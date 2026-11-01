//! Read-only startup projection from harness config.json to the frozen EngineConfig.
//!
//! This mirrors Core's engine-config.ts for supported text embedding and reranking.
//! Privacy decisions and persisted conditional-model receipts are checked before
//! providers are constructed. Loading configuration never prepares model artifacts.

use crate::{contract::EngineConfig, text::js::js_trim};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Map, Value};
use std::{fmt, io::Read as _, path::Path, time::Duration};
use url::Url;

const E5_SMALL: &str = "intfloat/multilingual-e5-small";
const BGE_RERANKER: &str = "woxpas-ai/bge-reranker-v2-m3-onnx";
const OPENAI_ENDPOINT: &str = "https://api.openai.com/v1";
const NC_MODELS: &[&str] = &[
    "jinaai/jina-embeddings-v3",
    "jinaai/jina-embeddings-v5-text-nano",
    "jinaai/jina-embeddings-v5-text-nano-retrieval",
    "jinaai/jina-reranker-v2-base-multilingual",
];

/// Startup configuration failures with fixed, non-secret diagnostic categories.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigLoadError {
    /// The harness file is unreadable, malformed, or violates its schema.
    Harness,
    /// The projected engine configuration violates the frozen engine schema.
    Engine,
    /// A selected provider has missing or unsupported details.
    Provider(&'static str),
    /// Local-only policy or the function-specific acknowledgment refuses the provider.
    Privacy(&'static str),
    /// A pinned non-commercial model lacks a matching persisted license receipt.
    LicenceRequired,
    /// The selected conditional-model alias is rejected by Core's license gate.
    InvalidLicenceModel,
    /// The existing license ledger cannot be read safely.
    LicenceLedger,
}
impl fmt::Display for ConfigLoadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Harness => formatter.write_str("invalid or unreadable harness configuration"),
            Self::Engine => formatter.write_str("invalid engine configuration"),
            Self::Provider(reason) => {
                write!(formatter, "engine provider configuration refused: {reason}")
            }
            Self::Privacy(reason) => write!(formatter, "engine privacy policy refused: {reason}"),
            Self::LicenceRequired => formatter
                .write_str("selected model revision requires persisted license confirmation"),
            Self::InvalidLicenceModel => formatter.write_str("selected model alias is unsupported"),
            Self::LicenceLedger => formatter.write_str("model license ledger unavailable"),
        }
    }
}
impl std::error::Error for ConfigLoadError {}

/// Read validated harness defaults and project Core's host-owned engine configuration.
/// Missing config.json uses defaults without creating the home, config, or model cache.
pub fn load(home: &Path) -> Result<(EngineConfig, Duration), ConfigLoadError> {
    let cfg =
        plur1bus_config::read(&home.join("config.json")).map_err(|_| ConfigLoadError::Harness)?;
    if !valid_harness_structure(&cfg) {
        return Err(ConfigLoadError::Harness);
    }
    let config = project(&cfg, home)?;
    check_licences(&config, home)?;
    let config = crate::config::validate(&config).map_err(|_| ConfigLoadError::Engine)?;
    let grace_ms = cfg
        .pointer("/supervisor/graceMs")
        .and_then(Value::as_f64)
        .filter(|value| {
            value.is_finite() && *value >= 1000.0 && *value <= 3_600_000.0 && value.fract() == 0.0
        })
        .ok_or(ConfigLoadError::Harness)? as u64;
    Ok((config, Duration::from_millis(grace_ms)))
}

// Match Core's structureErrors before spreading configuration objects. Schema
// validation alone permits arbitrary engine keys, including parsed __proto__.
fn valid_harness_structure(value: &Value) -> bool {
    let mut pending = vec![(value, 0)];
    while let Some((value, depth)) = pending.pop() {
        if !(value.is_object() || value.is_array()) {
            continue;
        }
        if depth > 64 {
            return false;
        }
        match value {
            Value::Object(object) => {
                if object.contains_key("__proto__") {
                    return false;
                }
                pending.extend(object.values().map(|value| (value, depth + 1)));
            }
            Value::Array(array) => pending.extend(array.iter().map(|value| (value, depth + 1))),
            _ => {}
        }
    }
    true
}

fn plain(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter(|(key, _)| key.as_str() != "__proto__")
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

struct Policy<'a> {
    local_only: bool,
    agent_pinned: bool,
    listed: &'a [Value],
}
impl<'a> Policy<'a> {
    fn new(cfg: &'a Value) -> Self {
        let agent_pinned = cfg
            .get("agents")
            .and_then(Value::as_object)
            .is_some_and(|agents| {
                agents
                    .values()
                    .any(|agent| agent.pointer("/privacy/localOnly") == Some(&Value::Bool(true)))
            });
        Self {
            local_only: cfg.pointer("/privacy/localOnly") == Some(&Value::Bool(true))
                || agent_pinned,
            agent_pinned,
            listed: cfg
                .pointer("/privacy/localEndpoints")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        }
    }
    fn check(&self, endpoint: Option<&str>) -> Result<(), ConfigLoadError> {
        if !self.local_only || endpoint.is_some_and(|endpoint| local(endpoint, self.listed)) {
            return Ok(());
        }
        Err(ConfigLoadError::Privacy(if self.agent_pinned {
            "local-only-shared-engine"
        } else {
            "local-only"
        }))
    }
}

