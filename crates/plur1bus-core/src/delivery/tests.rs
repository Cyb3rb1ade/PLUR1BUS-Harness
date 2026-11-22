//! Ports of `packages/core/test/delivery/{targets,policy}.test.ts` and of the rules the TypeScript tests leave to the
//! reader: the two races through hooks that change the world inside the channel call, the exact text of the command, the
//! number rendering of the allowlist, a row that does not parse, the private file and the schema.
use super::policy::js_number_string;
use super::service::row_exists;
use super::testing::Rig;
use super::{delivery_allowed, ChannelIdentity};
use crate::handoff::{ChatKind, InboundMessage};
use crate::rbac::types::{Principal, PrincipalKind, Role};
use serde_json::{json, Value};

fn tg(user: &str) -> ChannelIdentity {
    ChannelIdentity {
        channel: "telegram".into(),
        account_id: "bot".into(),
        user_id: user.into(),
    }
}

fn world() -> Value {
    json!({"now": 1_000_000, "links": [{"channel": "telegram", "accountId": "bot", "userId": "sender", "human": "alice"}],
        "principals": {"alice": {"role": "owner", "kind": "person"}, "bob": {"role": "owner", "kind": "person"}},
        "chat": "dm"})
}

fn alice() -> Principal {
    let mut p = Principal::new("alice", Role::Owner);
    p.kind = Some(PrincipalKind::Person);
    p
}

fn msg(text: &str) -> InboundMessage {
    InboundMessage {
        channel: "telegram".into(),
        chat_id: "dm".into(),
        chat_kind: ChatKind::Direct,
        sender_id: "sender".into(),
        account_id: Some("bot".into()),
        text: text.into(),
    }
}

fn last_code(rig: &Rig) -> String {
    rig.w
        .lock()
        .unwrap()
        .sent
        .last()
        .unwrap()
        .2
        .rsplit(' ')
        .next()
        .unwrap()
        .to_owned()
}

#[test]
fn a_target_needs_the_exact_dm_confirmation_and_never_shows_the_code() {
    let mut r = Rig::new(&world());
    let t = r.d().add(&tg("sender"), &alice()).unwrap();
    assert!(!t.validated);
    assert!(r
        .d()
        .validate(&t.id, "alice", "main")
        .unwrap_err()
        .is_denied());
    let code = last_code(&r);
    assert_eq!(code.len(), 32);
    let listed = serde_json::to_string(&r.d().list(&alice()).unwrap()).unwrap();
    assert!(!listed.contains(&code));
    // The wrong chat, the wrong bot, a group and a stranger's text change nothing.
    let mut m = msg(&format!("/delivery {code}"));
    m.chat_id = "wrong".into();
    assert!(r.d().confirm_message(&m, "alice").unwrap());
    let mut m = msg(&format!("/delivery {code}"));
    m.account_id = Some("other-bot".into());
    r.d().confirm_message(&m, "alice").unwrap();
    let mut m = msg(&format!("/delivery {code}"));
    m.chat_kind = ChatKind::Group;
    r.d().confirm_message(&m, "alice").unwrap();
    r.d()
        .confirm_message(&msg(&format!("/delivery {code}")), "bob")
        .unwrap();
    assert!(r
        .d()
        .validate(&t.id, "alice", "main")
        .unwrap_err()
        .is_denied());
    assert!(r
        .d()
        .confirm_message(&msg(&format!("/delivery {code}")), "alice")
        .unwrap());
    assert!(r.d().deliver(&t.id, "alice", "main", "result").unwrap());
    assert_eq!(r.w.lock().unwrap().sent.last().unwrap().2, "result");
    // Another person cannot use it.
    assert!(r
        .d()
        .deliver(&t.id, "bob", "main", "private")
        .unwrap_err()
        .is_denied());
    let w = r.w.lock().unwrap();
    assert!(w.audit.iter().any(|e| e.action == "delivery.denied"));
    assert!(
        !format!("{:?}", w.audit).contains(&code),
        "the code is never audited"
    );
}

