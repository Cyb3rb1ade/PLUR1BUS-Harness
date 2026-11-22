//! The live capability index (`live-index.ts`): the core-owned store behind `capabilities.search`. Every view is built
//! from the registrations admitted on this turn, never from a global persisted snapshot: the turn's tools become entries
//! ([`tool_entry`]) of a source of their own, the skill store's enabled skills are the `skills` source, an agent sees a
//! skill only where it is not blocked and (with an extension feed) granted to it, and the usage prior of each entry is
//! computed once per agent and kept until the entry's version changes or the nightly recheck clears it.
//!
//! What touches the world is a port here: the skill store's file half (`index.json`, `SKILL.md`, its front matter) is
//! [`SkillSource`], the supervisor's extension list is [`ExtensionFeed`], the local embedding service is
//! [`LocalEmbedding`] (never a download, never a cloud model), the calibration file is [`CalibrationSource`]. Not ported:
//! the file watcher (`watchSkills`, a debounce over `fs.watch`) and the system-job wiring (`job()`; its argument check is
//! [`validate_recheck_args`]); both belong to the flip, which owns the scheduler and the watcher.
use super::capabilities::{
    load_calibration, usage_prior, CalibrationConfig, CapabilityEntry, CapabilityIndex,
    EmbeddingPort, LexicalPort, PriorPort,
};
use super::json::{JsStr, Obj, V};
use super::registry::{RegistryError, SqliteCapabilityRegistry};
use super::validation::{PortFailed, Thrown};
use crate::budget::Clock;
use crate::js;
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;

