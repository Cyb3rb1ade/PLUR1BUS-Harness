//! Owner-bound history and progress subscription survive a stopped Core without reading source contents.
use super::imports::{audit, owner, validate, RunRecord, WATCH};
use super::{import_records as records, relock, Shared};
use crate::{ext::ExtError, paths::Layout};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc};

pub fn watch_status(
    shared: &Arc<Shared>,
    layout: &Layout,
    params: &Value,
    principal: Option<&Value>,
    subscribe: impl FnOnce(Value, u128),
) -> Result<(), ExtError> {
    let _watch = relock(&WATCH);
    let result = read_method(shared, layout, "admin.import.status", params, principal)?;
    let id = uuid::Uuid::parse_str(params["runId"].as_str().ok_or_else(records::unavailable)?)
        .map_err(|_| records::unavailable())?
        .as_u128();
    subscribe(result, id);
    Ok(())
}

pub(super) fn load(layout: &Layout, id: &str) -> Result<RunRecord, ExtError> {
    if !records::uuid(id) {
        return Err(records::unavailable());
    }
    let bytes = records::read(
        layout,
        &layout
            .home
            .join("imports")
            .join(id)
            .join("maintenance-run.json"),
        64 * 1024,
    )?;
    let record: RunRecord = serde_json::from_slice(&bytes).map_err(|_| records::unavailable())?;
    if record.version != 1
        || record.job.run_id != id
        || record.run["runId"] != id
        || record.run["planId"] != record.job.plan_id
        || !records::uuid(&record.job.plan_id)
        || !records::uuid(&record.job.invocation_id)
        || !records::hash(&record.job.plan_sha256)
        || record.job.owner_id.is_empty()
        || record.job.owner_id.len() > 512
        || !matches!(record.job.role.as_str(), "owner" | "admin")
        || !matches!(
            record.job.mode.as_str(),
            "apply" | "rollback" | "recover" | "activate"
        )
        || record.job.attempt == 0
        || record.run["attempt"] != record.job.attempt
        || record.run["sourceType"] != record.job.source_type
        || record
            .job
            .preflight_id
            .as_ref()
            .is_some_and(|id| !records::uuid(id))
        || record
            .job
            .target_sha256
            .as_ref()
            .is_some_and(|hash| !records::hash(hash))
    {
        return Err(records::unavailable());
    }
    validate_run(&record.run)?;
    Ok(record)
}

pub(super) fn validate_run(run: &Value) -> Result<(), ExtError> {
    static RESULT: std::sync::OnceLock<jsonschema::Validator> = std::sync::OnceLock::new();
    let validator = RESULT.get_or_init(|| {
        let schema: Value = serde_json::from_str(plur1bus_rpc::SCHEMA_JSON).expect("RPC schema");
        jsonschema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .build(&json!({
            "$defs":schema["$defs"],"$ref":"#/$defs/methods/admin.import.status/result"}))
            .expect("run metadata schema")
    });
    if !validator.is_valid(&json!({"run":run})) {
        return Err(records::unavailable());
    }
    Ok(())
}

pub(super) fn owned(
    shared: &Shared,
    layout: &Layout,
    id: &str,
    user: &str,
) -> Result<RunRecord, ExtError> {
    let cached = relock(&shared.maintenance).runs.get(id).cloned();
    let record = match cached {
        Some(record) => record,
        None => load(layout, id)?,
    };
    if record.job.owner_id != user {
        return Err(records::unavailable());
    }
    Ok(record)
}

pub fn read_method(
    shared: &Arc<Shared>,
    layout: &Layout,
    method: &str,
    params: &Value,
    principal: Option<&Value>,
) -> Result<Value, ExtError> {
    validate(method, params)?;
    let user = owner(principal)?;
    if method == "admin.import.runs" {
        let mut found = BTreeMap::new();
        match std::fs::read_dir(layout.home.join("imports")) {
            Ok(entries) => {
                for (index, entry) in entries.enumerate() {
                    if index >= 10_000 {
                        return Err(records::unavailable());
                    }
                    let entry = entry.map_err(|_| records::unavailable())?;
                    let id = entry.file_name().to_string_lossy().into_owned();
                    if !records::uuid(&id) {
                        continue;
                    }
                    if let Ok(record) = owned(shared, layout, &id, user) {
                        found.insert(id, record.run);
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(records::unavailable()),
        }
        let before = params["before"].as_str();
        let limit = params["limit"].as_u64().unwrap_or(25) as usize;
        let mut runs: Vec<Value> = found
            .into_values()
            .filter(|run| {
                before.is_none_or(|before| run["createdAt"].as_str().is_some_and(|at| at < before))
            })
            .collect();
        runs.sort_by(|a, b| b["createdAt"].as_str().cmp(&a["createdAt"].as_str()));
        if let Some(id) = principal.and_then(|p| p["_maintenanceRun"].as_str()) {
            runs.retain(|run| run["runId"] == id);
        }
        let next = (runs.len() > limit).then(|| runs[limit - 1]["createdAt"].clone());
        runs.truncate(limit);
        let mut result = json!({"runs":runs});
        if let Some(next) = next {
            result["nextBefore"] = next;
        }
        return Ok(result);
    }
    let id = params["runId"].as_str().ok_or_else(records::unavailable)?;
    let record = owned(shared, layout, id, user)?;
    if method == "admin.import.abort" {
        let mut state = relock(&shared.maintenance);
        let current = state.runs.get(id).unwrap_or(&record);
        let accepted = state
            .active
            .as_ref()
            .or(state.pending.as_ref())
            .is_some_and(|job| job.run_id == id && job.mode == "apply")
            && !matches!(
                current.run["state"].as_str(),
                Some("rolling-back" | "restarting-core" | "completed" | "failed" | "aborted")
            );
        if accepted {
            audit(layout, &record.job, "import.abort.requested", json!({}))?;
            // Persist the accepted intent before ACK. A killed supervisor must still undo this run.
            let directory = records::directory(layout, &["imports", id])?;
            records::write(
                layout,
                &directory.join("abort.json"),
                &json!({"schema":"import.abort/1","runId":id,"attempt":record.job.attempt,
                    "invocationId":record.job.invocation_id}),
            )?;
            state.abort_requested = true;
            shared.wake.notify_all();
        }
        return Ok(json!({"runId":id,"accepted":accepted,"state":record.run["state"]}));
    }
    Ok(json!({"run":record.run}))
}