#[test]
fn a_code_confirms_once_and_a_new_challenge_retires_the_old_code() {
    let mut r = Rig::new(&world());
    let t = r.d().add(&tg("sender"), &alice()).unwrap();
    let code = last_code(&r);
    r.d()
        .confirm_message(&msg(&format!("/delivery {code}")), "alice")
        .unwrap();
    r.d()
        .subscribe(&t.id, "dreams", "light", "main", &alice())
        .unwrap();
    r.d()
        .notify("dreams", "light", Some("main"), "completed")
        .unwrap();
    assert_eq!(
        r.w.lock().unwrap().sent.last().unwrap().2,
        "dreams: light — completed"
    );
    r.d().challenge(&t.id, &alice()).unwrap();
    // The old code is spent, the target is unconfirmed again.
    r.d()
        .confirm_message(&msg(&format!("/delivery {code}")), "alice")
        .unwrap();
    assert!(r.d().validate(&t.id, "alice", "main").is_err());
    let fresh = last_code(&r);
    assert_ne!(fresh, code);
}

#[test]
fn the_code_expires_at_ten_minutes_and_stops_after_five_tries() {
    let mut r = Rig::new(&world());
    let t = r.d().add(&tg("sender"), &alice()).unwrap();
    let code = last_code(&r);
    r.w.lock().unwrap().now += 599_999;
    // One before the limit: four wrong tries leave the fifth.
    for _ in 0..4 {
        r.d()
            .confirm_message(&msg(&format!("/delivery {}", "0".repeat(32))), "alice")
            .unwrap();
    }
    r.d()
        .confirm_message(&msg(&format!("/delivery {code}")), "alice")
        .unwrap();
    assert!(r.d().validate(&t.id, "alice", "main").is_ok());
    r.d().challenge(&t.id, &alice()).unwrap();
    let code = last_code(&r);
    for _ in 0..5 {
        r.d()
            .confirm_message(&msg(&format!("/delivery {}", "0".repeat(32))), "alice")
            .unwrap();
    }
    r.d()
        .confirm_message(&msg(&format!("/delivery {code}")), "alice")
        .unwrap();
    assert!(
        r.d().validate(&t.id, "alice", "main").is_err(),
        "the sixth try is refused even with the right code"
    );
    r.d().challenge(&t.id, &alice()).unwrap();
    let code = last_code(&r);
    r.w.lock().unwrap().now += 600_000;
    r.d()
        .confirm_message(&msg(&format!("/delivery {code}")), "alice")
        .unwrap();
    assert!(
        r.d().validate(&t.id, "alice", "main").is_err(),
        "now == expires is expired"
    );
}

#[test]
fn the_command_is_ascii_case_insensitive_and_unicode_whitespace_is_javascripts() {
    let mut r = Rig::new(&world());
    let t = r.d().add(&tg("sender"), &alice()).unwrap();
    let code = last_code(&r);
    // Not a command: consumed as ordinary text (false), no try is counted.
    for text in [
        "hello",
        "/deliveryX x",
        "/delivery\u{0085}",
        "/\u{0131}\u{017f}delivery",
        "/DEL\u{0130}VERY x",
    ] {
        assert!(
            !r.d().confirm_message(&msg(text), "alice").unwrap(),
            "{text:?}"
        );
    }
    // U+0085 is not JavaScript whitespace, so it neither ends the command word nor separates the code.
    assert!(!r
        .d()
        .confirm_message(&msg(&format!("/delivery\u{0085}{code}")), "alice")
        .unwrap());
    assert!(r.d().validate(&t.id, "alice", "main").is_err());
    // The BOM and U+3000 are whitespace for `trim` and `\s`; the upper case code is accepted and lowered.
    let upper = code.to_ascii_uppercase();
    assert!(r
        .d()
        .confirm_message(
            &msg(&format!("\u{feff}/Delivery\u{3000}{upper}\u{a0}")),
            "alice"
        )
        .unwrap());
    assert!(r.d().validate(&t.id, "alice", "main").is_ok());
}

