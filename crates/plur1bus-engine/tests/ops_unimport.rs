//! C3 actual Node/Lance rollback previews, durable receipts and cross-engine recovery.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "synthetic oracle assertions"
)]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::RequestContext,
    contract::{
        AgentContext, Cancel, EngineError, MemoryRow, MemoryUnimportRequest, Principal, StoreError,
    },
    embedding::EmbeddingProvider,
    ops::{
        context::OperationContext,
        import::ImportReceipts,
        import_ledger::{ImportIndex, ImportLedger},
        unimport::{
            FileUnimportEffects, UnimportCleanup, UnimportEffects, UnimportStores, Unimporter,
        },
    },
    recall::hash_embed::HashEmbedder,
    store::{shared_row::ShareMetadata, tombstone::TombstoneRegistry, RowFilter, RowPatch, Store},
    text::json::{parse_json, TolerantJsonValue as Json},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
struct Routes {
    store: Arc<Store>,
    shared: Arc<Store>,
    shared_failure: bool,
    store_failure: AtomicBool,
    fail_after_tombstone: AtomicBool,
    writes: AtomicUsize,
    reads: AtomicUsize,
}
impl UnimportStores for Routes {
    fn existing(&self, _: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        Ok(Some(self.store.clone()))
    }
    fn writable(&self, _: &RequestContext) -> Result<Arc<Store>, StoreError> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        Ok(self.store.clone())
    }
    fn shared_pools(&self, _: &RequestContext) -> Result<Vec<Arc<Store>>, StoreError> {
        if self.shared_failure {
            Err(StoreError::Corrupt)
        } else {
            Ok(vec![self.shared.clone()])
        }
    }
    fn tombstone(&self, store: &Store, id: &str) -> Result<(), StoreError> {
        if self.store_failure.swap(false, Ordering::SeqCst) {
            return Err(StoreError::Corrupt);
        }
        store.patch(
            id,
            &RowPatch {
                status: Some("deleted".into()),
                epistemic_status: Some("invalidated".into()),
                ..Default::default()
            },
        )?;
        if self.fail_after_tombstone.swap(false, Ordering::SeqCst) {
            return Err(StoreError::Corrupt);
        }
        Ok(())
    }
}
struct Receipts {
    ledger: ImportLedger,
    fail: AtomicBool,
}
impl ImportReceipts for Receipts {
    fn load(&self, a: &str) -> Result<ImportIndex, StoreError> {
        self.ledger.load(a)
    }
    fn append(&self, a: &str, r: &Json) -> Result<(), StoreError> {
        if self.fail.swap(false, Ordering::SeqCst) {
            return Err(StoreError::Corrupt);
        }
        self.ledger.append(a, r)
    }
}
type ArchiveHook = Box<dyn FnOnce() + Send>;
struct Effects {
    after_archive: Mutex<Option<ArchiveHook>>,
    case: Value,
    root: PathBuf,
    routes: Arc<Routes>,
    once: AtomicBool,
    cancel: Cancel,
    cleanup_calls: Mutex<Vec<Value>>,
}
impl UnimportEffects for Effects {
    fn archive(
        &self,
        row: &MemoryRow,
        agent: &str,
        state: &Path,
        now: i64,
    ) -> Result<PathBuf, EngineError> {
        let path = FileUnimportEffects.archive(row, agent, state, now)?;
        if self.once.swap(false, Ordering::SeqCst) {
            let c = &self.case;
            if c["editAfterArchive"] == true {
                self.routes
                    .store
                    .patch(
                        &row.id,
                        &RowPatch {
                            text: Some("Changed during archive.".into()),
                            updated_at: Some((now + 2) as f64),
                            ..Default::default()
                        },
                    )
                    .unwrap();
            }
            if c["forgetAfterArchive"] == true {
                self.routes
                    .store
                    .patch(
                        &row.id,
                        &RowPatch {
                            status: Some("deleted".into()),
                            epistemic_status: Some("invalidated".into()),
                            ..Default::default()
                        },
                    )
                    .unwrap();
            }
            if c["forgetAfterArchive"] == true || c["registryAfterArchive"] == true {
                TombstoneRegistry::new(&self.root.join("store"), agent)
                    .unwrap()
                    .append(&parse_json(&c["tombstone"].to_string()).unwrap())
                    .unwrap();
            }
            if c["sharedAfterArchive"] == true {
                install_shared(
                    &self.routes.shared,
                    &self.root.join("store"),
                    &c["sharedRows"],
                );
            }
            if c["loseLeaseAfterArchive"] == true {
                let lock = self.root.join("store/_imports/.locks/agent.lock");
                let mut record: Value = serde_json::from_slice(&fs::read(&lock).unwrap()).unwrap();
                record["nonce"] = json!(uuid::Uuid::new_v4().to_string());
                fs::write(lock, serde_json::to_vec(&record).unwrap()).unwrap();
            }
            if c["cancelAfterArchive"] == true {
                self.cancel.cancel();
            }
        }
        if let Some(hook) = self.after_archive.lock().unwrap().take() {
            hook();
        }
        Ok(path)
    }
    fn audit(&self, workspace: &Path, entry: &Value) -> Result<(), EngineError> {
        FileUnimportEffects.audit(workspace, entry)
    }
    fn cleanup(
        &self,
        agent: &str,
        workspace: Option<&Path>,
        archive: &Path,
        ids: &[String],
    ) -> Result<Option<UnimportCleanup>, EngineError> {
        if self.case["cleanup"] != true && self.case["cleanupFailure"] != true {
            return Ok(None);
        }
        self.cleanup_calls
            .lock()
            .unwrap()
            .push(json!({"agentId":agent,"workspaceDir":workspace,"archiveDir":archive,"ids":ids}));
        if self.case["cleanupFailure"] == true {
            return Err(StoreError::Corrupt.into());
        }
        Ok(Some(UnimportCleanup {
            graph_edges_removed: 2,
            mirrors_archived: 1,
            cleanup_errors: 0,
        }))
    }
}
fn install_shared(store: &Store, base: &Path, rows: &Value) {
    for row in rows.as_array().unwrap() {
        let mut plain = row.clone();
        let metadata = ShareMetadata {
            source_memory_id: plain
                .as_object_mut()
                .unwrap()
                .remove("sourceMemoryId")
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned(),
            source_agent_id: plain
                .as_object_mut()
                .unwrap()
                .remove("sourceAgentId")
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned(),
            share_idempotency_key: plain
                .as_object_mut()
                .unwrap()
                .remove("shareIdempotencyKey")
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned(),
            share_provenance: plain
                .as_object_mut()
                .unwrap()
                .remove("shareProvenance")
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned(),
        };
        store
            .upsert_shared(&[(serde_json::from_value(plain).unwrap(), metadata)], base)
            .unwrap();
    }
}
fn wire<T: serde::Serialize>(r: Result<T, EngineError>) -> Value {
    match r {
        Ok(v) => json!({"value":v}),
        Err(EngineError::MemoryOp(e)) => json!({"error":e.code}),
        Err(e) => panic!("{e:?}"),
    }
}
fn canonical(v: &mut Value) {
    match v {
        Value::Number(n) => *v = json!(n.as_f64().unwrap()),
        Value::Array(a) => a.iter_mut().for_each(canonical),
        Value::Object(o) => o.values_mut().for_each(canonical),
        _ => {}
    }
}
fn same(mut a: Value, mut b: Value, label: &str) {
    canonical(&mut a);
    canonical(&mut b);
    assert_eq!(a, b, "{label}");
}
fn install_files(root: &Path, files: &Value) {
    for (name, text) in files.as_object().unwrap() {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let text = text.as_str().unwrap();
        let root = root.to_str().unwrap();
        if name.ends_with(".jsonl") && text.contains("<work>") {
            let expanded: String = text
                .lines()
                .map(|line| {
                    let value: Value = serde_json::from_str(line).unwrap();
                    let value = support::replace_fixture_text(&value, "<work>", root);
                    format!("{value}\n")
                })
                .collect();
            fs::write(path, expanded).unwrap();
        } else {
            fs::write(path, text.replace("<work>", root)).unwrap();
        }
    }
}
fn files(root: &Path) -> Value {
    fn walk(root: &Path, p: &Path, out: &mut BTreeMap<String, String>) {
        if !p.exists() {
            return;
        }
        if p.is_file() {
            if p.extension().is_some_and(|s| s == "lock") {
                return;
            }
            out.insert(
                p.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
                fs::read_to_string(p).unwrap(),
            );
        } else {
            for e in fs::read_dir(p).unwrap() {
                walk(root, &e.unwrap().path(), out);
            }
        }
    }
    let mut out = BTreeMap::new();
    for folder in [
        "store/_imports",
        "store/_unimports",
        "store/_links",
        "store/_rebinds",
        "_tombstones",
        "state/memory",
        "workspace/.adaptive-learning",
        "jobs",
    ] {
        walk(root, &root.join(folder), &mut out);
    }
    json!(out)
}
fn parsed_files(files: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for (k, v) in files.as_object().unwrap() {
        let text = v.as_str().unwrap();
        let parsed = if k.ends_with(".jsonl") {
            Value::Array(
                text.lines()
                    .map(|l| serde_json::from_str(l).unwrap())
                    .collect(),
            )
        } else {
            serde_json::from_str(text).unwrap_or(v.clone())
        };
        out.insert(k.clone(), parsed);
    }
    Value::Object(out)
}
fn normalize(v: &Value, root: &Path) -> Value {
    support::replace_fixture_text(v, root.to_str().unwrap(), "<work>")
}

