//! The guard and the methods of the native set on a real home: who is served, what a refusal leaves in the audit log
//! and the chain, and what the two methods of flip A1 answer.
#![allow(clippy::unwrap_used)]
use super::*;
use crate::identity::admin_store::StoredNotice;
use crate::identity::codes::RandomSource;
use crate::identity::service::Actor;
use crate::identity::service_impl::{
    AuditEvent as IdentityEvent, IdentityOptions, IdentityService,
};
use crate::route::Transport;
use std::time::Instant;

pub(super) struct Home {
    pub(super) dir: tempfile::TempDir,
    pub(super) native: Native,
}

/// A home the legacy core has started in: `state/admin.sqlite` exists, seeded with the local owner.
pub(super) fn home() -> Home {
    let h = bare();
    drop(admin(&h));
    h
}

/// A home nothing has started in.
pub(super) fn bare() -> Home {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let native = Native::new(dir.path());
    Home { dir, native }
}

pub(super) fn owner() -> route::Principal {
    route::Principal::LocalOwner {
        transport: Transport::Ipc,
    }
}

/// `state/admin.sqlite` of the home, as another process (the legacy core) holds it.
pub(super) fn admin(home: &Home) -> AdminStore {
    AdminStore::open(
        &home.dir.path().join("state/admin.sqlite"),
        "local-owner",
        &secure,
    )
    .unwrap()
}

pub(super) fn set_role(store: &mut AdminStore, id: &str, role: &str) {
    store.set_role(id, role, &mut || Ok(())).unwrap();
}

/// What a refusal says: code, reason, message.
pub(super) fn refused<T: std::fmt::Debug>(
    r: Result<T, MethodError>,
) -> (String, Option<String>, String) {
    match r {
        Err(MethodError::Rpc(f)) => (f.error.to_string(), f.reason.clone(), f.message.clone()),
        other => panic!("not a refusal: {other:?}"),
    }
}