fn project(cfg: &Value, home: &Path) -> Result<Value, ConfigLoadError> {
    let policy = Policy::new(cfg);
    let mut engine = plain(cfg.get("engine"));
    // Core preflights the raw shared engine before projection, including its own LLM features.
    check_features(&Value::Object(engine.clone()), &policy)?;
    let override_path = engine
        .get("baseDbPathOverride")
        .and_then(Value::as_str)
        .filter(|value| !js_trim(value).is_empty())
        .map(str::to_owned);
    for name in [
        "implementation",
        "baseDbPathOverride",
        "baseDbPath",
        "autoRecall",
        "autoCapture",
        "media",
    ] {
        engine.remove(name);
    }
    let mut embedding = plain(engine.get("embedding"));
    if is_local(embedding.get("provider")) {
        let local = plain(embedding.get("local"));
        let mut selected = Map::new();
        if !local.contains_key("model") {
            selected.insert("model".into(), json!(E5_SMALL));
            selected.insert("dimensions".into(), json!(384));
        }
        selected.insert("cacheDir".into(), json!(home.join("models")));
        selected.extend(local);
        embedding.insert("provider".into(), json!("local-transformers"));
        embedding.insert("local".into(), Value::Object(selected));
    } else {
        validate_provider(
            &embedding,
            "embedding",
            cfg.pointer("/memory/embedding/privacyAck"),
            &policy,
        )?;
        embedding.remove("local");
    }
    let mut reranker = plain(engine.get("reranker"));
    if is_local(reranker.get("provider")) {
        let mut selected = Map::from_iter([
            ("model".into(), json!(BGE_RERANKER)),
            ("cacheDir".into(), json!(home.join("models"))),
        ]);
        selected.extend(plain(reranker.get("local")));
        reranker.insert("provider".into(), json!("local-transformers"));
        reranker.insert("local".into(), Value::Object(selected));
    } else {
        validate_provider(
            &reranker,
            "reranker",
            cfg.pointer("/memory/reranker/privacyAck"),
            &policy,
        )?;
        reranker.remove("local");
        reranker.insert("fallbackProvider".into(), json!("disabled"));
    }
    reranker.insert("enabled".into(), json!(true));
    let mut recall = plain(engine.get("recall"));
    recall.insert(
        "softBudgetMs".into(),
        cfg["core"]["recall"]["softBudgetMs"].clone(),
    );
    recall.insert(
        "globalInjectMaxChars".into(),
        cfg["core"]["recall"]["capChars"].clone(),
    );
    let mut trace = plain(recall.get("decisionTrace"));
    trace.insert("enabled".into(), json!(true));
    recall.insert("decisionTrace".into(), Value::Object(trace));
    if !engine.contains_key("modelPreparation") {
        if let Some(acceptance) = noncommercial_acceptance(cfg, &embedding) {
            engine.insert("modelPreparation".into(), acceptance);
        }
    }
    engine.insert(
        "baseDbPath".into(),
        override_path
            .map(Value::String)
            .unwrap_or_else(|| json!(home.join("state/lancedb"))),
    );
    engine.insert("autoRecall".into(), json!(false));
    engine.insert("autoCapture".into(), json!(false));
    engine.insert("embedding".into(), Value::Object(embedding));
    engine.insert("reranker".into(), Value::Object(reranker));
    engine.insert("recall".into(), Value::Object(recall));
    Ok(Value::Object(engine))
}

fn is_local(provider: Option<&Value>) -> bool {
    provider.is_none() || provider.and_then(Value::as_str) == Some("local-transformers")
}
fn incomplete() -> ConfigLoadError {
    ConfigLoadError::Provider("engine-provider-config-incomplete")
}
fn id(value: &str, extra: &[u8], max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || extra.contains(&byte))
}
fn endpoint(raw: &Value) -> Result<Url, ConfigLoadError> {
    let url = raw
        .as_str()
        .and_then(|value| Url::parse(value).ok())
        .filter(|url| matches!(url.scheme(), "http" | "https"))
        .ok_or_else(incomplete)?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ConfigLoadError::Provider("secret-in-config"));
    }
    Ok(url)
}
fn loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => host == "localhost",
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}
fn local(raw: &str, listed: &[Value]) -> bool {
    let Ok(url) = endpoint(&json!(raw)) else {
        return false;
    };
    loopback(&url)
        || listed
            .iter()
            .filter_map(Value::as_str)
            .filter_map(|entry| Url::parse(entry).ok())
            .any(|entry| entry.origin() == url.origin())
}
fn rerank_default(provider: &str) -> Option<&'static str> {
    match provider {
        "cohere" => Some("https://api.cohere.com/v2/rerank"),
        "jina" => Some("https://api.jina.ai/v1/rerank"),
        "voyage" => Some("https://api.voyageai.com/v1/rerank"),
        _ => None,
    }
}