fn normalize_files(files: &Value, root: &Path) -> Value {
    let mut files = normalize(&parsed_files(files), root);
    if let Some(lines) = files
        .get_mut("workspace/.adaptive-learning/destructive-ops.jsonl")
        .and_then(Value::as_array_mut)
    {
        for line in lines {
            if let Some(suffix) = line["archivePath"]
                .as_str()
                .and_then(|path| path.strip_prefix("<work>"))
            {
                line["archivePath"] = json!(format!(
                    "<work>{}",
                    suffix.replace(std::path::MAIN_SEPARATOR, "/")
                ));
            }
        }
    }
    files
}
fn rows(store: &Store) -> Value {
    let mut rows = store.scan(&RowFilter::default(), 100).unwrap();
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    json!(rows)
}
fn golden() -> Value {
    serde_json::from_str(include_str!("fixtures/ops/golden/unimport.json")).unwrap()
}
fn exceptions() -> Value {
    let e: Value =
        serde_json::from_str(include_str!("fixtures/ops/unimport-exceptions.json")).unwrap();
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("fixtures/ops/golden/unimport.json"))
        ),
        e["nodeGoldenSha256"]
    );
    e
}
struct Fixture {
    host: Arc<support::TestHost>,
    root: tempfile::TempDir,
    routes: Arc<Routes>,
    effects: Arc<Effects>,
    ops: Unimporter,
    p: Principal,
    a: AgentContext,
    req: MemoryUnimportRequest,
    cancel: Cancel,
}
impl Fixture {
    fn new(g: &Value, c: &Value, recover: bool) -> Self {
        let root = support::canonical_tempdir();
        let base = root.path().join("store");
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let host = Arc::new(support::TestHost::new(root.path().join("state")));
        host.set_workspace("agent", workspace);
        host.time
            .store(g["now"].as_i64().unwrap(), Ordering::SeqCst);
        let original = c;
        let c = support::replace_fixture_text(original, "<work>", root.path().to_str().unwrap());
        let mut identity = HashEmbedder::new().identity().clone();
        identity.dimension = 4.into();
        let store = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
        let shared =
            Arc::new(Store::create_shared(&root.path().join("shared"), &identity, 4).unwrap());
        let initial = if recover {
            &c["checkpoints"][0]["rows"]
        } else {
            &c["initialRows"]
        };
        for row in initial.as_array().unwrap() {
            let row: MemoryRow = serde_json::from_value(row.clone()).unwrap();
            store.upsert(&[row]).unwrap();
        }
        install_shared(&shared, &base, &c["initialSharedRows"]);
        install_files(
            root.path(),
            if recover {
                &original["checkpoints"][0]["files"]
            } else {
                &original["initialFiles"]
            },
        );
        let routes = Arc::new(Routes {
            store,
            shared,
            shared_failure: c["sharedFailure"] == true,
            store_failure: AtomicBool::new(!recover && c["storeFailure"] == true),
            fail_after_tombstone: AtomicBool::new(c["storeFailureAfterDelete"] == true),
            writes: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
        });
        let cancel = Cancel::never();
        let effects = Arc::new(Effects {
            after_archive: Mutex::new(None),
            case: c.clone(),
            root: root.path().to_owned(),
            routes: routes.clone(),
            once: AtomicBool::new(!recover),
            cancel: cancel.clone(),
            cleanup_calls: Mutex::new(vec![]),
        });
        let receipts = Arc::new(Receipts {
            ledger: ImportLedger::new(&base),
            fail: AtomicBool::new(!recover && c["receiptFailure"] == true),
        });
        let ops = Unimporter::new(
            Arc::new(OperationContext::new(host.clone())),
            routes.clone(),
            receipts,
            effects.clone(),
            base,
            if c["jobs"] == true {
                Some(root.path().join("jobs"))
            } else {
                None
            },
        );
        Self {
            host,
            root,
            routes,
            effects,
            ops,
            p: serde_json::from_value(g["principal"].clone()).unwrap(),
            a: serde_json::from_value(c.get("context").unwrap_or(&g["agent"]).clone()).unwrap(),
            req: serde_json::from_value(c["request"].clone()).unwrap(),
            cancel,
        }
    }
    fn call(&self) -> Value {
        wire(self.ops.unimport(&self.req, &self.p, &self.a, &self.cancel))
    }
}
#[test]
fn actual_node_previews_are_non_creating_and_obey_declared_guards() {
    let g = golden();
    let e = exceptions();
    for c in g["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let mut f = Fixture::new(&g, c, false);
        let before = files(f.root.path());
        f.req.dry_run = Some(true);
        let expected = e["cases"][name]
            .get("preview")
            .unwrap_or(&c["preview"])
            .clone();
        same(f.call(), expected, &format!("{name}:preview"));
        same(
            files(f.root.path()),
            before,
            &format!("{name}:preview files"),
        );
        same(
            rows(&f.routes.store),
            c["initialRows"].clone(),
            &format!("{name}:preview rows"),
        );
        assert_eq!(f.routes.writes.load(Ordering::SeqCst), 0, "{name}");
        assert!(
            !f.root.path().join("store/_imports/.locks").exists(),
            "{name}"
        );
    }
}
#[test]
fn actual_node_apply_rows_receipts_archives_and_recovery() {
    let g = golden();
    let e = exceptions();
    for c in g["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let recover = c.get("crash").is_some();
        let f = Fixture::new(&g, c, recover);
        if c["cancelBefore"] == true {
            f.cancel.cancel();
        }
        let results = if recover {
            vec![f.call()]
        } else {
            (0..if c["repeat"] == true { 2 } else { 1 })
                .map(|i| {
                    if i == 1 && c["repairAudit"] == true {
                        fs::remove_file(f.root.path().join("workspace/.adaptive-learning"))
                            .unwrap();
                    }
                    f.call()
                })
                .collect::<Vec<_>>()
        };
        let reference = e["cases"][name].get("results").unwrap_or(&c["results"]);
        let expected = if recover {
            json!([reference[1]])
        } else {
            reference.clone()
        };
        same(json!(results), expected, &format!("{name}:apply"));
        same(
            normalize(&rows(&f.routes.store), f.root.path()),
            e["cases"][name].get("rows").unwrap_or(&c["rows"]).clone(),
            &format!("{name}:rows"),
        );
        same(
            normalize_files(&files(f.root.path()), f.root.path()),
            parsed_files(&e["cases"][name].get("files").unwrap_or(&c["files"]).clone()),
            &format!("{name}:files"),
        );
        if !recover {
            same(
                normalize(
                    &json!(*f.effects.cleanup_calls.lock().unwrap()),
                    f.root.path(),
                ),
                c["cleanupCalls"].clone(),
                &format!("{name}:cleanup"),
            );
        }
    }
}

