#![allow(
    dead_code,
    reason = "shared parity support also serves focused render tests"
)]

use std::sync::Mutex;

use plur1bus_engine::context::WorkspaceAliases;
use plur1bus_engine::recall::acl::AclSubject;
use plur1bus_engine::recall::{
    blocks::RenderedRecall,
    boosters, inject_budget, injected_conflicts, memory_context,
    neo_prelude::{NeoPrelude, NeoRequest},
    reactivation,
    render::{self, RenderError},
    system_supplement, warm,
};
use plur1bus_engine::text::js::JsString;
use plur1bus_engine::text::json::{parse_json, TolerantJsonValue};
use serde_json::{json, Value};

pub const NOW: f64 = 1_768_305_600_000.0;
pub const AGENT: &str = "render-fixture";

pub fn field<'a>(value: &'a TolerantJsonValue, name: &str) -> &'a TolerantJsonValue {
    if let TolerantJsonValue::Object(fields) = value {
        if let Some((_, item)) = fields.iter().find(|(key, _)| key.to_utf8_lossy() == name) {
            return item;
        }
    }
    &TolerantJsonValue::Null
}

pub fn string(value: &TolerantJsonValue) -> JsString {
    match value {
        TolerantJsonValue::String(text) => text.clone(),
        _ => JsString::default(),
    }
}

fn value_of(value: &TolerantJsonValue) -> Value {
    match value {
        TolerantJsonValue::Null => Value::Null,
        TolerantJsonValue::Bool(b) => json!(b),
        TolerantJsonValue::Number(n) => serde_json::from_str(n).unwrap(),
        TolerantJsonValue::String(s) => json!(s.to_utf8_lossy()),
        TolerantJsonValue::Array(values) => values.iter().map(value_of).collect(),
        TolerantJsonValue::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, child)| (key.to_utf8_lossy(), value_of(child)))
                .collect(),
        ),
    }
}

pub fn text(value: &Value) -> String {
    if let Some(s) = value.as_str() {
        return s.to_owned();
    }
    let joiner = value["joiner"]
        .as_array()
        .map(|parts| parts.iter().filter_map(Value::as_str).collect::<String>())
        .unwrap_or_default();
    value["parts"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(&joiner)
        })
        .unwrap_or_default()
}

pub fn cases(name: &str) -> Vec<Value> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/recall/golden/render")
        .join(format!("{name}.json"));
    let content = std::fs::read_to_string(path).unwrap();
    let parsed = parse_json(&content).unwrap();
    value_of(&parsed)["cases"].as_array().unwrap().clone()
}

pub fn subject() -> AclSubject {
    AclSubject {
        agent_id: AGENT.to_owned(),
        workspace_identity: String::new(),
        user_principal: String::new(),
        aliases: Some(WorkspaceAliases::default()),
    }
}

pub fn request(case: &Value) -> render::RenderRequest {
    let input = &case["input"];
    let rows = input["rows"].as_array().cloned().unwrap_or_default();
    let mut request = render::RenderRequest::new(subject(), NOW);
    request.selected = render::SelectedRecall {
        memories: rows
            .into_iter()
            .map(|r| serde_json::from_value(r).unwrap())
            .collect(),
        canonical: serde_json::from_value(input["canonical"].clone()).unwrap_or_default(),
    };
    request.config = input["cfg"].clone();
    if let Some(encoding) = input["summaryEncoding"].as_str() {
        request.config["summaryMaxWords"] = serde_json::from_str(encoding).unwrap();
    }
    request.overlays = input["overlays"].as_array().cloned().unwrap_or_default();
    request.context.user_principal = input["userPrincipal"].as_str().unwrap_or("").to_owned();
    request.lens.index = input["lensIndex"].clone();
    request.lens.hydrated = input["hydratedRows"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|row| (text(&row["id"]), row.clone()))
        .collect();
    request.prompt = input["prompt"]
        .as_str()
        .unwrap_or("Continue dashboard architecture decisions")
        .to_owned();
    request.previous_activity = input["previous"].as_f64();
    request.language = input["lang"].as_str().unwrap_or("en").to_owned();
    request.temporal_enabled = input["temporal"] == true;
    request.has_workspace = input["noWorkspace"] != true;
    request.trace_enabled = input["trace"] == true;
    request.trace_in_prompt = request.trace_enabled;
    request.start_notice = input["notice"].as_str().map(JsString::from);
    request.neo_enabled = input["neo"] == true && input["neoAlreadyInjected"] != true;
    request.mood = input["mood"].clone();
    request.reactivation.index =
        reactivation::LensIndex::from_json(&text(&case["dependencies"]["reactivationIndexLine"]))
            .unwrap_or_default();
    request.due_reminders = input["reminders"].as_array().cloned().unwrap_or_default();
    request.pending_reminders = input["pending"].as_array().cloned().unwrap_or_default();
    request.reactivation.session.last_user_turn_at =
        case["dependencies"]["lastUserTurnAt"].as_f64();
    request.reactivation.session.last_crr_at = case["dependencies"]["lastCrrAt"].as_f64();
    request
}

