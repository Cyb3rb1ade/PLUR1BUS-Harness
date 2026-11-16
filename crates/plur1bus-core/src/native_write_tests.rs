//! The write methods of flip A2 on a real home: who may change whose role and status, what is audited before the row
//! changes, what is refused without a trace, and what the legacy core is asked for afterwards.
#![allow(clippy::unwrap_used)]
use super::tests::{
    admin, audit_lines, bare, chain_records, home, identity, owner, refused, set_role, Home,
};
use super::*;
use crate::identity::service::Actor;
use std::sync::atomic::{AtomicBool, Ordering};

/// SHA-256 of `local-owner` and of `second` (`printf '%s' <id> | shasum -a 256`).
const OWNER_HASH: &str = "f815d4b478fa8545ecb5d97fd8983c500df215a126363add288303e4574b64b1";
const SECOND_HASH: &str = "16367aacb67a4a017c8da8ab95682ccb390863780f7114dda0a0e0c55644c7c4";

/// The legacy core as the native methods see it: what it was asked for, whether it can be reached, whether it answers.
#[derive(Default)]
struct Legacy {
    asked: Mutex<Vec<(String, bool, bool)>>,
    unreachable: AtomicBool,
    failing: AtomicBool,
}

impl LegacyCore for Legacy {
    fn reachable(&self) -> bool {
        !self.unreachable.load(Ordering::SeqCst)
    }
    fn account_changed(&self, user_id: &str, rights: bool, learning: bool) -> Result<(), String> {
        self.asked
            .lock()
            .unwrap()
            .push((user_id.to_owned(), rights, learning));
        if self.failing.load(Ordering::SeqCst) {
            return Err("timeout".to_owned());
        }
        Ok(())
    }
    fn secret_changed(&self, _: Option<&str>, _: Option<&str>) -> Result<(), String> {
        Ok(())
    }
}

impl Legacy {
    fn asked(&self) -> Vec<(String, bool, bool)> {
        std::mem::take(&mut *self.asked.lock().unwrap())
    }
}

/// A home the legacy core runs in: both stores exist, `second` is a Member, and the control link stands.
fn running() -> (Home, Arc<Legacy>, AdminStore) {
    let h = home();
    drop(identity(&h));
    let mut other = admin(&h);
    set_role(&mut other, "second", "member");
    let legacy = Arc::new(Legacy::default());
    h.native.set_legacy(legacy.clone());
    (h, legacy, other)
}

fn told(user: &str, rights: bool, learning: bool) -> Vec<(String, bool, bool)> {
    vec![(user.to_owned(), rights, learning)]
}

fn audit_text(home: &Home) -> String {
    std::fs::read_to_string(home.dir.path().join("logs/audit.log")).unwrap_or_default()
}

fn stored(store: &AdminStore, id: &str) -> (String, bool, i64) {
    let row = store
        .users()
        .unwrap()
        .into_iter()
        .find(|u| u.id == id)
        .unwrap();
    (row.role, row.disabled, row.version)
}

fn code<T: std::fmt::Debug>(r: Result<T, MethodError>) -> (String, Option<String>) {
    let (code, reason, _) = refused(r);
    (code, reason)
}

