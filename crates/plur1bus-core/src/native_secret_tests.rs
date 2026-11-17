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
use serde_json::Map;

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
    store_with(Box::new(Records(recorded.clone())))
}

/// Every record as the store handed it to its sink, detail included.
type Events = Arc<Mutex<Vec<StoreEvent>>>;
struct Whole(Events);
impl StoreSink for Whole {
    fn record(&mut self, event: &StoreEvent) -> Result<(), SecretError> {
        self.0.lock().unwrap().push(event.clone());
        Ok(())
    }
}

fn store_with(audit: Box<dyn StoreSink>) -> Arc<SecretStore> {
    Arc::new(SecretStore::new(SecretStoreOptions {
        keyring: Box::new(MemoryBackend::new(true)),
        file: Box::new(MemoryBackend::new(false)),
        file_fallback: Box::new(|| false),
        audit,
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

/// R-20-34: a front door started for an import maintenance serves nothing itself. The legacy core holds the
/// maintenance and decides every request (`busy`, or let through), as it does without a front door; here that is
/// every method of the native set, whatever else it depends on, until the process starts again.
#[test]
fn started_for_an_import_maintenance_nothing_is_served_here() {
    use super::logs_tests::{mirror_over, nothing_new, Feed};
    let serving = || {
        let r = running();
        let mirror = mirror_over(&Feed::with(vec![nothing_new("1", 0)]));
        mirror.catch_up(Duration::from_secs(5)).unwrap();
        r.h.native.set_redaction(mirror);
        r
    };
    // With the mirror in step and the store here, every native method is served.
    let r = serving();
    for method in route::NATIVE {
        assert!(r.h.native.serves_now(method), "{method}");
    }
    r.h.native.hold_for_import_maintenance();
    for method in route::NATIVE.iter().chain(&["host.secret.get"]) {
        assert!(!r.h.native.serves_now(method), "{method}");
    }
    // The variable counts when it is set, whatever it holds: the legacy core judges the value, and refuses to start
    // on one that is no run id, the empty one and blanks included (`createImportMaintenanceHold` asks whether it is
    // defined). The front door never reads a set variable as no maintenance (P4D-38). Unset is none.
    let named = |value: Option<&str>| import_maintenance_named(value.map(std::ffi::OsStr::new));
    assert!(named(Some("9488a983-b15c-4281-9669-d09228686fc5")));
    assert!(named(Some("not a run id")));
    assert!(named(Some("")));
    assert!(named(Some(" ")));
    assert!(named(Some("\t\n")));
    assert!(!named(None));
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
    // The legacy core answered that notice: while nothing new waits it is not asked again, fetched or not (review
    // S4; until then every call asked again).
    r.h.native.secret_status(&owner()).unwrap();
    assert_eq!(told(&r), vec![]);
    let _ = r.store.drain_effects();
    r.h.native.secret_status(&owner()).unwrap();
    assert_eq!(told(&r), vec![]);
    // A store that went away is such an effect too.
    r.store.backend_unavailable();
    assert!(r.h.native.secret_list(&owner()).is_err());
    assert_eq!(told(&r), vec![(None, None)]);
}

/// Review S4: the legacy core is asked to fetch once for each stand of what waits, not once for each call; a notice
/// that failed is repeated with a later call, and not sooner than five seconds after the failure. A change is told
/// by name whatever the state of that is.
#[test]
fn the_request_to_fetch_goes_out_once_for_what_waits_and_rests_after_a_failure() {
    let fetch = vec![(None, None)];
    let r = running();
    assert_eq!(r.store.effects_stand(), None);
    assert_eq!(secret_methods::NOTICE_RETRY, Duration::from_secs(5));
    // Something waits: one notice, and none for the reads and the engine's calls that follow.
    assert!(r.h.native.secret_delete(&owner(), "never.there").is_err());
    let first = r.store.effects_stand();
    assert!(first.is_some());
    assert_eq!(told(&r), fetch);
    for _ in 0..3 {
        r.h.native.secret_status(&owner()).unwrap();
        r.h.native.secret_list(&owner()).unwrap();
        assert!(r
            .h
            .native
            .host_secret_get(&engine(), "never.there")
            .is_err());
    }
    assert_eq!(told(&r), vec![]);
    assert_eq!(r.store.effects_stand(), first, "nothing new waits");
    // The same name once more adds nothing; another name does, and is one more notice.
    assert!(r.h.native.secret_delete(&owner(), "never.there").is_err());
    assert_eq!(told(&r), vec![]);
    assert!(r.h.native.secret_delete(&owner(), "nor.this").is_err());
    assert!(r.store.effects_stand() > first);
    assert_eq!(told(&r), fetch);
    r.h.native.secret_status(&owner()).unwrap();
    assert_eq!(told(&r), vec![]);
    // Fetched, and then the same thing waits again: a later stand, told again.
    let _ = r.store.drain_effects();
    assert_eq!(r.store.effects_stand(), None);
    r.h.native.secret_status(&owner()).unwrap();
    assert_eq!(told(&r), vec![]);
    assert!(r.h.native.secret_delete(&owner(), "never.there").is_err());
    assert_eq!(told(&r), fetch);

    // A legacy core that does not answer: the notice fails, and the calls of the next five seconds do not try.
    r.legacy
        .failing
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(r.h.native.secret_delete(&owner(), "a.third").is_err());
    assert_eq!(told(&r), fetch);
    for _ in 0..3 {
        r.h.native.secret_status(&owner()).unwrap();
    }
    assert_eq!(told(&r), vec![]);
    r.h.native
        .age_failed_notice(secret_methods::NOTICE_RETRY - Duration::from_millis(200));
    r.h.native.secret_status(&owner()).unwrap();
    assert_eq!(told(&r), vec![], "not yet");
    // After that it is tried again with the next call, once, and rests again when it fails again.
    r.h.native.age_failed_notice(Duration::from_millis(200));
    r.h.native.secret_status(&owner()).unwrap();
    assert_eq!(told(&r), fetch);
    r.h.native.secret_status(&owner()).unwrap();
    assert_eq!(told(&r), vec![]);
    // A change is told by name all the same, in the rest too.
    r.h.native
        .secret_set(&owner(), "api.key", VALUE, None)
        .unwrap();
    assert_eq!(
        told(&r),
        vec![(Some("api.key".to_owned()), Some(VALUE.to_owned()))]
    );
    // The legacy core answers again: the notice that was owed goes out with the first call after the rest, and
    // that is the end of it.
    r.legacy
        .failing
        .store(false, std::sync::atomic::Ordering::SeqCst);
    r.h.native.secret_status(&owner()).unwrap();
    assert_eq!(
        told(&r),
        vec![],
        "still resting after the failed notice of the set"
    );
    r.h.native.age_failed_notice(secret_methods::NOTICE_RETRY);
    r.h.native.secret_status(&owner()).unwrap();
    assert_eq!(told(&r), fetch);
    r.h.native.secret_status(&owner()).unwrap();
    assert_eq!(told(&r), vec![]);
    // A named notice that was answered covers what waited then: the legacy core fetches on every notice.
    r.h.native.secret_delete(&owner(), "api.key").unwrap();
    assert_eq!(told(&r), vec![(Some("api.key".to_owned()), None)]);
    r.h.native.secret_status(&owner()).unwrap();
    assert_eq!(told(&r), vec![]);
    // A snapshot is something that waits too: the first thing a store has for its holder.
    let recorded: Recorded = Arc::default();
    let fresh = store(&recorded);
    assert_eq!(fresh.effects_stand(), None);
    fresh.preload_redaction();
    assert_eq!(fresh.effects_stand(), Some(1));
    let _ = fresh.drain_effects();
    assert_eq!(fresh.effects_stand(), None);
    // A notice that was answered ends the rest a failure began: what waits next is told at once, not five seconds
    // after a failure the legacy core has long recovered from.
    r.legacy
        .failing
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(r.h.native.secret_delete(&owner(), "a.fourth").is_err());
    assert_eq!(told(&r), fetch);
    r.legacy
        .failing
        .store(false, std::sync::atomic::Ordering::SeqCst);
    r.h.native
        .secret_set(&owner(), "api.key", VALUE, None)
        .unwrap();
    assert_eq!(told(&r).len(), 1, "by name, answered");
    assert!(r.h.native.secret_delete(&owner(), "a.fifth").is_err());
    assert_eq!(told(&r), fetch);
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

/// P4D-29: what the engine's configuration refers to. The home's `config.json` carries `engine`; the front door reads
/// it at every request of the engine's method.
fn write_engine(h: &Home, engine: Value) {
    let mut config = plur1bus_config::defaults();
    config["engine"] = engine;
    std::fs::write(h.dir.path().join("config.json"), config.to_string()).unwrap();
}

/// The engine's configuration names these (each in a block that has no default names of its own).
fn allow(h: &Home, names: &[&str]) {
    let blocks = ["merging", "skillMiner", "criticalPush", "schicht15"];
    let mut engine = Map::new();
    for (name, block) in names.iter().zip(blocks) {
        engine.insert(block.to_owned(), json!({ "apiKeyRef": name }));
    }
    write_engine(h, Value::Object(engine));
}

fn engine() -> route::Principal {
    route::Principal::Engine {
        transport: Transport::Ipc,
    }
}

fn handler_threw() -> (String, Option<String>, String) {
    (
        "E_INTERNAL".to_owned(),
        Some("handler-threw".to_owned()),
        "internal error".to_owned(),
    )
}

/// R-20-32: `host.secret.get` for the engine is `createEngineSecrets(store).resolve(name, "memory-engine")`: a lease
/// as the core, the value, the lease given back. The two records are the TypeScript store's, with its detail.
#[test]
fn the_engine_gets_a_value_through_a_lease_that_is_given_back_at_once() {
    use crate::secrets::audit::DetailValue;
    let h = home();
    allow(&h, &["models/key"]);
    let legacy = Arc::new(Legacy::default());
    h.native.set_legacy(legacy.clone());
    let events: Events = Arc::default();
    let store = store_with(Box::new(Whole(events.clone())));
    store.preload_redaction();
    let _ = store.drain_effects();
    h.native.set_secrets(store.clone());
    assert!(h.native.serves_now("host.secret.get"));
    let owner_of_the_store = SecretPrincipal::Owner {
        id: Some("local-owner".to_owned()),
        surface: None,
    };
    store
        .set(&owner_of_the_store, "models/key", VALUE, None)
        .unwrap();
    let _ = store.drain_effects();
    events.lock().unwrap().clear();
    let leases = |store: &SecretStore| store.active_leases(&SecretPrincipal::Core).unwrap().len();
    let status = |store: &SecretStore| store.status(&owner_of_the_store).unwrap().to_json();
    // A lease somebody else holds is not touched, and counts before as after.
    let other = store
        .lease(
            &SecretPrincipal::Core,
            "models/key",
            crate::secrets::leases::IssueOptions {
                purpose: "another-holder",
                profile_id: "another-holder",
                ttl_ms: None,
            },
        )
        .unwrap();
    assert_eq!(leases(&store), 1);
    let before = status(&store);
    assert_eq!(before["activeLeases"], 1, "{before}");
    events.lock().unwrap().clear();

    let got = h.native.host_secret_get(&engine(), "models/key").unwrap();
    assert_eq!(got, json!({ "value": VALUE }));

    let text = |s: &str| DetailValue::Str(s.encode_utf16().collect());
    let recorded = std::mem::take(&mut *events.lock().unwrap());
    assert_eq!(recorded.len(), 2, "{recorded:?}");
    assert_eq!(recorded[0].action.as_str(), "secret.lease");
    assert_eq!(recorded[0].target.as_deref(), Some("models/key"));
    assert_eq!(recorded[0].principal, SecretPrincipal::Core);
    assert_eq!(
        recorded[0].detail,
        vec![
            ("purpose".to_owned(), text("memory-engine")),
            ("profileId".to_owned(), text("memory-engine")),
            (
                "ttlMs".to_owned(),
                DetailValue::Num(serde_json::Number::from(5000))
            ),
        ]
    );
    assert_eq!(recorded[1].action.as_str(), "secret.lease.revoke");
    assert_eq!(recorded[1].target, None);
    assert_eq!(recorded[1].principal, SecretPrincipal::Core);
    let [(key, DetailValue::Str(lease_id))] = recorded[1].detail.as_slice() else {
        panic!("{:?}", recorded[1].detail)
    };
    let lease_id = String::from_utf16(lease_id).unwrap();
    assert_eq!(key, "leaseId");
    assert!(lease_id.starts_with("lse_") && lease_id != other.lease_id);

    // The lease is gone: what the store counts is what it counted before, and the other holder's lease still reads.
    assert_eq!(leases(&store), 1);
    assert_eq!(status(&store), before);
    assert_eq!(
        store
            .read_lease(&SecretPrincipal::Core, &other.lease_id)
            .unwrap()
            .value,
        VALUE
    );
    assert!(store.read_lease(&SecretPrincipal::Core, &lease_id).is_err());
    // Nothing changed, so the legacy core is told nothing.
    assert!(legacy.told.lock().unwrap().is_empty());
}

/// Every failure is the answer to a handler that threw, as the TypeScript port makes it: an unknown name, a name
/// that is none, a store that is away. No lease is left behind, and nothing of the call is in the answer.
#[test]
fn every_failure_of_the_engines_method_is_a_handler_that_threw() {
    let r = running();
    allow(&r.h, &["models/key", "never.there"]);
    r.h.native
        .secret_set(&owner(), "models/key", VALUE, None)
        .unwrap();
    let _ = (told(&r), actions(&r), r.store.drain_effects());
    let leases = || r.store.active_leases(&SecretPrincipal::Core).unwrap().len();

    for name in ["never.there", "not a name", ""] {
        let refused = refused(r.h.native.host_secret_get(&engine(), name));
        assert_eq!(refused, handler_threw(), "{name:?}");
        assert_eq!(leases(), 0, "{name:?}");
    }
    // The store recorded what it was asked, as it does for the TypeScript core: the lease of a name it does not
    // have is recorded before the name is looked up. A name that is none is outside the configuration's set (P4D-29):
    // refused before the lease, as a refusal with no target.
    let agent = SecretPrincipal::Agent {
        agent_id: Some("memory-engine".to_owned()),
    };
    assert_eq!(
        actions(&r),
        vec![
            (
                "secret.lease".to_owned(),
                Some("never.there".to_owned()),
                SecretPrincipal::Core
            ),
            ("secret.denied".to_owned(), None, agent.clone()),
            ("secret.denied".to_owned(), None, agent),
        ]
    );

    // A store that went away.
    r.store.backend_unavailable();
    let _ = told(&r);
    assert_eq!(
        refused(r.h.native.host_secret_get(&engine(), "models/key")),
        handler_threw()
    );
    assert_eq!(leases(), 0);
    // That is an effect the legacy core has to fetch, as after any native call.
    assert_eq!(told(&r), vec![(None, None)]);
}

/// Review U4: the lease was given and its revocation fails (the store could not write the record of it). No value
/// goes out: the answer is the one to a handler that threw, as for every other failure, and the line is the
/// server's. The lease that could not be given back stays in the table until it expires, as in the TypeScript port
/// (`finally { await store.revokeLease(...) }` throws, and the value it had is dropped with it; P4D-37).
#[test]
fn a_lease_that_cannot_be_given_back_gives_out_no_value() {
    use crate::secrets::error::SecretErrorCode;
    /// Records everything but a revocation, which it cannot write.
    struct NoRevocation(Events);
    impl StoreSink for NoRevocation {
        fn record(&mut self, event: &StoreEvent) -> Result<(), SecretError> {
            if event.action.as_str() == "secret.lease.revoke" {
                return Err(SecretError::new(
                    SecretErrorCode::AuditUnavailable,
                    "the audit log could not be written",
                ));
            }
            self.0.lock().unwrap().push(event.clone());
            Ok(())
        }
    }
    let h = home();
    allow(&h, &["models/key"]);
    let legacy = Arc::new(Legacy::default());
    h.native.set_legacy(legacy.clone());
    let events: Events = Arc::default();
    let store = store_with(Box::new(NoRevocation(events.clone())));
    store.preload_redaction();
    let _ = store.drain_effects();
    h.native.set_secrets(store.clone());
    let owner_of_the_store = SecretPrincipal::Owner {
        id: Some("local-owner".to_owned()),
        surface: None,
    };
    store
        .set(&owner_of_the_store, "models/key", VALUE, None)
        .unwrap();
    let _ = store.drain_effects();
    events.lock().unwrap().clear();
    let _ = crate::server::take_logged();

    let answer = h.native.host_secret_get(&engine(), "models/key");
    // Not `refused(..)`, which would print an answer that is none: nothing of this one is printed unless it is safe.
    let Err(MethodError::Rpc(failure)) = answer else {
        panic!("a value went out although its lease could not be given back")
    };
    assert_eq!(
        (
            failure.error.to_string(),
            failure.reason.clone(),
            failure.message.clone()
        ),
        handler_threw()
    );
    let whole = format!("{failure:?}");
    assert!(
        !whole.contains(VALUE) && !whole.contains("audit"),
        "{whole}"
    );
    // The lease was recorded, the revocation was not; the lease is still in the table, for its five seconds.
    let recorded: Vec<String> = events
        .lock()
        .unwrap()
        .iter()
        .map(|e| e.action.as_str().to_owned())
        .collect();
    assert_eq!(recorded, ["secret.lease"]);
    assert_eq!(
        store.active_leases(&SecretPrincipal::Core).unwrap().len(),
        1
    );
    // The line is the server's, with the method and the reason and nothing of the call or of the store's error.
    assert_eq!(
        crate::server::take_logged(),
        vec![(
            "error".to_owned(),
            "handler failed".to_owned(),
            json!({"method": "host.secret.get", "reason": "handler-threw"})
        )]
    );
    assert!(legacy.told.lock().unwrap().is_empty());
    // The same through the dispatcher, where a built value would wait for the answer: none does.
    let cx = route::CallContext {
        principal: engine(),
        native: Arc::new(Native::new(h.dir.path())),
    };
    cx.native.set_secrets(store.clone());
    let failed = route::serve(&cx, "host.secret.get", json!({"name": "models/key"})).unwrap_err();
    assert_eq!(
        failed,
        json!({"code": -32000, "message": "internal error",
            "data": {"error": "E_INTERNAL", "reason": "handler-threw"}})
    );
    assert_eq!(
        store.active_leases(&SecretPrincipal::Core).unwrap().len(),
        2
    );
}

/// The method serves the engine's principal and no other: the legacy core answers everyone else, and one that
/// arrives here all the same is refused before the store is asked. Without the store it is relayed.
#[test]
fn the_engines_method_serves_the_engine_only_and_only_with_the_store() {
    let r = running();
    allow(&r.h, &["models/key"]);
    r.h.native
        .secret_set(&owner(), "models/key", VALUE, None)
        .unwrap();
    let _ = actions(&r);
    for who in [
        owner(),
        person("boss", "owner"),
        person("alice", "admin"),
        route::Principal::Api {
            principal: None,
            transport: Transport::Api(None),
        },
        route::Principal::Module {
            transport: Transport::Ipc,
        },
        route::Principal::ScopedClient {
            token: Arc::new(crate::auth::Secret::fresh().unwrap()),
            transport: Transport::Ipc,
        },
    ] {
        let _ = crate::server::take_logged();
        let refused = refused(r.h.native.host_secret_get(&who, "models/key"));
        assert_eq!(
            (refused.0.as_str(), refused.1.as_deref()),
            ("E_INTERNAL", Some("route-table-drift")),
            "{who:?}"
        );
        // Review U8: a routing change that sends somebody else here is seen in the log, as the one that sends a
        // person's method to another caller is (`route::native_principal`). The line names the method and the
        // kind of principal, and nothing a principal carries (a person's id, a client's token).
        assert_eq!(
            crate::server::take_logged(),
            vec![(
                "error".to_owned(),
                "route table drift: the engine's method reached a principal that is not the engine"
                    .to_owned(),
                json!({"method": "host.secret.get", "principal": who.kind()})
            )],
            "{who:?}"
        );
    }
    assert_eq!(owner().kind(), "owner");
    assert_eq!(person("boss", "owner").kind(), "api");
    assert_eq!(engine().kind(), "engine");
    assert!(actions(&r).is_empty(), "the store was not asked");
    assert_eq!(
        r.h.native.host_secret_get(&engine(), "models/key").unwrap(),
        json!({ "value": VALUE })
    );
    assert!(
        crate::server::take_logged().is_empty(),
        "the engine's own call writes no line"
    );

    // No store here (the legacy core has it): relayed, and refused if it is reached all the same.
    let h = home();
    allow(&h, &["models/key"]);
    assert!(!route::NATIVE.contains(&"host.secret.get"));
    assert!(route::ENGINE_NATIVE.contains(&"host.secret.get"));
    assert!(!h.native.serves_now("host.secret.get"));
    assert_eq!(
        refused(h.native.host_secret_get(&engine(), "models/key"))
            .1
            .as_deref(),
        Some("route-table-drift")
    );
    let recorded: Recorded = Arc::default();
    h.native.set_secrets(store(&recorded));
    assert!(h.native.serves_now("host.secret.get"));
}

/// Through the dispatcher, as the engine gets it: the schema of the method has no pattern for the name, so a name
/// the store refuses is the store's failure, not the schema's.
#[test]
fn the_engines_call_through_the_dispatcher() {
    let r = running();
    allow(&r.h, &["models/key"]);
    r.h.native
        .secret_set(&owner(), "models/key", VALUE, None)
        .unwrap();
    let cx = route::CallContext {
        principal: engine(),
        native: Arc::new(Native::new(r.h.dir.path())),
    };
    cx.native.set_secrets(r.store.clone());
    assert_eq!(
        route::serve(&cx, "host.secret.get", json!({"name": "models/key"})),
        Ok(json!({ "value": VALUE }))
    );
    let failed = route::serve(&cx, "host.secret.get", json!({"name": "not a name"})).unwrap_err();
    assert_eq!(
        failed,
        json!({"code": -32000, "message": "internal error",
            "data": {"error": "E_INTERNAL", "reason": "handler-threw"}})
    );
    for params in [
        json!({}),
        json!({"name": ""}),
        json!({"name": "a", "more": 1}),
    ] {
        let refused = route::serve(&cx, "host.secret.get", params.clone()).unwrap_err();
        assert_eq!(refused["data"]["error"], "E_INVALID_PARAMS", "{params}");
    }
    // A method a person is served is not the engine's, whatever the routing did.
    let status = route::serve(&cx, "secret.status", json!({})).unwrap_err();
    assert_eq!(status["data"]["reason"], "route-table-drift", "{status}");
}

/// A running front door with a store that holds `models/key`, `personal/bank-token` and `OPENAI_API_KEY`, and the
/// whole of what it recorded, detail included.
fn scoped() -> (Home, Arc<Legacy>, Arc<SecretStore>, Events) {
    let h = home();
    let legacy = Arc::new(Legacy::default());
    h.native.set_legacy(legacy.clone());
    let events: Events = Arc::default();
    let store = store_with(Box::new(Whole(events.clone())));
    store.preload_redaction();
    let _ = store.drain_effects();
    h.native.set_secrets(store.clone());
    let me = SecretPrincipal::Owner {
        id: Some("local-owner".to_owned()),
        surface: None,
    };
    for name in ["models/key", "personal/bank-token", "OPENAI_API_KEY"] {
        store.set(&me, name, VALUE, None).unwrap();
    }
    let _ = store.drain_effects();
    events.lock().unwrap().clear();
    let _ = crate::server::take_logged();
    (h, legacy, store, events)
}

fn recorded_actions(events: &Events) -> Vec<(String, Option<String>)> {
    std::mem::take(&mut *events.lock().unwrap())
        .into_iter()
        .map(|e| (e.action.as_str().to_owned(), e.target))
        .collect()
}

/// P4D-29, R-20-35: a stored name the configuration does not refer to is refused as a name the store does not have
/// is (the same answer), no lease is taken, and the refusal is one `secret.denied` record that names the asked name:
/// the store's own record of a lease asked for by somebody the store does not serve, as the TypeScript port writes it.
#[test]
fn a_name_the_configuration_does_not_refer_to_is_refused_like_an_unknown_one() {
    use crate::secrets::audit::DetailValue;
    let (h, legacy, store, events) = scoped();
    allow(&h, &["models/key"]);
    let leases = || store.active_leases(&SecretPrincipal::Core).unwrap().len();

    // In the set: the value and the store's two records, as before.
    assert_eq!(
        h.native.host_secret_get(&engine(), "models/key").unwrap(),
        json!({ "value": VALUE })
    );
    assert_eq!(
        recorded_actions(&events),
        vec![
            ("secret.lease".to_owned(), Some("models/key".to_owned())),
            ("secret.lease.revoke".to_owned(), None),
        ]
    );

    // Outside the set and stored.
    let stored = refused(h.native.host_secret_get(&engine(), "personal/bank-token"));
    assert_eq!(stored, handler_threw());
    let held = std::mem::take(&mut *events.lock().unwrap());
    assert_eq!(held.len(), 1, "{held:?}");
    assert_eq!(held[0].action.as_str(), "secret.denied");
    assert_eq!(held[0].target.as_deref(), Some("personal/bank-token"));
    // The one who asked is named: an agent, which the store gives no lease, with the engine's name (K3).
    assert_eq!(
        held[0].principal,
        SecretPrincipal::Agent {
            agent_id: Some(secret_methods::ENGINE_OUTSIDE_SCOPE.to_owned()),
        }
    );
    assert_eq!(secret_methods::ENGINE_OUTSIDE_SCOPE, "memory-engine");
    assert_eq!(
        held[0].detail,
        vec![(
            "method".to_owned(),
            DetailValue::Str("lease".encode_utf16().collect())
        )]
    );
    assert_eq!(leases(), 0, "no lease was taken");

    // Outside the set and not stored: the same answer, the same record.
    let missing = refused(h.native.host_secret_get(&engine(), "personal/never-stored"));
    assert_eq!(missing, stored);
    assert_eq!(
        recorded_actions(&events),
        vec![(
            "secret.denied".to_owned(),
            Some("personal/never-stored".to_owned())
        )]
    );
    // A name that is none: refused, recorded without a target.
    assert_eq!(
        refused(h.native.host_secret_get(&engine(), "not a name")),
        stored
    );
    assert_eq!(
        recorded_actions(&events),
        vec![("secret.denied".to_owned(), None)]
    );
    // Nothing of a refusal is in the answer, and the legacy core is told nothing of it.
    assert!(legacy.told.lock().unwrap().is_empty());
    // Each of the three is a line of the server's and a line that says the routing let it through: `server.rs`
    // sends a name outside the set on to the legacy core and does not call the method with it (R-20-38).
    let logged = crate::server::take_logged();
    for message in [
        "handler failed",
        "route table drift: the engine's method was reached with a name outside the engine's scope",
    ] {
        let lines: Vec<_> = logged.iter().filter(|(_, m, _)| m == message).collect();
        assert_eq!(lines.len(), 3, "{message}: {logged:?}");
        // Nothing of the call is in a line: not the name that was asked for.
        for (_, _, fields) in lines {
            assert!(!fields.to_string().contains("personal"), "{fields}");
        }
    }
}

/// R-20-38: what the front door answers the engine itself. A name of its own set; a name outside it, and every name
/// while no valid configuration was read, goes on to the legacy core, which knows the planned target of an embedding
/// migration and decides. A request that names no secret stays here: its parameters are refused before the method.
#[test]
fn the_front_door_answers_the_engine_for_the_names_of_its_own_set_only() {
    let (h, _legacy, _store, events) = scoped();
    let asks = |name: Value| json!({"jsonrpc": "2.0", "id": 1, "method": "host.secret.get", "params": {"name": name}});
    let serves = |msg: &Value| h.native.engine_serves("host.secret.get", msg);
    // No configuration that was ever valid: no name is answered here.
    std::fs::write(h.dir.path().join("config.json"), "{ not json").unwrap();
    assert!(!serves(&asks(json!("models/key"))));
    allow(&h, &["models/key"]);
    assert!(serves(&asks(json!("models/key"))));
    for outside in [
        "personal/bank-token",
        "personal/never-stored",
        "OPENAI_API_KEY",
        "not a name",
        "",
        "models/key ",
        "MODELS/KEY",
    ] {
        assert!(!serves(&asks(json!(outside))), "{outside}");
    }
    // No name to judge: the method's own parameter check answers, here.
    for no_name in [
        json!(7),
        json!(null),
        json!(["models/key"]),
        json!({"name": "models/key"}),
    ] {
        assert!(serves(&asks(no_name.clone())), "{no_name}");
    }
    assert!(serves(
        &json!({"jsonrpc": "2.0", "id": 1, "method": "host.secret.get"})
    ));
    assert!(serves(
        &json!({"jsonrpc": "2.0", "id": 1, "method": "host.secret.get", "params": ["models/key"]})
    ));
    // Only the engine's one method.
    assert!(!h
        .native
        .engine_serves("secret.get", &asks(json!("models/key"))));
    assert!(!h
        .native
        .engine_serves("host.workspaceDir", &asks(json!("models/key"))));
    // The set follows the configuration: a default name while its block is there, a reference while it is there.
    write_engine(&h, json!({ "embedding": {} }));
    assert!(serves(&asks(json!("OPENAI_API_KEY"))));
    assert!(!serves(&asks(json!("models/key"))));
    // Asking is no call of the store: nothing was recorded, nothing leased.
    assert!(events.lock().unwrap().is_empty());
}

/// What a reference removed from the configuration does: the next request is refused. The set follows the file from
/// one request to the next. A file that is no configuration changes nothing (R-20-37): the last valid one holds, and
/// the first valid file after it does, with what it took out.
#[test]
fn a_reference_that_leaves_the_configuration_is_refused_by_the_next_request() {
    let (h, _legacy, _store, events) = scoped();
    let get = |name: &str| h.native.host_secret_get(&engine(), name);
    allow(&h, &["models/key", "personal/bank-token"]);
    assert!(get("models/key").is_ok());
    assert!(get("personal/bank-token").is_ok());
    allow(&h, &["models/key"]);
    assert!(get("models/key").is_ok());
    assert_eq!(refused(get("personal/bank-token")), handler_threw());
    write_engine(&h, json!({}));
    assert_eq!(refused(get("models/key")), handler_threw());
    // No file at all: the defaults, which name nothing.
    std::fs::remove_file(h.dir.path().join("config.json")).unwrap();
    assert_eq!(refused(get("models/key")), handler_threw());
    let denied = |events: &Events| {
        recorded_actions(events)
            .iter()
            .filter(|(a, _)| a == "secret.denied")
            .count()
    };
    assert_eq!(denied(&events), 3);
    // A file that is no JSON at all, or no configuration: the last valid one goes on, with both of its names.
    allow(&h, &["models/key", "personal/bank-token"]);
    assert!(get("models/key").is_ok());
    for broken in ["{ not json", r#"{"engine":"rust"}"#, ""] {
        std::fs::write(h.dir.path().join("config.json"), broken).unwrap();
        assert!(get("models/key").is_ok(), "{broken:?}");
        assert!(get("personal/bank-token").is_ok(), "{broken:?}");
        assert_eq!(
            refused(get("OPENAI_API_KEY")),
            handler_threw(),
            "{broken:?}"
        );
    }
    assert_eq!(denied(&events), 3);
    // Valid again, with one reference taken out: that one is refused by the next request.
    allow(&h, &["models/key"]);
    assert_eq!(refused(get("personal/bank-token")), handler_threw());
    assert!(get("models/key").is_ok());
    assert_eq!(denied(&events), 1);
}

/// R-20-36: the names a block falls back to are allowed while the block is in the configuration and not otherwise,
/// whatever the block's provider says; a block's default names do not open another block's.
#[test]
fn the_default_names_of_a_block_are_allowed_while_the_block_is_in_the_configuration() {
    let (h, _legacy, _store, events) = scoped();
    let get = |name: &str| h.native.host_secret_get(&engine(), name);
    write_engine(&h, json!({ "embedding": { "local": { "model": "m" } } }));
    assert_eq!(get("OPENAI_API_KEY").unwrap(), json!({ "value": VALUE }));
    let _ = recorded_actions(&events);
    write_engine(&h, json!({ "reranker": { "apiKeyRef": "models/key" } }));
    assert_eq!(refused(get("OPENAI_API_KEY")), handler_threw());
    assert!(get("models/key").is_ok());
    write_engine(&h, json!({ "embedding": {} }));
    assert!(get("OPENAI_API_KEY").is_ok());
    write_engine(&h, json!({}));
    assert_eq!(refused(get("OPENAI_API_KEY")), handler_threw());
    // A block that is no object has no default names.
    write_engine(&h, json!({ "embedding": "openai" }));
    assert_eq!(refused(get("OPENAI_API_KEY")), handler_threw());
}