pub fn assemble(case: &Value, neo: &FixtureNeo) -> RenderedRecall {
    struct Pipeline<'a>(&'a Value, render::SelectedRecall);
    impl render::SelectedRecallPipeline for Pipeline<'_> {
        fn select(
            &self,
            parameters: &render::SelectionParameters<'_>,
        ) -> Result<render::SelectedRecall, RenderError> {
            assert_eq!(
                parameters.top_n as u64,
                self.0["calls"]["pipelines"][0]["topN"].as_u64().unwrap()
            );
            assert_eq!(
                parameters.summary_max_words,
                self.0["calls"]["pipelines"][0]["summaryMaxWords"]
                    .as_f64()
                    .unwrap()
            );
            let mut selected = self.1.clone();
            selected.memories.truncate(parameters.top_n);
            Ok(selected)
        }
    }
    let request = request(case);
    render::assemble_context(&request, &Pipeline(case, request.selected.clone()), neo).unwrap()
}

pub struct FixtureNeo {
    text: JsString,
    pub calls: Mutex<Vec<(bool, usize)>>,
}

impl FixtureNeo {
    pub fn new(case: &Value) -> Self {
        Self {
            text: JsString::from(text(&case["dependencies"]["neoPrelude"])),
            calls: Mutex::new(Vec::new()),
        }
    }
}

impl NeoPrelude for FixtureNeo {
    fn read(&self, request: &NeoRequest<'_>) -> Result<JsString, RenderError> {
        self.calls
            .lock()
            .unwrap()
            .push((request.warm_only, request.exclude_texts.len()));
        Ok(self.text.clone())
    }
}

struct WarmBackend<'a> {
    case: &'a Value,
    invocations: Vec<warm::WarmParameters>,
}
impl warm::WarmRecall for WarmBackend<'_> {
    fn has_table(&self) -> Result<bool, RenderError> {
        if self.case["input"]["readLeaseError"] == true {
            return Err(RenderError::Unavailable(
                "synthetic read lease unavailable".into(),
            ));
        }
        Ok(self.case["input"]["missingTable"] != true)
    }
    fn recall(&mut self, parameters: &warm::WarmParameters) -> Result<(), RenderError> {
        self.invocations.push(parameters.clone());
        if self.case["input"]["pipelineError"] == true {
            Err(RenderError::Unavailable(
                self.case["input"]["pipelineErrorDetail"]
                    .as_str()
                    .unwrap_or("synthetic pipeline unavailable")
                    .to_owned(),
            ))
        } else {
            Ok(())
        }
    }
}

pub fn warm(case: &Value, neo: &FixtureNeo) -> RenderedRecall {
    let mut backend = WarmBackend {
        case,
        invocations: Vec::new(),
    };
    let input = &case["input"];
    let result = warm::run(
        &warm::WarmRequest {
            prompt: input["prompt"]
                .as_str()
                .unwrap_or("Continue dashboard architecture decisions")
                .to_owned(),
            neo_enabled: input["neo"] == true,
            top_n: 12,
            allowed: true,
        },
        &mut backend,
        neo,
    )
    .unwrap();
    assert_eq!(
        backend.invocations.len(),
        case["calls"]["pipelines"].as_array().unwrap().len()
    );
    for invocation in backend.invocations {
        assert!(invocation.read_only);
        assert!(!invocation.persist_embeddings);
        assert!(!invocation.retrieval_logger);
        assert!(!invocation.query_summarizer);
        assert!(!invocation.emotional_state);
    }
    assert!(case["calls"]["writes"].as_array().unwrap().is_empty());
    result
}

pub fn verify_supplement(case: &Value) {
    let actual = system_supplement::build(case["input"]["neo"] == true);
    assert_eq!(
        serde_json::to_string(&actual).unwrap(),
        text(&case["rawLine"])
    );
}

