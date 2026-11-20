use super::*;
use crate::collab::handoff::HandoffContext;
use crate::collab::limits::{CollaborationLimitsConfig, TaskClass, TaskLimits};
use crate::collab::ports::RunOutput;
use crate::collab::run::{DelegateRequest, DelegationTarget, TargetContext, TargetRequest};
use crate::collab::store::R;
use crate::collab::types::TargetKind;
use crate::logs::methods::AbortSignal;
use crate::rbac::audit::AuditEvent;
use crate::toolcall::json::{parse, V};
use serde_json::json;
use std::cell::RefCell;

impl crate::budget::IdSource for Seq {
    fn next_id(&self) -> String {
        self.new_id("session")
    }
}

struct FixedClock(Arc<AtomicI64>);
impl Clock for FixedClock {
    fn now(&self) -> i64 {
        self.0.load(Ordering::Relaxed)
    }
}

struct Target<'a> {
    name: &'a str,
    calls: RefCell<Vec<&'static str>>,
    abort: RefCell<Option<AbortSignal>>,
}
impl DelegationTarget for Target<'_> {
    fn kind(&self) -> TargetKind {
        if self.name == "remote review" {
            TargetKind::A2a
        } else {
            TargetKind::Local
        }
    }
    fn accepts(&self, id: &str) -> bool {
        id == "receiver"
    }
    fn acknowledge(&self, _: &TargetRequest<'_>) -> R<V> {
        self.calls.borrow_mut().push("ack");
        let id = if self.name == "wrong ack" {
            "other"
        } else {
            "handoff"
        };
        Ok(V::from_serde(
            &json!({ "schema": "plur1bus.ack/1", "inReplyTo": id, "objective": "Verify report",
            "status": "ok", "blockingQuestions": [] }),
        ))
    }
    fn start(&self, request: &TargetRequest<'_>) -> R<Option<RunOutput>> {
        self.calls.borrow_mut().push("run");
        assert_eq!(request.max_rounds, 3);
        assert_eq!(
            request.budget.limit(),
            if request.contract.is_some() {
                150
            } else {
                131_072
            }
        );
        assert_eq!(
            request.input.text,
            "Verify report\n\nAcceptance criteria:\nEvidence recorded"
        );
        assert_eq!(
            request.scope.unwrap().tool_view,
            if request.contract.is_some() {
                vec!["file.read"]
            } else {
                vec![]
            }
        );
        self.abort.replace(Some(request.cancel.clone()));
        Ok(None)
    }
}

fn output() -> RunOutput {
    RunOutput {
        text: "Fixture output from the worker".to_owned(),
        input_tokens: 2,
        output_tokens: 3,
        partial: false,
    }
}