fn validate_provider(
    block: &Map<String, Value>,
    role: &str,
    ack: Option<&Value>,
    policy: &Policy<'_>,
) -> Result<(), ConfigLoadError> {
    let provider = block
        .get("provider")
        .and_then(Value::as_str)
        .filter(|value| id(value, b"._-", 64))
        .ok_or(ConfigLoadError::Provider("engine-provider-invalid"))?;
    let reranker = role == "reranker";
    if reranker && !["cohere", "jina", "voyage", "remote"].contains(&provider) {
        return Err(ConfigLoadError::Provider(
            "engine-adapter-factory-unavailable",
        ));
    }
    if block.contains_key("apiKey") {
        return Err(ConfigLoadError::Provider("secret-in-config"));
    }
    if let Some(reference) = block.get("apiKeyRef") {
        if !reference
            .as_str()
            .is_some_and(|reference| id(reference, b"._:/@-", 128))
        {
            return Err(incomplete());
        }
    }
    if let Some(name) = block.get("apiKeyEnv") {
        if !name.as_str().is_some_and(|name| {
            !name.is_empty()
                && name.len() <= 128
                && (name.as_bytes()[0].is_ascii_alphabetic() || name.as_bytes()[0] == b'_')
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        }) {
            return Err(incomplete());
        }
    }
    if (!reranker || provider != "remote")
        && !block.contains_key("apiKeyRef")
        && !block.contains_key("apiKeyEnv")
    {
        return Err(incomplete());
    }
    if block.contains_key("baseURL") {
        return Err(incomplete());
    }
    let url = block.get("baseUrl").map(endpoint).transpose()?;
    if reranker {
        if provider == "remote" && url.is_none() {
            return Err(incomplete());
        }
        if block.get("protocol").is_some_and(|value| {
            !value
                .as_str()
                .is_some_and(|protocol| ["cohere", "jina", "voyage", "tei"].contains(&protocol))
        }) {
            return Err(incomplete());
        }
        if block
            .get("fallbackProvider")
            .is_some_and(|value| value != "disabled")
        {
            return Err(ConfigLoadError::Provider("reranker-fallback-refused"));
        }
        if block
            .get("model")
            .is_some_and(|model| model.as_str().is_none_or(|model| js_trim(model).is_empty()))
        {
            return Err(incomplete());
        }
    } else {
        if block
            .get("fallback")
            .is_some_and(|fallback| !fallback.is_null())
        {
            return Err(ConfigLoadError::Provider("embedding-fallback-refused"));
        }
        if block
            .get("model")
            .and_then(Value::as_str)
            .is_none_or(|model| js_trim(model).is_empty())
            || !block
                .get("dimensions")
                .and_then(Value::as_f64)
                .is_some_and(|width| width > 0.0 && width.fract() == 0.0)
        {
            return Err(incomplete());
        }
        if url.is_none() && provider != "openai" {
            return Err(incomplete());
        }
    }
    let default = if reranker {
        rerank_default(provider)
    } else {
        Some(OPENAI_ENDPOINT)
    };
    policy.check(url.as_ref().map(Url::as_str).or(default))?;
    if url.as_ref().is_some_and(loopback) {
        return Ok(());
    }
    let ack = ack.ok_or(ConfigLoadError::Privacy("privacy-acknowledgment-required"))?;
    if ack
        .get("by")
        .and_then(Value::as_str)
        .is_none_or(|actor| js_trim(actor).is_empty())
        || !ack
            .get("acknowledgedAt")
            .and_then(Value::as_str)
            .is_some_and(privacy_time_valid)
    {
        return Err(ConfigLoadError::Privacy("privacy-acknowledgment-invalid"));
    }
    if ack.get("provider").and_then(Value::as_str) != Some(provider)
        || ack.get("endpoint") != block.get("baseUrl")
    {
        return Err(ConfigLoadError::Privacy("privacy-acknowledgment-mismatch"));
    }
    Ok(())
}

fn privacy_time_valid(at: &str) -> bool {
    // Ajv accepts leap seconds and +HH zones; Core's additional Date.parse gate
    // rejects both. The schema already checks the remaining calendar and time shape.
    if at.as_bytes().get(10) != Some(&b'T')
        || !plur1bus_config::ajv_date_time(at)
        || at.get(17..19) == Some("60")
    {
        return false;
    }
    if at.ends_with(['Z', 'z']) {
        return true;
    }
    at.rfind(['+', '-'])
        .filter(|offset| *offset >= 19)
        .is_some_and(|offset| matches!(at.len() - offset, 5 | 6))
}

