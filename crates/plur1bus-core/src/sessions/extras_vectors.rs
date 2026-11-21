//! Replays the file-free part of `fixtures/parity/session-maintenance/`: turn telemetry, chat models and reasoning, session role
//! routing, and the maintenance configuration (mode V, `scripts/parity/session-maintenance-extras.ts`).
use super::chat_models::*;
use super::maintenance::session_maintenance;
use super::maintenance_vectors::{cfg_json, fixture};
use super::role_routing::*;
use super::turn_telemetry::*;
use super::vectors::{clip, f, first_diff, gi, gs};
use crate::approvals::js_json::J;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

fn report(bad: &[String]) {
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

// ---- telemetry -------------------------------------------------------------------------------------------------------

fn n(v: &Value) -> f64 {
    v.as_f64().unwrap()
}

fn telemetry_of(v: &Value) -> TurnTelemetry {
    TurnTelemetry {
        rounds: n(&v["rounds"]),
        tool_calls: n(&v["toolCalls"]),
        meta_calls: MetaCalls {
            search: n(&v["metaCalls"]["search"]),
            skill_load: n(&v["metaCalls"]["skillLoad"]),
            skill_read: n(&v["metaCalls"]["skillRead"]),
        },
        skills: SkillCounts {
            injected: n(&v["skills"]["injected"]),
            loaded: n(&v["skills"]["loaded"]),
        },
        tool_choice_status: gs(&v["toolChoice"], "status").to_owned(),
        tool_choice_forced: v["toolChoice"]["forced"].as_bool().unwrap(),
        tool_need_detected: v["toolNeed"]["detected"].as_bool().unwrap(),
        tool_need_reasons: v["toolNeed"]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r.as_str().unwrap().to_owned())
            .collect(),
        errors_returned: n(&v["errorsReturned"]),
        end_reason: gs(v, "endReason").to_owned(),
        triage_duration_ms: v["triageDurationMs"].as_f64(),
    }
}

fn telemetry_json(t: &TurnTelemetry) -> Value {
    json!({"rounds": f(t.rounds), "toolCalls": f(t.tool_calls),
        "metaCalls": {"search": f(t.meta_calls.search), "skillLoad": f(t.meta_calls.skill_load), "skillRead": f(t.meta_calls.skill_read)},
        "skills": {"injected": f(t.skills.injected), "loaded": f(t.skills.loaded)},
        "toolChoice": {"status": t.tool_choice_status, "forced": t.tool_choice_forced},
        "toolNeed": {"detected": t.tool_need_detected, "reasons": t.tool_need_reasons},
        "errorsReturned": f(t.errors_returned), "endReason": t.end_reason,
        "triageDurationMs": t.triage_duration_ms.map_or(Value::Null, f)})
}

fn summary_json(s: &TurnTelemetrySummary) -> Value {
    json!({"turns": f(s.turns), "rounds": f(s.rounds), "toolCalls": f(s.tool_calls),
        "metaCalls": {"search": f(s.meta_calls.search), "skillLoad": f(s.meta_calls.skill_load), "skillRead": f(s.meta_calls.skill_read)},
        "skills": {"injected": f(s.skills.injected), "loaded": f(s.skills.loaded)},
        "errorsReturned": f(s.errors_returned), "toolNeedTurns": f(s.tool_need_turns), "forcedTurns": f(s.forced_turns),
        "withoutNeededTool": f(s.without_needed_tool), "toolChoiceUnsupported": f(s.tool_choice_unsupported),
        "endReasons": Value::Object(s.end_reasons.iter().map(|(k, v)| (k.clone(), f(*v))).collect::<Map<_, _>>()),
        "triage": {"count": s.triage_count, "p50Ms": s.triage_p50_ms.map_or(Value::Null, f), "p95Ms": s.triage_p95_ms.map_or(Value::Null, f)}})
}