#[test]
fn a_role_is_assigned_audited_first_and_the_legacy_core_is_told() {
    let (h, legacy, other) = running();
    let (_, _, version) = stored(&other, "second");
    let done = h.native.user_role_set(&owner(), "second", "admin").unwrap();
    assert_eq!(done, json!({"userId": "second", "role": "admin"}));
    assert_eq!(
        stored(&other, "second"),
        ("admin".to_owned(), false, version + 1),
        "the other process reads the new role, and its version moved"
    );
    let lines = audit_lines(&h);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0]["action"], "user.role.set");
    assert_eq!(
        lines[0]["actor"],
        json!({"user": "local-owner", "host": "rpc"})
    );
    assert_eq!(lines[0]["target"], "second");
    assert_eq!(
        lines[0]["detail"],
        json!({"previous": "member", "role": "admin"})
    );
    assert!(
        audit_text(&h).contains(r#""detail":{"previous":"member","role":"admin"}}"#),
        "the members in the order the TypeScript handler writes them"
    );
    let chained = chain_records(&h);
    assert_eq!(chained.len(), 1);
    assert_eq!(
        chained[0]["rec"], lines[0],
        "the chain's record is the line's event"
    );
    // `rightsChanged` and the learner's reconcile both follow every role change, even one to the same role.
    assert_eq!(legacy.asked(), told("second", true, true));
    h.native.user_role_set(&owner(), "second", "admin").unwrap();
    assert_eq!(legacy.asked(), told("second", true, true));
    assert_eq!(audit_lines(&h).len(), 2);
    assert_eq!(stored(&other, "second").2, version + 2);
}

#[test]
fn a_human_without_a_stored_role_gets_one_and_nobody_else_is_a_user() {
    let h = home();
    let legacy = Arc::new(Legacy::default());
    h.native.set_legacy(legacy.clone());
    // Without the identity store an id that has no role cannot be looked up: the catch-all, and nothing stored.
    assert_eq!(
        refused(h.native.user_role_set(&owner(), "nobody", "viewer")),
        (
            "E_STORAGE".to_owned(),
            None,
            "administrative storage unavailable".to_owned()
        )
    );
    let mut people = identity(&h);
    let actor = Actor {
        user: "local-owner".to_owned(),
        host: "rpc".to_owned(),
        kind: Some(PrincipalKind::Person),
        role: Some(Role::Owner),
        token_scopes: None,
    };
    let ada = people.create_human("Ada", &actor).unwrap().id;
    assert_eq!(
        refused(h.native.user_role_set(&owner(), "nobody", "viewer")),
        ("E_NOT_FOUND".to_owned(), None, "user not found".to_owned())
    );
    assert_eq!(
        refused(h.native.user_status(&owner(), true, "nobody", None)),
        ("E_NOT_FOUND".to_owned(), None, "user not found".to_owned())
    );
    assert!(audit_lines(&h).is_empty());
    assert!(legacy.asked().is_empty());
    assert_eq!(admin(&h).users().unwrap().len(), 1);

    h.native.user_role_set(&owner(), &ada, "operator").unwrap();
    assert_eq!(stored(&admin(&h), &ada), ("operator".to_owned(), false, 1));
    assert_eq!(
        audit_lines(&h)[0]["detail"],
        json!({"previous": "member", "role": "operator"}),
        "a human without a stored role was a Member"
    );
    assert_eq!(legacy.asked(), told(&ada, true, true));
}

#[test]
fn ownership_changes_only_as_the_typescript_handler_allows() {
    let (h, legacy, mut other) = running();
    // Nobody is promoted to Owner.
    assert_eq!(
        refused(h.native.user_role_set(&owner(), "second", "owner")),
        (
            "E_DENIED".to_owned(),
            Some("single-owner".to_owned()),
            "there is exactly one Owner; promotion to Owner is not possible".to_owned()
        )
    );
    // The last active Owner is not demoted: the store's own rule, inside its transaction.
    assert_eq!(
        refused(h.native.user_role_set(&owner(), "local-owner", "admin")),
        (
            "E_CONFLICT".to_owned(),
            Some("last-owner".to_owned()),
            "the last Owner cannot be demoted".to_owned()
        )
    );
    // An Owner's role set to Owner again is a change like any other (audited, version moved).
    h.native
        .user_role_set(&owner(), "local-owner", "owner")
        .unwrap();
    assert_eq!(legacy.asked(), told("local-owner", true, true));
    assert_eq!(audit_lines(&h).len(), 1);

    // An Admin changes roles below Owner and touches no Owner.
    set_role(&mut other, "boss", "owner");
    set_role(&mut other, "local-owner", "admin");
    for (target, role) in [("boss", "admin"), ("boss", "owner"), ("second", "owner")] {
        assert_eq!(
            refused(h.native.user_role_set(&owner(), target, role)),
            (
                "E_DENIED".to_owned(),
                Some("owner-only".to_owned()),
                "only an Owner may change ownership".to_owned()
            ),
            "{target} -> {role}"
        );
    }
    h.native
        .user_role_set(&owner(), "second", "viewer")
        .unwrap();
    assert_eq!(stored(&other, "second").0, "viewer");
    assert_eq!(stored(&other, "boss").0, "owner");
    assert_eq!(legacy.asked(), told("second", true, true));
    assert_eq!(
        audit_lines(&h).len(),
        2,
        "no refusal of the handler is audited"
    );
}