fn check_features(engine: &Value, policy: &Policy<'_>) -> Result<(), ConfigLoadError> {
    if !policy.local_only {
        return Ok(());
    }
    fn walk(node: &Value, depth: usize, policy: &Policy<'_>) -> Result<(), ConfigLoadError> {
        if depth > 6 {
            return Ok(());
        }
        let Some(object) = node.as_object() else {
            return Ok(());
        };
        if let Some(base_url) = object.get("baseUrl").and_then(Value::as_str) {
            policy.check(Some(base_url))?;
        } else if object
            .get("apiKey")
            .is_some_and(|key| !key.is_null() && key != "")
            || object.get("apiKeyEnv").is_some_and(Value::is_string)
            || object.get("apiKeyRef").is_some_and(Value::is_string)
        {
            policy.check(None)?;
        }
        for (key, value) in object {
            if key != "__proto__" && key != "headers" {
                walk(value, depth + 1, policy)?;
            }
        }
        Ok(())
    }
    for (key, node) in plain(Some(engine)) {
        if key == "embedding" || key == "reranker" {
            if !is_local(node.get("provider")) {
                let default = if key == "embedding" {
                    Some(OPENAI_ENDPOINT)
                } else {
                    node.get("provider")
                        .and_then(Value::as_str)
                        .and_then(rerank_default)
                };
                policy.check(node.get("baseUrl").and_then(Value::as_str).or(default))?;
            }
        } else {
            walk(&node, 1, policy)?;
        }
    }
    Ok(())
}

fn noncommercial_acceptance(cfg: &Value, embedding: &Map<String, Value>) -> Option<Value> {
    if embedding.get("provider")?.as_str()? != "local-transformers"
        || cfg.pointer("/embedding/acceptedNcLicence") != Some(&Value::Bool(true))
        || cfg.pointer("/embedding/useClass") == Some(&json!("commercial"))
    {
        return None;
    }
    let normalized =
        crate::embedding::normalize::normalize_embedding_config(&Value::Object(embedding.clone()))
            .ok()?;
    if crate::embedding::artifacts::pinned_profile(normalized.model(), None)?.commercial_use
        != Some(false)
    {
        return None;
    }
    let prefix = match normalized.model() {
        "jinaai/jina-embeddings-v3" => "jina-v3-multilingual",
        "jinaai/jina-embeddings-v5-text-nano-retrieval" => "jina-v5-nano",
        _ => return None,
    };
    Some(
        json!({"profile":format!("{prefix}-{}",normalized.dimensions()),"acceptNonCommercialLicense":true}),
    )
}

fn check_licences(config: &Value, home: &Path) -> Result<(), ConfigLoadError> {
    let ledger_path = home.join("state/model-licences.sqlite");
    let receipts = if ledger_path
        .try_exists()
        .map_err(|_| ConfigLoadError::LicenceLedger)?
    {
        // A read-only SQLite handle may create WAL/SHM coordination files.
        // The Core ledger defaults to rollback journaling. Refuse other on-disk
        // modes before opening SQLite rather than ignore a live WAL's receipts.
        let mut file =
            std::fs::File::open(&ledger_path).map_err(|_| ConfigLoadError::LicenceLedger)?;
        let mut header = [0_u8; 20];
        file.read_exact(&mut header)
            .map_err(|_| ConfigLoadError::LicenceLedger)?;
        if &header[..16] != b"SQLite format 3\0" || header[18] != 1 || header[19] != 1 {
            return Err(ConfigLoadError::LicenceLedger);
        }
        let connection = Connection::open_with_flags(
            ledger_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| ConfigLoadError::LicenceLedger)?;
        // Core SELECTs complete rows and tests only exact string model/license/
        // revision matches. Unrelated or malformed receipt fields grant nothing;
        // they do not make an otherwise readable ledger unavailable.
        let mut query = connection
            .prepare("SELECT * FROM model_licences")
            .map_err(|_| ConfigLoadError::LicenceLedger)?;
        let names = query.column_names();
        let indices = ["model", "licence", "revision"]
            .map(|field| names.iter().rposition(|name| *name == field));
        let mut rows = query
            .query([])
            .map_err(|_| ConfigLoadError::LicenceLedger)?;
        let mut receipts = Vec::new();
        while let Some(row) = rows.next().map_err(|_| ConfigLoadError::LicenceLedger)? {
            let text = |index: Option<usize>| -> Result<Option<String>, ConfigLoadError> {
                let Some(index) = index else {
                    return Ok(None);
                };
                Ok(
                    match row
                        .get_ref(index)
                        .map_err(|_| ConfigLoadError::LicenceLedger)?
                    {
                        rusqlite::types::ValueRef::Text(value) => {
                            std::str::from_utf8(value).ok().map(str::to_owned)
                        }
                        _ => None,
                    },
                )
            };
            if let (Some(model), Some(licence), Some(revision)) =
                (text(indices[0])?, text(indices[1])?, text(indices[2])?)
            {
                receipts.push((model, licence, revision));
            }
        }
        receipts
    } else {
        Vec::new()
    };
    fn inspect(node: &Value, receipts: &[(String, String, String)]) -> Result<(), ConfigLoadError> {
        if let Some(object) = node.as_object() {
            if let Some(model) = object
                .get("model")
                .and_then(Value::as_str)
                .filter(|model| NC_MODELS.contains(model))
            {
                // Core explicitly rejects this obsolete alias rather than asking
                // the owner to confirm a different model/revision.
                if model == "jinaai/jina-embeddings-v5-text-nano" {
                    return Err(ConfigLoadError::InvalidLicenceModel);
                }
                let profile = crate::embedding::artifacts::pinned_profile(model, None)
                    .ok_or(ConfigLoadError::LicenceRequired)?;
                let revision = object
                    .get("revision")
                    .and_then(Value::as_str)
                    .unwrap_or(&profile.revision);
                if revision != profile.revision
                    || !receipts.iter().any(|receipt| {
                        receipt.0 == model && receipt.1 == "CC BY-NC-4.0" && receipt.2 == revision
                    })
                {
                    return Err(ConfigLoadError::LicenceRequired);
                }
            }
            for value in object.values() {
                inspect(value, receipts)?;
            }
        } else if let Some(array) = node.as_array() {
            for value in array {
                inspect(value, receipts)?;
            }
        }
        Ok(())
    }
    inspect(config, &receipts)
}
#[cfg(test)]
mod tests {
    // Tests fail immediately on invalid fixtures or failed cleanup; no unchecked values reach production.
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use serde_json::{json, Value};
    use std::{fs, path::Path, time::Duration};

