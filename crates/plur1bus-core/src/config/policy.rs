//! The privacy and provider rules the configuration code applies (TypeScript: `privacy/local-only.ts`,
//! `privacy/shared-engine.ts`, `composition/embedding-policy.ts` and `privacyAcknowledgmentError` of
//! `packages/config-schema/src/privacy.ts`).
//!
//! "Nur lokal" (owner decision 2026-10-18): with `privacy.localOnly` on, no model call leaves this machine. One place decides
//! what is local: loopback (`localhost`, 127.0.0.0/8, `::1`) or an exact origin listed in `privacy.localEndpoints`. A refused
//! provider is never replaced by another model. Every refusal is a [`PolicyError`], the fields of the TypeScript `RpcError`
//! (`error`, `message`, `reason`).
use super::endpoint::Url;
use serde_json::{Map, Value};

/// The refusal reason of the local-only rules.
pub const LOCAL_ONLY_REASON: &str = "local-only";
/// The hint every local-only refusal carries.
pub const LOCAL_ONLY_HINT: &str = "privacy.localOnly is on (Settings > Privacy): only local models may be used; turn the switch off, choose a local model, or list your own model server in privacy.localEndpoints";
/// The endpoint the pinned engine's OpenAI-compatible client calls when `baseUrl` is left out (openai only).
pub const OPENAI_DEFAULT_ENDPOINT: &str = "https://api.openai.com/v1";
/// Default Cohere endpoint; a configured baseUrl overrides it.
pub const COHERE_RERANK_ENDPOINT: &str = "https://api.cohere.com/v2/rerank";

/// A refusal with the fields of the TypeScript `RpcError`: `error` (the code), `message` and `reason`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyError {
    /// `RpcError.error`, for example `E_DENIED`.
    pub code: String,
    /// The message.
    pub message: String,
    /// `RpcError.reason`, when the refusal has one.
    pub reason: Option<String>,
}

impl PolicyError {
    pub(crate) fn new(code: &str, message: impl Into<String>, reason: Option<&str>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            reason: reason.map(str::to_owned),
        }
    }
}

impl std::fmt::Display for PolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for PolicyError {}

/// `String.prototype.trim`'s white space.
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `text.trim()`.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

fn object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

