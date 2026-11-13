//! The one validator of `config.json`: `validate` of `packages/config-schema` (`src/index.ts`), rule for rule and text
//! for text. The CLI, the supervisor and the core all call it, so one file gets one verdict.
use crate::apply_defaults;
use crate::privacy_ack::{privacy_acknowledgment_error, PrivacyChoice, PrivacyFunction};
use serde_json::{Map, Value};

/// The schema phase reports at most this many violations, then a count of the rest.
const MAX_ERRORS: usize = 50;

/// `String(n)` for the numbers a configuration holds: an integral value prints without a fraction.
pub fn js_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn get_f64(value: &Value, pointer: &str) -> Option<f64> {
    value.pointer(pointer).and_then(Value::as_f64)
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(_) => true,
    }
}

fn merged(base: Option<&Value>, over: Option<&Value>) -> Map<String, Value> {
    let mut out = base.and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(o) = over.and_then(Value::as_object) {
        for (k, v) in o {
            out.insert(k.clone(), v.clone());
        }
    }
    out
}

fn media_error(cfg: &Value) -> Option<String> {
    let base = cfg.pointer("/memory/mediaEmbedding");
    let mut layers: Vec<(String, Map<String, Value>)> = vec![(
        "/memory/mediaEmbedding".into(),
        base.and_then(Value::as_object).cloned().unwrap_or_default(),
    )];
    if let Some(agents) = cfg.get("agents").and_then(Value::as_object) {
        for (id, agent) in agents {
            let over = agent.pointer("/memory/mediaEmbedding");
            let mut layer = merged(base, over);
            let caption = merged(
                base.and_then(|b| b.get("caption")),
                over.and_then(|o| o.get("caption")),
            );
            layer.insert("caption".into(), Value::Object(caption));
            layers.push((format!("/agents/{id}/memory/mediaEmbedding"), layer));
        }
    }
    for (path, media) in &layers {
        if !truthy(media.get("enabled")) {
            continue;
        }
        let caption = media.get("caption").and_then(Value::as_object);
        let caption_provider = caption.and_then(|c| c.get("provider"));
        let caption_source = caption
            .and_then(|c| c.get("source"))
            .and_then(Value::as_str);
        let provider = media.get("provider");
        let checks: [(&str, Option<&Value>, Option<&Value>, bool); 2] = [
            (
                "",
                provider,
                media.get("privacyAck"),
                provider.and_then(Value::as_str).is_some_and(|p| {
                    ["local", "local-transformers", "egemma2", "off"].contains(&p)
                }),
            ),
            (
                "/caption",
                caption_provider,
                caption.and_then(|c| c.get("privacyAck")),
                !truthy(caption_provider)
                    || caption_provider
                        .and_then(Value::as_str)
                        .is_some_and(|p| ["local", "off"].contains(&p))
                    || caption_source == Some("off"),
            ),
        ];
        for (suffix, provider, ack, local) in checks {
            if !truthy(provider) {
                continue;
            }
            let Some(provider) = provider.and_then(Value::as_str) else {
                continue;
            };
            let failure = privacy_acknowledgment_error(&PrivacyChoice {
                function: if suffix.is_empty() {
                    PrivacyFunction::Media
                } else {
                    PrivacyFunction::Caption
                },
                provider,
                local,
                pinned: false,
                endpoint: None,
                ack,
            });
            if let Some(f) = failure {
                return Some(format!(
                    "{path}{suffix}/privacyAck {}: {}",
                    f.code, f.reason
                ));
            }
        }
    }
    None
}

const VOICE_FEATURES: [&str; 8] = [
    "autoRecall",
    "promptEnrichment",
    "reranker",
    "decisionService",
    "postTurnRefine",
    "memoryWrite",
    "compaction",
    "toolSchemas",
];

