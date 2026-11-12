//! Actual A1 SQLite parity and private counter persistence; caller ACL/render gating is composed separately.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use plur1bus_engine::{contract::Cancel, store::recall_stats::RecallStats};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{fs, path::Path, sync::Arc};
const ID: &str = "00000000-0000-4000-8000-000000000001";
fn root() -> tempfile::TempDir {
    tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}
fn snapshot(path: &Path) -> Value {
    if !path.exists() {
        return Value::Null;
    }
    let db = Connection::open(path).unwrap();
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    let stats:Vec<Value>=db.prepare("SELECT id,recalls,lastRecalledAt FROM stats ORDER BY id").unwrap().query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"recalls":r.get::<_,i64>(1)?,"lastRecalledAt":r.get::<_,Option<i64>>(2)?}))).unwrap().map(Result::unwrap).collect();
    let queries: Vec<Value> = db
        .prepare("SELECT id,digest FROM queries ORDER BY id,digest")
        .unwrap()
        .query_map([], |r| {
            Ok(json!({"id":r.get::<_,String>(0)?,"digest":r.get::<_,String>(1)?}))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect();
    json!({"version":version,"stats":stats,"queries":queries})
}
#[test]
fn actual_sqlite_transitions_match_the_frozen_a1_oracle() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/recall-stats.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let root = root();
        let store = RecallStats::new(root.path()).unwrap();
        let scenario = &case["scenario"];
        if scenario["uninitialized"] != true {
            for agent in ["alpha", "beta"] {
                store.read(agent, Some(&[]), &Cancel::never()).unwrap();
                let db = Connection::open(store.path(agent).unwrap()).unwrap();
                db.execute(
                    "UPDATE metadata SET value=? WHERE key='query-hmac-key'",
                    ["07".repeat(32)],
                )
                .unwrap();
                if agent == "alpha" && !scenario["legacy"].is_null() {
                    let l = &scenario["legacy"];
                    db.execute(
                        "INSERT INTO stats VALUES (?,?,?)",
                        params![
                            l["id"].as_str().unwrap(),
                            l["recalls"].as_i64().unwrap(),
                            l["lastRecalledAt"].as_i64()
                        ],
                    )
                    .unwrap();
                    db.pragma_update(None, "user_version", 0).unwrap();
                }
                if let Some(version) = scenario["version"].as_i64() {
                    db.pragma_update(None, "user_version", version).unwrap();
                }
            }
        }
        for step in case["steps"].as_array().unwrap() {
            let action = &step["action"];
            let agent = action["agent"].as_str().unwrap();
            let ids: Option<Vec<String>> = serde_json::from_value(action["ids"].clone()).unwrap();
            let result = if action["op"] == "read" {
                store
                    .read(agent, ids.as_deref(), &Cancel::never())
                    .map(|v| serde_json::to_value(v).unwrap())
            } else {
                store
                    .record(
                        agent,
                        ids.as_deref().unwrap(),
                        action["query"].as_str().unwrap(),
                        action["now"].as_f64().unwrap(),
                        &Cancel::never(),
                    )
                    .map(|()| Value::Null)
            };
            assert_eq!(
                result.is_err(),
                step["error"].as_bool().unwrap(),
                "{} {action}",
                scenario["name"]
            );
            if let Ok(value) = result {
                assert_eq!(value, step["result"], "{}", scenario["name"]);
            }
            assert_eq!(
                snapshot(&store.path(agent).unwrap()),
                step["state"],
                "{}",
                scenario["name"]
            );
        }
    }
}
#[test]
fn counters_survive_reopen_and_do_not_persist_plaintext_queries() {
    let root = root();
    let store = RecallStats::new(root.path()).unwrap();
    let query = "PRIVATE SYNTHETIC QUERY SENTINEL with a deliberate unique suffix";
    store
        .record(
            "alpha",
            &[ID.into(), ID.into()],
            query,
            20.0,
            &Cancel::never(),
        )
        .unwrap();
    let path = store.path("alpha").unwrap();
    drop(store);
    assert!(!fs::read(&path)
        .unwrap()
        .windows(query.len())
        .any(|s| s == query.as_bytes()));
    let store = RecallStats::new(root.path()).unwrap();
    store
        .record("alpha", &[ID.into()], query, 30.0, &Cancel::never())
        .unwrap();
    assert_eq!(
        serde_json::to_value(store.read("alpha", None, &Cancel::never()).unwrap()).unwrap(),
        json!([{"id":ID,"recalls":2,"distinctQueries":1,"lastRecalledAt":30}])
    );
    assert!(store
        .read("beta", None, &Cancel::never())
        .unwrap()
        .is_empty());
    let a = Connection::open(&path)
        .unwrap()
        .query_row("SELECT value FROM metadata", [], |r| r.get::<_, String>(0))
        .unwrap();
    let b = Connection::open(store.path("beta").unwrap())
        .unwrap()
        .query_row("SELECT value FROM metadata", [], |r| r.get::<_, String>(0))
        .unwrap();
    assert_ne!(a, b);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}
