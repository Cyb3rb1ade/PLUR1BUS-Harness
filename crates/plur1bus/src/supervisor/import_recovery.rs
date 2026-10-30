//! Durable startup recovery and the activation commit point contain control metadata only.
use super::imports::{Job, RunRecord};
use super::{import_records as records, imports, relock, Shared};
use crate::{ext::ExtError, paths::Layout};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
fn failed() -> ExtError {
    ExtError::new(
        "E_INTERNAL",
        "maintenance-recovery-required",
        "import maintenance requires recovery",
    )
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Activation {
    version: u8,
    invocation_id: String,
    run_id: String,
    plan_sha256: String,
    attempt: u64,
    result: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AbortIntent {
    schema: String,
    run_id: String,
    invocation_id: String,
    attempt: u64,
}

pub(super) fn abort_intent(layout: &Layout, job: &Job) -> Result<bool, ExtError> {
    let path = layout
        .home
        .join("imports")
        .join(&job.run_id)
        .join("abort.json");
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(failed()),
        Ok(_) => {}
    }
    let intent: AbortIntent =
        serde_json::from_slice(&records::read(layout, &path, 4096)?).map_err(|_| failed())?;
    if intent.schema != "import.abort/1"
        || intent.run_id != job.run_id
        || !records::uuid(&intent.invocation_id)
        || intent.attempt == 0
        || intent.attempt > job.attempt
    {
        return Err(failed());
    }
    Ok(intent.attempt == job.attempt && intent.invocation_id == job.invocation_id)
}

pub(super) fn activation(layout: &Layout, job: &Job) -> Result<Option<Value>, ExtError> {
    let path = layout
        .home
        .join("imports")
        .join(&job.run_id)
        .join("activation.json");
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(failed()),
        Ok(_) => {}
    }
    let saved: Activation =
        serde_json::from_slice(&records::read(layout, &path, 8192)?).map_err(|_| failed())?;
    if saved.version != 1
        || !records::uuid(&saved.invocation_id)
        || saved.run_id != job.run_id
        || saved.plan_sha256 != job.plan_sha256
        || saved.attempt > job.attempt
    {
        return Err(failed());
    }
    if saved.attempt < job.attempt || saved.invocation_id != job.invocation_id {
        return Ok(None);
    }
    if !saved.result["restored"].is_boolean()
        || !saved.result["ok"].is_boolean()
        || !saved.result["resumable"].is_boolean()
        || !matches!(
            saved.result["status"].as_str(),
            Some("completed" | "aborted" | "failed")
        )
    {
        return Err(failed());
    }
    Ok(Some(saved.result))
}

fn terminal(record: &RunRecord) -> bool {
    matches!(
        record.run["state"].as_str(),
        Some("completed" | "aborted" | "failed")
    )
}

/// Reserve recovery before any Core start. Torn or unowned dirty journals keep writers stopped.
pub fn initial(shared: &Shared, layout: &Layout) {
    if initial_inner(shared, layout).is_err() {
        block(shared);
    }
}

fn initial_inner(shared: &Shared, layout: &Layout) -> Result<(), ExtError> {
    let entries = match std::fs::read_dir(layout.home.join("imports")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(failed()),
    };
    let mut pending = None;
    for (index, entry) in entries.enumerate() {
        if index >= 10_000 {
            return Err(failed());
        }
        let entry = entry.map_err(|_| failed())?;
        let id = entry.file_name().to_string_lossy().into_owned();
        let kind = entry.file_type().map_err(|_| failed())?;
        if kind.is_symlink() {
            return Err(failed());
        }
        if !records::uuid(&id) {
            if kind.is_dir()
                && entry
                    .path()
                    .join("maintenance.json")
                    .try_exists()
                    .map_err(|_| failed())?
            {
                return Err(failed());
            }
            continue;
        }
        let native = entry.path().join("maintenance-run.json");
        match std::fs::symlink_metadata(&native) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                verify_unowned_journal(layout, &id)?;
                continue;
            }
            Err(_) => return Err(failed()),
            Ok(_) => {}
        }
        let record = imports::load(layout, &id)?;
        if terminal(&record) {
            verify_unowned_journal(layout, &id)?;
            continue;
        }
        if pending.is_some() {
            return Err(failed());
        }
        let mut job = record.job.clone();
        job.mode = if activation(layout, &job)?.is_some() {
            "activate"
        } else {
            "recover"
        }
        .into();
        job.preflight_id = None;
        job.target_sha256 = None;
        job.automatic_rollback = false;
        relock(&shared.maintenance).runs.insert(id, record);
        pending = Some(job);
    }
    relock(&shared.maintenance).pending = pending;
    Ok(())
}

