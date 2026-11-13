//! C5 owner-bound delivery. The Lance pending transition reserves a single POST.
use super::{
    lance_scope::LanceScope,
    registry::{JobBody, JobContext, JobReport},
};
use crate::{
    context::RequestContext,
    contract::{Cancel, EngineError, JobName, JobOutcome, MemoryRow, MemoryScope, StoreError},
    ops::write::MutationStores,
    recall::{acl, tombstone_mask::TombstoneMask},
    store::{RowFilter, RowPatch},
    transport::{GuardedClient, HttpRequest, TransportError},
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

const RETRY_MS: i64 = 300_000;
const MAX_ATTEMPTS: f64 = 5.;
const WEBHOOK_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) struct ReminderDispatch {
    pub scope: Arc<LanceScope>,
    pub base: PathBuf,
}

fn filter(request: &RequestContext) -> RowFilter {
    RowFilter {
        agent_id: Some(request.agent_id.to_string()),
        scope: Some(MemoryScope::AgentPrivate),
        status: Some("active".into()),
        workspace_id: Some(request.workspace_key.clone()),
        owner_user_id: Some(request.owner_user_id.clone()),
        memory_kind: Some("reminder".into()),
        ..RowFilter::default()
    }
}

fn owned(row: &MemoryRow, request: &RequestContext) -> bool {
    row.stored_by == request.agent_id.as_str()
        && row.workspace_key == request.workspace_key
        && acl::allowed(row, request).is_ok()
}

/// Pending delivery stays in the authenticated Lance row. The legacy workspace
/// queue lacks an owner field and is ineligible for native recall.
pub(crate) fn recall_rows(
    stores: &dyn MutationStores,
    request: &RequestContext,
    tombstones: &TombstoneMask,
    now: i64,
    cancel: &Cancel,
) -> Result<(Vec<Value>, Vec<Value>), EngineError> {
    cancel.check()?;
    if request.owner_user_id.is_empty()
        || request.workspace_key.is_empty()
        || request.chat_kind() != "private"
    {
        return Ok((vec![], vec![]));
    }
    let Some(store) = stores.existing_private(request)? else {
        return Ok((vec![], vec![]));
    };
    let mut due = vec![];
    let mut pending = vec![];
    for row in store.reminders_for_recall(&filter(request), now)? {
        cancel.check()?;
        if owned(&row, request) && !tombstones.masks(&row)? {
            let value = json!({"id":row.id,"text":row.text,"remindAt":row.remind_at});
            if row.reminder_status == "pending" {
                pending.push(value);
            } else {
                due.push(value);
            }
        }
    }
    Ok((due, pending))
}

