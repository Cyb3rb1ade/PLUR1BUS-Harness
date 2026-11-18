//! Replays `fixtures/parity/decision/*.json` (mode V, `scripts/parity/export-decision.ts`) against the Rust port. The
//! doubles of the ports play the recorded scripts and compare every request the port receives with the one TypeScript
//! built, as text.
use super::adapters::{decide_pruning, DecisionTreeChooser, PruningPair, TreeCandidate};
use super::client::{DecisionClient, DecisionOptions};
use super::role::{
    category_prefix, resolve_role, Candidate, RoleBackend, RoleCall, RoleChunk, RoleFault,
    RoleRouter,
};
use super::skills::{
    enriched_skill_query, fair_task_skills, is_skill_followup, rule_skills, select_decision_skills,
    Chooser, SkillCandidate, SkillPick, SkillSelectionInput, SkillSource,
};
use super::system_one::{
    accepts_json, Budget, BudgetCall, Http, HttpCall, HttpFault, Kind, LeasedSecret, PortFailed,
    Secrets, SystemOneBackend, SystemOneOptions,
};
use super::types::*;
use crate::approvals::js_json::{num_value, J};
use crate::prompt::vectors::{dec, num};
use crate::triage::runtime::Aborted;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use zeroize::Zeroizing;

fn fixture(name: &str) -> Value {
    let text = match name {
        "client" => include_str!("../../../../fixtures/parity/decision/client.json"),
        "skills" => include_str!("../../../../fixtures/parity/decision/skills.json"),
        "adapters" => include_str!("../../../../fixtures/parity/decision/adapters.json"),
        "role" => include_str!("../../../../fixtures/parity/decision/role.json"),
        "system-one" => include_str!("../../../../fixtures/parity/decision/system-one.json"),
        other => panic!("no fixture {other}"),
    };
    serde_json::from_str(text).expect("fixture parses")
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("string, got {v}"))
}

fn opt_s(v: &Value, key: &str) -> Option<String> {
    v.get(key).filter(|x| !x.is_null()).map(|x| s(x).to_owned())
}

struct TestClock(Mutex<f64>);

impl TestClock {
    fn set(&self, t: f64) {
        *self.0.lock().unwrap() = t;
    }
    fn advance(&self, ms: f64) {
        *self.0.lock().unwrap() += ms;
    }
}

impl Clock for TestClock {
    fn now(&self) -> f64 {
        *self.0.lock().unwrap()
    }
}

struct Flag(AtomicBool);

