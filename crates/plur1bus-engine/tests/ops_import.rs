//! Actual C3 Node/Lance import outcomes, row defaults, receipts and rollback/backfill recovery.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "synthetic oracle assertions"
)]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::RequestContext,
    contract::{Cancel, EmbedError, EngineError, MemoryRow, StoreError, VectorSpaceIdentity},
    embedding::{EmbedKind, EmbeddingProvider},
    ops::{
        context::OperationContext,
        import::{ImportReceipts, ImportStores, Importer},
        import_ledger::{ImportIndex, ImportLedger},
        import_row::ImportEncoding,
    },
    recall::hash_embed::HashEmbedder,
    store::{RowFilter, Store},
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use serde_json::{json, Value};
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};

struct Routes {
    store: Arc<Store>,
    fail_delete: AtomicBool,
    writes: AtomicUsize,
}
impl ImportStores for Routes {
    fn existing(&self, _: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        Ok(Some(self.store.clone()))
    }
    fn writable(&self, _: &RequestContext) -> Result<Arc<Store>, StoreError> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        Ok(self.store.clone())
    }
    fn delete(&self, store: &Store, id: &str) -> Result<(), StoreError> {
        if self.fail_delete.swap(false, Ordering::SeqCst) {
            return Err(StoreError::Unavailable);
        }
        store.delete(&[id]).map(|_| ())
    }
}
struct Receipts {
    ledger: ImportLedger,
    fail: AtomicBool,
}
impl ImportReceipts for Receipts {
    fn load(&self, agent: &str) -> Result<ImportIndex, StoreError> {
        self.ledger.load(agent)
    }
    fn append(&self, agent: &str, row: &Json) -> Result<(), StoreError> {
        if self.fail.swap(false, Ordering::SeqCst) {
            return Err(StoreError::Unavailable);
        }
        self.ledger.append(agent, row)
    }
}
struct Provider {
    identity: VectorSpaceIdentity,
    calls: AtomicUsize,
    fail: bool,
    mismatch: bool,
}
impl EmbeddingProvider for Provider {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        _: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        assert_eq!(kind, EmbedKind::Passage);
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.fail {
            return Err(EmbedError::Unavailable);
        }
        Ok(if self.mismatch {
            vec![]
        } else {
            texts.iter().map(|_| vec![1., 0., 0., 0.]).collect()
        })
    }
}
fn wire<T: serde::Serialize>(result: Result<T, EngineError>) -> Value {
    match result {
        Ok(v) => json!({"value":v}),
        Err(EngineError::MemoryOp(e)) => json!({"error":e.code}),
        Err(e) => panic!("unexpected {e:?}"),
    }
}
fn canonical(value: &mut Json, workspace: Option<&str>) {
    match value {
        Json::Number(n) => {
            *n = ryu_js::Buffer::new()
                .format(n.parse::<f64>().unwrap())
                .to_owned()
        }
        Json::Array(items) => items.iter_mut().for_each(|v| canonical(v, workspace)),
        Json::Object(fields) => {
            for (key, value) in fields.iter_mut() {
                if workspace.is_some() && *key == JsString::from("binding") {
                    *value = Json::String("__WORKSPACE_BINDING_DIGEST__".into());
                } else {
                    canonical(value, workspace);
                }
            }
            fields.sort_by(|(a, _), (b, _)| a.as_utf16_units().cmp(b.as_utf16_units()));
        }
        Json::String(s) if workspace.is_some_and(|w| *s == JsString::from(w)) => {
            *s = "__WORKSPACE__".into()
        }
        _ => {}
    }
}
fn same(actual: &str, expected: &str, workspace: Option<&str>, label: &str) {
    let mut a = parse_json(actual).unwrap();
    let mut b = parse_json(expected).unwrap();
    canonical(&mut a, workspace);
    canonical(&mut b, None);
    assert_eq!(a, b, "{label}");
}
#[test]
fn c3_import_outcomes_rows_and_receipts_match_actual_node() {
    use sha2::{Digest, Sha256};
    let exceptions: Value =
        serde_json::from_str(include_str!("fixtures/ops/import-exceptions.json")).unwrap();
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("fixtures/ops/golden/import.json"))
        ),
        exceptions["nodeGoldenSha256"]
    );
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/import.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let root = support::canonical_tempdir();
        let base = root.path().join("store");
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let host = Arc::new(support::TestHost::new(root.path().join("state")));
        if case["noWorkspace"] != true {
            host.set_workspace("agent", workspace);
        }
        let principal = serde_json::from_value(
            case.get("principal")
                .unwrap_or(&golden["principal"])
                .clone(),
        )
        .unwrap();
        let agent = serde_json::from_value(case.get("context").unwrap_or(&golden["agent"]).clone())
            .unwrap();
        let ctx = RequestContext::build(&principal, &agent, host.as_ref()).unwrap();
        let mut identity = HashEmbedder::new().identity().clone();
        identity.dimension = 4.into();
        let store = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
        for row in case["initialRows"].as_array().unwrap() {
            let row: MemoryRow =
                serde_json::from_str(&row.to_string().replace("__WORKSPACE__", &ctx.workspace_key))
                    .unwrap();
            store.upsert(&[row]).unwrap();
        }
        for row in case["tombstones"].as_array().unwrap() {
            plur1bus_engine::store::tombstone::TombstoneRegistry::new(&base, "agent")
                .unwrap()
                .append(&parse_json(&row.to_string()).unwrap())
                .unwrap();
        }
        let ledger = ImportLedger::new(&base);
        let Json::Array(lines) = parse_json(case["initialLinesJson"].as_str().unwrap()).unwrap()
        else {
            panic!("lines")
        };
        if !lines.is_empty() {
            let path = base.join("_imports/agent.jsonl");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(
                path,
                lines
                    .iter()
                    .map(|r| format!("{}\n", write_json(r)))
                    .collect::<String>(),
            )
            .unwrap();
        }
        let receipts = Arc::new(Receipts {
            ledger,
            fail: AtomicBool::new(case["appendFailure"] == true),
        });
        let routes = Arc::new(Routes {
            store: store.clone(),
            fail_delete: AtomicBool::new(case["rollbackFailure"] == true),
            writes: AtomicUsize::new(0),
        });
        let provider = Arc::new(Provider {
            identity,
            calls: AtomicUsize::new(0),
            fail: case["embedFailure"] == true,
            mismatch: case["embedMismatch"] == true,
        });
        let importer = Importer::new(
            Arc::new(OperationContext::new(host)),
            routes.clone(),
            provider.clone(),
            receipts.clone(),
            base.clone(),
            ImportEncoding::default(),
        );
        let request = serde_json::from_value(case["request"].clone()).unwrap();
        let now = golden["now"].as_i64().unwrap();
        let results = (0..if case["repeat"] == true { 2 } else { 1 })
            .map(|_| wire(importer.import_at(&request, &principal, &agent, &Cancel::never(), now)))
            .collect::<Vec<_>>();
        let label = case["name"].as_str().unwrap();
        let expected = exceptions["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["name"] == label)
            .unwrap_or(case);
        same(
            &json!(results).to_string(),
            &expected["results"].to_string(),
            None,
            label,
        );
        let mut rows = store.scan(&RowFilter::default(), 1000).unwrap();
        rows.sort_by(|a, b| a.id.cmp(&b.id));
        let workspace = rows
            .iter()
            .any(|r| !r.workspace_key.is_empty())
            .then_some(ctx.workspace_key.as_str());
        same(
            &serde_json::to_string(&rows).unwrap(),
            &case["rows"].to_string(),
            workspace,
            label,
        );
        let lines = Json::Array(
            receipts
                .ledger
                .read_lines("agent")
                .unwrap()
                .into_iter()
                .map(|r| r.raw)
                .collect(),
        );
        same(
            &write_json(&lines),
            expected["linesJson"].as_str().unwrap(),
            workspace,
            label,
        );
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            case["embeds"].as_u64().unwrap() as usize,
            "{label}"
        );
        if case["request"]["dryRun"] == true {
            assert_eq!(routes.writes.load(Ordering::SeqCst), 0);
            assert!(!base.join("_imports").exists());
        }
    }
}