#[test]
fn turn_telemetry_matches_typescript() {
    let all = fixture("telemetry");
    assert_eq!(all["limit"], json!(TRIAGE_SAMPLE_LIMIT));
    assert_eq!(all["endReasons"], json!(TURN_END_REASONS));
    let mut bad = Vec::new();
    for sc in all["scenarios"].as_array().unwrap() {
        let mut agg = TurnTelemetryAggregate::new();
        let mut counter = 0.0;
        for (i, step) in sc["steps"].as_array().unwrap().iter().enumerate() {
            let op = &step["op"];
            let got = if op.get("fresh").is_some() {
                telemetry_json(&create_turn_telemetry())
            } else if let Some(t) = op.get("observe") {
                agg.observe(&telemetry_of(t));
                Value::Null
            } else if let Some(s) = op.get("series") {
                for _ in 0..gi(s, "n").unwrap() {
                    counter += 1.0;
                    let mut t = create_turn_telemetry();
                    t.triage_duration_ms = Some(counter * n(&s["step"]));
                    agg.observe(&t);
                }
                Value::Null
            } else {
                summary_json(&agg.snapshot())
            };
            if got != step["result"] {
                bad.push(format!(
                    "{} #{i}\n  {}",
                    gs(sc, "name"),
                    first_diff(&step["result"], &got)
                ));
            }
        }
    }
    report(&bad);
}

// ---- reasoning and chat models ---------------------------------------------------------------------------------------

fn level(v: &Value) -> ReasoningLevel {
    ReasoningLevel::parse(v.as_str().unwrap()).unwrap()
}
fn levels(v: &Value) -> Vec<ReasoningLevel> {
    v.as_array().unwrap().iter().map(level).collect()
}

fn descriptor_of(v: &Value) -> ReasoningDescriptor {
    ReasoningDescriptor {
        kind: match gs(v, "kind") {
            "none" => ReasoningKind::None,
            "effort" => ReasoningKind::Effort,
            "budget" => ReasoningKind::Budget,
            "toggle" => ReasoningKind::Toggle,
            k => panic!("kind {k}"),
        },
        levels: levels(&v["levels"]),
        default: v.get("default").map(level),
        vendor_param: v.get("vendorParam").map(|p| p.as_str().unwrap().to_owned()),
        adaptive_thinking: v.get("adaptiveThinking") == Some(&json!(true)),
        values: v
            .get("values")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .map(|(k, x)| {
                        (
                            ReasoningLevel::parse(k).unwrap(),
                            match x {
                                Value::Bool(b) => ReasoningValue::Bool(*b),
                                other => ReasoningValue::Str(other.as_str().unwrap().to_owned()),
                            },
                        )
                    })
                    .collect()
            })
            .unwrap_or_default(),
        budget: v.get("budget").map(|b| ReasoningBudget {
            min: n(&b["min"]),
            max: n(&b["max"]),
            default: n(&b["default"]),
        }),
        source: match gs(v, "source") {
            "api" => DescriptorSource::Api,
            "table" => DescriptorSource::Table,
            _ => DescriptorSource::Unknown,
        },
        note: v.get("note").map(|x| x.as_str().unwrap().to_owned()),
    }
}

fn directive_json(r: Result<Option<ReasoningDirective>, String>) -> Value {
    match r {
        Err(e) => json!({"err": e}),
        Ok(None) => json!({"ok": null}),
        Ok(Some(d)) => {
            let mut o = Map::new();
            o.insert("vendorParam".into(), json!(d.vendor_param));
            o.insert(
                "value".into(),
                match d.value {
                    DirectiveValue::Str(s) => json!(s),
                    DirectiveValue::Num(x) => f(x),
                    DirectiveValue::Bool(b) => json!(b),
                },
            );
            if d.adaptive_thinking {
                o.insert("adaptiveThinking".into(), json!(true));
            }
            json!({"ok": Value::Object(o)})
        }
    }
}

struct SpecSources {
    spec: Value,
}

impl SpecSources {
    fn key(p: &str, m: &str) -> String {
        format!("{p}/{m}")
    }
}

impl ChatModelSources for SpecSources {
    fn profiles(&self) -> Vec<(String, Vec<ChatModelCandidate>)> {
        self.spec["profiles"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(name, list)| {
                (
                    name.clone(),
                    list.as_array()
                        .unwrap()
                        .iter()
                        .map(|c| ChatModelCandidate {
                            provider: gs(c, "provider").to_owned(),
                            model: gs(c, "model").to_owned(),
                        })
                        .collect(),
                )
            })
            .collect()
    }
    fn reasoning(&self, p: &str, m: &str) -> ReasoningDescriptor {
        self.spec["reasoning"]
            .get(Self::key(p, m))
            .map_or_else(ReasoningDescriptor::none, descriptor_of)
    }
    fn catalog(&self, p: &str, m: &str) -> Option<CatalogFacts> {
        self.spec["catalog"]
            .get(Self::key(p, m))
            .map(|c| CatalogFacts {
                display_name: c.get("displayName").map(|x| x.as_str().unwrap().to_owned()),
                status: c.get("status").map(|x| x.as_str().unwrap().to_owned()),
                context_window: c.get("contextWindow").and_then(Value::as_f64),
            })
    }
    fn endpoint(&self, p: &str) -> Option<String> {
        self.spec["endpoints"]
            .get(p)
            .map(|x| x.as_str().unwrap().to_owned())
    }
    fn config(&self) -> Option<Value> {
        self.spec.get("config").cloned()
    }
}

