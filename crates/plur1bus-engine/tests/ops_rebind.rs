//! Real C3 Node/Lance ownership migrations, recovery and conservative reversal.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::RequestContext,
    contract::{Cancel, EngineError, MemoryRow, Principal, StoreError},
    embedding::EmbeddingProvider,
    ops::{
        context::OperationContext,
        rebind::{RebindStores, Rebinder},
        rebind_ledger::RebindLedger,
    },
    recall::hash_embed::HashEmbedder,
    store::{tombstone::TombstoneRegistry, RowFilter, RowPatch, Store},
    text::json::parse_json,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};
struct Routes {
    store: Arc<Store>,
    missing: bool,
    fail: AtomicBool,
    reads: AtomicUsize,
    writes: AtomicUsize,
    cancel_after_patch: Option<Cancel>,
}
impl RebindStores for Routes {
    fn existing(&self, _: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        Ok((!self.missing).then(|| self.store.clone()))
    }
    fn writable(&self, _: &RequestContext) -> Result<Arc<Store>, StoreError> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        Ok(self.store.clone())
    }
    fn patch_owner(&self, store: &Store, id: &str, owner: &str) -> Result<(), StoreError> {
        if self.fail.swap(false, Ordering::SeqCst) {
            return Err(StoreError::Corrupt);
        }
        store.patch(
            id,
            &RowPatch {
                owner_user_id: Some(owner.into()),
                ..Default::default()
            },
        )?;
        if let Some(cancel) = &self.cancel_after_patch {
            cancel.cancel();
        }
        Ok(())
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
fn rows(store: &Store) -> Value {
    let mut rows = store.scan(&RowFilter::default(), 100).unwrap();
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    json!(rows)
}
fn files(root: &Path) -> BTreeMap<String, String> {
    fn walk(root: &Path, p: &Path, out: &mut BTreeMap<String, String>) {
        if !p.exists() {
            return;
        }
        for e in fs::read_dir(p).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(root, &p, out)
            } else {
                out.insert(
                    p.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                    fs::read_to_string(p).unwrap(),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}
fn install_files(root: &Path, files: &Value) {
    for (name, text) in files.as_object().unwrap() {
        let p = root.join(name);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text.as_str().unwrap()).unwrap();
    }
}
fn normalized(value: Value, rid: &str) -> Value {
    if rid.is_empty() {
        value
    } else {
        serde_json::from_str(&value.to_string().replace(rid, "<rebind-1>")).unwrap()
    }
}
fn disk_value(files: BTreeMap<String, String>) -> Value {
    let mut out = serde_json::Map::new();
    for (k, v) in files {
        out.insert(
            k,
            Value::Array(
                v.lines()
                    .map(|s| serde_json::from_str(s).unwrap())
                    .collect(),
            ),
        );
    }
    Value::Object(out)
}
#[test]
fn c3_rebind_and_unbind_match_actual_node() {
    let g: Value = serde_json::from_str(include_str!("fixtures/ops/golden/rebind.json")).unwrap();
    let exceptions: Value =
        serde_json::from_str(include_str!("fixtures/ops/rebind-exceptions.json")).unwrap();
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("fixtures/ops/golden/rebind.json"))
        ),
        exceptions["nodeGoldenSha256"]
    );
    for case in g["cases"].as_array().unwrap() {
        let temp = support::canonical_tempdir();
        let base = temp.path().join("store");
        let workspace = temp.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let host = Arc::new(support::TestHost::new(temp.path().join("state")));
        host.set_workspace("agent", workspace.clone());
        host.set_workspace("other", workspace);
        host.time
            .store(g["now"].as_i64().unwrap(), Ordering::SeqCst);
        let mut identity = HashEmbedder::new().identity().clone();
        identity.dimension = 4.into();
        let store = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
        let initial: Vec<MemoryRow> = serde_json::from_value(case["initialRows"].clone()).unwrap();
        for row in initial {
            store.upsert(&[row]).unwrap();
        }
        install_files(&base.join("_rebinds"), &case["initialFiles"]);
        let tombstone = || {
            TombstoneRegistry::new(&base, "agent")
                .unwrap()
                .append(&parse_json(&case["tombstone"].to_string()).unwrap())
                .unwrap()
        };
        if case.get("tombstoneBefore") == Some(&json!(true)) {
            tombstone();
        }
        let routes = Arc::new(Routes {
            store: store.clone(),
            missing: case["missing"] == true,
            fail: AtomicBool::new(case["patchFailure"] == true),
            reads: AtomicUsize::new(0),
            writes: AtomicUsize::new(0),
            cancel_after_patch: None,
        });
        let ops = Rebinder::new(
            Arc::new(OperationContext::new(host)),
            routes.clone(),
            base.clone(),
        );
        let p: Principal = serde_json::from_value(g["principal"].clone()).unwrap();
        let a = serde_json::from_value(case.get("context").unwrap_or(&g["agent"]).clone()).unwrap();
        let req = serde_json::from_value(case["request"].clone()).unwrap();
        let results = (0..if case["repeat"] == true { 2 } else { 1 })
            .map(|_| wire(ops.rebind(&req, &p, &a, &Cancel::never())))
            .collect::<Vec<_>>();
        let before = rows(&store);
        let rid = RebindLedger::new(&base)
            .list_applied()
            .unwrap()
            .first()
            .map(|(id, _)| id.clone())
            .unwrap_or_default();
        let mut unbind_results = vec![];
        if case["unbind"] == true {
            if let Some(timestamp) = case.get("ledgerTimestamp") {
                let path = base.join("_rebinds").join(format!("{rid}.jsonl"));
                let lines = fs::read_to_string(&path)
                    .unwrap()
                    .lines()
                    .map(|line| {
                        let mut row: Value = serde_json::from_str(line).unwrap();
                        if row["kind"] == "card" {
                            row["fromUpdatedAt"] = timestamp.clone();
                        }
                        format!("{row}\n")
                    })
                    .collect::<String>();
                fs::write(path, lines).unwrap();
            }
            let id = g["id"].as_str().unwrap();
            if let Some(change) = case.get("change") {
                let mut row = serde_json::to_value(store.get(id).unwrap().unwrap()).unwrap();
                for (k, v) in change.as_object().unwrap() {
                    row[k] = v.clone();
                }
                store
                    .upsert(&[serde_json::from_value(row).unwrap()])
                    .unwrap();
            }
            if case["delete"] == true {
                store.delete(&[id]).unwrap();
            }
            if case["tombstoneAfter"] == true {
                tombstone();
            }
            let req = serde_json::from_value(
                json!({"rebindId":rid.to_uppercase(),"dryRun":case["dryUnbind"]==true}),
            )
            .unwrap();
            let up = serde_json::from_value(
                case.get("unbindPrincipal")
                    .unwrap_or(&g["principal"])
                    .clone(),
            )
            .unwrap();
            let ua = serde_json::from_value(g["agent"].clone()).unwrap();
            for _ in 0..if case["repeatUnbind"] == true { 2 } else { 1 } {
                unbind_results.push(wire(ops.unbind(&req, &up, &ua, &Cancel::never())));
            }
        }
        let label = case["name"].as_str().unwrap();
        let override_ = exceptions["cases"].get(label);
        let expected = |key: &str| {
            override_
                .and_then(|v| v.get(key))
                .unwrap_or(&case[key])
                .clone()
        };
        let normalization = if case["headerClaimDisagree"] == true {
            ""
        } else {
            &rid
        };
        same(
            normalized(json!(results), normalization),
            expected("results"),
            &format!("{label}/results"),
        );
        same(
            before,
            expected("beforeUnbindRows"),
            &format!("{label}/before"),
        );
        same(
            normalized(json!(unbind_results), normalization),
            expected("unbindResults"),
            &format!("{label}/unbind"),
        );
        same(rows(&store), expected("rows"), &format!("{label}/rows"));
        let expected_files = serde_json::from_value(expected("files")).unwrap();
        same(
            normalized(disk_value(files(&base.join("_rebinds"))), normalization),
            disk_value(expected_files),
            &format!("{label}/files"),
        );
        assert_eq!(
            routes.reads.load(Ordering::SeqCst),
            expected("reads").as_u64().unwrap() as usize,
            "{label}/reads"
        );
        assert_eq!(
            routes.writes.load(Ordering::SeqCst),
            expected("writes").as_u64().unwrap() as usize,
            "{label}/writes"
        );
    }
}

