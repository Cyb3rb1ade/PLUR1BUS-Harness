//! Node parity for the in-memory checkpoint map and timestamp precedence.
#![cfg_attr(test, allow(clippy::unwrap_used))]

use plur1bus_engine::{
    contract::StoreError,
    store::checkpoint::{resolve_compacted_at, CheckpointStore},
};
use serde_json::Value;
use std::{path::Path, process::Command};

#[test]
fn checkpoint_digests_deduplication_and_timestamp_resolution_match_node() {
    let script = r#"
import {createRequire} from 'node:module'; import path from 'node:path'; import {pathToFileURL} from 'node:url';
let root;try{root=path.dirname(createRequire(path.join(process.cwd(),'package.json')).resolve('@cyb3rb1ade/plur1bus-memory/package.json'));}
catch{throw new Error('run pnpm test:prep (the engine package is not installed)');}
const {createCheckpointStore,resolveCompactedAt}=await import(pathToFileURL(path.join(root,'engine/checkpoint/checkpoint-store.js')));
const values=[0,-0,1,1.5,-1.5,1e-6,1e-7,1e20,1e21,1e30,Number.MIN_VALUE,4102444800000];
const store=createCheckpointStore({clock:()=>1234});
const cases=values.map(at=>store.checkpoint('a1','compaction',{at,sessionKey:'Grüße 🚀'}));
cases.push(store.checkpoint('a1','compaction',{at:4102444800000,sessionKey:'Grüße 🚀'}));
cases.push(store.checkpoint('a2','manual',{at:NaN}));
console.log(JSON.stringify({cases,last:store.lastAt('a1','compaction'),resolved:[
 resolveCompactedAt({event:{compactedAt:7},hookCtx:{compactedAt:8},store,agentId:'a1'}),
 resolveCompactedAt({event:{compactedAt:0},hookCtx:{compactedAt:8},store,agentId:'a1'}),
 resolveCompactedAt({store,agentId:'a1'}),resolveCompactedAt({store,agentId:'missing'})]}));
"#;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = Command::new("node")
        .args(["--input-type=module", "-e", script])
        .current_dir(root.join("packages/core"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let node: Value = serde_json::from_slice(&output.stdout).unwrap();
    let store = CheckpointStore::new(|| 1234.0);
    let values = [
        0.0,
        -0.0,
        1.0,
        1.5,
        -1.5,
        1e-6,
        1e-7,
        1e20,
        1e21,
        1e30,
        f64::from_bits(1),
        4_102_444_800_000.0,
    ];
    let mut cases = values
        .into_iter()
        .map(|at| {
            store
                .checkpoint("a1", "compaction", Some(at), "Grüße 🚀")
                .unwrap()
        })
        .collect::<Vec<_>>();
    cases.push(
        store
            .checkpoint("a1", "compaction", Some(4_102_444_800_000.0), "Grüße 🚀")
            .unwrap(),
    );
    cases.push(
        store
            .checkpoint("a2", "manual", Some(f64::NAN), "")
            .unwrap(),
    );
    assert_eq!(serde_json::to_value(cases).unwrap(), node["cases"]);
    assert_eq!(
        store.last_at("a1", "compaction").unwrap().unwrap(),
        node["last"].as_f64().unwrap()
    );
    let resolved = [
        resolve_compacted_at(Some(7.0), Some(8.0), Some(&store), "a1").unwrap(),
        resolve_compacted_at(Some(0.0), Some(8.0), Some(&store), "a1").unwrap(),
        resolve_compacted_at(None, None, Some(&store), "a1").unwrap(),
        resolve_compacted_at(None, None, Some(&store), "missing").unwrap(),
    ];
    for (actual, expected) in resolved
        .into_iter()
        .zip(node["resolved"].as_array().unwrap())
    {
        assert_eq!(actual, expected.as_f64());
    }
    assert_eq!(
        store.checkpoint("a1", "unknown", None, ""),
        Err(StoreError::InvalidInput)
    );
}