#[test]
fn the_state_another_process_stored_a_moment_ago_decides() {
    let (h, _legacy, mut other) = running();
    // Two Owners: either may be demoted, not both. The other process demotes one between two native calls.
    set_role(&mut other, "boss", "owner");
    set_role(&mut other, "boss", "admin");
    assert_eq!(
        code(h.native.user_role_set(&owner(), "local-owner", "admin")),
        ("E_CONFLICT".to_owned(), Some("last-owner".to_owned()))
    );
    set_role(&mut other, "boss", "owner");
    h.native.user_role_set(&owner(), "boss", "admin").unwrap();
    // A disabled Owner does not count as active: the last active one stays.
    set_role(&mut other, "boss", "owner");
    other
        .set_disabled("boss", true, "local-owner", 1, &mut || Ok(()))
        .unwrap();
    assert_eq!(
        code(h.native.user_role_set(&owner(), "local-owner", "admin")),
        ("E_CONFLICT".to_owned(), Some("last-owner".to_owned()))
    );
    assert_eq!(
        refused(h.native.user_status(&owner(), true, "local-owner", None)),
        (
            "E_CONFLICT".to_owned(),
            Some("last-owner".to_owned()),
            "the last active Owner cannot be disabled".to_owned()
        )
    );
}

#[test]
fn what_the_schema_lets_through_is_checked_again_as_in_typescript() {
    let (h, legacy, _other) = running();
    let long = "u".repeat(129);
    // 65 characters outside the BMP are 130 UTF-16 code units: the TypeScript handler counts those.
    let astral = "\u{1f600}".repeat(65);
    for id in [
        "a\u{1}b",
        "a\u{7f}",
        "a\nb",
        long.as_str(),
        astral.as_str(),
        "",
    ] {
        for refusal in [
            refused(h.native.user_role_set(&owner(), id, "viewer")),
            refused(h.native.user_status(&owner(), true, id, None)),
            refused(h.native.user_status(&owner(), false, id, None)),
        ] {
            assert_eq!(
                refusal,
                (
                    "E_INVALID_PARAMS".to_owned(),
                    None,
                    "invalid userId".to_owned()
                ),
                "{id:?}"
            );
        }
    }
    assert_eq!(
        refused(h.native.user_role_set(&owner(), "second", "king")),
        (
            "E_INVALID_PARAMS".to_owned(),
            None,
            "unknown role preset".to_owned()
        )
    );
    // 200 code points pass the schema; 101 of them outside the BMP are 202 code units.
    let reason = "\u{1f600}".repeat(101);
    assert_eq!(
        refused(
            h.native
                .user_status(&owner(), true, "second", Some(&reason))
        ),
        (
            "E_INVALID_PARAMS".to_owned(),
            None,
            "invalid reason".to_owned()
        )
    );
    assert!(h
        .native
        .user_status(&owner(), true, "second", Some(&"\u{1f600}".repeat(100)))
        .is_ok());
    assert_eq!(audit_lines(&h).len(), 1, "only the change is audited");
    assert_eq!(legacy.asked(), told("second", true, true));
}

