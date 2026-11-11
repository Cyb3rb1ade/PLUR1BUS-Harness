//! The server half of the RPC contract for Rust servers (feature `server`; Phase 4, P4-03).
//!
//! `build.rs` generates from the schema one trait per `x-server` value ([`CoreMethods`], [`EngineMethods`],
//! [`SupervisorMethods`], [`ModuleMethods`], [`ToolsMethods`]) with one method per RPC method, typed with the same
//! `types::<Method>Params` and `types::<Method>Result` the client uses, and one dispatcher per trait (`dispatch_core`, …).
//! A server cannot serve a method the schema does not declare for it, nor return a type the schema does not declare.
//!
//! Every trait method has a default body that returns [`MethodError::NotServed`]: the Rust core implements the methods it
//! serves natively and the front door relays every other one to the legacy core (P4-10).
//!
//! The dispatcher keeps the order of module-api's `RpcServer`: an unknown method first, then the params against the
//! schema (with `_meta` removed, D111), then the call, then the result against the schema (ADR-012 §2: a result that
//! violates it never leaves; `E_INTERNAL` with reason `result-schema`). Error codes and `reason` strings are contract;
//! the wording of a finding is not (ADR-016, controller ruling P4-03): `jsonschema` words them differently from ajv.
//!
//! [`Validators`] are compiled from pruned roots: each method's params or result plus only the `$defs` it reaches. The
//! P4-01 spike measured 4.3 s for all 854 validators against the full 569 KB schema and 26 ms pruned.
use crate::types::ErrorCode;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::Future;
use std::sync::OnceLock;

mod generated {
    // The generated traits return `impl Future + Send` on purpose (an `async fn` cannot promise `Send`).
    #![allow(clippy::manual_async_fn, clippy::too_many_lines)]
    use super::{call, DispatchError, MethodError, Validators};
    include!(concat!(env!("OUT_DIR"), "/server.rs"));
}
pub use generated::*;

/// What a method implementation returns instead of a result.
#[derive(Debug)]
pub enum MethodError {
    /// This implementation does not serve the method natively; the default of every generated trait method. The front
    /// door relays such a call to the legacy core (P4-10).
    NotServed,
    /// A refusal for the caller (boxed: it is the rare path, and keeps `Result<_, MethodError>` small).
    Rpc(Box<RpcFailure>),
}

impl MethodError {
    /// A refusal with `error.data.error = code` and the free-text `message`.
    pub fn rpc(code: ErrorCode, message: impl Into<String>) -> Self {
        Self::Rpc(Box::new(RpcFailure {
            error: code,
            message: message.into(),
            reason: None,
            detail: None,
            ids: None,
            ext: None,
        }))
    }

    /// Adds `error.data.reason` (a contract string) to a refusal.
    pub fn with_reason(self, reason: impl Into<String>) -> Self {
        match self {
            Self::Rpc(mut failure) => {
                failure.reason = Some(reason.into());
                Self::Rpc(failure)
            }
            other => other,
        }
    }
}

/// An RPC error as the schema's `ErrorObject.data` carries it, plus the message.
#[derive(Debug, Clone)]
pub struct RpcFailure {
    /// `error.data.error`, from the closed set.
    pub error: ErrorCode,
    /// `error.message`: free text, not contract.
    pub message: String,
    /// `error.data.reason`: a contract string.
    pub reason: Option<String>,
    /// `error.data.detail`: free text.
    pub detail: Option<String>,
    /// `error.data.ids`: non-secret ids a caller needs to recover.
    pub ids: Option<BTreeMap<String, String>>,
    /// `error.data.ext`: what an `ext.*` refusal shows.
    pub ext: Option<Value>,
}

/// Why a dispatch produced no result. The comments name the reply module-api's `RpcServer` sends for the same case.
#[derive(Debug)]
pub enum DispatchError {
    /// The schema declares no such method for this server: `E_INTERNAL` "method not found: <m>", reason
    /// `method-not-found`, JSON-RPC -32601.
    UnknownMethod,
    /// The implementation does not serve the method natively (the params were valid): relay it (P4-10).
    NotServed,
    /// The params do not satisfy the schema: `E_INVALID_PARAMS` "invalid params", `detail` = these findings joined with
    /// `"; "` (`<instance path or /> <message>`; the wording is not contract).
    InvalidParams(Vec<String>),
    /// The params satisfy the schema but do not decode into the generated type: a gap between the schema and the
    /// generated types, never the caller's fault. Report it as `E_INTERNAL`.
    ParamsDecode(String),
    /// The method refused the call.
    Method(Box<RpcFailure>),
    /// The result could not be serialised (a generated-type bug): `E_INTERNAL`.
    ResultEncode(String),
    /// The result does not satisfy the schema: `E_INTERNAL` "result violates schema", reason `result-schema`
    /// (ADR-012 §2). The findings are for the log, never for the caller.
    ResultSchema(Vec<String>),
}

impl From<MethodError> for DispatchError {
    fn from(error: MethodError) -> Self {
        match error {
            MethodError::NotServed => Self::NotServed,
            MethodError::Rpc(failure) => Self::Method(failure),
        }
    }
}

