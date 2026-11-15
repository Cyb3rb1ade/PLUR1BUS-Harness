//! Flip A3 on a real home: a person the harness API acts for is the person the store knows, never the local owner, and
//! what the delegation claims about role and agent rights counts for nothing against what is stored.
#![allow(clippy::unwrap_used)]
use super::tests::{admin, audit_lines, bare, home, identity, owner, refused, set_role, Home};
use super::*;
use crate::route::{ApiTransport, Transport};

/// The legacy core the write methods need afterwards; what it was asked for.
#[derive(Default)]
struct Legacy(Mutex<Vec<String>>);
impl LegacyCore for Legacy {
    fn reachable(&self) -> bool {
        true
    }
    fn account_changed(&self, user_id: &str, _: bool, _: bool) -> Result<(), String> {
        self.0.lock().unwrap().push(user_id.to_owned());
        Ok(())
    }
}

/// A home the legacy core runs in: `alice` is an Admin, `second` a Member, `boss` a second Owner.
fn running() -> (Home, Arc<Legacy>, AdminStore) {
    let h = home();
    drop(identity(&h));
    let mut other = admin(&h);
    for (id, role) in [("alice", "admin"), ("second", "member"), ("boss", "owner")] {
        set_role(&mut other, id, role);
    }
    let legacy = Arc::new(Legacy::default());
    h.native.set_legacy(legacy.clone());
    (h, legacy, other)
}

/// The API acting for the person `claim` describes.
fn api(claim: Value) -> route::Principal {
    route::Principal::Api {
        principal: Some(claim),
        transport: Transport::Api(Some(ApiTransport::Loopback)),
    }
}

fn person(user: &str, role: &str) -> route::Principal {
    api(json!({"userId": user, "kind": "person", "role": role}))
}

fn code<T: std::fmt::Debug>(r: Result<T, MethodError>) -> (String, Option<String>) {
    let (code, reason, _) = refused(r);
    (code, reason)
}

fn role_of(store: &AdminStore, id: &str) -> String {
    store
        .users()
        .unwrap()
        .into_iter()
        .find(|u| u.id == id)
        .unwrap()
        .role
}

#[test]
fn the_stored_role_decides_whatever_the_delegation_claims() {
    let (h, legacy, other) = running();
    // Claimed Viewer, stored Admin: served as the Admin the store knows.
    let a = h
        .native
        .authorize(&person("alice", "viewer"), "user.role.set", None)
        .unwrap();
    assert_eq!(
        (a.user_id.as_str(), a.role, a.kind),
        ("alice", Role::Admin, Some(PrincipalKind::Person))
    );
    let done = h
        .native
        .user_role_set(&person("alice", "viewer"), "second", "operator")
        .unwrap();
    assert_eq!(done, json!({"userId": "second", "role": "operator"}));
    assert_eq!(role_of(&other, "second"), "operator");
    let lines = audit_lines(&h);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0]["actor"], json!({"user": "alice", "host": "rpc"}));
    assert_eq!(*legacy.0.lock().unwrap(), ["second"]);

    // Claimed Owner, stored Admin: ownership is not hers to change, and she meets the handler's rule as an Admin.
    assert_eq!(
        code(
            h.native
                .user_role_set(&person("alice", "owner"), "boss", "admin")
        ),
        ("E_DENIED".to_owned(), Some("owner-only".to_owned()))
    );
    assert_eq!(
        code(
            h.native
                .user_status(&person("alice", "owner"), true, "boss", None)
        ),
        ("E_DENIED".to_owned(), None)
    );
    assert_eq!(role_of(&other, "boss"), "owner");

    // Claimed Owner, stored Member: the guard denies, and the audit event names the stored role.
    assert_eq!(
        code(
            h.native
                .user_role_set(&person("second", "owner"), "alice", "viewer")
        ),
        ("E_DENIED".to_owned(), Some("role-denied".to_owned()))
    );
    let lines = audit_lines(&h);
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[1]["action"], "rbac.denied");
    assert_eq!(
        lines[1]["actor"],
        json!({"user": "second", "host": "local"})
    );
    assert_eq!(lines[1]["detail"]["role"], "operator");
    assert_eq!(role_of(&other, "alice"), "admin");
}

