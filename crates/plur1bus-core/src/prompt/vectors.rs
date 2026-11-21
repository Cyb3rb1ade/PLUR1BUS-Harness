//! Replays `fixtures/parity/prompt/*.json` (mode V, `scripts/parity/export-prompt.ts`) against the Rust port.
//!
//! A rendered prompt is compared twice: its parts as values (so a failure says which part), then the digest of its
//! JSON text, which also holds the member order. The encoding of the fixtures (`$t`, `$v`, `$rep`, `$u16`, `$num`) is
//! described at the top of the exporter.
use super::builder::{PromptBuilder, PromptBuilderOptions};
use super::canonical::{canonical_json, normalize_text, normalize_text_units, sha256_hex};
use super::join::{join_blocks, Block, DeferralKind};
use super::model_table::{choose_cache_ttl, lookup_cache_profile, normalize_model_id, Mechanism};
use super::session::{PromptSession, PromptSessionOptions};
use super::skills::{
    render_available_skills, skill_description, CatalogueSkill, AVAILABLE_SKILLS_TOKEN_BUDGET,
    TOOL_USE_INSTRUCTIONS,
};
use super::telemetry::{CacheTelemetry, ProviderCacheUsage};
use super::types::*;
use super::{sticky_session_id, CacheRoute};
use crate::approvals::js_json::J;
use crate::js::utf16_len;
use crate::provider_auth::ports::Clock;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

fn fixture(name: &str) -> Value {
    let text = match name {
        "canonical" => include_str!("../../../../fixtures/parity/prompt/canonical.json"),
        "model-table" => include_str!("../../../../fixtures/parity/prompt/model-table.json"),
        "join" => include_str!("../../../../fixtures/parity/prompt/join.json"),
        "render" => include_str!("../../../../fixtures/parity/prompt/render.json"),
        "session" => include_str!("../../../../fixtures/parity/prompt/session.json"),
        "skills" => include_str!("../../../../fixtures/parity/prompt/skills.json"),
        "telemetry" => include_str!("../../../../fixtures/parity/prompt/telemetry.json"),
        other => panic!("no fixture {other}"),
    };
    serde_json::from_str(text).expect("fixture parses")
}

/// Resolves the references of the exporter's encoding. A string that was not well-formed comes back with U+FFFD in
/// place of each lone surrogate; `$num` stays (see [`num`]) except `-0`, which a JSON number can hold.
pub(crate) fn dec(v: &Value, root: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(|x| dec(x, root)).collect()),
        Value::Object(o) => {
            if o.len() == 1 {
                if let Some(i) = o.get("$t").and_then(Value::as_u64) {
                    return root["texts"][i as usize].clone();
                }
                if let Some(i) = o.get("$v").and_then(Value::as_u64) {
                    return dec(&root["values"][i as usize], root);
                }
                if let Some(r) = o.get("$rep") {
                    return Value::String(s(&r[0]).repeat(r[1].as_u64().unwrap() as usize));
                }
                if let Some(u) = o.get("$u16") {
                    return Value::String(String::from_utf16_lossy(&units(u)));
                }
                if o.get("$num").and_then(Value::as_str) == Some("-0") {
                    return json!(-0.0);
                }
            }
            Value::Object(o.iter().map(|(k, x)| (k.clone(), dec(x, root))).collect())
        }
        other => other.clone(),
    }
}

/// [`dec`] for a recorded answer: a whole number is an integer however it was written (`-0` prints as `0`), which is
/// how the Rust results come out of [`J::to_value`].
pub(crate) fn want(v: &Value, root: &Value) -> Value {
    fn whole(v: Value) -> Value {
        match v {
            Value::Number(n) => crate::approvals::js_json::num_value(n.as_f64().unwrap()),
            Value::Array(a) => Value::Array(a.into_iter().map(whole).collect()),
            Value::Object(o) => Value::Object(o.into_iter().map(|(k, x)| (k, whole(x))).collect()),
            other => other,
        }
    }
    whole(dec(v, root))
}