/// One call through a generated dispatcher: params checked and decoded, the method called, the result encoded and checked.
async fn call<P, R, F, Fut>(
    validators: &Validators,
    method: &str,
    params: Value,
    f: F,
) -> Result<Value, DispatchError>
where
    P: DeserializeOwned,
    R: Serialize,
    F: FnOnce(P) -> Fut,
    Fut: Future<Output = Result<R, MethodError>>,
{
    let params = validators.check_params(method, params)?;
    let typed: P =
        serde_json::from_value(params).map_err(|e| DispatchError::ParamsDecode(e.to_string()))?;
    let result = f(typed).await?;
    let value =
        serde_json::to_value(&result).map_err(|e| DispatchError::ResultEncode(e.to_string()))?;
    validators.check_result(method, &value)?;
    Ok(value)
}

/// The RPC schema, parsed once.
pub fn schema() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| serde_json::from_str(crate::SCHEMA_JSON).unwrap_or(Value::Null))
}

/// The `x-server` of a method or notification definition (`core` when absent, as `capabilities()` reads it).
pub fn server_of(definition: &Value) -> &str {
    definition["x-server"].as_str().unwrap_or("core")
}

/// A root schema for `node` that carries only the `$defs` `node` reaches (the transitive `$ref` closure), with the
/// schema's own `$schema` and `$id`, so every `#/$defs/<Name>` reference resolves as it does in the full document.
/// Every reference in the RPC schema has that form (checked by the tests), so a closure over top-level definitions is
/// complete.
pub fn pruned_root(schema: &Value, node: &Value) -> Value {
    let defs = schema["$defs"].as_object();
    let mut needed = BTreeSet::new();
    let mut pending = vec![node];
    while let Some(next) = pending.pop() {
        each_ref(next, &mut |name| {
            if let Some(def) = defs.and_then(|d| d.get(name)) {
                if needed.insert(name.to_owned()) {
                    pending.push(def);
                }
            }
        });
    }
    let mut root = match node {
        Value::Object(map) => map.clone(),
        other => {
            let mut map = Map::new();
            map.insert("allOf".into(), Value::Array(vec![other.clone()]));
            map
        }
    };
    for key in ["$schema", "$id"] {
        if let Some(v) = schema.get(key) {
            root.insert(key.into(), v.clone());
        }
    }
    let kept: Map<String, Value> = needed
        .into_iter()
        .filter_map(|name| Some((name.clone(), defs?.get(&name)?.clone())))
        .collect();
    root.insert("$defs".into(), Value::Object(kept));
    Value::Object(root)
}

