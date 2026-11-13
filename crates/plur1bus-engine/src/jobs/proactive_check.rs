//! Owner-bound proactive pattern detection and atomic cooldown accounting.
use super::{
    lance_scope::LanceScope,
    ledger::io,
    registry::{JobBody, JobContext, JobReport},
};
use crate::{
    contract::{Cancel, EmbedKind, EngineError, JobName, JobOutcome, StoreError},
    embedding::EmbeddingProvider,
    neo::{
        capture_journal::CaptureJournal,
        job_turns::{self, ConversationTurn},
    },
    recall::{hash_embed::cosine_similarity, knowledge::private_key},
    store::{directory::TrustedDirectory, kernel_lease},
    text::js::utf16_slice,
};
use chrono::{Datelike, Timelike};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

const STATE: &str = "proactive.json";
const MAX_BYTES: usize = 8 * 1024 * 1024;
const DAY_MS: i64 = 86_400_000;
const HOUR_MS: i64 = 3_600_000;

pub(crate) struct ProactiveCheck {
    pub scope: Arc<LanceScope>,
    pub base: PathBuf,
    pub root: PathBuf,
    pub provider: Arc<dyn EmbeddingProvider>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    patterns: Vec<Pattern>,
    nudges: Vec<Nudge>,
    cooldowns: BTreeMap<String, i64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pattern {
    cluster_id: String,
    turn_ids: Vec<String>,
    representative: String,
    score: f64,
    occurrences: usize,
    newest: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Nudge {
    id: String,
    keyword: String,
    text: String,
    score: f64,
    generated_at: i64,
}

impl JobBody for ProactiveCheck {
    fn name(&self) -> JobName {
        JobName::ProactiveCheck
    }

    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        let cancel = &cancel.limited_to(Instant::now() + Duration::from_secs(180));
        let authority = context.authority()?;
        let (principal, agent) = authority.caller();
        let _operation = self.scope.operations.enter(principal, agent)?;
        if let Some(skip) = self.scope.check(authority, cancel)? {
            return Ok(skip);
        }
        let host = self.scope.operations.host_handle();
        let raw = serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)?;
        let check = || -> Result<(), EngineError> {
            if self.scope.check(authority, cancel)?.is_some()
                || serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)? != raw
            {
                return Err(StoreError::Unavailable.into());
            }
            Ok(())
        };
        let journal =
            match CaptureJournal::open(&self.root, host.clone(), self.scope.policy.clone()) {
                Ok(journal) => journal,
                Err(StoreError::Io {
                    kind: std::io::ErrorKind::NotFound,
                }) => return Ok(skip("no_turns")),
                Err(error) => return Err(error.into()),
            };
        let now = context.now_ms;
        let turns = job_turns::with_conversation_turns(
            &journal,
            authority,
            now,
            cancel,
            &check,
            |rows, _| Ok(rows),
        )?;
        if turns.len() < 3 {
            return Ok(skip("no_turns"));
        }
        let mut vectors = Vec::with_capacity(turns.len());
        for batch in turns.chunks(16) {
            check()?;
            let texts: Vec<_> = batch.iter().map(|turn| turn.content.clone()).collect();
            let part = self.provider.embed(&texts, EmbedKind::Passage, cancel)?;
            if part.len() != batch.len()
                || part.iter().any(|vector| {
                    vector.is_empty() || vector.iter().any(|value| !value.is_finite())
                })
            {
                return Err(StoreError::Corrupt.into());
            }
            vectors.extend(part);
        }
        let patterns = cluster(&turns, &vectors, now, cancel)?;
        context.note_count("patternsFound", patterns.len())?;
        if patterns.is_empty() {
            return Ok(skip("no_patterns"));
        }
        let timezone = raw["timezone"]
            .as_str()
            .and_then(|name| name.parse::<chrono_tz::Tz>().ok())
            .unwrap_or(chrono_tz::UTC);
        let local_hour = chrono::DateTime::from_timestamp_millis(now)
            .ok_or(StoreError::InvalidInput)?
            .with_timezone(&timezone)
            .hour();
        let binding = private_key(authority.request()).ok_or(StoreError::InvalidInput)?;
        let _mutation = self.scope.operations.mutation()?;
        let count = job_turns::with_conversation_turns(
            &journal,
            authority,
            now,
            cancel,
            &check,
            |fresh, source_check| {
                if fresh != turns {
                    return Err(StoreError::Unavailable.into());
                }
                let dir = TrustedDirectory::open(&self.base)?
                    .create_child("_proactive")?
                    .create_child(&binding)?;
                let lease = kernel_lease::acquire(&dir, "proactive", cancel, &mut || {})?;
                source_check()?;
                let bytes = io::read(&dir, STATE, MAX_BYTES, cancel)?;
                let mut state = bytes
                    .as_deref()
                    .map(serde_json::from_slice::<State>)
                    .transpose()
                    .map_err(|_| StoreError::Corrupt)?
                    .unwrap_or_default();
                let count = record(&mut state, patterns, now, local_hour);
                let next = serde_json::to_vec(&state).map_err(|_| StoreError::Corrupt)?;
                if next.len() > MAX_BYTES {
                    return Err(StoreError::Unavailable.into());
                }
                let check_output = || {
                    source_check()?;
                    lease.check(&dir)?;
                    Ok(())
                };
                io::replace(
                    &dir,
                    STATE,
                    bytes.as_deref(),
                    &next,
                    MAX_BYTES,
                    cancel,
                    &check_output,
                )?;
                Ok(count)
            },
        )?;
        context.note_count("nudgesGenerated", count)?;
        Ok(JobReport::completed())
    }
}