pub(super) fn audit_lines(home: &Home) -> Vec<Value> {
    std::fs::read_to_string(home.dir.path().join("logs/audit.log"))
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

pub(super) fn chain_records(home: &Home) -> Vec<Value> {
    std::fs::read_to_string(home.dir.path().join("logs").join(chain::ACTIVE))
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .collect()
}

#[test]
fn the_local_owner_is_served_as_the_person_stored_for_it() {
    let h = home();
    let p = h
        .native
        .authorize(&owner(), "breakglass.notices", None)
        .unwrap();
    assert_eq!(p.user_id, "local-owner");
    assert_eq!(p.role, Role::Owner);
    assert_eq!(p.kind, Some(PrincipalKind::Person));
    // An allowed call leaves no audit event.
    assert_eq!(admin(&h).users().unwrap().len(), 1);
    assert!(audit_lines(&h).is_empty());
    assert!(!h.dir.path().join("logs").exists());

    // The role is read for every call: what another process stored a moment ago decides.
    let mut other = admin(&h);
    set_role(&mut other, "second", "owner");
    set_role(&mut other, "local-owner", "viewer");
    let p = h
        .native
        .authorize(&owner(), "breakglass.notices", None)
        .unwrap();
    assert_eq!(p.role, Role::Viewer);
}

#[test]
fn a_demoted_local_owner_is_denied_and_the_denial_is_in_the_audit_log_and_the_chain() {
    let h = home();
    let mut other = admin(&h);
    set_role(&mut other, "second", "owner");
    set_role(&mut other, "local-owner", "viewer");
    // The guard is the same for every method with a rule; the two native methods are open to every human role.
    let denied = h.native.authorize(&owner(), "user.role.set", None);
    assert_eq!(
        refused(denied),
        (
            "E_DENIED".to_owned(),
            Some("role-denied".to_owned()),
            "not permitted: admin.users.write".to_owned()
        )
    );
    let again = h.native.authorize(
        &owner(),
        "agent.rights.set",
        Some(&json!({"agentId": "bernd"})),
    );
    assert_eq!(refused(again).0, "E_DENIED");

    let lines = audit_lines(&h);
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert_eq!(lines[0]["action"], "rbac.denied");
    assert_eq!(
        lines[0]["actor"],
        json!({"user": "local-owner", "host": "local"})
    );
    assert_eq!(lines[0]["target"], "user.role.set");
    assert_eq!(
        lines[0]["detail"],
        json!({"action": "admin.users.write", "reason": "role-denied", "role": "viewer"})
    );
    assert_eq!(lines[1]["target"], "agent.rights.set");
    // The same two events are the chain's first two records, linked, with the anchor on the second.
    let chained = chain_records(&h);
    assert_eq!(chained.len(), 2, "{chained:?}");
    for (record, line) in chained.iter().zip(&lines) {
        assert_eq!(&record["rec"], line);
    }
    assert_eq!(chained[0]["seq"], 1);
    assert_eq!(chained[0]["prev"], chain::GENESIS);
    assert_eq!(chained[1]["seq"], 2);
    let anchor: Value = serde_json::from_str(
        &std::fs::read_to_string(h.dir.path().join("logs").join(chain::ANCHOR)).unwrap(),
    )
    .unwrap();
    assert_eq!(anchor["seq"], 2);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |name: &str| {
            std::fs::metadata(h.dir.path().join("logs").join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777
        };
        assert_eq!(mode("audit.log"), 0o600);
        assert_eq!(mode(chain::ACTIVE), 0o600);
    }
}

#[test]
fn a_disabled_local_owner_is_nobody() {
    let h = home();
    let mut other = admin(&h);
    set_role(&mut other, "second", "owner");
    other
        .set_disabled("local-owner", true, "second", 1, &mut || Ok(()))
        .unwrap();
    for method in ["breakglass.notices", "identity.principals"] {
        assert_eq!(
            refused(h.native.authorize(&owner(), method, None)),
            (
                "E_UNAUTHORIZED".to_owned(),
                Some("no-principal".to_owned()),
                "authentication required".to_owned()
            ),
            "{method}"
        );
    }
    assert_eq!(
        refused(h.native.breakglass_notices(&owner())).0,
        "E_UNAUTHORIZED"
    );
    assert_eq!(
        refused(h.native.identity_principals(&owner(), None)).0,
        "E_UNAUTHORIZED"
    );
    let lines = audit_lines(&h);
    assert_eq!(lines.len(), 4);
    assert_eq!(lines[0]["action"], "rbac.unauthenticated");
    assert_eq!(
        lines[0]["actor"],
        json!({"user": "anonymous", "host": "local"})
    );
    assert_eq!(
        lines[0]["detail"],
        json!({"action": "admin.notices.read", "reason": "no-principal"})
    );
    // Enabled again by the other process, served again.
    other
        .set_disabled("local-owner", false, "second", 2, &mut || Ok(()))
        .unwrap();
    assert!(h
        .native
        .authorize(&owner(), "breakglass.notices", None)
        .is_ok());
}

#[test]
fn a_store_that_is_missing_or_cannot_be_read_is_a_failed_resolver_never_an_owner() {
    let failed = (
        "E_UNAUTHORIZED".to_owned(),
        Some("resolver-failed".to_owned()),
        "authentication required".to_owned(),
    );
    // The legacy core has not created the store: nobody is served, and nothing is created here. A store created
    // here would be seeded with the local owner as Owner, whatever the installation had stored before.
    let h = bare();
    assert_eq!(
        refused(h.native.authorize(&owner(), "breakglass.notices", None)),
        failed
    );
    assert!(!h.dir.path().join("state").exists());
    assert_eq!(audit_lines(&h)[0]["detail"]["reason"], "resolver-failed");
    assert_eq!(
        refused(h.native.breakglass_notices(&owner())).0,
        "E_UNAUTHORIZED"
    );
    // Once the legacy core has created it, the next call is served: a failed open is not remembered.
    drop(admin(&h));
    assert!(h
        .native
        .authorize(&owner(), "breakglass.notices", None)
        .is_ok());

    // A store that exists but is not what the legacy core leaves behind: an empty file, a database without the role
    // table, a role table without a person. Opening them the owner's way would create what is missing and seed the
    // local owner as Owner; here they are refused and left exactly as they were.
    let h = bare();
    let state = h.dir.path().join("state");
    std::fs::create_dir_all(&state).unwrap();
    std::fs::write(state.join("admin.sqlite"), "").unwrap();
    assert_eq!(
        refused(h.native.authorize(&owner(), "breakglass.notices", None)),
        failed,
        "an empty file"
    );
    assert_eq!(
        std::fs::metadata(state.join("admin.sqlite")).unwrap().len(),
        0
    );
    let h = home();
    let emptied = admin(&h);
    emptied
        .conn()
        .execute("DELETE FROM admin_roles", [])
        .unwrap();
    assert_eq!(
        refused(h.native.authorize(&owner(), "breakglass.notices", None)),
        failed,
        "no person"
    );
    let people: i64 = emptied
        .conn()
        .query_row("SELECT COUNT(*) FROM admin_roles", [], |row| row.get(0))
        .unwrap();
    assert_eq!(people, 0, "nobody was seeded");
    emptied
        .conn()
        .execute_batch("DROP TABLE admin_roles")
        .unwrap();
    assert_eq!(
        refused(h.native.authorize(&owner(), "breakglass.notices", None)),
        failed,
        "no role table"
    );
    let tables: i64 = emptied
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='admin_roles'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tables, 0, "no table was created");

    // A file that is no database, or a directory in the store's place: refused.
    for broken in ["garbage", "directory"] {
        let h = bare();
        let state = h.dir.path().join("state");
        std::fs::create_dir_all(&state).unwrap();
        if broken == "garbage" {
            std::fs::write(state.join("admin.sqlite"), "not a database, not at all").unwrap();
        } else {
            std::fs::create_dir(state.join("admin.sqlite")).unwrap();
        }
        assert_eq!(
            refused(h.native.authorize(&owner(), "breakglass.notices", None)),
            failed,
            "{broken}"
        );
    }
}

