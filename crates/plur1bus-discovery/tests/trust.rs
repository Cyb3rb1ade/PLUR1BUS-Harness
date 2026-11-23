#![allow(clippy::unwrap_used, reason = "checked TypeScript fixture")]

use std::collections::HashSet;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use plur1bus_discovery::trust::{Envelope, Root};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::{json, Value};

#[test]
fn threshold_expiry_and_key_revocation_replay_typescript() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/discovery/trust.json"
    ))
    .unwrap();
    let keys = [1, 2].map(|byte| Ed25519KeyPair::from_seed_unchecked(&[byte; 32]).unwrap());
    let ids = ["fixture-a", "fixture-b"];
    for case in vectors["cases"].as_array().unwrap() {
        let expires = case["expires"].as_str().unwrap();
        let root = Root::parse(&json!({
            "type":"root", "version":1, "threshold":2,
            "expires": if case["oldRoot"] == true { "2026-11-20T00:00:00Z" } else { expires },
            "keys": keys.iter().enumerate().map(|(i,key)| json!({
                "id":ids[i], "publicKey": STANDARD.encode(key.public_key().as_ref()),
                "expires": if case["expired"] == true && i == 1 { "2026-11-20T00:00:00Z" } else { expires },
            })).collect::<Vec<_>>()
        }).to_string()).unwrap();
        let bytes = case["payload"].as_str().unwrap().as_bytes();
        let signatures: Vec<_> = case["signers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|index| {
                let i = usize::try_from(index.as_u64().unwrap()).unwrap();
                let signature = keys[i % 2].sign(bytes);
                json!({"keyId": ids.get(i).copied().unwrap_or("unknown-fixture"),
                "signature": STANDARD.encode(signature.as_ref())})
            })
            .collect();
        let envelope = serde_json::from_value::<Envelope>(json!({
            "payload": STANDARD.encode(bytes), "signatures": signatures,
        }))
        .unwrap();
        let revoked: HashSet<_> = case["revoked"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|id| id.as_str().unwrap())
            .collect();
        let actual = match root.verify(&envelope, case["now"].as_i64().unwrap(), &revoked) {
            Ok(verified) => json!({
                "signers":verified.signers(), "ignored":verified.ignored(),
                "bytes":std::str::from_utf8(verified.bytes()).unwrap(),
            }),
            Err(error) => json!({"code":error.code()}),
        };
        assert_eq!(actual, case["expected"], "{}", case["name"]);
    }
}
