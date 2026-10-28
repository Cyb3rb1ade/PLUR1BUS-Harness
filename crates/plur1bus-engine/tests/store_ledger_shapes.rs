//! Known Node ledger fields are typed without narrowing the persisted object shape.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use plur1bus_engine::contract::StoreError;
use plur1bus_engine::store::ledger_types::*;
use plur1bus_engine::store::state_file::JsonRecord;
use plur1bus_engine::text::js::JsString;
use plur1bus_engine::text::json::{parse_json, write_json, TolerantJsonValue};

macro_rules! fixture_shape {
    ($test:ident, $record:ty, $file:literal, $check:expr) => {
        #[test]
        fn $test() {
            for line in include_str!(concat!("fixtures/neo-v1/", $file)).lines() {
                let record = <$record>::from_json(parse_json(line).unwrap()).unwrap();
                $check(&record);
                assert_eq!(write_json(&record.to_json().unwrap()), line);
            }
        }
    };
}
fixture_shape!(
    turn_fields_are_typed,
    TurnJournalLine,
    "turn-journal.jsonl",
    |record: &TurnJournalLine| {
        assert!(record.id.is_some());
        assert!(record.content.is_some());
        assert!(record.turn_index.as_ref().unwrap().as_u64().is_some());
        assert_eq!(record.visibility.as_ref().unwrap().recallable, Some(true));
        assert_eq!(record.quality.as_ref().unwrap().user_confirmed, Some(false));
        assert_eq!(
            record
                .origin
                .as_ref()
                .unwrap()
                .source_turn_ids
                .as_ref()
                .unwrap()
                .len(),
            1
        );
        assert!(record
            .attribution
            .as_ref()
            .unwrap()
            .used_memory_ids
            .as_ref()
            .unwrap()
            .is_empty());
    }
);
fixture_shape!(
    candidate_fields_are_typed,
    MemoryCandidateLine,
    "memory-candidates.jsonl",
    |record: &MemoryCandidateLine| {
        assert!(record.statement.is_some());
        assert!(record.normalized_statement.is_some());
        assert!(record.agent_id.is_none());
        assert_eq!(record.confidence.as_ref().unwrap().as_f64(), Some(0.75));
        assert_eq!(record.source_turn_ids.as_ref().unwrap().len(), 1);
    }
);
fixture_shape!(
    index_fields_are_typed,
    CandidateIndexLine,
    "candidate-index.jsonl",
    |record: &CandidateIndexLine| {
        assert!(record.id.is_some());
        assert!(record.statement.is_some());
        assert!(record.created_at.is_some());
        assert!(record.origin.as_ref().unwrap().trust_level.is_some());
        assert!(record.origin.as_ref().unwrap().source_turn_ids.is_none());
    }
);
fixture_shape!(
    reaction_fields_are_typed,
    ReactionLedgerLine,
    "reaction-ledger.jsonl",
    |record: &ReactionLedgerLine| {
        assert!(record.turn_id.is_some());
        assert!(record.evidence.is_some());
        assert_eq!(record.polarity.as_ref().unwrap().as_i64(), Some(1));
        assert!(record.target_ids.as_ref().unwrap().is_empty());
    }
);
fixture_shape!(
    behavior_fields_are_typed,
    BehaviorCardLine,
    "behavior-cards.jsonl",
    |record: &BehaviorCardLine| {
        assert!(record.statement.is_some());
        assert!(record.last_confirmed_at.is_some());
        assert!(record.last_contradicted_at.is_none());
        assert_eq!(record.source_signals.as_ref().unwrap().len(), 1);
    }
);
fixture_shape!(
    retrieval_fields_are_typed,
    RetrievalLedgerLine,
    "retrieval-ledger.jsonl",
    |record: &RetrievalLedgerLine| {
        assert!(record.agent_id.is_some());
        assert!(record.query.is_some());
        assert_eq!(record.results_count.as_ref().unwrap().as_u64(), Some(1));
        assert_eq!(record.selected_ids.as_ref().unwrap().len(), 1);
    }
);
fixture_shape!(
    reconsolidation_fields_are_typed,
    ReconsolidationEventLine,
    "reconsolidation-events.jsonl",
    |record: &ReconsolidationEventLine| {
        assert!(record.idempotency_key.is_some());
        assert!(record.old_memory_id.is_some());
        assert!(record.new_memory_id.is_some());
        assert_eq!(
            record.created_at.as_ref().unwrap().as_u64(),
            Some(1_800_000_000_000)
        );
    }
);
fixture_shape!(
    conflict_fields_are_typed,
    ConflictLogLine,
    "conflict-log.jsonl",
    |record: &ConflictLogLine| {
        assert!(record.timestamp.is_some());
        assert!(record.new_memory_id.as_ref().unwrap().is_some());
        assert_eq!(record.pending, Some(true));
    }
);
fixture_shape!(
    resolved_fields_are_typed,
    ConflictResolvedLine,
    "conflict-resolved.jsonl",
    |record: &ConflictResolvedLine| {
        assert!(record
            .original
            .as_ref()
            .unwrap()
            .existing_memory_id
            .is_some());
        assert!(record.resolution.is_some());
        assert_eq!(record.dry_run, Some(false));
    }
);
fixture_shape!(
    destructive_fields_are_typed,
    DestructiveOpLine,
    "destructive-ops.jsonl",
    |record: &DestructiveOpLine| {
        assert!(record.operation.is_some());
        assert!(record.agent_id.as_ref().unwrap().is_some());
        assert!(matches!(record.timestamp, Some(TimestampValue::Number(_))));
    }
);
fixture_shape!(
    reply_fields_are_typed,
    ReplyOutcomeLine,
    "reply-outcomes.jsonl",
    |record: &ReplyOutcomeLine| {
        assert!(record.user_prompt.is_some());
        assert!(record.reply_text.is_some());
        assert_eq!(record.schema.as_ref().unwrap().as_u64(), Some(1));
        assert_eq!(record.memory_ids.as_ref().unwrap().len(), 1);
    }
);