pub fn verify_helper(case: &Value) {
    let input = &case["input"];
    match input["kind"].as_str().unwrap() {
        "formatter" => {
            let items = input["memories"]
                .as_array()
                .unwrap()
                .iter()
                .map(memory_context::PromptItem::from_value)
                .collect::<Vec<_>>();
            let result = memory_context::format(
                &items,
                &memory_context::FormatOptions::from_value(&input["options"], NOW),
            )
            .unwrap();
            assert_eq!(result.text.to_json(), text(&case["rawLine"]));
        }
        "budget" => {
            let blocks = input["blocks"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| {
                    plur1bus_engine::recall::blocks::ContextBlock::new(
                        text(&b["name"]),
                        JsString::from(text(&b["text"])),
                        b["droppable"] == true,
                    )
                })
                .collect::<Vec<_>>();
            assert_eq!(
                inject_budget::plan(&blocks, input["cap"].as_f64().unwrap()).to_json_line(),
                text(&case["rawLine"])
            );
        }
        "confidence" => {
            let result = boosters::frame_confidence(
                input["memories"].as_array().unwrap(),
                &input["options"],
            );
            assert_eq!(serde_json::to_value(result).unwrap(), case["value"]);
        }
        "versions" => {
            let ids = boosters::rank_versions(input["memories"].as_array().unwrap())
                .into_iter()
                .map(|m| m["id"].clone())
                .collect::<Vec<_>>();
            assert_eq!(serde_json::to_string(&ids).unwrap(), text(&case["rawLine"]));
        }
        "reactivation" => {
            let memories = input["memories"].as_array().unwrap();
            let index = json!({"memories":memories,"communities":[{"id":"helper-community",
                "representativeMemoryIds":memories.iter().map(|m|m["id"].clone()).collect::<Vec<_>>()}],"entries":{}});
            let selected = reactivation::select(&reactivation::SelectionRequest {
                prompt: text(&input["prompt"]),
                base_ids: input["baseRecallIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(text)
                    .collect(),
                index: if let Some(line) = input["semanticLensLine"].as_str() {
                    reactivation::LensIndex::from_json(line).unwrap()
                } else {
                    reactivation::LensIndex::from_value(input.get("semanticLens").unwrap_or(&index))
                        .unwrap()
                },
                graph_edges: input["graphEdges"].as_array().cloned().unwrap_or_default(),
                hydrated: input["hydrated"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|row| (text(&row["id"]), row.clone()))
                    .collect(),
                config: input["cfg"].clone(),
                subject: Some(subject()),
                now_ms: NOW,
            });
            let actual_text =
                reactivation::format_context(&selected, true, Some(&subject()), NOW).unwrap();
            assert_eq!(
                actual_text.to_json(),
                JsString::from(text(&case["value"]["text"])).to_json()
            );
            assert_eq!(
                Value::Array(selected.iter().map(|m| m["id"].clone()).collect()),
                case["value"]["ids"]
            );
        }
        "injected-conflicts" => {
            verify_injected(case);
        }
        unknown => panic!("unknown helper {unknown}"),
    }
}

fn verify_injected(case: &Value) {
    let input = &case["input"];
    struct Cards {
        cards: Vec<Value>,
        classified: Vec<bool>,
        updates: Vec<Value>,
    }
    impl injected_conflicts::BehaviorConflictStore for Cards {
        fn read_cards(&self, _limit: usize) -> Option<Vec<Value>> {
            Some(self.cards.clone())
        }
        fn is_injected_text(&self, text: &str) -> bool {
            self.cards
                .iter()
                .position(|card| card["statement"] == text)
                .and_then(|n| self.classified.get(n))
                .copied()
                .unwrap_or(false)
        }
        fn append_cards(&mut self, cards: &[Value]) -> Option<usize> {
            self.updates.extend_from_slice(cards);
            Some(cards.len())
        }
    }
    let mut cards = Cards {
        cards: input["cards"].as_array().unwrap().clone(),
        classified: input["classified"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v == true)
            .collect(),
        updates: Vec::new(),
    };
    let preview = injected_conflicts::preview(&cards, &input["requester"]);
    let action = text(&input["action"]);
    let applied = if action == "preview" {
        Value::Null
    } else {
        injected_conflicts::apply(
            &mut cards,
            &input["requester"],
            action != "unauthorized",
            if action == "drift" {
                "different"
            } else {
                preview["hash"].as_str().unwrap()
            },
            preview["count"].as_u64().unwrap() as usize,
            NOW,
        )
    };
    assert_eq!(
        json!({"preview":preview,"applied":applied,"updates":cards.updates}),
        case["value"]
    );
}