#[cfg(unix)]
#[test]
fn a_link_in_place_of_the_store_is_not_followed() {
    let elsewhere = home();
    let h = bare();
    let state = h.dir.path().join("state");
    std::fs::create_dir_all(&state).unwrap();
    std::os::unix::fs::symlink(
        elsewhere.dir.path().join("state/admin.sqlite"),
        state.join("admin.sqlite"),
    )
    .unwrap();
    assert_eq!(
        refused(h.native.authorize(&owner(), "breakglass.notices", None)).1,
        Some("resolver-failed".to_owned())
    );
    // The same for the identity store: a link to a real one elsewhere is no identity service.
    let h = home();
    drop(identity(&elsewhere));
    std::os::unix::fs::symlink(
        elsewhere.dir.path().join("state/identity.sqlite"),
        h.dir.path().join("state/identity.sqlite"),
    )
    .unwrap();
    assert_eq!(
        refused(h.native.identity_principals(&owner(), None)),
        (
            "E_NOT_AVAILABLE".to_owned(),
            None,
            "identity unavailable".to_owned()
        )
    );
}

#[test]
fn a_store_the_other_process_holds_locked_is_waited_for_and_then_a_failed_resolver() {
    let h = home();
    assert!(h
        .native
        .authorize(&owner(), "breakglass.notices", None)
        .is_ok());
    // The legacy core inside a write it does not finish: an exclusive lock on the rollback-journal store.
    let other = admin(&h);
    other.conn().execute_batch("BEGIN EXCLUSIVE").unwrap();
    let started = Instant::now();
    assert_eq!(
        refused(h.native.authorize(&owner(), "breakglass.notices", None)),
        (
            "E_UNAUTHORIZED".to_owned(),
            Some("resolver-failed".to_owned()),
            "authentication required".to_owned()
        ),
        "busy is a failed resolver, never an owner"
    );
    assert!(
        started.elapsed() >= Duration::from_secs(4),
        "the store's busy timeout was waited: {:?}",
        started.elapsed()
    );
    other.conn().execute_batch("COMMIT").unwrap();
    assert!(h
        .native
        .authorize(&owner(), "breakglass.notices", None)
        .is_ok());
}