fn option_json(o: &ChatModelOption) -> Value {
    let mut m = Map::new();
    m.insert("name".into(), json!(o.name));
    m.insert("displayName".into(), json!(o.display_name));
    m.insert("provider".into(), json!(o.provider));
    m.insert("model".into(), json!(o.model));
    m.insert("local".into(), json!(o.local));
    m.insert("selectable".into(), json!(o.selectable));
    if let Some(w) = o.context_window {
        m.insert("contextWindow".into(), f(w));
    }
    if let Some(r) = o.disabled_reason {
        m.insert("disabledReason".into(), json!(r.as_str()));
    }
    let r = &o.reasoning;
    let mut w = Map::new();
    w.insert("kind".into(), json!(r.kind.as_str()));
    w.insert(
        "levels".into(),
        json!(r.levels.iter().map(|l| l.as_str()).collect::<Vec<_>>()),
    );
    if let Some(d) = r.default {
        w.insert("default".into(), json!(d.as_str()));
    }
    w.insert("source".into(), json!(r.source.as_str()));
    if let Some(note) = &r.note {
        w.insert("note".into(), json!(note));
    }
    if let Some(b) = &r.budget_tokens {
        w.insert(
            "budgetTokens".into(),
            Value::Object(
                b.iter()
                    .map(|(l, t)| (l.as_str().to_owned(), f(*t)))
                    .collect(),
            ),
        );
    }
    m.insert("reasoning".into(), Value::Object(w));
    Value::Object(m)
}

#[test]
fn chat_models_and_reasoning_match_typescript() {
    let all = fixture("chat-models");
    let descriptors: BTreeMap<String, ReasoningDescriptor> = all["descriptors"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), descriptor_of(v)))
        .collect();
    let mut bad = Vec::new();
    let mut check = |what: String, want: &Value, got: Value| {
        if *want != got {
            bad.push(format!("{what}\n  {}", first_diff(want, &got)));
        }
    };
    for c in all["nearest"].as_array().unwrap() {
        let got = nearest_level(level(&c["requested"]), &levels(&c["levels"])).map_or(
            Value::Null,
            |(l, a)| json!({"level": l.as_str(), "adjusted": a}),
        );
        check(
            format!("nearest {} {}", c["requested"], c["levels"]),
            &c["result"],
            got,
        );
    }
    for c in all["budget"].as_array().unwrap() {
        let b = &c["budget"];
        let budget = ReasoningBudget {
            min: n(&b["min"]),
            max: n(&b["max"]),
            default: n(&b["default"]),
        };
        check(
            format!("budget {b} {}", c["level"]),
            &c["tokens"],
            f(budget_for(level(&c["level"]), &budget)),
        );
    }
    for c in all["directives"].as_array().unwrap() {
        let d = &descriptors[gs(c, "descriptor")];
        let mut want = c.clone();
        let o = want.as_object_mut().unwrap();
        o.remove("descriptor");
        o.remove("level");
        check(
            format!("directive {} {}", c["descriptor"], c["level"]),
            &want,
            directive_json(reasoning_directive(level(&c["level"]), d)),
        );
    }
    for c in all["effective"].as_array().unwrap() {
        let d = &descriptors[gs(c, "descriptor")];
        let (l, adjusted) =
            effective_reasoning(ReasoningChoice::parse(gs(c, "choice")).unwrap(), &d.levels);
        check(
            format!("effective {} {}", c["descriptor"], c["choice"]),
            &c["result"],
            json!({"level": l.map(ReasoningLevel::as_str), "adjusted": adjusted}),
        );
    }
    for c in all["directiveFor"].as_array().unwrap() {
        let d = &descriptors[gs(c, "descriptor")];
        let choice = c
            .get("choice")
            .map(|x| ReasoningChoice::parse(x.as_str().unwrap()).unwrap());
        let mut want = c.clone();
        let o = want.as_object_mut().unwrap();
        o.remove("descriptor");
        o.remove("choice");
        check(
            format!("directiveFor {} {:?}", c["descriptor"], c.get("choice")),
            &want,
            directive_json(directive_for(choice, d)),
        );
    }
    for c in all["isChoice"].as_array().unwrap() {
        check(
            format!("isChoice {}", c["v"]),
            &c["ok"],
            json!(ReasoningChoice::parse(gs(c, "v")).is_some()),
        );
    }
    for c in all["options"].as_array().unwrap() {
        let src = SpecSources {
            spec: c["spec"].clone(),
        };
        let got = Value::Array(
            chat_model_options(&src, gs(c, "agentId"))
                .iter()
                .map(option_json)
                .collect(),
        );
        check(format!("options {}", c["name"]), &c["options"], got);
    }
    for c in all["endpoints"].as_array().unwrap() {
        check(
            format!("endpoint {}", c["raw"]),
            &c["local"],
            json!(is_local_endpoint(c["raw"].as_str(), &c["cfg"])),
        );
    }
    assert_eq!(REASONING_CHOICES.len(), 7);
    report(&bad);
}