#[test]
fn quota_is_thirty_two_per_person_and_a_race_across_the_dm_lookup_cannot_overbook() {
    let mut r = Rig::new(&world());
    r.w.lock()
        .unwrap()
        .hooks
        .push_back(json!({"kind": "fill-quota", "person": "alice", "count": 32}));
    assert!(
        r.d().add(&tg("sender"), &alice()).unwrap_err().is_denied(),
        "the recheck after the channel call sees the filled quota"
    );
    assert_eq!(r.d().list(&alice()).unwrap().len(), 32);
    assert!(r.d().add(&tg("sender"), &alice()).unwrap_err().is_denied());
}

#[test]
fn a_change_during_the_channel_lookup_stops_the_delivery_before_the_send() {
    for (hook, why) in [
        (
            json!({"kind": "world", "patch": {"allowed": []}}),
            "allowlist",
        ),
        (
            json!({"kind": "unlink", "channel": "telegram", "accountId": "bot", "userId": "sender"}),
            "link",
        ),
        (
            json!({"kind": "world", "patch": {"chat": "other-dm"}}),
            "chat",
        ),
        (json!({"kind": "delete-row", "nth": 0}), "row"),
    ] {
        let mut r = Rig::new(&world());
        let t = r.d().add(&tg("sender"), &alice()).unwrap();
        r.w.lock().unwrap().ids.push(t.id.clone());
        let code = last_code(&r);
        r.d()
            .confirm_message(&msg(&format!("/delivery {code}")), "alice")
            .unwrap();
        let before = r.w.lock().unwrap().sent.len();
        r.w.lock().unwrap().hooks.push_back(hook);
        assert!(
            r.d()
                .deliver(&t.id, "alice", "main", "private")
                .unwrap_err()
                .is_denied(),
            "{why}"
        );
        assert_eq!(
            r.w.lock().unwrap().sent.len(),
            before,
            "{why}: nothing was sent"
        );
    }
}

#[test]
fn every_use_checks_the_right_to_use_the_agent_and_the_role_of_the_person() {
    let mut r = Rig::new(&world());
    let t = r.d().add(&tg("sender"), &alice()).unwrap();
    let code = last_code(&r);
    r.d()
        .confirm_message(&msg(&format!("/delivery {code}")), "alice")
        .unwrap();
    let set = |r: &Rig, spec: Value| {
        let mut w = r.w.lock().unwrap();
        w.principals.retain(|(k, _)| k != "alice");
        w.principals.push(("alice".into(), spec));
    };
    set(&r, json!({"role": "member", "kind": "person"}));
    assert!(
        r.d().validate(&t.id, "alice", "main").is_err(),
        "a member without a right on the agent"
    );
    set(
        &r,
        json!({"role": "member", "kind": "person", "agentRights": {"main": "use"}}),
    );
    assert!(r.d().validate(&t.id, "alice", "main").is_ok());
    assert!(r.d().validate(&t.id, "alice", "other").is_err());
    set(
        &r,
        json!({"role": "viewer", "kind": "person", "agentRights": {"main": "use"}}),
    );
    assert!(
        r.d().validate(&t.id, "alice", "main").is_err(),
        "a viewer never uses an agent"
    );
}

#[test]
fn a_row_that_does_not_parse_fails_the_call_and_allows_nothing() {
    let mut r = Rig::new(&world());
    let t = r.d().add(&tg("sender"), &alice()).unwrap();
    let db = plur1bus_store::rusqlite::Connection::open(&r.path).unwrap();
    db.execute("UPDATE delivery_targets SET value='{not json'", [])
        .unwrap();
    assert!(r.d().list(&alice()).is_err());
    assert!(r.d().validate(&t.id, "alice", "main").is_err());
    assert!(r.d().deliver(&t.id, "alice", "main", "x").is_err());
    assert!(r.d().add(&tg("sender"), &alice()).is_err());
    assert!(r.d().notify("dreams", "light", None, "x").is_err());
    assert!(row_exists(&db, &t.id));
}