/// Calls `f` with the definition name of every `#/$defs/<Name>` reference below `node`.
fn each_ref(node: &Value, f: &mut dyn FnMut(&str)) {
    match node {
        Value::Object(map) => {
            for (key, value) in map {
                match (key.as_str(), value) {
                    ("$ref", Value::String(reference)) => {
                        if let Some(name) = reference.strip_prefix("#/$defs/") {
                            f(name.split('/').next().unwrap_or(name));
                        }
                    }
                    _ => each_ref(value, f),
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|item| each_ref(item, f)),
        _ => {}
    }
}

/// Compiles `root` the way the TypeScript server's ajv does: draft 2020-12 with formats asserted (ajv-formats), using
/// ajv's rules for `date-time` (`plur1bus_config::ajv_date_time`) and `uuid`; `date` and `uri` use `jsonschema`'s own.
pub fn compile(root: &Value) -> Result<jsonschema::Validator, String> {
    jsonschema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .should_validate_formats(true)
        .with_format("date-time", plur1bus_config::ajv_date_time)
        .with_format("uuid", ajv_uuid)
        .build(root)
        .map_err(|e| e.to_string())
}

/// ajv-formats' `uuid`: `/^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i`.
fn ajv_uuid(value: &str) -> bool {
    let body = value
        .get(..9)
        .filter(|prefix| prefix.eq_ignore_ascii_case("urn:uuid:"))
        .map_or(value, |_| &value[9..]);
    let groups: Vec<&str> = body.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(group, len)| group.len() == len && group.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Every finding of `validator` on `value`, as module-api words its list: `<instance path, or / for the root> <message>`.
/// The message names the rule that failed from the schema's side only, in ajv's words, never the value it failed on
/// (P4-10 security review L2): `jsonschema`'s own `Display` quotes the instance, which can be a credential, and a finding
/// goes back to the caller as `detail`.
pub fn findings(validator: &jsonschema::Validator, value: &Value) -> Vec<String> {
    validator
        .iter_errors(value)
        .map(|error| {
            let path = error.instance_path.to_string();
            let path = if path.is_empty() {
                "/".to_owned()
            } else {
                path
            };
            format!("{path} {}", rule(&error.kind))
        })
        .collect()
}

/// ajv's message for a failed keyword, built from the schema's side of the error only.
fn rule(kind: &jsonschema::error::ValidationErrorKind) -> String {
    use jsonschema::error::{TypeKind, ValidationErrorKind as K};
    match kind {
        K::AdditionalItems { limit } => format!("must NOT have more than {limit} items"),
        K::AdditionalProperties { .. } => "must NOT have additional properties".to_owned(),
        K::AnyOf => "must match a schema in anyOf".to_owned(),
        K::Constant { .. } => "must be equal to constant".to_owned(),
        K::Contains => "must contain at least 1 valid item(s)".to_owned(),
        K::ContentEncoding { content_encoding } => {
            format!("must be encoded as \"{content_encoding}\"")
        }
        K::ContentMediaType { content_media_type } => {
            format!("must be of media type \"{content_media_type}\"")
        }
        K::Enum { .. } => "must be equal to one of the allowed values".to_owned(),
        K::ExclusiveMaximum { limit } => format!("must be < {limit}"),
        K::ExclusiveMinimum { limit } => format!("must be > {limit}"),
        K::FalseSchema => "boolean schema is false".to_owned(),
        K::Format { format } => format!("must match format \"{format}\""),
        K::MaxItems { limit } => format!("must NOT have more than {limit} items"),
        K::Maximum { limit } => format!("must be <= {limit}"),
        K::MaxLength { limit } => format!("must NOT have more than {limit} characters"),
        K::MaxProperties { limit } => format!("must NOT have more than {limit} properties"),
        K::MinItems { limit } => format!("must NOT have fewer than {limit} items"),
        K::Minimum { limit } => format!("must be >= {limit}"),
        K::MinLength { limit } => format!("must NOT have fewer than {limit} characters"),
        K::MinProperties { limit } => format!("must NOT have fewer than {limit} properties"),
        K::MultipleOf { multiple_of } => format!("must be multiple of {multiple_of}"),
        K::Not { .. } => "must NOT be valid".to_owned(),
        K::OneOfMultipleValid | K::OneOfNotValid => {
            "must match exactly one schema in oneOf".to_owned()
        }
        K::Pattern { pattern } => format!("must match pattern \"{pattern}\""),
        K::PropertyNames { .. } => "property name must be valid".to_owned(),
        // The missing property's name comes from the schema's `required`, not from the instance.
        K::Required { property } => format!(
            "must have required property '{}'",
            property.as_str().unwrap_or_default()
        ),
        K::Type { kind } => {
            let types: Vec<String> = match kind {
                TypeKind::Single(t) => vec![t.to_string()],
                TypeKind::Multiple(set) => set.into_iter().map(|t| t.to_string()).collect(),
            };
            format!("must be {}", types.join(","))
        }
        K::UnevaluatedItems { .. } => "must NOT have unevaluated items".to_owned(),
        K::UnevaluatedProperties { .. } => "must NOT have unevaluated properties".to_owned(),
        K::UniqueItems => "must NOT have duplicate items".to_owned(),
        K::BacktrackLimitExceeded { .. }
        | K::Custom { .. }
        | K::FromUtf8 { .. }
        | K::Referencing(_) => "is invalid".to_owned(),
    }
}

/// The params and result validators of every method of one `x-server`, compiled from pruned roots.
pub struct Validators {
    server: String,
    params: HashMap<String, jsonschema::Validator>,
    results: HashMap<String, jsonschema::Validator>,
}

impl Validators {
    /// Compiles the validators of every method whose `x-server` is `server`. An error is a schema bug: fail the start.
    pub fn for_server(server: &str) -> Result<Self, String> {
        let schema = schema();
        let methods = schema["$defs"]["methods"]
            .as_object()
            .ok_or("rpc.schema.json has no $defs/methods")?;
        let mut params = HashMap::new();
        let mut results = HashMap::new();
        for (name, definition) in methods.iter().filter(|(_, d)| server_of(d) == server) {
            let built = |part: &str| {
                compile(&pruned_root(schema, &definition[part]))
                    .map_err(|e| format!("{name} {part}: {e}"))
            };
            params.insert(name.clone(), built("params")?);
            results.insert(name.clone(), built("result")?);
        }
        Ok(Self {
            server: server.to_owned(),
            params,
            results,
        })
    }

    /// The `x-server` these validators belong to.
    pub fn server(&self) -> &str {
        &self.server
    }

    /// Removes `_meta` (D111: every params object may carry `_meta.traceparent`; it is not a method field; read it before
    /// dispatching) and checks the rest against the method's params schema. Returns the params without `_meta`.
    pub fn check_params(&self, method: &str, params: Value) -> Result<Value, DispatchError> {
        let validator = self
            .params
            .get(method)
            .ok_or(DispatchError::UnknownMethod)?;
        let params = match params {
            Value::Object(mut map) => {
                map.remove("_meta");
                Value::Object(map)
            }
            other => other,
        };
        let found = findings(validator, &params);
        if found.is_empty() {
            Ok(params)
        } else {
            Err(DispatchError::InvalidParams(found))
        }
    }

    /// Checks a result against the method's result schema.
    pub fn check_result(&self, method: &str, result: &Value) -> Result<(), DispatchError> {
        let validator = self
            .results
            .get(method)
            .ok_or(DispatchError::UnknownMethod)?;
        let found = findings(validator, result);
        if found.is_empty() {
            Ok(())
        } else {
            Err(DispatchError::ResultSchema(found))
        }
    }
}
