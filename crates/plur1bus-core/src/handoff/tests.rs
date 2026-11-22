//! The tests of `channel-handoff/handoff.test.ts` and the rules of `core.test.ts` / `host.test.ts` that belong to the library,
//! over the real store file and the scripted ports; the scenarios the exporter records are replayed in `vectors.rs`.
use super::testing::Rig;
use super::{ChatKind, InboundMessage};
use plur1bus_store::rusqlite::Connection;
use serde_json::{json, Value};

fn turn_messages(n: usize) -> Value {
    Value::Array(
        (0..n)
            .map(|i| json!({"role": if i % 2 == 1 {"assistant"} else {"user"}, "text": format!("{}-{}", if i % 2 == 1 {"reply"} else {"question"}, i / 2), "createdAt": 600 + i}))
            .collect(),
    )
}

#[allow(clippy::needless_pass_by_value)]
fn world(sessions: Value) -> Value {
    json!({
        "now": 1_000_000, "baseUrl": "https://web.example", "agentId": "main",
        "links": [{"channel": "telegram", "accountId": "bot", "userId": "sender", "human": "alice"}],
        "principals": {"alice": {"role": "owner", "kind": "person"}, "bob": {"role": "owner", "kind": "person"}},
        "sessions": sessions, "storeAvailable": true,
    })
}

#[allow(clippy::needless_pass_by_value)]
fn s1(extra: Value) -> Value {
    let mut s = json!({"id": "s1", "kind": "channel", "ownerPerson": "alice", "chatKey": "telegram:dm", "agentId": "main", "title": "Private DM", "updatedAt": 500});
    for (k, v) in extra.as_object().cloned().unwrap_or_default() {
        s[k] = v;
    }
    s
}

fn dm() -> InboundMessage {
    InboundMessage {
        channel: "telegram".into(),
        chat_id: "dm".into(),
        chat_kind: ChatKind::Direct,
        sender_id: "sender".into(),
        account_id: Some("bot".into()),
        text: "hello".into(),
    }
}

fn group() -> InboundMessage {
    InboundMessage {
        chat_kind: ChatKind::Group,
        ..dm()
    }
}

/// A rig whose `s1` was seen as direct while it was still empty, then grew to nine turns.
fn rig_with_history() -> Rig {
    let mut r = Rig::new(&world(json!([s1(json!({}))])));
    r.h().observe(&dm(), "alice", "s1").unwrap();
    r.w.lock().unwrap().sessions[0].messages = turn_messages(18)
        .as_array()
        .unwrap()
        .iter()
        .map(super::testing::message_of)
        .collect();
    r
}

fn continuation_text(r: &Rig, id: &str) -> String {
    r.w.lock()
        .unwrap()
        .sessions
        .iter()
        .find(|s| s.id == id)
        .unwrap()
        .messages[0]
        .text
        .clone()
}

#[test]
fn d120_a_web_continuation_excludes_rewound_channel_messages_and_overlapping_summaries() {
    let mut r = rig_with_history();
    {
        let mut w = r.w.lock().unwrap();
        let s = &mut w.sessions[0];
        s.summaries
            .push(("DISCARDED_HANDOFF_SUMMARY".into(), 1, 18));
        // The user rewound to message 2: everything after it is hidden, and so is a summary that overlaps the hidden range.
        s.rewinds.push((3, 18, false));
        s.messages.truncate(2);
    }
    let issued = r.h().issue("s1", "alice").unwrap();
    let out = r.h().redeem(&issued.token, "alice").unwrap();
    let ctx = continuation_text(&r, &out.session_id);
    assert!(
        !ctx.contains("DISCARDED_HANDOFF_SUMMARY")
            && !ctx.contains("question-8")
            && !ctx.contains("reply-8")
    );
    assert!(ctx.contains("question-0"));
}

#[test]
fn a_person_bound_link_redeems_once_into_a_separate_seeded_direct_session_and_the_token_is_never_audited(
) {
    let mut r = rig_with_history();
    let issued = r.h().issue("s1", "alice").unwrap();
    assert!(r.h().redeem(&issued.token, "bob").unwrap_err().is_denied());
    let out = r.h().redeem(&issued.token, "alice").unwrap();
    assert_ne!(out.session_id, "s1");
    assert_eq!(
        (out.from_session_id.as_str(), out.from_channel.as_str()),
        ("s1", "telegram")
    );
    let next_kind =
        r.w.lock()
            .unwrap()
            .sessions
            .iter()
            .find(|s| s.id == out.session_id)
            .map(|s| s.kind.clone())
            .unwrap();
    assert_eq!(next_kind, "direct");
    assert!(
        !r.w.lock().unwrap().sessions[0].archived,
        "the channel session stays active"
    );
    let seed = continuation_text(&r, &out.session_id);
    assert!(
        seed.contains("untrusted") && seed.contains("question-8") && !seed.contains("question-0")
    );
    assert!(
        r.h()
            .redeem(&issued.token, "alice")
            .unwrap_err()
            .is_denied(),
        "one use"
    );
    let audit = format!("{:?}", r.w.lock().unwrap().audit);
    assert!(!audit.contains(&issued.token));
}

