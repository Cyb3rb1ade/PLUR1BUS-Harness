//! RE-D172: the three append-only `1staid check` rows of the native Rust engine, `engine.process`, `engine.store` and
//! `engine.runtime`. All three `skip` while the Node engine is selected (`engine.implementation`, the default). With
//! the Rust engine one bounded `engine.status` call (the check's 300 ms connect and call timeouts, inside the pass's
//! budget) serves every row: the process row compares the answer with `run/engine.pid` and the socket's server, the
//! store row reads `storeSchema`, `jobs.ledger` and `journal`, the runtime row the `models` block and `degraded`. An
//! engine that does not answer fails the process row once; the other two are then not checkable (`skip`), and no
//! second connection is tried. Read-only, like every check.
use super::firstaid::Check;
use crate::paths::Layout;
use plur1bus_rpc::RpcError;
use serde_json::{json, Value};

const PROCESS: &str = "engine.process";
const STORE: &str = "engine.store";
const RUNTIME: &str = "engine.runtime";

/// What the pass knows about the engine before its rows are built.
pub(super) enum Engine {
    /// `engine.implementation` is `node` (or absent).
    NotSelected,
    /// config.json cannot be read or names no valid implementation (`config.valid` reports it).
    Unreadable,
    /// The Rust engine is selected: the one `engine.status` call, with the socket server's pid when it answered.
    Probed(Result<(Value, Option<u32>), RpcError>),
}

