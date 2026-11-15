//! Flip B2 on a real home: the six `secret.*` methods over a store the front door owns. Who is the store's owner,
//! what everyone else gets, what the legacy core is told and when, and that nothing is served without the store.
#![allow(clippy::unwrap_used)]
use super::tests::{admin, audit_lines, home, identity, owner, refused, set_role, Home};
use super::*;
use crate::identity::codes::RandomSource;
use crate::logs::redact::SecretSet;
use crate::rbac::surface::SurfaceTrustLevel;
use crate::route::{ApiTransport, Transport};
use crate::secrets::error::SecretError;
use crate::secrets::memory_backend::MemoryBackend;
use crate::secrets::store::{
    AuditEvent as StoreEvent, AuditSink as StoreSink, SecretStoreOptions, StartupOptions,
};
use crate::secrets::types::SecretPrincipal;
use crate::secrets::SecretStore;

const VALUE: &str = "a value in plain words for the native methods";

/// What the legacy core was told, in order: the name and whether a value came with it.
#[derive(Default)]
struct Legacy {
    told: Mutex<Vec<(Option<String>, Option<String>)>>,
    failing: std::sync::atomic::AtomicBool,
}
impl LegacyCore for Legacy {
    fn reachable(&self) -> bool {
        true
    }
    fn account_changed(&self, _: &str, _: bool, _: bool) -> Result<(), String> {
        Ok(())
    }
    fn secret_changed(&self, name: Option<&str>, secret: Option<&str>) -> Result<(), String> {
        self.told
            .lock()
            .unwrap()
            .push((name.map(str::to_owned), secret.map(str::to_owned)));
        if self.failing.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("timeout".to_owned());
        }
        Ok(())
    }
}

struct Counter(u8);
impl RandomSource for Counter {
    fn random_int(&mut self, _max: u32) -> u32 {
        0
    }
    fn fill_bytes(&mut self, out: &mut [u8]) {
        self.0 += 1;
        out.fill(self.0);
    }
}

type Recorded = Arc<Mutex<Vec<(String, Option<String>, SecretPrincipal)>>>;
struct Records(Recorded);
impl StoreSink for Records {
    fn record(&mut self, event: &StoreEvent) -> Result<(), SecretError> {
        self.0.lock().unwrap().push((
            event.action.as_str().to_owned(),
            event.target.clone(),
            event.principal.clone(),
        ));
        Ok(())
    }
}

fn store(recorded: &Recorded) -> Arc<SecretStore> {
    Arc::new(SecretStore::new(SecretStoreOptions {
        keyring: Box::new(MemoryBackend::new(true)),
        file: Box::new(MemoryBackend::new(false)),
        file_fallback: Box::new(|| false),
        audit: Box::new(Records(recorded.clone())),
        clock: Arc::new(|| 1_767_323_045_678),
        monotonic: Box::new(|| 0.0),
        random: Box::new(Counter(0)),
        logger: None,
        redaction: Arc::new(SecretSet::new()),
        startup: StartupOptions::default(),
    }))
}

struct Running {
    h: Home,
    legacy: Arc<Legacy>,
    store: Arc<SecretStore>,
    recorded: Recorded,
}

/// A home the legacy core runs in, with a store the front door owns: `alice` is an Admin, `second` a Member, `boss`
/// a second Owner. What the store's start left for the bridge connection has been fetched, as the legacy core does.
fn running() -> Running {
    let h = home();
    drop(identity(&h));
    let mut other = admin(&h);
    for (id, role) in [("alice", "admin"), ("second", "member"), ("boss", "owner")] {
        set_role(&mut other, id, role);
    }
    let legacy = Arc::new(Legacy::default());
    h.native.set_legacy(legacy.clone());
    let recorded: Recorded = Arc::default();
    let store = store(&recorded);
    store.preload_redaction();
    let _ = store.drain_effects();
    h.native.set_secrets(store.clone());
    Running {
        h,
        legacy,
        store,
        recorded,
    }
}

fn person(user: &str, role: &str) -> route::Principal {
    route::Principal::Api {
        principal: Some(json!({"userId": user, "kind": "person", "role": role})),
        transport: Transport::Api(Some(ApiTransport::Loopback)),
    }
}

fn told(r: &Running) -> Vec<(Option<String>, Option<String>)> {
    std::mem::take(&mut *r.legacy.told.lock().unwrap())
}

