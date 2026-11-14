//! Real files and authenticated caller identities around the pure pinned mood projection.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "integration fixture assertions"
)]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    capture::emotion_store::MoodStore,
    context::{harness_user_principal, principal_key},
    contract::{AgentContext, Cancel, Principal, StoreError},
    text::json::{parse_json, write_json, TolerantJsonValue as Json},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    sync::{atomic::Ordering, Arc},
};
const NOW: i64 = 1_710_000_000_000;
fn principal(agent: &str, user: &str, workspace: &Path) -> Principal {
    serde_json::from_value(
        json!({"agentId":agent,"workspace":format!("workspace-dir:v1:{}",workspace.display()),
        "user":principal_key("telegram", "fixture", user),"channel":"telegram","accountId":"fixture",
        "chat":{"id":"fixture","kind":"direct"},"trust":"proved"}),
    )
    .unwrap()
}
fn agent() -> AgentContext {
    serde_json::from_value(json!({"origin":"user","background":false})).unwrap()
}
fn setup() -> (
    tempfile::TempDir,
    Arc<support::TestHost>,
    Principal,
    MoodStore,
) {
    let dir = support::canonical_tempdir();
    let host = Arc::new(support::TestHost::new(dir.path().join("state")));
    host.set_workspace("alpha", dir.path().into());
    host.set_workspace("beta", dir.path().into());
    host.time.store(NOW, Ordering::SeqCst);
    let p = principal("alpha", "synthetic-user", dir.path());
    let pool = MoodStore::new(host.clone(), Json::Null).unwrap();
    (dir, host, p, pool)
}
fn update(pool: &MoodStore, p: &Principal) {
    assert!(
        pool.update(p, &agent(), &Cancel::never(), |state, now| {
            state.apply_emotion(
                &parse_json(r#"{"joy":0.8,"trust":0.4,"emotionalIntensity":0.7}"#).unwrap(),
                now,
            )
        })
        .unwrap()
        .display_written
    );
}
fn snapshot(pool: &MoodStore, p: &Principal) -> String {
    pool.read(p, &agent(), &Cancel::never(), |s, n| {
        Ok(write_json(&s.serialize_state(n)?))
    })
    .unwrap()
}

#[test]
fn emotional_state_file_updates_atomically_and_restart_applies_elapsed_decay() {
    let (dir, host, p, pool) = setup();
    snapshot(&pool, &p);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    update(&pool, &p);
    let disk = fs::read_to_string(dir.path().join(".emotional-state.json")).unwrap();
    assert!(disk.ends_with('\n'));
    let document: Value = serde_json::from_str(&disk).unwrap();
    assert_eq!(
        document["ownership"]["ownerUserId"],
        principal_key("telegram", "fixture", "synthetic-user")
    );
    assert!(fs::read_to_string(dir.path().join(".current-mood.txt"))
        .unwrap()
        .contains("agent: alpha"));
    let before = snapshot(&pool, &p);
    let reopened = MoodStore::new(host.clone(), Json::Null).unwrap();
    assert_eq!(snapshot(&reopened, &p), before);
    host.time.store(NOW + 3_600_000, Ordering::SeqCst);
    assert_eq!(snapshot(&reopened, &p), snapshot(&pool, &p));
    assert_ne!(snapshot(&reopened, &p), before);
    assert_eq!(
        fs::read_to_string(dir.path().join(".emotional-state.json")).unwrap(),
        disk
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(dir.path().join(".emotional-state.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn actual_node_unbound_foreign_duplicate_and_link_restorations_are_refused() {
    let golden: Value = serde_json::from_str(include_str!(
        "fixtures/capture/golden/emotion-ownership.json"
    ))
    .unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let (dir, _host, p, pool) = setup();
        let raw = case["raw"].as_str().unwrap();
        let file = dir.path().join(".emotional-state.json");
        if case["link"] == true {
            #[cfg(unix)]
            {
                let target = dir.path().join("foreign.json");
                fs::write(&target, raw).unwrap();
                std::os::unix::fs::symlink(target, &file).unwrap();
            }
            #[cfg(windows)]
            {
                fs::write(&file, raw).unwrap();
            }
        } else {
            fs::write(&file, raw).unwrap();
        }
        assert_eq!(case["hydrated"], case["name"] != "corrupt");
        assert_eq!(case["unchanged"], true);
        assert!(pool
            .read(&p, &agent(), &Cancel::never(), |s, n| s.snapshot(n))
            .is_err());
        assert!(pool
            .update(&p, &agent(), &Cancel::never(), |s, n| s.snapshot(n))
            .is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), raw);
        assert!(!dir.path().join(".mood-leases").exists());
    }
}

#[test]
fn other_user_agent_workspace_and_inferred_context_cannot_read_or_replace_state() {
    let (dir, host, p, pool) = setup();
    update(&pool, &p);
    let file = dir.path().join(".emotional-state.json");
    let before = fs::read(&file).unwrap();
    let mut inferred = p.clone();
    inferred.trust = serde_json::from_value(json!("inferred")).unwrap();
    for other in [
        principal("alpha", "other-user", dir.path()),
        principal("beta", "synthetic-user", dir.path()),
        inferred,
    ] {
        assert!(pool
            .read(&other, &agent(), &Cancel::never(), |s, n| s.snapshot(n))
            .is_err());
        assert!(pool
            .update(&other, &agent(), &Cancel::never(), |s, n| s.snapshot(n))
            .is_err());
        assert_eq!(fs::read(&file).unwrap(), before);
    }
    let target = support::canonical_tempdir();
    fs::write(target.path().join(".emotional-state.json"), &before).unwrap();
    host.set_workspace("alpha", target.path().into());
    let relocated = principal("alpha", "synthetic-user", target.path());
    assert!(pool
        .read(&relocated, &agent(), &Cancel::never(), |s, n| s.snapshot(n))
        .is_err());
}

#[test]
fn proved_people_use_separate_state_and_only_bootstrap_from_their_own_legacy_record() {
    let (dir, host, legacy, pool) = setup();
    let proved = |person| {
        let mut principal = serde_json::to_value(&legacy).unwrap();
        principal["user"] = json!(harness_user_principal(person));
        serde_json::from_value::<Principal>(principal).unwrap()
    };
    let alice = proved("alice");
    let bob = proved("bob");
    let initial = snapshot(&pool, &alice);
    update(&pool, &alice);
    let recorded = snapshot(&pool, &alice);
    assert_ne!(initial, recorded);
    let alice_file = fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".emotional-state-")
        })
        .unwrap()
        .path();
    let old = dir.path().join(".emotional-state.json");
    let stored = fs::read(&alice_file).unwrap();
    fs::rename(alice_file, &old).unwrap();
    let alice_display = fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".current-mood-")
        })
        .unwrap()
        .path();
    fs::rename(alice_display, dir.path().join(".current-mood.txt")).unwrap();

    let reopened = MoodStore::new(host, Json::Null).unwrap();
    assert_eq!(snapshot(&reopened, &alice), recorded);
    assert_eq!(snapshot(&reopened, &bob), initial);
    update(&reopened, &bob);
    update(&reopened, &alice);
    assert_eq!(fs::read(old).unwrap(), stored);
    assert_ne!(snapshot(&reopened, &alice), snapshot(&reopened, &bob));
}