fn units(v: &Value) -> Vec<u16> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|u| u.as_u64().unwrap() as u16)
        .collect()
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("string, got {v}"))
}

fn opt_s(v: &Value, key: &str) -> Option<String> {
    v.get(key).map(|x| s(x).to_owned())
}

/// A number, or one JSON cannot hold.
pub(crate) fn num(v: &Value) -> f64 {
    match v.get("$num").and_then(Value::as_str) {
        Some("NaN") => f64::NAN,
        Some("Infinity") => f64::INFINITY,
        Some("-Infinity") => f64::NEG_INFINITY,
        Some("-0") => -0.0,
        Some(other) => panic!("$num {other}"),
        None => v.as_f64().unwrap_or_else(|| panic!("number, got {v}")),
    }
}

struct TestClock(Mutex<f64>);

impl Clock for TestClock {
    fn now(&self) -> f64 {
        *self.0.lock().unwrap()
    }
}

fn route(v: &Value) -> Option<CacheRoute> {
    v.get("route")
        .map(|r| serde_json::from_value(r.clone()).expect("route"))
}

fn block(v: &Value) -> Block {
    Block {
        name: s(&v["name"]).to_owned(),
        text: s(&v["text"]).to_owned(),
        droppable: v["droppable"].as_bool().unwrap(),
    }
}

fn delivery(v: &Value) -> Option<Delivery> {
    v.get("delivery").map(|d| match s(d) {
        "tool_result" => Delivery::ToolResult,
        "context" => Delivery::Context,
        other => panic!("delivery {other}"),
    })
}

fn item(v: &Value) -> ConversationItem {
    ConversationItem {
        role: match s(&v["role"]) {
            "user" => Role::User,
            "assistant" => Role::Assistant,
            other => panic!("role {other}"),
        },
        kind: v.get("kind").map(|k| match s(k) {
            "text" => ItemKind::Text,
            "tool_use" => ItemKind::ToolUse,
            "tool_result" => ItemKind::ToolResult,
            "context" => ItemKind::Context,
            other => panic!("kind {other}"),
        }),
        text: s(&v["text"]).to_owned(),
        id: opt_s(v, "id"),
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| s(x).to_owned())
        .collect()
}

fn render_input(v: &Value) -> RenderInput {
    RenderInput {
        agent_id: s(&v["agentId"]).to_owned(),
        model: s(&v["model"]).to_owned(),
        route: route(v),
        session_id: opt_s(v, "sessionId"),
        memory_refresh: v.get("invalidationReason").is_some(),
        tools: v["tools"].as_array().unwrap().clone(),
        system: strings(&v["system"]),
        memory: s(&v["memory"]).to_owned(),
        conversation: v["conversation"]
            .as_array()
            .unwrap()
            .iter()
            .map(item)
            .collect(),
        volatile: v.get("volatile").map(|vol| VolatileInput {
            blocks: vol["blocks"]
                .as_array()
                .unwrap()
                .iter()
                .map(block)
                .collect(),
            cap_chars: vol.get("capChars").map(num),
            delivery: delivery(vol),
            tool_use_id: opt_s(vol, "toolUseId"),
        }),
        cache_ttl: opt_s(v, "cacheTtl"),
        cache_hint: v.get("cacheHint").map(|h| match s(h) {
            "auto" => CacheHint::Auto,
            "none" => CacheHint::None,
            "prefer" => CacheHint::Prefer,
            other => panic!("hint {other}"),
        }),
        memory_cap: v.get("zoneCaps").and_then(|z| z.get("memory")).map(num),
    }
}

fn events_value(events: &[PromptEvent]) -> Value {
    Value::Array(events.iter().map(|e| e.to_j().to_value()).collect())
}

