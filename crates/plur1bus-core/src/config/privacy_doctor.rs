//! `privacy/doctor.ts`: the doctor finding for `privacy.localOnly`. While the switch is on (installation or any agent), every
//! configured cloud model provider is reported as a failure, so the person sees what will be refused before a turn, a voice
//! call or the engine start runs into it. Read-only: nothing is changed and no provider is contacted.
//!
//! The configuration is a [`serde_json::Value`]; every access follows the TypeScript's `obj()` guard (a member that is not a
//! plain object reads as empty). **Order:** the TypeScript walks `Object.entries`, which is insertion order after the
//! integer-like keys; a `serde_json` map is sorted. Integer-like keys come first in ascending numeric order here too, the
//! other keys in key order, so a configuration whose keys are not already sorted can list its findings in another order.
use super::policy::{
    engine_model_endpoints, is_local_endpoint, local_endpoints, local_only_agents,
    local_only_installation, local_only_shared,
};
use serde_json::{Map, Value};

const MEDIA_LOCAL: [&str; 4] = ["local", "local-transformers", "egemma2", "off"];

/// `PrivacyCheck`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrivacyCheck {
    /// `id`
    pub id: String,
    /// `status`: `ok` or `fail`.
    pub status: &'static str,
    /// `summary`
    pub summary: String,
    /// `repair`: `(kind, label)`.
    pub repair: Option<(String, String)>,
}

impl PrivacyCheck {
    /// The JSON the TypeScript object serialises to.
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("id".into(), Value::String(self.id.clone()));
        m.insert("status".into(), Value::String(self.status.to_owned()));
        m.insert("summary".into(), Value::String(self.summary.clone()));
        if let Some((kind, label)) = &self.repair {
            let mut r = Map::new();
            r.insert("kind".into(), Value::String(kind.clone()));
            r.insert("label".into(), Value::String(label.clone()));
            m.insert("repair".into(), Value::Object(r));
        }
        Value::Object(m)
    }
}

/// `v` as `obj(v)[key]`: the member of a plain object (`undefined` for anything else).
fn member<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    v.and_then(Value::as_object).and_then(|m| m.get(key))
}

/// `Object.entries(obj(v))` in JavaScript order (see the module note).
fn entries(v: Option<&Value>) -> Vec<(&String, &Value)> {
    let Some(map) = v.and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut indexed: Vec<(usize, &String, &Value)> = Vec::new();
    let mut rest: Vec<(&String, &Value)> = Vec::new();
    for (k, val) in map {
        match crate::js::array_index(k) {
            Some(i) => indexed.push((i, k, val)),
            None => rest.push((k, val)),
        }
    }
    indexed.sort_by_key(|(i, _, _)| *i);
    indexed
        .into_iter()
        .map(|(_, k, v)| (k, v))
        .chain(rest)
        .collect()
}

/// `String(v)` of a JSON value (the `id` of a media adapter can be anything).
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => {
            plur1bus_log_schema::redact::js_number_string(n.as_f64().unwrap_or(f64::NAN))
        }
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|e| {
                if e.is_null() {
                    String::new()
                } else {
                    js_string(e)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// The cloud model configuration that `privacy.localOnly` would refuse, as short human-readable items (no secrets, origins only).
pub fn local_only_findings(cfg: &Value, shared_only: bool) -> Vec<String> {
    let listed = local_endpoints(cfg);
    let local = |url: Option<&Value>| {
        url.and_then(Value::as_str)
            .is_some_and(|u| is_local_endpoint(u, &listed))
    };
    let mut out = Vec::new();
    let c = Some(cfg);
    if !shared_only {
        for (id, raw) in entries(member(c, "providers")) {
            let Some(def) = raw.as_object() else { continue };
            if !def.contains_key("wireFormat") {
                continue;
            }
            if !local(member(member(Some(raw), "profile"), "base_url")) {
                out.push(format!("chat provider {id}"));
            }
        }
        let adapters = member(member(c, "providers"), "media").and_then(|m| m.get("adapters"));
        for a in adapters.and_then(Value::as_array).into_iter().flatten() {
            let id = match member(Some(a), "id") {
                None | Some(Value::Null) => "unknown".to_owned(),
                Some(v) => js_string(v),
            };
            if id == "coreml-local" {
                continue;
            }
            let default = Value::String("http://127.0.0.1:7860".into());
            let url = match member(Some(a), "baseUrl") {
                None | Some(Value::Null) => (id == "draw-things").then_some(&default),
                Some(v) => Some(v),
            };
            if !local(url) {
                out.push(format!("media adapter {id}"));
            }
        }
        for (id, raw) in entries(member(member(c, "voice"), "providers")) {
            if member(Some(raw), "enabled") == Some(&Value::Bool(true))
                && !local(member(Some(raw), "baseUrl"))
            {
                out.push(format!("voice provider {id}"));
            }
        }
    }
    let media = member(member(c, "memory"), "mediaEmbedding");
    if member(media, "enabled") != Some(&Value::Bool(false)) {
        if let Some(p) = member(media, "provider").and_then(Value::as_str) {
            if !MEDIA_LOCAL.contains(&p) {
                out.push(format!("media index provider {p}"));
            }
        }
    }
    let caption = member(media, "caption");
    if let Some(p) = member(caption, "provider").and_then(Value::as_str) {
        if !MEDIA_LOCAL.contains(&p)
            && member(caption, "source").and_then(Value::as_str) != Some("off")
        {
            out.push(format!("caption provider {p}"));
        }
    }
    let empty = Map::new();
    let engine = member(c, "engine")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    for e in engine_model_endpoints(engine) {
        if !e
            .endpoint
            .as_deref()
            .is_some_and(|u| is_local_endpoint(u, &listed))
        {
            out.push(format!("engine {}", e.role));
        }
    }
    out
}

/// `localOnlyCheck(cfg)`: the doctor check `privacy.local-only`.
pub fn local_only_check(cfg: &Value) -> PrivacyCheck {
    let id = "privacy.local-only".to_owned();
    if !local_only_shared(cfg) {
        return PrivacyCheck {
            id,
            status: "ok",
            summary: "privacy.localOnly is off: cloud models may be used where they are configured and acknowledged.".into(),
            repair: None,
        };
    }
    let scope = if local_only_installation(cfg) {
        "installation-wide".to_owned()
    } else {
        format!(
            "for at least one agent ({})",
            local_only_agents(cfg).join(", ")
        )
    };
    let findings = local_only_findings(cfg, !local_only_installation(cfg));
    if findings.is_empty() {
        return PrivacyCheck {
            id,
            status: "ok",
            summary: format!("privacy.localOnly is on {scope}; no cloud model is configured."),
            repair: None,
        };
    }
    let mut shown = findings
        .iter()
        .take(8)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if findings.len() > 8 {
        shown.push_str(&format!(", and {} more", findings.len() - 8));
    }
    PrivacyCheck {
        id,
        status: "fail",
        summary: format!("privacy.localOnly is on {scope}, but cloud models are configured and will be refused: {shown}."),
        repair: Some((
            "hint".into(),
            "Switch these to a local model, list your own model server in privacy.localEndpoints, or turn privacy.localOnly off (Settings > Privacy).".into(),
        )),
    }
}