#[test]
fn an_audit_that_cannot_be_written_stops_the_call_before_its_effect() {
    let mut r = Rig::new(&world());
    r.w.lock().unwrap().audit_fail = true;
    assert!(r.d().add(&tg("sender"), &alice()).is_err());
    assert!(
        r.d().list(&alice()).unwrap().is_empty(),
        "no row without its audit line"
    );
    r.w.lock().unwrap().audit_fail = false;
    let t = r.d().add(&tg("sender"), &alice()).unwrap();
    r.w.lock().unwrap().audit_fail = true;
    assert!(r.d().remove(&t.id, &alice()).is_err());
    assert_eq!(r.d().list(&alice()).unwrap().len(), 1);
}

#[test]
fn the_unconfirmable_send_leaves_the_target_and_the_error_has_no_code() {
    let mut r = Rig::new(&world());
    r.w.lock().unwrap().send_ok = false;
    let e = r.d().add(&tg("sender"), &alice()).unwrap_err();
    assert_eq!(e.to_string(), "confirmation could not be sent");
    assert!(!e.to_string().contains(&last_code(&r)));
    assert_eq!(r.d().list(&alice()).unwrap().len(), 1);
}

#[test]
fn only_a_person_that_exists_may_hold_targets_and_the_list_is_their_own() {
    let mut r = Rig::new(&world());
    let mut agent = alice();
    agent.kind = Some(PrincipalKind::Agent);
    assert!(r.d().add(&tg("sender"), &agent).unwrap_err().is_denied());
    let mut nobody = alice();
    nobody.user_id = "nobody".into();
    assert!(r.d().list(&nobody).unwrap_err().is_denied());
    assert!(r.d().eligible(&nobody).unwrap_err().is_denied());
    let t = r.d().add(&tg("sender"), &alice()).unwrap();
    let mut bob = alice();
    bob.user_id = "bob".into();
    assert!(r.d().list(&bob).unwrap().is_empty());
    assert!(r.d().remove(&t.id, &bob).unwrap_err().is_denied());
    assert!(r.d().challenge(&t.id, &bob).unwrap_err().is_denied());
}

#[test]
fn subscriptions_keep_the_last_thirty_two_and_system_jobs_need_an_owner_or_admin() {
    let mut r = Rig::new(&world());
    let t = r.d().add(&tg("sender"), &alice()).unwrap();
    let code = last_code(&r);
    r.d()
        .confirm_message(&msg(&format!("/delivery {code}")), "alice")
        .unwrap();
    for i in 0..34 {
        r.d()
            .subscribe(&t.id, "dreams", &format!("job{i}"), "main", &alice())
            .unwrap();
    }
    let row = r.d().validate(&t.id, "alice", "main").unwrap();
    let subs = row.subscriptions.unwrap();
    assert_eq!(subs.len(), 32);
    assert_eq!(subs[0].job, "job2");
    for bad in ["", "bad job", "bad\n", &"a".repeat(65)] {
        assert!(
            r.d()
                .subscribe(&t.id, "dreams", bad, "main", &alice())
                .unwrap_err()
                .is_denied(),
            "{bad:?}"
        );
    }
    assert!(r
        .d()
        .subscribe(&t.id, "other", "x", "main", &alice())
        .unwrap_err()
        .is_denied());
    let mut member = alice();
    member.role = Role::Member;
    assert!(r
        .d()
        .subscribe(&t.id, "system", "models.scan", "main", &member)
        .unwrap_err()
        .is_denied());
}

#[test]
fn the_store_is_private_has_one_table_and_no_user_version() {
    let r = Rig::new(&world());
    let db = plur1bus_store::rusqlite::Connection::open(&r.path).unwrap();
    let sql: String = db
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name='delivery_targets'",
            [],
            |x| x.get(0),
        )
        .unwrap();
    assert_eq!(
        sql,
        "CREATE TABLE delivery_targets(id TEXT PRIMARY KEY, value TEXT NOT NULL)"
    );
    let v: i64 = db
        .query_row("PRAGMA user_version", [], |x| x.get(0))
        .unwrap();
    assert_eq!(v, 0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&r.path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}

