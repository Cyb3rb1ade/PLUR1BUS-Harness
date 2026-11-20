use super::*;
use crate::coding::actions::{ActionInput, CodingActions, WorktreeDiff};
use crate::coding::gate::{GateGit, WorktreeEntry, WorktreeFiles};
use crate::coding::root::{coding_root, RootProbe};
use crate::coding::verifier::{CheckKind, Verifier, VerifierCommand, VerifierResult};
use crate::collab::repo::RepoGit;
use crate::identity::principals::derive_user_principal;
use crate::policy::fs_paths::FileKind;
use crate::policy::fs_paths::{PathFs, PathRoot, RealFs};
use crate::rbac::{
    audit::AuditEvent,
    types::{PrincipalKind, Role},
};
use crate::sessions::types::BeginOptions;
use crate::sessions::{CreateSessionInput, SessionKind};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::atomic::AtomicUsize;

struct Fixed;
impl Clock for Fixed {
    fn now(&self) -> i64 {
        100
    }
}

#[derive(Default)]
struct Ids(AtomicUsize);
impl IdSource for Ids {
    fn next_id(&self) -> String {
        self.0.fetch_add(1, Ordering::Relaxed).to_string()
    }
}

struct Roots {
    root: String,
    home: String,
    grant: Cell<bool>,
}
impl CodeRoots for Roots {
    fn root(&self, _: &str, path: &str) -> R<CanonicalPath> {
        let git = |_: &str, _: &[&str]| Ok(self.root.clone());
        let allowed = [PathRoot {
            id: "workspace".to_owned(),
            path: self.root.clone(),
            identity: None,
        }];
        coding_root(
            path,
            &RootProbe {
                fs: &RealFs,
                git: &git,
                core_home: &self.home,
                roots: if self.grant.get() { &allowed } else { &[] },
                deny: &json!([]),
            },
        )
    }
    fn branch(&self, _: &str) -> Option<String> {
        Some("main".to_owned())
    }
}

#[derive(Default)]
struct Authority {
    asked: usize,
    ended: Rc<RefCell<Vec<String>>>,
    lease: Rc<RefCell<Option<PresenceLease>>>,
}
impl GrantSource for Authority {
    fn list(&self, _: &str, _: &str, _: &str) -> Vec<Value> {
        vec![]
    }
    fn get(&self, _: &str) -> Option<Value> {
        None
    }
}
impl CodingAuthority for Authority {
    fn agent_active(&self, agent: &str) -> bool {
        agent == "worker"
    }
    fn linked_caller(&self, _: &Principal, caller: &str) -> bool {
        caller == "fixture"
    }
    fn resolve_person(&self, id: &str) -> Option<Principal> {
        (id == "owner").then(|| Principal {
            kind: Some(PrincipalKind::Person),
            ..Principal::new(id, Role::Owner)
        })
    }
    fn request_folder(&mut self, request: FolderRequest<'_>) -> R<String> {
        self.asked += 1;
        *self.lease.borrow_mut() = Some(request.lease);
        Ok("folder-fixture".to_owned())
    }
    fn folder_pending(&self, _: &str, _: &str) -> bool {
        true
    }
    fn cancel_folder(&mut self, _: &str, _: &str) {}
    fn end_task(&mut self, id: &str) {
        self.ended.borrow_mut().push(id.to_owned());
    }
}

fn open_request<'a>(root: &'a str, session: Option<&'a str>, interactive: bool) -> CodeOpen<'a> {
    CodeOpen {
        agent: "worker",
        root,
        session,
        card: None,
        memory: None,
        interactive: Some(interactive),
    }
}