#[test]
fn run_vectors() {
    let vectors: Vec<Value> =
        serde_json::from_str(include_str!("../../../../fixtures/parity/collab/run.json")).unwrap();
    for case in vectors {
        let name = case["name"].as_str().unwrap();
        let start = case["start"].as_i64().unwrap();
        let now = Arc::new(AtomicI64::new(start));
        let clock = Arc::new(FixedClock(now.clone()));
        let dir = tempfile::tempdir().unwrap();
        let ids = Arc::new(Seq::default());
        let events = Arc::new(MemoryEmitter::default());
        let mut options = StoreOptions::new(clock.clone(), ids.clone());
        options.limits = Some(Box::new(|| {
            let mut limits = CollaborationLimitsConfig::default();
            limits.task_classes[3] = TaskLimits {
                rounds: 3,
                wall_time_ms: 40,
                stall_time_ms: 10,
            };
            limits
        }));
        let db = CollabStore::open(&dir.path().join("collab.sqlite"), options).unwrap();
        let transcripts = (name == "transcript").then(|| {
            use crate::collab::replay::{RunTranscripts, SessionRecorder};
            use crate::sessions::store::SessionStore;
            Arc::new(SessionRecorder(Mutex::new(
                SessionStore::open_memory(clock.clone(), ids.clone()).unwrap(),
            ))) as Arc<dyn RunTranscripts>
        });
        let mut svc = CollabService::new(
            db,
            Ports {
                emit: Box::new(Shared(events.clone())),
                transcripts,
                redact: Some(Box::new(MarkerRedactor)),
                ..Ports::default()
            },
            ids,
        );
        let lead = person("lead", Role::Owner);
        let st = J::obj([(
            "returnTokens",
            J::Num(if name == "cap" { 1.0 } else { 100.0 }),
        )]);
        let project = svc.create_project(&lead, "Fixture", Some(&st)).unwrap().id;
        for id in ["sender", "receiver"] {
            svc.add_agent(&lead, &project, id).unwrap();
        }
        let h = case["handoff"].as_str().and_then(parse);
        let mut admission = input(&lead, &project, "sender", "receiver", "Verify report");
        admission.consult = false;
        admission.call_class = CallClass::Write;
        admission.extra = "Evidence recorded";
        admission.task_id = h.as_ref().map(|_| "sender-task");
        let mut audit = |_: &AuditEvent| Ok(());
        let handle = svc
            .delegate(DelegateRequest {
                admission,
                parent_task: None,
                task_class: TaskClass::CodeSmall,
                contract: h.clone(),
                allowed_tools: &["file.read".to_owned(), "file.write".to_owned()],
                parent_budget: None,
                writer: None,
                cancel: None,
                audit: &mut audit,
            })
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(handle.queued.status, case["initial"], "{name}");
        assert_eq!(project, "prj_1");
        let lookup = |_: &str| Ok(None);
        let no_grant = |_: &str| Ok(None);
        let mut ctx = HandoffContext {
            person: &lead.user_id,
            task_id: "sender-task",
            session_id: "sender-session",
            from_agent: "sender",
            project_id: &project,
            expected: h.as_ref(),
            has_history: false,
            clock: clock.as_ref(),
            approval: &lookup,
            grant: &no_grant,
            audit: &mut audit,
        };
        let target = Target {
            name,
            calls: RefCell::default(),
            abort: RefCell::default(),
        };
        let mut accepted = 0;
        let mut on_accepted = || {
            accepted += 1;
            Ok(())
        };
        let mut task = svc
            .run_target(
                &handle,
                &[&target],
                TargetContext {
                    handoff: h.as_ref().map(|_| &mut ctx),
                    independent_review: name == "remote review",
                    local_checkout: false,
                    on_accepted: Some(&mut on_accepted),
                },
            )
            .unwrap();
        assert_eq!(
            accepted,
            usize::from(h.is_some() && target.calls.borrow().contains(&"run")),
            "{name}"
        );
        let mut active = Vec::new();
        let advance = |ms: i64| now.store(start + ms, Ordering::Relaxed);
        let live = || !target.abort.borrow().as_ref().unwrap().is_aborted();
        match name {
            "progress" => {
                for offset in [9, 18] {
                    advance(offset);
                    assert!(svc.tick().unwrap().is_empty());
                    assert!(svc.report_progress(&handle, Some(output())));
                    active.push(live());
                }
                task = svc.finish_delegation(&handle, Ok(output())).unwrap();
            }
            "deadline" | "stall" => {
                assert!(svc.report_progress(&handle, Some(output())));
                let end = if name == "deadline" {
                    case["deadline"].as_i64().unwrap()
                } else {
                    10
                };
                advance(end - 1);
                assert!(svc.tick().unwrap().is_empty());
                active.push(live());
                advance(end);
                let mut finished = svc.tick().unwrap();
                assert_eq!(finished.len(), 1, "{name}");
                task = finished.pop();
                active.push(live());
                assert!(svc
                    .finish_delegation(&handle, Ok(output()))
                    .unwrap()
                    .is_none());
            }
            "shutdown abandons" => {
                svc.shutdown(0).unwrap();
                assert!(svc.store().is_closed());
                assert!(svc
                    .finish_delegation(&handle, Ok(output()))
                    .unwrap()
                    .is_none());
            }
            "shutdown cooperative" => {
                svc.shutdown(100).unwrap();
                assert!(!svc.store().is_closed());
                assert!(!live());
                let settled = svc
                    .finish_delegation(&handle, Err(CollabError::new(C::Aborted, "cancelled")))
                    .unwrap()
                    .unwrap();
                assert_eq!(settled.status, "cancelled");
                svc.tick().unwrap();
                assert!(svc.store().is_closed());
            }
            "done" | "cap" | "transcript" => {
                task = svc.finish_delegation(&handle, Ok(output())).unwrap()
            }
            "wrong ack" | "wrong target" | "remote review" => {}
            _ => panic!("unknown scenario {name}"),
        }
        let transcript = if name == "transcript" {
            let task = task.as_ref().unwrap();
            Some(transcript_shape(
                &svc.replay(&lead, &task.trace_id, &task.span_id, None)
                    .unwrap(),
            ))
        } else {
            None
        };
        assert_eq!(json!(transcript), case["transcript"], "{name}");
        let finish = task.map(|t| {
            let trace = svc.get_trace(&lead, &t.trace_id).unwrap();
            let span = trace.spans.iter().find(|s| s.span_id == t.span_id).unwrap();
            json!({ "task": t.status, "span": span.status, "error": t.error, "result": t.result,
                "truncated": t.truncated, "targetKind": t.target_kind, "inputTokens": span.input_tokens,
                "outputTokens": span.output_tokens })
        });
        let events: Vec<_> = events.0.lock().unwrap().iter().filter(|e| e.kind.starts_with("delegate.") || e.kind == "chain.abandoned")
            .map(|e| json!({ "type": e.kind, "status": e.data["status"], "inflight": e.data["inflight"] })).collect();
        assert_eq!(json!(finish), case["finish"], "{name}");
        assert_eq!(json!(active), case["active"], "{name}");
        assert_eq!(json!(target.calls.take()), case["calls"], "{name}");
        assert_eq!(json!(events), case["events"], "{name}");
    }
}