#[test]
fn a_status_change_is_audited_by_hashes_and_told_only_when_it_is_one() {
    let (h, legacy, other) = running();
    let (_, _, version) = stored(&other, "second");
    // The reason loses control characters and the characters that reorder displayed text; the rest stays.
    let reason = "left\u{202e}evil\u{2066}\u{0}\u{9f}\u{61c}\u{200f} — ok\u{1f600}";
    let done = h
        .native
        .user_status(&owner(), true, "second", Some(reason))
        .unwrap();
    assert_eq!(done, json!({"userId": "second", "disabled": true}));
    assert_eq!(
        stored(&other, "second"),
        ("member".to_owned(), true, version + 1)
    );
    let row = other
        .users()
        .unwrap()
        .into_iter()
        .find(|u| u.id == "second")
        .unwrap();
    assert_eq!(row.disabled_by.as_deref(), Some("local-owner"));
    assert!(row.disabled_at.is_some());
    let lines = audit_lines(&h);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0]["action"], "user.disabled");
    assert_eq!(
        lines[0]["actor"],
        json!({"user": OWNER_HASH, "host": "rpc"})
    );
    assert_eq!(lines[0]["target"], SECOND_HASH);
    assert_eq!(
        lines[0]["detail"],
        json!({"role": "member", "reason": "leftevil — ok\u{1f600}"})
    );
    let text = audit_text(&h);
    assert!(
        text.contains(r#""detail":{"role":"member","reason":"#),
        "{text}"
    );
    assert!(!text.contains("local-owner") && !text.contains("second"));
    let chained = chain_records(&h);
    assert_eq!(chained.len(), 1);
    assert_eq!(chained[0]["rec"], lines[0]);
    assert_eq!(legacy.asked(), told("second", true, true));

    // Disabled again: nothing changes and nothing is audited, but the learner's reconcile follows every `user.disable`.
    h.native
        .user_status(&owner(), true, "second", None)
        .unwrap();
    assert_eq!(audit_lines(&h).len(), 1);
    assert_eq!(stored(&other, "second").2, version + 1);
    assert_eq!(legacy.asked(), told("second", false, true));

    // Enabled: audited without a reason, rights changed, no reconcile.
    let done = h
        .native
        .user_status(&owner(), false, "second", None)
        .unwrap();
    assert_eq!(done, json!({"userId": "second", "disabled": false}));
    let lines = audit_lines(&h);
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[1]["action"], "user.enabled");
    assert_eq!(lines[1]["detail"], json!({"role": "member"}));
    assert_eq!(
        stored(&other, "second"),
        ("member".to_owned(), false, version + 2)
    );
    assert_eq!(legacy.asked(), told("second", true, false));
    // Enabled again: nothing at all.
    h.native
        .user_status(&owner(), false, "second", None)
        .unwrap();
    assert_eq!(audit_lines(&h).len(), 2);
    assert!(legacy.asked().is_empty());

    // A reason that is nothing but removed characters is no reason.
    h.native
        .user_status(&owner(), true, "second", Some("\u{202e}\u{7}"))
        .unwrap();
    assert_eq!(audit_lines(&h)[2]["detail"], json!({"role": "member"}));
}

#[test]
fn a_human_without_a_stored_role_is_stored_as_a_member_before_its_status_changes() {
    let h = home();
    let legacy = Arc::new(Legacy::default());
    h.native.set_legacy(legacy.clone());
    let mut people = identity(&h);
    let actor = Actor {
        user: "local-owner".to_owned(),
        host: "rpc".to_owned(),
        kind: Some(PrincipalKind::Person),
        role: Some(Role::Owner),
        token_scopes: None,
    };
    let ada = people.create_human("Ada", &actor).unwrap().id;
    // Enabling someone who is not disabled still stores the default; nothing is audited or told.
    h.native.user_status(&owner(), false, &ada, None).unwrap();
    assert_eq!(stored(&admin(&h), &ada), ("member".to_owned(), false, 1));
    assert!(audit_lines(&h).is_empty());
    assert!(legacy.asked().is_empty());
    h.native.user_status(&owner(), true, &ada, None).unwrap();
    assert_eq!(stored(&admin(&h), &ada), ("member".to_owned(), true, 2));
    assert_eq!(audit_lines(&h)[0]["detail"], json!({"role": "member"}));
    assert_eq!(legacy.asked(), told(&ada, true, true));
}