/// A shallow copy of a plain object without `__proto__` keys; anything else (string, array, null, number) is `{}`.
pub(crate) fn plain(value: Option<&Value>) -> Map<String, Value> {
    object(value)
        .map(|o| {
            o.iter()
                .filter(|(k, _)| k.as_str() != "__proto__")
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn agents_of(cfg: &Value) -> Vec<(&String, &Value)> {
    object(cfg.get("agents"))
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}

fn agent_local_only(agent: &Value) -> bool {
    agent.pointer("/privacy/localOnly") == Some(&Value::Bool(true))
}

/// The installation-wide switch.
pub fn local_only_installation(cfg: &Value) -> bool {
    cfg.pointer("/privacy/localOnly") == Some(&Value::Bool(true))
}

/// For the shared services every agent writes into (memory engine, media index): local-only while the installation is, or
/// while any agent is.
pub fn local_only_shared(cfg: &Value) -> bool {
    local_only_installation(cfg) || agents_of(cfg).iter().any(|(_, a)| agent_local_only(a))
}

/// Explicit agent pins that keep the shared engine local even when the installation switch is off, sorted.
pub fn local_only_agents(cfg: &Value) -> Vec<String> {
    let mut ids: Vec<String> = agents_of(cfg)
        .into_iter()
        .filter(|(_, a)| agent_local_only(a))
        .map(|(id, _)| id.clone())
        .collect();
    ids.sort();
    ids
}

/// `privacy.localEndpoints`: the string entries (a non-list is empty).
pub fn local_endpoints(cfg: &Value) -> Vec<String> {
    cfg.pointer("/privacy/localEndpoints")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|e| e.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn is_loopback_url(url: &Url) -> bool {
    if !url.is_http() {
        return false;
    }
    let host = url.hostname.to_lowercase();
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host == "localhost" || host == "::1" {
        return true;
    }
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 3 && p.bytes().all(|b| b.is_ascii_digit()))
        && parts
            .iter()
            .all(|p| p.parse::<u16>().is_ok_and(|n| n <= 255))
        && parts[0] == "127"
}

/// Loopback by spelling: `localhost`, an IPv4 literal in 127.0.0.0/8, or `::1`. A name is never resolved here.
pub fn is_loopback_endpoint(raw: &str) -> bool {
    Url::parse(raw).is_some_and(|u| is_loopback_url(&u))
}

/// Loopback, or the exact origin of one entry in `privacy.localEndpoints`. A malformed entry never matches.
pub fn is_local_endpoint(raw: &str, listed: &[String]) -> bool {
    let Some(url) = Url::parse(raw) else {
        return false;
    };
    if !url.is_http() || !url.username.is_empty() || !url.password.is_empty() {
        return false;
    }
    if is_loopback_url(&url) {
        return true;
    }
    let origin = url.origin();
    listed
        .iter()
        .any(|entry| Url::parse(entry).is_some_and(|e| e.origin() == origin))
}

/// Origin only: a path or query of a configured endpoint never reaches an error message.
pub fn redact_endpoint(raw: &str) -> String {
    match Url::parse(raw) {
        Some(url) => format!("{}//{}", url.protocol(), url.host()),
        None => "an invalid endpoint".to_owned(),
    }
}

/// The refusal every enforcement point throws: `E_DENIED`, reason `local-only`, never a substitute model.
pub fn local_only_denied(what: &str, endpoint: Option<&str>) -> PolicyError {
    let shown = match endpoint {
        Some(e) if !e.is_empty() => format!(" ({})", redact_endpoint(e)),
        _ => String::new(),
    };
    PolicyError::new(
        "E_DENIED",
        format!("{what} is not a local model{shown}; {LOCAL_ONLY_HINT}"),
        Some(LOCAL_ONLY_REASON),
    )
}

/// Throws the local-only refusal when the switch is on and `endpoint` is not local; `None` means a cloud default.
pub fn assert_local_endpoint(
    active: bool,
    what: &str,
    endpoint: Option<&str>,
    listed: &[String],
) -> Result<(), PolicyError> {
    if !active {
        return Ok(());
    }
    if endpoint.is_some_and(|e| is_local_endpoint(e, listed)) {
        return Ok(());
    }
    Err(local_only_denied(what, endpoint))
}

/// A model endpoint the shared engine would call (`EngineEndpoint`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineEndpoint {
    /// `embedding`, `reranker`, or the dotted path of an engine LLM feature.
    pub role: String,
    /// The endpoint, `None` where the feature names a key but no `baseUrl` (its provider's default endpoint).
    pub endpoint: Option<String>,
}

fn is_local_provider(provider: Option<&Value>) -> bool {
    provider.is_none() || provider.and_then(Value::as_str) == Some("local-transformers")
}

fn rerank_endpoint(provider: &str) -> Option<&'static str> {
    match provider {
        "cohere" => Some(COHERE_RERANK_ENDPOINT),
        "jina" => Some("https://api.jina.ai/v1/rerank"),
        "voyage" => Some("https://api.voyageai.com/v1/rerank"),
        _ => None,
    }
}

const MAX_DEPTH: usize = 6;

/// Every model endpoint the engine would call with this configuration: the remote embedding and reranker, and each engine
/// LLM feature with a transport of its own (`<feature>.baseUrl`). A feature that names a key but no `baseUrl` calls its
/// provider's default endpoint, which is not on this machine: it is listed with `endpoint: None`. The members after
/// `embedding` and `reranker` are visited in key order (`serde_json` sorts them; TypeScript keeps insertion order).
pub fn engine_model_endpoints(engine_config: &Map<String, Value>) -> Vec<EngineEndpoint> {
    let mut out = Vec::new();
    if let Some(emb) = engine_config.get("embedding").and_then(Value::as_object) {
        if !is_local_provider(emb.get("provider")) {
            out.push(EngineEndpoint {
                role: "embedding".into(),
                endpoint: Some(
                    emb.get("baseUrl")
                        .and_then(Value::as_str)
                        .unwrap_or(OPENAI_DEFAULT_ENDPOINT)
                        .to_owned(),
                ),
            });
        }
    }
    if let Some(rer) = engine_config.get("reranker").and_then(Value::as_object) {
        if !is_local_provider(rer.get("provider")) {
            out.push(EngineEndpoint {
                role: "reranker".into(),
                endpoint: rer
                    .get("baseUrl")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| {
                        // `String(provider)` of a non-string never names a preset.
                        rer.get("provider")
                            .and_then(Value::as_str)
                            .and_then(rerank_endpoint)
                            .map(str::to_owned)
                    }),
            });
        }
    }
    fn walk(node: &Value, path: &str, depth: usize, out: &mut Vec<EngineEndpoint>) {
        let Some(o) = node.as_object().filter(|_| depth <= MAX_DEPTH) else {
            return;
        };
        if let Some(base) = o.get("baseUrl").and_then(Value::as_str) {
            out.push(EngineEndpoint {
                role: path.to_owned(),
                endpoint: Some(base.to_owned()),
            });
        } else if o
            .get("apiKey")
            .is_some_and(|k| !k.is_null() && k.as_str() != Some(""))
            || o.get("apiKeyEnv").is_some_and(Value::is_string)
            || o.get("apiKeyRef").is_some_and(Value::is_string)
        {
            out.push(EngineEndpoint {
                role: path.to_owned(),
                endpoint: None,
            });
        }
        for (k, v) in o {
            if k != "__proto__" && k != "headers" {
                walk(v, &format!("{path}.{k}"), depth + 1, out);
            }
        }
    }
    for (k, v) in engine_config {
        if k != "embedding" && k != "reranker" && k != "__proto__" {
            walk(v, k, 1, &mut out);
        }
    }
    out
}

