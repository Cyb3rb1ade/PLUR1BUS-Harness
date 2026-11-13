//! `engine-config.ts`: the single translation between the harness config and the engine's configuration. Harness-owned keys
//! always win; everything else in `config.engine` passes through. The engine's own catalogue (which model is
//! non-commercial, which preparation profile belongs to a model) and the licence ledger (SQLite) and the egress service are
//! seams: [`EngineCatalog`], [`LicenceLedger`] and [`EgressDecide`].
use super::policy::{
    assert_engine_features_local, assert_shared_engine_privacy, engine_model_endpoints, js_trim,
    local_only_shared, plain, redact_endpoint, resolve_embedding_provider,
    resolve_reranker_provider, PolicyError, ProviderPlan, ProviderPolicy,
};
use crate::run_files::RunFiles;
use serde_json::{json, Map, Value};
use std::io;
use std::path::{Path, PathBuf};

const E5_SMALL: &str = "intfloat/multilingual-e5-small";
const BGE_RERANKER: &str = "woxpas-ai/bge-reranker-v2-m3-onnx";
const NATIVE_NEO_KEYS: [&str; 3] = ["maxRecords", "appendDedupeTailRecords", "retention"];

/// Non-commercial models of the pinned engine catalogue (`licences/memory.ts`).
pub const NC_MODELS: [&str; 4] = [
    "jinaai/jina-embeddings-v3",
    "jinaai/jina-embeddings-v5-text-nano",
    "jinaai/jina-embeddings-v5-text-nano-retrieval",
    "jinaai/jina-reranker-v2-base-multilingual",
];
/// The licence of those models.
pub const NC_LICENCE: &str = "CC BY-NC-4.0";

/// The directories of `paths.ts` that the engine configuration uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineLayout {
    /// `state/lancedb`.
    pub lancedb: PathBuf,
    /// `models`.
    pub models: PathBuf,
    /// `state`.
    pub state: PathBuf,
}

impl EngineLayout {
    /// The layout of a home.
    pub fn new(home: &Path) -> Self {
        Self {
            lancedb: home.join("state").join("lancedb"),
            models: home.join("models"),
            state: home.join("state"),
        }
    }

    /// The layout of the home a [`RunFiles`] belongs to.
    pub fn from_run_files(files: &RunFiles) -> Self {
        Self::new(&files.home)
    }
}

/// What the pinned engine knows about embedding models (`normalizeEmbeddingConfig`, `pinnedLocalModelProfile`,
/// `EMBEDDING_PREPARATION_TARGETS`).
pub trait EngineCatalog {
    /// The model and dimensions an embedding block resolves to; `None` where the engine would refuse the block.
    fn effective_embedding(&self, embedding: &Map<String, Value>) -> Option<(String, Value)>;
    /// Whether the pinned profile of `model` forbids commercial use.
    fn is_non_commercial(&self, model: &str) -> bool;
    /// The preparation profile id for a model and its dimensions.
    fn preparation_target(&self, model: &str, dimensions: &Value) -> Option<String>;
}

/// A catalogue that knows nothing: no model preparation is ever added.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoCatalog;

impl EngineCatalog for NoCatalog {
    fn effective_embedding(&self, _: &Map<String, Value>) -> Option<(String, Value)> {
        None
    }
    fn is_non_commercial(&self, _: &str) -> bool {
        false
    }
    fn preparation_target(&self, _: &str, _: &Value) -> Option<String> {
        None
    }
}

fn provider_policy(cfg: &Value) -> ProviderPolicy {
    ProviderPolicy::of(cfg)
}

fn obj(v: Option<&Value>) -> Map<String, Value> {
    plain(v)
}

fn with_all(mut base: Map<String, Value>, extra: Map<String, Value>) -> Map<String, Value> {
    base.extend(extra);
    base
}

/// `withoutUnsupportedNativeNeoKeys` (RE-D169).
fn without_unsupported_native_neo_keys(
    passthrough: &mut Map<String, Value>,
    engine_schema: &Value,
) {
    let Some(Value::Object(neo)) = passthrough.get("neo") else {
        return;
    };
    let mut neo = plain(Some(&Value::Object(neo.clone())));
    let declared =
        obj(obj(obj(obj(Some(engine_schema)).get("properties")).get("neo")).get("properties"));
    for k in NATIVE_NEO_KEYS {
        if !declared.contains_key(k) {
            neo.remove(k);
        }
    }
    passthrough.insert("neo".into(), Value::Object(neo));
}