// ---- maintenance -----------------------------------------------------------------------------------------------------

#[test]
fn maintenance_configuration_matches_typescript() {
    let all = fixture("maintenance");
    let mut bad = Vec::new();
    for c in all.as_array().unwrap() {
        // The configuration is the defaults with the override laid over `session.compaction`.
        let mut config = json!({"session": {"compaction": c["defaultsCompaction"].clone()}});
        if let Some(over) = c["override"]
            .pointer("/session/compaction")
            .and_then(Value::as_object)
        {
            for (k, v) in over {
                config["session"]["compaction"][k] = v.clone();
            }
        }
        let m = session_maintenance(&config).unwrap();
        let want = &c["compaction"];
        let got = cfg_json(&m.compaction);
        if *want != got {
            bad.push(format!(
                "compaction {}\n  {}",
                clip(&c["override"].to_string(), 80),
                first_diff(want, &got)
            ));
        }
        let p = &m.prune;
        let got = json!({"enabled": p.enabled, "keepLastTurns": p.keep_last_turns,
            "decider": match p.decider { super::pruning::Decider::Laya => "laya", super::pruning::Decider::Heuristic => "heuristic", super::pruning::Decider::Off => "off" },
            "maxMs": f(p.max_ms), "batchSize": p.batch_size});
        if c["prune"] != got {
            bad.push(format!(
                "prune {}\n  {}",
                clip(&c["override"].to_string(), 80),
                first_diff(&c["prune"], &got)
            ));
        }
    }
    assert!(session_maintenance(&json!({})).is_err());
    assert!(session_maintenance(&json!({"session": {"compaction": {}}})).is_err());
    report(&bad);
}

// ---- role routing ----------------------------------------------------------------------------------------------------

#[derive(Clone)]
struct SpecOptions {
    order: Vec<String>,
    profiles: BTreeMap<String, Vec<Candidate>>,
    spec: Value,
}

fn candidates_of(v: &Value) -> Vec<Candidate> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|c| Candidate {
            provider: gs(c, "provider").to_owned(),
            model: gs(c, "model").to_owned(),
        })
        .collect()
}

impl SpecOptions {
    fn new(spec: &Value) -> Self {
        let o = &spec["options"];
        Self {
            order: spec["profileOrder"]
                .as_array()
                .unwrap()
                .iter()
                .map(|k| k.as_str().unwrap().to_owned())
                .collect(),
            profiles: o["profiles"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), candidates_of(v)))
                .collect(),
            spec: o.clone(),
        }
    }
    fn has_classes(&self) -> bool {
        self.spec.get("classProfiles").is_some()
    }
}

