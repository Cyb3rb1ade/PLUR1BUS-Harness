//! Parity mode B for the approvals store (P4-K K3a): TypeScript writes `approvals.sqlite` at every schema version, Rust
//! opens, migrates, reads and writes it (approvals decided, used and left pending, grants created, used, consumed, revoked,
//! decisions signed), and TypeScript reads the result with the product code, checks chain and signatures with its own
//! verifier, decides and uses what Rust left pending, and verifies again (`tests/core-parity/approvals-b-driver.ts`). A file
//! Rust creates has TypeScript's schema text. Needs Node (`PLUR1BUS_NODE` or `node` on PATH) with the workspace's
//! TypeScript sources, like the other mixed-language tests.
//!
//! Unix only: the grants in the driver sit at POSIX paths, and the TypeScript store judges a path by `process.platform`,
//! so on Windows the driver itself refuses them (`drive-relative`). The Windows leg comes with the path adapter (R-K-12).
#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use plur1bus_core::approvals::keys::StaticKeySource;
use plur1bus_core::approvals::node_codec::{base64_decode, hex_decode};
use plur1bus_core::approvals::signing::{DecisionSigner, Ed25519Signer};
use plur1bus_core::approvals::store::{Binding, DecideInput, RequestInput, Status};
use plur1bus_core::approvals::{AuditPort, Clock, OsRandom};
use plur1bus_core::grants::open::{OpenPermissionStores, PermissionStores, Signing};
use plur1bus_core::grants::store::{CreateGrantInput, GrantMatch, GrantState};
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
            "tests/core-parity/approvals-b-driver.ts",
            command,
        ])
        .arg(dir)
        .output()
        .unwrap_or_else(|e| {
            panic!("could not run Node {node:?}: {e}. Install Node and run `pnpm test:prep`.")
        });
    assert!(
        output.status.success(),
        "approvals-b-driver {command}: {}{}",
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

struct Quiet;

impl AuditPort for Quiet {
    fn record(&mut self, _: &str, _: &Value) -> Result<(), String> {
        Ok(())
    }
}

fn binding(action_hash: &str) -> Binding {
    Binding {
        action_hash: action_hash.into(),
        principal: "christian".into(),
        subject_kind: "agent".into(),
        subject_id: "bernd".into(),
        turn_id: "turn1".into(),
        task_id: "t1".into(),
        session_id: "s1".into(),
    }
}

fn open(
    path: &Path,
    key: &[u8],
    now: i64,
    signer: Option<Arc<dyn DecisionSigner>>,
) -> PermissionStores {
    PermissionStores::open(OpenPermissionStores {
        path,
        db: Default::default(),
        keys: &StaticKeySource::new(key).unwrap(),
        clock: Arc::new(At(now)),
        random: Arc::new(OsRandom),
        request_ttl_ms: None,
        max_grant_days: None,
        home: Some("/home/test-user".into()),
        signing: signer.map_or(Signing::None, Signing::Signer),
    })
    .unwrap()
}

fn decide(s: &mut PermissionStores, id: &str, nonce: &str) {
    let d = DecideInput {
        request_id: id.into(),
        nonce: nonce.into(),
        approve: true,
        person: "christian".into(),
        surface: 3,
        delegable: false,
    };
    assert_eq!(s.decide(&d).unwrap(), Ok(true));
}

/// What Rust writes into every file; returns the request it leaves pending for TypeScript.
fn rust_writes(s: &mut PermissionStores) -> Value {
    let full = s
        .request(&RequestInput {
            bound: binding("h-rust-2"),
            capability: "fs.write".into(),
            detail: None,
        })
        .unwrap();
    decide(s, &full.id, &full.nonce);
    assert_eq!(
        s.consume(&full.id, &binding("h-rust-2")).unwrap(),
        Ok(false)
    );
    let left = s
        .request(&RequestInput {
            bound: binding("h-rust"),
            capability: "fs.write".into(),
            detail: None,
        })
        .unwrap();
    let mut g = CreateGrantInput::new(
        "fs.read",
        "christian",
        "bernd",
        "always",
        GrantMatch::Capability,
        "christian",
        2,
    );
    g.attested_via = Some("attested:rust-test".into());
    let created = s.create_grant(&mut Quiet, &g).unwrap();
    s.mark_used(&mut Quiet, created["id"].as_str().unwrap())
        .unwrap();
    json!({ "pending": left.id, "pendingNonce": left.nonce, "full": full.id, "grant": created["id"] })
}

#[test]
fn typescript_approval_files_round_trip_through_the_rust_port() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    driver("prepare", dir);
    let m: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(m["version"], 4);
    let key = hex_decode(m["key"].as_str().unwrap());
    let signer: Arc<dyn DecisionSigner> = Arc::new(
        Ed25519Signer::from_pkcs8(&base64_decode(m["signing"].as_str().unwrap())).unwrap(),
    );
    // A minute later: inside the ten minutes a once grant lives unused.
    let now = m["now"].as_i64().unwrap() + 60_000;
    let mut files = serde_json::Map::new();

    for v in ["v1", "v2", "v3", "v4"] {
        let path = dir.join(format!("approvals-{v}-rust.sqlite"));
        std::fs::copy(dir.join(format!("approvals-{v}.sqlite")), &path).unwrap();
        let signed = v == "v4";
        let mut s = open(&path, &key, now, signed.then(|| Arc::clone(&signer)));
        let verify = s.verify().unwrap();
        assert!(
            verify.ok(),
            "{v}: the TypeScript chain verifies in Rust: {:?}",
            verify
        );
        let ids = if signed { &m["v4"] } else { &m["ids"] };
        let status = |id: &Value| s.approval(id.as_str().unwrap()).unwrap().unwrap().status;
        assert_eq!(
            (status(&ids["approved"]), status(&ids["denied"])),
            (Status::Used, Status::Denied),
            "{v}"
        );
        let states: Vec<(String, GrantState)> = s
            .inspect(None, None)
            .unwrap()
            .into_iter()
            .map(|g| (g.grant["id"].as_str().unwrap().to_owned(), g.state))
            .collect();
        assert!(
            states.contains(&(ids["cap"].as_str().unwrap().to_owned(), GrantState::Active)),
            "{v}: {states:?}"
        );
        assert!(
            states.contains(&(
                ids["revoked"].as_str().unwrap().to_owned(),
                GrantState::Revoked
            )),
            "{v}: {states:?}"
        );
        if signed {
            // Rust decides the request TypeScript left pending (and signs it), and consumes TypeScript's once grant.
            decide(
                &mut s,
                m["v4"]["pending"].as_str().unwrap(),
                m["v4"]["pendingNonce"].as_str().unwrap(),
            );
            assert_eq!(
                s.consume(m["v4"]["pending"].as_str().unwrap(), &binding("h3"))
                    .unwrap(),
                Ok(false)
            );
            assert!(s
                .consume_once(
                    &mut Quiet,
                    m["v4"]["once"].as_str().unwrap(),
                    "christian",
                    "bernd",
                    "h-once"
                )
                .unwrap());
            let attested = s
                .grant(m["v4"]["attested"].as_str().unwrap())
                .unwrap()
                .unwrap();
            assert_eq!(attested["attestedVia"], "attested:touch-id");
        }
        files.insert(v.to_owned(), rust_writes(&mut s));
        assert!(
            s.verify().unwrap().ok(),
            "{v}: still verifies after the Rust writes"
        );
    }

    let fresh = dir.join("approvals-fresh-rust.sqlite");
    let mut s = open(&fresh, &key, now, None);
    files.insert("fresh".to_owned(), rust_writes(&mut s));
    drop(s);

    std::fs::write(
        dir.join("rust-results.json"),
        json!({ "now": now, "files": files }).to_string(),
    )
    .unwrap();
    let out: Value = serde_json::from_str(&driver("verify", dir)).unwrap();
    for v in ["v1", "v2", "v3", "v4", "fresh"] {
        let e = &out[v];
        assert_eq!(e["userVersion"], 4, "{v}: {e}");
        assert_eq!(
            e["sameSchema"], true,
            "{v}: the schema text is TypeScript's: {e}"
        );
        assert_eq!(e["check"]["integrity"], "ok", "{v}: {e}");
        assert_eq!(
            e["verify"]["ok"], true,
            "{v}: TypeScript verifies what Rust wrote: {e}"
        );
        let sigs = e["signaturesByTypeScript"].as_array().unwrap();
        assert!(sigs.iter().all(|x| *x == json!(true)), "{v}: {e}");
        let want_sigs = if v == "v4" { 4 } else { 0 };
        assert_eq!(
            sigs.len(),
            want_sigs,
            "{v}: two TypeScript and two Rust decisions are signed: {e}"
        );
        assert_eq!(e["verify"]["signatures"]["signedOk"], want_sigs, "{v}: {e}");
        let full = files[v]["full"].as_str().unwrap();
        assert!(
            e["approvals"]
                .as_array()
                .unwrap()
                .contains(&json!([full, "used", false])),
            "{v}: {e}"
        );
        let grant = files[v]["grant"].as_str().unwrap();
        let g = e["grants"]
            .as_array()
            .unwrap()
            .iter()
            .find(|g| g[0] == grant)
            .unwrap();
        assert_eq!(
            (&g[1], &g[2], &g[3]),
            (
                &json!("active"),
                &json!("always"),
                &json!("attested:rust-test")
            ),
            "{v}: {e}"
        );
        assert_eq!(
            g[4],
            json!(now),
            "{v}: the use Rust recorded is read from the chain: {e}"
        );
        let after = &e["typescriptAfterRust"];
        assert_eq!(
            (&after["decided"], &after["used"], &after["verify"]["ok"]),
            (&json!(true), &json!(true), &json!(true)),
            "{v}: {e}"
        );
    }
    let v4 = &out["v4"];
    assert!(
        v4["grants"]
            .as_array()
            .unwrap()
            .iter()
            .any(|g| g[0] == m["v4"]["once"] && g[1] == "consumed"),
        "{v4}"
    );
    assert_eq!(
        v4["typescriptAfterRust"]["verify"]["signatures"]["signedOk"], 5,
        "{v4}"
    );
}