fn actions(r: &Running) -> Vec<(String, Option<String>, SecretPrincipal)> {
    std::mem::take(&mut *r.recorded.lock().unwrap())
}

fn denied() -> (String, Option<String>, String) {
    (
        "E_DENIED".to_owned(),
        Some("denied".to_owned()),
        "secret operations are available to the owner only".to_owned(),
    )
}

#[test]
fn the_secret_methods_are_native_only_while_the_front_door_has_the_store() {
    let h = home();
    for method in secret_methods::SECRET_METHODS {
        assert!(route::NATIVE.contains(method), "{method}");
        assert!(!h.native.serves_now(method), "{method}");
    }
    // The methods that do not depend on the store are served as before, and `secret.grants.list` is not native.
    assert!(h.native.serves_now("user.role.set"));
    assert!(!route::NATIVE.contains(&"secret.grants.list"));
    // Reached all the same, a method refuses and touches nothing.
    assert_eq!(
        refused(h.native.secret_status(&owner())).1.as_deref(),
        Some("route-table-drift")
    );
    assert_eq!(
        refused(h.native.secret_set(&owner(), "api.key", VALUE, None))
            .1
            .as_deref(),
        Some("route-table-drift")
    );
    let recorded: Recorded = Arc::default();
    h.native.set_secrets(store(&recorded));
    for method in secret_methods::SECRET_METHODS {
        assert!(h.native.serves_now(method), "{method}");
    }
}

#[test]
fn the_owner_is_the_stores_owner_with_the_persons_id_and_the_surface_of_a_token_connection() {
    let r = running();
    let status = r.h.native.secret_status(&owner()).unwrap();
    assert_eq!(status["count"], 0);
    assert_eq!(status["backend"], "keyring");
    assert_eq!(
        r.h.native.secret_list(&owner()).unwrap(),
        json!({ "secrets": [] })
    );
    let set =
        r.h.native
            .secret_set(&owner(), "api.key", VALUE, Some("what it is for"))
            .unwrap();
    assert_eq!(set["name"], "api.key");
    assert_eq!(set["description"], "what it is for");
    assert_eq!(set["updatedBy"], "local-owner");
    assert!(set.get("warning").is_none(), "{set}");
    let meta = r.h.native.secret_get(&owner(), "api.key", false).unwrap();
    assert_eq!(meta, json!({ "secret": set }));
    let revealed = r.h.native.secret_get(&owner(), "api.key", true).unwrap();
    assert_eq!(revealed, json!({ "secret": set, "value": VALUE }));
    let described =
        r.h.native
            .secret_describe(&owner(), "api.key", "described again")
            .unwrap();
    assert_eq!(described["description"], "described again");
    // A value the log redactor does not mask is stored, and the answer says so.
    let short = r.h.native.secret_set(&owner(), "pin", "abc", None).unwrap();
    assert_eq!(short["warning"]["code"], "short-value-unmasked");
    assert_eq!(short["warning"]["minMaskedChars"], 8);
    assert_eq!(
        r.h.native.secret_delete(&owner(), "api.key").unwrap(),
        json!({ "removed": true })
    );
    // Every record names the person and the level the store's gate saw.
    let recorded = actions(&r);
    assert!(recorded.iter().all(|(_, _, p)| matches!(
        p,
        SecretPrincipal::Owner { id: Some(id), surface: Some(SurfaceTrustLevel::T1) } if id == "local-owner"
    )));
    let done: Vec<&str> = recorded.iter().map(|(a, _, _)| a.as_str()).collect();
    for action in [
        "secret.set",
        "secret.get",
        "secret.reveal",
        "secret.describe",
        "secret.delete",
    ] {
        assert!(done.contains(&action), "{action} in {done:?}");
    }
    // A second owner behind the API is an owner too, under their own id.
    r.h.native
        .secret_set(&person("boss", "viewer"), "boss.key", VALUE, None)
        .unwrap();
    assert!(matches!(
        &actions(&r).last().unwrap().2,
        SecretPrincipal::Owner { id: Some(id), surface: Some(SurfaceTrustLevel::T1) } if id == "boss"
    ));
}