impl RoutingOptions for SpecOptions {
    fn profiles(&self) -> Vec<(String, Vec<Candidate>)> {
        self.order
            .iter()
            .filter_map(|k| self.profiles.get(k).map(|l| (k.clone(), l.clone())))
            .collect()
    }
    fn profile(&self) -> Option<String> {
        self.spec
            .get("profile")
            .map(|p| p.as_str().unwrap().to_owned())
    }
    fn profile_for_agent(&self, agent: &str) -> Option<String> {
        self.spec
            .get("profileForAgent")?
            .get(agent)
            .map(|p| p.as_str().unwrap().to_owned())
    }
    fn profile_for_class(&self, class: &str) -> Result<Option<String>, ClassProfileError> {
        match self
            .spec
            .get("classProfiles")
            .and_then(|c| c.get(class))
            .map(|v| v.as_str().unwrap())
        {
            Some("$throw") => Err(ClassProfileError),
            other => Ok(other.map(str::to_owned)),
        }
    }
    fn context_profiles(&self, agent: &str) -> Option<Vec<String>> {
        let table = self.spec.get("contextProfiles")?;
        Some(table.get(agent).map_or_else(Vec::new, |l| {
            l.as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_str().unwrap().to_owned())
                .collect()
        }))
    }
    fn require_triage(&self) -> bool {
        self.spec.get("requireTriage") == Some(&json!(true))
    }
}

fn keys_of(list: &[Candidate]) -> Vec<String> {
    list.iter()
        .map(|c| format!("{}/{}", c.provider, c.model))
        .collect()
}

fn cand_json(list: &[Candidate]) -> Value {
    Value::Array(
        list.iter()
            .map(|c| json!({"provider": c.provider, "model": c.model}))
            .collect(),
    )
}

