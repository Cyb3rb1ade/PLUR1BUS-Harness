//! Read-only C2 planning over host-supplied inventory, free space and provider probes.
use super::{
    confirmation::{self, Confirmation},
    state_json::{get_text, id_valid, integer, normalize, number, put, string, MAX_SAFE},
};
use crate::{
    contract::Cancel,
    ops::import_primitives::field,
    text::json::{parse_json, write_json, TolerantJsonValue as Json},
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fmt};
/// Bounded planner failures. Backend errors never carry provider bodies or paths.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanError {
    /// A fixed validation category, never a caller-supplied message.
    Invalid(&'static str),
    /// A host dependency could not complete its read/probe.
    Dependency,
    /// Caller cancellation or deadline.
    Cancelled,
    /// OS entropy was unavailable.
    Entropy,
}
impl fmt::Display for PlanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Invalid(c) => c,
            Self::Dependency => "planner dependency unavailable",
            Self::Cancelled => "cancelled",
            Self::Entropy => "entropy unavailable",
        })
    }
}
impl std::error::Error for PlanError {}
/// Read-only host boundary. Implementations must propagate cancellation and must not prepare
/// local model artifacts, create generations, or change active configuration while planning.
pub trait PlanSource: Send + Sync {
    /// Actual active generations, including table versions/counts and the source fingerprint.
    fn inventory_active_generation(&self, cancel: &Cancel) -> Result<Vec<Json>, PlanError>;
    /// Available bytes on the actual target generation filesystem.
    fn free_bytes(&self, cancel: &Cancel) -> Result<u64, PlanError>;
    /// Whether immutable local target artifacts are present AND verified; no downloads.
    fn target_artifacts_verified(
        &self,
        fingerprint: &Json,
        cancel: &Cancel,
    ) -> Result<bool, PlanError>;
    /// One target embedding probe. Secret references are resolved only inside the host provider.
    fn probe_target(&self, target: &Json, cancel: &Cancel) -> Result<Vec<f64>, PlanError>;
}
/// Hash-bound plan plus its separately exposed operator proof. No blanket serialization or Debug.
pub struct ReembeddingPlan {
    plan: Json,
    digest: String,
    confirmation: Confirmation,
}
impl ReembeddingPlan {
    /// Immutable plan body; its exact object order is part of the digest.
    pub fn plan(&self) -> &Json {
        &self.plan
    }
    /// SHA-256 over Node-compatible compact plan bytes.
    pub fn digest(&self) -> &str {
        &self.digest
    }
    /// Proof exposure and hash-only persistence are explicit operations on Confirmation.
    pub fn confirmation(&self) -> &Confirmation {
        &self.confirmation
    }
}
impl fmt::Debug for ReembeddingPlan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ReembeddingPlan([redacted])")
    }
}
fn invalid(category: &'static str) -> PlanError {
    PlanError::Invalid(category)
}
fn check(cancel: &Cancel) -> Result<(), PlanError> {
    cancel.check().map_err(|_| PlanError::Cancelled)
}
fn obj(entries: Vec<(&str, Json)>) -> Json {
    Json::Object(entries.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn array(value: &Json) -> Result<&[Json], PlanError> {
    match value {
        Json::Array(v) => Ok(v),
        _ => Err(invalid("invalid source table inventory")),
    }
}
fn object(value: &Json) -> Result<&[(crate::text::js::JsString, Json)], PlanError> {
    match value {
        Json::Object(v) => Ok(v),
        _ => Err(invalid("invalid reembedding object")),
    }
}
fn required<'a>(value: &'a Json, key: &str) -> Result<&'a Json, PlanError> {
    field(value, key).ok_or(invalid("missing reembedding field"))
}
fn identifier(
    value: &Json,
    key: &str,
    max: usize,
    category: &'static str,
) -> Result<String, PlanError> {
    get_text(value, key)
        .filter(|s| id_valid(s) && s.len() <= max)
        .ok_or(invalid(category))
}
fn selection(raw: Option<&Json>, generation: &str) -> Result<Json, PlanError> {
    let default = || {
        obj(vec![
            ("mode", string("generation")),
            ("generation", string(generation)),
        ])
    };
    let Some(raw) = raw.filter(|v| !matches!(v, Json::Null)) else {
        return Ok(default());
    };
    let entries = object(raw)?;
    match get_text(raw, "mode").as_deref() {
        Some("legacy") if entries.len() == 1 => Ok(obj(vec![("mode", string("legacy"))])),
        Some("generation")
            if entries.len() == 2 && get_text(raw, "generation").as_deref() == Some(generation) =>
        {
            Ok(default())
        }
        _ => Err(invalid("invalid reembedding generation selection")),
    }
}
fn secret_ref(value: &Json) -> Result<Json, PlanError> {
    let e = object(value)?;
    let source = get_text(value, "source").ok_or(invalid("invalid target SecretRef source"))?;
    if e.len() != 3 || !["env", "store", "file", "exec"].contains(&source.as_str()) {
        return Err(invalid("invalid target SecretRef source"));
    }
    let provider = get_text(value, "provider")
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.as_bytes()[0].is_ascii_lowercase()
                && s.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-')
                })
        })
        .ok_or(invalid("invalid target SecretRef provider"))?;
    let id = required(value, "id")?;
    let Json::String(s) = id else {
        return Err(invalid("invalid target SecretRef id"));
    };
    if s.is_empty() || s.utf16_len() > 256 {
        return Err(invalid("invalid target SecretRef id"));
    }
    Ok(obj(vec![
        ("source", string(&source)),
        ("provider", string(&provider)),
        ("id", id.clone()),
    ]))
}
fn fingerprint(value: &Json) -> Result<(String, Json, String), PlanError> {
    let serde: serde_json::Value = serde_json::from_str(&write_json(value))
        .map_err(|_| invalid("invalid embedding fingerprint"))?;
    let id = crate::embedding::fingerprint::fingerprint_record_id(&serde)
        .map_err(|_| invalid("invalid embedding fingerprint"))?;
    let identity = crate::embedding::identity::identity_from_value(&serde)
        .map_err(|_| invalid("invalid embedding identity"))?;
    let (_, raw, identity_id) = crate::store::identity::canonical_identity(&identity)
        .map_err(|_| invalid("invalid embedding identity"))?;
    Ok((
        id,
        parse_json(&raw).map_err(|_| invalid("invalid embedding identity"))?,
        identity_id,
    ))
}
fn tables(raw: &Json, dimensions: &Json) -> Result<Vec<Json>, PlanError> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for table in array(raw)? {
        object(table)?;
        let id = get_text(table, "tableId")
            .filter(|s| s.len() <= 512 && s.split('/').all(id_valid))
            .ok_or(invalid("invalid reembedding table id"))?;
        let version = get_text(table, "version")
            .filter(|s| !s.is_empty())
            .ok_or(invalid("source table version is required"))?;
        let rows = field(table, "rowCount")
            .and_then(integer)
            .ok_or(invalid("invalid source table row count"))?;
        let bytes = field(table, "estimatedBytes")
            .and_then(integer)
            .ok_or(invalid("invalid source table byte estimate"))?;
        if field(table, "dimensions").is_some_and(|v| v != dimensions) {
            return Err(invalid("source table dimension mismatch"));
        }
        if !seen.insert(id.clone()) {
            return Err(invalid("duplicate source table inventory"));
        }
        out.push(obj(vec![
            ("tableId", string(&id)),
            ("version", string(&version)),
            ("rowCount", number(rows)),
            ("estimatedBytes", number(bytes)),
        ]));
    }
    Ok(out)
}
fn num(n: f64) -> Result<Json, PlanError> {
    if !n.is_finite() {
        return Err(invalid("invalid reembedding estimate"));
    }
    Ok(Json::Number(ryu_js::Buffer::new().format(n).to_owned()))
}
fn build(
    request: &Json,
    source: &dyn PlanSource,
    now: f64,
    cancel: &Cancel,
) -> Result<(Json, String, u64), PlanError> {
    check(cancel)?;
    let request = normalize(request, 0).map_err(|_| invalid("invalid reembedding request"))?;
    let id = identifier(&request, "id", 64, "invalid reembedding migration id")?;
    let target_generation = match field(&request, "targetGeneration") {
        None | Some(Json::Null) | Some(Json::Bool(false)) => default_generation(&id),
        Some(Json::String(s)) if s.is_empty() => default_generation(&id),
        Some(Json::Number(n)) if n == "0" => default_generation(&id),
        _ => identifier(
            &request,
            "targetGeneration",
            64,
            "invalid reembedding target generation",
        )?,
    };
    let target = required(&request, "target")?;
    let target_fingerprint =
        field(target, "fingerprint").ok_or(invalid("target embedding fingerprint is required"))?;
    if !now.is_finite() || now.fract() != 0. || !(0. ..=MAX_SAFE as f64).contains(&now) {
        return Err(invalid("invalid reembedding planner clock"));
    }
    let generations = source.inventory_active_generation(cancel)?;
    check(cancel)?;
    if generations.len() != 1 {
        return Err(invalid(
            "reembedding requires exactly one active generation",
        ));
    }
    let active = normalize(&generations[0], 0)
        .map_err(|_| invalid("invalid active generation inventory"))?;
    let source_generation = identifier(
        &active,
        "generation",
        128,
        "invalid reembedding source generation",
    )?;
    if source_generation == target_generation {
        return Err(invalid(
            "target generation must differ from the active generation",
        ));
    }
    super::state_json::safe_payload(target)
        .map_err(|_| invalid("secret-bearing migration plan field is forbidden"))?;
    super::state_json::safe_payload(&active)
        .map_err(|_| invalid("secret-bearing migration plan field is forbidden"))?;
    let source_fingerprint = required(&active, "fingerprint")?;
    let (left_id, left_identity, left_identity_id) = fingerprint(source_fingerprint)?;
    let (right_id, right_identity, right_identity_id) = fingerprint(target_fingerprint)?;
    if left_id == right_id {
        return Err(invalid(
            "reembedding plan does not change the embedding fingerprint",
        ));
    }
    let tables = tables(
        required(&active, "tables")?,
        required(source_fingerprint, "dimensions")?,
    )?;
    let rows = tables
        .iter()
        .filter_map(|t| field(t, "rowCount").and_then(integer))
        .fold(0., |sum, n| sum + n as f64);
    let bytes = tables
        .iter()
        .filter_map(|t| field(t, "estimatedBytes").and_then(integer))
        .fold(0., |sum, n| sum + n as f64);
    let dimensions = field(target_fingerprint, "dimensions")
        .and_then(integer)
        .filter(|n| *n > 0)
        .ok_or(invalid("invalid target dimensions"))?;
    let target_bytes = bytes + rows * (dimensions as f64) * 4.;
    let required_bytes = (target_bytes * 1.25).ceil().max(1.);
    let free = source.free_bytes(cancel)?;
    check(cancel)?;
    if free > MAX_SAFE || (free as f64) < required_bytes {
        return Err(invalid(
            "insufficient disk space for reembedding target generation",
        ));
    }
    let deferred =
        if get_text(target_fingerprint, "provider").as_deref() == Some("local-transformers") {
            let verified = source.target_artifacts_verified(target_fingerprint, cancel)?;
            check(cancel)?;
            !verified
        } else {
            false
        };
    if !deferred {
        let probe = source.probe_target(target, cancel)?;
        check(cancel)?;
        if probe.len() as u64 != dimensions {
            return Err(invalid("target provider probe dimension mismatch"));
        }
        if probe.iter().any(|n| !n.is_finite()) {
            return Err(invalid(
                "target provider probe returned a non-finite vector",
            ));
        }
    }
    let ttl = match field(&request, "confirmationTtlMs") {
        None | Some(Json::Null) => 900000,
        Some(v) => integer(v).ok_or(invalid("invalid reembedding confirmation TTL"))?,
    };
    if !(1000..=3600000).contains(&ttl) {
        return Err(invalid("invalid reembedding confirmation TTL"));
    }
    let time = crate::recall::render_date::iso_timestamp(now)
        .map_err(|_| invalid("invalid reembedding planner clock"))?;
    let mut source_record = obj(vec![
        ("generation", string(&source_generation)),
        (
            "selection",
            selection(field(&active, "selection"), &source_generation)?,
        ),
        (
            "configRevision",
            field(&active, "configRevision")
                .filter(|v| matches!(v, Json::String(_)))
                .cloned()
                .unwrap_or(Json::Null),
        ),
        ("fingerprintId", string(&left_id)),
        ("fingerprint", source_fingerprint.clone()),
        ("identity", left_identity),
        ("identityId", string(&left_identity_id)),
    ]);
    if let Some(v) = field(&active, "secretRef").filter(|v| truthy(v)) {
        put(&mut source_record, "secretRef", secret_ref(v)?)
            .map_err(|_| invalid("invalid source"))?;
    }
    put(&mut source_record, "tables", Json::Array(tables))
        .map_err(|_| invalid("invalid source"))?;
    let mut target_record = obj(vec![
        ("generation", string(&target_generation)),
        ("selection", selection(None, &target_generation)?),
        ("fingerprintId", string(&right_id)),
        ("fingerprint", target_fingerprint.clone()),
        ("identity", right_identity),
        ("identityId", string(&right_identity_id)),
    ]);
    if let Some(v) = field(target, "secretRef").filter(|v| truthy(v)) {
        put(&mut target_record, "secretRef", secret_ref(v)?)
            .map_err(|_| invalid("invalid target"))?;
    }
    put(
        &mut target_record,
        "probeStatus",
        string(if deferred {
            "probe_deferred_local_artifact"
        } else {
            "passed"
        }),
    )
    .map_err(|_| invalid("invalid target"))?;
    let plan = obj(vec![
        ("schemaVersion", number(1)),
        ("id", string(&id)),
        ("createdAt", string(&time)),
        ("source", source_record),
        ("target", target_record),
        (
            "estimates",
            obj(vec![
                ("rows", num(rows)?),
                ("providerCalls", num(rows)?),
                ("sourceBytes", num(bytes)?),
                ("targetBytes", num(target_bytes)?),
                ("requiredFreeBytes", num(required_bytes)?),
                ("freeBytes", number(free)),
            ]),
        ),
    ]);
    let digest = format!("sha256:{:x}", Sha256::digest(write_json(&plan).as_bytes()));
    let expiry = (now as u64)
        .checked_add(ttl)
        .filter(|n| *n <= MAX_SAFE)
        .ok_or(invalid("invalid reembedding confirmation expiry"))?;
    check(cancel)?;
    Ok((plan, digest, expiry))
}
fn truthy(v: &Json) -> bool {
    match v {
        Json::Null | Json::Bool(false) => false,
        Json::String(s) => !s.is_empty(),
        Json::Number(s) => s != "0",
        _ => true,
    }
}
fn default_generation(id: &str) -> String {
    let direct = format!("generation-{id}");
    if direct.len() <= 64 {
        direct
    } else {
        format!(
            "generation-{}-{}",
            &id[..40],
            &format!("{:x}", Sha256::digest(id.as_bytes()))[..12]
        )
    }
}
/// Build a plan and fresh confirmation. No source/target generation or state file is mutated.
/// `now` is an explicit host clock so preview, confirmation expiry and durable create agree.
pub fn create(
    request: &Json,
    source: &dyn PlanSource,
    now: f64,
    cancel: &Cancel,
) -> Result<ReembeddingPlan, PlanError> {
    let (plan, digest, expiry) = build(request, source, now, cancel)?;
    let confirmation = confirmation::create(&digest, expiry).map_err(|_| PlanError::Entropy)?;
    Ok(ReembeddingPlan {
        plan,
        digest,
        confirmation,
    })
}
#[cfg(test)]
#[path = "planner_tests.rs"]
mod tests;
