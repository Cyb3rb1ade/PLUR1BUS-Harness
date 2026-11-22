use super::*;
use crate::collab::limits::CallClass;
use crate::collab::scope::{scope_for, DelegationScope};
use crate::rbac::types::{PrincipalKind, Role};
use serde_json::{json, Value};
use std::cell::RefCell;

struct Provider<'a> {
    name: &'a str,
    calls: RefCell<Vec<Value>>,
}

impl RunnerProvider for Provider<'_> {
    fn stream(
        &self,
        request: &ProviderRequest<'_>,
        event: &mut dyn FnMut(ProviderEvent) -> R<()>,
    ) -> R<()> {
        self.calls.borrow_mut().push(json!({
            "agentId": request.agent, "projectId": request.project, "sessionId": request.session,
            "messages": [{ "role": "user", "text": request.prompt }], "toolView": request.tools,
            "readOnlyWorktree": request.read_only_worktree, "principal": request.principal, "person": request.person,
            "maxRounds": request.max_rounds,
        }));
        event(ProviderEvent::Progress)?;
        event(ProviderEvent::Delta("partial".to_owned()))?;
        if self.name == "aborts in stream" {
            request.abort.abort();
        }
        event(ProviderEvent::Usage {
            input: 2,
            output: 3,
        })?;
        event(ProviderEvent::Progress)?;
        event(ProviderEvent::Delta(" text".to_owned()))?;
        Ok(())
    }
}

#[test]
fn coding_runner_vectors() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/coding/runner.json"
    ))
    .unwrap();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let call = RunInput {
            agent_id: "worker".to_owned(),
            project_id: "project".to_owned(),
            text: "Check fixture".to_owned(),
            context: "More context".to_owned(),
        };
        let mut scope = scope_for(
            if name == "wrong scope" {
                "other"
            } else {
                "worker"
            },
            "project",
        );
        scope.tool_view = ["file.list", "file.read", "file.write"]
            .map(str::to_owned)
            .into();
        if name != "no delegation" {
            scope.delegation = Some(DelegationScope {
                trace_id: "trace".to_owned(),
                span_id: "span".to_owned(),
                path: vec!["worker".to_owned()],
                call_class: if matches!(name, "write" | "independent review") {
                    CallClass::Write
                } else {
                    CallClass::Read
                },
                work_budget: DelegationWorkBudget::new(100, None),
            });
        }
        let abort = AbortSignal::new();
        if name == "already aborted" {
            abort.abort();
        }
        let principal = Principal {
            kind: Some(if name == "agent principal" {
                PrincipalKind::Agent
            } else {
                PrincipalKind::Person
            }),
            ..Principal::new("lead", Role::Owner)
        };
        let input = RunnerInput {
            scope: (name != "missing scope").then_some(&scope),
            run: &call,
            abort: &abort,
            tools: &["file.read".to_owned(), "file.write".to_owned()],
            read_only_worktree: (name == "independent review").then_some("trusted-fixture-path"),
            session_id: (name == "write").then_some("bound-session"),
            principal: Some(&principal),
            max_rounds: Some(2),
            budget: scope.delegation.as_ref().map(|d| &d.work_budget),
        };
        let provider = Provider {
            name,
            calls: RefCell::default(),
        };
        let mut progress = Vec::new();
        let out = run(&input, &provider, &mut |r| {
            progress.push(json!([r.text, r.input_tokens, r.output_tokens]))
        });
        let wire = match out {
            Ok(r) => {
                json!({"ok": { "text": r.text, "inputTokens": r.input_tokens, "outputTokens": r.output_tokens }})
            }
            Err(e) if e.code == C::Aborted => json!({ "err": { "code": e.code.as_str() } }),
            Err(e) => json!({ "err": { "code": e.code.as_str(), "message": e.message } }),
        };
        assert_eq!(wire, case["result"], "{name}");
        assert_eq!(json!(provider.calls.into_inner()), case["calls"], "{name}");
        assert_eq!(json!(progress), case["progress"], "{name}");
    }
}
