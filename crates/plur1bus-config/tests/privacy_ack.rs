use plur1bus_config::{defaults, parse, validate};
use serde_json::json;
#[test]
fn cloud_caption_requires_own_ack_and_provider_changes_invalidate_it() {
    let mut cfg = defaults();
    cfg["memory"]["mediaEmbedding"]["caption"]["provider"] = json!("openai");
    assert!(validate(&cfg).is_err());
    let ack = json!({"provider":"openai","acknowledgedAt":"2026-10-14T10:00:00Z","by":"alice"});
    cfg["memory"]["mediaEmbedding"]["privacyAck"] = ack.clone();
    assert!(validate(&cfg).is_err());
    cfg["memory"]["mediaEmbedding"]["caption"]["privacyAck"] = ack;
    assert!(validate(&cfg).is_ok());
    cfg["memory"]["mediaEmbedding"]["caption"]["provider"] = json!("other");
    assert!(parse(&serde_json::to_string(&cfg).unwrap()).is_err());
}
#[test]
fn local_defaults_need_no_ack_and_text_metadata_is_optional() {
    let mut cfg = defaults();
    assert!(validate(&cfg).is_ok());
    cfg["memory"]["embedding"] = json!({"privacyAck":{"provider":"cloud","acknowledgedAt":"2026-10-14T10:00:00Z","by":"alice"}});
    assert!(validate(&cfg).is_ok());
    cfg["memory"]["embedding"]["privacyAck"]["acknowledgedAt"] = json!("invalid");
    assert!(validate(&cfg).is_err());
}