#[test]
fn coding_session_vectors() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/coding/sessions.json"
    ))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = |leaf: &str| {
        let p = dir.path().join(leaf);
        std::fs::create_dir(&p).unwrap();
        RealFs.realpath(p.to_str().unwrap()).unwrap()
    };
    let root = path("repo");
    let home = path("home");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let ids = Arc::new(Ids::default());
        let mut store = SessionStore::open_memory(Arc::new(Fixed), ids.clone()).unwrap();
        let owner = Principal {
            kind: Some(PrincipalKind::Person),
            ..Principal::new("owner", Role::Owner)
        };
        let roots = Roots {
            root: root.clone(),
            home: home.clone(),
            grant: Cell::new(!matches!(name, "no grant" | "interactive request")),
        };
        let mut authority = Authority::default();
        let ended = authority.ended.clone();
        let observed_lease = authority.lease.clone();
        let mut audit = Vec::new();
        let mut sink = |event: &AuditEvent| {
            audit.push(event.action.clone());
            Ok(())
        };
        let mut coding = CodingSessions::default();
        let abort = AbortSignal::new();
        let conn = CodeConnection {
            id: "fixture",
            caller: "fixture",
            local_cli: true,
            surface: 1,
            abort: &abort,
        };
        let mut ports = SessionPorts {
            roots: &roots,
            authority: &mut authority,
            project: None,
            clock: &Fixed,
            ids: ids.as_ref(),
            audit: &mut sink,
        };

        let out: R<Value> = (|| match name {
            case if case.starts_with("prepare ") => {
                let input = CreateSessionInput::new(
                    SessionKind::Acp,
                    "worker",
                    &derive_user_principal("owner").unwrap(),
                );
                let session = store.create_session(&input).unwrap();
                coding.open(
                    open_request(&root, Some(&session.id), false),
                    &owner,
                    &conn,
                    &mut store,
                    &mut ports,
                )?;
                if case == "prepare closed" {
                    coding.connection_closed("fixture", ports.authority);
                }
                if case == "prepare revoked" {
                    roots.grant.set(false);
                }
                let incorrect = derive_user_principal("other").unwrap();
                let prepared = coding.prepare(
                    &CodeTurn {
                        session: &session.id,
                        owner: if case == "prepare wrong owner" {
                            &incorrect
                        } else {
                            &session.owner
                        },
                        agent: "worker",
                        caller: Some("fixture"),
                        connection: Some("fixture"),
                        background: case == "prepare role",
                        coding_agent: false,
                    },
                    &store,
                    &ports,
                )?;
                Ok(json!({ "coding": prepared.coding, "project": prepared.project }))
            }
            "ACP mode" | "different connection" | "grant revoked" => {
                let input = CreateSessionInput::new(
                    SessionKind::Acp,
                    "worker",
                    &derive_user_principal("owner").unwrap(),
                );
                let session = store.create_session(&input).unwrap();
                coding.open(
                    open_request(&root, Some(&session.id), name == "interactive request"),
                    &owner,
                    &conn,
                    &mut store,
                    &mut ports,
                )?;
                let prior = coding.approver("fixture", &session.id, "owner", 1);
                if name == "grant revoked" {
                    roots.grant.set(false);
                }
                let change_conn = CodeConnection {
                    id: if name == "different connection" {
                        "other"
                    } else {
                        "fixture"
                    },
                    ..conn
                };
                let changed = coding.set_mode(
                    &session.id,
                    Mode::Chat,
                    &owner,
                    &change_conn,
                    &store,
                    &mut ports,
                )?;
                let after = coding.approver("fixture", &session.id, "owner", 1);
                coding.connection_closed("fixture", ports.authority);
                let task = prior.task.as_deref().unwrap();
                Ok(json!({ "state": "open", "changed": changed, "mode": "chat",
                        "before": prior.mode.map(Mode::as_str), "surface": prior.surface, "after": after.mode.map(Mode::as_str),
                        "taskAlive": coding.has_task(task, &session.id, Some("owner")), "taskEnded": ended.borrow().contains(&task.to_owned()) }))
            }
            "foreign source" => {
                let input = CreateSessionInput::new(
                    SessionKind::Direct,
                    "worker",
                    &derive_user_principal("other").unwrap(),
                );
                let other = store.create_session(&input).unwrap();
                coding.open(
                    open_request(&root, Some(&other.id), name == "interactive request"),
                    &owner,
                    &conn,
                    &mut store,
                    &mut ports,
                )?;
                Ok(json!(true))
            }
            "interactive request" => {
                let opened = coding.open(
                    open_request(&root, None, name == "interactive request"),
                    &owner,
                    &conn,
                    &mut store,
                    &mut ports,
                )?;
                let OpenState::GrantRequired(id) = opened.state else {
                    panic!("expected approval")
                };
                let lease = observed_lease.borrow().clone().unwrap();
                let before = lease.active();
                coding.connection_closed("fixture", ports.authority);
                Ok(
                    json!({ "state": "grant-required", "grant": id, "before": before, "afterClose": lease.active() }),
                )
            }
            _ => {
                let opened = coding.open(
                    open_request(&root, None, name == "interactive request"),
                    &owner,
                    &conn,
                    &mut store,
                    &mut ports,
                )?;
                let resumed = coding.open(
                    open_request(
                        &root,
                        Some(&opened.session.id),
                        name == "interactive request",
                    ),
                    &owner,
                    &conn,
                    &mut store,
                    &mut ports,
                )?;
                let binding = store.worktree(&opened.session.id).unwrap().unwrap();
                Ok(
                    json!({ "state": "open", "kind": opened.session.kind.as_str(),
                        "sameSession": opened.session.id == resumed.session.id,
                        "matchesRoot": binding.root == opened.root }),
                )
            }
        })();
        let wire = match out {
            Ok(value) => json!({ "ok": value }),
            Err(e) => {
                json!({"err": { "code": if e.reason.as_deref() == Some("root-not-granted") { "E_APPROVAL_REQUIRED" } else { match e.code {
                C::Conflict => "E_CONFLICT", C::NotFound => "E_NOT_FOUND", C::Unauthorized => "E_DENIED", _ => e.code.as_str()
            } }, "reason": e.reason, "message": e.message }})
            }
        };
        assert_eq!(wire, case["result"], "{name}");
        assert_eq!(json!(audit), case["audit"], "{name}");
        assert_eq!(json!(authority.asked), case["asked"], "{name}");
        assert_eq!(json!(ended.borrow().len()), case["ended"], "{name}");
    }
}