#[test]
fn an_expired_link_a_revoked_identity_and_a_wrong_bot_cannot_hand_off() {
    let mut r = rig_with_history();
    let issued = r.h().issue("s1", "alice").unwrap();
    let wrong_bot = InboundMessage {
        account_id: Some("wrong".into()),
        ..dm()
    };
    assert!(r
        .h()
        .issue_message(&wrong_bot, "alice")
        .unwrap_err()
        .is_denied());
    r.w.lock().unwrap().now += 600_000;
    assert!(r
        .h()
        .redeem(&issued.token, "alice")
        .unwrap_err()
        .is_denied());
    let again = r.h().issue("s1", "alice").unwrap();
    r.w.lock().unwrap().links.clear();
    assert!(r.h().redeem(&again.token, "alice").unwrap_err().is_denied());
    assert!(r.h().list("alice").unwrap().sessions.is_empty());
}

#[test]
fn history_is_own_only_and_excludes_groups_and_sessions_nobody_observed() {
    let mut r = rig_with_history();
    assert_eq!(r.h().list("alice").unwrap().sessions.len(), 1);
    assert!(r.h().list("bob").unwrap().sessions.is_empty());
    assert!(r.h().get("s1", "bob").unwrap_err().is_denied());
    r.w.lock().unwrap().sessions.push(super::testing::sess_of(&json!({"id": "old", "kind": "channel", "ownerPerson": "alice", "chatKey": "matrix:old", "agentId": "main", "updatedAt": 1})));
    assert!(r.h().get("old", "alice").unwrap_err().is_denied());
    r.h().observe(&group(), "alice", "s1").unwrap();
    assert!(r.h().list("alice").unwrap().sessions.is_empty());
    assert!(r.h().issue("s1", "alice").unwrap_err().is_denied());
}

#[test]
fn a_private_persisted_link_survives_a_restart_and_stays_one_use() {
    let mut r = rig_with_history();
    let issued = r.h().issue("s1", "alice").unwrap();
    r.reopen();
    assert!(!r
        .h()
        .redeem(&issued.token, "alice")
        .unwrap()
        .session_id
        .is_empty());
    assert!(r
        .h()
        .redeem(&issued.token, "alice")
        .unwrap_err()
        .is_denied());
}

#[test]
fn group_to_direct_and_historical_to_direct_never_expose_earlier_text() {
    let mut r = rig_with_history();
    r.h().observe(&group(), "alice", "s1").unwrap();
    r.h().observe(&dm(), "alice", "s1").unwrap();
    assert!(r.h().get("s1", "alice").unwrap_err().is_denied());
    // A session that already had a turn before anybody observed it as direct.
    let old = super::testing::sess_of(
        &json!({"id": "legacy", "kind": "channel", "ownerPerson": "alice", "chatKey": "telegram:legacy", "agentId": "main", "updatedAt": 1,
        "messages": [{"role": "user", "text": "private group words", "createdAt": 1}, {"role": "assistant", "text": "group reply", "createdAt": 2}]}),
    );
    r.w.lock().unwrap().sessions.push(old);
    let legacy_dm = InboundMessage {
        chat_id: "legacy".into(),
        ..dm()
    };
    r.h().observe(&legacy_dm, "alice", "legacy").unwrap();
    assert!(r.h().get("legacy", "alice").unwrap_err().is_denied());
}

#[test]
fn the_first_direct_web_command_after_pairing_creates_an_empty_source_without_a_model_turn() {
    let mut r = Rig::new(&world(json!([])));
    let fresh = InboundMessage {
        chat_id: "fresh".into(),
        text: "/web".into(),
        ..dm()
    };
    let link = r.h().issue_message(&fresh, "alice").unwrap();
    assert!(link.starts_with("https://web.example/#/chat/handoff/"));
    let out = r
        .h()
        .redeem(link.rsplit('/').next().unwrap(), "alice")
        .unwrap();
    let w = r.w.lock().unwrap();
    assert_eq!(
        w.sessions
            .iter()
            .find(|s| s.id == out.session_id)
            .unwrap()
            .kind,
        "direct"
    );
    assert!(w
        .sessions
        .iter()
        .find(|s| s.chat_key.as_deref() == Some("telegram:fresh"))
        .unwrap()
        .messages
        .is_empty());
}

