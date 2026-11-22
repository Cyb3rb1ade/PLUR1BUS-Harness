use super::*;
use crate::federation::loan::{Event, Side};
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../fixtures/parity/federation/memory.json"
    ))
    .unwrap()
}
fn result<T: Serialize>(value: Result<T, Error>) -> Value {
    value.map_or_else(|error| json!({"error":error.0}), |result| json!(result))
}

#[test]
fn partition_receipts_conflicts_and_retention_match_typescript() {
    let f = fixture();
    let offer: Offer = serde_json::from_value(f["offer"].clone()).unwrap();
    let state = State::new(offer.clone(), Side::Borrower, 1000)
        .unwrap()
        .transition(
            Event::Accept {
                borrower_project_id: Some("local-project".into()),
            },
            1000,
        )
        .unwrap();
    for row in f["selected"].as_array().unwrap() {
        let refs: Vec<Reference> = serde_json::from_value(row["input"].clone()).unwrap();
        assert_eq!(result(selected_home(&refs)), row["result"]);
    }
    for row in f["generation"].as_array().unwrap() {
        let refs: Vec<Reference> = serde_json::from_value(row["input"].clone()).unwrap();
        assert_eq!(result(make_batches(&state, &refs)), row["result"]);
    }
    for row in f["inbound"].as_array().unwrap() {
        let before: Vec<Batch> = serde_json::from_value(row["received"].clone()).unwrap();
        let batch: Batch = serde_json::from_value(row["batch"].clone()).unwrap();
        assert_eq!(
            result(receive(&before, &offer, &batch)),
            row["result"],
            "{}",
            row["name"]
        );
    }
    let batches: Vec<Batch> = f["outbox"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| serde_json::from_value(row["batch"].clone()).unwrap())
        .collect();
    let outbox = outbox(&batches).unwrap();
    assert_eq!(json!(outbox), f["outbox"]);
    for row in f["acks"].as_array().unwrap() {
        let ack = serde_json::from_value(row["ack"].clone()).unwrap();
        let actual = acknowledge(&outbox, &ack);
        if let Ok(entries) = &actual {
            assert_eq!(entries, &acknowledge(entries, &ack).unwrap());
        }
        assert_eq!(result(actual), row["result"]);
    }
    for row in f["use"].as_array().unwrap() {
        let level = serde_json::from_value(row["level"].clone()).unwrap();
        assert_eq!(json!(foreign_use(level)), row["result"]);
    }
    for row in f["disposition"].as_array().unwrap() {
        let offer = Offer {
            keep_mission_copies: row["keepMissionCopies"].as_bool().unwrap(),
            ..offer.clone()
        };
        assert_eq!(
            json!(disposition(
                &offer,
                row["acknowledged"].as_bool().unwrap(),
                row["ended"].as_bool().unwrap()
            )),
            row["result"]
        );
    }
}

#[test]
fn raw_metadata_limit_closed_shape_and_untrusted_receipts() {
    let f = fixture();
    let first: Batch = serde_json::from_value(f["inbound"][0]["batch"].clone()).unwrap();
    let offer: Offer = serde_json::from_value(f["offer"].clone()).unwrap();
    let mut huge = first.clone();
    huge.items = (0..2_049)
        .map(|i| Item {
            id: format!("ref{i:04}"),
            content_hash: "a".repeat(64),
        })
        .collect();
    assert_eq!(
        outbox(&[huge]).unwrap_err().0,
        "loan-memory-model: invalid batch items"
    );
    assert!(receive(&vec![first.clone(); 257], &offer, &first).is_err());
    assert!(serde_json::from_value::<Reference>(json!({
        "id":"fixture","personKey":"u","level":"private","contentHash":"a".repeat(64),"text":"fixture content"
    })).is_err());
    assert!(serde_json::from_value::<Ack>(
        json!({"loanId":"fixture","batchId":"a".repeat(64),"extra":"fixture"})
    )
    .is_err());
}
