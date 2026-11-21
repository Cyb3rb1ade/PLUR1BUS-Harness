//! Direct tests for the parts the replay does not reach through a recorded op: JS string semantics, the listener contract,
//! the one-writer transaction boundaries and the file mode. The behaviour that has a TypeScript answer is replayed in
//! `vectors.rs`.
use super::*;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

struct Clk;
impl Clock for Clk {
    fn now(&self) -> i64 {
        42
    }
}
struct Ids(AtomicU64);
impl IdSource for Ids {
    fn next_id(&self) -> String {
        (self.0.fetch_add(1, Ordering::SeqCst) + 1).to_string()
    }
}

fn store() -> SessionStore {
    SessionStore::open_memory(Arc::new(Clk), Arc::new(Ids(AtomicU64::new(0)))).unwrap()
}

fn direct(s: &mut SessionStore, title: &str) -> SessionRecord {
    s.create_session(&CreateSessionInput {
        title: Some(title.to_owned()),
        ..CreateSessionInput::new(SessionKind::Direct, "bernd", "owner")
    })
    .unwrap()
}

#[test]
fn a_title_is_cut_at_200_utf16_units_and_a_split_pair_becomes_the_replacement_character() {
    let mut s = store();
    let title = format!("{}\u{1F600}x", "t".repeat(199));
    let r = direct(&mut s, &title);
    assert_eq!(r.title, format!("{}\u{FFFD}", "t".repeat(199)));
    let emoji = direct(&mut s, &"\u{1F600}".repeat(150));
    assert_eq!(
        emoji.title.chars().count(),
        100,
        "100 whole emoji are 200 units"
    );
}

#[test]
fn the_token_estimate_rounds_up_twice_like_javascript() {
    let mut s = store();
    // ceil(5 / 4) = 2, times the factor 1.5 gives 3; a lone astral char is two UTF-16 units.
    s.set_token_factor("m", 1.5).unwrap();
    assert_eq!(tokens::count(&s, "m", "abcde", None).unwrap(), 3);
    assert_eq!(
        tokens::count(&s, "m", "\u{1F600}\u{1F600}", None).unwrap(),
        2
    );
    assert_eq!(tokens::count(&s, "m", "", None).unwrap(), 0);
}

#[test]
fn a_failing_archive_listener_never_undoes_the_archive() {
    let mut s = store();
    let seen = Arc::new(Mutex::new(0));
    let c = seen.clone();
    s.on_archived(Arc::new(move |_| {
        *c.lock().unwrap() += 1;
        Err("listener down".into())
    }));
    let r = direct(&mut s, "x");
    let archived = s.archive_session(&r.id).unwrap();
    assert!(archived.archived_at.is_some());
    assert_eq!(*seen.lock().unwrap(), 1);
    assert!(s.get_session(&r.id).unwrap().unwrap().archived_at.is_some());
}

#[test]
fn a_removed_listener_is_not_called() {
    let mut s = store();
    let n = Arc::new(AtomicI64::new(0));
    let c = n.clone();
    let id = s.on_erasure(Arc::new(move || {
        c.fetch_add(1, Ordering::SeqCst);
    }));
    s.remove_erasure_listener(id);
    let r = direct(&mut s, "x");
    s.archive_session(&r.id).unwrap();
    s.erase_session(&r.id, "admin", "gdpr").unwrap();
    assert_eq!(n.load(Ordering::SeqCst), 0);
}

#[test]
fn a_failed_begin_turn_leaves_no_row_behind() {
    let mut s = store();
    let r = direct(&mut s, "x");
    s.begin_turn(&r.id, "one", 1, &BeginOptions::default())
        .unwrap();
    let count = |s: &SessionStore, t: &str| -> i64 {
        s.conn()
            .query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
            .unwrap()
    };
    let before = count(&s, "messages");
    let e = s
        .begin_turn(&r.id, "two", 1, &BeginOptions::default())
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(
        before,
        count(&s, "messages"),
        "the refused begin wrote no message"
    );
    assert_eq!(count(&s, "events"), 1, "only the first turn.started");
}