impl Cancel for Flag {
    fn cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

struct FixedId;

impl IdSource for FixedId {
    fn next_id(&self) -> String {
        "$id".to_owned()
    }
}

struct LiveConfig(Mutex<Value>);

impl DecisionConfig for LiveConfig {
    fn config(&self) -> Value {
        self.0.lock().unwrap().clone()
    }
}

/// A typed input from a recorded one; `None` where a Rust caller cannot build it (the exporter keeps those apart).
fn input(v: &Value) -> Option<DecisionInput> {
    let use_case = match v.get("useCase")?.as_str()? {
        "triage" => UseCase::Triage,
        "routing" => UseCase::Routing,
        "pruning" => UseCase::Pruning,
        "skills" => UseCase::Skills,
        "placement" => UseCase::Placement,
        "zoom" => UseCase::Zoom,
        "compaction" => UseCase::Compaction,
        _ => return None,
    };
    // Features are recorded as `$entries`, in the order of `Object.entries` (the fixture writer sorts object keys).
    let features = match v.get("features") {
        None => None,
        Some(f) => Some(
            f.get("$entries")?
                .as_array()?
                .iter()
                .map(|e| {
                    let feature = match &e[1] {
                        Value::Bool(b) => Feature::Flag(*b),
                        Value::String(text) => Feature::Text(text.clone()),
                        other if other.is_number() || other.get("$num").is_some() => {
                            Feature::Number(num(other))
                        }
                        _ => return None,
                    };
                    Some((e[0].as_str()?.to_owned(), feature))
                })
                .collect::<Option<Vec<_>>>()?,
        ),
    };
    let options = match v.get("options") {
        None => None,
        Some(Value::Array(list)) => Some(
            list.iter()
                .map(|o| {
                    Some(ChoiceOption {
                        id: o.get("id")?.as_str()?.to_owned(),
                        description: o.get("description")?.as_str()?.to_owned(),
                    })
                })
                .collect::<Option<Vec<_>>>()?,
        ),
        Some(_) => return None,
    };
    let levels = match v.get("levels") {
        None => None,
        Some(Value::Array(list)) => Some(
            list.iter()
                .map(|l| l.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()?,
        ),
        Some(_) => return None,
    };
    Some(DecisionInput {
        use_case,
        state: v.get("state")?.as_str()?.to_owned(),
        question: v.get("question")?.as_str()?.to_owned(),
        features,
        options,
        levels,
    })
}

/// A recorded input as the text `JSON.stringify` gives in TypeScript: `{ useCase, state, question, features?, options?, levels? }`.
fn input_text(i: &DecisionInput) -> String {
    let mut j = J::obj([
        ("useCase", J::s(i.use_case.as_str())),
        ("state", J::s(&i.state)),
        ("question", J::s(&i.question)),
    ]);
    if let Some(features) = i.features_j() {
        j.set("features", features);
    }
    if let Some(options) = &i.options {
        j.set(
            "options",
            J::Arr(
                options
                    .iter()
                    .map(|o| J::obj([("id", J::s(&o.id)), ("description", J::s(&o.description))]))
                    .collect(),
            ),
        );
    }
    if let Some(levels) = &i.levels {
        j.set("levels", J::Arr(levels.iter().map(|l| J::s(l)).collect()));
    }
    j.stringify()
}

fn context(v: &Value, cancel: &Arc<Flag>) -> DecisionContext {
    // The chat request is recorded as `$entries` where its member order reaches a request.
    let chat = v.get("chat").map(|c| {
        let request = match c.get("$entries").and_then(Value::as_array) {
            Some(list) => J::Obj(
                list.iter()
                    .map(|e| (s(&e[0]).to_owned(), J::from_value(&e[1])))
                    .collect(),
            ),
            None => J::from_value(c),
        };
        let member = |key: &str| request.get(key).and_then(J::as_str).map(str::to_owned);
        ChatContext {
            principal: member("principal"),
            project_id: member("projectId"),
            role: member("role"),
            request,
        }
    });
    DecisionContext {
        agent_id: v.get("agentId").map_or("bernd", s).to_owned(),
        session_id: opt_s(v, "sessionId"),
        turn_id: opt_s(v, "turnId"),
        principal: opt_s(v, "principal"),
        cancel: Arc::clone(cancel) as Arc<dyn Cancel>,
        locale: None,
        deadline: v.get("deadline").map(num),
        force_local: v.get("forceLocal") == Some(&Value::Bool(true)),
        cloud_eligible: v.get("cloudEligible") == Some(&Value::Bool(true)),
        chat,
    }
}

// --- the client ---------------------------------------------------------------------------------------------------------------

struct ScriptedBackend {
    name: &'static str,
    spec: Value,
    runs: Mutex<Vec<Value>>,
    clock: Arc<TestClock>,
    cancel: Arc<Mutex<Arc<Flag>>>,
    config: Arc<LiveConfig>,
    requests: Arc<Mutex<Vec<Value>>>,
}

fn fitting(request: &DecisionRequest) -> J {
    match request.primitive {
        Primitive::TriageCompat => {
            J::parse(r#"{"schema":"plur1bus.triage/1","shape":"chat","tasks":[]}"#).unwrap()
        }
        Primitive::Choice => {
            let options = request.input.options.as_ref().unwrap();
            let mut probabilities = J::Obj(Vec::new());
            for (i, o) in options.iter().enumerate() {
                probabilities.set(&o.id, J::Num(if i == 0 { 1.0 } else { 0.0 }));
            }
            J::obj([
                ("id", J::s(&options[0].id)),
                ("probabilities", probabilities),
                ("confidence", J::Num(0.9)),
            ])
        }
        Primitive::Score => {
            let n = request.input.levels.as_ref().unwrap().len();
            J::obj([
                (
                    "probabilities",
                    J::Arr(
                        (0..n)
                            .map(|i| J::Num(if i == 0 { 1.0 } else { 0.0 }))
                            .collect(),
                    ),
                ),
                ("confidence", J::Num(0.9)),
            ])
        }
        Primitive::Noul => J::obj([("probability", J::Num(0.9))]),
    }
}

impl DecisionBackend for ScriptedBackend {
    fn local(&self, _context: &DecisionContext) -> Result<Option<bool>, BackendError> {
        if self.spec.get("onLocal").is_some() {
            self.config.0.lock().unwrap()["privacy"] = json!({ "localOnly": true });
        }
        match &self.spec["local"] {
            Value::Bool(b) => Ok(Some(*b)),
            Value::Null => Ok(None),
            _ => Err(BackendError::Other),
        }
    }

    fn has_eligible(&self) -> bool {
        self.spec.get("eligible").is_some()
    }

    fn eligible(&self, _context: &DecisionContext) -> Result<bool, BackendError> {
        self.spec["eligible"].as_bool().ok_or(BackendError::Other)
    }

    fn run(&self, request: &DecisionRequest, _cancel: &dyn Cancel) -> Result<J, BackendError> {
        self.requests.lock().unwrap().push(json!({
            "backend": self.name, "primitive": request.primitive.as_str(), "deadline": num_value(request.deadline), "useCase": request.input.use_case.as_str(),
            "forceLocal": request.context.force_local, "hasOptions": request.input.options.is_some(), "hasLevels": request.input.levels.is_some(),
        }));
        if self.spec.get("fit").is_some() {
            return Ok(fitting(request));
        }
        let mut runs = self.runs.lock().unwrap();
        let run = if runs.is_empty() {
            json!({ "throw": "unavailable" })
        } else {
            runs.remove(0)
        };
        self.clock
            .advance(run.get("advance").and_then(Value::as_f64).unwrap_or(0.0));
        if run.get("abort").is_some() {
            self.cancel.lock().unwrap().0.store(true, Ordering::SeqCst);
        }
        if run.get("hang").is_some() {
            // A backend that never answers gives up at the deadline it was handed.
            self.clock.set(request.deadline);
            return Err(BackendError::Interrupted);
        }
        if let Some(reason) = run.get("throw") {
            return Err(BackendError::Reason(failure(s(reason))));
        }
        if run.get("throwOther").is_some() {
            return Err(BackendError::Other);
        }
        Ok(J::parse(s(&run["answerJson"])).expect("a recorded answer parses"))
    }
}

fn failure(text: &str) -> Failure {
    [
        Failure::Unavailable,
        Failure::Timeout,
        Failure::Invalid,
        Failure::LowConfidence,
        Failure::Privacy,
        Failure::Cancelled,
    ]
    .into_iter()
    .find(|f| f.as_str() == text)
    .unwrap()
}

/// `deadline` is compared as a number: both sides print the same double.
fn requests_value(list: &[Value]) -> Value {
    Value::Array(list.to_vec())
}

#[test]
fn client_vectors_replay() {
    let f = fixture("client");
    let (mut calls, mut untyped) = (0, 0);
    for scenario in f["scenarios"].as_array().unwrap() {
        let name = s(&scenario["name"]);
        let mut cfg = json!({ "decision": {} });
        for (k, v) in scenario["config"].as_object().unwrap() {
            cfg[k] = v.clone();
        }
        let config = Arc::new(LiveConfig(Mutex::new(cfg)));
        let clock = Arc::new(TestClock(Mutex::new(1000.0)));
        let cancel = Arc::new(Mutex::new(Arc::new(Flag(AtomicBool::new(false)))));
        let requests: Arc<Mutex<Vec<Value>>> = Arc::default();
        let events: Arc<Mutex<Vec<String>>> = Arc::default();
        // `Object.keys(backends)`: the order they were written in the scenario is lost in the fixture (sorted keys);
        // the exporter writes them as role, laya, kev, jev or a subset, and `status` is compared without `installed`.
        let backends: Vec<(BackendName, Arc<dyn DecisionBackend>)> = scenario["backends"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(backend, spec)| {
                let name = BackendName::parse(backend).unwrap();
                let scripted = ScriptedBackend {
                    name: name.as_str(),
                    spec: spec.clone(),
                    runs: Mutex::new(
                        spec.get("runs")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default(),
                    ),
                    clock: Arc::clone(&clock),
                    cancel: Arc::clone(&cancel),
                    config: Arc::clone(&config),
                    requests: Arc::clone(&requests),
                };
                (name, Arc::new(scripted) as Arc<dyn DecisionBackend>)
            })
            .collect();
        let sink = Arc::clone(&events);
        let client = DecisionClient::new(DecisionOptions {
            config: Arc::clone(&config) as Arc<dyn DecisionConfig>,
            backends,
            emit: Some(Box::new(move |_, event| {
                sink.lock().unwrap().push(event.to_j().stringify())
            })),
            clock: Arc::clone(&clock) as Arc<dyn Clock>,
            ids: Arc::new(FixedId),
        });
        let typed = scenario["typed"] == true;
        for (i, recorded) in scenario["calls"].as_array().unwrap().iter().enumerate() {
            let what = format!("{name}[{i}]");
            let call = dec(&recorded["call"], &f);
            if !typed {
                assert!(
                    call.get("input").is_some_and(|v| input(v).is_none()),
                    "{what}: a typed caller cannot build this input"
                );
                assert!(
                    s(&recorded["json"]).contains(r#""reason":"invalid""#),
                    "{what}: TypeScript calls it invalid"
                );
                untyped += 1;
                continue;
            }
            clock.set(call.get("at").and_then(Value::as_f64).unwrap_or(1000.0));
            let flag = Arc::new(Flag(AtomicBool::new(call.get("abortedBefore").is_some())));
            *cancel.lock().unwrap() = Arc::clone(&flag);
            events.lock().unwrap().clear();
            requests.lock().unwrap().clear();
            let ctx = context(call.get("context").unwrap_or(&json!({})), &flag);
            let result = match s(&call["primitive"]) {
                "triage" => client.triage(s(&call["message"]), &ctx),
                primitive => {
                    let typed_input =
                        input(&call["input"]).unwrap_or_else(|| panic!("{what}: input"));
                    match primitive {
                        "noul" => client.noul(&typed_input, &ctx),
                        "choice" => client.choice(&typed_input, &ctx),
                        _ => client.score(&typed_input, &ctx),
                    }
                }
            };
            assert_eq!(
                result_j(&result).stringify(),
                s(&recorded["json"]),
                "{what}: the result"
            );
            let want_events: Vec<String> = recorded["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| s(e).to_owned())
                .collect();
            assert_eq!(*events.lock().unwrap(), want_events, "{what}: the event");
            assert_eq!(
                requests_value(&requests.lock().unwrap()),
                recorded["requests"],
                "{what}: what the backends were asked"
            );
            calls += 1;
        }
        if typed {
            // `installed` lists the backends in the order of the TypeScript object, which the fixture does not keep.
            let mut got = client.status().to_value();
            let mut want: Value = serde_json::from_str(s(&scenario["status"])).unwrap();
            for v in [&mut got, &mut want] {
                let installed = v["installed"].as_array_mut().unwrap();
                installed.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
            }
            assert_eq!(got, want, "{name}: status");
        }
    }
    assert!(
        calls > 220 && untyped == 9,
        "{calls} calls, {untyped} untyped"
    );
}

#[test]
fn the_sample_window_is_bounded() {
    let clock = Arc::new(TestClock(Mutex::new(0.0)));
    let client = DecisionClient::new(DecisionOptions {
        config: Arc::new(LiveConfig(Mutex::new(json!({})))),
        backends: Vec::new(),
        emit: None,
        clock: Arc::clone(&clock) as Arc<dyn Clock>,
        ids: Arc::new(FixedId),
    });
    let ctx = DecisionContext::new("a");
    let question = DecisionInput {
        use_case: UseCase::Routing,
        state: String::new(),
        question: String::new(),
        features: None,
        options: None,
        levels: None,
    };
    for _ in 0..600 {
        assert_eq!(
            client.noul(&question, &ctx).unwrap_err().reason,
            Failure::Unavailable
        );
    }
    let status = client.status().to_value();
    assert_eq!(status["requests"], 600);
    assert_eq!(status["failures"], 600);
    assert_eq!(status["errorRate"], 1);
    assert_eq!(status["backend"], "role");
}

// --- skills, pruning, the tree ------------------------------------------------------------------------------------------------

struct ScriptedChooser {
    script: Mutex<Vec<Value>>,
    seen: Mutex<Vec<Value>>,
    clock: Arc<TestClock>,
    abort: Option<Arc<Flag>>,
}

impl ScriptedChooser {
    fn new(script: &Value, clock: &Arc<TestClock>, abort: Option<&Arc<Flag>>) -> Self {
        Self {
            script: Mutex::new(script.as_array().unwrap().clone()),
            seen: Mutex::default(),
            clock: Arc::clone(clock),
            abort: abort.cloned(),
        }
    }
}

impl Chooser for ScriptedChooser {
    fn choice(&self, input: &DecisionInput, context: &DecisionContext) -> DecisionResult {
        let mut script = self.script.lock().unwrap();
        let next = if script.is_empty() {
            json!({ "ok": false, "reason": "unavailable" })
        } else {
            script.remove(0)
        };
        self.seen.lock().unwrap().push(json!({ "request": input_text(input), "deadline": context.deadline.map(num_value), "forceLocal": context.force_local, "agentId": context.agent_id }));
        self.clock
            .advance(next.get("advance").and_then(Value::as_f64).unwrap_or(0.0));
        if let Some(flag) = &self.abort {
            flag.0.store(true, Ordering::SeqCst);
        }
        if next.get("ok") == Some(&Value::Bool(false)) {
            return Err(DecisionError {
                request_id: "r".to_owned(),
                elapsed_ms: 1.0,
                reason: failure(s(&next["reason"])),
                attempted: Vec::new(),
            });
        }
        // `Object.entries` of the recorded probabilities: the order is not kept by the fixture, and none of the
        // adapters depends on it.
        let probabilities = next["value"]["probabilities"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, p)| (k.clone(), p.as_f64().unwrap()))
            .collect();
        Ok(DecisionSuccess {
            request_id: "r".to_owned(),
            backend: BackendName::Role,
            elapsed_ms: 1.0,
            model_revision: None,
            value: DecisionValue::Choice {
                id: s(&next["value"]["id"]).to_owned(),
                probabilities,
            },
            confidence: next
                .get("confidence")
                .and_then(Value::as_f64)
                .unwrap_or(0.8),
            confidence_source: ConfidenceSource::Uncalibrated,
        })
    }
}

/// The requests a chooser saw against the recorded ones. A case with `divergence` (K9a-D1) holds the text with U+FFFD
/// where TypeScript's `slice` left half a surrogate pair; that is the text the Rust port builds.
fn same_requests(what: &str, seen: &[Value], want: &Value) {
    let want: Vec<Value> = want
        .as_array()
        .unwrap()
        .iter()
        .map(|r| json!({ "request": r["request"], "deadline": r["deadline"], "forceLocal": r["forceLocal"], "agentId": r["agentId"] }))
        .collect();
    assert_eq!(seen, want.as_slice(), "{what}: the requests");
}

fn candidate(v: &Value) -> SkillCandidate {
    SkillCandidate {
        id: s(&v["id"]).to_owned(),
        name: s(&v["name"]).to_owned(),
        description: s(&v["description"]).to_owned(),
        confidence: v.get("confidence").map(num),
    }
}

fn selection(v: &Value) -> SkillSelectionInput {
    let names = |key: &str| {
        v.get(key)
            .and_then(Value::as_array)
            .map(|l| l.iter().map(|x| s(x).to_owned()).collect())
            .unwrap_or_default()
    };
    SkillSelectionInput {
        query: s(&v["query"]).to_owned(),
        candidates: v["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(candidate)
            .collect(),
        pinned: names("pinned"),
        blocked: names("blocked"),
        max_ms: v.get("maxMs").map(num),
    }
}

fn pick(v: &Value) -> SkillPick {
    let source = match s(&v["source"]) {
        "pinned" => SkillSource::Pinned,
        "rule" => SkillSource::Rule,
        _ => SkillSource::Decision,
    };
    SkillPick {
        skill: candidate(v),
        source,
    }
}

fn picks_value(picks: &[SkillPick]) -> Value {
    Value::Array(
        picks
            .iter()
            .map(|p| {
                let mut v = json!({ "id": p.skill.id, "name": p.skill.name, "description": p.skill.description, "source": p.source.as_str() });
                if let Some(c) = p.skill.confidence {
                    v["confidence"] = if c.is_finite() { json!(c) } else { json!({ "$num": if c.is_nan() { "NaN" } else { "Infinity" } }) };
                }
                v
            })
            .collect(),
    )
}

#[test]
fn skill_vectors_replay() {
    let f = fixture("skills");
    for case in f["rule"].as_array().unwrap() {
        let got = rule_skills(&selection(&dec(&case["input"], &f)));
        assert_eq!(
            picks_value(&got),
            dec(&case["picks"], &f),
            "{}",
            case["name"]
        );
    }
    let clock = Arc::new(TestClock(Mutex::new(1000.0)));
    let mut diverged = 0;
    for case in f["select"].as_array().unwrap() {
        let name = s(&case["name"]);
        clock.set(1000.0);
        let flag = Arc::new(Flag(AtomicBool::new(
            case.get("aborted").map(s) == Some("before"),
        )));
        let chooser = ScriptedChooser::new(
            &case["script"],
            &clock,
            (case.get("aborted").map(s) == Some("during")).then_some(&flag),
        );
        let ctx = context(&case["context"], &flag);
        let got = select_decision_skills(
            &chooser,
            clock.as_ref(),
            &selection(&dec(&case["input"], &f)),
            &ctx,
        );
        let requests = dec(&case["requests"], &f);
        same_requests(name, &chooser.seen.lock().unwrap(), &requests);
        diverged += requests
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r.get("divergence").is_some())
            .count();
        match (got, case.get("error")) {
            (Ok(picks), None) => assert_eq!(picks_value(&picks), dec(&case["picks"], &f), "{name}"),
            (Err(Aborted), Some(error)) => assert_eq!(s(error), "AbortError", "{name}"),
            (got, want) => panic!("{name}: Rust {got:?}, TypeScript {want:?}"),
        }
    }
    assert_eq!(diverged, 1, "one selection cuts a surrogate pair (K9a-D1)");
    for case in f["followups"].as_array().unwrap() {
        assert_eq!(
            is_skill_followup(s(&case["input"])),
            case["result"],
            "{:?}",
            case["input"]
        );
    }
    for case in f["queries"].as_array().unwrap() {
        let i = &case["input"];
        let summaries: Vec<&str> = i
            .get("tasks")
            .and_then(Value::as_array)
            .map(|t| t.iter().map(|x| s(&x["summary"])).collect())
            .unwrap_or_default();
        assert_eq!(
            enriched_skill_query(s(&i["current"]), i.get("previousUser").map(s), &summaries),
            s(&case["result"]),
            "{case}"
        );
    }
    for case in f["fair"].as_array().unwrap() {
        let tasks: Vec<Vec<SkillPick>> = case["input"]["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t.as_array().unwrap().iter().map(pick).collect())
            .collect();
        let pinned: Vec<SkillPick> = case["input"]["pinned"]
            .as_array()
            .unwrap()
            .iter()
            .map(pick)
            .collect();
        assert_eq!(
            picks_value(&fair_task_skills(&tasks, &pinned)),
            case["result"],
            "{case}"
        );
    }
}

#[test]
fn adapter_vectors_replay() {
    let f = fixture("adapters");
    let clock = Arc::new(TestClock(Mutex::new(1000.0)));
    let mut diverged = 0;
    for case in f["pruning"].as_array().unwrap() {
        let name = s(&case["name"]);
        let chooser = ScriptedChooser::new(&case["script"], &clock, None);
        let batch: Vec<PruningPair> = dec(&case["batch"], &f)
            .as_array()
            .unwrap()
            .iter()
            .map(|p| PruningPair {
                reference: s(&p["ref"]).to_owned(),
                text: s(&p["text"]).to_owned(),
            })
            .collect();
        let cancel: Arc<dyn Cancel> = Arc::new(NeverCancelled);
        let scope = |pair: &PruningPair| {
            let mut ctx = DecisionContext::new(&format!("agent-of-{}", pair.reference));
            ctx.cloud_eligible = true;
            ctx
        };
        let got = decide_pruning(
            &chooser,
            &scope,
            &batch,
            s(&dec(&case["task"], &f)),
            &cancel,
        );
        let requests = dec(&case["requests"], &f);
        same_requests(name, &chooser.seen.lock().unwrap(), &requests);
        diverged += requests
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r.get("divergence").is_some())
            .count();
        let got: Vec<Value> = got
            .iter()
            .map(|r| {
                let mut v =
                    json!({ "ref": r.reference, "relevant": r.relevant, "reason": r.reason });
                if let Some((verdict, confidence)) = r.verdict {
                    v["verdict"] = json!(verdict.as_str());
                    v["confidence"] = num_value(confidence);
                }
                v
            })
            .collect();
        assert_eq!(Value::Array(got), case["output"], "{name}");
    }
    for case in f["tree"].as_array().unwrap() {
        let name = s(&case["name"]);
        clock.set(1000.0);
        let flag = Arc::new(Flag(AtomicBool::new(
            case.get("aborted").map(s) == Some("before"),
        )));
        let chooser = ScriptedChooser::new(
            &case["script"],
            &clock,
            (case.get("aborted").map(s) == Some("during")).then_some(&flag),
        );
        let unused = Arc::new(Flag(AtomicBool::new(false)));
        let make = || context(&case["context"], &unused);
        let tree = DecisionTreeChooser {
            decisions: &chooser,
            context: &make,
            clock: clock.as_ref(),
        };
        let candidates: Vec<TreeCandidate> = dec(&case["candidates"], &f)
            .as_array()
            .unwrap()
            .iter()
            .map(|c| TreeCandidate {
                id: s(&c["id"]).to_owned(),
                name: s(&c["name"]).to_owned(),
                summary: s(&c["summary"]).to_owned(),
            })
            .collect();
        let cancel: Arc<dyn Cancel> = Arc::clone(&flag) as Arc<dyn Cancel>;
        let got = tree.choose(s(&dec(&case["query"], &f)), &candidates, &cancel);
        let requests = dec(&case["requests"], &f);
        same_requests(name, &chooser.seen.lock().unwrap(), &requests);
        diverged += requests
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r.get("divergence").is_some())
            .count();
        let got: Vec<Value> = got
            .iter()
            .map(|p| json!({ "id": p.id, "confidence": num_value(p.confidence) }))
            .collect();
        assert_eq!(Value::Array(got), case["picks"], "{name}");
    }
    assert_eq!(
        diverged, 2,
        "a task and a node name cut inside a surrogate pair (K9a-D1)"
    );
}

// --- the role backend -----------------------------------------------------------------------------------------------------------

fn candidates(v: &Value) -> Vec<Candidate> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|c| Candidate {
            provider: s(&c["provider"]).to_owned(),
            model: s(&c["model"]).to_owned(),
        })
        .collect()
}

struct ScriptedRouter {
    role: Option<String>,
    profiles: Vec<(String, Vec<Candidate>)>,
    case: Value,
    calls: Mutex<Vec<RoleCall>>,
}

impl RoleRouter for ScriptedRouter {
    fn decision_role(&self) -> Option<String> {
        self.role.clone()
    }
    fn profiles(&self) -> Vec<(String, Vec<Candidate>)> {
        self.profiles.clone()
    }
    fn is_local_provider(&self, provider: &str, _model: &str) -> Option<bool> {
        Some(provider == "local")
    }
    fn context_window(&self, provider: &str, model: &str) -> Option<f64> {
        self.case["windows"]
            .get(format!("{provider}/{model}"))
            .and_then(Value::as_f64)
    }
    fn stream(
        &self,
        call: &RoleCall,
        _cancel: &dyn Cancel,
        on_chunk: &mut dyn FnMut(RoleChunk) -> Result<(), BackendError>,
    ) -> Result<Option<Candidate>, RoleFault> {
        self.calls.lock().unwrap().push(call.clone());
        if let Some(chunks) = self.case.get("chunks").and_then(Value::as_array) {
            for chunk in chunks {
                let chunk = match s(&chunk["type"]) {
                    "delta" => RoleChunk::Delta(s(&chunk["text"]).to_owned()),
                    "tool.call" => RoleChunk::ToolCall,
                    "tool.result" => RoleChunk::ToolResult,
                    _ => RoleChunk::Other,
                };
                if on_chunk(chunk).is_err() {
                    return Ok(None);
                }
            }
            return Ok(None);
        }
        // The candidate the router streams from, and its recorded events (kept by its place in the profile).
        let used =
            &call.candidates[self.case.get("use").and_then(Value::as_u64).unwrap_or(0) as usize];
        let profile = &self
            .profiles
            .iter()
            .find(|(name, _)| *name == call.profile)
            .unwrap()
            .1;
        let at = profile.iter().position(|c| c == used).unwrap();
        let mut finished = None;
        for event in self.case["events"]
            .get(at)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(thrown) = event.get("throw") {
                return Err(if thrown["code"] == "local-only" {
                    RoleFault::LocalOnly
                } else {
                    RoleFault::Failed
                });
            }
            match s(&event["type"]) {
                "delta" if on_chunk(RoleChunk::Delta(s(&event["text"]).to_owned())).is_err() => {
                    return Ok(None)
                }
                "done" => finished = Some(used.clone()),
                _ => {}
            }
        }
        Ok(finished)
    }
}

