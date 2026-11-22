//! Learning opt-ins, host-driven UTC windows and shadow calibration.

use super::aggregation::precision_gate;
use super::runner::Config;
use super::store::{LearnStore, PROMPT_VERSION};
use super::{current, digest, equals, string, target_valid, Source, Target, Window};
use crate::collab::{CollabError, CollabErrorCode};
use crate::js::sort_default;
use crate::toolcall::json::V;

type R<T> = Result<T, CollabError>;
const DAY: i64 = 86_400_000;

/// Learning policy read from trusted configuration.
pub struct Settings {
    /// Run policy for the selected owner and destination.
    pub policy: Config,
    /// Lookback measured in complete UTC days.
    pub window_days: i64,
    /// Private unfinished-checkpoint retention.
    pub checkpoint_days: i64,
}

fn invalid() -> CollabError {
    CollabError::new(CollabErrorCode::Invalid, "invalid learning settings")
}

fn learn(config: &V) -> Option<&V> {
    config.get("dreams")?.get("learn")
}

fn binding<'a>(learn: &'a V, target: &Target) -> Option<&'a V> {
    match target.scope.as_str() {
        "agent" => learn.get("agents")?.get(&target.agent_id),
        "project" => learn.get("projects")?.get(target.project_id.as_deref()?),
        "installation" => learn.get("installation"),
        _ => None,
    }
}

fn target(scope: &str, row: &V, key: Option<&str>) -> Option<Target> {
    let owner = string(row, "owner").ok()?;
    let agent = if scope == "agent" {
        key?.to_owned()
    } else {
        string(row, "agentId").ok()?
    };
    let target = Target {
        scope: scope.into(),
        owner,
        agent_id: agent,
        project_id: if scope == "project" {
            Some(key?.into())
        } else {
            None
        },
    };
    target_valid(&target).then_some(target)
}

/// Parse configured owner bindings without consulting a model.
pub fn targets(config: &V) -> Vec<Target> {
    let Some(config) = learn(config) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for (section, scope) in [("agents", "agent"), ("projects", "project")] {
        if let Some(map) = config.get(section).and_then(V::as_obj) {
            result.extend(
                map.entries()
                    .iter()
                    .filter_map(|(key, row)| target(scope, row, Some(&key.lossy()))),
            );
        }
    }
    result.extend(
        config
            .get("installation")
            .and_then(|row| target("installation", row, None)),
    );
    result
}

fn integer(config: Option<&V>, key: &str, default: i64, min: i64, max: i64) -> R<i64> {
    let Some(value) = config.and_then(|c| c.get(key)) else {
        return Ok(default);
    };
    let n = value
        .as_f64()
        .filter(|n| n.fract() == 0.0 && (min as f64..=max as f64).contains(n))
        .ok_or_else(invalid)?;
    Ok(n as i64)
}

/// Resolve the options for the exact configured binding.
pub fn settings(config: &V, target: &Target, local_only: bool) -> R<Settings> {
    if !target_valid(target) {
        return Err(invalid());
    }
    let learn = learn(config);
    let slot = learn.and_then(|config| binding(config, target));
    let enabled = slot.is_some_and(|row| {
        matches!(row.get("enabled"), Some(V::Bool(true)))
            && equals(row, "owner", &target.owner)
            && (target.scope == "agent" || equals(row, "agentId", &target.agent_id))
    });
    let focus = if let Some(value) = slot.and_then(|row| row.get("focus")) {
        let focus = value
            .as_js()
            .filter(|s| s.len() <= 4000)
            .ok_or_else(invalid)?;
        String::from_utf16(focus.units()).map_err(|_| invalid())?
    } else {
        String::new()
    };
    Ok(Settings {
        policy: Config {
            enabled,
            max_sessions: integer(learn, "maxSessions", 50, 1, 50)? as usize,
            max_tokens: integer(learn, "maxTokens", 100_000, 4096, 1_000_000)?,
            focus,
            local_only,
            review: true,
        },
        window_days: integer(learn, "windowDays", 7, 1, 30)?,
        checkpoint_days: integer(learn, "checkpointDays", 7, 1, 7)?,
    })
}

