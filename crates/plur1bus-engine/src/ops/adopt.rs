//! Copy-never-move store inspection, with a bounded passage/vector identity probe.
use crate::{
    contract::{
        AdoptReport, Cancel, EmbedKind, EmbeddingIdentity, EmbeddingService, EngineError,
        MemoryOpErrorCode, PlatformCapabilities, StoreAdoptRequest, StoreOps,
    },
    store::{
        lance::adopt_probe::{self, ProbeRow},
        paths::assert_trusted_path,
    },
    text::js::locale_compare,
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

/// Read-only route boundary. A live engine adapter must return its actual recall namespaces.
pub trait AdoptionRoutes: Send + Sync {
    /// Sample each existing physical table in this pool/agent route without creating it.
    fn read(
        &self,
        pool_base: &Path,
        agent: &str,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<ProbeRow>>, EngineError>;
}
/// Direct copied-store route. Live engine roots use their own namespace-aware route adapter.
pub struct CopiedStoreRoutes;
impl AdoptionRoutes for CopiedStoreRoutes {
    fn read(
        &self,
        base: &Path,
        agent: &str,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<ProbeRow>>, EngineError> {
        adopt_probe::read(&base.join(agent), cancel)
            .map(|rows| vec![rows])
            .map_err(|_| super::context::error(MemoryOpErrorCode::Storage))
    }
}
fn invalid() -> EngineError {
    super::context::error(MemoryOpErrorCode::InvalidInput)
}
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}
fn safe_agent(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}
fn ordinary_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|s| s.is_dir() && !s.file_type().is_symlink())
}
fn children(path: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(path) else {
        return vec![];
    };
    let mut names = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            (e.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink())).then_some(name)
        })
        .collect::<Vec<_>>();
    names.sort();
    names
}
fn table(base: &Path, name: &str) -> bool {
    safe_agent(name)
        && ["memories.lance", "memories"]
            .iter()
            .any(|t| ordinary_dir(&base.join(name).join(t)))
}
fn locations(root: &Path) -> Vec<(PathBuf, String)> {
    let allowed = |name: &str| !name.starts_with(['.', '_']) && name != "generations";
    let mut found = Vec::new();
    for name in children(root).into_iter().filter(|s| allowed(s)) {
        if table(root, &name) {
            found.push((root.to_owned(), name));
        } else {
            let base = root.join(name);
            for agent in children(&base).into_iter().filter(|s| allowed(s)) {
                if table(&base, &agent) {
                    found.push((base.clone(), agent));
                }
            }
        }
    }
    found.sort_by(|a, b| {
        locale_compare(&a.1, &b.1)
            .then_with(|| locale_compare(&a.0.to_string_lossy(), &b.0.to_string_lossy()))
    });
    found
}
fn positive_dimension(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n > 0. && n <= 9_007_199_254_740_991. && n.fract() == 0.)
}
struct Generation {
    id: String,
    manifest: Value,
}
struct Generations {
    present: bool,
    unreadable: bool,
    manifests: Vec<Generation>,
}
fn manifests(root: &Path) -> Generations {
    let path = root.join("generations");
    let mut out = Generations {
        present: path.exists(),
        unreadable: false,
        manifests: vec![],
    };
    if !out.present {
        return out;
    }
    if assert_trusted_path(&path).is_err() || fs::read_dir(&path).is_err() {
        out.unreadable = true;
        return out;
    }
    for id in children(&path) {
        let file = path.join(&id).join("generation.json");
        if !file.exists() {
            continue;
        }
        let raw = assert_trusted_path(&file)
            .ok()
            .and_then(|()| fs::read(&file).ok())
            .and_then(|v| serde_json::from_slice::<Value>(&v).ok());
        match raw {
            Some(manifest)
                if manifest["fingerprintId"].is_string()
                    && positive_dimension(&manifest["dimensions"]) =>
            {
                out.manifests.push(Generation { id, manifest })
            }
            _ => out.unreadable = true,
        }
    }
    out
}
fn generation_root(root: &Path, generation: &Generation, expected: &Value) -> Option<PathBuf> {
    let g = &generation.manifest;
    let fingerprint = g["fingerprintId"].as_str()?;
    let digest = fingerprint.strip_prefix("embedding:v1:sha256:")?;
    if !safe_name(&generation.id)
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || g["schemaVersion"] != 1
        || g["generation"] != generation.id
        || !g["tables"].is_object()
        || g["fingerprintId"] != expected["fingerprintId"]
        || g["dimensions"] != expected["dimensions"]
    {
        return None;
    }
    let path = root.join("generations").join(&generation.id);
    assert_trusted_path(&path).ok()?;
    ordinary_dir(&path).then_some(path)
}
fn report(value: Value) -> Result<AdoptReport, EngineError> {
    serde_json::from_value(value).map_err(|_| super::context::error(MemoryOpErrorCode::Storage))
}
fn reject(mut value: Value, reason: &str) -> Result<AdoptReport, EngineError> {
    value["verdict"] = json!("incompatible");
    value["reason"] = json!(reason);
    report(value)
}
/// Read-only adoption facade. Neither dry-run mode nor apply moves files or changes configuration.
pub struct StoreAdopter {
    embeddings: Arc<dyn EmbeddingService>,
    identity: Option<EmbeddingIdentity>,
    platform: PlatformCapabilities,
    routes: Arc<dyn AdoptionRoutes>,
    cancel: Cancel,
}
impl StoreAdopter {
    /// Bind actual provider identity, native platform checks, read routes and engine-close token.
    pub fn new(
        embeddings: Arc<dyn EmbeddingService>,
        identity: Option<EmbeddingIdentity>,
        platform: PlatformCapabilities,
        routes: Arc<dyn AdoptionRoutes>,
        cancel: Cancel,
    ) -> Self {
        Self {
            embeddings,
            identity,
            platform,
            routes,
            cancel,
        }
    }
    /// Inspect with a narrower request cancellation budget supplied by the runtime.
    pub fn inspect(
        &self,
        request: &StoreAdoptRequest,
        cancel: &Cancel,
    ) -> Result<AdoptReport, EngineError> {
        self.cancel.check()?;
        cancel.check()?;
        let expected = serde_json::to_value(&request.expected_identity).map_err(|_| invalid())?;
        if !positive_dimension(&expected["dimensions"]) {
            return Err(invalid());
        }
        let path = Path::new(&request.path);
        if !path.is_absolute()
            || request.path.split(['/', '\\']).any(|p| p == "..")
            || self.platform.is_unsafe_link(path)
            || assert_trusted_path(path).is_err()
        {
            return Err(invalid());
        }
        let mut result = json!({"verdict":"ok", "dryRun":request.dry_run == Some(true)});
        match fs::symlink_metadata(path) {
            Err(_) => return reject(result, "path-unreadable"),
            Ok(s) if !s.is_dir() || s.file_type().is_symlink() => return Err(invalid()),
            _ => (),
        }
        let gens = manifests(path);
        if !path.join("_schema.json").exists()
            && locations(path).is_empty()
            && !(gens.present && (gens.unreadable || !gens.manifests.is_empty()))
        {
            return reject(result, "not-a-store");
        }
        let current = super::status::schema_version(path);
        result["storeSchema"] = json!({"current":current, "expected":"1"});
        match current.as_deref() {
            None => return reject(result, "schema-unreadable"),
            Some("1") => (),
            _ => return reject(result, "schema-mismatch"),
        }
        result["identity"] = serde_json::to_value(&self.identity).map_err(|_| invalid())?;
        if !positive_dimension(&result["identity"]["dimensions"]) {
            return reject(result, "identity-unverifiable");
        }
        if result["identity"]["dimensions"] != expected["dimensions"] {
            return reject(result, "dimension-mismatch");
        }
        if gens.unreadable && gens.manifests.is_empty() {
            return reject(result, "identity-unreadable");
        }
        let matching = gens.manifests.iter().find(|g| {
            g.manifest["fingerprintId"] == expected["fingerprintId"]
                && g.manifest["dimensions"] == expected["dimensions"]
        });
        if matching.is_none() {
            if let Some(g) = gens.manifests.first() {
                let m = &g.manifest;
                let reason = if m["dimensions"] != expected["dimensions"] {
                    "dimension-mismatch"
                } else {
                    "identity-mismatch"
                };
                let fallback = |key: &str| {
                    m[key]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map_or_else(|| expected[key].clone(), |s| json!(s))
                };
                result["identity"] = json!({"fingerprintId":m["fingerprintId"], "dimensions":m["dimensions"], "provider":fallback("provider"), "model":fallback("model")});
                result["identitySource"] = json!("manifest");
                return reject(result, reason);
            }
        }
        result["identitySource"] = json!(if matching.is_some() {
            "manifest"
        } else {
            "probe"
        });
        if result["identity"]["fingerprintId"] != expected["fingerprintId"] {
            return reject(result, "identity-mismatch");
        }
        let mut roots = vec![path.to_owned()];
        if let Some(g) = matching {
            let Some(root) = generation_root(path, g, &expected) else {
                return reject(result, "identity-unreadable");
            };
            roots.push(root);
        }
        let mut seen = HashSet::new();
        let mut groups: Vec<(PathBuf, Vec<String>)> = Vec::new();
        for root in roots {
            for (base, agent) in locations(&root) {
                if !seen.insert((base.clone(), agent.clone())) {
                    continue;
                }
                if let Some((_, agents)) = groups.iter_mut().find(|(b, _)| *b == base) {
                    agents.push(agent);
                } else {
                    groups.push((base, vec![agent]));
                }
            }
        }
        let mut tables = Vec::new();
        for (base, agents) in groups {
            for agent in agents {
                self.cancel.check()?;
                cancel.check()?;
                match self.routes.read(&base, &agent, cancel) {
                    Ok(rows) => tables.extend(rows),
                    Err(_) => {
                        cancel.check()?;
                        return reject(result, "identity-unverifiable");
                    }
                }
            }
        }
        let mut sample = Vec::new();
        for i in 0..16 {
            for table in &tables {
                if let Some(row) = table.get(i) {
                    sample.push(row);
                }
                if sample.len() == 16 {
                    break;
                }
            }
            if sample.len() == 16 {
                break;
            }
        }
        if sample.is_empty() {
            return if matching.is_some() {
                report(result)
            } else {
                reject(result, "identity-unverifiable")
            };
        }
        result["identitySource"] = json!("probe");
        let dim = expected["dimensions"].as_f64().ok_or_else(invalid)?;
        if sample.iter().any(|r| r.vector.len() as f64 != dim) {
            return reject(result, "dimension-mismatch");
        }
        self.cancel.check()?;
        cancel.check()?;
        let identity = self.identity.as_ref().ok_or_else(invalid)?;
        let texts = sample.iter().map(|r| r.text.clone()).collect::<Vec<_>>();
        let fresh = match self
            .embeddings
            .embed(&texts, EmbedKind::Passage, identity, cancel)
        {
            Ok(fresh) if fresh.len() == sample.len() => fresh,
            _ => {
                cancel.check()?;
                return reject(result, "identity-unverifiable");
            }
        };
        self.cancel.check()?;
        cancel.check()?;
        let mut scores = Vec::new();
        for (stored, fresh) in sample.iter().zip(fresh) {
            let fresh = fresh.into_iter().map(f64::from).collect::<Vec<_>>();
            if !adopt_probe::valid_vector(&fresh) {
                continue;
            }
            if fresh.len() != stored.vector.len() {
                return reject(result, "dimension-mismatch");
            }
            let (mut dot, mut a, mut b) = (0., 0., 0.);
            for (x, y) in stored.vector.iter().zip(fresh) {
                dot += x * y;
                a += x * x;
                b += y * y;
            }
            let score = dot / (a.sqrt() * b.sqrt());
            if score.is_finite() {
                scores.push(score);
            }
        }
        if scores.len() < 8.min(sample.len()) {
            return reject(result, "identity-unverifiable");
        }
        scores.sort_by(f64::total_cmp);
        let mid = scores.len() / 2;
        let median = if scores.len() % 2 == 0 {
            (scores[mid - 1] + scores[mid]) / 2.
        } else {
            scores[mid]
        };
        if scores[0] < 0.999 || median < 0.9995 {
            return reject(result, "identity-mismatch");
        }
        report(result)
    }
}
impl StoreOps for StoreAdopter {
    fn adopt(&self, request: StoreAdoptRequest) -> Result<AdoptReport, EngineError> {
        self.inspect(&request, &self.cancel)
    }
}
