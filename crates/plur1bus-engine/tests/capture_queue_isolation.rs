//! RX6: durable work must remain bound to the exact requested agent.
#![allow(clippy::unwrap_used)]

use plur1bus_engine::capture::post_turn::{DrainOptions, PostTurnQueue};
use plur1bus_engine::text::json::parse_json;

fn root() -> tempfile::TempDir {
    tempfile::Builder::new()
        .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
        .unwrap()
}

#[test]
fn a_foreign_payload_is_neither_processed_nor_removed() {
    let root = root();
    let queue = PostTurnQueue::open(root.path()).unwrap();
    let entry = queue
        .enqueue("alpha", parse_json("{}").unwrap(), 1_790_000_000_000)
        .unwrap();
    let file = root.path().join(".post-turn-queue/alpha").join(entry.file);
    let golden: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/capture/golden/post-turn-isolation.json"
    ))
    .unwrap();
    for case in golden["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| !matches!(c["name"].as_str(), Some("link" | "case-alias")))
    {
        assert_eq!(case["called"], 1);
        assert_eq!(case["processed"], 1);
        assert_eq!(case["remaining"], false);
        let payload = case["payload"].as_str().unwrap();
        std::fs::write(&file, payload).unwrap();
        let mut called = false;
        assert!(queue
            .drain(
                "alpha",
                |_| {
                    called = true;
                    Ok(true)
                },
                DrainOptions::default(),
                || 0
            )
            .is_err());
        assert!(!called);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), payload);
    }
}

#[test]
fn an_alias_never_observes_or_consumes_another_agents_queue() {
    let root = root();
    let queue = PostTurnQueue::open(root.path()).unwrap();
    let entry = queue
        .enqueue("Alpha", parse_json("{}").unwrap(), 1_790_000_000_000)
        .unwrap();
    let actual = root.path().join(".post-turn-queue/Alpha").join(entry.file);
    let before = std::fs::read(&actual).unwrap();
    let aliases = root.path().join(".post-turn-queue/alpha").exists();
    assert_eq!(queue.count("alpha"), 0);
    if aliases {
        assert!(queue
            .enqueue("alpha", parse_json("{}").unwrap(), 1_790_000_000_001)
            .is_err());
    }
    let mut called = false;
    let result = queue.drain(
        "alpha",
        |_| {
            called = true;
            Ok(true)
        },
        DrainOptions::default(),
        || 0,
    );
    if aliases {
        assert!(result.is_err());
    } else {
        assert_eq!(result.unwrap().processed, 0);
    }
    assert!(!called);
    assert_eq!(std::fs::read(&actual).unwrap(), before);
    assert_eq!(queue.count("Alpha"), 1);
}

#[cfg(unix)]
#[test]
fn linked_entries_are_not_read_processed_or_removed() {
    let root = root();
    let queue = PostTurnQueue::open(root.path()).unwrap();
    let entry = queue
        .enqueue("alpha", parse_json("{}").unwrap(), 1_790_000_000_000)
        .unwrap();
    let file = root.path().join(".post-turn-queue/alpha").join(entry.file);
    let outside = root.path().join("synthetic-outside.json");
    let payload = r#"{"agentId":"alpha","turns":["synthetic private sentence"]}"#;
    std::fs::write(&outside, payload).unwrap();
    std::fs::remove_file(&file).unwrap();
    std::os::unix::fs::symlink(&outside, &file).unwrap();
    let mut called = false;
    assert!(queue
        .drain(
            "alpha",
            |_| {
                called = true;
                Ok(true)
            },
            DrainOptions::default(),
            || 0
        )
        .is_err());
    assert!(!called);
    assert!(std::fs::symlink_metadata(file)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read_to_string(outside).unwrap(), payload);
}

#[test]
fn oversized_entries_remain_unprocessed_and_intact() {
    let root = root();
    let queue = PostTurnQueue::open(root.path()).unwrap();
    let entry = queue
        .enqueue("alpha", parse_json("{}").unwrap(), 1_790_000_000_000)
        .unwrap();
    let path = root.path().join(".post-turn-queue/alpha").join(entry.file);
    let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    let size = 64 * 1024 * 1024 + 1;
    file.set_len(size).unwrap();
    let mut called = false;
    assert!(queue
        .drain(
            "alpha",
            |_| {
                called = true;
                Ok(true)
            },
            DrainOptions::default(),
            || 0
        )
        .is_err());
    assert!(!called);
    assert_eq!(std::fs::metadata(path).unwrap().len(), size);
}