fn digest(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn type_error(message: &str) -> Thrown {
    Thrown {
        name: "TypeError",
        message: message.to_owned(),
    }
}

/// `short(s)`: control characters become spaces, then at most 25 words of the trimmed text, at most 1000 code units.
pub fn short(text: &V) -> Result<V, Thrown> {
    let Some(text) = text.as_js() else {
        return Err(type_error("s.replace is not a function"));
    };
    let replaced: Vec<u16> = text
        .units()
        .iter()
        .map(|u| if *u < 0x20 || *u == 0x7f { 0x20 } else { *u })
        .collect();
    let trimmed = js::trim_units(&replaced);
    // `split(/\s+/u)` of the trimmed text: no leading or trailing run is left, so every piece is a word (or the one
    // empty piece of an empty text).
    let mut words: Vec<&[u16]> = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < trimmed.len() {
        if js::is_space_unit(trimmed[i]) {
            words.push(&trimmed[start..i]);
            while i < trimmed.len() && js::is_space_unit(trimmed[i]) {
                i += 1;
            }
            start = i;
        } else {
            i += 1;
        }
    }
    words.push(&trimmed[start..]);
    let mut out: Vec<u16> = Vec::new();
    for (n, word) in words.iter().take(25).enumerate() {
        if n > 0 {
            out.push(0x20);
        }
        out.extend_from_slice(word);
    }
    out.truncate(1000);
    Ok(V::Str(JsStr::new(out)))
}

fn category_ok(category: Option<&V>) -> Option<&V> {
    category
        .filter(|c| c.truthy() && super::capabilities::valid_category(&c.to_js_string().lossy()))
}

/// `toolEntry(tool, scope)`: the capability entry of a registered tool, from trusted registration metadata only. `tool`
/// is the data of a `RegisteredTool` (`name`, `description`, `inputSchema`, `capability`, `effect`, `risk`, `discovery`).
pub fn tool_entry(tool: &V, scope: &str) -> Result<V, Thrown> {
    let name = tool
        .get("name")
        .and_then(V::as_js)
        .ok_or_else(|| type_error("tool.name.startsWith is not a function"))?;
    let name_text = name.lossy();
    let generated = if name_text.starts_with("image.") {
        "media.image"
    } else if name_text.starts_with("fs.") || name_text.starts_with("file.") {
        "files.manage"
    } else if name_text.starts_with("web.") {
        "web.research"
    } else {
        "ops.system"
    };
    let metadata = tool.get("discovery").filter(|m| !matches!(m, V::Null));
    let field = |key: &str| metadata.and_then(|m| m.get(key));
    let present = |key: &str| field(key).filter(|v| !matches!(v, V::Null));
    let category = category_ok(field("category"))
        .cloned()
        .unwrap_or_else(|| V::s(generated));
    let description = tool.get("description").cloned().unwrap_or(V::Null);
    let kind = present("kind").cloned().unwrap_or_else(|| {
        V::s(if name_text.starts_with("mcp.") {
            "mcp-tool"
        } else {
            "tool"
        })
    });
    let scope_digest = digest(scope);
    let version_input = V::Arr(vec![
        description.clone(),
        tool.get("inputSchema").cloned().unwrap_or(V::Null),
        tool.get("capability").cloned().unwrap_or(V::Null),
        tool.get("effect").cloned().unwrap_or(V::Null),
        tool.get("risk").cloned().unwrap_or(V::Null),
        metadata.cloned().unwrap_or(V::Null),
    ]);
    let mut generated_fields = Vec::new();
    for (key, label) in [
        ("category", "category"),
        ("summary", "description"),
        ("useWhen", "useWhen"),
        ("notFor", "notFor"),
    ] {
        if !field(key).is_some_and(V::truthy) {
            generated_fields.push(label);
        }
    }
    let not_for_default = V::s("Actions outside the dispatcher policy and granted scope.");
    let mut entry = Obj::new();
    entry.set(
        "id",
        V::Str(JsStr::from(format!("tool:{scope_digest}:")).plus_js(name)),
    );
    entry.set("name", V::Str(name.clone()));
    entry.set(
        "description",
        short(present("summary").unwrap_or(&description))?,
    );
    entry.set("category", category);
    entry.set("kind", kind);
    // An absent effect or risk is `undefined` and leaves the member out, as `JSON.stringify` does.
    for key in ["effect", "risk"] {
        if let Some(v) = tool.get(key) {
            entry.set(key, v.clone());
        }
    }
    entry.set("source", V::s(&format!("turn:{scope_digest}")));
    entry.set("version", V::s(&digest(&version_input.stringify())));
    entry.set(
        "useWhen",
        short(present("useWhen").unwrap_or(&description))?,
    );
    entry.set(
        "notFor",
        short(present("notFor").unwrap_or(&not_for_default))?,
    );
    entry.set("generatedFields", V::strs(&generated_fields));
    Ok(V::Obj(entry))
}

/// An enabled skill of the store as the index sees it (`IndexedSkill`).
#[derive(Clone, Debug)]
pub struct IndexedSkill {
    /// Its capability entry.
    pub entry: V,
    /// The text of `SKILL.md`.
    pub text: JsStr,
    /// The description the skill's author wrote, for the prompt's catalogue.
    pub authored_description: Option<JsStr>,
}

impl IndexedSkill {
    fn name(&self) -> String {
        self.entry
            .get("name")
            .and_then(V::as_js)
            .map(JsStr::lossy)
            .unwrap_or_default()
    }
}

/// What the skill store holds now (`refreshSkills`' file half): the enabled skills whose folder, `SKILL.md` and front
/// matter are sound, and whether the store could not be read (a store that does not exist is empty, not an error).
#[derive(Clone, Debug, Default)]
pub struct SkillScan {
    /// The skills, in the store's order.
    pub skills: Vec<IndexedSkill>,
    /// The store failed (closed): no skill, and `sourceError` in the status.
    pub error: bool,
}

/// The skill store's file half. `items` is the extension feed's list (`{ id: name, enabled }`) where a feed is set,
/// which then replaces the store's own `index.json`.
pub trait SkillSource {
    /// Reads the store.
    fn scan(&mut self, items: Option<&[(String, bool)]>) -> SkillScan;
}

/// One extension capability of the supervisor's list (`ExtensionCapability`); `agents: None` is `'all'`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtensionCapability {
    /// Its name.
    pub name: String,
    /// Whether it is enabled.
    pub enabled: bool,
    /// The agents it is granted to, or every agent.
    pub agents: Option<Vec<String>>,
}

/// The supervisor's extension list (`ExtensionCapabilityFeed.snapshot`); an error fails closed (no extension).
pub trait ExtensionFeed {
    /// The current list.
    fn snapshot(&mut self) -> Result<Vec<ExtensionCapability>, PortFailed>;
}