#[test]
fn an_admin_changes_the_status_of_members_and_viewers_only() {
    let (h, legacy, mut other) = running();
    set_role(&mut other, "boss", "owner");
    set_role(&mut other, "local-owner", "admin");
    for role in ["owner", "admin", "operator"] {
        set_role(&mut other, "peer", role);
        for disabled in [true, false] {
            assert_eq!(
                refused(h.native.user_status(&owner(), disabled, "peer", None)),
                (
                    "E_DENIED".to_owned(),
                    None,
                    "person status change denied".to_owned()
                ),
                "{role} {disabled}"
            );
        }
    }
    assert!(audit_lines(&h).is_empty());
    assert!(legacy.asked().is_empty());
    for role in ["member", "viewer"] {
        set_role(&mut other, "peer", role);
        h.native.user_status(&owner(), true, "peer", None).unwrap();
        h.native.user_status(&owner(), false, "peer", None).unwrap();
    }
    assert_eq!(audit_lines(&h).len(), 4);
    // An Owner changes anyone's, another Owner's included (the store keeps one active).
    set_role(&mut other, "local-owner", "owner");
    h.native.user_status(&owner(), true, "boss", None).unwrap();
    assert_eq!(stored(&other, "boss"), ("owner".to_owned(), true, 2));
}

#[test]
fn a_caller_below_admin_meets_the_guard_and_changes_nothing() {
    let (h, legacy, mut other) = running();
    set_role(&mut other, "boss", "owner");
    for role in ["operator", "member", "viewer"] {
        set_role(&mut other, "local-owner", role);
        for refusal in [
            code(h.native.user_role_set(&owner(), "second", "viewer")),
            code(h.native.user_status(&owner(), true, "second", None)),
            code(h.native.user_status(&owner(), false, "second", None)),
        ] {
            assert_eq!(
                refusal,
                ("E_DENIED".to_owned(), Some("role-denied".to_owned())),
                "{role}"
            );
        }
    }
    assert_eq!(stored(&other, "second"), ("member".to_owned(), false, 1));
    assert!(legacy.asked().is_empty());
    let lines = audit_lines(&h);
    assert_eq!(lines.len(), 9, "every denial of the guard is audited");
    assert!(lines.iter().all(|l| l["action"] == "rbac.denied"));
    // A disabled caller is nobody.
    set_role(&mut other, "local-owner", "admin");
    other
        .set_disabled("local-owner", true, "boss", 1, &mut || Ok(()))
        .unwrap();
    assert_eq!(
        code(h.native.user_role_set(&owner(), "second", "viewer")),
        ("E_UNAUTHORIZED".to_owned(), Some("no-principal".to_owned()))
    );
    assert_eq!(stored(&other, "second"), ("member".to_owned(), false, 1));
}

