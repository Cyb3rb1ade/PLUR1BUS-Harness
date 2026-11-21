//! Delegate admission, target dispatch and completion on an explicit clock tick.
use super::{AdmitInput, CollabError, CollabService, GuardrailReason, WriterIdentity, C, R};
use crate::collab::handoff::{deadline, property, HandoffTicket};
use crate::collab::ids::project_repeat_key;
use crate::collab::limits::{CallClass, DelegationWorkBudget, TaskClass};
use crate::collab::ports::{BudgetCheck, RunInput, RunOutput};
use crate::collab::replay::{RecordEnd, RecordStart, RecordedTurn};
use crate::collab::run::RunPhase;
use crate::collab::run::{
    DelegateHandle, DelegateRequest, DelegationTarget, Drain, PendingRun, TargetContext,
    TargetRequest,
};
use crate::collab::scope::{self, DelegationScope};
use crate::collab::store::{NewTask, SpanPatch, TaskPatch};
use crate::collab::types::{DelegateTask, TargetKind};
use crate::js::utf16_len;
use crate::logs::methods::AbortSignal;
use crate::rbac::audit::AuditEvent;
use crate::rbac::types::{PrincipalKind, Role};
use crate::sessions::compaction::truncate_with_pointer;
use crate::toolcall::json::V;
use serde_json::{json, Value};
use std::sync::Arc;

const DEFAULT_READ_TOOLS: &[&str] = &["file.read", "file.list", "file.stat"];

struct DelegationParent {
    task: DelegateTask,
    budget: DelegationWorkBudget,
    tools: Vec<String>,
}

fn bad_delegation_path() -> CollabError {
    CollabError::guardrail("invalid delegation path", GuardrailReason::Depth)
}

fn delegation_tool_view(
    req: &DelegateRequest<'_>,
    parent: Option<&DelegationParent>,
) -> R<Vec<String>> {
    let class = req.admission.call_class;
    let tools = req
        .contract
        .as_ref()
        .and_then(|contract| property(contract, &["constraints", "scope", "tools"]).as_arr());
    if let Some(tools) = tools {
        if class != CallClass::Write
            && tools
                .iter()
                .any(|tool| !DEFAULT_READ_TOOLS.iter().any(|read| tool.is_str(read)))
        {
            return Err(CollabError::new(
                C::Unauthorized,
                "read delegation requires read tools",
            ));
        }
        if let Some(parent) = parent {
            if tools
                .iter()
                .any(|tool| !parent.tools.iter().any(|name| tool.is_str(name)))
            {
                return Err(CollabError::new(
                    C::Unauthorized,
                    "nested tool scope cannot widen its caller",
                ));
            }
        }
    }
    Ok(req
        .allowed_tools
        .iter()
        .filter(|name| {
            parent.is_none_or(|parent| parent.tools.contains(name))
                && tools.map_or_else(
                    || class != CallClass::Write && DEFAULT_READ_TOOLS.contains(&name.as_str()),
                    |requested| requested.iter().any(|tool| tool.is_str(name)),
                )
        })
        .cloned()
        .collect())
}

fn stopped() -> CollabError {
    CollabError::new(C::Aborted, "collaboration service is stopping")
}

fn run_missing() -> CollabError {
    CollabError::new(C::NotFound, "delegation run not found")
}

fn active(task: &DelegateTask) -> bool {
    matches!(task.status.as_str(), "queued" | "running")
}

fn wire(value: &V) -> R<Value> {
    serde_json::from_str(&value.stringify())
        .map_err(|_| CollabError::new(C::Invalid, "handoff cannot be recorded"))
}

fn checked_usage(output: &RunOutput) -> R<i64> {
    if output.input_tokens < 0 || output.output_tokens < 0 {
        return Err(CollabError::new(C::Invalid, "invalid delegation usage"));
    }
    output
        .input_tokens
        .checked_add(output.output_tokens)
        .ok_or_else(|| CollabError::new(C::Invalid, "invalid delegation usage"))
}

impl CollabService {
    pub(super) fn check_accepting(&self) -> R<()> {
        if self.store.is_closed() || self.st().drain.is_some() {
            Err(stopped())
        } else {
            Ok(())
        }
    }

