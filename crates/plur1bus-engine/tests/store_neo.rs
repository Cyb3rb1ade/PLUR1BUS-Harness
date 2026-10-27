//! Node JSON/JSONL persistence remains lossless across Rust reads and writes.
#![cfg_attr(test, allow(clippy::unwrap_used))]

use plur1bus_engine::store::ledger::JsonlLedger;
use plur1bus_engine::store::state_file::StateFile;
use plur1bus_engine::text::json::{parse_json, write_json, TolerantJsonValue};
use serde::{Deserialize, Serialize};
use std::fs;

// macOS exposes the system temp root through /var -> /private; exercise trusted paths
// from its physical directory while the TempDir guard still owns cleanup.
struct TempDirectory {
    _owner: tempfile::TempDir,
    physical: std::path::PathBuf,
}

impl TempDirectory {
    fn new() -> Self {
        let owner = tempfile::tempdir().unwrap();
        let physical = owner.path().canonicalize().unwrap();
        Self {
            _owner: owner,
            physical,
        }
    }
    fn path(&self) -> &std::path::Path {
        &self.physical
    }
}

#[test]
fn a_node_jsonl_line_with_a_lone_surrogate_escape_reads_and_writes_back_byte_identically() {
    let directory = TempDirectory::new();
    let path = directory.path().join("turn-journal.jsonl");
    let recorded = include_str!("fixtures/text/json-lines.jsonl");
    fs::write(&path, recorded).unwrap();
    let ledger = JsonlLedger::<TolerantJsonValue>::open(&path).unwrap();
    let values = ledger.iter().collect::<Result<Vec<_>, _>>().unwrap();
    let output = values.iter().map(write_json).collect::<Vec<_>>().join("\n") + "\n";
    assert_eq!(output, recorded);
    let copied = directory.path().join("copied.jsonl");
    let ledger = JsonlLedger::<TolerantJsonValue>::open(&copied).unwrap();
    for value in &values {
        ledger.append(value).unwrap();
    }
    assert_eq!(fs::read(&copied).unwrap(), recorded.as_bytes());
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Counter {
    count: u64,
}

#[test]
fn ordinary_serde_records_work_in_ledgers_and_state_files() {
    let directory = TempDirectory::new();
    let path = directory.path().join("run-state.json");
    assert_eq!(StateFile::<Counter>::load(&path).unwrap(), None);
    StateFile::store(&path, &Counter { count: 3 }).unwrap();
    assert_eq!(
        StateFile::<Counter>::load(&path).unwrap(),
        Some(Counter { count: 3 })
    );
    let ledger = JsonlLedger::<Counter>::open(&directory.path().join("counter.jsonl")).unwrap();
    ledger.append(&Counter { count: 1 }).unwrap();
    ledger.append(&Counter { count: 2 }).unwrap();
    assert_eq!(
        ledger.iter().collect::<Result<Vec<_>, _>>().unwrap(),
        [Counter { count: 1 }, Counter { count: 2 }]
    );
}

#[test]
fn a_state_file_preserves_lone_surrogates_and_reports_corrupt_state() {
    let directory = TempDirectory::new();
    let path = directory.path().join("hook-state.json");
    let value = parse_json(r#"{"statement":"cut\ud83d","done":true}"#).unwrap();
    StateFile::store(&path, &value).unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        r#"{"statement":"cut\ud83d","done":true}"#.to_owned() + "\n"
    );
    assert_eq!(
        StateFile::<TolerantJsonValue>::load(&path).unwrap(),
        Some(value)
    );
    fs::write(&path, "{").unwrap();
    assert!(StateFile::<TolerantJsonValue>::load(&path).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"{");
}

#[test]
fn append_turn_adds_one_line_and_keeps_the_file_valid_jsonl() {
    let directory = TempDirectory::new();
    let path = directory.path().join("turn-journal.jsonl");
    let recorded = include_str!("fixtures/text/json-lines.jsonl");
    fs::write(&path, recorded).unwrap();
    let ledger = JsonlLedger::<TolerantJsonValue>::open(&path).unwrap();
    let before = ledger.iter().count();
    ledger
        .append(&parse_json(r#"{"id":"rust-turn","content":"hello"}"#).unwrap())
        .unwrap();
    assert_eq!(
        ledger.iter().collect::<Result<Vec<_>, _>>().unwrap().len(),
        before + 1
    );
    assert!(fs::read_to_string(&path).unwrap().starts_with(recorded));
}

#[test]
fn malformed_ledger_lines_are_reported_individually() {
    let directory = TempDirectory::new();
    let path = directory.path().join("ledger.jsonl");
    fs::write(&path, "\n{\"count\":1}\r\n{broken}\n{\"count\":2}\n").unwrap();
    let ledger = JsonlLedger::<Counter>::open(&path).unwrap();
    let mut lines = ledger.iter();
    assert_eq!(lines.next().unwrap().unwrap(), Counter { count: 1 });
    assert!(lines.next().unwrap().is_err());
    assert_eq!(lines.next().unwrap().unwrap(), Counter { count: 2 });
    assert!(lines.next().is_none());
}

macro_rules! ledger_fixture_test {
    ($test:ident, $record:ident, $file:literal) => {
        #[test]
        fn $test() {
            use plur1bus_engine::store::ledger_types::$record;
            use plur1bus_engine::store::state_file::JsonRecord;
            for line in include_str!(concat!("fixtures/neo-v1/", $file)).lines() {
                let record = $record::from_json(parse_json(line).unwrap()).unwrap();
                assert_eq!(write_json(&record.to_json().unwrap()), line);
            }
        }
    };
}

ledger_fixture_test!(
    turn_record_roundtrips,
    TurnJournalLine,
    "turn-journal.jsonl"
);
ledger_fixture_test!(
    memory_candidate_roundtrips,
    MemoryCandidateLine,
    "memory-candidates.jsonl"
);
ledger_fixture_test!(
    candidate_index_roundtrips,
    CandidateIndexLine,
    "candidate-index.jsonl"
);
ledger_fixture_test!(
    reaction_record_roundtrips,
    ReactionLedgerLine,
    "reaction-ledger.jsonl"
);
ledger_fixture_test!(
    behavior_card_roundtrips,
    BehaviorCardLine,
    "behavior-cards.jsonl"
);
ledger_fixture_test!(
    retrieval_record_roundtrips,
    RetrievalLedgerLine,
    "retrieval-ledger.jsonl"
);
ledger_fixture_test!(
    reconsolidation_record_roundtrips,
    ReconsolidationEventLine,
    "reconsolidation-events.jsonl"
);
ledger_fixture_test!(
    conflict_record_roundtrips,
    ConflictLogLine,
    "conflict-log.jsonl"
);
ledger_fixture_test!(
    resolved_conflict_roundtrips,
    ConflictResolvedLine,
    "conflict-resolved.jsonl"
);
ledger_fixture_test!(
    destructive_operation_roundtrips,
    DestructiveOpLine,
    "destructive-ops.jsonl"
);
ledger_fixture_test!(
    reply_outcome_roundtrips,
    ReplyOutcomeLine,
    "reply-outcomes.jsonl"
);

#[test]
fn the_real_node_normalized_statement_keeps_its_lone_surrogate() {
    use plur1bus_engine::store::ledger_types::MemoryCandidateLine;
    use plur1bus_engine::store::state_file::JsonRecord;
    let lines = include_str!("fixtures/neo-v1/memory-candidates.jsonl");
    let line = lines.lines().find(|line| line.contains("\\ud83d")).unwrap();
    let record = MemoryCandidateLine::from_json(parse_json(line).unwrap()).unwrap();
    let statement = record.string("normalizedStatement").unwrap();
    assert_eq!(statement.utf16_len(), 4000);
    assert_eq!(statement.as_utf16_units().last(), Some(&0xd83d));
    assert_eq!(write_json(&record.to_json().unwrap()), line);
}

#[test]
fn rust_and_node_append_turns_in_both_directions() {
    use plur1bus_engine::store::ledger_types::TurnJournalLine;
    use plur1bus_engine::store::state_file::JsonRecord;
    use plur1bus_engine::text::js::JsString;
    use std::path::Path;
    use std::process::Command;

    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let directory = TempDirectory::new();
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/neo-v1");
    for entry in fs::read_dir(&source).unwrap() {
        let entry = entry.unwrap();
        fs::copy(entry.path(), directory.path().join(entry.file_name())).unwrap();
    }
    let ledger =
        JsonlLedger::<TurnJournalLine>::open(&directory.path().join("turn-journal.jsonl")).unwrap();
    let mut turn = ledger.iter().next().unwrap().unwrap();
    turn.set_field(
        "id",
        TolerantJsonValue::String(JsString::from("rust-roundtrip-turn")),
    );
    turn.set_field(
        "content",
        TolerantJsonValue::String(JsString::from("Rust appended this turn.")),
    );
    plur1bus_engine::store::neo_files::NeoFiles::open(directory.path())
        .unwrap()
        .append_turn(&turn)
        .unwrap();
    assert!(turn.to_json().is_ok());
    let state = directory.path().join("run-state.json");
    let node_state = StateFile::<TolerantJsonValue>::load(&state).unwrap();
    assert!(node_state.is_some());
    StateFile::store(&state, &serde_json::json!({ "fromRust": true })).unwrap();
    let output = Command::new("node")
        .arg(root.join("crates/plur1bus-engine/tests/node/neo-check.mjs"))
        .arg(directory.path())
        .arg("--append")
        .current_dir(root.join("packages/core"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["turnCount"], 6);
    assert_eq!(report["runState"]["fromRust"], true);
    assert_eq!(report["runState"]["fromNode"], true);
    let restored = StateFile::<serde_json::Value>::load(&state)
        .unwrap()
        .unwrap();
    assert_eq!(restored["fromRust"], true);
    assert_eq!(restored["fromNode"], true);
    assert!(report["turnIds"]
        .as_array()
        .unwrap()
        .iter()
        .any(|id| id == "rust-roundtrip-turn"));
    let turns = ledger.iter().collect::<Result<Vec<_>, _>>().unwrap();
    assert_eq!(turns.len(), 6);
    assert!(turns
        .iter()
        .any(|turn| turn.string("id") == Some(&JsString::from("node-roundtrip-turn"))));
}

fn copied_neo_fixture() -> TempDirectory {
    let directory = TempDirectory::new();
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/neo-v1");
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        fs::copy(entry.path(), directory.path().join(entry.file_name())).unwrap();
    }
    directory
}

#[test]
fn vectors_read_back_equal_the_json_sidecar() {
    use plur1bus_engine::store::neo_files::NeoFiles;
    let directory = copied_neo_fixture();
    let store = NeoFiles::open(directory.path()).unwrap();
    let generation = store.generation().unwrap();
    assert_eq!(generation.number().unwrap(), 0);
    assert_eq!(generation.entries.len(), 3);
    let vectors = store.read_vectors(&generation).unwrap();
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/neo-v1/expected.json")).unwrap();
    for ((id, vector), recorded) in vectors.iter().zip(expected["vectors"].as_array().unwrap()) {
        assert_eq!(id, recorded["id"].as_str().unwrap());
        assert_eq!(
            *vector,
            serde_json::from_value::<Vec<f32>>(recorded["vector"].clone()).unwrap()
        );
    }
}

#[test]
fn a_generation_written_by_rust_is_read_by_node() {
    use plur1bus_engine::store::neo_files::{Generation, NeoFiles};
    let directory = copied_neo_fixture();
    let store = NeoFiles::open(directory.path()).unwrap();
    let previous = store.generation().unwrap();
    let previous_vectors = store.read_vectors(&previous).unwrap();
    let vectors = vec![
        ("rust-vector-b".to_owned(), vec![0.5, -0.25, 0.0]),
        ("rust-vector-a".to_owned(), vec![1.0, 0.0, -1.0]),
    ];
    store
        .write_generation(&Generation::new(1), &vectors)
        .unwrap();
    assert_eq!(
        store.read_vectors(&previous).unwrap(),
        previous_vectors,
        "old index snapshots must remain readable"
    );
    assert_eq!(
        store.read_vectors(&store.generation().unwrap()).unwrap(),
        vectors
    );
    assert!(!directory.path().join("generation.json").exists());
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = std::process::Command::new("node")
        .arg(root.join("crates/plur1bus-engine/tests/node/neo-check.mjs"))
        .arg(directory.path())
        .current_dir(root.join("packages/core"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["generation"]["generation"], 1);
    assert_eq!(report["generation"]["bytes"], 24);
    for ((id, vector), recorded) in vectors.iter().zip(report["vectors"].as_array().unwrap()) {
        assert_eq!(id, recorded["id"].as_str().unwrap());
        assert_eq!(
            *vector,
            serde_json::from_value::<Vec<f32>>(recorded["vector"].clone()).unwrap()
        );
    }
}

#[test]
fn a_reused_generation_cannot_invalidate_a_published_index() {
    use plur1bus_engine::store::neo_files::NeoFiles;
    let directory = copied_neo_fixture();
    let store = NeoFiles::open(directory.path()).unwrap();
    let generation = store.generation().unwrap();
    let before = fs::read(directory.path().join("vector-index.json")).unwrap();
    assert!(store
        .write_generation(
            &generation,
            &[("replacement".to_owned(), vec![1.0, 1.0, 1.0])]
        )
        .is_err());
    assert_eq!(
        fs::read(directory.path().join("vector-index.json")).unwrap(),
        before
    );
    assert_eq!(store.read_vectors(&generation).unwrap().len(), 3);
}

#[test]
fn an_empty_workspace_has_generation_zero_and_truncated_vectors_are_errors() {
    use plur1bus_engine::store::neo_files::NeoFiles;
    let empty = TempDirectory::new();
    let store = NeoFiles::open(empty.path()).unwrap();
    let generation = store.generation().unwrap();
    assert_eq!(generation.number().unwrap(), 0);
    assert!(store.read_vectors(&generation).unwrap().is_empty());
    let directory = copied_neo_fixture();
    let store = NeoFiles::open(directory.path()).unwrap();
    let generation = store.generation().unwrap();
    fs::write(directory.path().join(&generation.file), [0u8; 3]).unwrap();
    assert!(store.read_vectors(&generation).is_err());
}

#[test]
fn append_separates_a_valid_final_record_without_a_trailing_lf() {
    let directory = TempDirectory::new();
    let path = directory.path().join("ledger.jsonl");
    fs::write(&path, br#"{"count":1}"#).unwrap();
    let ledger = JsonlLedger::<Counter>::open(&path).unwrap();
    ledger.append(&Counter { count: 2 }).unwrap();
    assert_eq!(
        ledger.iter().collect::<Result<Vec<_>, _>>().unwrap(),
        [Counter { count: 1 }, Counter { count: 2 }]
    );
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "{\"count\":1}\n{\"count\":2}\n"
    );
}