struct ConcurrentProvider {
    inner: Provider,
    ready: std::sync::Barrier,
}
impl EmbeddingProvider for ConcurrentProvider {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.inner.identity
    }
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        self.ready.wait();
        self.inner.embed(texts, kind, cancel)
    }
}
#[test]
fn independent_store_handles_recheck_after_embedding_and_do_not_duplicate_a_receipt() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/import.json")).unwrap();
    let root = support::canonical_tempdir();
    let base = root.path().join("store");
    let mut identity = HashEmbedder::new().identity().clone();
    identity.dimension = 4.into();
    let first = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
    let second = Arc::new(
        Store::open(
            &base.join("agent"),
            plur1bus_engine::store::OpenMode::ReadWrite,
            Some(&identity),
        )
        .unwrap(),
    );
    let provider = Arc::new(ConcurrentProvider {
        inner: Provider {
            identity: identity.clone(),
            calls: AtomicUsize::new(0),
            fail: false,
            mismatch: false,
        },
        ready: std::sync::Barrier::new(2),
    });
    let receipts = Arc::new(Receipts {
        ledger: ImportLedger::new(&base),
        fail: AtomicBool::new(false),
    });
    let context = Arc::new(OperationContext::new(Arc::new(support::TestHost::new(
        root.path().join("state"),
    ))));
    let make = |store| {
        Importer::new(
            context.clone(),
            Arc::new(Routes {
                store,
                fail_delete: AtomicBool::new(false),
                writes: AtomicUsize::new(0),
            }),
            provider.clone(),
            receipts.clone(),
            base.clone(),
            ImportEncoding::default(),
        )
    };
    let a = make(first);
    let b = make(second);
    let request = serde_json::from_value(golden["cases"][0]["request"].clone()).unwrap();
    let principal = serde_json::from_value(golden["principal"].clone()).unwrap();
    let agent = serde_json::from_value(golden["agent"].clone()).unwrap();
    let results = std::thread::scope(|scope| {
        let one = scope.spawn(|| {
            wire(a.import_at(
                &request,
                &principal,
                &agent,
                &Cancel::never(),
                1_800_000_000_000,
            ))
        });
        let two = scope.spawn(|| {
            wire(b.import_at(
                &request,
                &principal,
                &agent,
                &Cancel::never(),
                1_800_000_000_000,
            ))
        });
        [one.join().unwrap(), two.join().unwrap()]
    });
    assert_eq!(
        results
            .iter()
            .filter(|r| r["value"]["created"] == 1.)
            .count(),
        1,
        "{results:?}"
    );
    assert_eq!(
        results
            .iter()
            .filter(|r| r["value"]["matchedExisting"] == 1.)
            .count(),
        1,
        "{results:?}"
    );
    assert_eq!(receipts.ledger.read_lines("agent").unwrap().len(), 1);
    let latest = Store::open(
        &base.join("agent"),
        plur1bus_engine::store::OpenMode::ReadOnly,
        Some(&identity),
    )
    .unwrap();
    assert_eq!(latest.count(&RowFilter::default()).unwrap(), 1);
}