#[test]
fn cancellation_before_apply_creates_nothing_and_mid_apply_resumes_durable_intents() {
    let g: Value = serde_json::from_str(include_str!("fixtures/ops/golden/rebind.json")).unwrap();
    let case = g["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "apply-repeat")
        .unwrap();
    let temp = support::canonical_tempdir();
    let base = temp.path().join("store");
    let workspace = temp.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let host = Arc::new(support::TestHost::new(temp.path().join("state")));
    host.set_workspace("agent", workspace);
    host.time
        .store(g["now"].as_i64().unwrap(), Ordering::SeqCst);
    let mut identity = HashEmbedder::new().identity().clone();
    identity.dimension = 4.into();
    let store = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
    let row: MemoryRow = serde_json::from_value(case["initialRows"][0].clone()).unwrap();
    let mut second = row.clone();
    second.id = "44444444-4444-4444-8444-444444444444".into();
    store.upsert(std::slice::from_ref(&row)).unwrap();
    store.upsert(&[second]).unwrap();
    let mid = Cancel::never();
    let routes = Arc::new(Routes {
        store: store.clone(),
        missing: false,
        fail: AtomicBool::new(false),
        reads: AtomicUsize::new(0),
        writes: AtomicUsize::new(0),
        cancel_after_patch: Some(mid.clone()),
    });
    let context = Arc::new(OperationContext::new(host));
    let ops = Rebinder::new(context.clone(), routes.clone(), base.clone());
    let p = serde_json::from_value(g["principal"].clone()).unwrap();
    let a = serde_json::from_value(g["agent"].clone()).unwrap();
    let req = serde_json::from_value(case["request"].clone()).unwrap();
    let early = Cancel::never();
    early.cancel();
    assert!(matches!(
        ops.rebind(&req, &p, &a, &early),
        Err(EngineError::Cancelled(_))
    ));
    assert_eq!(routes.writes.load(Ordering::SeqCst), 0);
    assert!(!base.join("_rebinds").exists());
    assert!(matches!(
        ops.rebind(&req, &p, &a, &mid),
        Err(EngineError::Cancelled(_))
    ));
    let ledger = RebindLedger::new(&base);
    let applied = ledger.list_applied().unwrap();
    assert_eq!(applied.len(), 1);
    assert_eq!(applied[0].1.cards.len(), 1);
    let from = g["from"].as_str().unwrap();
    assert_eq!(
        store
            .scan(
                &RowFilter {
                    owner_user_id: Some(from.into()),
                    ..Default::default()
                },
                10
            )
            .unwrap()
            .len(),
        1
    );
    let resumed = wire(ops.rebind(&req, &p, &a, &Cancel::never()));
    assert_eq!(resumed["value"]["matched"], 1);
    assert_eq!(resumed["value"]["rebound"], 1);
    assert_eq!(ledger.load(&applied[0].0).unwrap().cards.len(), 2);
    let reversed = wire(ops.unbind(
        &serde_json::from_value(json!({"rebindId":applied[0].0})).unwrap(),
        &p,
        &a,
        &Cancel::never(),
    ));
    assert_eq!(reversed["value"]["unbound"], 2);
    assert_eq!(
        store
            .scan(
                &RowFilter {
                    owner_user_id: Some(from.into()),
                    ..Default::default()
                },
                10
            )
            .unwrap()
            .len(),
        2
    );
    assert!(ledger.read_claim(from).unwrap().is_none());
    context.close();
    assert_eq!(
        wire(ops.rebind(&req, &p, &a, &Cancel::never())),
        json!({"error":"storage"})
    );
}