/// The engine's embedder as `prepare` sees it (`models.status().embedder`).
#[derive(Clone, Debug, PartialEq)]
pub struct EmbedderStatus {
    /// `state === "ready"`.
    pub ready: bool,
    /// `identity.provider`.
    pub provider: String,
    /// `JSON.stringify(identity)`: the model key of a stored vector.
    pub identity: String,
    /// `identity.dimensions`.
    pub dimensions: f64,
}

/// The engine's already-ready local embedding service. `kind` is `passage` or `query`. A vector is what the service
/// returns (`Float32Array`), so its numbers are single precision.
pub trait LocalEmbedding {
    /// The embedder's status, or `None` without an engine.
    fn status(&self) -> Option<EmbedderStatus>;
    /// The vectors of `texts`; an error is a failed batch.
    fn embed(&mut self, texts: &[JsStr], kind: &str) -> Result<Vec<Vec<f32>>, PortFailed>;
}

/// The installation's calibration file (`capability-calibration.json`): `Ok(None)` when there is none.
pub type CalibrationSource = Box<dyn FnMut() -> Result<Option<String>, Thrown>>;

/// What an agent may see this turn (`CapabilityView`).
pub struct CapabilityView {
    /// The ranking index (with the usage prior).
    pub index: CapabilityIndex,
    /// The discovery index (no prior).
    pub discovery: CapabilityIndex,
    /// The agent.
    pub agent: Option<String>,
    /// The admitted skills.
    pub skills: Vec<IndexedSkill>,
    /// Every admitted entry id.
    pub ids: HashSet<String>,
}

/// The status Doctor shows (`status()`).
#[derive(Clone, Debug, PartialEq)]
pub struct LiveStatus {
    /// `fts5-vectors` or `fts5-only`.
    pub mode: &'static str,
    /// `ready` or `unavailable`.
    pub local_embedding: &'static str,
    /// Entries in the registry.
    pub entries: usize,
    /// When the last recheck ran.
    pub last_recheck: Option<i64>,
    /// Whether a source failed.
    pub source_error: bool,
}

impl LiveStatus {
    /// The TypeScript object.
    pub fn to_v(&self) -> V {
        V::obj([
            ("mode", V::s(self.mode)),
            ("localEmbedding", V::s(self.local_embedding)),
            ("entries", V::Num(self.entries as f64)),
            (
                "lastRecheck",
                self.last_recheck.map_or(V::Null, |t| V::Num(t as f64)),
            ),
            ("sourceError", V::Bool(self.source_error)),
        ])
    }
}

type Shared<T> = Rc<RefCell<T>>;
type PriorKey = (Option<String>, String);

/// `LiveCapabilityIndex`.
pub struct LiveCapabilityIndex {
    registry: Shared<SqliteCapabilityRegistry>,
    clock: Arc<dyn Clock>,
    skills_source: Box<dyn SkillSource>,
    calibration_source: CalibrationSource,
    calibration: CalibrationConfig,
    extension_feed: Option<Box<dyn ExtensionFeed>>,
    extensions: Vec<ExtensionCapability>,
    engine: Option<Box<dyn LocalEmbedding>>,
    embedding_ready: bool,
    skills: Vec<IndexedSkill>,
    last_check: Option<i64>,
    priors: Shared<HashMap<PriorKey, f64>>,
    error: bool,
    feed_error: bool,
}

fn registry_thrown(e: RegistryError) -> Thrown {
    match e {
        RegistryError::Refused(t) => t,
        other => Thrown::error(format!("{other:?}")),
    }
}

/// The calibration of an installation: its file, or the defaults where there is none. Any other failure is thrown.
fn read_calibration(source: &mut CalibrationSource) -> Result<CalibrationConfig, Thrown> {
    let text = source()?;
    load_calibration(text.as_deref())
}

fn ids_of(entries: &[&CapabilityEntry]) -> HashSet<String> {
    entries.iter().map(|e| e.id()).collect()
}