fn request(v: &Value, cancel: &Arc<Flag>) -> DecisionRequest {
    let primitive = match s(&v["primitive"]) {
        "noul" => Primitive::Noul,
        "choice" => Primitive::Choice,
        "score" => Primitive::Score,
        _ => Primitive::TriageCompat,
    };
    DecisionRequest {
        input: input(v).expect("a typed input"),
        request_id: s(&v["requestId"]).to_owned(),
        primitive,
        deadline: num(&v["deadline"]),
        context: context(&v["context"], cancel),
    }
}

fn same_failure(what: &str, got: BackendError, want: &Value) {
    match (got, want.get("reason")) {
        (BackendError::Reason(reason), Some(recorded)) => {
            assert_eq!(reason.as_str(), s(recorded), "{what}")
        }
        (BackendError::Other, None) => assert!(want.get("other").is_some(), "{what}"),
        (got, _) => panic!("{what}: Rust {got:?}, TypeScript {want}"),
    }
}

#[test]
fn role_vectors_replay() {
    let f = fixture("role");
    assert_eq!(
        category_prefix(),
        s(&f["categoryPrefix"]),
        "the category prefix of the classifier"
    );
    let profiles = |v: &Value| -> Vec<(String, Vec<Candidate>)> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|p| (s(&p[0]).to_owned(), candidates(&p[1])))
            .collect()
    };
    for case in f["resolve"].as_array().unwrap() {
        let resolved = resolve_role(case["role"].as_str(), &profiles(&case["profiles"]));
        let local = resolved
            .as_ref()
            .map(|r| r.candidates[0].provider == "local");
        assert_eq!(json!(local), case["local"], "{case}");
    }
    let never = Arc::new(Flag(AtomicBool::new(false)));
    let (mut answered, mut refused, mut diverged) = (0, 0, 0);
    for case in f["runs"].as_array().unwrap() {
        let name = s(&case["name"]);
        let router = Arc::new(ScriptedRouter {
            role: opt_s(case, "role"),
            profiles: profiles(&f["profiles"]),
            case: dec(case, &f),
            calls: Mutex::default(),
        });
        let backend = RoleBackend::new(Arc::clone(&router) as Arc<dyn RoleRouter>);
        let req = request(&dec(&case["request"], &f), &never);
        assert_eq!(
            json!(backend.local(&req.context).unwrap()),
            case["local"],
            "{name}: local"
        );
        let got = backend.run(&req, never.as_ref());
        // What the router was asked: the profile and its candidates, the system parts, the bounds, the request text.
        let calls = router.calls.lock().unwrap();
        let created = case["created"].as_array().unwrap();
        assert_eq!(calls.len(), created.len(), "{name}: one call of the router");
        if let (Some(call), Some(created)) = (calls.first(), created.first()) {
            assert_eq!(call.profile, s(&created["profile"]), "{name}");
            assert_eq!(
                json!(call.system),
                created["system"],
                "{name}: the system parts"
            );
            assert_eq!(json!(call.max_tokens), created["maxTokens"], "{name}");
            assert_eq!(json!(call.max_rounds), created["maxRounds"], "{name}");
            assert_eq!(
                call.candidates,
                candidates(&created["candidates"]),
                "{name}: candidates in order"
            );
            let sent = &dec(&case["requests"], &f)[0];
            assert_eq!(
                call.request.stringify(),
                s(&sent["json"]),
                "{name}: the chat request, byte for byte"
            );
            assert_eq!(call.force_local, req.context.force_local, "{name}");
            assert!(
                created["requireTriage"] == false && created["profileForAgent"].is_null(),
                "{name}"
            );
        }
        match (got, case.get("error")) {
            (Ok(value), None) if case.get("divergence").is_some() => {
                // K9a-D2: TypeScript's answer with the revision the model claimed for itself; here without it.
                let mut theirs = J::parse(s(&case["json"])).unwrap();
                assert_eq!(
                    theirs.get("modelRevision").and_then(J::as_str),
                    Some("claimed"),
                    "{name}"
                );
                if let J::Obj(members) = &mut theirs {
                    members.retain(|(k, _)| k != "modelRevision");
                }
                assert_eq!(
                    value, theirs,
                    "{name}: the answer without the claimed revision"
                );
                diverged += 1;
            }
            (Ok(value), None) => {
                assert_eq!(value.stringify(), s(&case["json"]), "{name}: the answer");
                answered += 1;
            }
            (Err(e), Some(want)) => {
                same_failure(name, e, want);
                refused += 1;
            }
            (got, want) => panic!("{name}: Rust {got:?}, TypeScript {want:?}"),
        }
    }
    assert!(
        answered >= 18 && refused >= 9 && diverged == 1,
        "{answered} answered, {refused} refused, {diverged} diverged"
    );
}