#[test]
fn an_audit_sink_that_fails_changes_no_outcome_and_does_not_stop_the_other_sink() {
    let demoted = || {
        let h = home();
        let mut other = admin(&h);
        set_role(&mut other, "second", "owner");
        set_role(&mut other, "local-owner", "viewer");
        h
    };
    let denied = |h: &Home| {
        assert_eq!(
            refused(h.native.authorize(&owner(), "user.role.set", None)).0,
            "E_DENIED"
        );
        assert!(h
            .native
            .authorize(&owner(), "breakglass.notices", None)
            .is_ok());
    };
    // Neither place can be written.
    let h = demoted();
    std::fs::write(h.dir.path().join("logs"), "a file").unwrap();
    denied(&h);
    // The log line cannot be written: the chain still gets its record.
    let h = demoted();
    std::fs::create_dir_all(h.dir.path().join("logs/audit.log")).unwrap();
    denied(&h);
    assert_eq!(chain_records(&h).len(), 1);
    // The chain cannot take the record (its file is a directory): the log line is still written.
    let h = demoted();
    std::fs::create_dir_all(h.dir.path().join("logs").join(chain::ACTIVE)).unwrap();
    denied(&h);
    assert_eq!(audit_lines(&h).len(), 1);
}

#[test]
fn no_other_caller_and_no_method_without_a_rule_is_served() {
    let h = home();
    for who in [
        route::Principal::Api {
            principal: None,
            transport: Transport::Api(None),
        },
        route::Principal::Module {
            transport: Transport::Ipc,
        },
        route::Principal::Engine {
            transport: Transport::Ipc,
        },
    ] {
        assert_eq!(
            refused(h.native.authorize(&who, "breakglass.notices", None)),
            (
                "E_INTERNAL".to_owned(),
                Some("route-table-drift".to_owned()),
                "route table drift".to_owned()
            ),
            "{who:?}"
        );
        assert_eq!(refused(h.native.breakglass_notices(&who)).0, "E_INTERNAL");
        assert_eq!(
            refused(h.native.identity_principals(&who, None)).0,
            "E_INTERNAL"
        );
    }
    // No audit event was written for them: the guard never ran.
    assert!(audit_lines(&h).is_empty());
    // `user.invite.redeem` has no rule (it is reachable before a principal exists): never through this guard.
    assert!(guard::rule_for("user.invite.redeem").is_none());
    assert_eq!(
        refused(h.native.authorize(&owner(), "user.invite.redeem", None)).0,
        "E_INTERNAL"
    );
    // Every native method has a rule, but for the five `secret.*` methods neither RBAC table has one for: those hand
    // the store a principal and the store's own gate decides (`native_secrets.rs`, flip B2).
    for method in route::NATIVE {
        let gated_by_the_store = [
            "secret.delete",
            "secret.get",
            "secret.list",
            "secret.set",
            "secret.status",
        ]
        .contains(method);
        assert_eq!(
            guard::rule_for(method).is_some(),
            !gated_by_the_store,
            "{method}"
        );
    }
}

fn notice(user: &str, grant: &str) -> StoredNotice {
    StoredNotice {
        user_id: user.to_owned(),
        grant_id: grant.to_owned(),
        holder_user_id: "second".to_owned(),
        reason: "an incident".to_owned(),
        expires_at: 1_800_000_000_000,
    }
}

#[test]
fn breakglass_notices_are_the_callers_own_newest_first() {
    let h = home();
    assert_eq!(
        h.native.breakglass_notices(&owner()).unwrap(),
        json!({"notices": []})
    );
    // The legacy core writes the notices (`breakglass.request`); this reads what it stored.
    let mut other = admin(&h);
    other.notice(&notice("local-owner", "g1")).unwrap();
    other.notice(&notice("someone-else", "g2")).unwrap();
    other.notice(&notice("local-owner", "g3")).unwrap();
    let out = h.native.breakglass_notices(&owner()).unwrap();
    assert_eq!(
        out,
        json!({"notices": [notice("local-owner", "g3").to_json(), notice("local-owner", "g1").to_json()]})
    );
    // Every human role may read its own notices.
    set_role(&mut other, "second", "owner");
    set_role(&mut other, "local-owner", "viewer");
    assert_eq!(h.native.breakglass_notices(&owner()).unwrap(), out);
    // A stored payload that is not JSON is a storage failure, as the TypeScript handler's `JSON.parse` throw is.
    other
        .conn()
        .execute(
            "INSERT INTO admin_notices VALUES ('g4','local-owner','{ not json')",
            [],
        )
        .unwrap();
    assert_eq!(
        refused(h.native.breakglass_notices(&owner())),
        (
            "E_STORAGE".to_owned(),
            None,
            "administrative storage unavailable".to_owned()
        )
    );
}

