use super::*;
use crate::collab::replay::{ReplaySessions, SessionBinding};
use crate::collab::repo::BindRepoPorts;
use crate::collab::store::R;
use crate::policy::fs_paths::{PathFs, RealFs};
use crate::rbac::audit::AuditEvent;
use serde_json::json;
use std::{cell::RefCell, fs};

fn read_wire(result: R<Value>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(e) => {
            json!({ "err": { "code": e.code.as_str(), "reason": e.reason, "message": e.message } })
        }
    }
}

#[test]
fn repo_binding_vectors() {
    let h = open();
    let project = h.svc.create_project(&owner(), "repo", None).unwrap().id;
    h.svc
        .add_member(&owner(), &project, "u-member", "member")
        .unwrap();
    for path in ["home", "repo/sub", "home/private", "bare"] {
        fs::create_dir_all(h.dir.path().join(path)).unwrap();
    }
    fs::write(h.dir.path().join("file"), "").unwrap();
    let path = |relative: &str| h.dir.path().join(relative).to_str().unwrap().to_owned();
    let canon = RealFs.realpath(&path("repo")).unwrap();
    let bare = RealFs.realpath(&path("bare")).unwrap();
    let calls = RefCell::new(Vec::<Vec<String>>::new());
    let git = |cwd: &str, args: &[&str]| {
        calls
            .borrow_mut()
            .push(args.iter().map(|s| (*s).to_owned()).collect());
        match args {
            ["rev-parse", "--is-bare-repository"] => {
                Ok(if cwd == bare { "true" } else { "false" }.to_owned())
            }
            ["rev-parse", "--show-toplevel"] => Ok(canon.clone()),
            ["rev-parse", "--verify", "--quiet", "refs/heads/main"] => Ok("commit".to_owned()),
            _ => Err("unknown branch".to_owned()),
        }
    };
    let mut audit_actions = Vec::new();
    let mut audit = |e: &AuditEvent| {
        audit_actions.push(e.action.clone());
        Ok(())
    };
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/collab/repo-binding.json"
    ))
    .unwrap();
    for c in cases {
        let name = c["name"].as_str().unwrap();
        if name == "unbind" {
            let got = read_wire(h.svc.unbind_repo(&owner(), &project, &mut audit).map(|p| {
                if p.repo.is_none() {
                    Value::Null
                } else {
                    json!(true)
                }
            }));
            assert_eq!(got, c["result"], "{name}");
            continue;
        }
        let who = match c["who"].as_str().unwrap() {
            "lead" => owner(),
            "member" => member(&project, ProjectRight::Member, &[]),
            "agent" => Principal {
                kind: Some(PrincipalKind::Agent),
                ..owner()
            },
            other => panic!("unknown fixture principal {other}"),
        };
        let relative = match c["where"].as_str().unwrap() {
            "nested" => "repo/sub",
            "inside" => "home/private",
            p => p,
        };
        let got = h
            .svc
            .bind_repo(
                &who,
                &project,
                &path(relative),
                c["branch"].as_str().unwrap(),
                &mut BindRepoPorts {
                    home: Some(&path("home")),
                    fs: &RealFs,
                    git: &git,
                    audit: &mut audit,
                },
            )
            .map(|p| {
                let repo = p.repo.unwrap();
                json!({ "canonical": repo.repo_path == canon, "branch": repo.base_branch })
            });
        assert_eq!(read_wire(got), c["result"], "{name}");
        assert_eq!(json!(calls.take()), c["calls"], "{name}");
    }
    assert_eq!(audit_actions, ["project.repo.bind", "project.repo.unbind"]);
}

struct Sessions<'a> {
    case: &'a Value,
    fixture: &'a Value,
    reads: RefCell<Vec<&'static str>>,
}
impl ReplaySessions for Sessions<'_> {
    fn session(&self, id: &str) -> R<Option<SessionBinding>> {
        self.reads.borrow_mut().push("session");
        Ok(
            (self.case["session"].as_str() == Some(id)).then(|| SessionBinding {
                id: id.to_owned(),
                owner: self.case["owner"].as_str().unwrap().to_owned(),
                scope: self.case["scope"].as_str().unwrap().to_owned(),
            }),
        )
    }
    fn events(&self, _: &str) -> R<Vec<Value>> {
        self.reads.borrow_mut().push("events");
        Ok(self.fixture["events"].as_array().unwrap().clone())
    }
    fn messages(&self, _: &str) -> R<Vec<Value>> {
        self.reads.borrow_mut().push("messages");
        Ok(self.fixture["messages"].as_array().unwrap().clone())
    }
}

struct ReplayMask([String; 3]);
impl RedactionPort for ReplayMask {
    fn text(&self, s: &str) -> String {
        self.0.iter().fold(s.to_owned(), |text, marker| {
            text.replace(marker, "[masked]")
        })
    }
    fn value(&self, v: &Value) -> Value {
        match v {
            Value::String(s) => json!(self.text(s)),
            Value::Array(a) => Value::Array(a.iter().map(|x| self.value(x)).collect()),
            Value::Object(o) => {
                Value::Object(o.iter().map(|(k, v)| (k.clone(), self.value(v))).collect())
            }
            other => other.clone(),
        }
    }
}

#[test]
fn replay_vectors() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/collab/replay.json"
    ))
    .unwrap();
    let trace = fixture["traceId"].as_str().unwrap();
    let span = fixture["spanId"].as_str().unwrap();
    let session = fixture["sessionId"].as_str().unwrap();
    let marker = fixture["marker"].as_str().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let ids = Arc::new(Seq::default());
    let store = CollabStore::open(
        &dir.path().join("collab.sqlite"),
        StoreOptions::new(Arc::new(Clk(Arc::new(AtomicI64::new(1)))), ids.clone()),
    )
    .unwrap();
    let svc = CollabService::new(
        store,
        Ports {
            redact: Some(Box::new(ReplayMask([
                marker.to_owned(),
                trace.to_owned(),
                span.to_owned(),
            ]))),
            ..Ports::default()
        },
        ids,
    );
    let p = svc
        .store()
        .create_project("Fixture", "u-owner", None, Some("project"))
        .unwrap();
    svc.store()
        .insert_trace(trace, &p.id, "sender", span, None)
        .unwrap();
    svc.store()
        .insert_span(span, trace, None, "receiver", "delegate", None, None)
        .unwrap();
    svc.store().bind_session(span, session).unwrap();

    for c in fixture["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let who = if c["who"] == "lead" {
            owner()
        } else {
            member(&p.id, ProjectRight::Member, &[])
        };
        let sessions = Sessions {
            case: c,
            fixture: &fixture,
            reads: RefCell::default(),
        };
        let got = svc
            .replay(&who, trace, c["span"].as_str().unwrap(), Some(&sessions))
            .map(|r| r.to_value());
        assert_eq!(read_wire(got), c["result"], "{name}");
        assert_eq!(json!(sessions.reads.take()), c["reads"], "{name}");
    }
}