#[test]
fn lost_nonce_after_archive_cannot_write_intent_or_mutate_the_card() {
    let g = golden();
    let mut c = g["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "apply-repeat")
        .unwrap()
        .clone();
    c["loseLeaseAfterArchive"] = json!(true);
    let f = Fixture::new(&g, &c, false);
    assert_eq!(f.call(), json!({"error":"lock-lost"}));
    same(
        rows(&f.routes.store),
        c["initialRows"].clone(),
        "fenced row",
    );
    assert!(!f.root.path().join("store/_unimports").exists());
    let ledger = ImportLedger::new(&f.root.path().join("store"));
    assert_eq!(ledger.read_lines("agent").unwrap().len(), 1);
    assert!(f
        .root
        .path()
        .join("store/_imports/.locks/agent.lock")
        .exists());
}
#[test]
fn malformed_registry_never_repairs_or_authorizes_a_preview() {
    let g = golden();
    let c = g["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "default-preview")
        .unwrap();
    let f = Fixture::new(&g, c, false);
    let path = f.root.path().join("_tombstones/agent.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, b"{torn").unwrap();
    assert_eq!(f.call(), json!({"error":"storage"}));
    assert_eq!(fs::read(&path).unwrap(), b"{torn");
    assert_eq!(f.routes.writes.load(Ordering::SeqCst), 0);
    assert!(!f.root.path().join("store/_imports/.locks").exists());
}
#[test]
fn independent_unimporters_serialize_and_commit_one_rollback() {
    let g = golden();
    let c = g["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "apply-repeat")
        .unwrap();
    let f = Fixture::new(&g, c, false);
    let host = Arc::new(support::TestHost::new(f.root.path().join("state")));
    host.set_workspace("agent", f.root.path().join("workspace"));
    host.time
        .store(g["now"].as_i64().unwrap(), Ordering::SeqCst);
    let second = Unimporter::new(
        Arc::new(OperationContext::new(host.clone())),
        f.routes.clone(),
        Arc::new(ImportLedger::new(&f.root.path().join("store"))),
        Arc::new(FileUnimportEffects),
        f.root.path().join("store"),
        None,
    );
    let (a, b) = std::thread::scope(|scope| {
        let a = scope.spawn(|| f.call());
        let b = scope.spawn(|| wire(second.unimport(&f.req, &f.p, &f.a, &Cancel::never())));
        (a.join().unwrap(), b.join().unwrap())
    });
    assert_eq!(
        a["value"]["unimported"].as_f64().unwrap() + b["value"]["unimported"].as_f64().unwrap(),
        1.
    );
    assert_eq!(
        a["value"]["alreadyUnimported"].as_f64().unwrap()
            + b["value"]["alreadyUnimported"].as_f64().unwrap(),
        1.
    );
    same(
        normalize_files(&files(f.root.path()), f.root.path()),
        parsed_files(&c["files"].clone()),
        "one durable rollback",
    );
}

#[test]
fn same_timestamp_reimport_recovers_its_own_intent_after_soft_delete() {
    let g = golden();
    let mut c = g["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "reimport-same-run-same-time")
        .unwrap()
        .clone();
    c["storeFailureAfterDelete"] = json!(true);
    let f = Fixture::new(&g, &c, false);
    assert_eq!(f.call()["value"]["failed"], 1.);
    assert_eq!(f.call()["value"]["unimported"], 1.);
    assert_eq!(f.call()["value"]["alreadyUnimported"], 1.);
    let ledger = ImportLedger::new(&f.root.path().join("store"));
    assert_eq!(ledger.read_lines("agent").unwrap().len(), 4);
    assert!(ledger.load("agent").unwrap().by_card_id.is_empty());
    let sidecar =
        fs::read_to_string(f.root.path().join("store/_unimports/agent/run-1.jsonl")).unwrap();
    let markers: Vec<Value> = sidecar
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(
        markers
            .iter()
            .filter(|m| m["kind"] == "intent" && m["importGeneration"] == 2)
            .count(),
        1
    );
    assert_eq!(
        markers
            .iter()
            .filter(|m| m["kind"] == "done" && m["importGeneration"] == 2)
            .count(),
        1
    );
}

#[path = "support/unimport_graph.rs"]
mod graph;