    fn write(home: &Path, value: &Value) {
        fs::write(home.join("config.json"), serde_json::to_vec(value).unwrap()).unwrap();
    }
    fn configured(home: &Path, value: &Value) -> Value {
        write(home, value);
        serde_json::to_value(load(home).unwrap().0).unwrap()
    }
    fn ack(provider: &str, endpoint: Option<&str>) -> Value {
        let mut ack = json!({"provider":provider,"acknowledgedAt":"2026-10-18T09:00:00Z","by":"fixture-owner"});
        if let Some(endpoint) = endpoint {
            ack["endpoint"] = json!(endpoint);
        }
        ack
    }
    fn remote() -> Value {
        json!({"schemaVersion":1,"engine":{"embedding":{"provider":"openai","model":"fixture-model","dimensions":8,"apiKeyEnv":"FIXTURE_KEY"}},"memory":{"embedding":{"privacyAck":ack("openai",None)}}})
    }

    #[test]
    fn missing_config_projects_node_defaults_without_creating_files() {
        let scratch =
            tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let home = scratch.path().join("missing-home");
        let (config, grace) = load(&home).unwrap();
        let config = serde_json::to_value(config).unwrap();
        assert_eq!(grace, Duration::from_secs(60));
        assert_eq!(config["baseDbPath"], json!(home.join("state/lancedb")));
        assert_eq!(
            config["embedding"]["local"]["cacheDir"],
            json!(home.join("models"))
        );
        assert_eq!(
            config["embedding"]["local"]["model"],
            "intfloat/multilingual-e5-small"
        );
        assert_eq!(config["embedding"]["local"]["dimensions"], 384);
        assert_eq!(
            config["reranker"]["local"]["model"],
            "woxpas-ai/bge-reranker-v2-m3-onnx"
        );
        assert_eq!(config["reranker"]["enabled"], true);
        assert_eq!(config["autoRecall"], false);
        assert_eq!(config["autoCapture"], false);
        assert!(!home.exists());
    }

    #[test]
    fn harness_owned_paths_recall_budgets_and_grace_override_passthrough() {
        let scratch =
            tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let home = scratch.path();
        let raw = json!({"schemaVersion":1,"supervisor":{"graceMs":17000},"core":{"recall":{"softBudgetMs":123,"hardBudgetMs":456,"capChars":1789}},"engine":{"implementation":"rust","baseDbPath":"/ignored","baseDbPathOverride":"  ","autoRecall":true,"autoCapture":true,"media":{"enabled":true},"recall":{"softBudgetMs":999,"globalInjectMaxChars":999,"fullTextMaxChars":2000,"decisionTrace":{"enabled":false}}}});
        let config = configured(home, &raw);
        assert_eq!(config["baseDbPath"], json!(home.join("state/lancedb")));
        for key in ["implementation", "baseDbPathOverride", "media"] {
            assert!(config.get(key).is_none());
        }
        assert_eq!(config["recall"]["softBudgetMs"], 123);
        assert_eq!(config["recall"]["globalInjectMaxChars"], 1789);
        assert_eq!(config["recall"]["fullTextMaxChars"], 2000);
        assert_eq!(config["recall"]["decisionTrace"]["enabled"], true);
        assert_eq!(load(home).unwrap().1, Duration::from_secs(17));
        assert!(!home.join("state").exists());
        assert!(!home.join("models").exists());
    }

    #[test]
    fn explicit_database_override_and_selected_local_model_are_preserved() {
        let scratch =
            tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let config = configured(
            scratch.path(),
            &json!({"schemaVersion":1,"engine":{"baseDbPathOverride":"/fixture/db","embedding":{"local":{"model":"google/embeddinggemma-2"}}}}),
        );
        assert_eq!(config["baseDbPath"], "/fixture/db");
        assert_eq!(
            config["embedding"]["local"]["model"],
            "google/embeddinggemma-2"
        );
        assert!(config["embedding"]["local"].get("dimensions").is_none());
    }