struct Counter(u8);
impl RandomSource for Counter {
    fn random_int(&mut self, _: u32) -> u32 {
        0
    }
    fn fill_bytes(&mut self, out: &mut [u8]) {
        for b in out {
            self.0 = self.0.wrapping_add(1);
            *b = self.0;
        }
    }
}

/// The identity service as the legacy core holds it (it writes; the front door's own only reads).
pub(super) fn identity(home: &Home) -> IdentityService {
    IdentityService::create(IdentityOptions {
        db_path: home.dir.path().join("state/identity.sqlite"),
        clock: Box::new(|| 1_700_000_000_000),
        audit: Box::new(|_: &IdentityEvent| Ok(())),
        random: Box::new(Counter(0)),
        secure_path: Box::new(secure),
        authorize: None,
        code_ttl_ms: None,
    })
    .unwrap()
}

#[test]
fn identity_principals_are_the_callers_own_or_anyones_for_an_owner_or_admin() {
    let h = home();
    // Without the identity store the legacy core creates there is no identity service, and none is created here.
    assert_eq!(
        refused(h.native.identity_principals(&owner(), None)),
        (
            "E_NOT_AVAILABLE".to_owned(),
            None,
            "identity unavailable".to_owned()
        )
    );
    assert!(!h.dir.path().join("state/identity.sqlite").exists());
    let mut legacy = identity(&h);
    // The local owner has no human record: asking for itself is the TypeScript core's `not-found`.
    assert_eq!(
        refused(h.native.identity_principals(&owner(), None)),
        (
            "E_NOT_FOUND".to_owned(),
            None,
            "unknown harness principal".to_owned()
        )
    );
    let actor = Actor {
        user: "local-owner".to_owned(),
        host: "rpc".to_owned(),
        kind: Some(PrincipalKind::Person),
        role: Some(Role::Owner),
        token_scopes: None,
    };
    let human = legacy.create_human("Ada", &actor).unwrap();
    let v2 = derive_user_principal(&human.id).unwrap();
    assert_eq!(
        h.native
            .identity_principals(&owner(), Some(&human.id))
            .unwrap(),
        json!({"humanId": human.id, "principals": [v2]})
    );
    assert_eq!(
        refused(h.native.identity_principals(&owner(), Some("nobody"))).0,
        "E_NOT_FOUND"
    );
    // An id the derivation refuses (the schema refuses it first on the wire): `invalid-params`, which names no field.
    assert_eq!(
        refused(h.native.identity_principals(&owner(), Some("a\u{1}b"))),
        (
            "E_INVALID_PARAMS".to_owned(),
            None,
            "invalid harness user id".to_owned()
        )
    );
    // An Admin may ask about anyone; below that, only about oneself.
    let mut other = admin(&h);
    set_role(&mut other, "second", "owner");
    set_role(&mut other, "local-owner", "admin");
    assert!(h
        .native
        .identity_principals(&owner(), Some(&human.id))
        .is_ok());
    for role in ["operator", "member", "viewer"] {
        set_role(&mut other, "local-owner", role);
        assert_eq!(
            refused(h.native.identity_principals(&owner(), Some(&human.id))),
            (
                "E_DENIED".to_owned(),
                None,
                "self identities only".to_owned()
            ),
            "{role}"
        );
        assert_eq!(
            refused(h.native.identity_principals(&owner(), Some("local-owner"))).0,
            "E_NOT_FOUND",
            "{role}: its own id is no other's"
        );
    }
    // The front door's service only reads: nothing it did reached an audit sink, and no audit event was written.
    assert!(audit_lines(&h).is_empty());
}