#[test]
fn every_record_keeps_missing_wrong_shaped_and_unknown_fields_without_extra_requirements() {
    fn check<T: JsonRecord + Default>() {
        assert_eq!(write_json(&T::default().to_json().unwrap()), "{}");
        for text in [
            "{}",
            r#"{"id":42,"confidence":"low","sourceTurnIds":[1,"x"],"origin":[],"future":{"x":"\ud800"}}"#,
        ] {
            let record = T::from_json(parse_json(text).unwrap()).unwrap();
            assert_eq!(write_json(&record.to_json().unwrap()), text);
        }
        assert!(matches!(
            T::from_json(TolerantJsonValue::Null),
            Err(StoreError::Corrupt)
        ));
    }
    check::<TurnJournalLine>();
    check::<MemoryCandidateLine>();
    check::<CandidateIndexLine>();
    check::<ReactionLedgerLine>();
    check::<BehaviorCardLine>();
    check::<RetrievalLedgerLine>();
    check::<ReconsolidationEventLine>();
    check::<ConflictLogLine>();
    check::<ConflictResolvedLine>();
    check::<DestructiveOpLine>();
    check::<ReplyOutcomeLine>();
}

#[test]
fn nullable_node_fields_remain_distinct_from_absence() {
    let missing = ConflictLogLine::from_json(parse_json("{}").unwrap()).unwrap();
    assert!(missing.new_memory_id.is_none());
    let explicit_null =
        ConflictLogLine::from_json(parse_json(r#"{"newMemoryId":null}"#).unwrap()).unwrap();
    assert_eq!(explicit_null.new_memory_id, Some(None));
    assert_eq!(
        write_json(&explicit_null.to_json().unwrap()),
        r#"{"newMemoryId":null}"#
    );
    let outcome =
        ReplyOutcomeLine::from_json(parse_json(r#"{"workspaceKey":null}"#).unwrap()).unwrap();
    assert_eq!(outcome.workspace_key, Some(None));
}

#[test]
fn numeric_lexemes_and_the_real_lone_surrogate_are_preserved() {
    let text = r#"{"confidence":1e+02,"recency":1.00,"salience":-0,"future":true}"#;
    let record = MemoryCandidateLine::from_json(parse_json(text).unwrap()).unwrap();
    assert_eq!(record.confidence.as_ref().unwrap().as_f64(), Some(100.0));
    assert_eq!(record.recency.as_ref().unwrap().as_str(), "1.00");
    assert_eq!(write_json(&record.to_json().unwrap()), text);
    for line in include_str!("fixtures/neo-v1/memory-candidates.jsonl")
        .lines()
        .filter(|line| line.contains("\\ud83d"))
    {
        let record = MemoryCandidateLine::from_json(parse_json(line).unwrap()).unwrap();
        assert_eq!(
            record
                .normalized_statement
                .as_ref()
                .unwrap()
                .as_utf16_units()
                .last(),
            Some(&0xd83d)
        );
        assert_eq!(write_json(&record.to_json().unwrap()), line);
    }
    assert_eq!(LedgerNumber::new("1e+02").unwrap().as_f64(), Some(100.0));
    assert!(LedgerNumber::new("01").is_err());
    assert!(LedgerNumber::new("NaN").is_err());
}

#[test]
fn typed_updates_preserve_unknown_fields_order_and_legacy_mutator_behavior() {
    let text = r#"{"id":"old","future":"\ud83d","origin":{"kind":"user_explicit","confidence":0.75,"next":1e2},"status":"active"}"#;
    let mut record = MemoryCandidateLine::from_json(parse_json(text).unwrap()).unwrap();
    record.id = Some(JsString::from("typed"));
    record.origin.as_mut().unwrap().confidence = Some(LedgerNumber::new("0.2").unwrap());
    record.set_field(
        "status",
        TolerantJsonValue::String(JsString::from("candidate")),
    );
    assert_eq!(record.id.as_ref(), Some(&JsString::from("typed")));
    assert_eq!(record.string("status"), Some(&JsString::from("candidate")));
    assert_eq!(
        write_json(&record.to_json().unwrap()),
        r#"{"id":"typed","future":"\ud83d","origin":{"kind":"user_explicit","confidence":0.2,"next":1e2},"status":"candidate"}"#
    );
    record.status = None;
    assert!(!write_json(&record.to_json().unwrap()).contains("\"status\""));
}