/// Compares one rendered prompt with its recorded step.
fn check_render(what: &str, r: &RenderedPrompt, step: &Value, root: &Value) {
    let j = r.to_j();
    let got = j.to_value();
    let summary = want(&step["summary"], root);
    for part in [
        "events",
        "breakpoints",
        "cache",
        "prefix",
        "zoneHashes",
        "prefixHashes",
        "stableTokensEstimate",
    ] {
        assert_eq!(got[part], summary[part], "{what}: {part}");
    }
    let zones: Vec<Value> = r
        .zones
        .iter()
        .map(|z| json!([z.byte_offset, z.token_estimate]))
        .collect();
    assert_eq!(Value::Array(zones), summary["zones"], "{what}: zones");
    let marked: Vec<Value> = r
        .segments
        .iter()
        .enumerate()
        .filter_map(|(i, seg)| seg.cache.as_ref().map(|ttl| json!([i, ttl])))
        .collect();
    assert_eq!(Value::Array(marked), step["marked"], "{what}: marked");
    assert_eq!(r.segments.len() as u64, step["segmentCount"], "{what}");
    if let Some(segments) = step.get("segments") {
        assert_eq!(got["segments"], want(segments, root), "{what}: segments");
    }
    let segments = canonical_json(&got["segments"]).unwrap();
    assert_eq!(
        sha256_hex(&segments),
        s(&step["segmentsDigest"]),
        "{what}: segment bytes"
    );
    assert_eq!(
        sha256_hex(&j.stringify()),
        s(&step["digest"]),
        "{what}: the JSON text of the whole result"
    );
}

type Emitted = Arc<Mutex<Vec<PromptEvent>>>;

fn builder(
    options: &Value,
    clock: &Arc<TestClock>,
    emitted: &Emitted,
) -> Result<PromptBuilder, String> {
    let mut cache_ttl_ms = HashMap::new();
    if let Some(map) = options.get("cacheTtlMs").and_then(Value::as_object) {
        for (provider, ttl) in map {
            cache_ttl_ms.insert(provider.clone(), (!ttl.is_null()).then(|| num(ttl)));
        }
    }
    let sink = Arc::clone(emitted);
    PromptBuilder::new(
        Arc::clone(clock) as Arc<dyn Clock>,
        PromptBuilderOptions {
            emit: Some(Box::new(move |e| sink.lock().unwrap().push(e.clone()))),
            cache_ttl_ms,
        },
    )
    .map_err(|e| e.to_string())
}

#[test]
fn render_vectors_replay() {
    let f = fixture("render");
    let (mut renders, mut refusals) = (0, 0);
    for scenario in f["scenarios"].as_array().unwrap() {
        let name = s(&scenario["name"]);
        let clock = Arc::new(TestClock(Mutex::new(0.0)));
        let emitted: Emitted = Arc::default();
        let b = match builder(&dec(&scenario["options"], &f), &clock, &emitted) {
            Ok(b) => b,
            Err(message) => {
                assert_eq!(message, s(&scenario["error"]), "{name}");
                refusals += 1;
                continue;
            }
        };
        assert!(
            scenario.get("error").is_none(),
            "{name}: TypeScript refused the options"
        );
        for (i, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let what = format!("{name}[{i}]");
            *clock.0.lock().unwrap() = num(&step["at"]);
            emitted.lock().unwrap().clear();
            let input = render_input(&dec(&step["input"], &f));
            match (b.render(&input), step.get("error")) {
                (Ok(r), None) => {
                    assert_eq!(
                        *emitted.lock().unwrap(),
                        r.events,
                        "{what}: emit sees every event"
                    );
                    check_render(&what, &r, step, &f);
                    renders += 1;
                }
                (Err(e), Some(message)) => {
                    assert_eq!(e.to_string(), s(message), "{what}");
                    assert_eq!(
                        events_value(&emitted.lock().unwrap()),
                        want(&step["emitted"], &f),
                        "{what}: events before the refusal"
                    );
                    refusals += 1;
                }
                (Ok(_), Some(message)) => {
                    panic!("{what}: TypeScript refuses ({message}), Rust renders")
                }
                (Err(e), None) => panic!("{what}: Rust refuses ({e}), TypeScript renders"),
            }
        }
    }
    assert!(
        renders > 200 && refusals > 20,
        "{renders} renders, {refusals} refusals"
    );
}

