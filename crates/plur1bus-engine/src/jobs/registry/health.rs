//! Ledger-derived job health, as the pin's `job-registry.js` `health()`: read-only and
//! never failing. It creates no directory, takes no lease and never waits for a session.
use super::*;
use crate::text::json::{parse_exact, write_json, TolerantJsonValue};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap},
    sync::atomic::AtomicU64,
    time::SystemTime,
};

/// rem/deep LLM sessions per agent and UTC sweep (the pin's `BREAKER_LIMIT`).
const BREAKER_LIMIT: usize = 3;

struct InFlight {
    id: u64,
    agent: String,
    job: JobName,
    sweep: String,
    session: bool,
}

/// Every run in flight in this registry, from its durable marker until it is finished.
#[derive(Default)]
pub(super) struct InFlightRuns {
    next: AtomicU64,
    runs: Mutex<Vec<InFlight>>,
    cache: HealthCache,
}

/// Removes its run from the in-flight set on every exit path.
pub(super) struct InFlightGuard<'a> {
    runs: &'a InFlightRuns,
    id: u64,
}
impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        self.runs
            .runs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|run| run.id != self.id);
    }
}

/// Identity of a ledger file's content as far as metadata can tell: length, modification
/// time and, where available, inode and change time (a same-length rewrite changes ctime).
type Key = (u64, Option<SystemTime>, u64, i64, i64);

/// Per-agent ledger projections, re-read only when the ledger file's metadata changed.
#[derive(Default)]
pub struct HealthCache(Mutex<HashMap<String, Cached>>);

#[derive(Clone, Default)]
struct Cached {
    key: Option<Key>,
    last_runs: HashMap<String, JobLastRun>,
    sessions: HashMap<String, usize>,
    unreadable: usize,
}

impl Registry {
    pub(super) fn track(
        &self,
        agent: &AgentId,
        job: JobName,
        sweep: String,
        session: bool,
    ) -> InFlightGuard<'_> {
        let id = self.inflight.next.fetch_add(1, Ordering::Relaxed);
        self.inflight
            .runs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(InFlight {
                id,
                agent: agent.to_string(),
                job,
                sweep,
                session,
            });
        InFlightGuard {
            runs: &self.inflight,
            id,
        }
    }

    /// Whether the jobs root is still the directory this registry bound.
    pub fn root_intact(&self) -> bool {
        self.root.assert_unchanged().is_ok()
    }

    /// `JobsHealth` for every agent directory under the root plus every agent with a run in
    /// flight. An unreadable root or agent ledger reports `ledger: "unavailable"`; the call
    /// itself never fails.
    pub fn health(&self) -> JobsHealth {
        let sweep = metadata::sweep((self.clock)() as f64).unwrap_or_default();
        let inflight: Vec<(String, JobName, bool)> = self
            .inflight
            .runs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .map(|run| {
                (
                    run.agent.clone(),
                    run.job,
                    run.session && run.sweep == sweep,
                )
            })
            .collect();
        let names = self
            .root
            .assert_unchanged()
            .ok()
            .and_then(|()| agent_dirs(self.root.path()));
        assemble(
            self.root.path(),
            names,
            &inflight,
            &sweep,
            &self.inflight.cache,
        )
    }
}

/// Health of a jobs root no registry has bound yet (no run can be in flight). Opens nothing
/// for writing and keeps no handle; `None` when the root is not a trusted directory.
pub fn health_at(root: &Path, now_ms: i64, cache: &HealthCache) -> Option<JobsHealth> {
    let dir = TrustedDirectory::open(root).ok()?;
    let sweep = metadata::sweep(now_ms as f64).unwrap_or_default();
    let names = agent_dirs(dir.path());
    let health = assemble(dir.path(), names, &[], &sweep, cache);
    dir.assert_unchanged().ok()?;
    Some(health)
}

