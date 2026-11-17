//! P4D-39: `config.set` as the connection's handler answers it. A local caller may say for whom it writes; a
//! delegated write names its person itself.
use super::*;

fn fixture() -> (tempfile::TempDir, ConnCtx) {
    let dir = tempfile::tempdir().unwrap();
    let layout = Layout::new(dir.path().to_path_buf());
    let shared = Arc::new(Shared {
        state: Mutex::new(super::super::test_state()),
        wake: Default::default(),
        log: super::super::Log::none(),
        config: Mutex::new(config::initial(&layout)),
        subscribers: Default::default(),
        out_logs: Default::default(),
        maintenance: Default::default(),
    });
    let context = ConnCtx {
        token: "t".repeat(64),
        hello: json!({}),
        audit_health: Default::default(),
        shared,
        layout,
    };
    (dir, context)
}

/// `("ok", "")` for a result, else the error and its reason.
fn outcome(reply: &Value) -> (String, String) {
    if reply["result"].is_object() {
        return ("ok".into(), String::new());
    }
    let data = &reply["error"]["data"];
    (
        data["error"].as_str().unwrap_or("?").into(),
        data["reason"].as_str().unwrap_or("").into(),
    )
}

#[test]
fn a_local_write_is_judged_by_the_actor_it_names_and_a_delegated_write_names_none() {
    let (_dir, ctx) = fixture();
    let set = |key: &str, actor: Option<Value>, principal: Option<&Value>| {
        let mut params = json!({"changes": [{"key": key, "value": "a.name"}], "dryRun": true});
        if let Some(actor) = actor {
            params["actor"] = actor;
        }
        outcome(&ctx.config_set(&json!(1), &params, principal))
    };
    let ok = ("ok".to_string(), String::new());
    let denied = ("E_DENIED".to_string(), "config-write-role".to_string());
    let person = |role: &str| json!({"kind": "person", "userId": "usr_1", "role": role});
    // A block that holds a credential, and a key next to no credential.
    let held = "channels.telegram.tokenSecret";
    let free = "core.logLevel";
    let level = |actor: Option<Value>, principal: Option<&Value>| {
        let mut params = json!({"changes": [{"key": free, "value": "warn"}], "dryRun": true});
        if let Some(actor) = actor {
            params["actor"] = actor;
        }
        outcome(&ctx.config_set(&json!(1), &params, principal))
    };

    // The local owner, as before there was an actor; `null` is no actor.
    assert_eq!(set(held, None, None), ok);
    assert_eq!(set(held, Some(Value::Null), None), ok);
    // The core says for whom it writes: the owner, the engine and the core's own causes change the block.
    assert_eq!(set(held, Some(person("owner")), None), ok);
    assert_eq!(set(held, Some(json!({"kind": "engine"})), None), ok);
    assert_eq!(
        set(
            held,
            Some(json!({"kind": "core", "cause": "embedding-switch"})),
            None
        ),
        ok
    );
    // Nobody else does, and a person the core gave no role is nobody.
    for role in ["admin", "operator", "member", "viewer"] {
        assert_eq!(set(held, Some(person(role)), None), denied, "{role}");
        assert_eq!(
            level(Some(person(role)), None),
            ok,
            "{role}: outside the block"
        );
    }
    assert_eq!(
        set(
            held,
            Some(json!({"kind": "person", "userId": "usr_1"})),
            None
        ),
        denied
    );
    // What the schema does not know as an actor is no request this method answers.
    for unknown in [
        json!({"kind": "somebody"}),
        json!({"kind": "person", "userId": "usr_1", "role": "root"}),
        json!({"role": "owner"}),
        json!("owner"),
    ] {
        assert_eq!(
            set(held, Some(unknown.clone()), None).0,
            "E_INVALID_PARAMS",
            "{unknown}"
        );
    }

    // A delegated write is judged by its person, and an actor beside the delegation is refused whatever it says.
    let admin = json!({"kind": "person", "userId": "usr_admin", "role": "admin"});
    let owner = json!({"kind": "person", "userId": "usr_owner", "role": "owner"});
    assert_eq!(set(held, None, Some(&owner)), ok);
    assert_eq!(set(held, None, Some(&admin)), denied);
    assert_eq!(level(None, Some(&admin)), ok);
    for actor in [person("owner"), json!({"kind": "engine"}), person("admin")] {
        assert_eq!(
            set(held, Some(actor.clone()), Some(&admin)).0,
            "E_INVALID_PARAMS"
        );
        assert_eq!(level(Some(actor), Some(&owner)).0, "E_INVALID_PARAMS");
    }
    assert!(!ctx.layout.config_path().exists(), "dry runs write nothing");
}