#[test]
fn session_vectors_replay() {
    let f = fixture("session");
    let mut renders = 0;
    for scenario in f["scenarios"].as_array().unwrap() {
        let name = s(&scenario["name"]);
        let open = dec(&scenario["open"], &f);
        let clock = Arc::new(TestClock(Mutex::new(0.0)));
        let unused: Emitted = Arc::default();
        let emitted: Emitted = Arc::default();
        let sink = Arc::clone(&emitted);
        let mut session = PromptSession::new(PromptSessionOptions {
            builder: Arc::new(builder(&json!({}), &clock, &unused).unwrap()),
            agent_id: s(&open["agentId"]).to_owned(),
            model: s(&open["model"]).to_owned(),
            session_id: opt_s(&open, "sessionId"),
            tools: open["tools"].as_array().unwrap().clone(),
            system: strings(&open["system"]),
            memory_snapshot: s(&open["memorySnapshot"]).to_owned(),
            cache_ttl: opt_s(&open, "cacheTtl"),
            memory_cap: open.get("zoneCaps").and_then(|z| z.get("memory")).map(num),
            emit: Some(Box::new(move |e| sink.lock().unwrap().push(e.clone()))),
        });
        for (i, step) in scenario["ops"].as_array().unwrap().iter().enumerate() {
            let what = format!("{name}[{i}]");
            let op = dec(&step["op"], &f);
            emitted.lock().unwrap().clear();
            let outcome: Result<(), String> = if let Some(appended) = op.get("append") {
                session.append(item(appended)).map_err(|e| e.to_string())
            } else if let Some(recall) = op.get("recall") {
                let blocks: Vec<Block> = recall["blocks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(block)
                    .collect();
                session
                    .recall(
                        &blocks,
                        recall.get("capChars").map(num),
                        delivery(&op),
                        op.get("toolUseId").map(s),
                    )
                    .map(|events| {
                        assert_eq!(events_value(&events), want(&step["events"], &f), "{what}");
                    })
                    .map_err(|e| e.to_string())
            } else if let Some(snapshot) = op.get("refresh") {
                session.refresh_memory_snapshot(s(snapshot));
                assert_eq!(
                    sha256_hex(session.memory_snapshot()),
                    s(&step["snapshotSha256"]),
                    "{what}"
                );
                Ok(())
            } else if let Some(model) = op.get("setModel") {
                session.set_model(s(model));
                assert_eq!(session.model(), s(&step["model"]), "{what}");
                Ok(())
            } else {
                if let Some(at) = op.get("at") {
                    *clock.0.lock().unwrap() = num(at);
                }
                session
                    .render()
                    .map(|r| {
                        check_render(&what, &r, step, &f);
                        renders += 1;
                    })
                    .map_err(|e| e.to_string())
            };
            match (outcome, step.get("error")) {
                (Ok(()), None) => {}
                (Err(e), Some(message)) => assert_eq!(e, s(message), "{what}"),
                (got, want) => panic!("{what}: Rust {got:?}, TypeScript {want:?}"),
            }
            if let Some(want) = step.get("emitted") {
                assert_eq!(
                    events_value(&emitted.lock().unwrap()),
                    self::want(want, &f),
                    "{what}: emitted"
                );
            }
        }
    }
    assert!(renders >= 30, "{renders}");
}

#[test]
fn canonical_vectors_replay() {
    let f = fixture("canonical");
    for case in f["normalize"].as_array().unwrap() {
        let got = match case["input"].get("$u16") {
            Some(u) => normalize_text_units(&units(u)),
            None => normalize_text(s(&dec(&case["input"], &f))),
        };
        assert_eq!(
            Value::String(got.clone()),
            dec(&case["output"], &f),
            "{case}"
        );
        assert_eq!(utf16_len(&got) as u64, case["utf16Length"], "{case}");
        assert_eq!(got.len() as u64, case["utf8Length"], "{case}");
        assert_eq!(sha256_hex(&got), s(&case["sha256"]), "{case}");
    }
    for case in f["json"].as_array().unwrap() {
        let input: Value = serde_json::from_str(s(&case["inputJson"])).expect("input parses");
        match (canonical_json(&input), case.get("error")) {
            (Ok(text), None) => {
                assert_eq!(text, s(&case["output"]), "{case}");
                assert_eq!(sha256_hex(&text), s(&case["sha256"]), "{case}");
            }
            (Err(e), Some(message)) => assert_eq!(e.to_string(), s(message), "{case}"),
            (got, _) => panic!("{case}: {got:?}"),
        }
    }
    assert!(f["json"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c.get("error").is_some()));
    for case in f["sha"].as_array().unwrap() {
        assert_eq!(sha256_hex(s(&case["input"])), s(&case["sha256"]));
    }
    for case in f["sticky"].as_array().unwrap() {
        let got = sticky_session_id(s(&case["agentId"]), case.get("sessionId").map(s));
        assert_eq!(got, s(&case["id"]), "{case}");
    }
    let instructions = dec(&f["instructions"]["text"], &f);
    assert_eq!(TOOL_USE_INSTRUCTIONS, s(&instructions));
    assert_eq!(
        sha256_hex(TOOL_USE_INSTRUCTIONS),
        s(&f["instructions"]["sha256"])
    );
}

#[test]
fn model_table_vectors_replay() {
    let f = fixture("model-table");
    let lookups = f["lookups"].as_array().unwrap();
    for case in lookups {
        let model = s(&case["model"]);
        let p = lookup_cache_profile(model, route(case).as_ref());
        assert_eq!(p.json(), case["profile"], "{model} {:?}", case.get("route"));
        assert_eq!(normalize_model_id(model), s(&case["id"]), "{model}");
        assert_eq!(p.known, p.mechanism != Mechanism::None);
    }
    let ttls = f["ttl"].as_array().unwrap();
    for case in ttls {
        let never = case.get("policy").map(s) == Some("never");
        let got = choose_cache_ttl(
            s(&case["model"]),
            num(&case["projectedReads"]),
            never,
            route(case).as_ref(),
        );
        assert_eq!(got, s(&case["ttl"]), "{case}");
    }
    assert!(lookups.len() > 250 && ttls.len() > 500);
}

#[test]
fn join_vectors_replay() {
    let f = fixture("join");
    let cases = f["cases"].as_array().unwrap();
    for case in cases {
        let blocks: Vec<Block> = case["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .map(block)
            .collect();
        let (text, deferrals) = join_blocks(&blocks, num(&case["cap"]));
        assert_eq!(
            Value::String(text.clone()),
            dec(&case["text"], &f),
            "{}",
            case["name"]
        );
        assert_eq!(
            utf16_len(&text) as u64,
            case["utf16Length"],
            "{}",
            case["name"]
        );
        let got: Vec<Value> = deferrals
            .iter()
            .map(|d| {
                let kind = if d.kind == DeferralKind::Clipped { "clipped" } else { "dropped" };
                json!({ "block": d.block, "kind": kind, "from": d.from, "to": d.to, "reason": d.reason })
            })
            .collect();
        assert_eq!(Value::Array(got), case["deferrals"], "{}", case["name"]);
    }
    assert!(cases.len() > 200);
}

#[test]
fn skill_vectors_replay() {
    let f = fixture("skills");
    for case in f["describe"].as_array().unwrap() {
        let got = skill_description(s(&dec(&case["input"], &f)));
        // A description cut inside a surrogate pair ends in a lone surrogate in TypeScript (`$u16`) and in U+FFFD
        // here; `dec` reads both the same way, and the length in code units is equal.
        assert_eq!(
            Value::String(got.clone()),
            dec(&case["output"], &f),
            "{case}"
        );
        assert_eq!(utf16_len(&got) as u64, case["utf16Length"], "{case}");
    }
    let mut cut_pairs = 0;
    for case in f["render"].as_array().unwrap() {
        let name = s(&case["name"]);
        let skills: Vec<CatalogueSkill> = dec(&case["skills"], &f)
            .as_array()
            .unwrap()
            .iter()
            .map(|v| CatalogueSkill {
                name: s(&v["entry"]["name"]).to_owned(),
                description: s(&v["entry"]["description"]).to_owned(),
                authored_description: opt_s(v, "authoredDescription"),
            })
            .collect();
        let budget = case
            .get("budget")
            .map_or(AVAILABLE_SKILLS_TOKEN_BUDGET, num);
        match (render_available_skills(&skills, budget), case.get("error")) {
            (Ok(text), None) => {
                assert_eq!(
                    Value::String(text.clone()),
                    dec(&case["output"], &f),
                    "{name}"
                );
                assert_eq!(utf16_len(&text) as u64, case["utf16Length"], "{name}");
                if case["output"].get("$u16").is_some() {
                    cut_pairs += 1;
                } else {
                    assert_eq!(sha256_hex(&text), s(&case["sha256"]), "{name}");
                }
            }
            (Err(e), Some(message)) => assert_eq!(e.to_string(), s(message), "{name}"),
            (got, want) => panic!("{name}: Rust {got:?}, TypeScript {want:?}"),
        }
    }
    assert_eq!(
        cut_pairs, 0,
        "no catalogue of the vectors holds a cut pair; the describe cases do"
    );
    assert!(f["describe"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["output"].get("$u16").is_some()));
}

fn usage(v: &Value) -> ProviderCacheUsage {
    ProviderCacheUsage {
        cache_read: num(&v["cache_read"]),
        cache_creation: num(&v["cache_creation"]),
        input: num(&v["input"]),
    }
}

fn patched(prompt: &RenderedPrompt, patch: Option<&Value>) -> RenderedPrompt {
    let mut p = prompt.clone();
    let Some(patch) = patch else { return p };
    if let Some(n) = patch.get("stableTokensEstimate") {
        p.stable_tokens_estimate = n.as_u64().unwrap();
    }
    if patch.get("clearBreakpoints").is_some() {
        p.breakpoints.clear();
    }
    if let Some(m) = patch.get("mechanism") {
        p.cache.mechanism = match s(m) {
            "none" => Mechanism::None,
            "implicit" => Mechanism::Implicit,
            _ => Mechanism::Explicit,
        };
    }
    if let Some(reason) = patch.get("reason") {
        assert_eq!(s(reason), "eligible");
        p.cache.reason = CacheReason::Eligible;
    }
    if let Some(age) = patch.get("ageMs") {
        p.cache.age_ms = (!age.is_null()).then(|| num(age));
    }
    if let Some(ttl) = patch.get("ttlMs") {
        p.cache.ttl_ms = (!ttl.is_null()).then(|| num(ttl));
    }
    if let Some(texts) = patch.get("toolTexts") {
        let mut segments: Vec<Segment> = strings(texts)
            .into_iter()
            .map(|text| Segment {
                zone: ZoneName::Tools,
                kind: SegmentKind::ToolDef,
                role: None,
                text,
                id: None,
                cache: None,
            })
            .collect();
        segments.extend(
            p.segments
                .into_iter()
                .filter(|seg| seg.zone != ZoneName::Tools),
        );
        p.segments = segments;
    }
    p
}

fn models_j(list: &[(String, super::telemetry::CacheUsageSummary)]) -> J {
    J::Arr(
        list.iter()
            .map(|(model, summary)| J::obj([("model", J::s(model)), ("summary", summary.to_j())]))
            .collect(),
    )
}

#[test]
fn telemetry_vectors_replay() {
    let f = fixture("telemetry");
    let (mut records, mut refusals) = (0, 0);
    for scenario in f["scenarios"].as_array().unwrap() {
        let name = s(&scenario["name"]);
        let clock = Arc::new(TestClock(Mutex::new(0.0)));
        let b = builder(&json!({}), &clock, &Emitted::default()).unwrap();
        let mut telemetry = CacheTelemetry::new();
        let mut prompt: Option<RenderedPrompt> = None;
        for (i, step) in scenario["ops"].as_array().unwrap().iter().enumerate() {
            let what = format!("{name}[{i}]");
            let op = dec(&step["op"], &f);
            let got: Result<J, String> = if let Some(input) = op.get("render") {
                *clock.0.lock().unwrap() = num(&op["at"]);
                let mut r = b.render(&render_input(input)).unwrap();
                if step["divergence"] == "K9a-D7" {
                    assert_eq!(r.cache.age_ms, None, "{what}");
                    assert!(!r.cache.expected_warm, "{what}");
                    // The telemetry vectors isolate the telemetry component. Supply the TS
                    // cache observation for these two inputs after checking the Rust eviction.
                    r.cache.age_ms = Some(0.0);
                    r.cache.expected_warm = true;
                }
                assert_eq!(
                    sha256_hex(&r.to_j().stringify()),
                    s(&step["digest"]),
                    "{what}"
                );
                prompt = Some(r);
                continue;
            } else if let Some(u) = op.get("record") {
                let p = patched(prompt.as_ref().unwrap(), op.get("patch"));
                telemetry
                    .record(&p, usage(u))
                    .map(|r| r.to_j())
                    .map_err(|e| e.to_string())
            } else if let Some(args) = op.get("summary") {
                let summary = telemetry.summary(s(&args[0]), s(&args[1]), args.get(2).map(s));
                Ok(summary.map_or(J::Null, |v| v.to_j()))
            } else if let Some(n) = op.get("sessions") {
                let mut lines = Vec::new();
                for k in 0..n.as_u64().unwrap() {
                    let input = json!({ "agentId": "a", "model": "claude-sonnet-5-5", "tools": [], "system": ["x".repeat(8000)], "memory": "", "conversation": [], "sessionId": format!("n{k}") });
                    let r = b.render(&render_input(&input)).unwrap();
                    let record = telemetry
                        .record(
                            &r,
                            ProviderCacheUsage {
                                cache_read: 0.0,
                                cache_creation: 1.0,
                                input: 1.0,
                            },
                        )
                        .unwrap();
                    lines.push(record.to_j().stringify());
                    prompt = Some(r);
                }
                assert_eq!(sha256_hex(&lines.join("\n")), s(&step["json"]), "{what}");
                continue;
            } else {
                let args = &op["sessionModels"];
                Ok(models_j(
                    &telemetry.session_models(s(&args[0]), s(&args[1])),
                ))
            };
            match (got, step.get("error")) {
                (Ok(j), None) => {
                    assert_eq!(j.to_value(), want(&step["result"], &f), "{what}");
                    assert_eq!(
                        sha256_hex(&j.stringify()),
                        s(&step["json"]),
                        "{what}: JSON text"
                    );
                    records += 1;
                }
                (Err(e), Some(message)) => {
                    assert_eq!(e, s(message), "{what}");
                    refusals += 1;
                }
                (got, want) => panic!("{what}: Rust {got:?}, TypeScript {want:?}"),
            }
        }
    }
    assert!(
        records > 100 && refusals >= 7,
        "{records} records, {refusals} refusals"
    );
}
