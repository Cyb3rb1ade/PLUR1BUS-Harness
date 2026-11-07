//! `events.subscribe` and `events.unsubscribe` behind the front door, and the fan-out of notifications (ADR-012 §3).
//!
//! Every subscription is made on the client's link, so the legacy core registers it against the client's own identity
//! and runs its audience filter (persons, agents, RBAC visibility, opt-in names, the API's connection-bound events) for
//! everything it emits: those notifications reach the client through the link unchanged. The front door adds only what it
//! emits itself, `core.state` for its own process state, and drops the legacy core's `core.state` on the same
//! connections, so a subscriber sees one process.
//!
//! The front door emits `core.state` to owner connections only, with the TypeScript server's rule for a notification
//! without an audience: the first subscription whose `names` include it (or that has none) and that is not filtered by
//! `agentId`. API connections keep the legacy core's `core.state` instead, because their delivery needs the person behind
//! the API principal, which only the legacy core can resolve until P4-12 (P4D-2: an API subscriber does not see the front
//! door's `orphaned`). Engine subscriptions are limited to `egress.changed`, and scoped clients cannot subscribe, as in
//! the TypeScript core.
use serde_json::Value;

/// One subscription the legacy core accepted on an owner link.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sub {
    /// The legacy core's subscription id.
    pub id: String,
    /// `names`, when given.
    pub names: Option<Vec<String>>,
    /// `agentId`, when given.
    pub agent_id: Option<String>,
}

impl Sub {
    /// The subscription an accepted `events.subscribe { names?, agentId? }` made, from its params and result.
    pub fn from_call(params: &Value, result: &Value) -> Option<Sub> {
        Some(Sub {
            id: result.get("subscriptionId")?.as_str()?.to_owned(),
            names: params.get("names").and_then(Value::as_array).map(|n| {
                n.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            }),
            agent_id: params
                .get("agentId")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }

    /// `rpc-server.ts` `notify(method, params)` without an audience, for a notification without an `agentId` param.
    pub fn takes_unaddressed(&self, method: &str) -> bool {
        let named = self
            .names
            .as_ref()
            .is_none_or(|n| n.iter().any(|x| x == method));
        named && self.agent_id.is_none()
    }
}

/// Whether a set of subscriptions gets the front door's `core.state` (once per connection).
pub fn takes_core_state(subs: &[Sub]) -> bool {
    subs.iter().any(|s| s.takes_unaddressed("core.state"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn core_state_reaches_unfiltered_and_naming_subscriptions_only() {
        let sub = |params: Value| Sub::from_call(&params, &json!({"subscriptionId":"s"})).unwrap();
        assert!(takes_core_state(&[sub(json!({}))]));
        assert!(takes_core_state(&[sub(
            json!({"names":["core.state","agent.activity"]})
        )]));
        assert!(!takes_core_state(&[sub(
            json!({"names":["agent.activity"]})
        )]));
        assert!(
            !takes_core_state(&[sub(json!({"agentId":"bernd"}))]),
            "an agent filter needs params.agentId"
        );
        assert!(!takes_core_state(&[]));
        assert!(takes_core_state(&[
            sub(json!({"agentId":"bernd"})),
            sub(json!({}))
        ]));
        assert!(Sub::from_call(&json!({}), &json!({})).is_none());
    }
}