#[test]
fn a_change_that_cannot_be_audited_does_not_happen() {
    let failed = (
        "E_STORAGE".to_owned(),
        Some("audit-failed".to_owned()),
        "administrative action cannot be audited".to_owned(),
    );
    // Neither place can be written.
    let (h, legacy, other) = running();
    std::fs::write(h.dir.path().join("logs"), "a file").unwrap();
    assert_eq!(
        refused(h.native.user_role_set(&owner(), "second", "admin")),
        failed
    );
    assert_eq!(
        refused(h.native.user_status(&owner(), true, "second", None)),
        failed
    );
    assert_eq!(stored(&other, "second"), ("member".to_owned(), false, 1));
    assert!(
        legacy.asked().is_empty(),
        "nothing changed, nothing to tell"
    );

    // One of the two places fails: the event is not recorded, so the change does not happen either. Both are tried.
    let (h, legacy, other) = running();
    std::fs::create_dir_all(h.dir.path().join("logs/audit.log")).unwrap();
    assert_eq!(
        refused(h.native.user_role_set(&owner(), "second", "admin")),
        failed
    );
    assert_eq!(chain_records(&h).len(), 1, "the chain was still tried");
    assert_eq!(stored(&other, "second"), ("member".to_owned(), false, 1));
    let (h2, legacy2, other2) = running();
    std::fs::create_dir_all(h2.dir.path().join("logs").join(chain::ACTIVE)).unwrap();
    assert_eq!(
        refused(h2.native.user_status(&owner(), true, "second", None)),
        failed
    );
    assert_eq!(audit_lines(&h2).len(), 1, "the line was still tried");
    assert_eq!(stored(&other2, "second"), ("member".to_owned(), false, 1));
    assert!(legacy.asked().is_empty() && legacy2.asked().is_empty());

    // A status that does not change needs no audit event and is no failure.
    assert!(h2
        .native
        .user_status(&owner(), false, "second", None)
        .is_ok());
}

#[test]
fn nothing_is_stored_once_the_legacy_core_cannot_be_reached() {
    let stopping = (
        "E_NOT_AVAILABLE".to_owned(),
        Some("stopping".to_owned()),
        "core is stopping".to_owned(),
    );
    let attempts = |h: &Home| {
        [
            refused(h.native.user_role_set(&owner(), "second", "admin")),
            refused(h.native.user_status(&owner(), true, "second", None)),
            refused(h.native.user_status(&owner(), false, "second", None)),
        ]
    };
    // The control link has ended.
    let (h, legacy, mut other) = running();
    legacy.unreachable.store(true, Ordering::SeqCst);
    for refusal in attempts(&h) {
        assert_eq!(refusal, stopping);
    }
    assert_eq!(stored(&other, "second"), ("member".to_owned(), false, 1));
    assert!(audit_lines(&h).is_empty());
    assert!(legacy.asked().is_empty());
    // The guard still comes first: a caller who may not write learns that, and it is audited.
    set_role(&mut other, "boss", "owner");
    set_role(&mut other, "local-owner", "viewer");
    assert_eq!(attempts(&h)[0].1.as_deref(), Some("role-denied"));
    assert_eq!(audit_lines(&h).len(), 3);

    // A front door whose control link was never set (no production path) refuses the same way.
    let h = home();
    drop(identity(&h));
    set_role(&mut admin(&h), "second", "member");
    for refusal in attempts(&h) {
        assert_eq!(refusal, stopping);
    }
    assert_eq!(
        stored(&admin(&h), "second"),
        ("member".to_owned(), false, 1)
    );
    // The methods that only read do not need the legacy core.
    assert!(h.native.breakglass_notices(&owner()).is_ok());
}

#[test]
fn a_change_stands_when_the_legacy_core_does_not_answer() {
    let (h, legacy, other) = running();
    legacy.failing.store(true, Ordering::SeqCst);
    assert_eq!(
        h.native
            .user_role_set(&owner(), "second", "viewer")
            .unwrap(),
        json!({"userId": "second", "role": "viewer"})
    );
    assert_eq!(
        h.native
            .user_status(&owner(), true, "second", None)
            .unwrap(),
        json!({"userId": "second", "disabled": true})
    );
    assert_eq!(stored(&other, "second"), ("viewer".to_owned(), true, 3));
    assert_eq!(audit_lines(&h).len(), 2);
    assert_eq!(
        legacy.asked(),
        vec![
            ("second".to_owned(), true, true),
            ("second".to_owned(), true, true)
        ]
    );
}