/// What the installation and the agents require of the shared engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedEnginePrivacy {
    /// Whether the shared engine must stay local.
    pub required: bool,
    /// The agents that pin it.
    pub agents: Vec<String>,
    /// The roles whose endpoints are not local, sorted.
    pub blocked: Vec<String>,
}

/// `sharedEnginePrivacy`: policy only, no engine internals, network probes or provider preference.
pub fn shared_engine_privacy(
    cfg: &Value,
    running_engine: Option<&Map<String, Value>>,
) -> SharedEnginePrivacy {
    let agents = local_only_agents(cfg);
    let required = local_only_shared(cfg);
    let listed = local_endpoints(cfg);
    let engine = object(cfg.get("engine")).cloned().unwrap_or_default();
    let mut blocked: Vec<String> = if required {
        engine_model_endpoints(running_engine.unwrap_or(&engine))
            .into_iter()
            .filter(|e| {
                e.endpoint
                    .as_deref()
                    .is_none_or(|url| !is_local_endpoint(url, &listed))
            })
            .map(|e| e.role)
            .collect()
    } else {
        Vec::new()
    };
    blocked.sort();
    SharedEnginePrivacy {
        required,
        agents,
        blocked,
    }
}

/// `assertSharedEnginePrivacy`: `E_DENIED` when a required-local shared engine would call a non-local endpoint.
pub fn assert_shared_engine_privacy(
    cfg: &Value,
    running_engine: Option<&Map<String, Value>>,
) -> Result<(), PolicyError> {
    let policy = shared_engine_privacy(cfg, running_engine);
    if policy.blocked.is_empty() {
        return Ok(());
    }
    let source = if policy.agents.is_empty() {
        "privacy.localOnly".to_owned()
    } else {
        format!("agents {}", policy.agents.join(", "))
    };
    Err(PolicyError::new(
        "E_DENIED",
        format!(
            "Shared engine {} must use local endpoints because of {source}; {LOCAL_ONLY_HINT}",
            policy.blocked.join(", ")
        ),
        Some(if policy.agents.is_empty() {
            "local-only"
        } else {
            "local-only-shared-engine"
        }),
    ))
}

/// What a privacy acknowledgment is checked against (`PrivacyChoice`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrivacyFunction {
    /// Memory text sent to an embedding or reranking provider.
    Text,
    /// A media index provider.
    Media,
    /// A captioning provider.
    Caption,
}

/// One provider choice to check (`PrivacyChoice`).
#[derive(Debug, Clone)]
pub struct PrivacyChoice<'a> {
    /// The function the provider serves.
    pub function: PrivacyFunction,
    /// The provider id.
    pub provider: &'a str,
    /// Whether the provider runs on this machine.
    pub local: bool,
    /// Whether the privacy pin applies.
    pub pinned: bool,
    /// The exact endpoint the admitted provider uses, when it is configurable.
    pub endpoint: Option<&'a str>,
    /// The recorded acknowledgment (`undefined`, `null` and other falsy values count as none).
    pub ack: Option<&'a Value>,
}