/// `buildEngineConfig`: the engine's configuration for a validated harness configuration.
pub fn build_engine_config(
    cfg: &Value,
    layout: &EngineLayout,
    engine_schema: &Value,
    catalog: &dyn EngineCatalog,
) -> Result<Map<String, Value>, PolicyError> {
    assert_shared_engine_privacy(cfg, None)?;
    let mut passthrough = obj(cfg.get("engine"));
    let override_path = passthrough.get("baseDbPathOverride").cloned();
    for k in [
        "implementation",
        "baseDbPathOverride",
        "baseDbPath",
        "autoRecall",
        "autoCapture",
        "media",
    ] {
        passthrough.remove(k);
    }
    without_unsupported_native_neo_keys(&mut passthrough, engine_schema);
    let rer = obj(passthrough.get("reranker"));
    let rec = obj(passthrough.get("recall"));
    let policy = provider_policy(cfg);
    let memory = obj(plain(Some(cfg)).get("memory"));
    let embedding = engine_embedding(cfg, layout)?;
    let rer_plan =
        resolve_reranker_provider(&rer, obj(memory.get("reranker")).get("privacyAck"), &policy)?;
    assert_engine_features_local(&passthrough, &policy)?;
    let reranker = match rer_plan {
        ProviderPlan::Remote(block) => block,
        ProviderPlan::Local => {
            let mut local = Map::new();
            local.insert("model".into(), json!(BGE_RERANKER));
            local.insert("cacheDir".into(), json!(path_text(&layout.models)));
            local.extend(obj(rer.get("local")));
            let mut out = rer.clone();
            out.insert("enabled".into(), json!(true));
            out.insert("provider".into(), json!("local-transformers"));
            out.insert("local".into(), Value::Object(local));
            out
        }
    };
    let core_recall = cfg
        .get("core")
        .and_then(|c| c.get("recall"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut trace = obj(rec.get("decisionTrace"));
    trace.insert("enabled".into(), json!(true));
    let mut recall = rec.clone();
    recall.insert(
        "softBudgetMs".into(),
        core_recall
            .get("softBudgetMs")
            .cloned()
            .unwrap_or(Value::Null),
    );
    recall.insert(
        "globalInjectMaxChars".into(),
        core_recall.get("capChars").cloned().unwrap_or(Value::Null),
    );
    recall.insert("decisionTrace".into(), Value::Object(trace));
    let override_path = match &override_path {
        Some(Value::String(s)) if !js_trim(s).is_empty() => Some(s.clone()),
        _ => None,
    };
    let supports_media = obj(obj(Some(engine_schema)).get("properties"))
        .get("media")
        .is_some_and(Value::is_object);
    let nc = if passthrough.contains_key("modelPreparation") {
        None
    } else {
        non_commercial_acceptance(cfg, &embedding, catalog)
    };
    let mut out = passthrough;
    out.insert(
        "baseDbPath".into(),
        json!(override_path.unwrap_or_else(|| path_text(&layout.lancedb))),
    );
    out.insert("autoRecall".into(), json!(false));
    out.insert("autoCapture".into(), json!(false));
    out.insert("embedding".into(), Value::Object(embedding));
    out.insert("reranker".into(), Value::Object(reranker));
    out.insert("recall".into(), Value::Object(recall));
    if let Some(nc) = nc {
        out.insert("modelPreparation".into(), Value::Object(nc));
    }
    if supports_media {
        let media = cfg
            .get("memory")
            .and_then(|m| m.get("mediaEmbedding"))
            .cloned()
            .unwrap_or(Value::Null);
        out.insert(
            "media".into(),
            Value::Object(build_media_engine_config(&media, &layout.models)),
        );
    }
    Ok(out)
}

fn path_text(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// `localMediaSelection`: the current host supports only verified on-device Gemma.
pub fn local_media_selection(c: &Value) -> bool {
    let provider = c.get("provider").and_then(Value::as_str).unwrap_or("");
    ["local", "local-transformers", "egemma2"].contains(&provider)
        && c.get("model").and_then(Value::as_str) == Some("google/embeddinggemma-2")
}

/// `buildMediaEngineConfig`: translates the owned namespace; raw `engine.media` cannot override host policy.
pub fn build_media_engine_config(c: &Value, models: &Path) -> Map<String, Value> {
    let get = |v: &Value, k: &str| v.get(k).cloned().unwrap_or(Value::Null);
    let num = |v: &Value, k: &str| v.get(k).and_then(Value::as_f64);
    let dims = num(c, "dimensions");
    let enabled = c.get("enabled").and_then(Value::as_bool) == Some(true)
        && local_media_selection(c)
        && dims.is_some_and(|d| [128.0, 256.0, 512.0, 768.0].contains(&d));
    let video = c.get("video").cloned().unwrap_or(Value::Null);
    let audio = c.get("audio").cloned().unwrap_or(Value::Null);
    let mut out = Map::new();
    out.insert("enabled".into(), json!(enabled));
    out.insert("provider".into(), json!("local-transformers"));
    out.insert("model".into(), get(c, "model"));
    out.insert("dimensions".into(), get(c, "dimensions"));
    out.insert("modalities".into(), get(c, "modalities"));
    out.insert("precision".into(), json!("fp32"));
    out.insert("privacyPin".into(), json!("local"));
    out.insert("cacheDir".into(), json!(path_text(models)));
    out.insert(
        "segmentMs".into(),
        num(&video, "segmentSec").map_or(Value::Null, |s| number(s * 1000.0)),
    );
    out.insert(
        "maxFrames".into(),
        num(&video, "maxFrames").map_or(Value::Null, |m| number(m.min(32.0))),
    );
    out.insert(
        "maxAudioSeconds".into(),
        num(&audio, "maxSeconds").map_or(Value::Null, |m| number(m.min(300.0))),
    );
    out.insert("backfill".into(), get(c, "backfill"));
    out
}

/// `engineEmbedding`: a remote provider as configured, otherwise the local model. E5-small with 384 dimensions stays the
/// default while `engine.embedding.local.model` names none.
pub fn engine_embedding(
    cfg: &Value,
    layout: &EngineLayout,
) -> Result<Map<String, Value>, PolicyError> {
    let emb = obj(obj(cfg.get("engine")).get("embedding"));
    let ack = obj(obj(plain(Some(cfg)).get("memory")).get("embedding"));
    let plan = resolve_embedding_provider(&emb, ack.get("privacyAck"), &provider_policy(cfg))?;
    if let ProviderPlan::Remote(block) = plan {
        return Ok(block);
    }
    let local = obj(emb.get("local"));
    let mut merged = Map::new();
    if !local.contains_key("model") {
        merged.insert("model".into(), json!(E5_SMALL));
        merged.insert("dimensions".into(), json!(384));
    }
    merged.insert("cacheDir".into(), json!(path_text(&layout.models)));
    merged.extend(local);
    let mut out = emb;
    out.insert("provider".into(), json!("local-transformers"));
    out.insert("local".into(), Value::Object(merged));
    Ok(out)
}

/// `nonCommercialAcceptance`: the engine loads a pinned non-commercial embedding only with
/// `modelPreparation.acceptNonCommercialLicense`.
fn non_commercial_acceptance(
    cfg: &Value,
    embedding: &Map<String, Value>,
    catalog: &dyn EngineCatalog,
) -> Option<Map<String, Value>> {
    let licence = obj(plain(Some(cfg)).get("embedding"));
    if embedding.get("provider").and_then(Value::as_str) != Some("local-transformers")
        || licence.get("acceptedNcLicence") != Some(&json!(true))
        || licence.get("useClass").and_then(Value::as_str) == Some("commercial")
    {
        return None;
    }
    let (model, dimensions) = catalog.effective_embedding(embedding)?;
    if !catalog.is_non_commercial(&model) {
        return None;
    }
    let id = catalog.preparation_target(&model, &dimensions)?;
    Some(with_all(
        Map::new(),
        [
            ("profile".to_owned(), json!(id)),
            ("acceptNonCommercialLicense".to_owned(), json!(true)),
        ]
        .into_iter()
        .collect(),
    ))
}

/// A persisted licence confirmation (`LicenceAcceptance`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LicenceAcceptance {
    /// The model.
    pub model: String,
    /// The licence.
    pub licence: String,
    /// The revision.
    pub revision: Option<String>,
}

/// The licence ledger `state/model-licences.sqlite`.
pub trait LicenceLedger {
    /// All persisted confirmations of the ledger file at `path` (opened read-only).
    fn accepted(&self, path: &Path) -> io::Result<Vec<LicenceAcceptance>>;
}

/// `memoryModel`: licence and pinned revision of a non-commercial model.
pub fn memory_model(model: &str) -> Result<(String, &'static str, &'static str), PolicyError> {
    if model == "jinaai/jina-embeddings-v5-text-nano" {
        return Err(PolicyError::new(
            "E_INVALID_PARAMS",
            "use the pinned Jina v5 retrieval model",
            None,
        ));
    }
    if !NC_MODELS.contains(&model) {
        return Err(PolicyError::new(
            "E_INVALID_PARAMS",
            "unknown non-commercial model",
            None,
        ));
    }
    let revision = if model == NC_MODELS[0] {
        "68ed94909d564380f954be27ae2e133214c1adc9"
    } else if model.contains("v5") {
        "ac5d898c8d382b17167c33e5c8af644a3519b47d"
    } else {
        "9cfeff2df7d40d1b78e75e5e9cebec92a99813c9"
    };
    Ok((model.to_owned(), NC_LICENCE, revision))
}

/// `assertMemoryConfiguration`: every non-commercial model named anywhere in `value` needs a persisted confirmation of
/// its pinned revision.
pub fn assert_memory_configuration(
    value: &Value,
    accepted: &[LicenceAcceptance],
) -> Result<(), PolicyError> {
    match value {
        Value::Object(o) => {
            if let Some(model) = o.get("model").and_then(Value::as_str) {
                if NC_MODELS.contains(&model) {
                    let (m, licence, pinned) = memory_model(model)?;
                    let revision = o.get("revision").and_then(Value::as_str).unwrap_or(pinned);
                    let confirmed = accepted.iter().any(|a| {
                        a.model == m
                            && a.licence == licence
                            && a.revision.as_deref() == Some(revision)
                    });
                    if revision != pinned || !confirmed {
                        return Err(PolicyError::new(
                            "E_DENIED",
                            "selected model revision lacks persisted licence confirmation",
                            Some("model-licence-required"),
                        ));
                    }
                }
            }
            o.values()
                .try_for_each(|v| assert_memory_configuration(v, accepted))
        }
        Value::Array(items) => items
            .iter()
            .try_for_each(|v| assert_memory_configuration(v, accepted)),
        _ => Ok(()),
    }
}

/// `checkEngineConfigLicences`: the execution gate, separate from the pure projection.
pub fn check_engine_config_licences(
    engine_config: &Value,
    layout: &EngineLayout,
    ledger: &dyn LicenceLedger,
) -> Result<(), PolicyError> {
    let path = layout.state.join("model-licences.sqlite");
    let accepted = if path.exists() {
        ledger.accepted(&path).map_err(|e| {
            PolicyError::new(
                "E_INTERNAL",
                format!("licence ledger not readable: {e}"),
                None,
            )
        })?
    } else {
        Vec::new()
    };
    assert_memory_configuration(engine_config, &accepted)
}

/// The decision of the egress policy for one endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EgressDecision {
    /// The endpoint may be called.
    Allowed,
    /// Refused, with the policy's reason (`not-found` when the name does not resolve).
    Denied {
        /// The reason.
        reason: String,
    },
}

/// `Egress.decide`.
pub trait EgressDecide {
    /// Decides whether `endpoint` may be called.
    fn decide(&self, endpoint: &str) -> EgressDecision;
}

impl<F: Fn(&str) -> EgressDecision> EgressDecide for F {
    fn decide(&self, endpoint: &str) -> EgressDecision {
        self(endpoint)
    }
}

/// `checkEngineEgress`: every model endpoint the engine will call must pass the egress policy. A name that does not resolve
/// right now, or an endpoint without a known host, is only reported through `warn`.
pub fn check_engine_egress(
    engine_config: &Map<String, Value>,
    egress: &dyn EgressDecide,
    warn: &mut dyn FnMut(&str, &Map<String, Value>),
) -> Result<(), PolicyError> {
    for e in engine_model_endpoints(engine_config) {
        let Some(endpoint) = e.endpoint.as_deref() else {
            let mut fields = Map::new();
            fields.insert("role".into(), json!(e.role));
            warn(
                "engine model endpoint not checked by egress: no baseUrl, provider default",
                &fields,
            );
            continue;
        };
        match egress.decide(endpoint) {
            EgressDecision::Allowed => {}
            EgressDecision::Denied { reason } if reason == "not-found" => {
                let mut fields = Map::new();
                fields.insert("role".into(), json!(e.role));
                fields.insert("endpoint".into(), json!(redact_endpoint(endpoint)));
                warn(
                    "engine model endpoint did not resolve; egress could not judge it",
                    &fields,
                );
            }
            EgressDecision::Denied { reason } => {
                return Err(PolicyError::new(
                    "E_DENIED",
                    format!(
                        "engine {} endpoint {} is refused by the egress policy ({reason}); list the host in egress.allowHosts (loopback also needs egress.allowLoopback)",
                        e.role,
                        redact_endpoint(endpoint)
                    ),
                    Some("egress-denied"),
                ));
            }
        }
    }
    Ok(())
}

/// Whether the shared engine must stay local (re-exported for callers that build a plan).
pub fn shared_engine_local(cfg: &Value) -> bool {
    local_only_shared(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use plur1bus_config::defaults;
    use std::cell::RefCell;

    fn layout() -> EngineLayout {
        EngineLayout::new(Path::new("/h/.plur1bus"))
    }

    /// A path of the layout as these tests spell it: the platform's separator (`\` on Windows, where the layout joins
    /// with it as `path.join` does) read as `/`.
    fn posix(path: &Value) -> String {
        path.as_str().unwrap_or_default().replace('\\', "/")
    }

    fn schema() -> Value {
        json!({"properties": {}})
    }

    fn build(cfg: &Value) -> Result<Map<String, Value>, PolicyError> {
        build_engine_config(cfg, &layout(), &schema(), &NoCatalog)
    }

    #[test]
    fn forces_the_harness_owned_keys_and_passes_engine_keys_through() {
        let mut cfg = defaults();
        cfg["engine"]["recallMinScore"] = json!(0.42);
        let e = Value::Object(build(&cfg).unwrap());
        assert_eq!(posix(&e["baseDbPath"]), "/h/.plur1bus/state/lancedb");
        assert_eq!(e["autoRecall"], false);
        assert_eq!(e["autoCapture"], false);
        assert_eq!(e["embedding"]["provider"], "local-transformers");
        assert_eq!(
            e["embedding"]["local"]["model"],
            "intfloat/multilingual-e5-small"
        );
        assert_eq!(e["embedding"]["local"]["dimensions"], 384);
        assert_eq!(e["embedding"]["local"]["cacheDir"], "/h/.plur1bus/models");
        assert_eq!(e["reranker"]["enabled"], true);
        assert_eq!(
            e["reranker"]["local"]["model"],
            "woxpas-ai/bge-reranker-v2-m3-onnx"
        );
        assert_eq!(e["recall"]["softBudgetMs"], 400);
        assert_eq!(e["recall"]["globalInjectMaxChars"], 17000);
        assert_eq!(e["recall"]["decisionTrace"]["enabled"], true);
        assert_eq!(e["recallMinScore"], 0.42);
        assert!(e.get("media").is_none());
    }

    #[test]
    fn a_user_cannot_override_the_forced_keys_through_engine() {
        let mut cfg = defaults();
        cfg["engine"]["baseDbPath"] = json!("/elsewhere");
        cfg["engine"]["autoCapture"] = json!(true);
        cfg["engine"]["reranker"] = json!({"enabled": false});
        let e = build(&cfg).unwrap();
        assert_eq!(posix(&e["baseDbPath"]), "/h/.plur1bus/state/lancedb");
        assert_eq!(e["autoCapture"], false);
        assert_eq!(e["reranker"]["enabled"], true);
    }

    #[test]
    fn base_db_path_override_wins_but_blank_does_not() {
        let mut cfg = defaults();
        cfg["engine"]["baseDbPathOverride"] = json!("/tmp/db");
        assert_eq!(build(&cfg).unwrap()["baseDbPath"], "/tmp/db");
        for blank in ["", "   ", "\u{a0}\n"] {
            cfg["engine"]["baseDbPathOverride"] = json!(blank);
            assert_eq!(
                posix(&build(&cfg).unwrap()["baseDbPath"]),
                "/h/.plur1bus/state/lancedb"
            );
        }
    }

    #[test]
    fn non_object_sections_are_replaced_not_spread() {
        let mut cfg = defaults();
        cfg["engine"]["embedding"] = json!("abc");
        cfg["engine"]["reranker"] = json!(["x"]);
        cfg["engine"]["recall"] = json!(7);
        let e = build(&cfg).unwrap();
        assert_eq!(e["embedding"]["provider"], "local-transformers");
        assert_eq!(e["reranker"]["provider"], "local-transformers");
        assert_eq!(e["recall"]["softBudgetMs"], 400);
        assert!(e["embedding"].get("0").is_none() && e["reranker"].get("0").is_none());
    }

    #[test]
    fn a_proto_key_in_engine_is_not_copied() {
        let mut cfg = defaults();
        let engine: Value =
            serde_json::from_str(r#"{"__proto__":{"polluted":1},"keep":1}"#).unwrap();
        cfg["engine"]
            .as_object_mut()
            .unwrap()
            .extend(engine.as_object().unwrap().clone());
        let e = build(&cfg).unwrap();
        assert!(!e.contains_key("__proto__"));
        assert_eq!(e["keep"], 1);
    }

    #[test]
    fn native_neo_keys_are_dropped_unless_declared_and_typos_stay() {
        let mut cfg = defaults();
        cfg["engine"]["neo"] =
            json!({"maxRecords": 5, "appendDedupeTailRecords": 2, "retention": {}, "typo": 1});
        let e = build(&cfg).unwrap();
        assert_eq!(e["neo"], json!({"typo": 1}));
        assert_eq!(cfg["engine"]["neo"]["maxRecords"], 5, "input not mutated");
        let declared =
            json!({"properties": {"neo": {"properties": {"maxRecords": {}, "retention": {}}}}});
        let e = build_engine_config(&cfg, &layout(), &declared, &NoCatalog).unwrap();
        assert_eq!(
            e["neo"],
            json!({"maxRecords": 5, "retention": {}, "typo": 1})
        );
        let mut none = defaults();
        none["engine"].as_object_mut().unwrap().remove("neo");
        assert!(!build(&none).unwrap().contains_key("neo"));
    }

    #[test]
    fn media_is_projected_only_when_the_schema_declares_it() {
        let cfg = defaults();
        let declared = json!({"properties": {"media": {"type": "object"}}});
        let e = build_engine_config(&cfg, &layout(), &declared, &NoCatalog).unwrap();
        assert_eq!(e["media"]["provider"], "local-transformers");
        assert_eq!(posix(&e["media"]["cacheDir"]), "/h/.plur1bus/models");
        assert_eq!(e["media"]["privacyPin"], "local");
    }

    #[test]
    fn local_only_refuses_a_cloud_embedding_even_with_an_acknowledgment() {
        let mut cfg = defaults();
        cfg["privacy"]["localOnly"] = json!(true);
        cfg["engine"]["embedding"] = json!({"provider": "openai", "model": "text-embedding-3-small", "apiKeyRef": "openai-key"});
        let e = build(&cfg).unwrap_err();
        assert_eq!(e.code, "E_DENIED");
    }

    struct Fake;
    impl EngineCatalog for Fake {
        fn effective_embedding(&self, e: &Map<String, Value>) -> Option<(String, Value)> {
            let l = e.get("local")?;
            Some((
                l.get("model")?.as_str()?.to_owned(),
                l.get("dimensions").cloned().unwrap_or(json!(1024)),
            ))
        }
        fn is_non_commercial(&self, m: &str) -> bool {
            NC_MODELS.contains(&m)
        }
        fn preparation_target(&self, m: &str, _: &Value) -> Option<String> {
            Some(format!("profile-{}", m.rsplit('/').next()?))
        }
    }

    fn nc_config() -> Value {
        let mut cfg = defaults();
        cfg["engine"]["embedding"] =
            json!({"local": {"model": "jinaai/jina-embeddings-v3", "dimensions": 1024}});
        cfg
    }

    #[test]
    fn non_commercial_acceptance_follows_the_owner_and_the_use_class() {
        let mut cfg = nc_config();
        let none = |c: &Value| build_engine_config(c, &layout(), &schema(), &Fake).unwrap();
        assert!(!none(&cfg).contains_key("modelPreparation"));
        cfg["embedding"] = json!({"acceptedNcLicence": true});
        assert_eq!(
            none(&cfg)["modelPreparation"],
            json!({"profile": "profile-jina-embeddings-v3", "acceptNonCommercialLicense": true})
        );
        cfg["embedding"] = json!({"acceptedNcLicence": true, "useClass": "commercial"});
        assert!(!none(&cfg).contains_key("modelPreparation"));
        cfg["embedding"] = json!({"acceptedNcLicence": true});
        cfg["engine"]["modelPreparation"] = json!({"profile": "mine"});
        assert_eq!(none(&cfg)["modelPreparation"], json!({"profile": "mine"}));
        let mut permissive = defaults();
        permissive["embedding"] = json!({"acceptedNcLicence": true});
        assert!(!none(&permissive).contains_key("modelPreparation"));
    }

    #[test]
    fn memory_configuration_needs_a_confirmation_of_the_pinned_revision() {
        let (_, _, rev) = memory_model("jinaai/jina-embeddings-v3").unwrap();
        let cfg = json!({"embedding": {"local": {"model": "jinaai/jina-embeddings-v3"}}});
        assert_eq!(
            assert_memory_configuration(&cfg, &[])
                .unwrap_err()
                .reason
                .as_deref(),
            Some("model-licence-required")
        );
        let ok = LicenceAcceptance {
            model: "jinaai/jina-embeddings-v3".into(),
            licence: NC_LICENCE.into(),
            revision: Some(rev.into()),
        };
        assert!(assert_memory_configuration(&cfg, std::slice::from_ref(&ok)).is_ok());
        let stale = json!({"model": "jinaai/jina-embeddings-v3", "revision": "other"});
        assert!(assert_memory_configuration(&stale, &[ok]).is_err());
        assert!(memory_model("jinaai/jina-embeddings-v5-text-nano").is_err());
        assert!(memory_model("nope").is_err());
    }

    struct Ledger(Vec<LicenceAcceptance>);
    impl LicenceLedger for Ledger {
        fn accepted(&self, _: &Path) -> io::Result<Vec<LicenceAcceptance>> {
            Ok(self.0.clone())
        }
    }

    #[test]
    fn the_ledger_is_read_only_when_its_file_exists() {
        let d = tempfile::tempdir().unwrap();
        let l = EngineLayout::new(d.path());
        let cfg = json!({"model": "jinaai/jina-embeddings-v3"});
        assert!(check_engine_config_licences(&cfg, &l, &Ledger(vec![])).is_err());
        std::fs::create_dir_all(&l.state).unwrap();
        std::fs::write(l.state.join("model-licences.sqlite"), "").unwrap();
        let (m, lic, rev) = memory_model("jinaai/jina-embeddings-v3").unwrap();
        let acc = LicenceAcceptance {
            model: m,
            licence: lic.into(),
            revision: Some(rev.into()),
        };
        assert!(check_engine_config_licences(&cfg, &l, &Ledger(vec![acc])).is_ok());
    }

    #[test]
    fn egress_refuses_unlisted_hosts_and_only_reports_the_unjudgeable() {
        let cfg = json!({"embedding": {"provider": "openai", "baseUrl": "https://user:pw@evil.example/v1"}, "llm": {"x": {"baseUrl": "https://gone.example"}}});
        let engine = cfg.as_object().unwrap();
        let seen = RefCell::new(Vec::<String>::new());
        let decide = |url: &str| {
            if url.contains("evil") {
                EgressDecision::Denied {
                    reason: "host-not-allowed".into(),
                }
            } else if url.contains("gone") {
                EgressDecision::Denied {
                    reason: "not-found".into(),
                }
            } else {
                EgressDecision::Allowed
            }
        };
        let mut warn = |m: &str, _: &Map<String, Value>| seen.borrow_mut().push(m.to_owned());
        let e = check_engine_egress(engine, &decide, &mut warn).unwrap_err();
        assert_eq!(e.code, "E_DENIED");
        assert_eq!(e.reason.as_deref(), Some("egress-denied"));
        assert!(!e.message.contains("pw"), "{}", e.message);
        assert!(e.message.contains("egress.allowHosts"));
        let mut quiet = |_: &str, _: &Map<String, Value>| {};
        assert!(check_engine_egress(&Map::new(), &decide, &mut quiet).is_ok());
    }
}