// --- System One -------------------------------------------------------------------------------------------------------------------

struct Ports {
    case: Value,
    secret: String,
    parts: Vec<Value>,
    config: Arc<LiveConfig>,
    clock: Arc<TestClock>,
    cancel: Arc<Flag>,
    calls: Mutex<Vec<Value>>,
}

impl Ports {
    fn port(&self, key: &str) -> Option<&Value> {
        self.case["ports"].get(key)
    }
    fn throws(&self, key: &str) -> bool {
        self.port(key).and_then(Value::as_str) == Some("throw")
    }
    fn log(&self, call: Value) {
        self.calls.lock().unwrap().push(call);
    }
}

impl Budget for Ports {
    fn check_before_call(&self, call: &BudgetCall) -> Option<String> {
        let mut v = json!({ "principal": call.principal, "agent": call.agent, "project": call.project, "model": call.model, "provider": call.provider,
            "estimatedInputTokens": call.estimated_input_tokens as u64, "maxOutputTokens": call.max_output_tokens as u64 });
        if let Some(session) = &call.session {
            v["session"] = json!(session);
        }
        if let Some(turn) = &call.turn {
            v["turn"] = json!(turn);
        }
        self.log(json!(["budget.checkBeforeCall", v]));
        (self.port("budget").and_then(Value::as_str) != Some("refuse")).then(|| "res-1".to_owned())
    }
    fn settle(
        &self,
        reservation: &str,
        input_tokens: f64,
        output_tokens: f64,
    ) -> Result<(), PortFailed> {
        self.log(json!(["budget.settle", reservation, { "inputTokens": input_tokens as u64, "outputTokens": output_tokens as u64 }]));
        if self.throws("settle") {
            Err(PortFailed)
        } else {
            Ok(())
        }
    }
    fn release_unused(&self, reservation: &str) -> Result<(), PortFailed> {
        self.log(json!(["budget.releaseUnused", reservation]));
        if self.throws("release") {
            Err(PortFailed)
        } else {
            Ok(())
        }
    }
}