fn voice_error(cfg: &Value) -> Option<String> {
    let budget = get_f64(cfg, "/voice/v3/budgetMs")?;
    let base = cfg.pointer("/voice/v3/realtime/features");
    let mut layers: Vec<(String, Map<String, Value>)> = Vec::new();
    let mut base_layer = Map::new();
    for name in VOICE_FEATURES {
        if let Some(v) = base.and_then(|b| b.get(name)) {
            base_layer.insert(name.to_owned(), v.clone());
        }
    }
    layers.push(("/voice/v3/realtime".into(), base_layer));
    if let Some(agents) = cfg.get("agents").and_then(Value::as_object) {
        for (id, agent) in agents {
            let mut layer = Map::new();
            for name in VOICE_FEATURES {
                let over = agent.pointer("/voice/features").and_then(|f| f.get(name));
                layer.insert(
                    name.to_owned(),
                    Value::Object(merged(base.and_then(|b| b.get(name)), over)),
                );
            }
            layers.push((format!("/agents/{id}/voice"), layer));
        }
    }
    for (path, features) in &layers {
        let mut total = 0.0;
        for feature in VOICE_FEATURES {
            let setting = features.get(feature);
            if setting.and_then(|s| s.get("mode")).and_then(Value::as_str) != Some("off") {
                total += setting
                    .and_then(|s| s.get("maxMs"))
                    .and_then(Value::as_f64)
                    .unwrap_or(50.0);
            }
            if total > budget {
                return Some(format!(
                    "{path}/features/{feature} exceeds voice.v3.budgetMs ({} ms)",
                    js_number(total)
                ));
            }
        }
        for name in VOICE_FEATURES {
            if name != "toolSchemas"
                && features
                    .get(name)
                    .and_then(|s| s.get("mode"))
                    .and_then(Value::as_str)
                    == Some("reduced")
            {
                return Some(format!(
                    "{path}/features/{name} reduced is only supported for toolSchemas"
                ));
            }
        }
    }
    None
}

/// `validate` of `packages/config-schema` (`src/index.ts`): the model-context rule, the schema with the defaults filled in
/// (every violation, at most 50 and a count of the rest), then the first failing cross-field rule in the order TypeScript
/// applies them: compaction ratios, recall budgets, break-glass reason lengths, the media and captioning privacy
/// acknowledgments, the voice budget. Returns the configuration with the defaults filled in.
pub fn validate_filled(value: &Value) -> Result<Value, Vec<String>> {
    let apple = crate::model_context_errors(value, None);
    if !apple.is_empty() {
        return Err(apple);
    }
    let mut copy = value.clone();
    apply_defaults(&mut copy);
    let all = crate::schema_errors(&copy);
    if !all.is_empty() {
        let mut errors: Vec<String> = all.iter().take(MAX_ERRORS).cloned().collect();
        if all.len() > MAX_ERRORS {
            errors.push(format!("... and {} more", all.len() - MAX_ERRORS));
        }
        return Err(errors);
    }
    if let (Some(soft), Some(hard)) = (
        get_f64(&copy, "/session/compaction/softRatio"),
        get_f64(&copy, "/session/compaction/hardRatio"),
    ) {
        if soft >= hard {
            return Err(vec![
                "/session/compaction softRatio must be below hardRatio".into(),
            ]);
        }
    }
    if let (Some(soft), Some(hard)) = (
        get_f64(&copy, "/core/recall/softBudgetMs"),
        get_f64(&copy, "/core/recall/hardBudgetMs"),
    ) {
        if soft > hard {
            return Err(vec![
                "/core/recall softBudgetMs must not exceed hardBudgetMs".into(),
            ]);
        }
    }
    if copy.get("breakglass").is_some_and(|b| truthy(Some(b))) {
        if let (Some(min), Some(max)) = (
            get_f64(&copy, "/breakglass/reasonMinChars"),
            get_f64(&copy, "/breakglass/reasonMaxChars"),
        ) {
            if min > max {
                return Err(vec![
                    "/breakglass reasonMinChars must not exceed reasonMaxChars".into(),
                ]);
            }
        }
    }
    if let Some(e) = media_error(&copy) {
        return Err(vec![e]);
    }
    if let Some(e) = voice_error(&copy) {
        return Err(vec![e]);
    }
    Ok(copy)
}