/// A refused privacy choice (`PrivacyAcknowledgmentFailure`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrivacyFailure {
    /// `E_DENIED` for text, `E_MEDIA_PRIVACY` otherwise.
    pub code: &'static str,
    /// `privacy-pin`, `privacy-acknowledgment-required`, `-invalid` or `-mismatch`.
    pub reason: &'static str,
}

fn falsy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => true,
        Value::String(s) => s.is_empty(),
        Value::Number(n) => n.as_f64() == Some(0.0),
        _ => false,
    }
}

/// `privacyAcknowledgmentError`: `None` when the choice is admitted.
pub fn privacy_acknowledgment_error(choice: &PrivacyChoice<'_>) -> Option<PrivacyFailure> {
    if choice.local {
        return None;
    }
    let code = if choice.function == PrivacyFunction::Text {
        "E_DENIED"
    } else {
        "E_MEDIA_PRIVACY"
    };
    if choice.pinned {
        return Some(PrivacyFailure {
            code,
            reason: "privacy-pin",
        });
    }
    let fail = |reason| Some(PrivacyFailure { code, reason });
    let Some(ack) = choice.ack.filter(|a| !falsy(a)) else {
        return fail("privacy-acknowledgment-required");
    };
    let by_ok = ack
        .get("by")
        .and_then(Value::as_str)
        .is_some_and(|by| !js_trim(by).is_empty());
    let at_ok = ack
        .get("acknowledgedAt")
        .and_then(Value::as_str)
        .is_some_and(|at| {
            let b = at.as_bytes();
            b.len() >= 11
                && b[..4].iter().all(u8::is_ascii_digit)
                && b[4] == b'-'
                && b[5..7].iter().all(u8::is_ascii_digit)
                && b[7] == b'-'
                && b[8..10].iter().all(u8::is_ascii_digit)
                && b[10] == b'T'
                && crate::logs::query::date_parse(at).is_some()
        });
    if !by_ok || !at_ok {
        return fail("privacy-acknowledgment-invalid");
    }
    let endpoint = match ack.get("endpoint") {
        None | Some(Value::Null) => None,
        Some(other) => Some(other),
    };
    let wanted = choice.endpoint.map(|e| Value::String(e.to_owned()));
    if ack.get("provider") != Some(&Value::String(choice.provider.to_owned()))
        || endpoint != wanted.as_ref()
    {
        return fail("privacy-acknowledgment-mismatch");
    }
    None
}

/// The policy a provider choice is made under (`ProviderPolicy`).
#[derive(Debug, Clone, Default)]
pub struct ProviderPolicy {
    /// `privacy.localOnly` for the shared engine.
    pub local_only: bool,
    /// `privacy.localEndpoints`.
    pub local_endpoints: Vec<String>,
}

impl ProviderPolicy {
    /// The shared-engine policy of a configuration (`providerPolicy` of `engine-config.ts`).
    pub fn of(cfg: &Value) -> Self {
        Self {
            local_only: local_only_shared(cfg),
            local_endpoints: local_endpoints(cfg),
        }
    }
}

/// Which embedding or reranker provider the engine is built with.
#[derive(Debug, Clone, PartialEq)]
pub enum ProviderPlan {
    /// The pinned local model.
    Local,
    /// A remote provider, with the block the engine gets.
    Remote(Map<String, Value>),
}

fn incomplete(role: &str, message: &str, reason: &str) -> PolicyError {
    PolicyError::new(
        "E_INVALID_PARAMS",
        format!("{role}: {message}"),
        Some(reason),
    )
}

const INCOMPLETE: &str = "engine-provider-config-incomplete";

fn ident(text: &str, max: usize, extra: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && text.chars().count() <= max
        && chars.all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
}