impl Secrets for Ports {
    fn lease(
        &self,
        name: &str,
        purpose: &str,
        profile_id: &str,
        ttl_ms: f64,
    ) -> Result<String, PortFailed> {
        self.log(json!(["secrets.lease", name, { "purpose": purpose, "profileId": profile_id, "ttlMs": ttl_ms as u64 }]));
        self.clock.advance(
            self.port("leaseAdvance")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
        );
        if self.port("leaseAbort").is_some() {
            self.cancel.0.store(true, Ordering::SeqCst);
        }
        if let Some(during) = self.port("duringLease") {
            let mut config = self.config.0.lock().unwrap();
            if during.get("localOnly").is_some() {
                config["privacy"] = json!({ "localOnly": true });
            } else {
                let kind = s(&self.case["kind"]);
                for (k, v) in during.as_object().unwrap() {
                    config["decision"]["systemOne"][kind][k] = v.clone();
                }
            }
        }
        if self.throws("lease") {
            Err(PortFailed)
        } else {
            Ok("lease-1".to_owned())
        }
    }
    fn read_lease(&self, lease_id: &str) -> Result<LeasedSecret, PortFailed> {
        self.log(json!(["secrets.readLease", lease_id]));
        if self.throws("readLease") {
            return Err(PortFailed);
        }
        Ok(LeasedSecret {
            purpose: self.port("leasePurpose").map_or("decision", s).to_owned(),
            profile_id: self
                .port("leaseProfile")
                .map_or("decision-service", s)
                .to_owned(),
            value: Zeroizing::new(self.secret.clone()),
        })
    }
    fn revoke_lease(&self, lease_id: &str) -> Result<(), PortFailed> {
        self.log(json!(["secrets.revokeLease", lease_id]));
        if self.throws("revoke") {
            Err(PortFailed)
        } else {
            Ok(())
        }
    }
}

