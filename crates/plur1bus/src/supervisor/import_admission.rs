//! Admission binds a live Core preflight to one human-owned scheduler job.
use super::import_records as records;
use super::imports::{busy_error, owned, owner, persist, validate, Job, Proof, RunRecord};
use super::{relock, Shared};
use crate::{ext::ExtError, paths::Layout};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

struct Reservation<'a>(&'a Shared);
impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        relock(&self.0.maintenance).preparing = false;
        self.0.wake.notify_all();
    }
}

/// Claim an exact live-Core preflight before a pending job becomes visible to the scheduler.
pub fn queue(
    shared: &Arc<Shared>,
    layout: &Layout,
    method: &str,
    params: &Value,
    principal: Option<&Value>,
    delegation: Option<&Value>,
) -> Result<Value, ExtError> {
    validate(method, params)?;
    let user = owner(principal)?;
    {
        let state = shared.lock();
        if state.no_core {
            return Err(ExtError::new(
                "E_NOT_AVAILABLE",
                "no-children",
                "a supervised Core is required",
            ));
        }
        if state.stopping.is_some()
            || state.restart_running
            || !state.restart_jobs.is_empty()
            || !state.module_ops.is_empty()
        {
            return Err(busy_error());
        }
    }
    // Fence old package writers before raising maintenance admission, so their rollback cannot be interrupted.
    let _ext_guard = crate::ext::try_mutation()?;
    let _inspection_fence = super::ext::inspection_fence()?;
    {
        let mut state = relock(&shared.maintenance);
        if state.preparing || state.pending.is_some() || state.active.is_some() || state.blocked {
            return Err(busy_error());
        }
        state.preparing = true;
    }
    let _reservation = Reservation(shared);
    {
        let state = shared.lock();
        if state.stopping.is_some()
            || state.restart_running
            || !state.restart_jobs.is_empty()
            || !state.module_ops.is_empty()
        {
            return Err(busy_error());
        }
    }
    let rollback = method == "admin.import.rollback";
    let prior = if rollback || params["resume"] == true {
        let run_id = if rollback {
            params["runId"].as_str().ok_or_else(records::unavailable)?
        } else {
            ""
        };
        if rollback {
            Some(owned(shared, layout, run_id, user)?)
        } else {
            None
        }
    } else {
        None
    };
    let plan_id = if rollback {
        prior.as_ref().unwrap().job.plan_id.as_str()
    } else {
        params["planId"].as_str().ok_or_else(records::unavailable)?
    };
    let (plan, digest) = records::plan(layout, plan_id)?;
    if plan.owner_id != user {
        return Err(records::unavailable());
    }
    let now = super::now_ms();
    if !rollback && plan.expires_at <= super::iso8601(now) {
        return Err(records::unavailable());
    }
    let prior = if params["resume"] == true {
        Some(owned(shared, layout, &plan.run_id, user)?)
    } else {
        prior
    };
    if let Some(prior) = &prior {
        let allowed = if rollback {
            prior.run["rollbackAvailable"] == true
        } else {
            prior.run["resumable"] == true && prior.run["restored"] == true
        };
        if !allowed {
            return Err(ExtError::new(
                "E_CONFLICT",
                "run-not-resumable",
                "this import operation is unavailable",
            ));
        }
    } else if layout
        .home
        .join("imports")
        .join(&plan.run_id)
        .join("maintenance-run.json")
        .exists()
    {
        return Err(ExtError::new(
            "E_CONFLICT",
            "run-exists",
            "use a fresh preflight and explicit resume",
        ));
    }
    let current = relock(&shared.config)
        .revision
        .clone()
        .ok_or_else(records::unavailable)?;
    // Rollback and resume preflights bind the current target separately; the original plan keeps its original revision.
    if !rollback && params["resume"] != true && current != plan.config_revision {
        return Err(ExtError::new(
            "E_CONFLICT",
            "config-changed",
            "target configuration changed",
        ));
    }
    if plan.options["migrateSecrets"] == true && principal.is_some_and(|p| p["role"] != "owner") {
        return Err(ExtError::new(
            "E_DENIED",
            "secret-owner-required",
            "secret migration requires Owner",
        ));
    }
    let ticket = records::claim(
        layout,
        params["preflightId"]
            .as_str()
            .ok_or_else(records::unavailable)?,
        &plan,
        &digest,
        user,
        if rollback { "rollback" } else { "apply" },
        now,
    )?;
    let attempt = prior
        .as_ref()
        .map_or(Some(1), |record| {
            record.job.attempt.checked_add(u64::from(!rollback))
        })
        .ok_or_else(records::unavailable)?;
    let job = Job {
        invocation_id: uuid::Uuid::new_v4().to_string(),
        run_id: plan.run_id.clone(),
        plan_id: plan.id,
        plan_sha256: digest,
        owner_id: user.into(),
        role: principal
            .and_then(|p| p["role"].as_str())
            .unwrap_or("owner")
            .into(),
        source_type: plan.source_type,
        mode: if rollback { "rollback" } else { "apply" }.into(),
        attempt,
        preflight_id: Some(ticket.id),
        target_sha256: Some(ticket.target_sha256),
        migrate_secrets: plan.options["migrateSecrets"] == true,
        automatic_rollback: false,
    };
    let record = RunRecord {
        version: 1,
        job: job.clone(),
        run: json!({"runId":job.run_id,"planId":job.plan_id,
        "sourceType":job.source_type,"state":"queued","attempt":attempt,"createdAt":plan.created_at,
        "updatedAt":super::iso8601(now),"restored":false,"resumable":false,"rollbackAvailable":rollback}),
    };
    super::imports::audit(layout, &job, "import.requested", json!({"mode":job.mode}))?;
    persist(shared, layout, record)?;
    let run_id = job.run_id.clone();
    let mut state = relock(&shared.maintenance);
    if let (Some(principal), Some(token)) =
        (principal, delegation.and_then(|api| api["token"].as_str()))
    {
        state.proofs.clear();
        state.proofs.insert(
            run_id.clone(),
            Proof {
                principal: principal.clone(),
                token_sha256: format!("{:x}", Sha256::digest(token.as_bytes())),
                expires_at: now + 75 * 60_000,
            },
        );
    }
    state.abort_requested = false;
    state.pending = Some(job);
    drop(state);
    shared.wake.notify_all();
    Ok(json!({"runId":run_id,"state":"queued"}))
}