#[test]
fn a_store_the_legacy_core_never_created_is_not_created_by_a_write() {
    let h = bare();
    h.native.set_legacy(Arc::new(Legacy::default()));
    // Without the store the guard has nobody to serve (flip A1); nothing appears on disk.
    assert_eq!(
        code(h.native.user_role_set(&owner(), "second", "admin")),
        (
            "E_UNAUTHORIZED".to_owned(),
            Some("resolver-failed".to_owned())
        )
    );
    assert!(!h.dir.path().join("state/admin.sqlite").exists());
    assert!(!h.dir.path().join("state/identity.sqlite").exists());
}

#[test]
fn the_helpers_follow_the_javascript_they_port() {
    assert_eq!(hashed("local-owner"), OWNER_HASH);
    assert_eq!(hashed("second"), SECOND_HASH);
    assert_eq!(js_length("a\u{1f600}"), 3);
    assert_eq!(js_length("äö"), 2);
    assert!(admin_text(&"u".repeat(128), "userId").is_ok());
    assert!(
        admin_text("a b\u{a0}\u{80}", "userId").is_ok(),
        "only C0 and DEL"
    );
    // Every character the TypeScript expression removes, and its neighbours stay.
    let removed: Vec<char> = ('\u{0}'..='\u{1f}')
        .chain('\u{7f}'..='\u{9f}')
        .chain(['\u{61c}', '\u{200e}', '\u{200f}'])
        .chain('\u{202a}'..='\u{202e}')
        .chain('\u{2066}'..='\u{2069}')
        .collect();
    assert_eq!(audited_reason(&removed.iter().collect::<String>()), "");
    let kept = " ~\u{a0}\u{61b}\u{61d}\u{200d}\u{2010}\u{2029}\u{202f}\u{2065}\u{206a}";
    assert_eq!(audited_reason(kept), kept);
}

/// Lets another process (its own connection to the store) write between the next write methods' own reads and their
/// write transactions.
fn between(h: &Home, mut other: impl FnMut(&mut AdminStore) + Send + 'static) {
    let path = h.dir.path().join("state/admin.sqlite");
    *h.native.window.lock().unwrap() = Some(Box::new(move || {
        let mut store = AdminStore::open(&path, "local-owner", &secure).unwrap();
        other(&mut store);
    }));
}

fn undisturbed(h: &Home) {
    *h.native.window.lock().unwrap() = None;
}

#[test]
fn a_role_the_other_process_changed_in_between_is_judged_and_audited_as_the_transaction_finds_it() {
    // An Admin sets a Member's role; the other process makes that Member an Owner first. Ownership is not an Admin's
    // to change: refused under the write lock, nothing stored, nothing audited.
    let (h, legacy, mut other) = running();
    set_role(&mut other, "boss", "owner");
    set_role(&mut other, "local-owner", "admin");
    between(&h, |store| set_role(store, "second", "owner"));
    assert_eq!(
        refused(h.native.user_role_set(&owner(), "second", "viewer")),
        (
            "E_DENIED".to_owned(),
            Some("owner-only".to_owned()),
            "only an Owner may change ownership".to_owned()
        )
    );
    assert_eq!(stored(&other, "second").0, "owner");
    assert!(audit_lines(&h).is_empty());
    assert!(legacy.asked().is_empty());

    // The audit event names the role the change replaced, not the one read a moment earlier.
    let (h, legacy, other) = running();
    between(&h, |store| set_role(store, "second", "operator"));
    h.native.user_role_set(&owner(), "second", "admin").unwrap();
    assert_eq!(
        audit_lines(&h)[0]["detail"],
        json!({"previous": "operator", "role": "admin"})
    );
    assert_eq!(stored(&other, "second").0, "admin");
    assert_eq!(legacy.asked(), told("second", true, true));
    // And a promotion that became one in between is none: the other process demoted the Owner the call re-affirms.
    undisturbed(&h);
    set_role(&mut admin(&h), "boss", "owner");
    between(&h, |store| set_role(store, "boss", "admin"));
    assert_eq!(
        code(h.native.user_role_set(&owner(), "boss", "owner")),
        ("E_DENIED".to_owned(), Some("single-owner".to_owned()))
    );
    assert_eq!(stored(&other, "boss").0, "admin");
    assert_eq!(audit_lines(&h).len(), 1);
}

