//! Pure run-state rate-limit transitions. A metadata key is neither authority nor an execution lock.
mod store;
use super::{
    ledger::json::node_value,
    metadata::{get, truthy},
};
use crate::{
    capture::{dynamics::number as js_number, interference::bounded},
    contract::{Cancel, EngineError, StoreError},
    text::json::TolerantJsonValue as Json,
};
pub use store::RateLimitStore;

/// Frozen Node job:agent:workspace composition. Colons deliberately retain legacy key semantics.
/// Host composition must separately select an authorized state file; keys cannot isolate tenants.
pub struct Key(String);
impl Key {
    /// Construct bounded labels; absent/empty agent or workspace becomes the literal `all`.
    pub fn new(
        job: &str,
        agent: Option<&str>,
        workspace: Option<&str>,
    ) -> Result<Self, EngineError> {
        if job.is_empty()
            || [Some(job), agent, workspace]
                .into_iter()
                .flatten()
                .any(|v| v.len() > 1024)
        {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(Self(format!(
            "{job}:{}:{}",
            agent.filter(|s| !s.is_empty()).unwrap_or("all"),
            workspace.filter(|s| !s.is_empty()).unwrap_or("all")
        )))
    }
}
fn prepare(state: Option<&Json>, now: f64, cancel: &Cancel) -> Result<Json, EngineError> {
    cancel.check()?;
    if !now.is_finite() {
        return Err(StoreError::InvalidInput.into());
    }
    if let Some(value) = state {
        if !matches!(value, Json::Object(_)) {
            return Err(StoreError::InvalidInput.into());
        }
        bounded(value, cancel, &mut (0, 0))?;
        if get(value, "jobRateLimits")
            .is_some_and(|rates| truthy(Some(rates)) && !matches!(rates, Json::Object(_)))
        {
            return Err(StoreError::InvalidInput.into());
        }
    }
    Ok(state.cloned().unwrap_or_else(|| Json::Object(vec![])))
}
/// Read-only Node decision over an already loaded state. Absence is empty, corrupt bytes are not.
/// A nonnumeric truthy legacy lastRunAt denies execution and retains its exact diagnostic value.
pub fn check(
    state: Option<&Json>,
    key: &Key,
    interval_ms: f64,
    now: f64,
    cancel: &Cancel,
) -> Result<Json, EngineError> {
    if !interval_ms.is_finite() || interval_ms < 0.0 {
        return Err(StoreError::InvalidInput.into());
    }
    let state = prepare(state, now, cancel)?;
    let last = get(&state, "jobRateLimits")
        .and_then(|rates| get(rates, &key.0))
        .and_then(|entry| get(entry, "lastRunAt"))
        .filter(|value| truthy(Some(value)))
        .cloned()
        .unwrap_or_else(|| number(0.0));
    let elapsed = now - js_number(Some(&last));
    let allowed = elapsed >= interval_ms;
    let mut fields = vec![("allowed".into(), Json::Bool(allowed))];
    if !allowed {
        fields.push(("remainingMs".into(), number(interval_ms - elapsed)));
    }
    fields.push(("lastRunAt".into(), last));
    cancel.check()?;
    Ok(node_value(Json::Object(fields)))
}
/// Propose the exact compact Node state after one successful run, preserving unrelated fields.
/// This does not persist, reserve a run window or authorize the legacy `all`/colon namespaces.
/// Malformed truthy rate maps are refused rather than replaced or silently losing array properties.
pub fn record(
    state: Option<&Json>,
    key: &Key,
    now: f64,
    cancel: &Cancel,
) -> Result<Json, EngineError> {
    let mut state = prepare(state, now, cancel)?;
    let mut rates = get(&state, "jobRateLimits")
        .filter(|value| truthy(Some(value)))
        .cloned()
        .unwrap_or_else(|| Json::Object(vec![]));
    if !matches!(rates, Json::Object(_)) {
        return Err(StoreError::InvalidInput.into());
    }
    let count = get(&rates, &key.0)
        .and_then(|entry| get(entry, "runCount"))
        .filter(|value| truthy(Some(value)));
    let next = match count {
        Some(value @ (Json::String(_) | Json::Array(_) | Json::Object(_))) => {
            let mut units = crate::neo::merged_order::string(value)
                .as_utf16_units()
                .to_vec();
            units.push(u16::from(b'1'));
            Json::String(crate::text::js::JsString::from_utf16_units(units))
        }
        Some(value) => number(js_number(Some(value)) + 1.0),
        None => number(1.0),
    };
    set(
        &mut rates,
        &key.0,
        Json::Object(vec![
            ("lastRunAt".into(), number(now)),
            ("runCount".into(), next),
        ]),
    )?;
    set(&mut state, "jobRateLimits", rates)?;
    bounded(&state, cancel, &mut (0, 0))?;
    cancel.check()?;
    Ok(node_value(state))
}
fn number(value: f64) -> Json {
    if value.is_finite() {
        Json::Number(ryu_js::Buffer::new().format_finite(value).into())
    } else {
        Json::Null
    }
}
fn set(object: &mut Json, name: &str, value: Json) -> Result<(), EngineError> {
    let Json::Object(fields) = object else {
        return Err(StoreError::InvalidInput.into());
    };
    if let Some((_, old)) = fields.iter_mut().find(|(key, _)| key == &name.into()) {
        *old = value;
    } else {
        fields.push((name.into(), value));
    }
    Ok(())
}