    fn delegation_parent(
        &self,
        i: &AdmitInput<'_>,
        parent_task: Option<&str>,
    ) -> R<Option<DelegationParent>> {
        let trace = if let Some(trace_id) = i.trace_id.filter(|trace| !trace.is_empty()) {
            Some(
                self.store
                    .get_trace(trace_id)?
                    .filter(|trace| trace.project_id == i.project_id)
                    .ok_or_else(|| {
                        CollabError::with_reason(C::NotFound, "delegation trace not found", "trace")
                    })?,
            )
        } else {
            None
        };
        let Some(parent_task) = parent_task else {
            if trace
                .as_ref()
                .is_some_and(|trace| trace.root_agent != i.from_agent)
                || i.parent_span_id.is_some()
                || i.path
                    .as_ref()
                    .is_some_and(|path| path.len() != 1 || path[0] != i.from_agent)
            {
                return Err(bad_delegation_path());
            }
            return Ok(None);
        };
        let trace = trace.ok_or_else(bad_delegation_path)?;
        let task = self
            .store
            .get_task(parent_task)?
            .filter(|task| {
                task.status == "running"
                    && task.project_id == i.project_id
                    && task.trace_id == trace.trace_id
                    && task.to_agent == i.from_agent
                    && i.path.as_ref() == Some(&task.path)
                    && i.parent_span_id.is_none_or(|span| span == task.span_id)
            })
            .ok_or_else(bad_delegation_path)?;
        let now = self.store.now();
        let state = self.st();
        let run = state
            .pending
            .get(parent_task)
            .filter(|run| {
                run.task.trace_id == task.trace_id
                    && run.task.span_id == task.span_id
                    && run.task.path == task.path
                    && run.principal.user_id == i.principal.user_id
                    && run.principal.kind == i.principal.kind
                    && run.phase == RunPhase::Running
                    && !run.cancelled()
                    && !run.timed_out(now)
            })
            .ok_or_else(bad_delegation_path)?;
        Ok(Some(DelegationParent {
            task,
            budget: run.budget.clone(),
            tools: run.scope.tool_view.clone(),
        }))
    }

    /// Check the chain and reserve its writer, then atomically record the new task and span.
    pub fn delegate(&self, mut req: DelegateRequest<'_>) -> R<DelegateHandle> {
        req.admission.consult = false;
        self.redactor()?;
        let project = self.admission_project(&req.admission)?;
        let class = match req.task_class {
            TaskClass::Consult | TaskClass::Research => CallClass::Read,
            TaskClass::Review => CallClass::Review,
            TaskClass::CodeSmall | TaskClass::CodeLarge => CallClass::Write,
        };
        if req.admission.call_class != class {
            return Err(CollabError::new(
                C::Unauthorized,
                "delegation class does not match its task",
            ));
        }
        let parent = self.delegation_parent(&req.admission, req.parent_task)?;
        if parent.is_some() && class == CallClass::Write {
            return Err(bad_delegation_path());
        }
        let mut admission = req.admission.clone();
        if let Some(parent) = &parent {
            admission.path = Some(parent.task.path.clone());
            admission.parent_span_id = Some(&parent.task.span_id);
        }
        // The caller's task label identifies a handoff, but cannot create a fresh fan-out bucket.
        admission.task_id = parent.as_ref().map(|parent| parent.task.id.as_str());
        let i = &admission;
        let (chain, project, mut path) = self.guard_admission(i, project)?;
        let tool_view = delegation_tool_view(&req, parent.as_ref())?;
        if chain.ended || chain.aborted || req.cancel.as_ref().is_some_and(AbortSignal::is_aborted)
        {
            return Err(CollabError::new(C::Aborted, "delegation chain ended"));
        }
        let limits = self.store.limits(&project.id)?;
        let task_limits = limits.task(req.task_class);
        let now = self.store.now();
        let mut end = now.saturating_add(task_limits.wall_time_ms);
        let mut work_tokens = limits.work_tokens;
        if let Some(h) = req.contract.as_ref() {
            let invalid = || CollabError::new(C::Invalid, "invalid handoff ticket");
            if property(h, &["kind"]).is_str("consult")
                || (class != CallClass::Write && property(h, &["kind"]).is_str("handoff"))
            {
                return Err(invalid());
            }
            end = end.min(deadline(h).ok_or_else(invalid)?);
            let tokens = property(h, &["budget", "tokens"])
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0)
                .ok_or_else(invalid)?;
            work_tokens = work_tokens.min(tokens as i64);
        }
        req.audit
            .append(&AuditEvent {
                at: now,
                user: i.principal.user_id.clone(),
                host: String::new(),
                action: "delegate.queued".to_owned(),
                target: project.id.clone(),
                detail: vec![],
            })
            .map_err(|_| CollabError::new(C::Storage, "delegation audit failed"))?;
        self.check_accepting()?;
        if self.is_aborted(&chain.trace_id) {
            return Err(CollabError::new(C::Aborted, "delegation chain ended"));
        }
        let writer = if i.call_class == CallClass::Write {
            let identity = WriterIdentity {
                principal: i.principal,
                project_id: i.project_id,
                from_agent: i.from_agent,
                to_agent: i.to_agent,
                trace_id: Some(&chain.trace_id),
                parent_span_id: i.parent_span_id,
            };
            let id = if let Some(held) = req.writer {
                held
            } else {
                self.reserve_writer(&identity)?
            };
            if let Err(e) = self.use_writer(id, &identity) {
                if req.writer.is_none() {
                    self.release_writer(id);
                }
                return Err(e);
            }
            Some(id)
        } else {
            None
        };

