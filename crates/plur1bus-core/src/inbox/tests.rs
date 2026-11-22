//! Ports of `packages/core/test/inbox/{store,producers,audit-c04}.test.ts`, and of the rules their authors left to the reader:
//! the cursor as Node decodes it, the token words of `looksLikeToken`, the clip of a param, the best-effort service over a store
//! that fails.
use super::producers::{job_failed_to_inbox, looks_like_token, param, JobRun};
use super::service::{InboxNotice, InboxPort, InboxTarget, SettleTarget};
use super::store::decode_cursor;
use super::testing::{open, SeqIds, TestClock};
use super::{
    Ids, InboxDraft, InboxError, InboxListQuery, InboxRef, InboxService, InboxServiceOptions,
    InboxStore, INBOX_KINDS,
};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

struct T {
    s: InboxStore,
    clock: Arc<TestClock>,
    path: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

fn t_with(max_age: Option<f64>, max_entries: Option<f64>) -> T {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state").join("inbox.sqlite");
    let clock = Arc::new(TestClock(AtomicI64::new(1_000_000)));
    let s = open(
        path.clone(),
        clock.clone(),
        Arc::new(SeqIds::default()),
        max_age,
        max_entries,
    )
    .unwrap();
    T {
        s,
        clock,
        path,
        _dir: dir,
    }
}

fn t() -> T {
    t_with(None, None)
}

fn d(user: &str, key: &str) -> InboxDraft {
    InboxDraft {
        user_id: user.into(),
        kind: "system".into(),
        severity: "info".into(),
        title_key: "inbox.test".into(),
        params: None,
        reference: None,
        dedupe_key: key.into(),
    }
}

fn q() -> InboxListQuery {
    InboxListQuery::default()
}

fn ids(s: &InboxStore, user: &str, include_dismissed: bool) -> Vec<String> {
    s.list(
        user,
        &InboxListQuery {
            include_dismissed,
            limit: Some(200.0),
            ..q()
        },
    )
    .unwrap()
    .entries
    .into_iter()
    .map(|e| e.id)
    .collect()
}

#[test]
fn the_kind_set_is_closed_and_has_the_eight_documented_kinds() {
    assert_eq!(INBOX_KINDS.len(), 8);
    let mut x = t();
    let mut bad = d("u", "k");
    bad.kind = "other".into();
    assert_eq!(
        x.s.publish(&bad).unwrap_err().to_string(),
        "unknown inbox kind"
    );
}

#[test]
fn publish_stores_metadata_only_and_the_same_dedupe_key_twice_is_one_entry() {
    let mut x = t();
    let mut draft = d("u", "approval:1");
    draft.kind = "approval".into();
    draft.params = Some(vec![
        ("capability".into(), json!("fs.read")),
        ("n".into(), json!(3)),
    ]);
    draft.reference = Some(InboxRef {
        route: Some("/approvals".into()),
        object_id: Some("a1".into()),
    });
    let a = x.s.publish(&draft).unwrap();
    assert!(a.created);
    let b = x.s.publish(&draft).unwrap();
    assert_eq!((b.id.as_str(), b.created), (a.id.as_str(), false));
    let page = x.s.list("u", &q()).unwrap();
    assert_eq!(page.entries.len(), 1);
    assert_eq!(
        page.entries[0].params,
        json!({"capability": "fs.read", "n": 3})
    );
    assert_eq!(
        page.entries[0].reference,
        Some(json!({"route": "/approvals", "objectId": "a1"}))
    );
    // Nothing but the metadata columns exists in the file.
    let db = plur1bus_store::rusqlite::Connection::open(&x.path).unwrap();
    let cols: Vec<String> = db
        .prepare("SELECT name FROM pragma_table_info('inbox_entries')")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        cols,
        [
            "seq",
            "id",
            "user_id",
            "dedupe_key",
            "kind",
            "severity",
            "title_key",
            "params",
            "ref",
            "created_at",
            "read_at",
            "dismissed_at"
        ]
    );
}

