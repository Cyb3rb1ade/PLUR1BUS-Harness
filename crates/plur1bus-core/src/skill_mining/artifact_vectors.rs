use super::*;
use crate::rbac::{
    audit::AuditEvent,
    types::{PrincipalKind, Role},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;

fn owner(role: Role) -> Principal {
    Principal {
        kind: Some(PrincipalKind::Person),
        ..Principal::new("ada", role)
    }
}
fn scoped() -> Scope {
    Scope {
        owner: "fixture-owner".into(),
        agent_id: "alpha".into(),
        scope: "workspace".into(),
    }
}

struct Runtime;
impl Clock for Runtime {
    fn now(&self) -> i64 {
        10
    }
}
impl Authority for Runtime {
    fn current(&self, _: &str) -> Option<Principal> {
        Some(owner(Role::Owner))
    }
    fn allows(&self, _: &Scope, _: &Principal) -> bool {
        true
    }
}
struct File {
    path: String,
    bytes: RefCell<Vec<u8>>,
}
impl Files for File {
    fn snapshot(&self, _: &Scope, path: &str, _: usize) -> R<Snapshot> {
        assert_eq!(path, "NOTES.md");
        Ok(Snapshot {
            canonical: self.path.clone(),
            bytes: self.bytes.borrow().clone(),
        })
    }
}
#[derive(Default)]
struct Proposals(Vec<Value>);
impl Queue for Proposals {
    fn propose(&mut self, _: &Scope, value: Change<'_>) -> R<String> {
        self.0
            .push(json!({"text":value.text,"oldHash":value.old_hash,"author":value.author}));
        Ok("proposal".into())
    }
}

fn projection(data: &Inspection) -> Value {
    json!({"author":data.author,"hash":data.hash})
}
fn refusal(value: R<()>) -> Value {
    match value {
        Ok(()) => Value::Null,
        Err(e) if e.code == CollabErrorCode::Unauthorized => json!("E_DENIED"),
        Err(e) => panic!("{e:?}"),
    }
}

#[test]
fn artifact_authorship_is_exact_and_human_files_still_require_review() {
    let expected: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/skills/artifact-provenance.json"
    ))
    .unwrap();
    let db = Store::open(Path::new(":memory:")).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("NOTES.md");
    let path = path.to_str().unwrap();
    let files = File {
        path: path.into(),
        bytes: RefCell::new(b"Original fixture".to_vec()),
    };
    let mut requests = Proposals::default();
    let mut events = Vec::new();
    let digest = format!("{:x}", Sha256::digest(path.as_bytes()));
    let mut audit = |e: &AuditEvent| {
        let mut item =
            json!({"action":e.action,"target":if e.target==digest{"artifact"}else{&e.target}});
        if let Some((_, enabled)) = e.detail.iter().find(|(k, _)| k == "enabled") {
            item["enabled"] = enabled.clone();
        }
        events.push(item);
        Ok(())
    };
    let mut s = Service {
        store: &db,
        files: &files,
        authority: &Runtime,
        clock: &Runtime,
        queue: &mut requests,
        audit: &mut audit,
    };
    let scope = scoped();
    let user = owner(Role::Owner);
    let admin = owner(Role::Admin);
    let default_policy = db.approval_required().unwrap();
    let initial = projection(&s.inspect(&scope, &user, "NOTES.md").unwrap());
    let first = s
        .request(&scope, &user, "NOTES.md", "first proposal")
        .unwrap();
    let attribution = refusal(s.attribute(&scope, &admin, "NOTES.md", Author::Agent));
    let policy = refusal(s.set_approval(&scope, &admin, false));
    s.set_approval(&scope, &user, false).unwrap();
    let human = s
        .request(&scope, &user, "NOTES.md", "second proposal")
        .unwrap();
    s.attribute(&scope, &user, "NOTES.md", Author::Agent)
        .unwrap();
    let agent = projection(&s.inspect(&scope, &user, "NOTES.md").unwrap());
    let no_approval = s
        .request(&scope, &user, "NOTES.md", "agent write route")
        .unwrap();
    s.set_approval(&scope, &user, true).unwrap();
    let approval = s
        .request(&scope, &user, "NOTES.md", "third proposal")
        .unwrap();
    *files.bytes.borrow_mut() = b"Manual fixture edit".to_vec();
    let after = projection(&s.inspect(&scope, &user, "NOTES.md").unwrap());
    assert_eq!(
        json!({"initial":initial,"defaultPolicy":default_policy,"humanDefault":first,"refusedAttribution":attribution,
        "refusedPolicy":policy,"humanOptOut":human,"agent":agent,"agentOptOut":no_approval,"agentOptIn":approval,
        "afterManual":after,"proposals":requests.0,"audit":events}),
        expected
    );
}

#[test]
fn artifact_provenance_and_policy_round_trip_in_both_directions() {
    let folder = tempfile::tempdir().unwrap();
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/core-parity/k7c-artifact-driver.ts");
    let driver = |step| {
        let output = std::process::Command::new("node")
            .args(["--experimental-strip-types", "--conditions=source"])
            .arg(&script)
            .arg(step)
            .arg(folder.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    };
    let canonical = driver("seed").trim().to_owned();
    let files = File {
        path: canonical,
        bytes: RefCell::new(b"Fixture bytes".to_vec()),
    };
    let secure = |p: &Path| cfg!(windows) || crate::private_store::default_secure(p);
    let ts = folder.path().join("artifact-from-ts.sqlite");
    let rust = folder.path().join("artifact-from-rust.sqlite");
    let scope = scoped();
    let person = owner(Role::Owner);
    let with = |db: &Store, b: &mut dyn FnMut(&mut Service<'_>)| {
        let mut queue = Proposals::default();
        let mut audit = |_: &AuditEvent| Ok(());
        b(&mut Service {
            store: db,
            files: &files,
            authority: &Runtime,
            clock: &Runtime,
            queue: &mut queue,
            audit: &mut audit,
        });
    };
    {
        let db = Store::open_with_permissions(&ts, &secure).unwrap();
        assert!(!db.approval_required().unwrap());
        with(&db, &mut |s| {
            assert_eq!(
                s.inspect(&scope, &person, "NOTES.md").unwrap().author,
                Author::Agent
            );
            s.set_approval(&scope, &person, true).unwrap();
        });
    }
    {
        let db = Store::open_with_permissions(&rust, &secure).unwrap();
        with(&db, &mut |s| {
            s.attribute(&scope, &person, "NOTES.md", Author::Agent)
                .unwrap();
            s.set_approval(&scope, &person, false).unwrap();
        });
    }
    assert_eq!(driver("verify"), "SKILL_ARTIFACT_MODE_B_OK\n");
    let db = Store::open_with_permissions(&rust, &secure).unwrap();
    with(&db, &mut |s| {
        assert_eq!(
            s.inspect(&scope, &person, "NOTES.md").unwrap().author,
            Author::Human
        )
    });
}