/// The store's ranking as a lexical port: the rank of each hit among the allowed candidates, `1 / (rank + 1)`. A store
/// failure gives no lexical score (the index ranks on its own then).
fn lexical(registry: &Shared<SqliteCapabilityRegistry>) -> LexicalPort {
    let registry = Rc::clone(registry);
    Box::new(move |query: &str, candidates: &[&CapabilityEntry]| {
        let allowed = ids_of(candidates);
        registry
            .borrow()
            .search(query, &allowed, 128.0)
            .unwrap_or_default()
            .iter()
            .enumerate()
            .filter_map(|(i, e)| {
                e.get("id")
                    .and_then(V::as_js)
                    .map(|id| (id.lossy(), 1.0 / (i as f64 + 1.0)))
            })
            .collect()
    })
}

fn prior(priors: &Shared<HashMap<PriorKey, f64>>, agent: Option<String>) -> PriorPort {
    let priors = Rc::clone(priors);
    Box::new(move |e: &CapabilityEntry| {
        priors
            .borrow()
            .get(&(agent.clone(), e.id()))
            .copied()
            .unwrap_or(0.0)
    })
}

struct FixedScores(HashMap<String, f64>);

impl EmbeddingPort for FixedScores {
    fn score(&self, _query: &str, _entries: &[&CapabilityEntry]) -> HashMap<String, f64> {
        self.0.clone()
    }
}

/// The turn was cancelled while `prepare` ran (`signal.throwIfAborted()`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Aborted;

/// What `prepare` answers: the view's own index (no ready local model, or it failed), or an index with vector scores.
pub enum Prepared {
    /// Use `view.index`.
    View,
    /// The index with local vector scores.
    Vectors(CapabilityIndex),
}

const LOCAL_PROVIDERS: &[&str] = &["local-transformers", "local-gguf", "local-onnx", "mlx"];

impl LiveCapabilityIndex {
    /// `new LiveCapabilityIndex(home, clock, engine)`, with the registry the owner opened (`state/capabilities.sqlite`).
    pub fn new(
        registry: SqliteCapabilityRegistry,
        clock: Arc<dyn Clock>,
        skills_source: Box<dyn SkillSource>,
        mut calibration_source: CalibrationSource,
        engine: Option<Box<dyn LocalEmbedding>>,
    ) -> Result<Self, Thrown> {
        let calibration = read_calibration(&mut calibration_source)?;
        Ok(LiveCapabilityIndex {
            registry: Rc::new(RefCell::new(registry)),
            clock,
            skills_source,
            calibration_source,
            calibration,
            extension_feed: None,
            extensions: Vec::new(),
            engine,
            embedding_ready: false,
            skills: Vec::new(),
            last_check: None,
            priors: Rc::new(RefCell::new(HashMap::new())),
            error: false,
            feed_error: false,
        })
    }