/// The three rows for `layout`; `probe` makes the single `engine.status` call (only when the Rust engine is selected).
pub(super) fn checks(
    layout: &Layout,
    platform: &'static str,
    probe: impl FnOnce(&'static str) -> Result<(Value, Option<u32>), RpcError>,
) -> Vec<Check> {
    let engine = match plur1bus_config::read(&layout.config_path()) {
        Err(_) => Engine::Unreadable,
        Ok(config) => match crate::engine_process::selected(&config) {
            Err(_) => Engine::Unreadable,
            Ok(false) => Engine::NotSelected,
            Ok(true) => Engine::Probed(probe(platform)),
        },
    };
    rows(engine, recorded(layout, platform))
}

/// `run/engine.pid` as `(pid, instanceId)`.
fn recorded(layout: &Layout, platform: &str) -> Option<(u32, String)> {
    let text = std::fs::read_to_string(
        layout
            .endpoints(&crate::supervisor::Role::engine(), platform)
            .pid,
    )
    .ok()?;
    let mut fields = text.split_whitespace();
    let pid = fields.next()?.parse().ok()?;
    Some((pid, fields.next()?.to_owned()))
}

/// The rows for what the pass found (pure, so every branch is tested without a process).
pub(super) fn rows(engine: Engine, recorded: Option<(u32, String)>) -> Vec<Check> {
    let all = |summary: &str| {
        [PROCESS, STORE, RUNTIME]
            .map(|id| Check::skip(id, summary))
            .to_vec()
    };
    match engine {
        Engine::NotSelected => {
            all("the Node engine is selected (engine.implementation); no native engine runs")
        }
        Engine::Unreadable => all("the engine selection cannot be read (see config.valid)"),
        Engine::Probed(Err(error)) => {
            let reason = match &error {
                RpcError::Unavailable { reason, .. } => reason.clone(),
                other => other.to_string(),
            };
            // The probe pins the server to the pid in run/engine.pid (S11): another process on the endpoint is refused
            // before the token is sent, and is that pid file not naming the engine that serves (B12).
            let summary = if super::is_server_mismatch(&error) {
                "run/engine.pid does not name the process that serves the engine endpoint"
            } else {
                "the Rust engine is selected but does not answer on its endpoint"
            };
            vec![
                Check::fail(
                    PROCESS,
                    summary,
                    Some(json!({ "reason": reason })),
                    Some(
                        "`plur1bus daemon status` shows the engine slot; `plur1bus daemon start` starts it again"
                            .into(),
                    ),
                ),
                Check::skip(STORE, "not checkable: the engine did not answer (see engine.process)"),
                Check::skip(RUNTIME, "not checkable: the engine did not answer (see engine.process)"),
            ]
        }
        Engine::Probed(Ok((status, peer))) => vec![
            process_row(&status, peer, recorded),
            store_row(&status),
            runtime_row(&status),
        ],
    }
}

fn process_row(status: &Value, peer: Option<u32>, recorded: Option<(u32, String)>) -> Check {
    let pid = status["pid"].as_u64().and_then(|p| u32::try_from(p).ok());
    let instance = status["instanceId"].as_str();
    let state = status["process"]["state"].as_str();
    let detail = json!({
        "pid": pid,
        "instanceId": instance,
        "state": state,
        "rpc": status["rpc"],
        "serverPid": peer,
        "recordedPid": recorded.as_ref().map(|(p, _)| *p),
    });
    // The pid itself was pinned by the probe (a mismatch never answers, see `rows`); the incarnation was not.
    if recorded.as_ref().map(|(_, i)| i.as_str()) != instance {
        return Check::fail(
            PROCESS,
            "run/engine.pid names another engine incarnation than the one that serves its endpoint",
            Some(detail),
            None,
        );
    }
    let pid = pid.unwrap_or_default();
    match state {
        Some("ready") => Check {
            detail: Some(detail),
            ..Check::ok(PROCESS, format!("engine pid {pid} serves its endpoint"))
        },
        Some("orphaned") => Check::warn(
            PROCESS,
            format!("engine pid {pid} lost its supervisor (orphaned) and ends after its grace"),
            Some(detail),
            Some("`plur1bus daemon start` adopts it or starts another".into()),
        ),
        Some("stopping") => Check::warn(
            PROCESS,
            format!("engine pid {pid} is stopping"),
            Some(detail),
            None,
        ),
        _ => Check::warn(
            PROCESS,
            format!("engine pid {pid} reports no process state"),
            Some(detail),
            None,
        ),
    }
}

fn store_row(status: &Value) -> Check {
    let current = status["storeSchema"]["current"].as_str();
    let expected = status["storeSchema"]["expected"].as_str();
    let ledger = status["jobs"]["ledger"].as_str();
    let backlog = status["journal"]["entries"].as_f64().unwrap_or(0.0);
    let detail = json!({
        "storeSchema": { "current": current, "expected": expected },
        "jobsLedger": ledger,
        "journal": status["journal"],
    });
    match (current, expected) {
        (Some(c), Some(e)) if c != e => {
            return Check::fail(
                STORE,
                format!("the engine store is at schema {c}, the engine expects {e}"),
                Some(detail),
                None,
            )
        }
        (None, _) => {
            return Check::warn(STORE, "the engine has no store yet", Some(detail), None);
        }
        _ => {}
    }
    if ledger != Some("ok") {
        return Check::warn(
            STORE,
            "the engine's jobs ledger is unavailable",
            Some(detail),
            None,
        );
    }
    if backlog > 0.0 {
        return Check::warn(
            STORE,
            format!("{backlog} journaled turn(s) wait for the engine"),
            Some(detail),
            None,
        );
    }
    Check {
        detail: Some(detail),
        ..Check::ok(
            STORE,
            format!(
                "store schema {}, jobs ledger ok, no journal backlog",
                current.unwrap_or_default()
            ),
        )
    }
}

fn runtime_row(status: &Value) -> Check {
    let embedder = status["models"]["embedder"]["state"].as_str();
    let reranker = status["models"]["reranker"]["state"].as_str();
    let detail = json!({
        "embedder": embedder,
        "reranker": reranker,
        "warming": status["models"]["embedder"]["warming"],
        "degraded": status["degraded"],
    });
    match embedder {
        Some("ready") if reranker != Some("failed") => Check {
            detail: Some(detail),
            ..Check::ok(RUNTIME, "the engine's embedding model is ready")
        },
        Some("ready") => Check::warn(
            RUNTIME,
            "the engine's reranker failed; recall runs without it",
            Some(detail),
            None,
        ),
        Some("failed") => Check::fail(
            RUNTIME,
            "the engine's embedding model failed",
            Some(detail),
            None,
        ),
        Some(_) => Check::warn(
            RUNTIME,
            "the engine's models are still loading",
            Some(detail),
            None,
        ),
        None => Check::warn(
            RUNTIME,
            "the engine reports no model status",
            Some(detail),
            None,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::super::firstaid::Status;
    use super::*;

    fn healthy() -> Value {
        json!({
            "pid": 42, "instanceId": "i-1", "rpc": "1.25.0",
            "process": { "state": "ready", "orphanedSince": null },
            "storeSchema": { "current": "1", "expected": "1" },
            "jobs": { "ledger": "ok", "agents": [] },
            "journal": { "entries": 0, "oldestAt": null },
            "models": { "embedder": { "state": "ready", "warming": false } },
            "degraded": null,
        })
    }

    fn statuses(checks: &[Check]) -> Vec<(&'static str, Status)> {
        checks.iter().map(|c| (c.id, c.status)).collect()
    }

    #[test]
    fn the_node_engine_skips_all_three_rows() {
        let rows = rows(Engine::NotSelected, None);
        assert_eq!(
            statuses(&rows),
            [
                (PROCESS, Status::Skip),
                (STORE, Status::Skip),
                (RUNTIME, Status::Skip)
            ]
        );
    }

    #[test]
    fn a_healthy_engine_passes_all_three_rows() {
        let rows = rows(
            Engine::Probed(Ok((healthy(), Some(42)))),
            Some((42, "i-1".into())),
        );
        assert_eq!(
            statuses(&rows),
            [
                (PROCESS, Status::Ok),
                (STORE, Status::Ok),
                (RUNTIME, Status::Ok)
            ]
        );
    }

    #[test]
    fn an_unreachable_engine_fails_once_and_leaves_the_rest_unchecked() {
        let error = RpcError::Unavailable {
            reason: "no-token".into(),
            detail: String::new(),
        };
        let rows = rows(Engine::Probed(Err(error)), None);
        assert_eq!(
            statuses(&rows),
            [
                (PROCESS, Status::Fail),
                (STORE, Status::Skip),
                (RUNTIME, Status::Skip)
            ]
        );
        assert_eq!(rows[0].detail.as_ref().unwrap()["reason"], "no-token");
        assert!(rows[1].summary.contains("not checkable"));
    }

    #[test]
    fn a_process_the_pid_file_does_not_name_fails() {
        // B12: another process on the endpoint is refused by the pinned probe; the row names the pid file.
        let refused = RpcError::Call {
            error: plur1bus_rpc::types::ErrorCode::EUnauthorized,
            jsonrpc: -32000,
            message: "refused".into(),
            reason: Some("pipe-server-mismatch".into()),
            detail: None,
            ids: None,
            ext: None,
        };
        let rows = rows(Engine::Probed(Err(refused)), Some((7, "i-1".into())));
        assert_eq!(rows[0].status, Status::Fail);
        assert!(
            rows[0].summary.contains("does not name"),
            "{}",
            rows[0].summary
        );
        // An answering engine of another incarnation than the pid file names.
        let rows = super::rows(
            Engine::Probed(Ok((healthy(), Some(42)))),
            Some((42, "i-2".into())),
        );
        assert_eq!(rows[0].status, Status::Fail);
        assert!(
            rows[0].summary.contains("incarnation"),
            "{}",
            rows[0].summary
        );
    }

    #[test]
    fn store_and_runtime_findings_are_reported() {
        let mut status = healthy();
        status["storeSchema"]["current"] = json!("0");
        status["models"]["embedder"]["state"] = json!("loading");
        let rows = rows(
            Engine::Probed(Ok((status.clone(), None))),
            Some((42, "i-1".into())),
        );
        assert_eq!(rows[1].status, Status::Fail);
        assert_eq!(rows[2].status, Status::Warn);
        status["storeSchema"]["current"] = json!("1");
        status["jobs"]["ledger"] = json!("unavailable");
        status["models"]["embedder"]["state"] = json!("failed");
        let rows = super::rows(Engine::Probed(Ok((status, None))), Some((42, "i-1".into())));
        assert_eq!(rows[1].status, Status::Warn);
        assert_eq!(rows[2].status, Status::Fail);
    }
}