struct FinishingProvider {
    identity: VectorSpaceIdentity,
    host: Arc<support::TestHost>,
    abort: bool,
}
impl EmbeddingProvider for FinishingProvider {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }
    fn embed(
        &self,
        texts: &[String],
        _: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        self.host.time.store(2000, Ordering::SeqCst);
        if self.abort {
            cancel.cancel();
        }
        Ok(texts.iter().map(|_| vec![1., 0., 0., 0.]).collect())
    }
}
#[test]
fn cancellation_after_embedding_writes_nothing_and_import_receipt_uses_write_time() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/import.json")).unwrap();
    for abort in [false, true] {
        let root = support::canonical_tempdir();
        let base = root.path().join("store");
        let host = Arc::new(support::TestHost::new(root.path().join("state")));
        host.time.store(1000, Ordering::SeqCst);
        let mut identity = HashEmbedder::new().identity().clone();
        identity.dimension = 4.into();
        let store = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
        let routes = Arc::new(Routes {
            store: store.clone(),
            fail_delete: AtomicBool::new(false),
            writes: AtomicUsize::new(0),
        });
        let receipts = Arc::new(Receipts {
            ledger: ImportLedger::new(&base),
            fail: AtomicBool::new(false),
        });
        let importer = Importer::new(
            Arc::new(OperationContext::new(host.clone())),
            routes.clone(),
            Arc::new(FinishingProvider {
                identity,
                host,
                abort,
            }),
            receipts.clone(),
            base.clone(),
            ImportEncoding::default(),
        );
        let request = serde_json::from_value(golden["cases"][0]["request"].clone()).unwrap();
        let principal = serde_json::from_value(golden["principal"].clone()).unwrap();
        let agent = serde_json::from_value(golden["agent"].clone()).unwrap();
        let result = wire(importer.import(&request, &principal, &agent, &Cancel::never()));
        if abort {
            assert_eq!(result["value"]["cards"][0]["reason"], "aborted");
            assert_eq!(store.count(&RowFilter::default()).unwrap(), 0);
            assert!(!base.join("_imports").exists());
            assert_eq!(routes.writes.load(Ordering::SeqCst), 0);
        } else {
            assert_eq!(result["value"]["created"], 1.);
            let rows = store.scan(&RowFilter::default(), 10).unwrap();
            assert_eq!(rows[0].created_at.as_f64(), Some(1000.));
            assert_eq!(rows[0].source_timestamp.as_f64(), Some(2000.));
            assert_eq!(rows[0].updated_at.as_f64(), Some(2000.));
            let receipt: Value = serde_json::from_str(&write_json(
                &receipts.ledger.read_lines("agent").unwrap()[0].raw,
            ))
            .unwrap();
            assert_eq!(receipt["importedAt"], 2000.);
        }
    }
}