fn env_name(text: &str) -> bool {
    let mut chars = text.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && text.chars().count() <= 128
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn common<'a>(
    v: &'a Map<String, Value>,
    role: &str,
    key_required: bool,
) -> Result<&'a str, PolicyError> {
    let Some(provider) = v
        .get("provider")
        .and_then(Value::as_str)
        .filter(|p| ident(p, 64, "._-"))
    else {
        return Err(incomplete(
            role,
            "provider must be a provider id (letters, digits, '.', '_', '-')",
            "engine-provider-invalid",
        ));
    };
    if v.contains_key("apiKey") {
        return Err(incomplete(role, "apiKey is refused: a key never stands in the configuration; set apiKeyRef to its harness secret name or apiKeyEnv to its environment variable", "secret-in-config"));
    }
    if let Some(reference) = v.get("apiKeyRef") {
        if !reference.as_str().is_some_and(|r| ident(r, 128, "._:/@-")) {
            return Err(incomplete(
                role,
                "apiKeyRef must be a valid harness secret name (1–128 characters)",
                INCOMPLETE,
            ));
        }
    }
    if let Some(name) = v.get("apiKeyEnv") {
        if !name.as_str().is_some_and(env_name) {
            return Err(incomplete(
                role,
                "apiKeyEnv must be an environment variable name",
                INCOMPLETE,
            ));
        }
    }
    if key_required && !v.contains_key("apiKeyRef") && !v.contains_key("apiKeyEnv") {
        return Err(incomplete(
            role,
            &format!("provider {provider} needs apiKeyRef (harness secret name) or apiKeyEnv (environment variable name)"),
            INCOMPLETE,
        ));
    }
    if v.contains_key("baseURL") {
        return Err(incomplete(
            role,
            "use baseUrl; the engine ignores baseURL and would call its default endpoint instead",
            INCOMPLETE,
        ));
    }
    Ok(provider)
}

fn endpoint(raw: &Value, role: &str) -> Result<Url, PolicyError> {
    let Some(url) = raw.as_str().and_then(Url::parse).filter(Url::is_http) else {
        return Err(incomplete(
            role,
            "baseUrl must be an http(s) URL",
            INCOMPLETE,
        ));
    };
    if !url.username.is_empty() || !url.password.is_empty() {
        return Err(incomplete(
            role,
            "baseUrl must not carry credentials; set apiKeyEnv instead",
            "secret-in-config",
        ));
    }
    Ok(url)
}

fn without_local(v: &Map<String, Value>) -> Map<String, Value> {
    v.iter()
        .filter(|(k, _)| k.as_str() != "local")
        .map(|(k, x)| (k.clone(), x.clone()))
        .collect()
}

fn privacy_refusal(
    failure: &PrivacyFailure,
    role: &str,
    provider: &str,
    what: &str,
    field: &str,
) -> PolicyError {
    let tail = if failure.reason == "privacy-acknowledgment-required" {
        format!("record {field} for it")
    } else {
        format!("{field} does not admit it ({})", failure.reason)
    };
    PolicyError::new(
        failure.code,
        format!("{role}: provider {provider} sends {what} off this machine; {tail}"),
        Some(failure.reason),
    )
}

/// `resolveEmbeddingProvider`.
pub fn resolve_embedding_provider(
    v: &Map<String, Value>,
    privacy_ack: Option<&Value>,
    policy: &ProviderPolicy,
) -> Result<ProviderPlan, PolicyError> {
    if is_local_provider(v.get("provider")) {
        return Ok(ProviderPlan::Local);
    }
    let role = "embedding";
    let provider = common(v, role, true)?;
    if v.get("fallback").is_some_and(|f| !f.is_null()) {
        return Err(incomplete(role, "fallback is refused: another model would silently write a different vector space; change models through reembed", "embedding-fallback-refused"));
    }
    let model = v.get("model").and_then(Value::as_str);
    if model.is_none_or(|m| js_trim(m).is_empty()) {
        return Err(incomplete(
            role,
            &format!("provider {provider} needs model"),
            INCOMPLETE,
        ));
    }
    let positive_integer = v
        .get("dimensions")
        .and_then(Value::as_f64)
        .is_some_and(|d| d.is_finite() && d.fract() == 0.0 && d > 0.0);
    if !positive_integer {
        return Err(incomplete(
            role,
            &format!(
                "provider {provider} needs dimensions (a positive integer, the vector size of {})",
                model.unwrap_or_default()
            ),
            INCOMPLETE,
        ));
    }
    if !v.contains_key("baseUrl") && provider != "openai" {
        return Err(incomplete(
            role,
            &format!("provider {provider} needs baseUrl, its OpenAI-compatible endpoint"),
            INCOMPLETE,
        ));
    }
    let url = v.get("baseUrl").map(|b| endpoint(b, role)).transpose()?;
    let raw = v.get("baseUrl").and_then(Value::as_str);
    assert_local_endpoint(
        policy.local_only,
        &format!("{role} provider {provider}"),
        Some(raw.unwrap_or(OPENAI_DEFAULT_ENDPOINT)),
        &policy.local_endpoints,
    )?;
    let failure = privacy_acknowledgment_error(&PrivacyChoice {
        function: PrivacyFunction::Text,
        provider,
        local: url.as_ref().is_some_and(is_loopback_url),
        pinned: false,
        endpoint: raw,
        ack: privacy_ack,
    });
    if let Some(failure) = failure {
        return Err(privacy_refusal(
            &failure,
            role,
            provider,
            "memory text",
            "memory.embedding.privacyAck",
        ));
    }
    let mut block = without_local(v);
    block.insert("provider".into(), Value::String(provider.to_owned()));
    Ok(ProviderPlan::Remote(block))
}