#[test]
fn everyone_else_is_an_agent_to_the_store_which_refuses_and_records() {
    let r = running();
    r.h.native
        .secret_set(&owner(), "api.key", VALUE, None)
        .unwrap();
    let _ = (told(&r), actions(&r));
    // An Admin, a Member, a person the store does not know, and an Admin who claims to be the owner.
    for who in [
        person("alice", "admin"),
        person("second", "member"),
        person("nobody", "owner"),
        person("alice", "owner"),
    ] {
        assert_eq!(refused(r.h.native.secret_status(&who)), denied(), "{who:?}");
        assert_eq!(refused(r.h.native.secret_list(&who)), denied());
        assert_eq!(
            refused(r.h.native.secret_get(&who, "api.key", true)),
            denied()
        );
        assert_eq!(
            refused(
                r.h.native
                    .secret_set(&who, "api.key", "another value", None)
            ),
            denied()
        );
        assert_eq!(refused(r.h.native.secret_delete(&who, "api.key")), denied());
        let recorded = actions(&r);
        assert_eq!(recorded.len(), 5, "{recorded:?}");
        assert!(recorded
            .iter()
            .all(|(action, _, p)| action == "secret.denied"
                && *p == SecretPrincipal::Agent { agent_id: None }));
    }
    // Nothing changed, and nobody was told of a change.
    assert_eq!(
        r.h.native.secret_get(&owner(), "api.key", true).unwrap()["value"],
        VALUE
    );
    assert!(told(&r).iter().all(|(name, _)| name.is_none()));
    // A person who is disabled is refused as such, before the store is asked.
    let mut other = admin(&r.h);
    other
        .set_disabled("second", true, "local-owner", 1, &mut || Ok(()))
        .unwrap();
    let _ = actions(&r);
    assert_eq!(
        refused(r.h.native.secret_list(&person("second", "member"))),
        (
            "E_DENIED".to_owned(),
            Some("person-disabled".to_owned()),
            "person is disabled".to_owned()
        )
    );
    assert!(actions(&r).is_empty());
}

#[test]
fn describe_goes_through_the_guard_first() {
    let r = running();
    r.h.native
        .secret_set(&owner(), "api.key", VALUE, None)
        .unwrap();
    let _ = actions(&r);
    let before = audit_lines(&r.h).len();
    // A Member has no `settings.write`: the guard refuses and records, and the store is not asked.
    let (code, reason, _) = refused(r.h.native.secret_describe(
        &person("second", "member"),
        "api.key",
        "a member's words",
    ));
    assert_eq!(code, "E_DENIED");
    assert_ne!(reason.as_deref(), Some("denied"));
    assert!(actions(&r).is_empty());
    assert_eq!(audit_lines(&r.h).len(), before + 1);
    // An Admin passes the guard and is an agent to the store.
    assert_eq!(
        refused(r.h.native.secret_describe(
            &person("alice", "admin"),
            "api.key",
            "an admin's words"
        )),
        denied()
    );
    assert_eq!(actions(&r)[0].0, "secret.denied");
    assert_eq!(audit_lines(&r.h).len(), before + 1);
}

