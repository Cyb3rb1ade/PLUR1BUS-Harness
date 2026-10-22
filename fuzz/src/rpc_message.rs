//! JSON-RPC message shapes of `plur1bus-rpc` (the generated `types`): arbitrary JSON deserialised as one of the wire
//! types. Invariants: never panics; a value that parses re-serialises, re-parses, and the second serialisation equals
//! the first (the type is a fixed point of `parse . serialise`). `client_response_line` covers the socket client.
use plur1bus_rpc::types::*;
use plur1bus_rpc::{capabilities, RpcError};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

fn fixed_point<T: Serialize + DeserializeOwned>(v: &Value) {
    let Ok(t) = serde_json::from_value::<T>(v.clone()) else {
        return;
    };
    // The byte path (`from_slice`, a different serde_json code path) must decide like `from_value`. It is fed the bytes of
    // the parsed `Value`, not the raw input: a raw input may repeat a key, which `Value` collapses (last one wins, the way
    // `Client` reads every line: `from_slice::<Value>` then `from_value`) while a derived struct read straight from bytes
    // refuses it as `duplicate field`. That difference is by design (`fuzz_lines.rs` pins last-wins), not an inconsistency
    // of the wire types, so it must not be part of this check.
    let bytes = serde_json::to_vec(v).expect("a Value serialises");
    assert!(
        serde_json::from_slice::<T>(&bytes).is_ok(),
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
        0 => fixed_point::<Request>(&v),
        1 => fixed_point::<Response>(&v),
        2 => fixed_point::<Notification>(&v),
        3 => fixed_point::<ErrorObject>(&v),
        4 => fixed_point::<Id>(&v),
        5 => fixed_point::<Capabilities>(&v),
        6 => fixed_point::<JournalLine>(&v),
        7 => fixed_point::<CoreStatus>(&v),
        _ => fixed_point::<ExtInspection>(&v),
    }
}
