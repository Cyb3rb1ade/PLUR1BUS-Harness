//! Parity mode B: TypeScript writes the store files, Rust reads and writes them, TypeScript reads them again
//! (`tests/core-parity/store-b-driver.ts`, built on the P4-02 helper `store-roundtrip.ts`). Needs Node (`PLUR1BUS_NODE`
//! or `node` on PATH) with the workspace's TypeScript sources, like the other mixed-language tests.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use plur1bus_store::rusqlite::ErrorCode;
use plur1bus_store::{migrate, Store, StoreError, StoreSpec, Synchronous};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn driver(command: &str, dir: &Path) -> String {
    let node = std::env::var_os("PLUR1BUS_NODE").unwrap_or_else(|| "node".into());
    let output = Command::new(&node)
        .current_dir(root())
        .args([
            "--experimental-strip-types",
            "--conditions=source",
            "--no-warnings=ExperimentalWarning",
            "tests/core-parity/store-b-driver.ts",
            command,
        ])
        .arg(dir)
        .output()
        .unwrap_or_else(|e| {
            panic!("could not run Node {node:?}: {e}. Install Node and run `pnpm test:prep`.")
        });
    assert!(
        output.status.success(),
        "store-b-driver {command}: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

/// The session store as `packages/core/src/session/store.ts` opens it.
fn session_spec(version: u32) -> StoreSpec {
    StoreSpec {
        foreign_keys: true,
        synchronous: Synchronous::Normal,
        ..StoreSpec::new("session", version)
    }
}

#[test]
fn typescript_store_files_round_trip_through_the_rust_store() {
    let dir = tempfile::tempdir().unwrap();
    let dir = dir.path();
    driver("prepare", dir);
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
    let version = manifest["sessionVersion"].as_u64().unwrap() as u32;
    assert!(version >= 9, "the session store is at v9 or later");

    // Every older version is refused as it is: Phase 4's Rust store never migrates on its own.
    for v in 1..version {
        let path = dir.join(format!("session-v{v}.sqlite"));
        let before = std::fs::read(&path).unwrap();
        let err = Store::open(&path, &session_spec(version)).err().unwrap();
        assert!(
            matches!(err, StoreError::OlderSchema { found, expected, .. } if found == v && expected == version),
            "v{v}: {err}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), before, "v{v} untouched");
    }

    // The current version: Rust writes a session and a message (FTS triggers fire), and enforces the foreign keys the
    // TypeScript store enforces.
    let written = dir.join("session-rust.sqlite");
    std::fs::copy(dir.join(format!("session-v{version}.sqlite")), &written).unwrap();
    let mut store = Store::open(&written, &session_spec(version)).unwrap();
    store
        .write(|tx| {
            tx.execute(
                "INSERT INTO sessions (id, kind, agent_id, owner, scope, created_at, updated_at)
                 VALUES ('s-rust', 'direct', 'bernd', 'user:v1:o', 'private', 1, 1)",
                [],
            )?;
            tx.execute(
                "INSERT INTO messages (id, session_id, seq, role, text, tokens, created_at)
                 VALUES ('m-rust', 's-rust', 1, 'user', 'rustwritten words', 2, 1)",
                [],
            )
        })
        .unwrap();
    let orphan = store
        .write(|tx| {
            tx.execute(
                "INSERT INTO messages (id, session_id, seq, role, text, tokens, created_at)
                 VALUES ('m-orphan', 'no-such-session', 1, 'user', 'x', 1, 1)",
                [],
            )
        })
        .unwrap_err();
    assert!(
        matches!(&orphan, StoreError::Sqlite(e) if e.sqlite_error_code() == Some(ErrorCode::ConstraintViolation)),
        "{orphan}"
    );
    drop(store);

    // A store whose TypeScript code never touches the pragma: Rust must do with an orphan row exactly what node:sqlite
    // did with it when it prepared the file. Node 24 enforces (`enableForeignKeyConstraints` defaults to true).
    let node = &manifest["nodeForeignKeys"];
    assert_eq!(
        node["pragma"], true,
        "PRAGMA foreign_keys on an untouched node:sqlite connection"
    );
    assert_eq!(
        node["orphanRefused"], true,
        "node:sqlite refused the orphan row"
    );
    let fk = dir.join("fk-declared-rust.sqlite");
    std::fs::copy(dir.join("fk-declared.sqlite"), &fk).unwrap();
    let mut store = Store::open(&fk, &StoreSpec::new("fk-declared", 1)).unwrap();
    let refused = store
        .write(|tx| tx.execute("INSERT INTO c VALUES (7)", []))
        .unwrap_err();
    assert!(
        matches!(&refused, StoreError::Sqlite(e) if e.sqlite_error_code() == Some(ErrorCode::ConstraintViolation)),
        "{refused}"
    );
    drop(store);
    // Only a store that asks for it runs without enforcement; the row it leaves is what `verify` reads below.
    let off = StoreSpec {
        foreign_keys: false,
        ..StoreSpec::new("fk-declared", 1)
    };
    let mut store = Store::open(&fk, &off).unwrap();
    store
        .write(|tx| tx.execute("INSERT INTO c VALUES (7)", []))
        .unwrap();
    drop(store);

    // The explicit runner with the TypeScript migration texts reaches the schema the TypeScript migrate() wrote.
    let steps: Vec<String> = manifest["sessionMigrations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_owned())
        .collect();
    let steps: Vec<&str> = steps.iter().map(String::as_str).collect();
    let migrated = dir.join("session-migrated-by-rust.sqlite");
    std::fs::copy(dir.join("session-v1.sqlite"), &migrated).unwrap();
    assert_eq!(
        migrate(&migrated, &session_spec(version), &steps).unwrap(),
        version
    );

    let seen: Value = serde_json::from_str(&driver("verify", dir)).unwrap();
    let session = &seen["session"];
    assert_eq!(session["check"]["userVersion"], version);
    assert_eq!(session["check"]["integrity"], "ok");
    assert_eq!(session["check"]["foreignKeyViolations"], 0);
    assert_eq!(session["check"]["journalMode"], "wal");
    assert_eq!(
        session["sessions"],
        serde_json::json!([{"id":"s-rust","kind":"direct","agent_id":"bernd","owner":"user:v1:o"}])
    );
    assert_eq!(session["messages"][0]["id"], "m-rust");
    assert_eq!(session["messages"].as_array().unwrap().len(), 1);
    assert_eq!(
        session["search"], 1,
        "the FTS index TypeScript searches has the Rust row"
    );

    assert_eq!(seen["fkDeclared"]["check"]["foreignKeyViolations"], 1);
    assert_eq!(
        seen["fkDeclared"]["children"],
        serde_json::json!([{"pid": 7}])
    );

    assert_eq!(seen["migrated"]["userVersion"], version);
    assert_eq!(seen["migrated"]["sameSchema"], true);
    assert_eq!(seen["migrated"]["integrity"], "ok");
}