    #[test]
    fn selected_remote_embedding_is_preserved_only_with_matching_privacy_acknowledgment() {
        let scratch =
            tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let config = configured(scratch.path(), &remote());
        assert_eq!(config["embedding"]["provider"], "openai");
        assert_eq!(config["embedding"]["model"], "fixture-model");
        let mut raw = remote();
        raw["memory"]["embedding"] = json!({});
        write(scratch.path(), &raw);
        assert!(load(scratch.path()).is_err());
        let mut raw = remote();
        raw["memory"]["embedding"]["privacyAck"] = ack("another-provider", None);
        write(scratch.path(), &raw);
        assert!(load(scratch.path()).is_err());
    }

    #[test]
    fn installation_and_any_agent_local_only_refuse_cloud_without_substituting_models() {
        let scratch =
            tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        for patch in [
            json!({"privacy":{"localOnly":true}}),
            json!({"agents":{"fixture":{"privacy":{"localOnly":true}}}}),
        ] {
            let mut raw = remote();
            raw.as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            write(scratch.path(), &raw);
            assert!(load(scratch.path()).is_err());
        }
        let mut raw = remote();
        raw["memory"]["embedding"] =
            json!({"provider":"remote","baseUrl":"https://private.invalid"});
        write(scratch.path(), &raw);
        assert!(
            load(scratch.path()).is_err(),
            "memory.embedding is privacy metadata, never a silently ignored provider selection"
        );
    }

    #[test]
    fn loopback_endpoints_need_no_ack_but_lan_endpoints_still_do() {
        let scratch =
            tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let mut raw = remote();
        raw["engine"]["embedding"]["baseUrl"] = json!("http://127.0.0.1:8080/v1");
        raw["privacy"] = json!({"localOnly":true});
        raw["memory"]["embedding"] = json!({});
        let config = configured(scratch.path(), &raw);
        assert_eq!(config["embedding"]["baseUrl"], "http://127.0.0.1:8080/v1");
        raw["engine"]["embedding"]["baseUrl"] = json!("http://192.168.1.20:8080/v1");
        raw["privacy"]["localEndpoints"] = json!(["http://192.168.1.20:8080"]);
        write(scratch.path(), &raw);
        assert!(load(scratch.path()).is_err());
        raw["memory"]["embedding"]["privacyAck"] =
            ack("openai", Some("http://192.168.1.20:8080/v1"));
        assert!(configured(scratch.path(), &raw).get("embedding").is_some());
    }

    #[test]
    fn remote_reranker_uses_its_own_ack_and_never_enables_fallback() {
        let scratch =
            tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let mut raw = json!({"schemaVersion":1,"engine":{"reranker":{"provider":"cohere","apiKeyRef":"models/reranker"}},"memory":{"reranker":{"privacyAck":ack("cohere",None)}}});
        let config = configured(scratch.path(), &raw);
        assert_eq!(config["reranker"]["provider"], "cohere");
        assert_eq!(config["reranker"]["enabled"], true);
        assert_eq!(config["reranker"]["fallbackProvider"], "disabled");
        raw["memory"]["reranker"] = json!({});
        write(scratch.path(), &raw);
        assert!(load(scratch.path()).is_err());
    }

    #[test]
    fn local_only_also_checks_engine_feature_transports() {
        let scratch =
            tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        write(
            scratch.path(),
            &json!({"schemaVersion":1,"privacy":{"localOnly":true},"engine":{"merging":{"apiKeyEnv":"FIXTURE_KEY","model":"fixture"}}}),
        );
        assert!(load(scratch.path()).is_err());
        let config = configured(
            scratch.path(),
            &json!({"schemaVersion":1,"privacy":{"localOnly":true},"engine":{"merging":{"baseUrl":"http://localhost:8080/v1","model":"fixture"}}}),
        );
        assert_eq!(config["merging"]["baseUrl"], "http://localhost:8080/v1");
    }

    #[test]
    fn invalid_config_errors_never_echo_untrusted_values() {
        let scratch =
            tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        write(
            scratch.path(),
            &json!({"schemaVersion":1,"engine":{"embedding":{"provider":"openai","model":"fixture-model","dimensions":8,"apiKey":"private-config-secret"}}}),
        );
        let error = load(scratch.path()).unwrap_err();
        assert!(!error.to_string().contains("private-config-secret"));
        assert!(!format!("{error:?}").contains("private-config-secret"));
    }
}

#[cfg(test)]
mod regressions {
    // Tests fail immediately on invalid fixtures or failed cleanup; no unchecked values reach production.
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use std::fs;