#[test]
fn cancelled_failed_and_oversize_updates_do_not_advance_disk_or_cached_state() {
    let (dir, _host, p, pool) = setup();
    update(&pool, &p);
    let before = snapshot(&pool, &p);
    let file = dir.path().join(".emotional-state.json");
    let bytes = fs::read(&file).unwrap();
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(pool
        .update(&p, &agent(), &cancel, |s, n| s.snapshot(n))
        .is_err());
    assert!(pool
        .update(&p, &agent(), &Cancel::never(), |s, n| {
            s.apply_emotion(
                &parse_json(r#"{"anger":1,"emotionalIntensity":1}"#).unwrap(),
                n,
            )?;
            Err::<(), _>(StoreError::Corrupt.into())
        })
        .is_err());
    assert_eq!(snapshot(&pool, &p), before);
    assert_eq!(fs::read(&file).unwrap(), bytes);
    fs::write(&file, vec![b' '; 4 * 1024 * 1024 + 1]).unwrap();
    assert!(pool
        .update(&p, &agent(), &Cancel::never(), |s, n| s.snapshot(n))
        .is_err());
    assert_eq!(fs::metadata(file).unwrap().len(), 4 * 1024 * 1024 + 1);
}

#[test]
fn independent_pools_refresh_after_a_peer_commit_and_serialize_concurrent_updates() {
    let (dir, host, p, pool) = setup();
    update(&pool, &p);
    let peer = MoodStore::new(host, Json::Null).unwrap();
    let before = snapshot(&pool, &p);
    update(&peer, &p);
    assert_ne!(snapshot(&pool, &p), before);
    assert_eq!(snapshot(&pool, &p), snapshot(&peer, &p));
    std::thread::scope(|scope| {
        for store in [&pool, &peer] {
            let p = &p;
            scope.spawn(move || {
                for _ in 0..8 {
                    update(store, p);
                }
            });
        }
    });
    assert_eq!(snapshot(&pool, &p), snapshot(&peer, &p));
    let json: Value =
        serde_json::from_slice(&fs::read(dir.path().join(".emotional-state.json")).unwrap())
            .unwrap();
    assert!(json["state"]["current"]["joy"].as_f64().unwrap() > 0.99);
}

#[test]
fn failed_companion_publish_reports_a_durable_json_commit_without_overwriting_foreign_text() {
    let (dir, _host, p, pool) = setup();
    let display = dir.path().join(".current-mood.txt");
    fs::write(&display, "foreign display").unwrap();
    let commit = pool
        .update(&p, &agent(), &Cancel::never(), |s, n| s.snapshot(n))
        .unwrap();
    assert!(!commit.display_written);
    assert!(dir.path().join(".emotional-state.json").is_file());
    assert_eq!(fs::read_to_string(&display).unwrap(), "foreign display");
    let commit = pool
        .update(&p, &agent(), &Cancel::never(), |s, n| s.snapshot(n))
        .unwrap();
    assert!(!commit.display_written);
    assert_eq!(fs::read_to_string(&display).unwrap(), "foreign display");
    fs::remove_file(&display).unwrap();
    fs::create_dir(&display).unwrap();
    let commit = pool
        .update(&p, &agent(), &Cancel::never(), |s, n| s.snapshot(n))
        .unwrap();
    assert!(!commit.display_written);
    assert!(display.is_dir());
}