#[test]
fn a_refusal_of_the_store_keeps_its_code_its_text_and_names_the_field() {
    let r = running();
    // The description holds a piece of the value: the store's own rule, behind the schema's.
    let refusal = r.h.native.secret_set(
        &owner(),
        "api.key",
        VALUE,
        Some("a value in plain words for the record"),
    );
    match refusal {
        Err(MethodError::Rpc(f)) => {
            assert_eq!(f.error.to_string(), "E_INVALID_PARAMS");
            assert_eq!(f.reason.as_deref(), Some("invalid-description"));
            assert_eq!(f.detail.as_deref(), Some("description"));
            assert_eq!(
                f.message,
                "secret description must not contain a secret fragment"
            );
        }
        other => panic!("{other:?}"),
    }
    let missing = r.h.native.secret_get(&owner(), "never.there", true);
    match missing {
        Err(MethodError::Rpc(f)) => {
            assert_eq!(f.error.to_string(), "E_NOT_FOUND");
            assert_eq!(f.reason.as_deref(), Some("not-found"));
            assert!(f.detail.is_none());
            assert_eq!(f.message, "no secret named never.there");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        refused(r.h.native.secret_delete(&owner(), "never.there")).0,
        "E_NOT_FOUND"
    );
}

#[test]
fn the_legacy_core_is_told_of_a_change_before_the_answer_and_asked_to_fetch_the_rest() {
    let r = running();
    // A read that leaves nothing for the holder outside: nobody is told.
    r.h.native.secret_status(&owner()).unwrap();
    r.h.native.secret_list(&owner()).unwrap();
    assert_eq!(told(&r), vec![]);
    // A set: the name and the value, once.
    r.h.native
        .secret_set(&owner(), "api.key", VALUE, None)
        .unwrap();
    assert_eq!(
        told(&r),
        vec![(Some("api.key".to_owned()), Some(VALUE.to_owned()))]
    );
    // The effects stay with the store for the bridge connection, which owns them.
    assert_eq!(r.store.drain_effects().names, vec!["api.key".to_owned()]);
    // A reveal and a description change nothing the legacy core holds.
    r.h.native.secret_get(&owner(), "api.key", true).unwrap();
    r.h.native
        .secret_describe(&owner(), "api.key", "what it is for")
        .unwrap();
    assert_eq!(told(&r), vec![]);
    // A delete: the name, no value.
    r.h.native.secret_delete(&owner(), "api.key").unwrap();
    assert_eq!(told(&r), vec![(Some("api.key".to_owned()), None)]);
    let _ = r.store.drain_effects();
    // A change that failed after the store had begun it voided the name's leases: the legacy core is asked to
    // fetch what the store has to tell, without a name.
    assert!(r.h.native.secret_delete(&owner(), "never.there").is_err());
    assert_eq!(told(&r), vec![(None, None)]);
    // While that has not been fetched, every call asks again; once it has been, none does.
    r.h.native.secret_status(&owner()).unwrap();
    assert_eq!(told(&r), vec![(None, None)]);
    let _ = r.store.drain_effects();
    r.h.native.secret_status(&owner()).unwrap();
    assert_eq!(told(&r), vec![]);
    // A store that went away is such an effect too.
    r.store.backend_unavailable();
    assert!(r.h.native.secret_list(&owner()).is_err());
    assert_eq!(told(&r), vec![(None, None)]);
}

#[test]
fn a_legacy_core_that_was_not_reached_changes_nothing_about_the_change() {
    let r = running();
    r.legacy
        .failing
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let set =
        r.h.native
            .secret_set(&owner(), "api.key", VALUE, None)
            .unwrap();
    assert_eq!(set["name"], "api.key");
    assert_eq!(told(&r).len(), 1);
    assert_eq!(
        r.h.native.secret_get(&owner(), "api.key", true).unwrap()["value"],
        VALUE
    );
    // Without a control link at all, the same.
    let h = home();
    let recorded: Recorded = Arc::default();
    h.native.set_secrets(store(&recorded));
    assert!(h
        .native
        .secret_set(&owner(), "api.key", VALUE, None)
        .is_ok());
}

/// Through the dispatcher, as a caller gets it: the answer is what the method built. The generated type leaves an
/// optional array out when it is empty, and the TypeScript core sends `secrets: []` for an empty store.
#[test]
fn an_empty_store_answers_with_its_empty_list_as_the_typescript_core_does() {
    let Running { h, .. } = running();
    let Home { dir: _dir, native } = h;
    let cx = route::CallContext {
        principal: owner(),
        native: Arc::new(native),
    };
    let status = route::serve(&cx, "secret.status", json!({})).unwrap();
    assert_eq!(status["count"], 0);
    assert_eq!(status["secrets"], json!([]), "{status}");
    assert_eq!(
        route::serve(&cx, "secret.list", json!({})).unwrap(),
        json!({ "secrets": [] })
    );
    // Each call answers with its own value: nothing of the call before is left on the thread, a refusal included.
    let refused = route::serve(&cx, "secret.get", json!({ "name": "none" })).unwrap_err();
    assert_eq!(refused["data"]["error"], "E_NOT_FOUND", "{refused}");
    let set = route::serve(
        &cx,
        "secret.set",
        json!({ "name": "api.key", "value": VALUE }),
    )
    .unwrap();
    assert_eq!(set["name"], "api.key", "{set}");
    let status = route::serve(&cx, "secret.status", json!({})).unwrap();
    assert_eq!(status["count"], 1);
    assert_eq!(status["secrets"][0]["name"], "api.key", "{status}");
}