fn cluster(
    turns: &[ConversationTurn],
    vectors: &[Vec<f32>],
    now: i64,
    cancel: &Cancel,
) -> Result<Vec<Pattern>, EngineError> {
    let mut assigned = vec![false; turns.len()];
    let mut patterns = Vec::new();
    for index in 0..turns.len() {
        cancel.check()?;
        if assigned[index] {
            continue;
        }
        assigned[index] = true;
        let mut members = vec![index];
        for (other, was_assigned) in assigned.iter_mut().enumerate().skip(index + 1) {
            if !*was_assigned && cosine_similarity(&vectors[index], &vectors[other]) >= 0.82 {
                *was_assigned = true;
                members.push(other);
            }
        }
        if members.len() < 3 {
            continue;
        }
        let mut sums = vec![0.; vectors[index].len()];
        let mut hours = BTreeSet::new();
        let mut days = BTreeSet::new();
        let mut newest = i64::MIN;
        for &i in &members {
            for (sum, value) in sums.iter_mut().zip(&vectors[i]) {
                *sum += f64::from(*value);
            }
            let time = chrono::DateTime::from_timestamp_millis(turns[i].timestamp)
                .ok_or(StoreError::InvalidInput)?;
            hours.insert(time.hour());
            days.insert(time.weekday().num_days_from_sunday());
            newest = newest.max(turns[i].timestamp);
        }
        let centroid: Vec<_> = sums
            .into_iter()
            .map(|sum| (sum / members.len() as f64) as f32)
            .collect();
        let mut best = index;
        let mut score = -1.;
        for &i in &members {
            let similarity = cosine_similarity(&centroid, &vectors[i]);
            if similarity > score {
                best = i;
                score = similarity;
            }
        }
        let content = &turns[best].content;
        let representative = utf16_slice(content, 0, 180).to_utf8_lossy();
        let label = utf16_slice(&representative, 0, 20).to_utf8_lossy();
        let cluster_id = format!("cluster-{:x}", Sha256::digest(label.as_bytes()));
        let diversity = ((hours.len() as f64 / 4.).min(1.) + (days.len() as f64 / 3.).min(1.)) / 2.;
        let recency = (now - newest) as f64 / HOUR_MS as f64;
        let frequency = ((members.len() as f64).ln_1p() / 10_f64.ln_1p()).min(1.);
        patterns.push(Pattern {
            cluster_id,
            representative,
            newest,
            turn_ids: members
                .iter()
                .map(|&i| turns[i].id.to_utf8_lossy())
                .collect(),
            score: frequency * (-recency / 168.).exp() * diversity,
            occurrences: members.len(),
        });
    }
    patterns.sort_by(|left, right| right.score.total_cmp(&left.score));
    let mut seen = BTreeSet::new();
    patterns.retain(|pattern| seen.insert(pattern.cluster_id.clone()));
    Ok(patterns)
}

fn record(state: &mut State, patterns: Vec<Pattern>, now: i64, local_hour: u32) -> usize {
    let day = now.div_euclid(DAY_MS);
    let shown = state
        .nudges
        .iter()
        .filter(|nudge| nudge.generated_at.div_euclid(DAY_MS) == day)
        .count();
    let mut generated = 0;
    for pattern in &patterns {
        if shown + generated >= 2 {
            break;
        }
        if pattern.score < 0.6 {
            continue;
        }
        if let Some(last) = state.cooldowns.get(&pattern.cluster_id) {
            let material = format!("{}:{day}", pattern.representative);
            let hash = material.encode_utf16().fold(0u32, |hash, unit| {
                hash.wrapping_mul(31).wrapping_add(u32::from(unit))
            });
            let hours = 18 + i64::from(hash % 13);
            if !(8..22).contains(&local_hour) || now.saturating_sub(*last) < hours * HOUR_MS {
                continue;
            }
        }
        let recency = (now - pattern.newest) as f64 / HOUR_MS as f64;
        let phrase = if recency <= 26. {
            "gestern"
        } else if recency <= 50. {
            "vor 2 Tagen"
        } else if recency <= 74. {
            "vor 3 Tagen"
        } else if recency <= 170. {
            "letzte Woche"
        } else if recency <= 350. {
            "letzten Monat"
        } else {
            "in letzter Zeit"
        };
        let count = if pattern.occurrences >= 5 {
            "mehrmals".to_owned()
        } else {
            format!("{}x", pattern.occurrences)
        };
        let keyword = &pattern.representative;
        let label = keyword.chars().next().map_or_else(String::new, |first| {
            format!("{}{}", first.to_uppercase(), &keyword[first.len_utf8()..])
        });
        state.nudges.push(Nudge {
            id: format!("nudge-{}-{now}", pattern.cluster_id),
            keyword: keyword.clone(),
            text: format!("Du hast {phrase} {count} über {label} gesprochen — willst du heute weiterarbeiten?"),
            score: pattern.score,
            generated_at: now,
        });
        state.cooldowns.insert(pattern.cluster_id.clone(), now);
        generated += 1;
    }
    state.patterns = patterns;
    if state.nudges.len() > 100 {
        state.nudges.drain(..state.nudges.len() - 100);
    }
    if state.cooldowns.len() > 5000 {
        let mut entries: Vec<_> = std::mem::take(&mut state.cooldowns).into_iter().collect();
        entries.sort_by_key(|(_, at)| std::cmp::Reverse(*at));
        state.cooldowns = entries.into_iter().take(5000).collect();
    }
    generated
}

fn skip(reason: &str) -> JobReport {
    JobReport {
        outcome: JobOutcome::Skipped,
        reason: Some(reason.into()),
    }
}
