//! Replays `fixtures/parity/session-maintenance/*.json` (mode V, `scripts/parity/export-session-maintenance.ts`): context fit,
//! compaction, pruning and the summarizer run over a real file with a scripted clock, scripted ids, a scripted monotonic clock
//! and scripted ports; every op must answer what TypeScript answered, every call a port received and every event and error the
//! services reported must match, and so must the rows stored afterwards.
use super::compaction::*;
use super::context_fit::*;
use super::jstext::head;
use super::pruning::*;
use super::store::SessionStore;
use super::summarizer::*;
use super::tokens::ContextModel;
use super::vectors::{
    clip, err_json, event_json, f, first_diff, gi, gs, gso, revive, summary_json, Run,
};
use super::*;
use crate::approvals::js_json::J;
use serde_json::{json, Map, Value};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

pub(super) fn fixture(name: &str) -> Value {
    let text = match name {
        "pure" => include_str!("../../../../fixtures/parity/session-maintenance/pure.json"),
        "context-fit" => {
            include_str!("../../../../fixtures/parity/session-maintenance/context-fit.json")
        }
        "compaction-1" => {
            include_str!("../../../../fixtures/parity/session-maintenance/compaction-1.json")
        }
        "compaction-2" => {
            include_str!("../../../../fixtures/parity/session-maintenance/compaction-2.json")
        }
        "compaction-3" => {
            include_str!("../../../../fixtures/parity/session-maintenance/compaction-3.json")
        }
        "compaction-4" => {
            include_str!("../../../../fixtures/parity/session-maintenance/compaction-4.json")
        }
        "pruning-5" => {
            include_str!("../../../../fixtures/parity/session-maintenance/pruning-5.json")
        }
        "pruning-1" => {
            include_str!("../../../../fixtures/parity/session-maintenance/pruning-1.json")
        }
        "pruning-2" => {
            include_str!("../../../../fixtures/parity/session-maintenance/pruning-2.json")
        }
        "pruning-3" => {
            include_str!("../../../../fixtures/parity/session-maintenance/pruning-3.json")
        }
        "pruning-4" => {
            include_str!("../../../../fixtures/parity/session-maintenance/pruning-4.json")
        }
        "summarizer" => {
            include_str!("../../../../fixtures/parity/session-maintenance/summarizer.json")
        }
        "telemetry" => {
            include_str!("../../../../fixtures/parity/session-maintenance/telemetry.json")
        }
        "chat-models" => {
            include_str!("../../../../fixtures/parity/session-maintenance/chat-models.json")
        }
        "maintenance" => {
            include_str!("../../../../fixtures/parity/session-maintenance/maintenance.json")
        }
        "role-routing" => {
            include_str!("../../../../fixtures/parity/session-maintenance/role-routing.json")
        }
        other => panic!("no fixture {other}"),
    };
    revive(&serde_json::from_str(text).expect("fixture parses"))
}

// ---- pure helpers ----------------------------------------------------------------------------------------------------

pub(super) fn cfg_json(c: &CompactionConfig) -> Value {
    let mut m = Map::new();
    m.insert("windowTokens".into(), json!(c.window_tokens));
    m.insert("softRatio".into(), f(c.soft_ratio));
    m.insert("hardRatio".into(), f(c.hard_ratio));
    m.insert("summaryMaxTokens".into(), json!(c.summary_max_tokens));
    m.insert("maxMessageTokens".into(), json!(c.max_message_tokens));
    match c.summarizer {
        Some(SummarizerMode::Digest) => m.insert("summarizer".into(), json!("digest")),
        Some(SummarizerMode::Llm) => m.insert("summarizer".into(), json!("llm")),
        None => None,
    };
    Value::Object(m)
}

fn summary_messages(v: &Value) -> Vec<SummaryMessage> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|m| SummaryMessage {
            role: MessageRole::parse(gs(m, "role")).unwrap(),
            text: gs(m, "text").to_owned(),
            seq: gi(m, "seq").unwrap(),
        })
        .collect()
}

