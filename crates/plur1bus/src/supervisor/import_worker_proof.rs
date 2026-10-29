//! Private control metadata binds a child result to the durable checkpoint; report bodies are only streamed into SHA256.
use super::{failed, keys};
use crate::ext::ExtError;
use crate::paths::Layout;
use crate::supervisor::{import_records as records, imports::Job};
use serde_json::Value;
use sha2::{Digest, Sha256};

const PHASES: &[&str] = &[
    "prepared",
    "snapshotting",
    "snapshot-complete",
    "applying",
    "committed",
    "rolling-back",
    "restored",
];
const REASONS: &[&str] = &[
    "apply-failed",
    "aborted",
    "restore-failed",
    "source-changed",
    "target-changed",
    "manual-rollback",
    "automatic-rollback",
    "recovered",
];

fn journal(layout: &Layout, job: &Job) -> Result<Value, ExtError> {
    if !records::uuid(&job.run_id) {
        return Err(failed());
    }
    let base = layout.home.join("imports").join(&job.run_id);
    let journal: Value = serde_json::from_slice(&records::read(
        layout,
        &base.join("maintenance.json"),
        256 * 1024,
    )?)
    .map_err(|_| failed())?;
    if !keys(
        &journal,
        &[
            "schema",
            "runId",
            "attempt",
            "phase",
            "snapshotSha256",
            "targetSha256",
            "history",
            "secrets",
        ],
    ) || journal["schema"] != "import.maintenance/1"
        || journal["runId"] != job.run_id
        || journal["attempt"].as_u64() != Some(job.attempt)
        || journal["phase"]
            .as_str()
            .is_none_or(|phase| !PHASES.contains(&phase))
    {
        return Err(failed());
    }
    for field in ["snapshotSha256", "targetSha256"] {
        if journal
            .get(field)
            .is_some_and(|value| value.as_str().is_none_or(|text| !records::hash(text)))
        {
            return Err(failed());
        }
    }
    let history = journal["history"]
        .as_array()
        .filter(|items| !items.is_empty() && items.len() <= 256)
        .ok_or_else(failed)?;
    for event in history {
        if !keys(event, &["attempt", "phase", "at", "reason"])
            || event["attempt"]
                .as_u64()
                .is_none_or(|attempt| attempt == 0 || attempt > job.attempt)
            || event["phase"]
                .as_str()
                .is_none_or(|phase| !PHASES.contains(&phase))
            || event["at"].as_str().is_none_or(|at| {
                crate::ext::record::parse_iso_ms(at)
                    .is_none_or(|ms| crate::supervisor::iso8601(ms) != at)
            })
            || event.get("reason").is_some_and(|value| {
                value
                    .as_str()
                    .is_none_or(|reason| !REASONS.contains(&reason))
            })
        {
            return Err(failed());
        }
    }
    let last = history.last().ok_or_else(failed)?;
    if last["phase"] != journal["phase"] || last["attempt"] != journal["attempt"] {
        return Err(failed());
    }
    let secrets = journal["secrets"]
        .as_array()
        .filter(|items| items.len() <= 256)
        .ok_or_else(failed)?;
    let mut names = std::collections::BTreeSet::new();
    for secret in secrets {
        let name = secret["name"]
            .as_str()
            .filter(|name| !name.is_empty() && name.len() <= 256)
            .ok_or_else(failed)?;
        if !keys(secret, &["name", "absentBefore", "created", "removed"])
            || !names.insert(name)
            || secret["absentBefore"] != true
            || !secret["created"].is_boolean()
            || !secret["removed"].is_boolean()
            || secret["removed"] == true && secret["created"] != true
        {
            return Err(failed());
        }
    }
    let pristine = matches!(journal["phase"].as_str(), Some("prepared" | "snapshotting"));
    if !pristine && journal.get("snapshotSha256").is_none() {
        return Err(failed());
    }
    if let Some(expected) = journal["snapshotSha256"].as_str() {
        let manifest = records::read(
            layout,
            &base.join("cold-snapshot/manifest.json"),
            32 * 1024 * 1024,
        )?;
        if format!("{:x}", Sha256::digest(&manifest)) != expected {
            return Err(failed());
        }
        let manifest: Value = serde_json::from_slice(&manifest).map_err(|_| failed())?;
        if manifest["schema"] != "import.cold-snapshot/1"
            || manifest["runId"] != job.run_id
            || !manifest["roots"].is_array()
            || !manifest["config"].is_object()
        {
            return Err(failed());
        }
    }
    Ok(journal)
}

pub(super) fn verify(layout: &Layout, job: &Job, result: &Value) -> Result<(), ExtError> {
    if result["ok"] == true && result["status"] != "completed"
        || result["ok"] == false && result["status"] == "completed"
        || result["ok"] == true && result.get("error").is_some()
    {
        return Err(failed());
    }
    if result["error"]["reason"] == "target-changed" && safe_refusal(layout, job, Some(result)) {
        return Ok(());
    }
    let state = journal(layout, job)?;
    if result["restored"] == true {
        let clean = state["phase"] == "restored"
            || matches!(state["phase"].as_str(), Some("prepared" | "snapshotting"))
                && state.get("snapshotSha256").is_none()
                && state["secrets"]
                    .as_array()
                    .is_some_and(|values| values.is_empty());
        if !clean
            || state["secrets"].as_array().is_none_or(|items| {
                items
                    .iter()
                    .any(|secret| secret["created"] == true && secret["removed"] != true)
            })
        {
            return Err(failed());
        }
    } else if result["ok"] == true && state["phase"] != "committed" {
        return Err(failed());
    }
    if let Some(report) = result.get("report") {
        if !records::source_type(&job.source_type)
            || report["schema"] != format!("import.{}/1", job.source_type)
        {
            return Err(failed());
        }
        let (hash, bytes) = records::fingerprint(
            layout,
            &layout
                .home
                .join("imports")
                .join(&job.run_id)
                .join("report.json"),
            256 * 1024 * 1024,
        )?;
        if report["sha256"] != hash || report["bytes"] != bytes {
            return Err(failed());
        }
    } else if result["ok"] == true && result["restored"] == false && job.mode == "apply" {
        return Err(failed());
    }
    Ok(())
}

pub(super) fn safe_refusal(layout: &Layout, job: &Job, result: Option<&Value>) -> bool {
    if job.automatic_rollback
        || !result.is_none_or(|value| {
            value["ok"] == false
                && value["status"] == "failed"
                && value["restored"] == false
                && value["error"]["reason"] == "target-changed"
        })
    {
        return false;
    }
    let removed = |state: &Value| {
        state["secrets"].as_array().is_some_and(|items| {
            items
                .iter()
                .all(|secret| secret["created"] != true || secret["removed"] == true)
        })
    };
    let prepared = |state: &Value| {
        state["phase"] == "prepared"
            && state.get("snapshotSha256").is_none()
            && state["secrets"]
                .as_array()
                .is_some_and(|items| items.is_empty())
    };
    match job.mode.as_str() {
        "rollback" => journal(layout, job).is_ok_and(|state| {
            state["phase"] == "committed" || state["phase"] == "restored" && removed(&state)
        }),
        "apply" => {
            if journal(layout, job).is_ok_and(|state| prepared(&state)) {
                return true;
            }
            let Some(previous) = job.attempt.checked_sub(1).filter(|attempt| *attempt > 0) else {
                return false;
            };
            let mut previous_job = job.clone();
            previous_job.attempt = previous;
            journal(layout, &previous_job).is_ok_and(|state| {
                prepared(&state) || state["phase"] == "restored" && removed(&state)
            })
        }
        _ => false,
    }
}