#[test]
fn the_identity_store_is_read_only_from_here_and_its_failures_are_fixed_texts() {
    let h = home();
    let mut legacy = identity(&h);
    let actor = Actor {
        user: "local-owner".to_owned(),
        host: "rpc".to_owned(),
        kind: Some(PrincipalKind::Person),
        role: Some(Role::Owner),
        token_scopes: None,
    };
    let human = legacy.create_human("Ada", &actor).unwrap();
    // A read while the legacy core holds a write transaction open (WAL): answered from the last commit, not blocked.
    legacy.conn().execute_batch("BEGIN IMMEDIATE").unwrap();
    let started = Instant::now();
    assert!(h
        .native
        .identity_principals(&owner(), Some(&human.id))
        .is_ok());
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    legacy.conn().execute_batch("ROLLBACK").unwrap();
    // The connection the front door opens cannot write.
    let conn = h.native.identity().unwrap();
    assert!(conn.execute("DELETE FROM attempts", []).is_err());
    drop((conn, legacy));
    // A directory or garbage in the store's place: fixed texts, no path, nothing created.
    let h = home();
    std::fs::create_dir_all(h.dir.path().join("state/identity.sqlite")).unwrap();
    assert_eq!(
        refused(h.native.identity_principals(&owner(), Some("local-owner"))),
        (
            "E_NOT_AVAILABLE".to_owned(),
            None,
            "identity unavailable".to_owned()
        )
    );
    let h = home();
    std::fs::write(
        h.dir.path().join("state/identity.sqlite"),
        "not a database, not at all",
    )
    .unwrap();
    assert_eq!(
        refused(h.native.identity_principals(&owner(), Some("local-owner"))),
        (
            "E_STORAGE".to_owned(),
            None,
            "surface storage unavailable".to_owned()
        )
    );
}

#[test]
fn the_identity_refusals_map_as_map_identity_error_maps_them() {
    let of = |code, field: Option<&str>, retry: Option<i64>| {
        let e = IdentityError {
            code,
            message: "m".to_owned(),
            field: field.map(str::to_owned),
            retry_after_ms: retry,
        };
        match identity_error(&e) {
            MethodError::Rpc(f) => (f.error.to_string(), f.reason.clone(), f.detail.clone()),
            MethodError::NotServed => panic!(),
        }
    };
    let s = |v: &str| Some(v.to_owned());
    use IdentityErrorCode as C;
    assert_eq!(
        of(C::InvalidParams, Some("id"), None),
        ("E_INVALID_PARAMS".into(), None, s("id"))
    );
    assert_eq!(
        of(C::InvalidParams, None, None),
        ("E_INVALID_PARAMS".into(), None, None)
    );
    assert_eq!(
        of(C::NotFound, None, None),
        ("E_NOT_FOUND".into(), None, None)
    );
    assert_eq!(
        of(C::Conflict, None, None),
        ("E_CONFLICT".into(), None, None)
    );
    assert_eq!(
        of(C::Limit, None, None),
        ("E_CONFLICT".into(), s("limit"), None)
    );
    assert_eq!(
        of(C::InvalidCode, None, None),
        ("E_DENIED".into(), s("invalid-code"), None)
    );
    assert_eq!(
        of(C::Expired, None, None),
        ("E_DENIED".into(), s("expired"), None)
    );
    assert_eq!(
        of(C::RateLimited, None, Some(1500)),
        ("E_DENIED".into(), s("rate-limited"), s("retryAfterMs=1500"))
    );
    assert_eq!(
        of(C::RateLimited, None, None),
        ("E_DENIED".into(), s("rate-limited"), s("retryAfterMs=0"))
    );
    assert_eq!(
        of(C::Denied, None, None),
        ("E_DENIED".into(), s("identity-denied"), None)
    );
    assert_eq!(
        of(C::Storage, None, None),
        ("E_STORAGE".into(), s("identity-store"), None)
    );
}