const CHECK_CONFIG: &str = ".plur1bus-verifiers.json";
const CHECK_MANIFEST: &str = r#"{"commands":{"format":["fixture-format"],"lint":["fixture-lint"],"typecheck":["fixture-typecheck"],"test":["fixture-test"]},"networkAllowed":true}"#;

struct AdvisoryFixture<'a> {
    case: &'a str,
    roots: &'a Roots,
    calls: RefCell<Vec<Value>>,
}

impl AdvisoryFixture<'_> {
    fn manifest(&self) -> String {
        match self.case {
            "uncommitted" => format!("{CHECK_MANIFEST} "),
            "invalid" => "{}".to_owned(),
            _ => CHECK_MANIFEST.to_owned(),
        }
    }
}

impl WorktreeFiles for AdvisoryFixture<'_> {
    fn canonical(&self, path: &str) -> R<String> {
        Ok(path.to_owned())
    }
    fn metadata(&self, _: &str, name: &str) -> R<Option<WorktreeEntry>> {
        Ok((name == CHECK_CONFIG).then(|| WorktreeEntry {
            kind: FileKind::File,
            size: self.manifest().len() as u64,
            links: 1,
        }))
    }
    fn read(&self, _: &str, name: &str, max: usize) -> R<Option<Vec<u8>>> {
        assert_eq!(max, 1_048_576);
        Ok((name == CHECK_CONFIG).then(|| self.manifest().into_bytes()))
    }
    fn windows(&self) -> bool {
        cfg!(windows)
    }
}

impl RepoGit for AdvisoryFixture<'_> {
    fn read(&self, root: &str, args: &[&str]) -> Result<String, String> {
        assert_eq!(root, self.roots.root);
        assert_eq!(args, ["rev-parse", "--verify", "--quiet", "HEAD"]);
        Ok("a".repeat(40) + "\n")
    }
}

impl GateGit for AdvisoryFixture<'_> {
    fn committed(&self, _: &str, head: &str, name: &str) -> R<Option<String>> {
        assert_eq!(head, "a".repeat(40));
        Ok((name == CHECK_CONFIG).then(|| CHECK_MANIFEST.to_owned()))
    }
}

impl WorktreeDiff for AdvisoryFixture<'_> {
    fn worktree_diff(&self, _: &CanonicalPath) -> R<String> {
        panic!("advisory checks do not produce a diff");
    }
}