#[test]
fn a_person_the_store_does_not_know_is_nobody_and_never_the_local_owner() {
    let (h, legacy, other) = running();
    // The local owner is stored as an active Owner; a delegation for someone unknown gets nothing of that.
    for claim in [
        person("ghost", "owner"),
        person("ghost", "admin"),
        person("Local-Owner", "owner"),
        person("local-owner ", "owner"),
    ] {
        assert_eq!(
            code(h.native.user_role_set(&claim, "second", "admin")),
            ("E_UNAUTHORIZED".to_owned(), Some("no-principal".to_owned())),
            "{claim:?}"
        );
        assert_eq!(
            code(h.native.breakglass_notices(&claim)),
            ("E_UNAUTHORIZED".to_owned(), Some("no-principal".to_owned()))
        );
    }
    assert_eq!(role_of(&other, "second"), "member");
    assert!(legacy.0.lock().unwrap().is_empty());
    let lines = audit_lines(&h);
    assert_eq!(lines.len(), 8);
    assert!(lines.iter().all(|l| l["action"] == "rbac.unauthenticated"
        && l["actor"] == json!({"user": "anonymous", "host": "local"})
        && l["detail"]["reason"] == "no-principal"));
    assert_eq!(other.users().unwrap().len(), 4, "nobody was added");

    // The API acting for the person stored as `local-owner` is that person on the API path: a token's scopes narrow
    // her like anyone, which the owner connection's principal never is.
    let narrow = api(
        json!({"userId": "local-owner", "kind": "person", "role": "owner", "tokenScopes": ["memory.read"]}),
    );
    assert_eq!(
        code(h.native.user_role_set(&narrow, "second", "admin")),
        ("E_DENIED".to_owned(), Some("token-scope".to_owned()))
    );
    assert!(h
        .native
        .user_role_set(&person("local-owner", "viewer"), "second", "admin")
        .is_ok());
}

#[test]
fn a_disabled_person_is_refused_as_disabled_and_nothing_is_audited() {
    let (h, legacy, mut other) = running();
    other
        .set_disabled("alice", true, "boss", 1, &mut || Ok(()))
        .unwrap();
    for refusal in [
        refused(
            h.native
                .user_role_set(&person("alice", "admin"), "second", "viewer"),
        ),
        refused(
            h.native
                .user_status(&person("alice", "admin"), true, "second", None),
        ),
        refused(h.native.breakglass_notices(&person("alice", "admin"))),
        refused(
            h.native
                .identity_principals(&person("alice", "admin"), None),
        ),
    ] {
        assert_eq!(
            refusal,
            (
                "E_DENIED".to_owned(),
                Some("person-disabled".to_owned()),
                "person is disabled".to_owned()
            )
        );
    }
    assert!(
        audit_lines(&h).is_empty(),
        "the TypeScript guard passes this refusal on unaudited"
    );
    assert_eq!(role_of(&other, "second"), "member");
    assert!(legacy.0.lock().unwrap().is_empty());
    // The local owner's own connection is not concerned, and neither is another person through the API.
    assert!(h.native.breakglass_notices(&owner()).is_ok());
    assert!(h
        .native
        .breakglass_notices(&person("second", "member"))
        .is_ok());
    // Enabled again by the other process: served again, at once.
    other
        .set_disabled("alice", false, "boss", 2, &mut || Ok(()))
        .unwrap();
    assert!(h
        .native
        .user_role_set(&person("alice", "admin"), "second", "viewer")
        .is_ok());
}

#[test]
fn the_local_owners_state_is_not_the_api_persons() {
    let (h, _legacy, mut other) = running();
    // The local owner demoted and disabled: the owner connection is nobody, the Admin behind the API still an Admin.
    set_role(&mut other, "local-owner", "viewer");
    other
        .set_disabled("local-owner", true, "boss", 1, &mut || Ok(()))
        .unwrap();
    assert_eq!(
        code(h.native.breakglass_notices(&owner())),
        ("E_UNAUTHORIZED".to_owned(), Some("no-principal".to_owned()))
    );
    assert!(h
        .native
        .user_role_set(&person("alice", "admin"), "second", "viewer")
        .is_ok());
}