#[test]
fn dry_run_with_torn_tombstone_registry_fails_closed_without_repair() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/import.json")).unwrap();
    let root = support::canonical_tempdir();
    let base = root.path().join("store");
    let mut identity = HashEmbedder::new().identity().clone();
    identity.dimension = 4.into();
    let store = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
    let routes = Arc::new(Routes {
        store: store.clone(),
        fail_delete: AtomicBool::new(false),
        writes: AtomicUsize::new(0),
    });
    let receipts = Arc::new(Receipts {
        ledger: ImportLedger::new(&base),
        fail: AtomicBool::new(false),
    });
    let provider = Arc::new(Provider {
        identity,
        calls: AtomicUsize::new(0),
        fail: false,
        mismatch: false,
    });
    let registry =
        plur1bus_engine::store::tombstone::TombstoneRegistry::new(&base, "agent").unwrap();
    fs::create_dir_all(registry.path().parent().unwrap()).unwrap();
    fs::write(registry.path(), "{torn").unwrap();
    let importer = Importer::new(
        Arc::new(OperationContext::new(Arc::new(support::TestHost::new(
            root.path().join("state"),
        )))),
        routes.clone(),
        provider.clone(),
        receipts,
        base.clone(),
        ImportEncoding::default(),
    );
    let mut request = golden["cases"][0]["request"].clone();
    request["dryRun"] = json!(true);
    let principal = serde_json::from_value(golden["principal"].clone()).unwrap();
    let agent = serde_json::from_value(golden["agent"].clone()).unwrap();
    assert_eq!(
        wire(importer.import_at(
            &serde_json::from_value(request).unwrap(),
            &principal,
            &agent,
            &Cancel::never(),
            1000
        )),
        json!({"error":"storage"})
    );
    assert_eq!(fs::read_to_string(registry.path()).unwrap(), "{torn");
    assert!(!registry.path().with_extension("corrupt.log").exists());
    assert!(!base.join("_imports").exists());
    assert_eq!(routes.writes.load(Ordering::SeqCst), 0);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    assert_eq!(store.count(&RowFilter::default()).unwrap(), 0);
}
