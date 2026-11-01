//! RPC fixtures keep credentials out of committed JSON; both typed fixture suites hydrate them in memory.
use serde_json::Value;
use std::hash::BuildHasher;

/// Clone a fixture, supplying fresh process-local test credentials for the Core/tools handshake only.
pub fn hydrated(name: &str, fixture: &Value) -> Value {
    let mut fixture = fixture.clone();
    if name == "tools.hello" {
        let runtime = std::collections::hash_map::RandomState::new();
        for field in ["token", "ticketKey"] {
            let value = (0..4)
                .map(|i| format!("{:016x}", runtime.hash_one((field, i))))
                .collect::<String>();
            fixture["params"][field] = value.into();
        }
    }
    fixture
}