#[test]
fn pure_helpers_match_typescript() {
    let all = fixture("pure");
    let mut bad = Vec::new();
    for c in all["estimate"].as_array().unwrap() {
        if estimate_tokens(gs(c, "text")) != gi(c, "tokens").unwrap() {
            bad.push(format!("estimate {}", clip(&c.to_string(), 80)));
        }
    }
    for key in ["truncate", "truncateNegative"] {
        for c in all[key].as_array().unwrap() {
            let (text, truncated) = truncate_with_pointer(
                gs(c, "text"),
                gi(c, "max").unwrap(),
                c.get("pointer").and_then(Value::as_str).unwrap_or("p"),
            );
            let want = &c["result"];
            if want["text"] != json!(text) || want["truncated"] != json!(truncated) {
                bad.push(format!("{key} {}", clip(&c.to_string(), 120)));
            }
        }
    }
    for c in all["fitTail"].as_array().unwrap() {
        let got = fit_tail(gs(c, "text"), gi(c, "max").unwrap());
        if c["result"] != json!(got) {
            bad.push(format!(
                "fitTail max {} {}",
                c["max"],
                clip(&c["text"].to_string(), 60)
            ));
        }
    }
    for c in all["digest"].as_array().unwrap() {
        let got = digest(&summary_messages(&c["messages"]));
        if c["digest"] != json!(got) {
            bad.push(format!("digest {}", clip(&c.to_string(), 100)));
        }
    }
    for c in all["defaults"].as_array().unwrap() {
        let got = cfg_json(&default_compaction(gi(c, "window").unwrap()));
        if c["cfg"] != got {
            bad.push(format!("defaults {c}"));
        }
    }
    let p = default_prune();
    assert_eq!(
        all["pruneDefaults"]["confidence"],
        f(DEFAULT_PRUNE_CONFIDENCE)
    );
    assert_eq!(
        all["pruneDefaults"]["prune"],
        json!({"enabled": p.enabled, "keepLastTurns": p.keep_last_turns, "decider": "laya", "maxMs": f(p.max_ms), "batchSize": p.batch_size})
    );
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

// ---- context fit -----------------------------------------------------------------------------------------------------

fn fit_error(e: &FitError) -> Value {
    match e {
        FitError::Provider { message, code } => {
            let mut m = Map::new();
            m.insert("name".into(), json!("ProviderError"));
            m.insert("message".into(), json!(message));
            m.insert("kind".into(), json!("invalid_request"));
            if let Some(c) = code {
                m.insert("code".into(), json!(c));
            }
            m.insert("retryable".into(), json!(false));
            Value::Object(m)
        }
        FitError::Rpc { message } => json!({"name": "RpcError", "message": message,
            "error": "E_CONFIG_INVALID", "reason": "context-too-small"}),
    }
}

fn fit_request(v: &Value) -> FitRequest {
    FitRequest {
        messages: J::from_value(&v["messages"]),
        tools: v.get("tools").filter(|t| !t.is_null()).map(J::from_value),
        max_tokens: v.get("maxTokens").and_then(Value::as_f64),
    }
}

fn attempt<T>(r: Result<T, FitError>, to: impl FnOnce(T) -> Value) -> Value {
    match r {
        Ok(v) => json!({"ok": to(v)}),
        Err(e) => json!({"err": fit_error(&e)}),
    }
}

#[test]
fn context_fit_matches_typescript() {
    let all = fixture("context-fit");
    assert_eq!(
        all["constants"]["MIN_CONTEXT_AGENT_ROLE"],
        json!(MIN_CONTEXT_AGENT_ROLE)
    );
    assert_eq!(
        all["constants"]["APPLE_FM_CONTEXT_WINDOW"],
        json!(APPLE_FM_CONTEXT_WINDOW)
    );
    let mut bad = Vec::new();
    let mut check = |what: String, want: Value, got: Value| {
        if want != got {
            bad.push(format!("{what}\n  {}", first_diff(&want, &got)));
        }
    };
    for c in all["cases"].as_array().unwrap() {
        let req = fit_request(&c["request"]);
        let cost = attempt(
            context_cost(&req),
            |c| json!({"prompt": c.prompt, "reserve": c.reserve}),
        );
        check(
            format!("cost {}", clip(&c["request"].to_string(), 80)),
            c["cost"].clone(),
            cost,
        );
        for w in c["fit"].as_array().unwrap() {
            let window = w.get("window").and_then(Value::as_f64);
            let got = attempt(assert_context_fit(&req, window), |()| Value::Null);
            let mut want = w.clone();
            want.as_object_mut().unwrap().remove("window");
            check(
                format!(
                    "fit {} window {}",
                    clip(&c["request"].to_string(), 60),
                    w["window"]
                ),
                want,
                got,
            );
        }
    }
    for c in all["exact"].as_array().unwrap() {
        let req = fit_request(&c["request"]);
        let got = attempt(assert_context_fit(&req, c["window"].as_f64()), |()| {
            Value::Null
        });
        let mut want = c.clone();
        let o = want.as_object_mut().unwrap();
        o.remove("request");
        o.remove("window");
        check(
            format!(
                "exact {} window {}",
                clip(&c["request"].to_string(), 60),
                c["window"]
            ),
            want,
            got,
        );
    }
    for c in all["roles"].as_array().unwrap() {
        let got = attempt(
            assert_role_context(gs(c, "role"), c.get("window").and_then(Value::as_f64)),
            |()| Value::Null,
        );
        let mut want = c.clone();
        let o = want.as_object_mut().unwrap();
        o.remove("role");
        o.remove("window");
        check(format!("role {} {}", c["role"], c["window"]), want, got);
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

// ---- the scenario world ----------------------------------------------------------------------------------------------

struct Shared {
    log: RefCell<Vec<Value>>,
    mono: Cell<f64>,
    abort: Cell<bool>,
    last_turn: RefCell<String>,
    last_session: RefCell<String>,
}

/// The base ops a port may run "while it awaits": another task writing to the same store.
fn during(store: &mut SessionStore, ops: Option<&Value>, sh: &Shared) {
    let Some(ops) = ops.and_then(Value::as_array) else {
        return;
    };
    for op in ops {
        let turn_id = |op: &Value| {
            let t = gs(op, "turnId");
            if t == "$turn" {
                sh.last_turn.borrow().clone()
            } else {
                t.to_owned()
            }
        };
        let r: Result<(), SessionError> = match gs(op, "op") {
            "begin" => store
                .begin_turn(
                    gs(op, "sessionId"),
                    gs(op, "text"),
                    gi(op, "tokens").unwrap(),
                    &BeginOptions {
                        harness_command: false,
                        channel_origin: None,
                    },
                )
                .map(|b| *sh.last_turn.borrow_mut() = b.turn.id),
            "complete" => store
                .complete_turn(
                    &turn_id(op),
                    gs(&op["input"], "text"),
                    gi(&op["input"], "tokens").unwrap(),
                    None,
                )
                .map(|_| ()),
            "append" => store
                .append_event(
                    &turn_id(op),
                    EventType::parse(gs(op, "type")).unwrap(),
                    event_data(gs(op, "type"), &op["data"]),
                )
                .map(|_| ()),
            "setVisibility" => store.set_tool_visibility(
                gs(op, "sessionId"),
                gs(op, "ref"),
                op["hidden"].as_bool().unwrap(),
                gs(op, "reason"),
                None,
            ),
            other => panic!("during op {other}"),
        };
        if let Err(e) = r {
            sh.log
                .borrow_mut()
                .push(json!({"duringError": err_json(&e)}));
        }
    }
}

struct CompDouble {
    spec: Value,
    sh: Rc<Shared>,
}

impl CompactionHooks for CompDouble {
    fn has_summarizer(&self) -> bool {
        self.spec.get("summarizer").is_some()
    }
    fn summarize(
        &mut self,
        store: &mut SessionStore,
        messages: &[SummaryMessage],
        max_tokens: i64,
        session_id: &str,
        caller: Option<&J>,
    ) -> Result<String, String> {
        let mut entry = Map::new();
        entry.insert(
            "messages".into(),
            Value::Array(
                messages
                    .iter()
                    .map(|m| json!({"role": m.role.as_str(), "text": m.text, "seq": m.seq}))
                    .collect(),
            ),
        );
        entry.insert("maxTokens".into(), json!(max_tokens));
        entry.insert("sessionId".into(), json!(session_id));
        if let Some(c) = caller {
            entry.insert("caller".into(), c.to_value());
        }
        self.sh.log.borrow_mut().push(json!({"summarize": entry}));
        let s = &self.spec["summarizer"];
        during(store, s.get("during"), &self.sh);
        if gs(s, "kind") == "throw" {
            return Err(gs(s, "message").to_owned());
        }
        Ok(gs(s, "text").to_owned())
    }
    fn has_before_swap(&self) -> bool {
        self.spec.get("beforeSwap").is_some()
    }
    fn before_swap(
        &mut self,
        store: &mut SessionStore,
        info: &SwapInfo,
    ) -> Result<CheckpointAnswer, String> {
        self.sh.log.borrow_mut().push(json!({"beforeSwap":
            {"sessionId": info.session_id, "fromSeq": info.from_seq, "toSeq": info.to_seq}}));
        let b = &self.spec["beforeSwap"];
        during(store, b.get("during"), &self.sh);
        match gs(b, "kind") {
            "throw" => Err("engine down".to_owned()),
            "skipped" => Ok(CheckpointAnswer::Skipped),
            _ => Ok(CheckpointAnswer::Done),
        }
    }
    fn emit(&mut self, event: &str, attrs: &J) {
        self.sh
            .log
            .borrow_mut()
            .push(json!({"emit": event, "attrs": attrs.to_value()}));
    }
    fn on_error(&mut self, what: &str, err: &str) {
        self.sh
            .log
            .borrow_mut()
            .push(json!({"error": what, "message": err}));
    }
}

struct PruneDouble {
    spec: Value,
    sh: Rc<Shared>,
}

impl PruneHooks for PruneDouble {
    fn has_decider(&self) -> bool {
        self.spec.get("decide").is_some()
    }
    fn decide(
        &mut self,
        store: &mut SessionStore,
        batch: &[ToolPair],
        task: &str,
    ) -> DeciderOutcome {
        let d = self.spec["decide"].clone();
        self.sh.log.borrow_mut().push(json!({"decide":
            {"refs": batch.iter().map(|p| p.reference.clone()).collect::<Vec<_>>(), "task": task}}));
        during(store, d.get("during"), &self.sh);
        if let Some(b) = d.get("bump").and_then(Value::as_f64) {
            self.sh.mono.set(self.sh.mono.get() + b);
        }
        if d.get("abort").and_then(Value::as_bool) == Some(true) {
            assert!(
                self.spec["abortable"].as_bool() == Some(true),
                "abort needs a signal"
            );
            self.sh.abort.set(true);
        }
        match gs(&d, "kind") {
            "throw" => DeciderOutcome::Threw,
            "null" => DeciderOutcome::Answer(None),
            "timeout" => DeciderOutcome::TimedOut,
            "verdicts" => {
                let entries = d["entries"].as_array().unwrap();
                let mut out: Vec<J> = batch
                    .iter()
                    .enumerate()
                    .map(|(i, p)| {
                        let mut o = J::obj([("ref", J::s(&p.reference))]);
                        let e = J::from_value(&entries[i.min(entries.len() - 1)]);
                        for (k, v) in e.members() {
                            o.set(k, v.clone());
                        }
                        o
                    })
                    .collect();
                match d.get("shape").and_then(Value::as_str).unwrap_or("ok") {
                    "short" => {
                        out.pop();
                    }
                    "dup" if out.len() > 1 => {
                        let first = out[0].get("ref").cloned().unwrap();
                        out[1].set("ref", first);
                    }
                    "null-element" => out[0] = J::Null,
                    "not-array" => {
                        return DeciderOutcome::Answer(Some(J::obj([("not", J::s("an array"))])))
                    }
                    "unknown-ref" => out[0].set("ref", J::s("event:nope")),
                    "numeric-ref" => out[0].set("ref", J::Num(7.0)),
                    "primitive" => out[0] = J::s("text"),
                    _ => {}
                }
                DeciderOutcome::Answer(Some(J::Arr(out)))
            }
            other => panic!("decider {other}"),
        }
    }
    fn min_confidence(&self) -> Option<f64> {
        self.spec.get("minConfidence").and_then(Value::as_f64)
    }
    fn aborted(&self) -> bool {
        self.spec["abortable"].as_bool() == Some(true) && self.sh.abort.get()
    }
    fn emit(&mut self, event: &str, attrs: &J) {
        self.sh
            .log
            .borrow_mut()
            .push(json!({"emit": event, "attrs": attrs.to_value()}));
    }
    fn now_ms(&self) -> f64 {
        self.sh.mono.get()
    }
}

/// The fixtures sort object keys; TypeScript's tool events keep the order the exporter's `turn()` builder gave them.
fn event_data(kind: &str, data: &Value) -> J {
    let order: &[&str] = match kind {
        "tool.call" => &["id", "name", "args"],
        "tool.result" => &["id", "output", "isError"],
        _ => &[],
    };
    match data.as_object() {
        Some(d) if !order.is_empty() => {
            let mut j = J::Obj(Default::default());
            for k in order {
                if let Some(x) = d.get(*k) {
                    j.set(k, J::from_value(x));
                }
            }
            j
        }
        _ => J::from_value(data),
    }
}

fn prune_config(spec: Option<&Value>) -> PruneConfig {
    let mut c = default_prune();
    if let Some(o) = spec.and_then(Value::as_object) {
        if let Some(v) = o.get("enabled") {
            c.enabled = v.as_bool().unwrap();
        }
        if let Some(v) = o.get("keepLastTurns") {
            c.keep_last_turns = v.as_i64().unwrap();
        }
        if let Some(v) = o.get("decider") {
            c.decider = match v.as_str().unwrap() {
                "laya" => Decider::Laya,
                "heuristic" => Decider::Heuristic,
                "off" => Decider::Off,
                other => panic!("decider {other}"),
            };
        }
        if let Some(v) = o.get("maxMs") {
            c.max_ms = v.as_f64().unwrap();
        }
        if let Some(v) = o.get("batchSize") {
            c.batch_size = v.as_i64().unwrap();
        }
    }
    c
}

fn compaction_config(spec: &Value) -> CompactionConfig {
    let mut c = default_compaction(gi(spec, "windowTokens").unwrap());
    if let Some(v) = spec.get("softRatio") {
        c.soft_ratio = v.as_f64().unwrap();
    }
    if let Some(v) = spec.get("hardRatio") {
        c.hard_ratio = v.as_f64().unwrap();
    }
    if let Some(v) = gi(spec, "summaryMaxTokens") {
        c.summary_max_tokens = v;
    }
    if let Some(v) = gi(spec, "maxMessageTokens") {
        c.max_message_tokens = v;
    }
    c.summarizer = match gso(spec, "summarizer").as_deref() {
        Some("llm") => Some(SummarizerMode::Llm),
        Some("digest") => Some(SummarizerMode::Digest),
        _ => None,
    };
    c
}

fn maint_err(e: &MaintError) -> Value {
    match e {
        MaintError::Session(s) => err_json(s),
        MaintError::Thrown { name } => json!({"name": name}),
        MaintError::Config(m) => json!({"name": "Error", "message": m}),
    }
}

fn explanation_json(p: &PruneExplanation) -> Value {
    json!({"ref": p.reference, "hidden": p.hidden, "verdict": p.verdict,
        "confidence": p.confidence.map_or(Value::Null, f), "tokensSaved": p.tokens_saved})
}
fn metrics_json(m: &PruneMetrics) -> Value {
    json!({"pruned": m.pruned, "tokensSaved": m.tokens_saved, "refetches": m.refetches, "refetchRate": f(m.refetch_rate)})
}
fn view_message_json(m: &ViewMessage) -> Value {
    let mut o = Map::new();
    o.insert("id".into(), json!(m.id));
    o.insert("role".into(), json!(m.role.as_str()));
    o.insert("text".into(), json!(m.text));
    o.insert("seq".into(), json!(m.seq));
    o.insert(
        "turnId".into(),
        m.turn_id.as_ref().map_or(Value::Null, |t| json!(t)),
    );
    if let Some(c) = &m.tool_call {
        o.insert(
            "toolCall".into(),
            json!({"id": c.id, "name": c.name, "whole": c.whole}),
        );
    }
    Value::Object(o)
}
fn view_json(v: &ContextView) -> Value {
    let mut c = Map::new();
    c.insert("swapped".into(), json!(v.compaction.swapped));
    for (k, x) in [
        ("fromSeq", v.compaction.from_seq),
        ("toSeq", v.compaction.to_seq),
        ("tokensBefore", v.compaction.tokens_before),
        ("tokensAfter", v.compaction.tokens_after),
    ] {
        if let Some(x) = x {
            c.insert(k.into(), json!(x));
        }
    }
    if let Some(x) = v.compaction.checkpoint {
        c.insert("checkpoint".into(), json!(x));
    }
    json!({
        "summaries": v.summaries.iter().map(summary_json).collect::<Vec<_>>(),
        "messages": v.messages.iter().map(view_message_json).collect::<Vec<_>>(),
        "tokens": v.tokens,
        "hidden": v.hidden.iter().map(|h| {
            let mut o = Map::new();
            o.insert("ref".into(), json!(h.reference));
            if let Some(r) = &h.reason { o.insert("reason".into(), json!(r)); }
            Value::Object(o)
        }).collect::<Vec<_>>(),
        "clipped": v.clipped,
        "compaction": Value::Object(c),
    })
}
fn pair_json(p: &ToolPair) -> Value {
    let mut o = Map::new();
    o.insert("ref".into(), json!(p.reference));
    o.insert("turnId".into(), json!(p.turn_id));
    o.insert("text".into(), json!(p.text));
    o.insert("hidden".into(), json!(p.hidden));
    o.insert("restored".into(), json!(p.restored));
    if let Some(r) = &p.reason {
        o.insert("reason".into(), json!(r));
    }
    Value::Object(o)
}
fn hidden_output_json(h: &HiddenToolOutput) -> Value {
    let mut o = Map::new();
    o.insert("ref".into(), json!(h.reference));
    o.insert("reason".into(), json!(h.reason));
    o.insert("name".into(), json!(h.name));
    o.insert("callId".into(), json!(h.call_id));
    o.insert("turnId".into(), json!(h.turn_id));
    if let Some(a) = &h.args {
        o.insert("args".into(), a.to_value());
    }
    o.insert("output".into(), json!(h.output));
    if let Some(e) = h.is_error {
        o.insert("isError".into(), json!(e));
    }
    Value::Object(o)
}

struct World {
    run: Run,
    sh: Rc<Shared>,
    compactor: Option<Compactor>,
    standalone: Option<ToolPruner>,
}

impl World {
    fn new(name: &str) -> Self {
        Self {
            run: Run::new(name),
            sh: Rc::new(Shared {
                log: RefCell::new(Vec::new()),
                mono: Cell::new(0.0),
                abort: Cell::new(false),
                last_turn: RefCell::new(String::new()),
                last_session: RefCell::new(String::new()),
            }),
            compactor: None,
            standalone: None,
        }
    }

    fn make_pruner(&self, spec: &Value) -> Result<ToolPruner, Value> {
        self.sh.abort.set(false);
        ToolPruner::new(
            prune_config(spec.get("cfg")),
            Box::new(PruneDouble {
                spec: spec.clone(),
                sh: self.sh.clone(),
            }),
        )
        .map_err(|m| json!({"name": "Error", "message": m}))
    }

    fn build(&mut self, op: &Value) -> Result<(), Value> {
        let hooks = op.get("hooks").cloned().unwrap_or(json!({}));
        let pruner = match hooks.get("pruner") {
            Some(spec) => Some(self.make_pruner(spec)?),
            None => None,
        };
        let c = Compactor::new(
            compaction_config(&op["cfg"]),
            Box::new(CompDouble {
                spec: hooks,
                sh: self.sh.clone(),
            }),
            pruner,
        )
        .map_err(|e| maint_err(&e))?;
        self.compactor = Some(c);
        self.standalone = None;
        Ok(())
    }

    /// The exporter's `scripted`: `$turn` and `$ses` stand for the ids the run has seen last.
    fn scripted(&self, v: &Value) -> Value {
        let mut o = v.clone();
        if o.get("turnId") == Some(&json!("$turn")) {
            o["turnId"] = json!(self.sh.last_turn.borrow().clone());
        }
        if o.get("sessionId") == Some(&json!("$ses")) {
            o["sessionId"] = json!(self.sh.last_session.borrow().clone());
        }
        o
    }

    fn step(&mut self, raw: &Value) -> Result<Value, Value> {
        let scripted = self.scripted(raw);
        let op = &scripted;
        let sid = gso(op, "sessionId").unwrap_or_default();
        match gs(op, "op") {
            "compactor" => self.build(op).map(|()| Value::Null),
            "pruner" => {
                self.standalone = Some(self.make_pruner(op)?);
                Ok(Value::Null)
            }
            "mono" => {
                self.sh.mono.set(op["ms"].as_f64().unwrap());
                Ok(f(self.sh.mono.get()))
            }
            "configureModel" => {
                self.compactor.as_mut().expect("compactor").configure_model(
                    &sid,
                    gs(op, "model"),
                    gi(op, "window"),
                );
                Ok(Value::Null)
            }
            "view" => {
                let s = self.run.s() as &SessionStore;
                let v = self.compactor.as_ref().unwrap().view(s, &sid);
                v.map(|v| view_json(&v)).map_err(|e| maint_err(&e))
            }
            "prepare" => {
                let c = self.compactor.as_mut().unwrap();
                let s = self.run.s();
                c.prepare(s, &sid)
                    .map(|v| view_json(&v))
                    .map_err(|e| maint_err(&e))
            }
            "afterTurn" => {
                let caller = op.get("caller").map(J::from_value);
                let c = self.compactor.as_mut().unwrap();
                let s = self.run.s();
                c.after_turn(s, &sid, caller.as_ref())
                    .map(|p| json!({"prepared": p}))
                    .map_err(|e| maint_err(&e))
            }
            "explain" => {
                let s = self.run.s() as &SessionStore;
                self.compactor
                    .as_ref()
                    .unwrap()
                    .explain(s, &sid)
                    .map(|e| {
                        json!({"summaryCount": e.summary_count, "decisions": e.decisions.iter().map(explanation_json).collect::<Vec<_>>(),
                            "truncated": e.truncated, "metrics": metrics_json(&e.metrics)})
                    })
                    .map_err(|e| maint_err(&e))
            }
            "restore" => {
                let c = self.compactor.as_mut().unwrap();
                let s = self.run.s();
                c.restore_tool_ref(s, &sid, gs(op, "ref"))
                    .map(|b| json!(b))
                    .map_err(|e| maint_err(&e))
            }
            "append" if matches!(gs(op, "type"), "tool.call" | "tool.result") => {
                let s = self.run.s();
                s.append_event(
                    gs(op, "turnId"),
                    EventType::parse(gs(op, "type")).unwrap(),
                    event_data(gs(op, "type"), &op["data"]),
                )
                .map(|e| event_json(&e))
                .map_err(|e| err_json(&e))
            }
            "stop" => {
                self.compactor.as_mut().expect("compactor").stop();
                Ok(Value::Null)
            }
            "prune" => {
                self.sh.abort.set(false);
                let (compactor, standalone, run) =
                    (&mut self.compactor, &mut self.standalone, &mut self.run);
                let p = match standalone.as_mut() {
                    Some(p) => p,
                    None => compactor
                        .as_mut()
                        .and_then(Compactor::pruner_mut)
                        .expect("pruner"),
                };
                p.run(run.s(), &sid).map(|n| json!(n)).map_err(|e| match e {
                    PruneRunError::Session(s) => err_json(&s),
                    PruneRunError::Thrown { name } => json!({"name": name}),
                })
            }
            "pruneView" => {
                let s = self.run.s() as &SessionStore;
                let p = match self.standalone.as_ref() {
                    Some(p) => p,
                    None => self
                        .compactor
                        .as_ref()
                        .and_then(Compactor::pruner)
                        .expect("pruner"),
                };
                p.view(s, &sid)
                    .map(|v| Value::Array(v.iter().map(pair_json).collect()))
                    .map_err(|e| err_json(&e))
            }
            "hiddenOutputs" => {
                let s = self.run.s() as &SessionStore;
                hidden_tool_outputs(s, &sid)
                    .map(|v| Value::Array(v.iter().map(hidden_output_json).collect()))
                    .map_err(|e| err_json(&e))
            }
            "limits" => {
                let c = self.compactor.as_ref().unwrap();
                Ok(
                    json!({"hard": c.hard_limit(), "soft": c.soft_limit(), "cfgFor": cfg_json(c.config_for(&sid))}),
                )
            }
            "dump" => Ok(self.dump(&sid)),
            _ => {
                let out = self.run.op(op);
                match gs(op, "op") {
                    "begin" => {
                        if let Some(id) = out["ok"]["turn"]["id"].as_str() {
                            *self.sh.last_turn.borrow_mut() = id.to_owned();
                        }
                    }
                    "create" => {
                        if let Some(id) = out["ok"]["id"].as_str() {
                            *self.sh.last_session.borrow_mut() = id.to_owned();
                        }
                    }
                    _ => {}
                }
                match out.get("err") {
                    Some(e) => Err(e.clone()),
                    None => Ok(out["ok"].clone()),
                }
            }
        }
    }

    fn dump(&mut self, sid: &str) -> Value {
        let mut get = |op: Value| self.run.op(&op)["ok"].clone();
        let events: Vec<Value> =
            get(json!({"op": "events", "sessionId": sid, "after": 0, "limit": 1000}))
                .as_array()
                .unwrap()
                .iter()
                .filter(|e| e["type"] == "compaction.prune")
                .cloned()
                .collect();
        json!({
            "messages": get(json!({"op": "messages", "sessionId": sid})),
            "summaries": get(json!({"op": "summaries", "sessionId": sid})),
            "visibility": get(json!({"op": "visibility", "sessionId": sid})),
            "explanation": get(json!({"op": "pruneExplanation", "sessionId": sid})),
            "metrics": get(json!({"op": "pruneMetrics", "sessionId": sid})),
            "events": events,
        })
    }
}

// ---- scenario replay -------------------------------------------------------------------------------------------------

fn replay(file: &str) {
    let all = fixture(file);
    let mut failures = Vec::new();
    for sc in all.as_array().unwrap() {
        let name = sc["name"].as_str().unwrap();
        let mut w = World::new(name);
        for (i, step) in sc["ops"].as_array().unwrap().iter().enumerate() {
            let op = &step["op"];
            let res = w.step(op);
            let mut got = Map::new();
            match res {
                Ok(v) => got.insert("ok".into(), v),
                Err(e) => got.insert("err".into(), e),
            };
            got.insert(
                "log".into(),
                Value::Array(w.sh.log.borrow_mut().drain(..).collect()),
            );
            let mut want = Map::new();
            for k in ["ok", "err", "log"] {
                if let Some(v) = step.get(k) {
                    want.insert(k.into(), v.clone());
                }
            }
            // The base ops answer `{ok}` with a null the exporter keeps as `ok: null`.
            if want.get("ok").is_none() && want.get("err").is_none() {
                want.insert("ok".into(), Value::Null);
            }
            let (want, got) = (Value::Object(want), Value::Object(got));
            if want != got {
                failures.push(format!(
                    "{name} #{i} {}\n  {}",
                    clip(&op.to_string(), 300),
                    first_diff(&want, &got)
                ));
                if failures.len() > 6 {
                    break;
                }
            }
        }
        if failures.len() > 6 {
            break;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn compaction_scenarios_match_typescript_1() {
    replay("compaction-1");
}
#[test]
fn compaction_scenarios_match_typescript_2() {
    replay("compaction-2");
}
#[test]
fn compaction_scenarios_match_typescript_3() {
    replay("compaction-3");
}
#[test]
fn compaction_scenarios_match_typescript_4() {
    replay("compaction-4");
}
#[test]
fn pruning_scenarios_match_typescript_5() {
    replay("pruning-5");
}
#[test]
fn pruning_scenarios_match_typescript_1() {
    replay("pruning-1");
}
#[test]
fn pruning_scenarios_match_typescript_2() {
    replay("pruning-2");
}
#[test]
fn pruning_scenarios_match_typescript_3() {
    replay("pruning-3");
}
#[test]
fn pruning_scenarios_match_typescript_4() {
    replay("pruning-4");
}

// ---- the summarizer --------------------------------------------------------------------------------------------------

struct ScriptedProvider {
    responses: Vec<Value>,
    role_models: Option<Option<Vec<ContextModel>>>,
    calls: Rc<Cell<usize>>,
    requests: Rc<RefCell<Vec<Value>>>,
}

impl SummaryProvider for ScriptedProvider {
    fn role_models(&self) -> Option<Vec<ContextModel>> {
        self.role_models.clone().flatten()
    }
    fn stream(&mut self, request: &SummaryRequest) -> Vec<StreamItem> {
        let id = &request.turn_id;
        let b = id.as_bytes();
        assert!(
            id.len() == 36 && b[14] == b'4' && matches!(b[19], b'8' | b'9' | b'a' | b'b'),
            "turnId is not a v4 uuid: {id}"
        );
        let mut r = request.to_j().to_value();
        r["turnId"] = json!("$uuid");
        self.requests.borrow_mut().push(r);
        let n = self.calls.get();
        self.calls.set(n + 1);
        let resp = &self.responses[n.min(self.responses.len() - 1)];
        let user = request.user.clone();
        let calls = self.calls.get();
        let mut out = Vec::new();
        let default = vec![json!({"echoDefault": true})];
        let items = resp
            .get("items")
            .and_then(Value::as_array)
            .unwrap_or(&default);
        for it in items {
            if let Some(d) = it.get("delta") {
                out.push(StreamItem::Delta(d.as_str().unwrap().to_owned()));
            } else if let Some(e) = it.get("echo").and_then(Value::as_u64) {
                out.push(StreamItem::Delta(format!(
                    "S{calls}:{}",
                    head(&user, e as i64)
                )));
            } else if it.get("echoDefault").is_some() {
                out.push(StreamItem::Delta(format!("S{calls}:{}", head(&user, 12))));
            } else if let Some(fl) = it.get("fill") {
                out.push(StreamItem::Delta(
                    fl.as_str()
                        .unwrap()
                        .repeat(it["times"].as_u64().unwrap() as usize),
                ));
            } else if let Some(u) = it.get("usage") {
                let mut j = J::from_value(u);
                j.set("type", J::s("usage"));
                out.push(StreamItem::Usage(j));
            } else if let Some(t) = it.get("tool") {
                out.push(if t == "call" {
                    StreamItem::ToolCall
                } else {
                    StreamItem::ToolResult
                });
            } else if let Some(m) = it.get("throw") {
                out.push(StreamItem::Throw(m.as_str().unwrap().to_owned()));
                break;
            }
        }
        out
    }
}

#[test]
fn summarizer_matches_typescript() {
    let all = fixture("summarizer");
    let mut bad = Vec::new();
    for c in all.as_array().unwrap() {
        let name = gs(c, "name");
        let spec = &c["spec"];
        let calls = Rc::new(Cell::new(0));
        let requests = Rc::new(RefCell::new(Vec::new()));
        let usages = Rc::new(RefCell::new(Vec::new()));
        let responses = spec
            .get("responses")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| vec![json!({"items": [{"delta": "SUMMARY"}]})]);
        let role_models = match spec.get("roleModels") {
            None => None,
            Some(Value::String(_)) => None,
            Some(Value::Null) => Some(None),
            Some(v) => Some(Some(
                v.as_array()
                    .unwrap()
                    .iter()
                    .map(|m| ContextModel {
                        provider: gs(m, "provider").to_owned(),
                        model: gs(m, "model").to_owned(),
                    })
                    .collect(),
            )),
        };
        let provider = ScriptedProvider {
            responses,
            role_models,
            calls: calls.clone(),
            requests: requests.clone(),
        };
        let sink = usages.clone();
        let context = J::from_value(
            &json!({"sessionId": "ses_1", "agentId": "bernd", "principal": "user:v1:alice", "caller": {"kind": "cli", "uid": 501}}),
        );
        let purpose = if spec.get("purpose").and_then(Value::as_str) == Some("lesson") {
            SummaryPurpose::Lesson
        } else {
            SummaryPurpose::Compaction
        };
        let mut s = LlmSummarizer::new(
            provider,
            context,
            gi(spec, "inputMaxTokens").unwrap_or(2048),
            Some(Box::new(move |u: &J| sink.borrow_mut().push(u.to_value()))),
            purpose,
            Arc::new(crate::budget::UuidIds),
        );
        let got = s.summarize(
            &summary_messages(&spec["messages"]),
            gi(spec, "maxTokens").unwrap(),
        );
        let mut want = Map::new();
        for k in ["ok", "err"] {
            if let Some(v) = c.get(k) {
                want.insert(k.into(), v.clone());
            }
        }
        want.insert("calls".into(), c["calls"].clone());
        want.insert("requests".into(), c["requests"].clone());
        want.insert("usages".into(), c["usages"].clone());
        let mut have = Map::new();
        match got {
            Ok(v) => have.insert("ok".into(), json!(v)),
            Err(e) => have.insert("err".into(), json!(e)),
        };
        have.insert("calls".into(), json!(calls.get()));
        have.insert("requests".into(), Value::Array(requests.borrow().clone()));
        have.insert("usages".into(), Value::Array(usages.borrow().clone()));
        let (want, have) = (Value::Object(want), Value::Object(have));
        if want != have {
            bad.push(format!("{name}\n  {}", first_diff(&want, &have)));
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}