fn verify_unowned_journal(layout: &Layout, id: &str) -> Result<(), ExtError> {
    let path = layout
        .home
        .join("imports")
        .join(id)
        .join("maintenance.json");
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(failed()),
        Ok(_) => {}
    }
    let journal: Value =
        serde_json::from_slice(&records::read(layout, &path, 256 * 1024)?).map_err(|_| failed())?;
    if journal["schema"] != "import.maintenance/1"
        || journal["runId"] != id
        || !matches!(
            journal["phase"].as_str(),
            Some("committed" | "restored" | "prepared" | "snapshotting")
        )
        || matches!(journal["phase"].as_str(), Some("prepared" | "snapshotting"))
            && (journal.get("snapshotSha256").is_some()
                || journal["secrets"].as_array().is_none_or(|v| !v.is_empty()))
        || journal["secrets"].as_array().is_none_or(|secrets| {
            journal["phase"] == "restored"
                && secrets
                    .iter()
                    .any(|secret| secret["created"] == true && secret["removed"] != true)
        })
    {
        return Err(failed());
    }
    Ok(())
}

pub fn block(shared: &Shared) {
    relock(&shared.maintenance).blocked = true;
    shared.log.error(
        "import maintenance requires recovery; writers remain stopped",
        json!({}),
    );
    shared.wake.notify_all();
}

/// Called with the supervisor state locked: never wait for the maintenance lock (private config takes the reverse).
pub fn scheduled(shared: &Shared) -> (bool, Option<Job>) {
    let mut state = match shared.maintenance.try_lock() {
        Ok(state) => state,
        Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => return (true, None),
    };
    if state.blocked || state.preparing || state.active.is_some() {
        return (true, None);
    }
    if let Some(job) = state.pending.take() {
        state.active = Some(job.clone());
        return (true, Some(job));
    }
    (false, None)
}

pub(super) fn publish_activation(
    layout: &Layout,
    job: &Job,
    result: &Value,
) -> Result<(), ExtError> {
    let directory = records::directory(layout, &["imports", &job.run_id])?;
    records::write(
        layout,
        &directory.join("activation.json"),
        &Activation {
            version: 1,
            invocation_id: job.invocation_id.clone(),
            run_id: job.run_id.clone(),
            plan_sha256: job.plan_sha256.clone(),
            attempt: job.attempt,
            result: result.clone(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previous_apply_activation_cannot_authorize_an_interrupted_manual_rollback() {
        let temp = tempfile::tempdir().unwrap();
        let layout = Layout::new(temp.path().to_path_buf());
        let mut job = Job {
            invocation_id: uuid::Uuid::new_v4().to_string(),
            run_id: uuid::Uuid::new_v4().to_string(),
            plan_id: uuid::Uuid::new_v4().to_string(),
            plan_sha256: "a".repeat(64),
            owner_id: "local-owner".into(),
            role: "owner".into(),
            source_type: "fixture".into(),
            mode: "apply".into(),
            attempt: 1,
            preflight_id: Some(uuid::Uuid::new_v4().to_string()),
            target_sha256: Some("b".repeat(64)),
            migrate_secrets: false,
            automatic_rollback: false,
        };
        let outcome = json!({"ok":true,"status":"completed","restored":false,"resumable":false});
        publish_activation(&layout, &job, &outcome).unwrap();
        assert_eq!(activation(&layout, &job).unwrap(), Some(outcome.clone()));
        job.mode = "rollback".into();
        job.preflight_id = Some(uuid::Uuid::new_v4().to_string());
        job.invocation_id = uuid::Uuid::new_v4().to_string();
        let directory = records::directory(&layout, &["imports", &job.run_id]).unwrap();
        records::write(
            &layout,
            &directory.join("maintenance.json"),
            &json!({"schema":"import.maintenance/1",
            "runId":job.run_id,"attempt":1,"phase":"rolling-back","secrets":[]}),
        )
        .unwrap();
        assert!(
            activation(&layout, &job).unwrap().is_none(),
            "old apply receipt must not bypass dirty rollback recovery"
        );
        let restored = json!({"ok":true,"status":"completed","restored":true,"resumable":false});
        publish_activation(&layout, &job, &restored).unwrap();
        assert_eq!(activation(&layout, &job).unwrap(), Some(restored));
        let unchanged = records::read(&layout, &directory.join("maintenance.json"), 4096).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&unchanged).unwrap()["phase"],
            "rolling-back"
        );
    }
}