#[test]
fn a_tokens_scopes_narrow_the_person_and_the_stored_rights_replace_the_claimed_ones() {
    let (h, _legacy, other) = running();
    let scoped = |scopes: Value| {
        api(json!({"userId": "alice", "kind": "person", "role": "admin", "tokenScopes": scopes}))
    };
    for scopes in [
        json!([]),
        json!(["memory.read"]),
        json!(["admin.users.read"]),
        json!(["admin.users"]),
    ] {
        assert_eq!(
            code(
                h.native
                    .user_role_set(&scoped(scopes.clone()), "second", "viewer")
            ),
            ("E_DENIED".to_owned(), Some("token-scope".to_owned())),
            "{scopes}"
        );
    }
    assert_eq!(role_of(&other, "second"), "member");
    let lines = audit_lines(&h);
    assert_eq!(lines.len(), 4);
    assert!(lines
        .iter()
        .all(|l| l["action"] == "rbac.denied" && l["actor"]["user"] == "alice"));
    for scopes in [
        json!(["admin.users.write"]),
        json!(["admin.*"]),
        json!(["memory.read", "admin.users.write"]),
    ] {
        assert!(
            h.native
                .user_role_set(&scoped(scopes.clone()), "second", "viewer")
                .is_ok(),
            "{scopes}"
        );
    }
    // The principal the method runs for carries the token's scopes and the stored agent rights; the claimed agent
    // rights are gone, the claimed project rights stay (the store has none).
    let mut store = admin(&h);
    store.set_right("bernd", "alice", Some("use")).unwrap();
    let claim = api(
        json!({"userId": "alice", "kind": "person", "role": "owner", "tokenScopes": ["admin.*"],
        "agentRights": {"bernd": "manage", "other": "manage"}, "projectRights": {"p1": "lead"},
        "tokenId": "t1", "binding": {"agentId": "bernd"}}),
    );
    let a = h.native.authorize(&claim, "user.role.set", None).unwrap();
    assert_eq!(a.role, Role::Admin);
    assert_eq!(a.token_scopes, Some(vec!["admin.*".to_owned()]));
    assert_eq!(
        a.agent_rights,
        Some(vec![("bernd".to_owned(), AgentRight::Use)])
    );
    assert_eq!(
        a.project_rights,
        Some(vec![("p1".to_owned(), ProjectRight::Lead)])
    );
}

#[test]
fn what_is_no_person_in_the_delegations_shape_is_never_served() {
    let (h, _legacy, other) = running();
    // An agent the API acts for and the API service itself are the legacy core's: reaching this module with one is a
    // routing change gone wrong.
    for who in [
        api(json!({"userId": "alice", "kind": "agent", "role": "admin"})),
        api(json!({"userId": "alice", "role": "admin"})),
        route::Principal::Api {
            principal: None,
            transport: Transport::Api(None),
        },
    ] {
        assert_eq!(
            code(h.native.user_role_set(&who, "second", "viewer")),
            (
                "E_INTERNAL".to_owned(),
                Some("route-table-drift".to_owned())
            ),
            "{who:?}"
        );
    }
    // A person whose claim is not the shape module-api admits (the front door has refused it before): a failed
    // resolver, never a guess.
    for claim in [
        json!({"userId": "alice", "kind": "person", "role": "king"}),
        json!({"userId": "alice", "kind": "person"}),
        json!({"userId": 7, "kind": "person", "role": "admin"}),
        json!({"userId": "alice", "kind": "person", "role": "admin", "tokenScopes": "admin.*"}),
        json!({"userId": "alice", "kind": "person", "role": "admin", "tokenScopes": [7]}),
        json!({"userId": "alice", "kind": "person", "role": "admin", "agentRights": {"bernd": "own"}}),
        json!({"userId": "alice", "kind": "person", "role": "admin", "projectRights": ["p1"]}),
    ] {
        assert_eq!(
            code(
                h.native
                    .user_role_set(&api(claim.clone()), "second", "viewer")
            ),
            (
                "E_UNAUTHORIZED".to_owned(),
                Some("resolver-failed".to_owned())
            ),
            "{claim}"
        );
    }
    assert_eq!(role_of(&other, "second"), "member");
}

#[test]
fn without_the_store_an_api_person_is_a_failed_resolver_and_nothing_is_created() {
    let h = bare();
    h.native.set_legacy(Arc::new(Legacy::default()));
    assert_eq!(
        code(
            h.native
                .user_role_set(&person("alice", "owner"), "second", "viewer")
        ),
        (
            "E_UNAUTHORIZED".to_owned(),
            Some("resolver-failed".to_owned())
        )
    );
    assert!(!h.dir.path().join("state/admin.sqlite").exists());
}

#[test]
fn the_reading_methods_answer_for_the_person_behind_the_api() {
    let (h, _legacy, _other) = running();
    // Her own notices (none), not the local owner's; her own principals need her human record.
    assert_eq!(
        h.native
            .breakglass_notices(&person("alice", "admin"))
            .unwrap(),
        json!({"notices": []})
    );
    assert_eq!(
        code(
            h.native
                .identity_principals(&person("second", "member"), Some("alice"))
        ),
        ("E_DENIED".to_owned(), None),
        "a Member asks about herself only"
    );
    assert_eq!(
        refused(
            h.native
                .identity_principals(&person("alice", "admin"), None)
        )
        .0,
        "E_NOT_FOUND",
        "asked about herself: alice has no human record"
    );
}