fn assemble(
    root: &Path,
    names: Option<BTreeSet<String>>,
    inflight: &[(String, JobName, bool)],
    sweep: &str,
    cache: &HealthCache,
) -> JobsHealth {
    let (mut names, mut available) = match names {
        Some(names) => (names, true),
        None => (BTreeSet::new(), false),
    };
    names.extend(inflight.iter().map(|(agent, _, _)| agent.clone()));
    let mut agents = Vec::new();
    for name in names {
        let Ok(agent_id) = name.parse::<AgentId>() else {
            continue;
        };
        let cached = agent_ledger(root, &name, cache).unwrap_or_else(|()| {
            available = false;
            Cached::default()
        });
        let mut running: Vec<String> = inflight
            .iter()
            .filter(|(agent, _, _)| *agent == name)
            .map(|(_, job, _)| job.to_string())
            .collect();
        running.sort();
        running.dedup();
        let sessions = cached.sessions.get(sweep).copied().unwrap_or(0)
            + inflight
                .iter()
                .filter(|(agent, _, session)| *agent == name && *session)
                .count();
        let running = running
            .iter()
            .filter_map(|job| serde_json::from_value(json!(job)).ok())
            .collect();
        agents.push(AgentJobHealth {
            agent_id,
            last_runs: cached.last_runs,
            running,
            breaker: BreakerState {
                sweep: sweep.to_owned(),
                sessions: sessions.into(),
                limit: BREAKER_LIMIT.into(),
                open: sessions >= BREAKER_LIMIT,
            },
            unreadable_lines: cached.unreadable.into(),
        });
    }
    JobsHealth {
        ledger: if available {
            JobsHealthLedger::Ok
        } else {
            JobsHealthLedger::Unavailable
        },
        agents,
    }
}

/// Safe agent directory names below a root; `None` when the root is unreadable.
fn agent_dirs(root: &Path) -> Option<BTreeSet<String>> {
    let mut names = BTreeSet::new();
    for entry in std::fs::read_dir(root).ok()? {
        let entry = entry.ok()?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let safe = !name.is_empty()
            && name.len() <= 64
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        if safe && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            names.insert(name);
        }
    }
    Some(names)
}

fn key(meta: &std::fs::Metadata) -> Key {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (
            meta.len(),
            meta.modified().ok(),
            meta.ino(),
            meta.ctime(),
            meta.ctime_nsec(),
        )
    }
    #[cfg(not(unix))]
    {
        (meta.len(), meta.modified().ok(), 0, 0, 0)
    }
}

/// One agent's projection, re-read only when the ledger file's metadata changed.
fn agent_ledger(root: &Path, agent: &str, cache: &HealthCache) -> Result<Cached, ()> {
    let path = root.join(agent).join("ledger.jsonl");
    let key = match std::fs::symlink_metadata(&path) {
        Ok(meta) => key(&meta),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Cached::default()),
        Err(_) => return Err(()),
    };
    let mut cache = cache
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(cached) = cache.get(agent).filter(|cached| cached.key == Some(key)) {
        return Ok(cached.clone());
    }
    let snapshot = JobLedger::open(root, agent)
        .map_err(|_| ())?
        .snapshot(&Cancel::never())
        .map_err(|_| ())?;
    let cached = derive(key, &snapshot.rows, snapshot.unreadable);
    cache.insert(agent.to_owned(), cached.clone());
    Ok(cached)
}

/// Latest finished run per job (by `finishedAt`, first wins on ties) and rem/deep sessions
/// per sweep. A latest row that does not fit the frozen `JobLastRun` is left out.
fn derive(key: Key, rows: &[TolerantJsonValue], unreadable: usize) -> Cached {
    let mut latest: HashMap<String, (f64, Value)> = HashMap::new();
    let mut sessions: HashMap<String, usize> = HashMap::new();
    for row in rows {
        let Ok(row) = parse_exact(&write_json(row)) else {
            continue;
        };
        if let (Some(job), Some(finished)) = (row["job"].as_str(), row["finishedAt"].as_f64()) {
            if latest.get(job).is_none_or(|(best, _)| finished > *best) {
                latest.insert(job.to_owned(), (finished, row.clone()));
            }
        }
        if row["llmSession"] == true && matches!(row["phase"].as_str(), Some("rem" | "deep")) {
            if let Some(sweep) = row["sweep"].as_str() {
                *sessions.entry(sweep.to_owned()).or_default() += 1;
            }
        }
    }
    let last_runs = latest
        .into_iter()
        .filter_map(|(job, (_, row))| {
            let mut projected = json!({"runId":row["runId"],"outcome":row["outcome"],
                "trigger":row["trigger"],"startedAt":row["startedAt"],
                "finishedAt":row["finishedAt"],"attempt":row["attempt"]});
            if let Some(reason) = row.get("reason") {
                projected["reason"] = reason.clone();
            }
            serde_json::from_value(projected)
                .ok()
                .map(|last| (job, last))
        })
        .collect();
    Cached {
        key: Some(key),
        last_runs,
        sessions,
        unreadable,
    }
}