    /// The registry (shared with the views' lexical ports).
    pub fn registry(&self) -> std::cell::Ref<'_, SqliteCapabilityRegistry> {
        self.registry.borrow()
    }

    /// The registry, for writing.
    pub fn registry_mut(&self) -> std::cell::RefMut<'_, SqliteCapabilityRegistry> {
        self.registry.borrow_mut()
    }

    /// Sets the extension feed (`extensionFeed = ...`); with a feed, the skill list comes from it.
    pub fn set_extension_feed(&mut self, feed: Option<Box<dyn ExtensionFeed>>) {
        self.extension_feed = feed;
    }

    /// The usage prior currently kept for `agent` and `id`.
    pub fn prior_of(&self, agent: Option<&str>, id: &str) -> Option<f64> {
        self.priors
            .borrow()
            .get(&(agent.map(str::to_owned), id.to_owned()))
            .copied()
    }

    /// `refreshSkills()`: reads the store and makes the registry's `skills` source what it holds.
    pub fn refresh_skills(&mut self) -> Result<(), Thrown> {
        let items: Option<Vec<(String, bool)>> = self.extension_feed.as_ref().map(|_| {
            self.extensions
                .iter()
                .map(|e| (e.name.clone(), e.enabled))
                .collect()
        });
        let scan = self.skills_source.scan(items.as_deref());
        self.error = self.feed_error || scan.error;
        let entries: Vec<V> = scan.skills.iter().map(|s| s.entry.clone()).collect();
        self.replace("skills", &entries)?;
        self.skills = scan.skills;
        Ok(())
    }

    fn forget_priors(&self, id: &str) {
        self.priors.borrow_mut().retain(|(_, key), _| key != id);
    }

    fn replace(&mut self, source: &str, entries: &[V]) -> Result<(), Thrown> {
        let current: HashSet<String> = entries
            .iter()
            .filter_map(|e| e.get("id").and_then(V::as_js).map(JsStr::lossy))
            .collect();
        for entry in entries {
            let id = entry.get("id").and_then(V::as_js).map(JsStr::lossy);
            let snapshot = self.registry.borrow().snapshot().map_err(registry_thrown)?;
            let old = snapshot
                .iter()
                .find(|e| e.get("id").and_then(V::as_js).map(JsStr::lossy) == id);
            let changed = match (old.and_then(|o| o.get("version")), entry.get("version")) {
                (Some(V::Str(a)), Some(V::Str(b))) => a != b,
                (None, None) => false,
                _ => true,
            };
            if changed {
                if let Some(id) = &id {
                    self.forget_priors(id);
                }
            }
            self.registry
                .borrow_mut()
                .upsert(entry)
                .map_err(registry_thrown)?;
        }
        let snapshot = self.registry.borrow().snapshot().map_err(registry_thrown)?;
        for old in snapshot {
            let id = old
                .get("id")
                .and_then(V::as_js)
                .map(JsStr::lossy)
                .unwrap_or_default();
            if old.get("source").is_some_and(|s| s.is_str(source)) && !current.contains(&id) {
                self.registry
                    .borrow_mut()
                    .remove(&id)
                    .map_err(registry_thrown)?;
                self.forget_priors(&id);
            }
        }
        Ok(())
    }

    /// `syncExtensions()`: the feed's current list (none on failure, which is a source error), then the skills.
    pub fn sync_extensions(&mut self) -> Result<(), Thrown> {
        let Some(feed) = self.extension_feed.as_mut() else {
            return Ok(());
        };
        match feed.snapshot() {
            Ok(list) => {
                self.extensions = list;
                self.feed_error = false;
            }
            Err(PortFailed) => {
                self.extensions = Vec::new();
                self.feed_error = true;
            }
        }
        self.refresh_skills()
    }

    fn compute_prior(&self, id: &str, agent: Option<&str>) -> Result<f64, Thrown> {
        let registry = self.registry.borrow();
        let half_life = self.calibration.half_life_days;
        let local = registry
            .weighted_stats(id, agent, half_life, None)
            .map_err(registry_thrown)?;
        let global = registry
            .weighted_stats(id, None, half_life, None)
            .map_err(registry_thrown)?;
        Ok(usage_prior(&local, &global, &self.calibration))
    }

    fn index_of(
        &self,
        entries: &[V],
        with_prior: Option<Option<String>>,
    ) -> Result<CapabilityIndex, Thrown> {
        let mut index = CapabilityIndex::new(
            None,
            Some(lexical(&self.registry)),
            with_prior.map(|agent| prior(&self.priors, agent)),
        );
        for entry in entries {
            index.upsert(entry)?;
        }
        Ok(index)
    }

    /// `view(scope, tools, selection, agent)`: called at the turn boundary. `tools` are the data of the turn's
    /// registered tools; `blocked` the selection's blocked skill names.
    pub fn view(
        &mut self,
        scope: &str,
        tools: &[V],
        blocked: &[String],
        agent: Option<&str>,
    ) -> Result<CapabilityView, Thrown> {
        self.refresh_skills()?;
        let entries: Vec<V> = tools
            .iter()
            .map(|t| tool_entry(t, scope))
            .collect::<Result<_, _>>()?;
        self.replace(&format!("turn:{}", digest(scope)), &entries)?;
        let feed = self.extension_feed.is_some();
        let skills: Vec<IndexedSkill> = self
            .skills
            .iter()
            .filter(|s| {
                let name = s.name();
                !blocked.contains(&name)
                    && (!feed
                        || self.extensions.iter().any(|e| {
                            e.name == name
                                && match &e.agents {
                                    None => true,
                                    Some(list) => {
                                        agent.is_some_and(|a| list.iter().any(|x| x == a))
                                    }
                                }
                        }))
            })
            .cloned()
            .collect();
        let all: Vec<V> = entries
            .iter()
            .cloned()
            .chain(skills.iter().map(|s| s.entry.clone()))
            .collect();
        let agent_key = agent.map(str::to_owned);
        for e in &all {
            let id = e
                .get("id")
                .and_then(V::as_js)
                .map(JsStr::lossy)
                .unwrap_or_default();
            let key = (agent_key.clone(), id.clone());
            if !self.priors.borrow().contains_key(&key) {
                let p = self.compute_prior(&id, agent)?;
                self.priors.borrow_mut().insert(key, p);
            }
        }
        let ids: HashSet<String> = all
            .iter()
            .filter_map(|e| e.get("id").and_then(V::as_js).map(JsStr::lossy))
            .collect();
        let index = self.index_of(&all, Some(agent_key.clone()))?;
        let discovery = self.index_of(&all, None)?;
        Ok(CapabilityView {
            index,
            discovery,
            agent: agent_key,
            skills,
            ids,
        })
    }

    /// `prepare(query, view, signal)`: with a ready local embedder, vectors for the entries that have none (stored for
    /// the entry's current text) and the query's vector, cosine scores in an index of their own. Never starts or
    /// downloads a model; any failure keeps the view's index. `aborted` is the turn's signal: a cancelled turn is not a
    /// failure of the model, and is passed on.
    pub fn prepare(
        &mut self,
        query: &JsStr,
        view: &CapabilityView,
        aborted: &dyn Fn() -> bool,
    ) -> Result<Prepared, Aborted> {
        let status = self.engine.as_ref().and_then(|e| e.status());
        let Some(status) =
            status.filter(|s| s.ready && LOCAL_PROVIDERS.contains(&s.provider.as_str()))
        else {
            self.embedding_ready = false;
            return Ok(Prepared::View);
        };
        match self.vectors(query, view, &status) {
            Ok(index) => {
                self.embedding_ready = true;
                Ok(Prepared::Vectors(index))
            }
            Err(PortFailed) => {
                if aborted() {
                    return Err(Aborted);
                }
                self.embedding_ready = false;
                Ok(Prepared::View)
            }
        }
    }

    fn vectors(
        &mut self,
        query: &JsStr,
        view: &CapabilityView,
        status: &EmbedderStatus,
    ) -> Result<CapabilityIndex, PortFailed> {
        let model = status.identity.as_str();
        let rows: Vec<V> = self
            .registry
            .borrow()
            .snapshot()
            .map_err(|_| PortFailed)?
            .into_iter()
            .filter(|e| {
                e.get("id")
                    .and_then(V::as_js)
                    .is_some_and(|id| view.ids.contains(&id.lossy()))
            })
            .collect();
        let id_of = |e: &V| {
            e.get("id")
                .and_then(V::as_js)
                .map(JsStr::lossy)
                .unwrap_or_default()
        };
        let mut missing = Vec::new();
        for e in &rows {
            if self
                .registry
                .borrow()
                .vector(&id_of(e), model)
                .map_err(|_| PortFailed)?
                .is_none()
            {
                missing.push(e.clone());
            }
        }
        let mut hashes = Vec::new();
        for e in &missing {
            // `hash(e.id)!`: every row of the snapshot has one.
            hashes.push(
                self.registry
                    .borrow()
                    .hash(&id_of(e))
                    .map_err(|_| PortFailed)?
                    .unwrap_or_default(),
            );
        }
        let engine = self.engine.as_mut().ok_or(PortFailed)?;
        if !missing.is_empty() {
            let texts: Vec<JsStr> = missing
                .iter()
                .map(|e| {
                    let mut t = e
                        .get("description")
                        .map(V::to_js_string)
                        .unwrap_or_else(|| JsStr::from("undefined"));
                    t.push_str(" ");
                    if let Some(u) = e.get("useWhen").filter(|u| !matches!(u, V::Null)) {
                        t.push(&u.to_js_string());
                    }
                    t
                })
                .collect();
            let vectors = engine.embed(&texts, "passage")?;
            if vectors.len() != missing.len() {
                return Err(PortFailed);
            }
            for (i, e) in missing.iter().enumerate() {
                if vectors[i].len() as f64 != status.dimensions {
                    return Err(PortFailed);
                }
                let v: Vec<f64> = vectors[i].iter().map(|x| f64::from(*x)).collect();
                self.registry
                    .borrow_mut()
                    .put_vector(&id_of(e), &hashes[i], model, &v)
                    .map_err(|_| PortFailed)?;
            }
        }
        let head = JsStr::new(query.units()[..query.len().min(4096)].to_vec());
        let vector = engine
            .embed(&[head], "query")?
            .into_iter()
            .next()
            .ok_or(PortFailed)?;
        if vector.len() as f64 != status.dimensions || vector.iter().any(|v| !v.is_finite()) {
            return Err(PortFailed);
        }
        let vector: Vec<f64> = vector.iter().map(|x| f64::from(*x)).collect();
        let mut scores = HashMap::new();
        for e in &rows {
            let Some(v) = self
                .registry
                .borrow()
                .vector(&id_of(e), model)
                .map_err(|_| PortFailed)?
            else {
                continue;
            };
            if v.len() != vector.len() {
                continue;
            }
            let (mut dot, mut a, mut b) = (0.0f64, 0.0f64, 0.0f64);
            for i in 0..v.len() {
                dot += v[i] * vector[i];
                a += v[i] * v[i];
                b += vector[i] * vector[i];
            }
            // `a && b`: zero and NaN are false.
            let score = if a != 0.0 && !a.is_nan() && b != 0.0 && !b.is_nan() {
                dot / (a * b).sqrt()
            } else {
                0.0
            };
            scores.insert(id_of(e), score);
        }
        let mut index = CapabilityIndex::new(
            Some(Box::new(FixedScores(scores))),
            Some(lexical(&self.registry)),
            Some(prior(&self.priors, view.agent.clone())),
        );
        for e in &rows {
            index.upsert(e).map_err(|_| PortFailed)?;
        }
        Ok(index)
    }

    /// `recheck()`: the calibration again, the skills again, and every prior of every agent with recorded use computed
    /// afresh.
    pub fn recheck(&mut self) -> Result<LiveStatus, Thrown> {
        self.calibration = read_calibration(&mut self.calibration_source)?;
        self.refresh_skills()?;
        self.last_check = Some(self.clock.now());
        self.priors.borrow_mut().clear();
        let agents = self.registry.borrow().agents().map_err(registry_thrown)?;
        let snapshot = self.registry.borrow().snapshot().map_err(registry_thrown)?;
        for agent in agents {
            for e in &snapshot {
                let id = e
                    .get("id")
                    .and_then(V::as_js)
                    .map(JsStr::lossy)
                    .unwrap_or_default();
                let p = self.compute_prior(&id, Some(&agent))?;
                self.priors
                    .borrow_mut()
                    .insert((Some(agent.clone()), id), p);
            }
        }
        self.status()
    }

    /// `status()`.
    pub fn status(&self) -> Result<LiveStatus, Thrown> {
        Ok(LiveStatus {
            mode: if self.embedding_ready {
                "fts5-vectors"
            } else {
                "fts5-only"
            },
            local_embedding: if self.embedding_ready {
                "ready"
            } else {
                "unavailable"
            },
            entries: self
                .registry
                .borrow()
                .snapshot()
                .map_err(registry_thrown)?
                .len(),
            last_recheck: self.last_check,
            source_error: self.error,
        })
    }

    /// The admitted skills of the last refresh.
    pub fn skills(&self) -> &[IndexedSkill] {
        &self.skills
    }
}

/// The recheck job's argument check (`validateArgs`): nothing, `null`, or an empty object.
pub fn validate_recheck_args(args: Option<&V>) -> Result<(), &'static str> {
    match args {
        None | Some(V::Null) => Ok(()),
        Some(V::Obj(o)) if o.is_empty() => Ok(()),
        Some(_) => Err("capability recheck takes no arguments"),
    }
}