impl Verifier for AdvisoryFixture<'_> {
    fn run(
        &self,
        _: &str,
        command: &VerifierCommand,
        network_allowed: bool,
        abort: &AbortSignal,
    ) -> VerifierResult {
        self.calls.borrow_mut().push(json!({
            "kind": command.kind,
            "argv": command.argv,
            "networkAllowed": network_allowed,
        }));
        if self.case == "abort during check" {
            abort.abort();
        }
        if self.case == "revoked during check" {
            self.roots.grant.set(false);
        }
        VerifierResult {
            ok: true,
            exit_code: Some(0),
            reason: None,
            output: "check fixture".to_owned(),
        }
    }
}

#[test]
fn coding_advisory_vectors() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/coding/advisory.json"
    ))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = |leaf: &str| {
        let p = dir.path().join(leaf);
        std::fs::create_dir(&p).unwrap();
        RealFs.realpath(p.to_str().unwrap()).unwrap()
    };
    let roots = Roots {
        root: path("advisory-repo"),
        home: path("core-home"),
        grant: Cell::new(true),
    };
    for c in cases {
        let case = c["name"].as_str().unwrap();
        roots.grant.set(true);
        let ids = Arc::new(Ids::default());
        let mut store = SessionStore::open_memory(Arc::new(Fixed), ids.clone()).unwrap();
        let fixture = AdvisoryFixture {
            case,
            roots: &roots,
            calls: RefCell::default(),
        };
        let mut authority = Authority::default();
        let person = authority.resolve_person("owner").unwrap();
        let mut audit = |_: &AuditEvent| Ok(());
        let mut ports = SessionPorts {
            roots: &roots,
            authority: &mut authority,
            project: None,
            clock: &Fixed,
            ids: ids.as_ref(),
            audit: &mut audit,
        };
        let mut coding = CodingSessions::default();
        let connection = CodeConnection {
            id: "fixture",
            caller: "fixture",
            local_cli: true,
            surface: 1,
            abort: &AbortSignal::new(),
        };
        let opened = coding
            .open(
                open_request(&roots.root, None, false),
                &person,
                &connection,
                &mut store,
                &mut ports,
            )
            .unwrap();
        let id = &opened.session.id;
        if case == "busy" {
            store
                .begin_turn(id, "fixture", 1, &BeginOptions::default())
                .unwrap();
        }
        let signal = AbortSignal::new();
        if case == "aborted" {
            signal.abort();
        }
        let actions = CodingActions {
            coding: &coding,
            store: &store,
            sessions: &ports,
            files: &fixture,
            git: &fixture,
            verifier: &fixture,
            git_view: &fixture,
            network_approved: case != "host offline",
            redact: &|text| text.replace("fixture", "[masked]"),
        };
        let result = actions.check(
            &ActionInput {
                session: id,
                who: &person,
                caller: Some("fixture"),
                task: None,
            },
            (case == "lint only").then_some(CheckKind::Lint),
            &signal,
        );
        let calls = fixture.calls.take();
        let result = match result {
            Ok(result) => {
                let checks: Vec<_> = result.checks.into_iter().map(|(kind, result)| {
                    json!({ "kind": kind, "ok": result.ok, "exitCode": result.exit_code, "output": result.output })
                }).collect();
                let mut answer = json!({ "ok": result.ok, "checks": checks });
                if result.aborted {
                    answer["reason"] = json!("aborted");
                }
                json!({ "ok": answer, "calls": calls })
            }
            Err(error) => {
                let code = match (error.code, error.reason.as_deref()) {
                    (_, Some("root-not-granted")) => "E_APPROVAL_REQUIRED",
                    (C::Conflict, _) => "E_CONFLICT",
                    (C::Invalid, _) => "E_INVALID_PARAMS",
                    (code, _) => code.as_str(),
                };
                json!({ "err": { "code": code, "message": error.message, "reason": error.reason }, "calls": calls })
            }
        };
        let mut expected = c["result"].clone();
        if let Some(allowed) = c["divergence"]["networkAllowed"].as_bool() {
            for call in expected["calls"].as_array_mut().unwrap() {
                assert_eq!(call["networkAllowed"], true);
                call["networkAllowed"] = json!(allowed);
            }
        }
        assert_eq!(result, expected, "{case}");
    }
}
