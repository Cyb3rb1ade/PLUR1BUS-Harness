//! Parity mode B for the collaboration store (P4-K K6a, plan P4-50): TypeScript writes `collab.sqlite` at every schema version,
//! Rust opens it (which migrates it), reads it, and writes through its public methods; TypeScript reads the result with the
//! product code (`tests/core-parity/collab-b-driver.ts`, on the P4-02 helper). Needs Node (`PLUR1BUS_NODE` or `node` on PATH)
//! with the workspace's TypeScript sources.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use plur1bus_core::approvals::js_json::J;
use plur1bus_core::budget::Clock;
use plur1bus_core::collab::board::CardFields;
use plur1bus_core::collab::ids::SystemIds;
use plur1bus_core::collab::migrations::SCHEMA_VERSION;
use plur1bus_core::collab::store::TaskPatch;
use plur1bus_core::collab::{CollabStore, StoreOptions};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

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
            "tests/core-parity/collab-b-driver.ts",
            command,
        ])
        .arg(dir)
        .output()
        .unwrap_or_else(|e| {
            panic!("could not run Node {node:?}: {e}. Install Node and run `pnpm test:prep`.")
        });
    assert!(
        output.status.success(),
        "collab-b-driver {command}: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

struct At(i64);
impl Clock for At {
    fn now(&self) -> i64 {
        self.0
    }
}

fn open(path: &Path, now: i64) -> CollabStore {
    CollabStore::open(
        path,
        StoreOptions::new(Arc::new(At(now)), Arc::new(SystemIds)),
    )
    .unwrap()
}

fn actor() -> J {
    J::obj([("kind", J::s("person")), ("id", J::s("u-owner"))])
}

fn card(title: &str) -> CardFields {
    CardFields {
        title: Some(title.to_owned()),
        ..CardFields::default()
    }
}

#[test]
fn typescript_files_of_every_version_open_in_rust_and_come_back() {
    let dir = tempfile::tempdir().unwrap();
    driver("prepare", dir.path());
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("manifest.json")).unwrap())
            .unwrap();
    let now = manifest["now"].as_i64().unwrap() + 500;
    assert_eq!(manifest["version"].as_u64().unwrap() as u32, SCHEMA_VERSION);

    for v in 1..=SCHEMA_VERSION {
        let to = dir.path().join(format!("collab-v{v}-rust.sqlite"));
        std::fs::copy(dir.path().join(format!("collab-v{v}.sqlite")), &to).unwrap();
        let mut s = open(&to, now);
        assert_eq!(s.user_version().unwrap(), SCHEMA_VERSION, "v{v} migrated");
        let old = s
            .get_project(&format!("prj_b{v}"))
            .unwrap()
            .expect("the TypeScript project is read");
        assert_eq!(old.name, format!("project v{v}"));
        assert_eq!(old.agents, vec!["agent-old".to_owned()]);
        s.add_agent(&old.id, "agent-new").unwrap();
        let id = format!("prj_rust{v}");
        s.create_project("rust project", "u-owner", None, Some(&id))
            .unwrap();
        s.add_member(&id, "u-two", "member").unwrap();
        s.add_agent(&id, "agent-r").unwrap();
        s.board_create_card(
            &id,
            &format!("{id}:backlog"),
            None,
            &card("from rust"),
            &actor(),
            false,
        )
        .unwrap();
        s.close();
    }

    let to = dir.path().join("collab-ts-rust.sqlite");
    std::fs::copy(dir.path().join("collab-ts.sqlite"), &to).unwrap();
    let mut s = open(&to, now);
    let project = manifest["project"].as_str().unwrap();
    let p = s.get_project(project).unwrap().unwrap();
    assert_eq!(p.name, "ts project");
    assert_eq!(p.agents, vec!["agent-a".to_owned()]);
    let (cards, _) = s.board_cards(project, &Default::default()).unwrap();
    assert_eq!(cards.len(), 1);
    assert_eq!(s.get_task("k1").unwrap().unwrap().status, "running");
    assert_eq!(
        s.get_artifact(manifest["artifact"].as_str().unwrap())
            .unwrap()
            .unwrap()
            .body,
        "full body"
    );
    s.add_agent(project, "agent-rust").unwrap();
    s.board_create_card(
        project,
        &format!("{project}:backlog"),
        None,
        &card("rust card"),
        &actor(),
        false,
    )
    .unwrap();
    s.update_task(
        "k1",
        &TaskPatch {
            status: "succeeded".into(),
            result: Some("done".into()),
            ..TaskPatch::default()
        },
    )
    .unwrap();
    s.close();

    let back: Value = serde_json::from_str(&driver("verify", dir.path())).unwrap();
    let versions = back["versions"].as_object().unwrap();
    assert_eq!(versions.len() as u32, SCHEMA_VERSION);
    let first = &versions["1"]["schema"];
    for (v, r) in versions {
        assert_eq!(r["check"]["integrity"], "ok", "v{v} integrity");
        assert_eq!(r["check"]["foreignKeyViolations"], 0, "v{v} foreign keys");
        assert_eq!(
            r["check"]["userVersion"], SCHEMA_VERSION,
            "v{v} user_version"
        );
        assert_eq!(
            &r["schema"], first,
            "v{v} ends on the same schema text as v1"
        );
        assert_eq!(r["old"]["name"], format!("project v{v}"));
        assert_eq!(
            r["old"]["agents"],
            json!(["agent-new", "agent-old"]),
            "v{v}: both agents, as TypeScript lists them"
        );
        assert_eq!(r["mine"]["agents"], json!(["agent-r"]));
        assert_eq!(
            r["mine"]["members"],
            json!([{ "userId": "u-owner", "role": "lead" }, { "userId": "u-two", "role": "member" }])
        );
        assert_eq!(
            r["cards"],
            json!(["from rust"]),
            "v{v}: TypeScript reads the card Rust wrote"
        );
    }
    let ts = &back["ts"];
    assert_eq!(ts["check"]["integrity"], "ok");
    assert_eq!(ts["project"]["agents"], json!(["agent-a", "agent-rust"]));
    assert_eq!(ts["cards"].as_array().unwrap().len(), 2);
    assert_eq!(ts["trace"], json!([["s1", "succeeded"]]));
    assert_eq!(ts["task"], "succeeded");
    assert_eq!(ts["artifact"], "full body");
    assert_eq!(ts["worktree"], "/w/1");
}