#[test]
fn concurrent_connections_keep_exact_counts_and_one_digest_per_exact_query() {
    let root = root();
    let store = Arc::new(RecallStats::new(root.path()).unwrap());
    store.read("alpha", Some(&[]), &Cancel::never()).unwrap();
    let workers: Vec<_> = (0..4)
        .map(|index| {
            let store = store.clone();
            std::thread::spawn(move || {
                for _ in 0..5 {
                    store
                        .record(
                            "alpha",
                            &[ID.into()],
                            &format!("Synthetic query {index}"),
                            20.0,
                            &Cancel::never(),
                        )
                        .unwrap();
                }
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(
        serde_json::to_value(store.read("alpha", None, &Cancel::never()).unwrap()).unwrap(),
        json!([{"id":ID,"recalls":20,"distinctQueries":4,"lastRecalledAt":20}])
    );
}
#[test]
fn invalid_bounds_cancel_and_metadata_never_partially_advance_counters() {
    let root = root();
    let store = RecallStats::new(root.path()).unwrap();
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(store
        .record("alpha", &[ID.into()], "Synthetic", 1.0, &cancel)
        .is_err());
    assert!(!root.path().join("_recall-stats").exists());
    assert!(store
        .record("../bad", &[ID.into()], "Synthetic", 1.0, &Cancel::never())
        .is_err());
    assert!(store
        .record(
            "alpha",
            &vec![ID.into(); 501],
            "Synthetic",
            1.0,
            &Cancel::never()
        )
        .is_err());
    assert!(store
        .record(
            "alpha",
            &[ID.into()],
            &"a".repeat(1_000_001),
            1.0,
            &Cancel::never()
        )
        .is_err());
    assert!(!root.path().join("_recall-stats").exists());
    store
        .record("alpha", &[ID.into()], "Synthetic", 1.0, &Cancel::never())
        .unwrap();
    let path = store.path("alpha").unwrap();
    let before = snapshot(&path);
    let db = Connection::open(&path).unwrap();
    db.execute("UPDATE metadata SET value='invalid'", [])
        .unwrap();
    drop(db);
    assert!(store
        .record("alpha", &[ID.into()], "Another", 2.0, &Cancel::never())
        .is_err());
    assert_eq!(snapshot(&path), before);
}
#[cfg(unix)]
#[test]
fn linked_database_and_rebound_base_are_refused() {
    use std::os::unix::fs::symlink;
    for hard in [false, true] {
        let root = root();
        let outside = root.path().join("outside.sqlite");
        fs::write(&outside, b"unrelated").unwrap();
        let store = RecallStats::new(root.path()).unwrap();
        fs::create_dir(root.path().join("_recall-stats")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            root.path().join("_recall-stats"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        if hard {
            fs::hard_link(&outside, store.path("alpha").unwrap()).unwrap();
        } else {
            symlink(&outside, root.path().join("_recall-stats/alpha.sqlite")).unwrap();
        }
        assert!(store.read("alpha", None, &Cancel::never()).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"unrelated");
    }
    let parent = root();
    let base = parent.path().join("base");
    fs::create_dir(&base).unwrap();
    let store = RecallStats::new(&base).unwrap();
    fs::rename(&base, parent.path().join("previous")).unwrap();
    fs::create_dir(&base).unwrap();
    assert!(store.read("alpha", None, &Cancel::never()).is_err());
    assert!(fs::read_dir(base).unwrap().next().is_none());
}
#[test]
fn later_counter_overflow_rolls_back_earlier_ids_and_lost_keys_are_not_replaced() {
    let root = root();
    let store = RecallStats::new(root.path()).unwrap();
    let second = "00000000-0000-4000-8000-000000000002";
    store
        .record(
            "alpha",
            &[ID.into(), second.into()],
            "Synthetic first query",
            1.0,
            &Cancel::never(),
        )
        .unwrap();
    let path = store.path("alpha").unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute(
        "UPDATE stats SET recalls=? WHERE id=?",
        params![9_007_199_254_740_991_i64, second],
    )
    .unwrap();
    let before = snapshot(&path);
    assert!(store
        .record(
            "alpha",
            &[ID.into(), second.into()],
            "Synthetic second query",
            2.0,
            &Cancel::never()
        )
        .is_err());
    assert_eq!(snapshot(&path), before);
    db.execute("DELETE FROM metadata", []).unwrap();
    assert!(store.read("alpha", None, &Cancel::never()).is_err());
    let count: i64 = db
        .query_row("SELECT COUNT(*) FROM metadata", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(snapshot(&path), before);
}
#[cfg(unix)]
#[test]
fn linked_sqlite_journals_never_reach_the_database_connection() {
    use std::os::unix::fs::symlink;
    for hard in [true, false] {
        let root = root();
        let store = RecallStats::new(root.path()).unwrap();
        store.read("alpha", Some(&[]), &Cancel::never()).unwrap();
        let target = root.path().join("unrelated");
        fs::write(&target, b"unrelated bytes").unwrap();
        let journal = root.path().join("_recall-stats/alpha.sqlite-journal");
        if hard {
            fs::hard_link(&target, &journal).unwrap();
        } else {
            symlink(&target, &journal).unwrap();
        }
        assert!(store
            .record("alpha", &[ID.into()], "Synthetic", 1.0, &Cancel::never())
            .is_err());
        assert_eq!(fs::read(&target).unwrap(), b"unrelated bytes");
    }
}

/// Migration 0 -> 1 (A1 `recall-stats.json`, cases `legacy-counter` and `legacy-null-time`): a version-0 sidecar holds
/// bare `stats` rows without query digests. Opening it must keep every counter and last-recalled time, lift
/// `user_version` to 1, and leave later records to add to the old count.
#[test]
fn recall_stats_migration_0_to_1_keeps_the_counters() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/recall-stats.json")).unwrap();
    let legacy_cases: Vec<&Value> = golden["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| !case["scenario"]["legacy"].is_null())
        .collect();
    assert_eq!(legacy_cases.len(), 2, "the oracle's legacy cases changed");
    for case in legacy_cases {
        let legacy = &case["scenario"]["legacy"];
        let id = legacy["id"].as_str().unwrap();
        let recalls = legacy["recalls"].as_i64().unwrap();
        let last = legacy["lastRecalledAt"].as_i64();
        let root = root();
        // A real version-0 file: only the `stats` table, no `queries`, no `metadata` and so no HMAC key.
        let path = RecallStats::new(root.path())
            .unwrap()
            .path("alpha")
            .unwrap();
        plur1bus_engine::store::paths::secure_dir(path.parent().unwrap()).unwrap();
        {
            let db = Connection::open(&path).unwrap();
            db.execute_batch(
                "CREATE TABLE stats (id TEXT PRIMARY KEY, recalls INTEGER NOT NULL DEFAULT 0, lastRecalledAt INTEGER);",
            )
            .unwrap();
            db.execute(
                "INSERT INTO stats VALUES (?,?,?)",
                params![id, recalls, last],
            )
            .unwrap();
            let tables: i64 = db
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name IN ('queries','metadata')",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(tables, 0, "setup: a v0 file has neither table");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let version: i64 = Connection::open(&path)
            .unwrap()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 0, "setup");

        // Opening migrates in place and keeps the counter exactly.
        let store = RecallStats::new(root.path()).unwrap();
        let counters =
            serde_json::to_value(store.read("alpha", None, &Cancel::never()).unwrap()).unwrap();
        assert_eq!(
            counters,
            json!([{"id":id,"recalls":recalls,"distinctQueries":0,"lastRecalledAt":last}])
        );
        let after = snapshot(&path);
        assert_eq!(after["version"], 1);
        assert_eq!(
            after["stats"],
            json!([{"id":id,"recalls":recalls,"lastRecalledAt":last}])
        );
        assert_eq!(after["queries"], json!([]));
        // The transition created the missing tables and the HMAC key.
        let key: String = Connection::open(&path)
            .unwrap()
            .query_row(
                "SELECT value FROM metadata WHERE key='query-hmac-key'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit()));

        // A second open is a no-op.
        drop(store);
        let store = RecallStats::new(root.path()).unwrap();
        store.read("alpha", None, &Cancel::never()).unwrap();
        assert_eq!(snapshot(&path), after);

        // New recalls add to the migrated count; the time never moves backwards (a null time takes the new one only
        // where the oracle says so, so compare with the oracle's final state).
        store
            .record(
                "alpha",
                &[id.into()],
                "New synthetic query",
                120.0,
                &Cancel::never(),
            )
            .unwrap();
        let migrated = serde_json::to_value(
            store
                .read("alpha", Some(&[id.to_owned()]), &Cancel::never())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(migrated[0]["recalls"], recalls + 1);
        assert_eq!(migrated[0]["distinctQueries"], 1);
        let steps = case["steps"].as_array().unwrap();
        assert_eq!(migrated, steps.last().unwrap()["result"]);
        // Digests depend on the per-file HMAC key (the oracle test pins it), so compare counters and version only.
        let state = snapshot(&path);
        let expected = &steps.last().unwrap()["state"];
        assert_eq!(state["version"], expected["version"]);
        assert_eq!(state["stats"], expected["stats"]);
        assert_eq!(state["queries"].as_array().unwrap().len(), 1);
    }
}