/// Compute the completed UTC window for a target.
pub fn window(now: i64, days: i64) -> Option<Window> {
    if !(DAY..=super::SAFE_INTEGER).contains(&now) || !(1..=30).contains(&days) {
        return None;
    }
    let to = now.div_euclid(DAY) * DAY;
    Some(Window {
        from: to.saturating_sub(days * DAY).max(0),
        to,
    })
}

/// Earliest UTC opportunity for any opted-in target; the host owns the timer.
pub fn next_run_at(config: &V, now: i64) -> Option<i64> {
    if !(0..=super::SAFE_INTEGER - DAY).contains(&now) {
        return None;
    }
    targets(config)
        .iter()
        .any(|t| settings(config, t, true).is_ok_and(|s| s.policy.enabled))
        .then_some((now.div_euclid(DAY) + 1) * DAY)
}

/// Targets whose current complete window needs a first attempt or crash resume.
pub fn due(
    store: &LearnStore,
    config: &V,
    source: &dyn Source,
    now: i64,
) -> R<Vec<(Target, Window)>> {
    let mut result = Vec::new();
    for target in targets(config) {
        let settings = settings(config, &target, true)?;
        let Some(window) = window(now, settings.window_days).filter(|_| settings.policy.enabled)
        else {
            continue;
        };
        if source
            .current_person(&target.owner)
            .is_none_or(|who| current(source, &target, &who, now).is_err())
        {
            continue;
        }
        if store
            .runs(&target.owner, Some(&target))?
            .first()
            .is_some_and(|run| run.window.to == window.to && run.outcome.is_some())
        {
            continue;
        }
        result.push((target, window));
    }
    Ok(result)
}

fn ordered(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut list: Vec<_> = values.into_iter().collect();
    sort_default(&mut list);
    list.dedup();
    list
}

/// Content-free, counterfactual calibration across an authorized owner's decisions.
pub fn calibration(store: &LearnStore, owner: &str, classes: &[String]) -> R<V> {
    let classes = ordered(classes.iter().cloned());
    let thresholds = V::obj([
        ("version", V::Num(2.0)),
        ("minimumDecisions", V::Num(50.0)),
        ("precisionGate", V::Num(0.95)),
        ("scoreA", V::Num(0.8)),
        ("scoreB", V::Num(0.9)),
    ]);
    let revision = digest(&V::Arr(vec![
        V::s(owner),
        V::s(PROMPT_VERSION),
        V::strs(&classes),
        thresholds.clone(),
    ]));
    let mut totals = [(0, 0), (0, 0)];
    let mut models = Vec::new();
    for row in store.decided_findings(owner)? {
        let f = row.get("finding").ok_or_else(invalid)?;
        if !equals(f, "kind", "knowledge") || !equals(f, "promptVersion", PROMPT_VERSION) {
            continue;
        }
        let available = f.get("modelClasses").and_then(V::as_arr).unwrap_or(&[]);
        let mut actual = available
            .iter()
            .filter_map(|v| v.as_js().map(|s| s.lossy()))
            .collect::<Vec<_>>();
        sort_default(&mut actual);
        if actual != classes {
            continue;
        }
        let tier = if equals(f, "desiredTier", "A") {
            0
        } else if equals(f, "desiredTier", "B") {
            1
        } else {
            continue;
        };
        if let Some(ids) = f.get("models").and_then(V::as_arr) {
            models.extend(ids.iter().filter_map(|v| v.as_js().map(|s| s.lossy())));
        }
        totals[tier].1 += 1;
        totals[tier].0 += u64::from(equals(&row, "outcome", "accepted"));
    }
    Ok(V::obj([
        ("version", V::Num(2.0)),
        ("revision", V::s(&revision)),
        ("owner", V::s(owner)),
        ("promptVersion", V::s(PROMPT_VERSION)),
        ("modelClasses", V::strs(&classes)),
        ("models", V::strs(&ordered(models))),
        ("thresholds", thresholds),
        ("predictions", store.prediction_summary(owner, &classes)?),
        ("A", precision_gate(totals[0].0, totals[0].1)),
        ("B", precision_gate(totals[1].0, totals[1].1)),
    ]))
}

#[cfg(test)]
#[path = "config_vectors.rs"]
mod vectors;