/// `resolveRerankerProvider`.
pub fn resolve_reranker_provider(
    v: &Map<String, Value>,
    privacy_ack: Option<&Value>,
    policy: &ProviderPolicy,
) -> Result<ProviderPlan, PolicyError> {
    if is_local_provider(v.get("provider")) {
        return Ok(ProviderPlan::Local);
    }
    let role = "reranker";
    if let Some(p) = v.get("provider").and_then(Value::as_str) {
        if ident(p, 64, "._-") && !["cohere", "jina", "voyage", "remote"].contains(&p) {
            return Err(PolicyError::new(
                "E_NOT_AVAILABLE",
                format!("{role}: provider {p} has no engine adapter; use cohere, jina, voyage or remote with an explicit protocol"),
                Some("engine-adapter-factory-unavailable"),
            ));
        }
    }
    let provider = common(
        v,
        role,
        v.get("provider").and_then(Value::as_str) != Some("remote"),
    )?;
    if !v.contains_key("baseUrl") && provider == "remote" {
        return Err(incomplete(role, "remote needs baseUrl", INCOMPLETE));
    }
    let url = v.get("baseUrl").map(|b| endpoint(b, role)).transpose()?;
    if let Some(protocol) = v.get("protocol") {
        if !protocol
            .as_str()
            .is_some_and(|p| ["cohere", "jina", "voyage", "tei"].contains(&p))
        {
            return Err(incomplete(
                role,
                "protocol must be cohere, jina, voyage or tei",
                INCOMPLETE,
            ));
        }
    }
    if v.get("fallbackProvider")
        .is_some_and(|f| f.as_str() != Some("disabled"))
    {
        return Err(incomplete(
            role,
            "fallbackProvider is refused: no silent switch to another reranker model",
            "reranker-fallback-refused",
        ));
    }
    if v.get("model")
        .is_some_and(|m| m.as_str().is_none_or(|m| js_trim(m).is_empty()))
    {
        return Err(incomplete(
            role,
            "model must be a non-empty string",
            INCOMPLETE,
        ));
    }
    let raw = v.get("baseUrl").and_then(Value::as_str);
    assert_local_endpoint(
        policy.local_only,
        &format!("{role} provider {provider}"),
        raw.or_else(|| rerank_endpoint(provider)),
        &policy.local_endpoints,
    )?;
    // Presets bind the provider alone; a custom endpoint must be acknowledged explicitly.
    let failure = privacy_acknowledgment_error(&PrivacyChoice {
        function: PrivacyFunction::Text,
        provider,
        local: url.as_ref().is_some_and(is_loopback_url),
        pinned: false,
        endpoint: raw,
        ack: privacy_ack,
    });
    if let Some(failure) = failure {
        return Err(privacy_refusal(
            &failure,
            role,
            provider,
            "recalled memory text",
            "memory.reranker.privacyAck",
        ));
    }
    let mut block = without_local(v);
    block.insert("provider".into(), Value::String(provider.to_owned()));
    block.insert("enabled".into(), Value::Bool(true));
    block.insert("fallbackProvider".into(), Value::String("disabled".into()));
    Ok(ProviderPlan::Remote(block))
}

/// `assertEngineFeaturesLocal`: `privacy.localOnly` for the engine's own LLM features.
pub fn assert_engine_features_local(
    engine_config: &Map<String, Value>,
    policy: &ProviderPolicy,
) -> Result<(), PolicyError> {
    if !policy.local_only {
        return Ok(());
    }
    for e in engine_model_endpoints(engine_config) {
        if e.role == "embedding" || e.role == "reranker" {
            continue;
        }
        assert_local_endpoint(
            true,
            &format!("engine LLM feature {}", e.role),
            e.endpoint.as_deref(),
            &policy.local_endpoints,
        )?;
    }
    Ok(())
}