#[test]
fn a_status_the_other_process_changed_in_between_is_judged_and_audited_as_the_transaction_finds_it()
{
    // An Admin disables a Member; the other process makes that Member an Admin first.
    let (h, legacy, mut other) = running();
    set_role(&mut other, "boss", "owner");
    set_role(&mut other, "local-owner", "admin");
    between(&h, |store| set_role(store, "second", "admin"));
    assert_eq!(
        refused(h.native.user_status(&owner(), true, "second", None)),
        (
            "E_DENIED".to_owned(),
            None,
            "person status change denied".to_owned()
        )
    );
    assert_eq!(stored(&other, "second"), ("admin".to_owned(), false, 2));
    assert!(audit_lines(&h).is_empty());
    assert!(legacy.asked().is_empty());

    // The other process disabled the person first: this call changes nothing, audits nothing and reports no change of
    // rights (the other process told the API services of its own change).
    let (h, legacy, other) = running();
    between(&h, |store| {
        store
            .set_disabled("second", true, "boss", 1, &mut || Ok(()))
            .unwrap();
    });
    assert_eq!(
        h.native
            .user_status(&owner(), true, "second", None)
            .unwrap(),
        json!({"userId": "second", "disabled": true})
    );
    assert!(audit_lines(&h).is_empty());
    assert_eq!(stored(&other, "second"), ("member".to_owned(), true, 2));
    assert_eq!(legacy.asked(), told("second", false, true));

    // The role in the event is the one the transaction read.
    let (h, _legacy, _other) = running();
    between(&h, |store| set_role(store, "second", "viewer"));
    h.native
        .user_status(&owner(), true, "second", None)
        .unwrap();
    assert_eq!(audit_lines(&h)[0]["detail"], json!({"role": "viewer"}));
}

#[test]
fn the_checked_store_writes_hand_their_hook_the_row_under_the_write_lock() {
    let (h, _legacy, _other) = running();
    let mut store = admin(&h);
    let mut seen = Vec::new();
    store
        .set_role_checked("second", "viewer", &mut |previous| {
            seen.push(previous);
            Ok(())
        })
        .unwrap();
    // A person without a stored role was a Member; a hook that refuses leaves the row as it was.
    let refused = store.set_role_checked("nobody-yet", "admin", &mut |previous| {
        seen.push(previous);
        Err(AdminError::Hook("no".to_owned()))
    });
    assert!(matches!(refused, Err(AdminError::Hook(_))));
    assert_eq!(seen, [Role::Member, Role::Member]);
    assert!(store.person("nobody-yet").unwrap().is_none());
    assert_eq!(stored(&store, "second").0, "viewer");

    let mut rows = Vec::new();
    let changed = store
        .set_disabled_checked("second", true, "boss", 7, &mut |person| {
            rows.push((person.principal.role, person.disabled));
            Ok(())
        })
        .unwrap();
    assert!(changed);
    // No change, no hook; a refusing hook, no change.
    let again = store
        .set_disabled_checked("second", true, "boss", 8, &mut |_| {
            panic!("no change to audit")
        })
        .unwrap();
    assert!(!again);
    let refused = store.set_disabled_checked("second", false, "boss", 9, &mut |person| {
        rows.push((person.principal.role, person.disabled));
        Err(AdminError::Hook("no".to_owned()))
    });
    assert!(matches!(refused, Err(AdminError::Hook(_))));
    assert_eq!(rows, [(Role::Viewer, false), (Role::Viewer, true)]);
    assert_eq!(stored(&store, "second"), ("viewer".to_owned(), true, 3));
}