impl Http for Ports {
    fn request(&self, call: &HttpCall, _cancel: &dyn Cancel) -> Result<(u16, Vec<u8>), HttpFault> {
        let mut headers = json!({ "content-type": HttpCall::CONTENT_TYPE });
        if let Some(authorization) = &call.authorization {
            let whole = authorization.as_str() == format!("Bearer {}", self.secret);
            let mut parts = vec![json!("Bearer ")];
            parts.extend(self.parts.iter().cloned());
            headers["authorization"] =
                json!({ "parts": if whole { parts } else { vec![json!("?")] } });
        }
        let types = [
            Some("application/json"),
            Some("application/json; charset=utf-8"),
            Some("APPLICATION/JSON \t;"),
            Some("application/jsonp"),
            Some("text/json"),
            Some("application/json+x"),
            None,
            Some(""),
            Some(" application/json"),
        ];
        let accepts: Vec<Value> = types.iter().map(|t| json!([t, accepts_json(*t)])).collect();
        self.log(json!(["egress.request", { "url": call.url, "method": HttpCall::METHOD, "maxRequestBytes": HttpCall::MAX_BYTES, "maxBytes": HttpCall::MAX_BYTES, "maxRedirects": 0, "errorBodyBytes": 0,
            "timeoutMs": call.timeout_ms as u64, "userAgent": HttpCall::USER_AGENT, "accept": HttpCall::CONTENT_TYPE, "body": call.body, "bytes": call.body.len(), "headers": headers, "accepts": accepts }]));
        self.clock.advance(
            self.port("httpAdvance")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
        );
        if self.port("httpAbort").is_some() {
            self.cancel.0.store(true, Ordering::SeqCst);
        }
        match self.port("http").and_then(Value::as_str) {
            Some("timeout") => return Err(HttpFault::Timeout),
            Some(_) => return Err(HttpFault::Other),
            None => {}
        }
        let response = self
            .case
            .get("response")
            .cloned()
            .unwrap_or_else(|| json!({ "status": 200, "json": {} }));
        let body = match response.get("text") {
            Some(text) => s(text).to_owned(),
            // The recorded body is `JSON.stringify(json)`; its member order is the fixture's here, which the closed
            // checks do not depend on.
            None => response["json"].to_string(),
        };
        Ok((
            response["status"].as_u64().unwrap() as u16,
            body.into_bytes(),
        ))
    }
}