fn transcript_shape(replay: &crate::collab::replay::ReplayTranscript) -> Value {
    json!({
        "messages": replay.messages.iter().map(|m| json!([m["role"], m["text"]])).collect::<Vec<_>>(),
        "events": replay.events.iter().map(|e| json!([e["type"], e["data"].get("handoff").is_some(),
            e["data"]["entry"]["kind"], e["data"]["status"]])).collect::<Vec<_>>(),
    })
}

#[test]
fn a_reservation_is_bound_to_a_single_identity_and_run() {
    let h = open();
    let owner = owner();
    let project = setup(&h, &["sender", "receiver", "other"]);
    let writer = h
        .svc
        .reserve_writer(&WriterIdentity {
            principal: &owner,
            project_id: &project,
            from_agent: "sender",
            to_agent: "receiver",
            trace_id: None,
            parent_span_id: None,
        })
        .unwrap();
    let start = |agent, writer, text| {
        let mut args = input(&owner, &project, "sender", agent, text);
        args.consult = false;
        args.call_class = CallClass::Write;
        h.svc.delegate(DelegateRequest {
            admission: args,
            parent_task: None,
            task_class: TaskClass::CodeSmall,
            contract: None,
            allowed_tools: &[],
            parent_budget: None,
            writer: Some(writer),
            cancel: None,
            audit: &mut |_: &AuditEvent| Ok(()),
        })
    };
    assert!(
        matches!(start("other", writer, "wrong worker"), Err(error) if error.code == C::Unauthorized)
    );
    let handle = start("receiver", writer, "first task").unwrap();
    h.svc.release_writer(writer);
    let identity = WriterIdentity {
        principal: &owner,
        project_id: &project,
        from_agent: "sender",
        to_agent: "receiver",
        trace_id: None,
        parent_span_id: None,
    };
    for _ in 0..3 {
        h.svc.reserve_writer(&identity).unwrap();
    }
    assert!(
        matches!(h.svc.reserve_writer(&identity), Err(error) if error.guardrail == Some(GuardrailReason::Fanout))
    );
    assert!(
        matches!(start("receiver", writer, "second task"), Err(error) if error.code == C::Unauthorized)
    );
    let error = h.svc.finish_delegation(&handle, Ok(output())).unwrap_err();
    assert_eq!(error.code, C::Conflict);
    assert_eq!(
        h.svc.get_task(&owner, &handle.queued.id).unwrap().status,
        "queued"
    );
}

#[test]
fn an_audit_failure_refuses_delegation_before_creating_a_task() {
    let h = open();
    let owner = owner();
    let project = setup(&h, &["sender", "receiver"]);
    let trace = h.svc.open_chain(&owner, &project, "sender").unwrap();
    let mut admission = input(&owner, &project, "sender", "receiver", "Audit-first");
    admission.call_class = CallClass::Write;
    admission.trace_id = Some(&trace);
    let got = h.svc.delegate(DelegateRequest {
        admission,
        parent_task: None,
        task_class: TaskClass::CodeSmall,
        contract: None,
        allowed_tools: &[],
        parent_budget: None,
        writer: None,
        cancel: None,
        audit: &mut |_: &AuditEvent| Err("not recorded".to_owned()),
    });
    assert!(matches!(got, Err(error) if error.code == C::Storage));
    assert!(h.svc.get_trace(&owner, &trace).unwrap().spans.is_empty());
}
