//! D124 pure team decisions. The transport authenticates Core before entering this module.
mod action;
mod check;
mod diffcheck;
pub mod glob;
mod impact;
mod lead;
mod next;
mod state;
mod workflow;
use crate::{CoreContext, ToolError, ToolsModule};
use plur1bus_rpc::types::{
    ErrorCode, ToolsTeamCheckParams, ToolsTeamCheckResult, ToolsTeamDiffcheckParams,
    ToolsTeamDiffcheckResult, ToolsTeamImpactParams, ToolsTeamImpactResult, ToolsTeamNextParams,
    ToolsTeamNextResult,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::OnceLock};

/// Native module, with no handles, secrets, environment or execution hooks.
pub struct TeamModule;
impl ToolsModule for TeamModule {
    fn call(
        &self,
        method: &str,
        params: &Value,
        _core: &CoreContext,
    ) -> Option<Result<Value, ToolError>> {
        method
            .starts_with("tools.team.")
            .then(|| dispatch(method, params))
    }
}
pub(crate) fn invalid() -> ToolError {
    ToolError {
        code: ErrorCode::EInvalidParams,
        reason: "team-facts-invalid",
    }
}
fn schema(name: &str) -> Result<&'static jsonschema::Validator, ToolError> {
    static SCHEMAS: OnceLock<Result<BTreeMap<String, jsonschema::Validator>, ToolError>> =
        OnceLock::new();
    let schemas = SCHEMAS.get_or_init(|| {
        let source: Value = serde_json::from_str(plur1bus_rpc::SCHEMA_JSON).map_err(|_| invalid())?;
        let methods = source["$defs"]["methods"].as_object().ok_or_else(invalid)?;
        let mut validators = BTreeMap::new();
        for n in methods.keys().filter(|n| n.starts_with("tools.team.")) {
            for part in ["params", "result"] {
                let key = format!("{n}/{part}");
                let schema = json!({"$schema":"https://json-schema.org/draft/2020-12/schema", "$defs":source["$defs"], "$ref":format!("#/$defs/methods/{key}")});
                validators.insert(key, jsonschema::validator_for(&schema).map_err(|_| invalid())?);
            }
        }
        Ok(validators)
    }).as_ref().map_err(Clone::clone)?;
    schemas.get(name).ok_or_else(invalid)
}
fn invoke<P: DeserializeOwned + Serialize, R: DeserializeOwned + Serialize>(
    method: &str,
    input: &Value,
    f: fn(&Value) -> Result<Value, ToolError>,
) -> Result<Value, ToolError> {
    if !schema(&format!("{method}/params"))?.is_valid(input) {
        return Err(invalid());
    }
    let _typed: P = serde_json::from_value(input.clone()).map_err(|_| invalid())?;
    let result = f(input)?;
    if !schema(&format!("{method}/result"))?.is_valid(&result) {
        return Err(invalid());
    }
    let result: R = serde_json::from_value(result).map_err(|_| invalid())?;
    serde_json::to_value(result).map_err(|_| invalid())
}
/// Pure entry point for shared-fixture tests. Production reaches it only through the Core guard.
pub fn dispatch(method: &str, input: &Value) -> Result<Value, ToolError> {
    match method {
        "tools.team.next" => {
            invoke::<ToolsTeamNextParams, ToolsTeamNextResult>(method, input, next::next)
        }
        "tools.team.check" => {
            invoke::<ToolsTeamCheckParams, ToolsTeamCheckResult>(method, input, check::check)
        }
        "tools.team.diffcheck" => invoke::<ToolsTeamDiffcheckParams, ToolsTeamDiffcheckResult>(
            method,
            input,
            diffcheck::check,
        ),
        "tools.team.impact" => {
            invoke::<ToolsTeamImpactParams, ToolsTeamImpactResult>(method, input, impact::check)
        }
        _ => Err(invalid()),
    }
}
pub(crate) fn list<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v[k].as_array().map_or(&[], Vec::as_slice)
}
pub(crate) fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
pub(crate) fn num(v: &Value, k: &str) -> u64 {
    v[k].as_u64().unwrap_or(0)
}
/// SHA-256 of recursively key-sorted JSON; shared fixtures pin parity with the TypeScript store.
pub fn hash(v: &Value) -> String {
    fn canonical(v: &Value) -> Value {
        match v {
            Value::Object(m) => Value::Object(
                m.iter()
                    .map(|(k, v)| (k.clone(), canonical(v)))
                    .collect::<BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            Value::Array(a) => Value::Array(a.iter().map(canonical).collect()),
            other => other.clone(),
        }
    }
    format!("{:x}", Sha256::digest(canonical(v).to_string().as_bytes()))
}