        path.push(i.to_agent.to_owned());
        let span_id = if self.with_chain(&chain.trace_id, |c| c.fanout == 0) == Some(true) {
            chain.root_span_id.clone()
        } else {
            self.ids.span_id()
        };
        let id = self.store.id("tsk");
        let row = NewTask {
            id: id.clone(),
            project_id: project.id.clone(),
            trace_id: chain.trace_id.clone(),
            span_id: span_id.clone(),
            parent_task_id: parent.as_ref().map(|parent| parent.task.id.clone()),
            from_agent: i.from_agent.to_owned(),
            to_agent: i.to_agent.to_owned(),
            kind: "delegate".to_owned(),
            status: "queued".to_owned(),
            task: i.text.to_owned(),
            acceptance: i.extra.to_owned(),
            path: path.clone(),
        };
        let preview = self.preview(i.text);
        let persisted = self.store.tx(|_| {
            self.store.remember_repeat(
                &project_repeat_key(&project.id, i.from_agent, i.to_agent, i.text),
                now,
            )?;
            self.store.insert_span(
                &span_id,
                &chain.trace_id,
                i.parent_span_id,
                i.to_agent,
                "delegate",
                None,
                Some(&preview),
            )?;
            self.store.insert_task(&row)?.ok_or_else(run_missing)
        });
        let task = match persisted {
            Ok(task) => task,
            Err(e) => {
                if let Some(writer) = writer {
                    self.clear_writer(writer);
                }
                return Err(e);
            }
        };
        self.with_chain(&chain.trace_id, |c| {
            c.fanout += 1;
            if i.call_class != CallClass::Write {
                *c.read_starts
                    .entry(Self::turn_key(i.from_agent, i.task_id))
                    .or_insert(0) += 1;
            }
        });
        let budget =
            DelegationWorkBudget::new(work_tokens, parent.as_ref().map(|parent| &parent.budget));
        let mut scope = scope::scope_for(i.to_agent, &project.id);
        scope.delegation = Some(DelegationScope {
            trace_id: chain.trace_id.clone(),
            span_id: span_id.clone(),
            path,
            call_class: i.call_class,
            work_budget: budget.clone(),
        });
        scope.tool_view = tool_view;