#[test]
fn a_session_file_is_private() {
    let dir = std::env::temp_dir().join(format!("p4k-sessions-mode-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("sessions.sqlite");
    let _store =
        SessionStore::open(&path, Arc::new(Clk), Arc::new(Ids(AtomicU64::new(0)))).unwrap();
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
fn a_rewind_reservation_excludes_other_connections_and_releases_on_drop() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sessions.sqlite");
    let ids = Arc::new(Ids(AtomicU64::new(0)));
    let mut first = SessionStore::open(&path, Arc::new(Clk), ids.clone()).unwrap();
    let mut second = SessionStore::open(&path, Arc::new(Clk), ids).unwrap();
    let session = direct(&mut first, "rewind");
    let other = direct(&mut second, "other");
    let token = first.reserve_rewind(&session.id, None).unwrap();

    let begin =
        |store: &mut SessionStore, id| store.begin_turn(id, "fixture", 1, &BeginOptions::default());
    let error = begin(&mut second, &session.id).unwrap_err();
    assert_eq!(error.reason.as_deref(), Some("rewind-in-progress"));
    assert!(second.rewind_reserved(&session.id));
    assert_eq!(
        second
            .reserve_rewind(&session.id, None)
            .unwrap_err()
            .reason
            .as_deref(),
        Some("rewind-in-progress")
    );
    assert!(begin(&mut second, &other.id).is_ok());
    second.release_rewind(&session.id, token);
    assert!(second.rewind_reserved(&session.id));

    drop(first);
    assert!(!second.rewind_reserved(&session.id));
    assert!(begin(&mut second, &session.id).is_ok());
}

#[test]
fn an_error_never_carries_message_text() {
    let mut s = store();
    let r = direct(&mut s, "x");
    s.begin_turn(
        &r.id,
        "secret text in a message",
        1,
        &BeginOptions::default(),
    )
    .unwrap();
    let e = s
        .begin_turn(&r.id, "another secret", 1, &BeginOptions::default())
        .unwrap_err();
    assert!(!e.message.contains("secret") && !format!("{e:?}").contains("secret"));
}

#[test]
fn a_sqlite_message_maps_to_the_error_the_typescript_store_gives() {
    // `mapSqlite`: substring tests, in this order.
    let e = SessionError::from_message("I1: session kind, agent, owner and scope are immutable");
    assert_eq!(
        (e.code, e.reason.as_deref()),
        (ErrorCode::Immutable, Some("immutable-field"))
    );
    let e = SessionError::from_message("UNIQUE constraint failed: sessions.chat_key");
    assert_eq!(
        (e.code, e.reason.as_deref()),
        (ErrorCode::Conflict, Some("active-chat-session"))
    );
    let e =
        SessionError::from_message("UNIQUE constraint failed: index 'idx_sessions_active_chat'");
    assert_eq!(e.reason.as_deref(), Some("active-chat-session"));
    let e = SessionError::from_message("UNIQUE constraint failed: index 'idx_turns_one_running'");
    assert_eq!(
        (e.code, e.reason.as_deref()),
        (ErrorCode::Conflict, Some("turn-in-progress"))
    );
    // K5-D2: the TypeScript pattern also catches the UNIQUE(session_id, seq) failure of a racing second writer.
    let e = SessionError::from_message("UNIQUE constraint failed: turns.session_id, turns.seq");
    assert_eq!(
        (e.code, e.reason.as_deref()),
        (ErrorCode::Conflict, Some("turn-in-progress"))
    );
    let e = SessionError::from_message("CHECK constraint failed: kind");
    assert_eq!(
        (e.code, e.reason.as_deref()),
        (ErrorCode::Storage, Some("sqlite"))
    );
}