    fn write(home: &Path, cfg: &Value) {
        fs::write(home.join("config.json"), serde_json::to_vec(cfg).unwrap()).unwrap();
    }
    fn receipt_ledger(home: &Path, model: &str, revision: &str) {
        fs::create_dir(home.join("state")).unwrap();
        let connection = Connection::open(home.join("state/model-licences.sqlite")).unwrap();
        connection.execute_batch("CREATE TABLE model_licences(who TEXT, at TEXT, licence TEXT, model TEXT, revision TEXT, source TEXT)").unwrap();
        connection.execute("INSERT INTO model_licences VALUES ('fixture','2026-10-18T09:00:00Z','CC BY-NC-4.0',?1,?2,'memory')",[model,revision]).unwrap();
    }
    fn conditional_config() -> Value {
        json!({"schemaVersion":1,"engine":{"embedding":{"local":{"model":"jinaai/jina-embeddings-v3"}}},"embedding":{"acceptedNcLicence":true,"useClass":"research"}})
    }

    #[test]
    fn integral_float_grace_has_the_same_meaning_as_integer_grace() {
        let scratch =
            tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        write(
            scratch.path(),
            &json!({"schemaVersion":1,"supervisor":{"graceMs":17000.0}}),
        );
        assert_eq!(load(scratch.path()).unwrap().1, Duration::from_secs(17));
    }
    #[test]
    fn privacy_acknowledgment_rejects_schema_valid_but_node_unparseable_leap_seconds() {
        let scratch =
            tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        write(
            scratch.path(),
            &json!({"schemaVersion":1,"engine":{"embedding":{"provider":"openai","model":"fixture","dimensions":8,"apiKeyEnv":"FIXTURE_KEY"}},"memory":{"embedding":{"privacyAck":{"provider":"openai","by":"owner","acknowledgedAt":"2026-10-18T23:59:60Z"}}}}),
        );
        assert!(load(scratch.path()).is_err());
    }
    #[test]
    fn conditional_model_receipts_require_the_exact_model_license_and_revision() {
        let scratch =
            tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        write(scratch.path(), &conditional_config());
        assert!(matches!(
            load(scratch.path()),
            Err(ConfigLoadError::LicenceRequired)
        ));
        assert!(!scratch.path().join("state").exists());
        receipt_ledger(
            scratch.path(),
            "jinaai/jina-embeddings-v3",
            "wrong-revision",
        );
        assert!(matches!(
            load(scratch.path()),
            Err(ConfigLoadError::LicenceRequired)
        ));
        let path = scratch.path().join("state/model-licences.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "UPDATE model_licences SET revision=?1",
                ["68ed94909d564380f954be27ae2e133214c1adc9"],
            )
            .unwrap();
        drop(connection);
        let before = fs::read(&path).unwrap();
        let config = serde_json::to_value(load(scratch.path()).unwrap().0).unwrap();
        assert_eq!(
            config["modelPreparation"]["acceptNonCommercialLicense"],
            true
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(!scratch.path().join("models").exists());
    }
    #[test]
    fn wal_license_ledger_is_refused_before_reading_can_create_sidecars() {
        let scratch =
            tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        write(scratch.path(), &json!({"schemaVersion":1}));
        receipt_ledger(scratch.path(), "fixture-model", "fixture-revision");
        let path = scratch.path().join("state/model-licences.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("PRAGMA journal_mode=WAL;")
            .unwrap();
        drop(connection);
        let before: Vec<_> = fs::read_dir(scratch.path().join("state"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert!(matches!(
            load(scratch.path()),
            Err(ConfigLoadError::LicenceLedger)
        ));
        let after: Vec<_> = fs::read_dir(scratch.path().join("state"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(before, after);
    }
}

#[cfg(test)]
mod parity {
    // The fixture is computed from Core; this test exercises Rust's real read-only load path.
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use std::{collections::BTreeMap, fs, path::PathBuf, process::Command};

    const VECTORS: &str = include_str!("../../../../tests/engine-parity/config/startup.json");
    const HOME: &str = "${HOME}";

    fn paths(value: &mut Value, home: &str, normalize: bool) {
        match value {
            Value::String(text) => {
                if normalize && text.starts_with(home) {
                    *text = format!("{HOME}{}", text[home.len()..].replace('\\', "/"));
                } else if !normalize {
                    *text = text.replace(HOME, home);
                }
            }
            Value::Array(items) => {
                for value in items {
                    paths(value, home, normalize);
                }
            }
            Value::Object(object) => {
                for value in object.values_mut() {
                    paths(value, home, normalize);
                }
            }
            _ => {}
        }
    }
    fn snapshot(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
        fn walk(root: &Path, path: &Path, result: &mut BTreeMap<PathBuf, Option<Vec<u8>>>) {
            if !path.exists() {
                return;
            }
            result.insert(path.strip_prefix(root).unwrap().to_path_buf(), None);
            for entry in fs::read_dir(path).unwrap() {
                let entry = entry.unwrap();
                if entry.file_type().unwrap().is_dir() {
                    walk(root, &entry.path(), result);
                } else {
                    result.insert(
                        entry.path().strip_prefix(root).unwrap().to_path_buf(),
                        Some(fs::read(entry.path()).unwrap()),
                    );
                }
            }
        }
        let mut result = BTreeMap::new();
        walk(root, root, &mut result);
        result
    }
    fn ledger(home: &Path, spec: &Value) {
        fs::create_dir_all(home.join("state")).unwrap();
        let path = home.join("state/model-licences.sqlite");
        if spec["kind"] == "directory" {
            fs::create_dir(path).unwrap();
            return;
        }
        if spec["kind"] == "corrupt" {
            fs::write(path, "fixture-corrupt-ledger").unwrap();
            return;
        }
        let db = Connection::open(path).unwrap();
        if spec["kind"] == "unrelated-table" {
            db.execute_batch("CREATE TABLE model_licences(unrelated)")
                .unwrap();
        }
        if spec["kind"] != "rows" {
            return;
        }
        db.execute_batch("CREATE TABLE model_licences(who, at, licence, model, revision, source)")
            .unwrap();
        for row in spec
            .get("rows")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let values = ["who", "at", "licence", "model", "revision", "source"].map(|field| {
                match row.get(field) {
                    Some(Value::String(value)) => Some(rusqlite::types::Value::Text(value.clone())),
                    Some(Value::Number(value)) => {
                        Some(rusqlite::types::Value::Real(value.as_f64().unwrap()))
                    }
                    None | Some(Value::Null) => Some(rusqlite::types::Value::Null),
                    _ => None,
                }
                .expect("unsupported synthetic receipt value")
            });
            db.execute(
                "INSERT INTO model_licences VALUES(?,?,?,?,?,?)",
                rusqlite::params_from_iter(values),
            )
            .unwrap();
        }
    }
    fn error(error: ConfigLoadError) -> Value {
        let (code, reason) = match error {
            ConfigLoadError::Harness | ConfigLoadError::Engine => ("E_CONFIG_INVALID", None),
            ConfigLoadError::Privacy(reason) => ("E_DENIED", Some(reason)),
            ConfigLoadError::Provider("engine-adapter-factory-unavailable") => (
                "E_NOT_AVAILABLE",
                Some("engine-adapter-factory-unavailable"),
            ),
            ConfigLoadError::Provider(reason) => ("E_INVALID_PARAMS", Some(reason)),
            ConfigLoadError::InvalidLicenceModel => ("E_INVALID_PARAMS", None),
            ConfigLoadError::LicenceRequired => ("E_DENIED", Some("model-licence-required")),
            ConfigLoadError::LicenceLedger => ("E_CONFIG_INVALID", Some("licence-ledger")),
        };
        json!({"ok":false,"code":code,"reason":reason})
    }

    #[test]
    fn core_generated_startup_vectors_match_rust_without_writes() {
        let fixture: Value = serde_json::from_str(VECTORS).unwrap();
        assert_eq!(fixture["version"], 1);
        assert_eq!(fixture["source"], "packages/core/src/engine-config.ts");
        let mut failures = Vec::new();
        for vector in fixture["cases"].as_array().unwrap() {
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("home");
            if vector["configDirectory"] == true {
                fs::create_dir_all(home.join("config.json")).unwrap();
            }
            if let Some(raw) = vector.get("rawConfig").and_then(Value::as_str) {
                fs::create_dir(&home).unwrap();
                fs::write(home.join("config.json"), raw).unwrap();
            } else if let Some(raw) = vector.get("config") {
                let mut raw = raw.clone();
                paths(&mut raw, home.to_str().unwrap(), false);
                fs::create_dir(&home).unwrap();
                fs::write(home.join("config.json"), serde_json::to_vec(&raw).unwrap()).unwrap();
            }
            if let Some(spec) = vector.get("ledger") {
                ledger(&home, spec);
            }
            let before = snapshot(root.path());
            let actual = match load(&home) {
                Ok((config, grace)) => {
                    let mut config = serde_json::to_value(config).unwrap();
                    paths(&mut config, home.to_str().unwrap(), true);
                    json!({"ok":true,"config":config,"graceMs":grace.as_millis()})
                }
                Err(cause) => error(cause),
            };
            assert_eq!(
                snapshot(root.path()),
                before,
                "{}: startup wrote files",
                vector["name"]
            );
            if actual != vector["expected"] {
                failures.push(format!(
                    "{}: expected ok={} code={} reason={}; got ok={} code={} reason={}",
                    vector["name"],
                    vector["expected"]["ok"],
                    vector["expected"]["code"],
                    vector["expected"]["reason"],
                    actual["ok"],
                    actual["code"],
                    actual["reason"]
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "Core/Rust config drift:\n{}",
            failures.join("\n")
        );
    }

    #[test]
    fn committed_vectors_are_current_core_results() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let output = Command::new("node")
            .args(["--experimental-strip-types", "--conditions=source"])
            .arg(root.join("packages/core/test/fixtures/engine-config-vectors.ts"))
            .arg("--check")
            .output()
            .expect("Core startup vector generator could not start; run pnpm test:prep with the required Node toolchain");
        assert_ne!(
            output.status.code(),
            Some(2),
            "Core startup vectors differ from the current Core results; run pnpm --filter @plur1bus/core gen:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            output.status.success(),
            "Core startup vector generator failed; run pnpm test:prep to prepare the private Engine package and Core dependencies:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