#[test]
fn a_republished_entry_does_not_resurrect_a_read_or_dismissed_one_and_people_are_separate() {
    let mut x = t();
    let a = x.s.publish(&d("u", "k")).unwrap();
    x.s.mark_read("u", Ids::List(std::slice::from_ref(&a.id)))
        .unwrap();
    x.s.dismiss("u", Ids::List(std::slice::from_ref(&a.id)))
        .unwrap();
    assert!(!x.s.publish(&d("u", "k")).unwrap().created);
    assert!(x.s.list("u", &q()).unwrap().entries.is_empty());
    assert!(x.s.publish(&d("other", "k")).unwrap().created);
    assert_eq!(x.s.list("other", &q()).unwrap().entries.len(), 1);
    assert_eq!(x.s.count("u").unwrap().total, 0);
}

#[test]
fn cursor_pages_have_no_gaps_or_duplicates_even_when_entries_arrive_between_pages() {
    let mut x = t();
    for i in 0..7 {
        x.s.publish(&d("u", &format!("k{i}"))).unwrap();
    }
    let p1 =
        x.s.list(
            "u",
            &InboxListQuery {
                limit: Some(3.0),
                ..q()
            },
        )
        .unwrap();
    x.s.publish(&d("u", "late")).unwrap();
    let p2 =
        x.s.list(
            "u",
            &InboxListQuery {
                limit: Some(3.0),
                cursor: p1.next_cursor.clone(),
                ..q()
            },
        )
        .unwrap();
    let p3 =
        x.s.list(
            "u",
            &InboxListQuery {
                limit: Some(3.0),
                cursor: p2.next_cursor.clone(),
                ..q()
            },
        )
        .unwrap();
    let seen: Vec<String> = [p1, p2, p3]
        .iter()
        .flat_map(|p| p.entries.iter().map(|e| e.id.clone()))
        .collect();
    assert_eq!(seen, ["e7", "e6", "e5", "e4", "e3", "e2", "e1"]);
}

#[test]
fn a_malformed_cursor_is_a_typed_error_and_node_style_decoding_is_kept() {
    let x = t();
    for bad in ["", "!", "N", "NAA", "MTIzNDU2Nzg5MDEyMzQ1Ng", "LTE"] {
        let e =
            x.s.list(
                "u",
                &InboxListQuery {
                    cursor: Some(bad.into()),
                    ..q()
                },
            )
            .unwrap_err();
        assert_eq!(
            (e.code(), e.to_string().as_str()),
            (Some("cursor"), "cursor is not valid"),
            "{bad:?}"
        );
    }
    // Both base64 alphabets, padding, an invalid character and `=` ending the input all decode as Node's `Buffer.from` does.
    for (c, n) in [
        ("NA", 4),
        ("NA==", 4),
        ("N A", 4),
        ("NA!", 4),
        ("Mw=A", 3),
        ("MDA3", 7),
    ] {
        assert_eq!(decode_cursor(c).unwrap(), n, "{c:?}");
    }
}

