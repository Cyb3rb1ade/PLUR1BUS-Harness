//! JSON-RPC message shapes of `plur1bus-rpc` (the generated `types`): arbitrary JSON deserialised as one of the wire
//! types. Invariants: never panics; a value that parses re-serialises, re-parses, and the second serialisation equals
//! the first (the type is a fixed point of `parse . serialise`). `client_response_line` covers the socket client.
use plur1bus_rpc::types::*;
use plur1bus_rpc::{capabilities, RpcError};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

fn fixed_point<T: Serialize + DeserializeOwned>(v: &Value, raw: &[u8]) {
    // Both entry points: from a parsed Value and straight from bytes (different serde_json code paths).
    let from_bytes = serde_json::from_slice::<T>(raw);
    let Ok(t) = serde_json::from_value::<T>(v.clone()) else {
        return;
    };
    assert!(
        from_bytes.is_ok(),
        "from_slice rejects what from_value accepts"
    );
    let first = serde_json::to_value(&t).expect("a parsed wire type serialises");
    let again: T = serde_json::from_value(first.clone()).expect("a serialised wire type re-parses");
    let second = serde_json::to_value(&again).expect("serialises again");
    assert_eq!(first, second, "parse . serialise is not a fixed point");
}

pub fn run(data: &[u8]) {
    let Some((&sel, rest)) = data.split_first() else {
        return;
    };
    let text = String::from_utf8_lossy(rest);
    // Error values built from hostile text: Display and the accessors must not panic.
    let e = RpcError::Protocol(text.to_string());
    let _ = (e.to_string(), e.code_name(), e.ids(), e.ext());

    let Ok(v) = serde_json::from_slice::<Value>(rest) else {
        return;
    };
    if sel % 9 == 5 {
        // Builds the capabilities document from the embedded schema: slow, so only in its own mode.
        let features: Vec<&str> = text.split(',').collect();
        let _ = capabilities(&text, &features);
    }
    match sel % 9 {
        0 => fixed_point::<Request>(&v, rest),
        1 => fixed_point::<Response>(&v, rest),
        2 => fixed_point::<Notification>(&v, rest),
        3 => fixed_point::<ErrorObject>(&v, rest),
        4 => fixed_point::<Id>(&v, rest),
        5 => fixed_point::<Capabilities>(&v, rest),
        6 => fixed_point::<JournalLine>(&v, rest),
        7 => fixed_point::<CoreStatus>(&v, rest),
        _ => fixed_point::<ExtInspection>(&v, rest),
    }
}