#[test]
fn role_routing_matches_typescript() {
    let all = fixture("role-routing");
    let mut bad = Vec::new();
    for c in all["keyOrder"].as_array().unwrap() {
        let keys: Vec<String> = c["keys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_str().unwrap().to_owned())
            .collect();
        if c["order"] != json!(js_key_order(&keys)) {
            bad.push(format!("keyOrder {}", c["keys"]));
        }
    }
    for sc in all["scenarios"].as_array().unwrap() {
        let name = gs(sc, "name");
        let spec = &sc["spec"];
        let options = SpecOptions::new(spec);
        let roles: BTreeMap<String, String> = spec["roles"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
            .collect();
        let cap = n(&spec["summaryMaxTokens"]);
        let mut router = SessionRoleRouter::new(options.clone(), roles, cap);
        let names_to_keys = |r: &SessionRoleRouter<SpecOptions>| -> Value {
            Value::Object(
                r.options()
                    .profiles
                    .iter()
                    .map(|(k, v)| (k.clone(), json!(keys_of(v))))
                    .collect(),
            )
        };
        // The foreground router is created once, at construction.
        let main = {
            let o = &router.options();
            let mut m = Map::new();
            m.insert("classify".into(), json!(router.needs_classifier()));
            m.insert(
                "profile".into(),
                o.profile().map_or(Value::Null, |p| json!(p)),
            );
            m.insert(
                "selected".into(),
                o.profile()
                    .and_then(|p| o.profiles.get(&p).map(|l| json!(keys_of(l))))
                    .unwrap_or(Value::Null),
            );
            m.insert("maxRounds".into(), Value::Null);
            m.insert("maxTokens".into(), Value::Null);
            m.insert("profiles".into(), names_to_keys(&router));
            if !o.has_classes() {
                m.insert("profileForClass".into(), Value::Null);
            } else if let Ok(Some(p)) = o.profile_for_class("small") {
                m.insert("profileForClass".into(), json!(p));
            }
            Value::Object(m)
        };
        if sc["created"] != json!([main]) {
            bad.push(format!(
                "{name} created\n  {}",
                first_diff(&sc["created"], &json!([main]))
            ));
        }
        for (i, step) in sc["steps"].as_array().unwrap().iter().enumerate() {
            let op = &step["op"];
            let mut got = Map::new();
            let mut created = vec![];
            let mut requests = vec![];
            let mut put = |k: &str, v: Value| {
                got.insert(k.into(), v);
            };
            match gs(op, "op") {
                "roleModels" => put("ok", cand_json(&router.role_models())),
                "modelProfiles" => put("ok", json!(router.model_profiles())),
                "defaultModelProfile" => {
                    put("ok", json!(router.default_model_profile(gs(op, "agentId"))))
                }
                "contextModels" => put(
                    "ok",
                    cand_json(&router.context_models(
                        op.get("profile").and_then(Value::as_str),
                        op.get("scope").and_then(Value::as_str),
                    )),
                ),
                "setProfile" => {
                    router
                        .options_mut()
                        .profiles
                        .insert(gs(op, "name").to_owned(), candidates_of(&op["candidates"]));
                    put("ok", Value::Null);
                }
                "createOptions" => put("ok", Value::Null),
                kind => {
                    // The scripted call: pick the router, cap the request, measure the usage, wrap the chunk.
                    let summarize = kind == "summarize";
                    let (model_list, early): (Vec<Candidate>, Option<String>) = if summarize {
                        match router.summarizer() {
                            Ok(sel) => {
                                if sel.created {
                                    let mut profiles =
                                        names_to_keys(&router).as_object().unwrap().clone();
                                    profiles.insert(
                                        sel.profile.clone(),
                                        json!(keys_of(&sel.candidates)),
                                    );
                                    created.push(json!({"classify": false, "maxRounds": 1, "maxTokens": f(cap), "profile": sel.profile,
                                        "profileForClass": sel.profile, "profiles": Value::Object(profiles), "selected": keys_of(&sel.candidates)}));
                                }
                                (sel.candidates, None)
                            }
                            Err(e) => (vec![], Some(e)),
                        }
                    } else {
                        let p = router
                            .options()
                            .profile()
                            .unwrap_or_else(|| "default".to_owned());
                        (
                            router
                                .options()
                                .profiles
                                .get(&p)
                                .cloned()
                                .unwrap_or_default(),
                            None,
                        )
                    };
                    if let Some(e) = early {
                        put("err", json!(e));
                    } else {
                        let wire = op.get("wireMax").and_then(Value::as_f64);
                        let request_max = op.get("requestMax").and_then(Value::as_f64);
                        let capped = capped_max_tokens(summarize, wire, request_max, cap);
                        requests.push(json!({"maxTokens": capped.map_or(Value::Null, f)}));
                        let mut chunks = vec![json!({"type": "delta", "text": "x"})];
                        let mut usage = J::obj([
                            ("type", J::s("usage")),
                            ("inputTokens", J::Num(1.0)),
                            ("outputTokens", J::Num(2.0)),
                        ]);
                        if let Some(first) = model_list.first() {
                            let model = format!("{}/{}", first.provider, first.model);
                            let mut measurements = vec![];
                            if op.get("usage").and_then(Value::as_str) == Some("none")
                                || op.get("usage").and_then(Value::as_str) == Some("partial")
                            {
                                // no measurement: the usage lacks a count
                            } else {
                                let messages = op.get("messages").map_or_else(
                                    || {
                                        J::from_value(
                                            &json!([{"role": "user", "content": "hello"}]),
                                        )
                                    },
                                    J::from_value,
                                );
                                let tools = op.get("tools").map(J::from_value);
                                measurements.push(usage_measurement(
                                    &model,
                                    &messages,
                                    tools.as_ref(),
                                    100.0,
                                    7.0,
                                ));
                            }
                            usage = augment_usage_chunk(&usage, Some(&model), &measurements);
                        }
                        chunks.push(usage.to_value());
                        put("ok", Value::Array(chunks));
                    }
                }
            }
            got.insert("created".into(), Value::Array(created));
            got.insert("requests".into(), Value::Array(requests));
            let mut want = Map::new();
            for k in ["ok", "err", "created", "requests"] {
                if let Some(v) = step.get(k) {
                    want.insert(k.into(), v.clone());
                }
            }
            if Value::Object(want.clone()) != Value::Object(got.clone()) {
                bad.push(format!(
                    "{name} #{i} {}\n  {}",
                    clip(&op.to_string(), 160),
                    first_diff(&Value::Object(want), &Value::Object(got))
                ));
            }
        }
    }
    report(&bad);
}

#[test]
fn a_summary_cap_takes_the_smallest_of_the_three_bounds() {
    assert_eq!(capped_max_tokens(true, None, None, 400.0), Some(400.0));
    assert_eq!(
        capped_max_tokens(true, Some(1000.0), Some(50.0), 400.0),
        Some(50.0)
    );
    assert_eq!(
        capped_max_tokens(true, Some(20.0), Some(5000.0), 400.0),
        Some(20.0)
    );
    assert_eq!(
        capped_max_tokens(false, Some(1000.0), Some(50.0), 400.0),
        Some(1000.0)
    );
    assert_eq!(capped_max_tokens(false, None, None, 400.0), None);
    assert_eq!(
        last_user_text(&[
            ("user".into(), "a".into()),
            ("assistant".into(), "b".into())
        ]),
        "a"
    );
    assert_eq!(last_user_text(&[("assistant".into(), "b".into())]), "");
}
