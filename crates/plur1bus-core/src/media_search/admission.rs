//! Live provider selection and per-call media admission.

use super::{Caller, Error, Kind, Scope};
use serde::Serialize;
use serde_json::Value;

/// One trusted provider binding and its current local-only policy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Route {
    /// Configured provider identity.
    pub provider: String,
    /// Current model.
    pub model: String,
    /// Exact provider endpoint, if configurable.
    pub endpoint: Option<String>,
    /// Trusted locality classification.
    pub local: bool,
    /// Whether the shared or agent local-only policy applies.
    pub pinned: bool,
    /// Current function-specific acknowledgment.
    pub acknowledgment: Option<Value>,
}

/// Kind of effect whose route is being checked.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Operation {
    /// Encode stored media.
    Encode(Kind),
    /// Text query encoding.
    Search,
    /// Start or resume a bulk operation.
    Backfill,
    /// Caption the specified media kind.
    Caption(Kind),
}

/// The effective route resolver supplied by the trusted host.
pub trait Policy {
    /// Resolve current policy for the exact work and scope.
    fn route(&self, op: Operation, scope: &Scope) -> Option<Route>;
}

/// Units reserved for one cloud embedding.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Units<'a> {
    /// Agent billed.
    pub agent_id: &'a str,
    /// Exact configured model.
    pub model: &'a str,
    /// Number of images.
    pub images: u32,
    /// Rounded-up verified video duration.
    pub video_seconds: u32,
}
/// Completion of media reservation. Any started encode consumes the held units.
pub trait Hold {
    /// Settle a started operation.
    fn settle(self: Box<Self>) -> Result<(), Error>;
    /// Release a reservation that never reached the port.
    fn release(self: Box<Self>) -> Result<(), Error>;
}
/// Persistent unit reservation port.
pub trait Budget {
    /// Reserve exact units for the chosen route.
    fn reserve(&self, units: Units<'_>) -> Result<Box<dyn Hold + '_>, Error>;
}

use plur1bus_config::privacy_ack::{privacy_acknowledgment_error, PrivacyChoice, PrivacyFunction};

const MAX_VIDEO_SECONDS: f64 = 86_400.0;

impl Route {
    pub(super) fn check(&self, function: PrivacyFunction) -> Result<(), Error> {
        if self.provider.is_empty() || self.model.is_empty() {
            return Err(unavailable("media-route-unavailable"));
        }
        if let Some(failure) = privacy_acknowledgment_error(&PrivacyChoice {
            function,
            provider: &self.provider,
            local: self.local,
            pinned: self.pinned,
            endpoint: self.endpoint.as_deref(),
            ack: self.acknowledgment.as_ref(),
        }) {
            return Err(Error::new(failure.code, failure.reason));
        }
        Ok(())
    }
}

fn unavailable(reason: &'static str) -> Error {
    Error::new("E_MEDIA_UNAVAILABLE", reason)
}

pub(super) fn current(
    caller: &Caller<'_>,
    policy: &dyn Policy,
    op: Operation,
    action: &'static str,
    function: PrivacyFunction,
) -> Result<Route, Error> {
    caller.authorize(action)?;
    let route = policy
        .route(op, caller.scope)
        .ok_or_else(|| unavailable("media-route-unavailable"))?;
    route.check(function)?;
    Ok(route)
}

pub(super) fn unchanged(
    caller: &Caller<'_>,
    policy: &dyn Policy,
    op: Operation,
    action: &'static str,
    function: PrivacyFunction,
    expected: &Route,
) -> Result<(), Error> {
    if current(caller, policy, op, action, function)? != *expected {
        return Err(unavailable("media-route-changed"));
    }
    Ok(())
}

/// Run an encoder with the current route and matching budget.
pub fn encode<T>(
    caller: &Caller<'_>,
    policy: &dyn Policy,
    budget: Option<&dyn Budget>,
    kind: Kind,
    trusted_seconds: Option<f64>,
    call: impl FnOnce(&Route) -> Result<T, Error>,
) -> Result<T, Error> {
    let op = Operation::Encode(kind);
    let action = "media.write";
    let function = PrivacyFunction::Media;
    let route = current(caller, policy, op, action, function)?;
    if route.local {
        let result = call(&route)?;
        unchanged(caller, policy, op, action, function, &route)?;
        return Ok(result);
    }
    let budget = budget.ok_or_else(|| unavailable("media-unit-budget-unbound"))?;
    let (images, video_seconds) = match kind {
        Kind::Image => (1, 0),
        Kind::Video => {
            let seconds = trusted_seconds
                .filter(|s| s.is_finite() && *s > 0.0 && *s <= MAX_VIDEO_SECONDS)
                .ok_or_else(|| unavailable("trusted-media-duration"))?;
            (0, seconds.ceil() as u32)
        }
        Kind::Audio => return Err(unavailable("trusted-media-duration")),
    };
    let hold = budget.reserve(Units {
        agent_id: &caller.scope.agent_id,
        model: &route.model,
        images,
        video_seconds,
    })?;
    if let Err(error) = unchanged(caller, policy, op, action, function, &route) {
        hold.release()?;
        return Err(error);
    }
    let result = call(&route);
    hold.settle()?;
    unchanged(caller, policy, op, action, function, &route)?;
    result
}

/// Admit the local-only search or backfill operation.
pub fn local_operation<T>(
    caller: &Caller<'_>,
    policy: &dyn Policy,
    op: Operation,
    call: impl FnOnce(&Route) -> Result<T, Error>,
) -> Result<T, Error> {
    let action = match op {
        Operation::Search => "media.index.read",
        Operation::Backfill => "media.index.operate",
        _ => return Err(Error::new("E_INVALID_PARAMS", "media-operation")),
    };
    let function = PrivacyFunction::Media;
    let route = current(caller, policy, op, action, function)?;
    if !route.local {
        return Err(unavailable("cloud-bulk-or-query-unmetered"));
    }
    let result = call(&route)?;
    unchanged(caller, policy, op, action, function, &route)?;
    Ok(result)
}

#[cfg(test)]
#[path = "admission_vectors.rs"]
mod vectors;
