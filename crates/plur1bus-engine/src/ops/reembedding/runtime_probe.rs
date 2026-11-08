//! Internal post-activation store/recall probe with audited, UUID-scoped cleanup.
use super::coordinator::CoordinatorError as Error;
use crate::{
    contract::{Cancel, MemoryRow},
    store::{RowFilter, Store},
};
use serde_json::{json, Value};
use std::sync::Arc;
const AGENT: &str = "plur1bus-reembedding-probe";
const WORKSPACE: &str = "workspace:v1:plur1bus-reembedding-probe";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ProbeFailure {
    pub(crate) operation: Option<Error>,
    pub(crate) cleanup: Option<Error>,
}
impl From<Error> for ProbeFailure {
    fn from(e: Error) -> Self {
        Self {
            operation: Some(e),
            cleanup: None,
        }
    }
}
impl std::fmt::Display for ProbeFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("reembedding runtime probe failed")
    }
}
impl std::error::Error for ProbeFailure {}
fn invalid(s: &'static str) -> Error {
    Error::Invalid(s)
}
fn check(c: &Cancel) -> Result<(), Error> {
    c.check().map_err(|_| Error::Cancelled)
}
fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
pub(crate) trait ProbeDb: Send {
    fn store(&self, row: &Value, c: &Cancel) -> Result<(), Error>;
    fn search(&self, vector: &[f64], c: &Cancel) -> Result<Vec<String>, Error>;
    fn delete(&self, id: &str, c: &Cancel) -> Result<(), Error>;
}
pub(crate) trait ProbeHost: Send + Sync {
    fn active_generation(&self, c: &Cancel) -> Result<Option<String>, Error>;
    fn create_id(&self) -> String;
    fn now_ms(&self) -> f64;
    fn embed(&self, request: &Value, c: &Cancel) -> Result<Vec<f64>, Error>;
    /// Open only the synthetic agent's store in the selected active runtime, bound to this UUID.
    fn open(&self, target: &Value, probe_id: &str, c: &Cancel) -> Result<Box<dyn ProbeDb>, Error>;
    fn audit(&self, entry: &Value) -> Result<bool, Error>;
}
fn vector(v: Vec<f64>, dim: usize) -> Result<Vec<f64>, Error> {
    if v.len() != dim || v.iter().any(|n| !n.is_finite()) {
        Err(invalid("reembedding probe vector is invalid"))
    } else {
        Ok(v)
    }
}
pub(crate) fn run(
    host: &dyn ProbeHost,
    request: &Value,
    c: &Cancel,
) -> Result<Value, ProbeFailure> {
    check(c)?;
    let expected = request
        .get("expectedGeneration")
        .ok_or_else(|| invalid("invalid runtime probe selection"))?;
    if !expected.is_null() && !expected.is_string() {
        return Err(invalid("invalid runtime probe selection").into());
    }
    if host.active_generation(c)?.as_deref() != expected.as_str() {
        return Err(invalid("active generation selection drift after config mutation").into());
    }
    let fp = &request["fingerprint"];
    let dimension = fp["dimensions"]
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 1.0 && *v <= 9_007_199_254_740_991.0 && v.fract() == 0.0)
        .ok_or_else(|| invalid("target embedding fingerprint is invalid"))?;
    let dimension = usize::try_from(dimension as u64)
        .map_err(|_| invalid("target embedding fingerprint is invalid"))?;
    let id = host.create_id();
    if !uuid(&id) {
        return Err(invalid("invalid synthetic probe id").into());
    }
    let text = format!("PLUR1BUS reembedding probe {id}");
    let now = host.now_ms();
    if !now.is_finite() || !(0.0..=9_007_199_254_740_991.0).contains(&now) || now.fract() != 0.0 {
        return Err(invalid("synthetic probe clock is invalid").into());
    }
    let now = now as u64;
    let embed = |purpose: &str| {
        check(c)?;
        let mut input = json!({"text":text,"purpose":purpose,"fingerprint":fp});
        if let Some(reference) = request.get("secretRef") {
            input["secretRef"] = reference.clone();
        }
        vector(host.embed(&input, c)?, dimension)
    };
    let passage = embed("passage")?;
    let db = host.open(
        &json!({"generation":expected,"agentId":AGENT,"dimensions":dimension}),
        &id,
        c,
    )?;
    let row = json!({"id":id,"vector":passage,"text":text,"summary":text,"agentId":AGENT,"storedBy":AGENT,"workspaceId":WORKSPACE,"workspaceKey":WORKSPACE,"ownerUserId":"","scope":"agent-private","origin":"system","category":"fact","importance":0.5,"createdAt":now,"status":"active","epistemicStatus":"observed"});
    let mut stored = false;
    let operation = (|| {
        check(c)?;
        db.store(&row, c)?;
        stored = true;
        let query = embed("query")?;
        let recalled = db.search(&query, c)?;
        if !recalled.iter().any(|candidate| candidate == &id) {
            return Err(invalid(
                "target runtime did not recall the synthetic reembedding probe",
            ));
        }
        Ok(json!({"readiness":true,"store":true,"recall":true}))
    })();
    let cleanup = if stored {
        // Caller cancellation must not skip audited cleanup of our own newly inserted UUID.
        let audit=host.audit(&json!({"event":"reembedding.synthetic_probe_delete","memoryId":id,"agentId":AGENT,"workspaceId":WORKSPACE,"createdAt":now}));
        match audit {
            Ok(true) => db.delete(&id, &Cancel::never()),
            Ok(false) => Err(Error::Audit),
            Err(e) => Err(e),
        }
    } else {
        Ok(())
    };
    match (operation, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (operation, cleanup) => Err(ProbeFailure {
            operation: operation.err(),
            cleanup: cleanup.err(),
        }),
    }
}
/// A real typed Lance adapter scoped to one synthetic UUID. The host selects its generation/pool;
/// the probe cannot delete another UUID or store a row outside the fixed private probe agent.
pub(crate) struct StoreProbeDb {
    store: Arc<Store>,
    id: String,
}
impl StoreProbeDb {
    pub(crate) fn new(store: Arc<Store>, id: &str) -> Result<Self, Error> {
        if !uuid(id) {
            return Err(invalid("invalid synthetic probe id"));
        }
        Ok(Self {
            store,
            id: id.to_owned(),
        })
    }
}
impl ProbeDb for StoreProbeDb {
    fn store(&self, row: &Value, c: &Cancel) -> Result<(), Error> {
        check(c)?;
        if row["id"].as_str() != Some(&self.id)
            || row["agentId"] != AGENT
            || row["scope"] != "agent-private"
            || row["workspaceId"] != WORKSPACE
            || row["workspaceKey"] != WORKSPACE
            || row["ownerUserId"] != ""
        {
            return Err(invalid("invalid synthetic probe row"));
        }
        if self.store.get(&self.id).map_err(|_| Error::Host)?.is_some() {
            return Err(invalid("synthetic probe id already exists"));
        }
        let mut value = serde_json::to_value(crate::capture::row_defaults::schema_defaults(vec![]))
            .map_err(|_| Error::Host)?;
        value
            .as_object_mut()
            .ok_or(Error::Host)?
            .extend(row.as_object().ok_or(Error::Host)?.clone());
        let typed: MemoryRow = serde_json::from_value(value).map_err(|_| Error::Host)?;
        self.store.upsert(&[typed]).map_err(|_| Error::Host)
    }
    fn search(&self, vector: &[f64], c: &Cancel) -> Result<Vec<String>, Error> {
        check(c)?;
        let vector = vector.iter().map(|n| *n as f32).collect::<Vec<_>>();
        if vector.iter().any(|v| !v.is_finite()) {
            return Err(invalid("reembedding probe vector is invalid"));
        }
        let rows = self
            .store
            .search(
                &vector,
                5,
                &RowFilter {
                    agent_id: Some(AGENT.into()),
                    workspace_id: Some(WORKSPACE.into()),
                    ..Default::default()
                },
            )
            .map_err(|_| Error::Host)?;
        check(c)?;
        Ok(rows.into_iter().map(|r| r.row.id).collect())
    }
    fn delete(&self, id: &str, c: &Cancel) -> Result<(), Error> {
        check(c)?;
        if id != self.id {
            return Err(invalid("synthetic probe deletion id mismatch"));
        }
        self.store.delete(&[id]).map_err(|_| Error::Host)?;
        Ok(())
    }
}
#[cfg(test)]
#[path = "runtime_probe_tests.rs"]
mod tests;