        let key = Arc::new(());
        let cancel = AbortSignal::new();
        let queued = self.redact_task(task.clone())?;
        let pending = PendingRun {
            transcript: None,
            key: key.clone(),
            task,
            principal: i.principal.clone(),
            sender_task: req.admission.task_id.map(str::to_owned),
            input: RunInput {
                agent_id: i.to_agent.to_owned(),
                project_id: project.id.clone(),
                context: String::new(),
                text: format!("{}\n\nAcceptance criteria:\n{}", i.text, i.extra),
            },
            contract: req.contract,
            scope,
            cancel: cancel.clone(),
            parent_cancel: req.cancel,
            writer,
            deadline: end,
            stall_ms: task_limits.stall_time_ms,
            progress_at: now,
            progress: None,
            rounds: task_limits.rounds,
            return_tokens: limits.return_tokens,
            budget,
            phase: RunPhase::Queued,
            kind: None,
            a2a: false,
        };
        self.st().pending.insert(id.clone(), pending);
        self.fire(
            "delegate.queued",
            &project.id,
            Some(&chain.trace_id),
            Some(i.to_agent),
            json!({ "taskId": id, "spanId": span_id }),
        );
        Ok(DelegateHandle {
            queued,
            id,
            key,
            cancel,
        })
    }

    fn lookup_run(&self, handle: &DelegateHandle) -> Option<PendingRun> {
        self.st()
            .pending
            .get(&handle.id)
            .filter(|run| Arc::ptr_eq(&run.key, &handle.key))
            .cloned()
    }

    /// Drive receiver selection and the ack before giving the target a chance to execute.
    pub fn run_target(
        &self,
        handle: &DelegateHandle,
        targets: &[&dyn DelegationTarget],
        ctx: TargetContext<'_, '_>,
    ) -> R<Option<DelegateTask>> {
        let run = self.lookup_run(handle).ok_or_else(run_missing)?;
        if run.phase != RunPhase::Queued {
            return Err(CollabError::new(C::Conflict, "delegation already started"));
        }
        if run.cancelled() || run.timed_out(self.store.now()) || self.is_aborted(&run.task.trace_id)
        {
            return self.interrupt_run(&run);
        }
        let task = &run.task;
        let changed = self.store.patch_task(
            &task.id,
            &TaskPatch {
                status: "running".to_owned(),
                ..Default::default()
            },
        )?;
        if changed.is_none() {
            return Err(run_missing());
        }
        {
            let mut state = self.st();
            let pending = state.pending.get_mut(&handle.id).ok_or_else(run_missing)?;
            pending.phase = RunPhase::Acknowledging;
            pending.progress_at = self.store.now();
        }
        self.fire(
            "delegate.started",
            &task.project_id,
            Some(&task.trace_id),
            Some(&task.to_agent),
            json!({ "taskId": task.id, "spanId": task.span_id }),
        );
        match self.dispatch(&run, targets, ctx) {
            Ok(None) => Ok(None),
            Ok(Some(out)) => self.finish_delegation(handle, Ok(out)),
            Err(e) => {
                let Some(current) = self.lookup_run(handle) else {
                    return Ok(None);
                };
                self.settle_live_run(&current, Err(e))
            }
        }
    }

    fn dispatch(
        &self,
        run: &PendingRun,
        targets: &[&dyn DelegationTarget],
        ctx: TargetContext<'_, '_>,
    ) -> R<Option<RunOutput>> {
        let mut matches = targets
            .iter()
            .filter(|target| target.accepts(&run.input.agent_id));
        let invalid_target =
            || CollabError::new(C::Invalid, "delegation target missing or ambiguous");
        let target = matches.next().ok_or_else(invalid_target)?;
        if matches.next().is_some() {
            return Err(invalid_target());
        }
        let kind = target.kind();
        let a2a = kind == TargetKind::A2a || target.origin_a2a();
        if a2a {
            if run
                .contract
                .as_ref()
                .is_some_and(|h| property(h, &["kind"]).is_str("handoff"))
                || ctx.independent_review
                || ctx.local_checkout
            {
                return Err(CollabError::new(
                    C::Unauthorized,
                    "A2A targets cannot review local worktrees or receive card ownership",
                ));
            }
            if run.principal.role != Role::Owner
                || run.principal.kind != Some(PrincipalKind::Person)
            {
                return Err(CollabError::new(
                    C::Unauthorized,
                    "A2A assignment and execution require an Owner person",
                ));
            }
        }
        let scope = (kind == TargetKind::Local && !a2a).then_some(&run.scope);
        let eligible = || {
            let current = self
                .st()
                .pending
                .get(&run.task.id)
                .cloned()
                .ok_or_else(run_missing)?;
            if current.cancelled()
                || current.timed_out(self.store.now())
                || self.is_aborted(&run.task.trace_id)
            {
                return Err(CollabError::new(C::Aborted, "aborted"));
            }
            self.check_accepting()
        };
        eligible()?;
        let mut ticket = if let Some(contract) = &run.contract {
            let target_mismatch = || CollabError::new(C::Unauthorized, "handoff target mismatch");
            if contract
                .get("to")
                .and_then(|to| to.get("agent"))
                .is_some_and(|a| !a.is_str(&run.input.agent_id))
            {
                return Err(target_mismatch());
            }
            let bound = ctx.handoff.ok_or_else(target_mismatch)?;
            if bound.person != run.principal.user_id
                || bound.from_agent != run.task.from_agent
                || bound.project_id != run.task.project_id
                || run.sender_task.as_deref() != Some(bound.task_id)
            {
                return Err(target_mismatch());
            }
            Some(HandoffTicket::new(contract.clone(), bound)?)
        } else {
            None
        };
        let recorded = if scope.is_some() {
            self.begin_recording(run)?
        } else {
            None
        };
        let request = TargetRequest {
            input: &run.input,
            session_id: recorded.as_ref().map(|t| t.session_id.as_str()),
            scope,
            contract: run.contract.as_ref(),
            cancel: &run.cancel,
            max_rounds: run.rounds,
            budget: &run.budget,
            return_tokens: run.return_tokens,
        };
        if let Some(ticket) = ticket.as_mut() {
            eligible()?;
            if !property(ticket.handoff(), &["kind"]).is_str("consult") {
                let ack = target.acknowledge(&request)?;
                self.record_entry(
                    run,
                    recorded.as_ref(),
                    &json!({ "kind": "ack", "data": wire(&ack)? }),
                )?;
                ticket.acknowledge(&ack)?;
            }
            eligible()?;
            ticket.start()?;
            if let Some(accepted) = ctx.on_accepted {
                accepted()?;
            }
        }
        eligible()?;
        if let Some(p) = self.st().pending.get_mut(&run.task.id) {
            p.kind = (run.contract.is_some() || recorded.is_some()).then_some(kind);
            p.a2a = target.origin_a2a();
            p.phase = RunPhase::Running;
        }
        target.start(&request)
    }

    fn begin_recording(&self, run: &PendingRun) -> R<Option<RecordedTurn>> {
        let Some(recorder) = &self.ports.transcripts else {
            return Ok(None);
        };
        let task = &run.task;
        let redact = self.redactor()?;
        let recorded = recorder.begin(RecordStart {
            project_id: &task.project_id,
            from_agent: &task.from_agent,
            to_agent: &task.to_agent,
            prompt: &redact.text(&run.input.text),
        })?;
        if let Some(pending) = self.st().pending.get_mut(&task.id) {
            pending.transcript = Some(recorded.clone());
        }
        self.store
            .bind_session(&task.span_id, &recorded.session_id)?;
        if let Some(contract) = &run.contract {
            recorder.append(&recorded, json!({ "kind": "tool_result", "trust": "untrusted",
                "provenance": { "traceId": task.trace_id, "fromAgent": task.from_agent }, "handoff": redact.value(&wire(contract)?) }))?;
        }
        Ok(Some(recorded))
    }

    fn record_entry(
        &self,
        run: &PendingRun,
        recorded: Option<&RecordedTurn>,
        entry: &Value,
    ) -> R<()> {
        if let (Some(recorder), Some(recorded)) = (&self.ports.transcripts, recorded) {
            recorder.append(recorded, json!({ "kind": "tool_result", "trust": "untrusted",
                "provenance": { "traceId": run.task.trace_id, "spanId": run.task.span_id, "agentId": run.task.to_agent },
                "entry": self.redactor()?.value(entry) }))?;
        }
        Ok(())
    }

    /// Append a redacted progress event while a running session is still open.
    pub fn report_transcript(&self, handle: &DelegateHandle, entry: &Value) -> R<bool> {
        if !self.report_progress(handle, None) {
            return Ok(false);
        }
        let run = self.lookup_run(handle).ok_or_else(run_missing)?;
        self.record_entry(&run, run.transcript.as_ref(), entry)?;
        Ok(true)
    }

    /// Record real work progress or a heartbeat. Progress arriving at or after a boundary is ignored.
    pub fn report_progress(&self, handle: &DelegateHandle, output: Option<RunOutput>) -> bool {
        let now = self.store.now();
        let mut state = self.st();
        if state.drain.is_some() {
            return false;
        }
        let Some(run) = state.pending.get_mut(&handle.id) else {
            return false;
        };
        if !Arc::ptr_eq(&handle.key, &run.key)
            || run.phase == RunPhase::Queued
            || run.cancelled()
            || run.timed_out(now)
            || output
                .as_ref()
                .is_some_and(|out| checked_usage(out).is_err())
        {
            return false;
        }
        run.progress_at = run.progress_at.max(now);
        if output.is_some() {
            run.progress = output;
        }
        let mut parent = run.task.parent_task_id.clone();
        let trace_id = run.task.trace_id.clone();
        // Only ancestor runs of the same admitted trace receive a heartbeat from this child.
        for _ in 0..state.pending.len() {
            let Some(ancestor) = parent.as_ref().and_then(|id| state.pending.get_mut(id)) else {
                break;
            };
            if ancestor.task.trace_id != trace_id || ancestor.cancelled() || ancestor.timed_out(now)
            {
                break;
            }
            ancestor.progress_at = ancestor.progress_at.max(now);
            parent.clone_from(&ancestor.task.parent_task_id);
        }
        true
    }

    /// Complete a dispatch exactly once. An elapsed deadline wins over a late reply.
    pub fn finish_delegation(
        &self,
        handle: &DelegateHandle,
        outcome: R<RunOutput>,
    ) -> R<Option<DelegateTask>> {
        let Some(run) = self.lookup_run(handle) else {
            return Ok(None);
        };
        if run.phase != RunPhase::Running {
            return Err(CollabError::new(C::Conflict, "delegation has not started"));
        }
        self.settle_live_run(&run, outcome)
    }

    fn settle_live_run(&self, run: &PendingRun, outcome: R<RunOutput>) -> R<Option<DelegateTask>> {
        if run.cancelled() || run.timed_out(self.store.now()) || self.is_aborted(&run.task.trace_id)
        {
            return self.interrupt_run(run);
        }
        self.complete_run(run, outcome, false, false)
    }

    fn interrupt_run(&self, run: &PendingRun) -> R<Option<DelegateTask>> {
        run.cancel.abort();
        if run.contract.is_some() && run.phase == RunPhase::Running {
            let mut partial = run.progress.clone().unwrap_or_default();
            partial.partial = true;
            self.complete_run(run, Ok(partial), false, false)
        } else {
            self.complete_run(
                run,
                Err(CollabError::new(C::Aborted, "aborted")),
                true,
                false,
            )
        }
    }

    fn complete_run(
        &self,
        run: &PendingRun,
        outcome: R<RunOutput>,
        cancelled: bool,
        abandoned: bool,
    ) -> R<Option<DelegateTask>> {
        let task = &run.task;
        let current = self.store.get_task(&task.id)?.ok_or_else(run_missing)?;
        if !active(&current) {
            self.remove_run(run);
            return Ok(None);
        }
        let outcome = outcome.and_then(|out| checked_usage(&out).map(|tokens| (out, tokens)));
        let mut usage = None;
        let mut transcript_output = None;
        let (finished, span_status) = self.store.tx(|_| {
            let mut patch = TaskPatch::default();
            let mut span = SpanPatch::default();
            match outcome {
                Ok((out, tokens)) => {
                    let redaction = self.redactor()?;
                    let full = redaction.text(&out.text);
                    let (artifact, pointer) =
                        self.store.put_artifact(&task.project_id, &full, None)?;
                    let (mut capped, truncated) =
                        truncate_with_pointer(&full, run.return_tokens, &pointer);
                    if truncated && !(capped.contains(&pointer) && capped.contains("[truncated")) {
                        capped = format!("[truncated {} chars; {pointer}]", utf16_len(&full));
                    }
                    patch.status = if out.partial {
                        "cancelled"
                    } else {
                        "succeeded"
                    }
                    .to_owned();
                    patch.error = out.partial.then(|| "partial".to_owned());
                    patch.artifact_id = Some(artifact);
                    patch.result = Some(capped.clone());
                    patch.truncated = truncated;
                    patch.input_tokens = Some(out.input_tokens);
                    patch.output_tokens = Some(out.output_tokens);
                    patch.target_kind = run.kind.map(|k| k.as_str().to_owned());
                    patch.origin = run.a2a.then(|| "a2a".to_owned());
                    span.status = if out.partial { "partial" } else { "succeeded" }.to_owned();
                    span.output_preview = Some(self.preview(&capped));
                    span.input_tokens = patch.input_tokens;
                    span.output_tokens = patch.output_tokens;
                    span.target_kind.clone_from(&patch.target_kind);
                    span.origin.clone_from(&patch.origin);
                    usage = Some(tokens);
                    transcript_output = Some((full, out));
                }
                Err(error) => {
                    patch.status = if cancelled { "cancelled" } else { "failed" }.to_owned();
                    patch.error = Some(if cancelled {
                        "aborted".to_owned()
                    } else {
                        self.redactor()?.text(&error.message)
                    });
                    span.status.clone_from(&patch.status);
                    span.error = if abandoned {
                        Some("abandoned at shutdown".to_owned())
                    } else {
                        patch.error.clone()
                    };
                }
            }
            let updated = self
                .store
                .patch_task(&task.id, &patch)?
                .ok_or_else(run_missing)?;
            self.store.finish_span(&task.span_id, &span)?;
            Ok((updated, span.status))
        })?;
        self.remove_run(run);
        self.store.end_task_grants(&task.id);
        if let Some(tokens) = usage {
            self.with_chain(&task.trace_id, |c| {
                c.tokens_used = c.tokens_used.saturating_add(tokens)
            });
            self.ports.budget.record(&BudgetCheck {
                tokens,
                project_id: task.project_id.clone(),
                agent_id: task.to_agent.clone(),
                chain_id: task.trace_id.clone(),
            });
        }
        if !abandoned {
            let event = if cancelled {
                "delegate.cancelled"
            } else {
                "delegate.finished"
            };
            let mut data = json!({ "taskId": task.id, "status": span_status });
            if usage.is_some() {
                data["truncated"] = json!(finished.truncated);
            }
            self.fire(
                event,
                &task.project_id,
                Some(&task.trace_id),
                Some(&task.to_agent),
                data,
            );
        }
        self.finish_recording(run, &finished, transcript_output.as_ref())?;
        self.redact_task(finished).map(Some)
    }

    fn finish_recording(
        &self,
        run: &PendingRun,
        finished: &DelegateTask,
        output: Option<&(String, RunOutput)>,
    ) -> R<()> {
        let (Some(recorder), Some(recorded)) = (&self.ports.transcripts, &run.transcript) else {
            return Ok(());
        };
        let task = &run.task;
        let status = if output.is_some_and(|(_, out)| out.partial) {
            "partial"
        } else if output.is_some() {
            "done"
        } else {
            "failed"
        };
        let data = json!({ "traceId": task.trace_id, "spanId": task.span_id, "status": status });
        let entry = output.map(|(text, out)| json!({ "kind": "tool_result", "trust": "untrusted",
            "provenance": { "traceId": task.trace_id, "spanId": task.span_id, "projectId": task.project_id,
                "fromAgent": task.from_agent, "toAgent": task.to_agent }, "status": status, "result": text,
            "usage": { "inputTokens": out.input_tokens, "outputTokens": out.output_tokens } }));
        recorder.end(
            recorded,
            RecordEnd {
                entry,
                data: &data,
                text: output.map_or("", |(text, _)| text.as_str()),
                tokens: output.map_or(0, |(_, out)| out.output_tokens),
                error: finished.error.as_deref(),
            },
        )
    }

    fn remove_run(&self, run: &PendingRun) {
        self.st().pending.remove(&run.task.id);
        if let Some(slot) = run.writer {
            self.clear_writer(slot);
        }
    }

    pub(super) fn cancel_delegate_signals(&self, trace_id: Option<&str>) {
        let signals: Vec<_> = self
            .st()
            .pending
            .values()
            .filter(|r| trace_id.is_none_or(|id| id == r.task.trace_id))
            .map(|r| r.cancel.clone())
            .collect();
        for signal in signals {
            signal.abort();
        }
    }

    /// Advance work deadlines and the shutdown drain using the injected clock.
    pub fn tick(&mut self) -> R<Vec<DelegateTask>> {
        if self.store.is_closed() {
            return Ok(vec![]);
        }
        let now = self.store.now();
        let drain = self.st().drain;
        let mut completed = Vec::new();
        if let Some(drain) = drain {
            let drained = self.tick_drain(now, drain);
            if matches!(drained, Ok(true)) || now >= drain.deadline {
                self.store.close();
                *self.st() = Default::default();
            }
            drained?;
        } else {
            let mut due: Vec<_> = self
                .st()
                .pending
                .values()
                .filter(|run| run.cancelled() || run.timed_out(now))
                .cloned()
                .collect();
            due.sort_by(|a, b| a.task.id.cmp(&b.task.id));
            for run in due {
                if let Some(task) = self.interrupt_run(&run)? {
                    completed.push(task);
                }
            }
        }
        Ok(completed)
    }

    /// Signal running turns to stop. The caller keeps ticking until drain completion and store closure.
    pub fn shutdown(&mut self, budget_ms: i64) -> R<()> {
        if self.store.is_closed() {
            return Ok(());
        }
        let now = self.store.now();
        {
            let mut state = self.st();
            state.drain.get_or_insert(Drain {
                deadline: now.saturating_add(budget_ms.max(0)),
                budget_ms,
            });
            for chain in state.chains.values_mut() {
                chain.aborted = true;
            }
        }
        self.cancel_delegate_signals(None);
        self.tick()?;
        Ok(())
    }

    fn tick_drain(&self, now: i64, drain: Drain) -> R<bool> {
        let mut chains: Vec<_> = self.st().chains.keys().cloned().collect();
        chains.sort();
        let mut busy = Vec::new();
        for id in chains {
            if let Some(trace) = self.store.get_trace(&id)? {
                if trace.spans.iter().any(|span| span.status == "running") {
                    busy.push(trace);
                }
            }
        }
        if !busy.is_empty() && now < drain.deadline {
            return Ok(false);
        }
        let mut failure = None;
        for trace in busy {
            let running: Vec<_> = trace
                .spans
                .iter()
                .filter(|s| s.status == "running")
                .collect();
            let mut delegates: Vec<_> = self
                .st()
                .pending
                .values()
                .filter(|run| run.task.trace_id == trace.trace_id)
                .cloned()
                .collect();
            delegates.sort_by(|a, b| a.task.id.cmp(&b.task.id));
            for run in delegates {
                if let Err(error) = self.complete_run(&run, Err(stopped()), true, true) {
                    failure.get_or_insert(error);
                }
            }
            let fallback = (|| {
                self.store.cancel_open_tasks(&trace.trace_id)?;
                for span in &running {
                    self.store.finish_span(
                        &span.span_id,
                        &SpanPatch {
                            status: "cancelled".to_owned(),
                            error: Some("abandoned at shutdown".to_owned()),
                            ..Default::default()
                        },
                    )?;
                }
                self.end_chain(&trace.trace_id, "cancelled")
            })();
            if let Err(error) = fallback {
                failure.get_or_insert(error);
            }
            self.fire(
                "chain.abandoned",
                &trace.project_id,
                Some(&trace.trace_id),
                None,
                json!({ "inflight": running.len(), "budgetMs": drain.budget_ms }),
            );
        }
        failure.map_or(Ok(true), Err)
    }
}