impl JobBody for ReminderDispatch {
    fn name(&self) -> JobName {
        JobName::ReminderDispatch
    }

    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        let cancel = &cancel.limited_to(Instant::now() + Duration::from_secs(120));
        let scope = &self.scope;
        let authority = context.authority()?;
        let (principal, agent) = authority.caller();
        let _operation = scope.operations.enter(principal, agent)?;
        let host = scope.operations.host();
        let config = serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)?;
        let settings = &config["reminders"];
        let endpoint = match settings["deliveryMode"].as_str().unwrap_or("pending_only") {
            "pending_only" => None,
            "webhook" => {
                let Some(url) = settings["webhookUrl"]
                    .as_str()
                    .map(str::trim)
                    .filter(|url| !url.is_empty())
                else {
                    return Ok(skipped("no_reminder_webhook"));
                };
                let (_, target) = crate::transport::target::parse_url(url)
                    .map_err(|_| StoreError::InvalidInput)?;
                if target.scheme == crate::contract::Scheme::Http
                    && !crate::transport::target::loopback_host(&target.host)
                {
                    return Ok(skipped("reminder_webhook_scheme"));
                }
                Some(url)
            }
            _ => return Ok(skipped("no_reminder_delivery_route")),
        };
        if let Some(skip) = scope.check(authority, cancel)? {
            return Ok(skip);
        }
        let request = authority.request();
        let Some(store) = scope.stores.existing_private(request)? else {
            return Ok(JobReport::completed());
        };
        let filter = filter(request);
        let now = context.now_ms;
        let tombstones = TombstoneMask::new(&self.base);
        let mut reserved = 0;
        let mut delivered = 0;
        let mut failed = 0;
        let mut unsettled = 0;
        for row in store.reminders_for_dispatch(&filter, now)? {
            if !owned(&row, request) {
                continue;
            }
            let attempt = row.dispatch_count.as_f64().unwrap_or(0.) + 1.;
            let reservation = RowPatch {
                reminder_status: Some("pending".into()),
                dispatch_count: Some(attempt),
                dispatched_at: Some(now as f64),
                last_dispatch_attempt_at: Some(now as f64),
                next_dispatch_attempt_at: Some(0.),
                ..RowPatch::default()
            };
            {
                let _mutation = scope.operations.mutation()?;
                if let Some(skip) = scope.check(authority, cancel)? {
                    return Ok(skip);
                }
                let live = serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)?;
                if &live["reminders"] != settings {
                    return Err(StoreError::Unavailable.into());
                }
                if tombstones.refreshed().masks(&row)? {
                    continue;
                }
                if store.dispatch_reminder(&filter, &row, &reservation, Some(now))? != 1 {
                    continue;
                }
            }
            reserved += 1;
            let Some(endpoint) = endpoint else {
                continue;
            };
            let ok = match deliver(scope, request, &row, endpoint, now, cancel) {
                Ok(status) => (200..300).contains(&status),
                // A connection may have received the POST before the client
                // lost its response. Preserve pending and the local recall path.
                Err(_) => {
                    unsettled += 1;
                    continue;
                }
            };
            delivered += usize::from(ok);
            failed += usize::from(!ok);
            let mut expected = row;
            expected.reminder_status = "pending".into();
            expected.dispatch_count =
                serde_json::Number::from_f64(attempt).ok_or(StoreError::Corrupt)?;
            let final_status = RowPatch {
                reminder_status: Some(if ok { "dispatched" } else { "failed" }.into()),
                next_dispatch_attempt_at: Some(if ok || attempt >= MAX_ATTEMPTS {
                    0.
                } else {
                    now.saturating_add(RETRY_MS) as f64
                }),
                ..RowPatch::default()
            };
            let mut saved = false;
            for _ in 0..2 {
                let _mutation = scope.operations.mutation()?;
                if let Some(skip) = scope.check(authority, cancel)? {
                    return Ok(skip);
                }
                match store.dispatch_reminder(&filter, &expected, &final_status, None) {
                    Ok(count) => {
                        saved = count == 1;
                        break;
                    }
                    Err(_) => log::warn!("reminder-dispatch: status write failed"),
                }
            }
            unsettled += usize::from(!saved);
        }
        for (name, count) in [
            ("dispatched", reserved),
            ("delivered", delivered),
            ("failed", failed),
            ("unsettled", unsettled),
        ] {
            context.note_count(name, count)?;
        }
        if unsettled > 0 {
            return Ok(JobReport {
                outcome: JobOutcome::Incomplete,
                reason: Some("reminder_status_write_failed".into()),
            });
        }
        Ok(JobReport::completed())
    }
}

fn skipped(reason: &str) -> JobReport {
    JobReport {
        outcome: JobOutcome::Skipped,
        reason: Some(reason.into()),
    }
}

fn deliver(
    scope: &LanceScope,
    request: &RequestContext,
    row: &MemoryRow,
    endpoint: &str,
    now: i64,
    cancel: &Cancel,
) -> Result<u16, TransportError> {
    let timestamp = chrono::DateTime::from_timestamp_millis(now)
        .ok_or(TransportError::InvalidRequest)?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let body = json!({
        "agentId": request.agent_id, "workspaceKey": request.workspace_key,
        "reminder":{"id":row.id,"text":row.text,"remindAt":row.remind_at},
        "timestamp":timestamp,
    });
    let request = HttpRequest {
        method: "POST".into(),
        url: endpoint.into(),
        headers: vec![
            ("Content-Type".into(), "application/json".into()),
            ("Idempotency-Key".into(), row.id.clone()),
        ],
        body: serde_json::to_vec(&body).map_err(|_| TransportError::InvalidRequest)?,
        max_response_bytes: 0,
        max_error_response_bytes: 0,
        auth_rejection_counter: None,
    };
    GuardedClient::for_host(scope.operations.host_handle()).delivery_status(
        request,
        Instant::now() + WEBHOOK_TIMEOUT,
        cancel,
    )
}
