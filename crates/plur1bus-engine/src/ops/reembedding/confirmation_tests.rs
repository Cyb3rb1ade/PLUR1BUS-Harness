#![allow(clippy::unwrap_used, reason = "recorded confirmation fixtures")]
use super::*;
use std::collections::BTreeSet;
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/ops/golden/reembedding-confirmation.json"
    ))
    .unwrap()
}
#[test]
fn actual_node_confirmation_creation_matches_without_persisting_proofs() {
    for case in fixture()["creation"].as_array().unwrap() {
        let seed = case["seed"].as_u64().unwrap() as u8;
        let result = from_entropy(
            case["digest"].as_str().unwrap(),
            case["expiry"].as_u64().unwrap(),
            &[seed; 32],
        );
        if let Some(error) = case["error"].as_str() {
            let expected = match error {
                "invalid reembedding plan digest" => ConfirmationError::PlanDigest,
                "invalid reembedding confirmation expiry" => ConfirmationError::Expiry,
                _ => unreachable!("unexpected Node category"),
            };
            assert_eq!(result.unwrap_err(), expected, "{}", case["name"]);
        } else {
            let result = result.unwrap();
            assert_eq!(
                format!("{:x}", Sha256::digest(result.expose_token().as_bytes())),
                case["result"]["proofSha256"]
            );
            assert_eq!(
                serde_json::to_value(result.persisted()).unwrap(),
                case["result"]["persisted"]
            );
            assert!(proof_shape(result.expose_token()));
            assert!(!format!("{result:?}").contains(result.expose_token()));
            assert!(!serde_json::to_string(result.persisted())
                .unwrap()
                .contains(result.expose_token()));
        }
    }
}
#[test]
fn actual_node_binding_and_strict_expiry_match_all_malformed_cases() {
    let digest = format!("sha256:{}", "a".repeat(64));
    for case in fixture()["verification"].as_array().unwrap() {
        let original = from_entropy(&digest, 1000, &[9; 32]).unwrap();
        let mut proof = original.expose_token().to_owned();
        match case["proof"].as_str() {
            Some("different-seed") => {
                proof = from_entropy(&digest, 1000, &[8; 32])
                    .unwrap()
                    .expose_token()
                    .to_owned()
            }
            Some("prefix") => proof = format!("invalid{}", &proof[8..]),
            Some("short") => {
                proof.pop();
            }
            Some("long") => proof.push('a'),
            Some("invalid-char") => {
                proof.pop();
                proof.push('!');
            }
            None => {}
            _ => unreachable!("unknown proof mutation"),
        }
        let clock =
            case["clock"]
                .as_f64()
                .unwrap_or_else(|| match case["clock"].as_str().unwrap() {
                    "NaN" => f64::NAN,
                    "Infinity" => f64::INFINITY,
                    _ => unreachable!("unknown clock"),
                });
        assert_eq!(
            verify_binding(&proof, &case["persisted"]),
            case["binding"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        assert_eq!(
            verify(&proof, &case["persisted"], clock),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
}
#[test]
fn os_entropy_is_fresh_and_float_json_integers_keep_node_semantics() {
    let digest = format!("sha256:{}", "c".repeat(64));
    let mut seen = BTreeSet::new();
    for _ in 0..16 {
        let c = create(&digest, 1000).unwrap();
        assert!(seen.insert(format!("{:x}", Sha256::digest(c.expose_token().as_bytes()))));
        let mut persisted = serde_json::to_value(c.persisted()).unwrap();
        persisted["schemaVersion"] = serde_json::json!(1.0);
        persisted["expiresAt"] = serde_json::json!(1000.0);
        assert!(verify(c.expose_token(), &persisted, 999.));
        assert!(!verify(c.expose_token(), &persisted, 1000.));
    }
}