#[test]
fn system_one_vectors_replay() {
    let f = fixture("system-one");
    let (mut answered, mut refused) = (0, 0);
    for raw in f["cases"].as_array().unwrap() {
        let case = dec(raw, &f);
        let name = s(&case["name"]);
        let parts: Vec<Value> = case["ports"]
            .get("leaseValue")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| f["secret"]["parts"].as_array().unwrap().clone());
        let secret: String = parts.iter().map(s).collect();
        let cancel = Arc::new(Flag(AtomicBool::new(
            case["ports"].get("abortedBefore").is_some(),
        )));
        let ports = Arc::new(Ports {
            secret,
            parts,
            config: Arc::new(LiveConfig(Mutex::new(case["config"].clone()))),
            clock: Arc::new(TestClock(Mutex::new(1000.0))),
            cancel: Arc::clone(&cancel),
            calls: Mutex::default(),
            case: case.clone(),
        });
        let kind = if case["kind"] == "jev" {
            Kind::Jev
        } else {
            Kind::Kev
        };
        let kev = case["kevEligible"].as_bool();
        let options = SystemOneOptions {
            config: Arc::clone(&ports.config) as Arc<dyn DecisionConfig>,
            http: Arc::clone(&ports) as Arc<dyn Http>,
            secrets: Arc::clone(&ports) as Arc<dyn Secrets>,
            budget: (case["noBudget"] != true).then(|| Arc::clone(&ports) as Arc<dyn Budget>),
            clock: Arc::clone(&ports.clock) as Arc<dyn Clock>,
            test_origin: opt_s(&case, "testOrigin"),
            kev_eligible: kev
                .map(|eligible| Box::new(move || eligible) as Box<dyn Fn() -> bool + Send + Sync>),
        };
        let backend = match (
            SystemOneBackend::new(kind, options),
            case.get("constructError"),
        ) {
            (Ok(backend), None) => backend,
            (Err(e), Some(want)) => {
                same_failure(name, e, want);
                refused += 1;
                continue;
            }
            (got, want) => panic!(
                "{name}: construction: Rust {:?}, TypeScript {want:?}",
                got.err()
            ),
        };
        let req = request(&case["request"], &cancel);
        assert_eq!(
            json!(backend.local(&req.context).unwrap()),
            case["local"],
            "{name}: local"
        );
        assert_eq!(
            json!(backend.eligible(&req.context).unwrap()),
            case["eligible"],
            "{name}: eligible"
        );
        let got = backend.run(&req, cancel.as_ref());
        assert_eq!(
            Value::Array(ports.calls.lock().unwrap().clone()),
            case["calls"],
            "{name}: the calls on the ports, in order"
        );
        match (got, case.get("error")) {
            (Ok(value), None) => {
                assert_eq!(value.stringify(), s(&case["json"]), "{name}: the answer");
                answered += 1;
            }
            (Err(e), Some(want)) => {
                same_failure(name, e, want);
                refused += 1;
            }
            (got, want) => panic!("{name}: Rust {got:?}, TypeScript {want:?}"),
        }
    }
    assert!(
        answered >= 20 && refused >= 90,
        "{answered} answered, {refused} refused"
    );
}