#[test]
fn a_group_message_never_gets_a_link_and_a_stranger_never_gets_a_session() {
    let mut r = Rig::new(&world(json!([])));
    assert!(r
        .h()
        .issue_message(
            &InboundMessage {
                chat_kind: ChatKind::Group,
                text: "/web".into(),
                ..dm()
            },
            "alice"
        )
        .unwrap_err()
        .is_denied());
    let stranger = InboundMessage {
        chat_id: "x".into(),
        sender_id: "stranger".into(),
        ..dm()
    };
    assert!(r
        .h()
        .issue_message(&stranger, "alice")
        .unwrap_err()
        .is_denied());
    assert!(
        r.w.lock().unwrap().sessions.is_empty(),
        "a refused message created nothing"
    );
}

#[test]
fn a_row_that_does_not_parse_is_never_visible_and_does_not_hide_the_others() {
    let mut r = rig_with_history();
    r.w.lock().unwrap().sessions.push(super::testing::sess_of(&json!({"id": "s2", "kind": "channel", "ownerPerson": "alice", "chatKey": "telegram:c2", "agentId": "main", "updatedAt": 1})));
    r.h()
        .observe(
            &InboundMessage {
                chat_id: "c2".into(),
                ..dm()
            },
            "alice",
            "s2",
        )
        .unwrap();
    let path = r.path.clone();
    let c = Connection::open(&path).unwrap();
    c.execute(
        "UPDATE channel_direct SET value = 'not json' WHERE session_id = 's1'",
        [],
    )
    .unwrap();
    drop(c);
    assert!(r.h().get("s1", "alice").unwrap_err().is_denied());
    assert!(r.h().issue("s1", "alice").unwrap_err().is_denied());
    let list = r.h().list("alice").unwrap();
    assert_eq!(
        list.sessions
            .iter()
            .map(|s| s.id.as_str())
            .collect::<Vec<_>>(),
        ["s2"]
    );
}

#[test]
fn k3_d4_a_cut_that_would_split_a_surrogate_pair_drops_the_half() {
    // TypeScript's `slice(0, 400)` leaves the first half of the pair; a Rust string cannot hold it, so the half goes.
    let mut r = rig_with_history();
    r.w.lock().unwrap().sessions[0].messages[17].text = format!("{}😀", "a".repeat(399));
    let issued = r.h().issue("s1", "alice").unwrap();
    let out = r.h().redeem(&issued.token, "alice").unwrap();
    let ctx = continuation_text(&r, &out.session_id);
    assert!(
        ctx.contains(&format!("assistant: {}\n", "a".repeat(399)))
            || ctx.ends_with(&format!("assistant: {}", "a".repeat(399))),
        "{ctx}"
    );
    assert!(!ctx.contains('😀'));
}

#[test]
fn the_store_has_the_four_tables_and_no_user_version() {
    let r = Rig::new(&world(json!([])));
    let c = Connection::open(&r.path).unwrap();
    let names: Vec<String> = c
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .unwrap()
        .query_map([], |x| x.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        names,
        [
            "channel_continuations",
            "channel_direct",
            "channel_handoffs",
            "channel_taint"
        ]
    );
    let v: i64 = c
        .query_row("PRAGMA user_version", [], |x| x.get(0))
        .unwrap();
    assert_eq!(v, 0);
    let sync: i64 = Connection::open(&r.path)
        .unwrap()
        .query_row("PRAGMA journal_mode", [], |x| {
            x.get::<_, String>(0).map(|s| i64::from(s == "wal"))
        })
        .unwrap();
    assert_eq!(sync, 1, "WAL");
}

#[cfg(unix)]
#[test]
fn the_file_is_private() {
    use std::os::unix::fs::PermissionsExt;
    let r = Rig::new(&world(json!([])));
    let mode = std::fs::metadata(&r.path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let dir = std::fs::metadata(r.path.parent().unwrap())
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(dir, 0o700);
}

#[test]
fn a_store_whose_permissions_cannot_be_applied_is_not_opened() {
    let dir = tempfile::tempdir().unwrap();
    let e = super::store::open(&dir.path().join("h.sqlite"), Some(&|_| false))
        .err()
        .unwrap();
    assert_eq!(e.to_string(), "handoff permissions unavailable");
}