#[test]
fn count_reports_every_kind_and_mark_read_keeps_the_first_read_time() {
    let mut x = t();
    let mut a = d("u", "approval:1");
    a.kind = "approval".into();
    let a = x.s.publish(&a).unwrap();
    x.s.publish(&d("u", "system:1")).unwrap();
    let c = x.s.count("u").unwrap();
    assert_eq!(c.unread.len(), 8);
    assert_eq!(c.unread.iter().find(|(k, _)| k == "approval").unwrap().1, 1);
    assert_eq!(c.total, 2);
    assert_eq!(
        x.s.mark_read("u", Ids::List(std::slice::from_ref(&a.id)))
            .unwrap(),
        1
    );
    x.clock.0.fetch_add(10, Ordering::SeqCst);
    assert_eq!(
        x.s.mark_read("u", Ids::List(&[a.id])).unwrap(),
        0,
        "already read"
    );
    assert_eq!(x.s.mark_read("u", Ids::All).unwrap(), 1);
    assert_eq!(x.s.mark_read("other", Ids::All).unwrap(), 0);
    let db = plur1bus_store::rusqlite::Connection::open(&x.path).unwrap();
    let first: i64 = db
        .query_row("SELECT read_at FROM inbox_entries WHERE id='e1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(first, 1_000_000, "the first read time stays");
}

#[test]
fn settle_closes_by_dedupe_key_and_is_a_no_op_when_absent() {
    let mut x = t();
    x.s.publish(&d("u", "approval:1")).unwrap();
    assert!(x.s.settle("u", "approval:1").unwrap());
    assert!(!x.s.settle("u", "approval:1").unwrap());
    assert!(!x.s.settle("u", "approval:2").unwrap());
    assert!(x.s.list("u", &q()).unwrap().entries.is_empty());
    assert_eq!(
        x.s.list(
            "u",
            &InboxListQuery {
                include_dismissed: true,
                ..q()
            }
        )
        .unwrap()
        .entries
        .len(),
        1
    );
}

#[test]
fn retention_by_age_removes_old_entries_and_an_old_entry_never_blocks_a_repeat() {
    let mut x = t_with(Some(1000.0), None);
    x.s.publish(&d("u", "a")).unwrap();
    x.clock.0.fetch_add(1000, Ordering::SeqCst);
    x.s.publish(&d("u", "b")).unwrap();
    assert_eq!(
        ids(&x.s, "u", true).len(),
        2,
        "age equal to the limit stays"
    );
    x.clock.0.fetch_add(1, Ordering::SeqCst);
    x.s.publish(&d("u", "c")).unwrap();
    assert_eq!(ids(&x.s, "u", true), ["e3", "e2"]);
    x.clock.0.fetch_add(2000, Ordering::SeqCst);
    assert!(
        x.s.publish(&d("u", "c")).unwrap().created,
        "the aged out entry does not hide the repeat event"
    );
}

#[test]
fn retention_by_count_keeps_the_newest_per_person_only() {
    let mut x = t_with(None, Some(3.0));
    for i in 0..5 {
        x.s.publish(&d("u", &format!("k{i}"))).unwrap();
    }
    x.s.publish(&d("v", "k")).unwrap();
    assert_eq!(ids(&x.s, "u", true), ["e5", "e4", "e3"]);
    assert_eq!(ids(&x.s, "v", true), ["e6"]);
}

#[test]
fn the_defaults_are_ninety_days_and_a_thousand_and_bad_limits_are_refused() {
    let x = t();
    assert_eq!(x.s.retention(), (90 * 86_400_000, 1000));
    for (a, b) in [
        (Some(0.0), None),
        (Some(-1.0), None),
        (Some(1.5), None),
        (None, Some(0.0)),
        (None, Some(2.5)),
        (Some(f64::NAN), None),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let e = open(
            dir.path().join("i.sqlite"),
            x.clock.clone(),
            Arc::new(SeqIds::default()),
            a,
            b,
        )
        .err()
        .unwrap();
        assert_eq!(e.code(), Some("invalid"));
    }
}

#[test]
fn entries_survive_a_restart_and_the_file_is_private_and_not_wal() {
    let mut x = t();
    x.s.publish(&d("u", "k")).unwrap();
    let path = x.path.clone();
    let clock = x.clock.clone();
    drop(x.s);
    let s = open(path.clone(), clock, Arc::new(SeqIds::default()), None, None).unwrap();
    assert_eq!(s.list("u", &q()).unwrap().entries.len(), 1);
    let db = plur1bus_store::rusqlite::Connection::open(&path).unwrap();
    let mode: String = db
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "delete");
    let v: i64 = db
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, 0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn a_batch_that_fails_rolls_back_completely_and_ids_are_validated() {
    let mut x = t();
    let a = x.s.publish(&d("u", "k")).unwrap();
    let too_long = "x".repeat(65);
    for bad in [
        vec![],
        vec![String::new()],
        vec![too_long.clone()],
        (0..501).map(|i| i.to_string()).collect(),
    ] {
        assert_eq!(
            x.s.mark_read("u", Ids::List(&bad)).unwrap_err().code(),
            Some("invalid")
        );
        assert_eq!(
            x.s.dismiss("u", Ids::List(&bad)).unwrap_err().code(),
            Some("invalid")
        );
    }
    assert_eq!(
        x.s.dismiss("u", Ids::All).unwrap_err().to_string(),
        "ids must be 1-500 entry ids"
    );
    // The failing call changed nothing.
    assert_eq!(x.s.count("u").unwrap().total, 1);
    assert_eq!(
        x.s.mark_read("u", Ids::List(&[a.id.clone(), a.id]))
            .unwrap(),
        1,
        "an id named twice counts once"
    );
}

#[test]
fn break_glass_notices_migrate_once_without_the_reason() {
    use crate::rbac::break_glass::BreakGlassNotice;
    let mut x = t();
    let n = BreakGlassNotice {
        user_id: "u".into(),
        grant_id: "g1".into(),
        holder_user_id: "h".into(),
        reason: "the secret reason".into(),
        expires_at: 5,
    };
    assert_eq!(
        super::migrate::migrate_breakglass_notices(&mut x.s, std::slice::from_ref(&n)).unwrap(),
        1
    );
    assert_eq!(
        super::migrate::migrate_breakglass_notices(&mut x.s, &[n]).unwrap(),
        0
    );
    let db = plur1bus_store::rusqlite::Connection::open(&x.path).unwrap();
    let all: Vec<String> = db
        .prepare("SELECT params || ifnull(ref,'') FROM inbox_entries")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(all.iter().all(|t| !t.contains("secret")));
}

#[test]
fn mark_read_and_dismiss_report_every_kind_they_changed_not_just_the_newest_page() {
    let mut x = t();
    for i in 0..205 {
        let mut a = d("u", &format!("system:{i}"));
        if i == 0 {
            a.kind = "approval".into();
        }
        x.s.publish(&a).unwrap();
    }
    let kinds = x.s.kinds_of("u", Ids::All, true).unwrap();
    assert!(kinds.contains(&"approval".to_owned()) && kinds.contains(&"system".to_owned()));
    let first = vec!["e1".to_owned()];
    assert_eq!(
        x.s.kinds_of("u", Ids::List(&first), false).unwrap(),
        ["approval"]
    );
}

// --- the service ------------------------------------------------------------------------------------------------------

type Log = Arc<Mutex<Vec<(String, Value)>>>;

fn service(x: T, admins: Vec<String>, log: &Log) -> (InboxService, std::path::PathBuf) {
    let path = x.path.clone();
    let log = log.clone();
    let svc = InboxService::new(InboxServiceOptions {
        store: x.s,
        admins: Box::new(move || admins.clone()),
        on_change: None,
        on_published: None,
        log: Some(Box::new(move |m, f| {
            log.lock().unwrap().push((m.to_owned(), f))
        })),
    });
    std::mem::forget(x._dir);
    (svc, path)
}

fn notice(target: InboxTarget, key: &str) -> InboxNotice {
    InboxNotice {
        target,
        kind: "system".into(),
        severity: "info".into(),
        title_key: "inbox.t".into(),
        params: None,
        reference: None,
        dedupe_key: key.into(),
    }
}

#[test]
fn a_producer_can_never_hurt_its_source_a_failing_store_swallows_every_call() {
    let log: Log = Arc::default();
    let (mut svc, path) = service(t(), vec!["a".into()], &log);
    // The store breaks under the service (the table is gone).
    plur1bus_store::rusqlite::Connection::open(&path)
        .unwrap()
        .execute("DROP TABLE inbox_entries", [])
        .unwrap();
    svc.publish(&notice(InboxTarget::User("u".into()), "system:a"), None);
    svc.publish(&notice(InboxTarget::Admins, "system:b"), Some(1000.0));
    svc.settle(&SettleTarget::All, "system:a");
    svc.settle(&SettleTarget::User("u".into()), "system:a");
    let lines: Vec<String> = log.lock().unwrap().iter().map(|l| l.0.clone()).collect();
    assert_eq!(
        lines,
        [
            "inbox publish failed",
            "inbox publish failed",
            "inbox settle failed",
            "inbox settle failed"
        ]
    );
    // A rejected notice is logged with its kind and the validation text, and never thrown.
    let mut bad = notice(InboxTarget::User("u".into()), "system:a");
    bad.title_key = "BAD".into();
    svc.publish(&bad, None);
    let last = log.lock().unwrap().last().cloned().unwrap();
    assert_eq!(last.1["kind"], "system");
}

#[test]
fn a_token_shaped_job_failure_reason_never_reaches_the_inbox() {
    struct Rec(Vec<InboxNotice>);
    impl InboxPort for Rec {
        fn publish(&mut self, n: &InboxNotice, _: Option<f64>) {
            self.0.push(n.clone());
        }
        fn settle(&mut self, _: &SettleTarget, _: &str) {}
    }
    let mut r = Rec(Vec::new());
    job_failed_to_inbox(&mut r, &JobRun { run_id: "r1", job: "models.scan", reason: Some("401 for sk-abcdef123456 on https://x.test/?key=ghp_abcdefghijklmnopqrstuvwxyz0123456789") });
    let text = format!("{:?}", r.0);
    assert!(
        !text.contains("sk-abcdef") && !text.contains("ghp_abc"),
        "{text}"
    );
    assert!(text.contains("[redacted]"));
}

#[test]
fn a_long_producer_string_is_clipped_not_a_reason_to_lose_the_notification() {
    let long = "x ".repeat(300);
    let p = param(&long);
    assert_eq!(p.encode_utf16().count(), 200);
    assert!(p.ends_with('…'));
    // A clip that would split an emoji drops the half (K3-D4): 198 units, the emoji pair, then more text.
    let cut = param(&format!("{}\u{1F600}{}", "a".repeat(198), "b".repeat(50)));
    assert_eq!(cut, format!("{}…", "a".repeat(198)));
    assert_eq!(param("  a \t\n b  "), "a b");
    assert_eq!(param("see (sk-abcdef123456), ok"), "see ([redacted]), ok");
    assert_eq!(
        param("bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ/x"),
        "bot[redacted]/x"
    );
}

#[test]
fn the_token_words_are_exactly_those_of_looks_like_token() {
    for yes in [
        "xoxb-1",
        "xapp-1",
        "sk-a",
        "sk_a",
        "pk_a",
        "rk_a",
        "ghp_a",
        "gho_a",
        "ghs_a",
        "github_pat_a",
        "glpat-a",
        "AKIAABCDEFGH0",
        "AIzaX",
        "ya29.x",
        "eyJx",
        "syt_x",
        "mfa.x",
        "123456:ABCDEFGHIJKLMNOPQRST",
        "AAAAAAAAAAAAAAAAAAAA.BBBB.CCCCCCCCCCCCCCCCCCCC",
    ] {
        assert!(looks_like_token(yes), "{yes}");
    }
    for no in [
        "",
        "xoxz-1",
        "ya29x",
        "mfax",
        "AKIAABCDEFG",
        "AKIAabcdefgh1",
        "12345:ABCDEFGHIJKLMNOPQRST",
        "123456:ABCDEFGHIJKLMNOPQRS",
        "123456:ABCDEFGHIJKLMNOPQRST!",
        "AAAAAAAAAAAAAAAAAAA.BBBB.CCCCCCCCCCCCCCCCCCCC",
        "a.b.c",
        "plain words",
    ] {
        assert!(!looks_like_token(no), "{no}");
    }
}

#[test]
fn the_store_has_the_two_tables_and_the_index_and_no_other_object() {
    let x = t();
    let db = plur1bus_store::rusqlite::Connection::open(&x.path).unwrap();
    let names: Vec<String> = db
        .prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(names, ["inbox_by_user", "inbox_cooldowns", "inbox_entries"]);
    let _ = InboxError::Cursor;
}
