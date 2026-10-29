//! Human-owned supervised import maintenance. Only bounded control metadata crosses this layer.
use super::import_records as records;
use super::{relock, Shared};
use crate::ext::ExtError;
use crate::paths::Layout;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub(super) static WATCH: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(super) struct Proof {
    pub(super) principal: Value,
    pub(super) token_sha256: String,
    pub(super) expires_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Job {
    pub invocation_id: String,
    pub run_id: String,
    pub plan_id: String,
    pub plan_sha256: String,
    pub owner_id: String,
    pub role: String,
    pub source_type: String,
    pub mode: String,
    pub attempt: u64,
    pub preflight_id: Option<String>,
    pub target_sha256: Option<String>,
    pub migrate_secrets: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub automatic_rollback: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRecord {
    pub version: u8,
    pub job: Job,
    pub run: Value,
}

#[derive(Default)]
pub struct State {
    pub preparing: bool,
    pub pending: Option<Job>,
    pub active: Option<Job>,
    pub blocked: bool,
    pub abort_requested: bool,
    pub runs: BTreeMap<String, RunRecord>,
    pub(super) proofs: BTreeMap<String, Proof>,
}

pub fn busy(shared: &Shared) -> bool {
    let state = match shared.maintenance.try_lock() {
        Ok(state) => state,
        Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => return true,
    };
    state.preparing || state.pending.is_some() || state.active.is_some() || state.blocked
}

pub(super) fn owner(principal: Option<&Value>) -> Result<&str, ExtError> {
    match principal {
        None => Ok("local-owner"),
        Some(p)
            if p["kind"] == "person" && matches!(p["role"].as_str(), Some("owner" | "admin")) =>
        {
            p["userId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(records::unavailable)
        }
        _ => Err(ExtError::new(
            "E_DENIED",
            "role-denied",
            "import maintenance requires a human Owner or Admin",
        )),
    }
}

pub fn busy_error() -> ExtError {
    ExtError::new(
        "E_CONFLICT",
        "busy",
        "import maintenance is already in progress",
    )
}

pub(super) fn audit(
    layout: &Layout,
    job: &Job,
    action: &str,
    mut detail: Value,
) -> Result<(), ExtError> {
    detail["planId"] = json!(job.plan_id);
    detail["attempt"] = json!(job.attempt);
    detail["invocationId"] = json!(job.invocation_id);
    crate::audit::append_as(
        layout,
        (&job.owner_id, "import"),
        action,
        &job.run_id,
        detail,
    )
    .map_err(|_| {
        ExtError::new(
            "E_INTERNAL",
            "audit-unavailable",
            "import audit is unavailable",
        )
    })
}

pub use super::import_admission::queue;

/// A stopped Core permits only this run's already-authorized read/abort/progress capability.
pub fn offline_principal(
    shared: &Shared,
    delegation: &Value,
    method: &str,
    params: &Value,
) -> Option<Value> {
    if delegation["clientId"] != "harness-api" || delegation["principal"]["kind"] != "person" {
        return None;
    }
    let token = delegation["token"].as_str()?;
    let user = delegation["principal"]["userId"].as_str()?;
    if !matches!(
        method,
        "supervisor.auth" | "admin.import.status" | "admin.import.abort" | "admin.import.runs"
    ) {
        return None;
    }
    let state = relock(&shared.maintenance);
    let active = state.active.as_ref().or(state.pending.as_ref())?;
    let proof = state.proofs.get(&active.run_id)?;
    if proof.expires_at <= super::now_ms()
        || proof.principal["userId"] != user
        || proof.token_sha256 != format!("{:x}", Sha256::digest(token.as_bytes()))
        || matches!(method, "admin.import.status" | "admin.import.abort")
            && params["runId"] != active.run_id
    {
        return None;
    }
    let mut principal = proof.principal.clone();
    principal["_maintenanceRun"] = json!(active.run_id);
    Some(principal)
}

pub fn validate(method: &str, params: &Value) -> Result<(), ExtError> {
    static VALIDATORS: std::sync::OnceLock<BTreeMap<String, jsonschema::Validator>> =
        std::sync::OnceLock::new();
    let validators = VALIDATORS.get_or_init(|| {
        let schema: Value =
            serde_json::from_str(plur1bus_rpc::SCHEMA_JSON).expect("embedded RPC schema");
        ["apply", "status", "abort", "runs", "rollback"]
            .into_iter()
            .map(|suffix| {
                let method = format!("admin.import.{suffix}");
                let schema = json!({"$schema":"https://json-schema.org/draft/2020-12/schema",
                "$defs":schema["$defs"], "$ref":format!("#/$defs/methods/{method}/params")});
                let validator = jsonschema::options()
                    .with_draft(jsonschema::Draft::Draft202012)
                    .build(&schema)
                    .expect("maintenance params schema");
                (method, validator)
            })
            .collect()
    });
    if validators
        .get(method)
        .is_some_and(|validator| validator.is_valid(params))
    {
        Ok(())
    } else {
        Err(ExtError::new(
            "E_INVALID_PARAMS",
            "invalid-params",
            "invalid import maintenance parameters",
        ))
    }
}

pub fn persist(shared: &Shared, layout: &Layout, record: RunRecord) -> Result<(), ExtError> {
    super::import_history::validate_run(&record.run)?;
    let id = &record.job.run_id;
    if !records::uuid(id) {
        return Err(records::unavailable());
    }
    let directory = records::directory(layout, &["imports", id])?;
    records::write(layout, &directory.join("maintenance-run.json"), &record)?;
    relock(&shared.maintenance).runs.insert(id.clone(), record);
    Ok(())
}

pub fn update(
    shared: &Shared,
    layout: &Layout,
    job: &Job,
    change: impl FnOnce(&mut Value),
) -> Result<(), ExtError> {
    let mut record = relock(&shared.maintenance)
        .runs
        .get(&job.run_id)
        .cloned()
        .ok_or_else(records::unavailable)?;
    change(&mut record.run);
    record.run["updatedAt"] = json!(super::iso8601(super::now_ms()));
    persist(shared, layout, record)
}

pub fn progress(
    shared: &Shared,
    layout: &Layout,
    job: &Job,
    envelope: &Value,
) -> Result<(), ExtError> {
    let _watch = relock(&WATCH);
    let mut event = envelope
        .as_object()
        .cloned()
        .ok_or_else(records::unavailable)?;
    event.remove("v");
    event.remove("type");
    let event = Value::Object(event);
    static VALIDATOR: std::sync::OnceLock<jsonschema::Validator> = std::sync::OnceLock::new();
    let validator = VALIDATOR.get_or_init(|| {
        let schema: Value = serde_json::from_str(plur1bus_rpc::SCHEMA_JSON).expect("RPC schema");
        jsonschema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .build(&json!({
            "$defs":schema["$defs"],"$ref":"#/$defs/notifications/import.progress"}))
            .expect("progress schema")
    });
    if event["runId"] != job.run_id || event.to_string().len() > 4096 || !validator.is_valid(&event)
    {
        return Err(ExtError::new(
            "E_INTERNAL",
            "worker-failed",
            "invalid import progress",
        ));
    }
    update(shared, layout, job, |run| {
        run["progress"] = event.clone();
        let state = match event["phase"].as_str() {
            Some("snapshot") => Some("snapshotting"),
            Some("apply" | "verify") => Some("applying"),
            Some("rollback") => Some("rolling-back"),
            _ => None,
        };
        if let Some(state) = state.filter(|_| run["state"] != "restarting-core") {
            run["state"] = json!(state);
        }
    })?;
    let id = uuid::Uuid::parse_str(&job.run_id)
        .map_err(|_| records::unavailable())?
        .as_u128();
    shared.subscribers.broadcast(
        super::subscribers::Topic::Import(id),
        "import.progress",
        &event,
    );
    Ok(())
}

pub(super) use super::import_history::{load, owned};
pub use super::import_history::{read_method, watch_status};

/// The scheduler owns the active job until the restored or imported Core is usable again.
pub fn take_pending(shared: &Shared) -> Option<Job> {
    let mut state = relock(&shared.maintenance);
    if state.preparing || state.active.is_some() || state.blocked {
        return None;
    }
    let job = state.pending.take()?;
    state.active = Some(job.clone());
    Some(job)
}

pub fn stage(shared: &Shared, layout: &Layout, job: &Job, phase: &str) -> Result<(), ExtError> {
    let mut state = relock(&shared.maintenance);
    let mut record = state
        .runs
        .get(&job.run_id)
        .cloned()
        .ok_or_else(records::unavailable)?;
    record.job = job.clone();
    record.run["state"] = json!(phase);
    record.run["updatedAt"] = json!(super::iso8601(super::now_ms()));
    let directory = records::directory(layout, &["imports", &job.run_id])?;
    records::write(layout, &directory.join("maintenance-run.json"), &record)?;
    state.runs.insert(job.run_id.clone(), record);
    state.active = Some(job.clone());
    Ok(())
}

/// Serialize the late-abort decision with abort admission. An accepted abort can never be lost at commit.
pub fn begin_restart(shared: &Shared, layout: &Layout, job: &Job) -> Result<bool, ExtError> {
    let mut state = relock(&shared.maintenance);
    if job.mode == "apply" && state.abort_requested {
        return Ok(false);
    }
    let mut record = state
        .runs
        .get(&job.run_id)
        .cloned()
        .ok_or_else(records::unavailable)?;
    record.job = job.clone();
    record.run["state"] = json!("restarting-core");
    record.run["updatedAt"] = json!(super::iso8601(super::now_ms()));
    let directory = records::directory(layout, &["imports", &job.run_id])?;
    records::write(layout, &directory.join("maintenance-run.json"), &record)?;
    state.runs.insert(job.run_id.clone(), record);
    state.active = Some(job.clone());
    Ok(true)
}

pub fn finish(shared: &Shared, layout: &Layout, job: &Job, result: &Value) -> Result<(), ExtError> {
    audit(
        layout,
        job,
        "import.finished",
        json!({"status":result["status"],"restored":result["restored"]}),
    )?;
    let mut state = relock(&shared.maintenance);
    let mut record = state
        .runs
        .get(&job.run_id)
        .cloned()
        .ok_or_else(records::unavailable)?;
    {
        let run = &mut record.run;
        run["state"] = result["status"].clone();
        run["restored"] = result["restored"].clone();
        run["resumable"] = result["resumable"].clone();
        run["rollbackAvailable"] = json!(
            result["restored"] == false
                && (result["ok"] == true || run["rollbackAvailable"] == true)
        );
        if let Some(report) = result.get("report") {
            run["report"] = report.clone();
        }
        if let Some(error) = result.get("error") {
            run["error"] = error.clone();
        }
    }
    record.run["updatedAt"] = json!(super::iso8601(super::now_ms()));
    super::import_history::validate_run(&record.run)?;
    let directory = records::directory(layout, &["imports", &job.run_id])?;
    records::write(layout, &directory.join("maintenance-run.json"), &record)?;
    state.runs.insert(job.run_id.clone(), record);
    state.active = None;
    state.pending = None;
    state.abort_requested = false;
    state.proofs.clear();
    shared.wake.notify_all();
    Ok(())
}
