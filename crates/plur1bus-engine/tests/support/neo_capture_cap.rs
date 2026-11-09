use super::*;
use std::io::Read;
fn seeded() -> (Fixture, Vec<u8>) {
    let f = setup_config(json!({"neo":{"maxRecords":500}}));
    f.journal
        .record(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    let mut records = rows(&f.directory, "turn-journal.jsonl");
    for i in records.len()..700 {
        let mut row = records[0].clone();
        row["id"] = json!(format!("synthetic-{i}"));
        records.push(row);
    }
    let bytes = records
        .iter()
        .map(|row| format!("{row}\n"))
        .collect::<String>()
        .into_bytes();
    fs::write(f.directory.join("turn-journal.jsonl"), &bytes).unwrap();
    (f, bytes)
}
#[test]
fn archive_does_not_forget_ids_of_trimmed_original_turns() {
    let (f, original) = seeded();
    let result = f
        .journal
        .record(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    assert_eq!(result.turns, 0);
    assert_eq!(rows(&f.directory, "turn-journal.jsonl").len(), 500);
    assert_eq!(
        f.journal
            .record(&f.turn, &f.context, &Cancel::never())
            .unwrap()
            .turns,
        0
    );
    let archive = fs::read_dir(f.directory.join("archives"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
    let gzip = fs::read(archive.path()).unwrap();
    let mut recovered = Vec::new();
    flate2::read::MultiGzDecoder::new(gzip.as_slice())
        .read_to_end(&mut recovered)
        .unwrap();
    recovered.extend(fs::read(f.directory.join("turn-journal.jsonl")).unwrap());
    assert_eq!(recovered, original);
}
#[test]
fn failed_archive_refuses_new_capture_before_appending() {
    let (f, original) = seeded();
    fs::write(f.directory.join("archives"), b"blocked").unwrap();
    let mut next = f.turn.clone();
    next.session_key = Some("different-session".into());
    assert!(f
        .journal
        .record(&next, &f.context, &Cancel::never())
        .is_err());
    assert_eq!(
        fs::read(f.directory.join("turn-journal.jsonl")).unwrap(),
        original
    );
}
#[test]
fn foreign_owner_and_active_receipt_fence_cap_housekeeping() {
    let (f, original) = seeded();
    let mut records = rows(&f.directory, "turn-journal.jsonl");
    records[0]["ownerUserId"] = json!(harness_user_principal("another-owner"));
    let foreign = records
        .iter()
        .map(|row| format!("{row}\n"))
        .collect::<String>();
    fs::write(f.directory.join("turn-journal.jsonl"), &foreign).unwrap();
    assert!(f
        .journal
        .record(&f.turn, &f.context, &Cancel::never())
        .is_err());
    assert_eq!(
        fs::read_to_string(f.directory.join("turn-journal.jsonl")).unwrap(),
        foreign
    );
    assert!(!f.directory.join("archives").exists());
    fs::write(f.directory.join("turn-journal.jsonl"), &original).unwrap();
    fs::write(
        f.directory.join("native-capture-pending-fixture.json"),
        json!({"records":[[{"id":"pending"}],[],[],[],[]]}).to_string(),
    )
    .unwrap();
    assert!(f
        .journal
        .record(&f.turn, &f.context, &Cancel::never())
        .is_err());
    assert_eq!(
        fs::read(f.directory.join("turn-journal.jsonl")).unwrap(),
        original
    );
}

#[test]
fn unindexed_content_fallback_uses_configured_tail_independent_of_live_cap() {
    let mut accepted = Vec::new();
    for tail in [100, 5000] {
        let f = setup_config(json!({"neo":{"maxRecords":40000,"appendDedupeTailRecords":tail}}));
        f.journal
            .record(&f.turn, &f.context, &Cancel::never())
            .unwrap();
        let mut candidates = rows(&f.directory, "memory-candidates.jsonl");
        for index in candidates.len()..600 {
            let mut row = candidates[0].clone();
            row["id"] = json!(format!("synthetic-candidate-{index}"));
            row["normalizedStatement"] = json!(format!("unrelated candidate {index}"));
            candidates.push(row);
        }
        fs::write(
            f.directory.join("memory-candidates.jsonl"),
            candidates
                .iter()
                .map(|row| format!("{row}\n"))
                .collect::<String>(),
        )
        .unwrap();
        fs::remove_file(f.directory.join("native-append-history.json")).unwrap();
        let mut next = f.turn.clone();
        next.session_key = Some("new-session".into());
        accepted.push(
            f.journal
                .record(&next, &f.context, &Cancel::never())
                .unwrap()
                .candidates,
        );
    }
    assert_eq!(accepted, vec![5, 0]);
}
