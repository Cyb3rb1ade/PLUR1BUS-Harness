//! `logs.query` served here (P4-20 flip A): behind the guard, over the home's log files, and masked with what the
//! legacy core's redaction registry holds at the moment of the call.
#![allow(clippy::unwrap_used)]
use super::tests::{admin, audit_lines, home, owner, refused, set_role, Home};
use super::*;
use crate::logs::levels::Source;
use crate::logs::redact::SecretSet;
use crate::logs::writer::{Writer, WriterOptions};
use crate::redaction_mirror::ChangesSource;
use plur1bus_log_schema::Level;
use serde_json::Map;
use std::collections::VecDeque;

/// A feed that answers from a script and counts how often it was asked.
#[derive(Default)]
struct Feed {
    answers: Mutex<VecDeque<Result<Value, String>>>,
    asked: Mutex<Vec<(String, u64, u64)>>,
}

impl Feed {
    fn with(answers: Vec<Result<Value, String>>) -> Arc<Feed> {
        Arc::new(Feed {
            answers: Mutex::new(answers.into()),
            asked: Mutex::default(),
        })
    }

    fn asked(&self) -> usize {
        self.asked.lock().unwrap().len()
    }
}

impl ChangesSource for Feed {
    fn changes(&self, epoch: &str, after: u64, wait_ms: u64, _: u64) -> Result<Value, String> {
        self.asked
            .lock()
            .unwrap()
            .push((epoch.to_owned(), after, wait_ms));
        self.answers
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Err("timeout".to_owned()))
    }
}

fn nothing_new(epoch: &str, next: u64) -> Result<Value, String> {
    Ok(json!({ "epoch": epoch, "next": next, "secrets": [], "more": false }))
}

fn mirror_over(feed: &Arc<Feed>) -> Arc<RedactionMirror> {
    let mirror = Arc::new(RedactionMirror::new(Arc::new(SecretSet::new())));
    mirror.set_source(feed.clone());
    mirror
}

/// A line in `logs/core.log` of the home, written as a process writes it that does not know `message` holds a secret.
fn write_line(home: &Home, message: &str) {
    let writer = Writer::new(WriterOptions::new(
        home.dir.path().join("logs"),
        "core",
        Source::new("harness", "core", Some("0.1.0")),
    ))
    .unwrap();
    writer
        .write_legacy(Level::Info, message, &Map::new())
        .unwrap();
    writer.flush(true).unwrap();
    writer.close().unwrap();
}

fn query(params: Value) -> plur1bus_rpc::types::LogsQueryParams {
    serde_json::from_value(params).unwrap()
}

#[test]
fn a_value_the_legacy_core_learned_after_the_line_was_written_comes_back_masked() {
    let h = home();
    let value = "a value nobody knew when the line was written";
    write_line(
        &h,
        &format!("the provider answered with {value} in its body"),
    );
    let on_disk = std::fs::read_to_string(h.dir.path().join("logs/core.log")).unwrap();
    assert!(on_disk.contains(value), "the writer did not know the value");

    // At the start the registry is empty; the value is set afterwards and is in the journal when the query catches up.
    let feed = Feed::with(vec![
        nothing_new("1", 0),
        Ok(
            json!({ "epoch": "1", "next": 1, "secrets": [{ "secret": value, "pinned": true }], "more": false }),
        ),
        nothing_new("1", 1),
    ]);
    let mirror = mirror_over(&feed);
    mirror.catch_up(Duration::from_secs(5)).unwrap();
    h.native.set_redaction(mirror.clone());
    assert!(h.native.serves_now("logs.query"));

    let page = h.native.logs_query(&owner(), &query(json!({}))).unwrap();
    let text = page.to_string();
    assert_eq!(page["records"].as_array().map(Vec::len), Some(1), "{text}");
    assert!(
        !text.contains(value),
        "the value left the front door: {text}"
    );
    assert!(
        text.contains("the provider answered with [REDACTED:secret] in its body"),
        "{text}"
    );
    assert_eq!(
        feed.asked(),
        2,
        "one call at the start, one before the query"
    );
    // The same query again: caught up once more (nothing new), the same answer.
    let again = h.native.logs_query(&owner(), &query(json!({}))).unwrap();
    assert_eq!(again["records"], page["records"]);
    assert_eq!(feed.asked(), 3);
    assert_eq!(
        feed.asked.lock().unwrap()[2],
        ("1".to_owned(), 1, 0),
        "a catch-up never waits"
    );
}

#[test]
fn without_a_mirror_in_step_the_query_is_not_answered_here() {
    let h = home();
    write_line(&h, "an ordinary line");
    let out_of_step = (
        "E_NOT_AVAILABLE".to_owned(),
        Some("redaction-sync".to_owned()),
        "log redaction is not in step with the legacy core".to_owned(),
    );
    // No mirror at all (a front door whose start did not get that far): relayed, and refused if it is called all the same.
    assert!(!h.native.serves_now("logs.query"));
    assert!(
        h.native.serves_now("identity.principals"),
        "only logs.query depends on the mirror"
    );
    assert_eq!(
        refused(h.native.logs_query(&owner(), &query(json!({})))),
        out_of_step
    );

    // A mirror that was in step, then the legacy core stops answering: the query that finds out is refused, and from
    // then on the method is relayed.
    let feed = Feed::with(vec![nothing_new("1", 0)]);
    let mirror = mirror_over(&feed);
    mirror.catch_up(Duration::from_secs(5)).unwrap();
    let h = home();
    h.native.set_redaction(mirror);
    assert!(h.native.serves_now("logs.query"));
    assert_eq!(
        refused(h.native.logs_query(&owner(), &query(json!({})))),
        out_of_step
    );
    assert!(!h.native.serves_now("logs.query"));
}

#[test]
fn the_guard_comes_first_and_refusals_are_the_log_methods_own() {
    let h = home();
    write_line(&h, "an ordinary line");
    let feed = Feed::with(vec![
        nothing_new("1", 0),
        nothing_new("1", 0),
        nothing_new("1", 0),
    ]);
    let mirror = mirror_over(&feed);
    mirror.catch_up(Duration::from_secs(5)).unwrap();
    h.native.set_redaction(mirror);

    // What the log methods refuse is refused with their code and reason.
    let empty_range = h.native.logs_query(
        &owner(),
        &query(json!({ "from": "2026-01-02T00:00:00Z", "to": "2026-01-01T00:00:00Z" })),
    );
    let (code, reason, _) = refused(empty_range);
    assert_eq!(
        (code.as_str(), reason.as_deref()),
        ("E_INVALID_PARAMS", Some("empty-range"))
    );
    let asked = feed.asked();

    // A local owner who is no longer Owner or Admin: denied before the legacy core is asked for anything, and audited.
    let mut store = admin(&h);
    set_role(&mut store, "second", "owner");
    set_role(&mut store, "local-owner", "member");
    drop(store);
    let (code, _, _) = refused(h.native.logs_query(&owner(), &query(json!({}))));
    assert_eq!(code, "E_DENIED");
    assert_eq!(
        feed.asked(),
        asked,
        "a denied caller costs the legacy core nothing"
    );
    let denied = audit_lines(&h);
    assert!(
        denied
            .iter()
            .any(|line| line.to_string().contains("logs.query")),
        "the denial is in the audit log: {denied:?}"
    );
}
