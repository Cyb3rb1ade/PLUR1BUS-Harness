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
    // The core says for whom it writes: the owner changes the block, and so does the core for the one cause that
    // has to (the switch of an embedding migration).
    assert_eq!(set(held, Some(person("owner")), None), ok);
    assert_eq!(
        set(
            held,
            Some(json!({"kind": "core", "cause": "embedding-switch"})),
            None
        ),
        ok
    );
    // The engine and any other cause of the core do not; what they write elsewhere is theirs as before.
    for other in [
        json!({"kind": "engine"}),
        json!({"kind": "core", "cause": "agent-create"}),
    ] {
        assert_eq!(set(held, Some(other.clone()), None), denied, "{other}");
        assert_eq!(
            level(Some(other.clone()), None),
            ok,
            "{other}: outside the block"
        );
    }
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

/// A write the core makes for a person is written, and the record names that person; one it makes for itself or for
/// the engine is the local owner's in the record, as before.
#[test]
fn the_record_of_a_write_names_the_person_it_was_made_for() {
    let (_dir, ctx) = fixture();
    let days = |n: u64, actor: Option<Value>| {
        let mut params = json!({"changes": [{"key": "approvals.maxGrantDays", "value": n}]});
        if let Some(actor) = actor {
            params["actor"] = actor;
        }
        let reply = ctx.config_set(&json!(1), &params, None);
        assert_eq!(reply["result"]["applied"], true, "{reply}");
        let log = std::fs::read_to_string(ctx.layout.audit_log()).unwrap();
        let last: Value = serde_json::from_str(log.lines().last().unwrap()).unwrap();
        assert_eq!(last["target"], "approvals.maxGrantDays");
        last["actor"]["user"].as_str().unwrap().to_owned()
    };
    assert_eq!(
        days(
            31,
            Some(json!({"kind": "person", "userId": "usr_admin", "role": "admin"}))
        ),
        "usr_admin"
    );
    assert_eq!(days(32, Some(json!({"kind": "engine"}))), "local-owner");
    assert_eq!(
        days(33, Some(json!({"kind": "core", "cause": "agent-create"}))),
        "local-owner"
    );
    assert_eq!(days(34, None), "local-owner");
}