#[test]
fn a_store_whose_permissions_cannot_be_applied_is_not_opened() {
    let dir = tempfile::tempdir().unwrap();
    let r = Rig::new(&world());
    let w = r.w.clone();
    let o = super::DeliveryOptions {
        path: dir.path().join("s").join("delivery.sqlite"),
        clock: std::sync::Arc::new(super::testing::WorldClock(w.clone())),
        identity: Box::new(super::testing::WorldIdentity(w.clone())),
        resolve: super::testing::world_principals(&w),
        audit: Box::new(super::testing::WorldAudit(w)),
        allowed: Box::new(|_| true),
        target: Box::new(|_| String::new()),
        send: Box::new(|_, _, _| true),
        ids: r.ids.clone(),
        random: r.rnd.clone(),
        secure_path: Some(Box::new(|_| false)),
    };
    let e = super::DeliveryTargets::open(o).err().unwrap();
    assert_eq!(e.to_string(), "delivery permissions unavailable");
}

#[test]
fn the_allowlist_reads_the_list_of_its_channel_and_compares_ids_as_strings() {
    let none = |_: &str| None;
    let id = |c: &str, u: &str| ChannelIdentity {
        channel: c.into(),
        account_id: "a".into(),
        user_id: u.into(),
    };
    // A numeric Telegram entry admits its destination.
    let c = json!({"telegram": {"enabled": true, "allowlist": [123456789, "42"]}});
    assert!(delivery_allowed(&c, &id("telegram", "123456789"), &none));
    assert!(delivery_allowed(&c, &id("telegram", "42"), &none));
    assert!(!delivery_allowed(&c, &id("telegram", "43"), &none));
    // Disabled, missing list, non-scalar entries.
    for cfg in [
        json!({"telegram": {"enabled": false, "allowlist": ["1"]}}),
        json!({"telegram": {"enabled": "true", "allowlist": ["1"]}}),
        json!({"telegram": {"enabled": true}}),
        json!({"telegram": {"enabled": true, "allowlist": "1"}}),
        json!({"telegram": {"enabled": true, "allowlist": [null, true, ["1"], {"a": 1}]}}),
        json!({}),
    ] {
        assert!(
            !delivery_allowed(&cfg, &id("telegram", "1"), &none),
            "{cfg}"
        );
    }
    // Direct-message channels read dmAllowlist, not allowlist; Buzz reads senderAllowlist through the key port.
    let c = json!({"slack": {"enabled": true, "allowlist": ["U1"], "dmAllowlist": ["U2"]}, "buzz": {"enabled": true, "senderAllowlist": ["npub1x"], "allowlist": ["abc"]}});
    assert!(!delivery_allowed(&c, &id("slack", "U1"), &none));
    assert!(delivery_allowed(&c, &id("slack", "U2"), &none));
    let key = |s: &str| (s == "npub1x").then(|| "abc".to_owned());
    assert!(delivery_allowed(&c, &id("buzz", "abc"), &key));
    assert!(!delivery_allowed(&c, &id("buzz", "npub1x"), &key));
    assert!(!delivery_allowed(&c, &id("buzz", "abc"), &none));
}

#[test]
fn numbers_are_rendered_as_javascript_renders_them() {
    for (x, s) in [
        (0.0, "0"),
        (-0.0, "0"),
        (42.0, "42"),
        (0.5, "0.5"),
        (123456789.0, "123456789"),
        (1e21, "1e+21"),
        (1e20, "100000000000000000000"),
        (12345678901234567890.0, "12345678901234567000"),
        (1.5e300, "1.5e+300"),
        (1e-7, "1e-7"),
        (0.000001, "0.000001"),
        (-1.5, "-1.5"),
        (123e-20, "1.23e-18"),
    ] {
        assert_eq!(js_number_string(x), s);
    }
}
