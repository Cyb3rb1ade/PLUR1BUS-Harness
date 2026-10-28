//! Identity serialization and hashes are pinned to the installed Node implementation.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use plur1bus_engine::contract::{StoreError, VectorSpaceIdentity};
use plur1bus_engine::store::identity::{canonical_identity, canonical_json, identity_id};
use serde_json::{json, Value};

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/store-v1")
}
fn copy(source: &Path, destination: &Path) {
    std::fs::create_dir_all(destination).unwrap();
    for entry in std::fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let path = destination.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy(&entry.path(), &path);
        } else {
            std::fs::copy(entry.path(), path).unwrap();
        }
    }
}

const NODE_CHECK: &str = r#"
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const pin='9f34008c143c5da87b2194b5a28442b407ff8ba7';
const repo=path.resolve(process.cwd(),'../..');
assert.ok(JSON.parse(readFileSync('package.json')).dependencies['@cyb3rb1ade/plur1bus-memory'].endsWith(pin));
// A Windows checkout may convert the committed lockfile to CRLF; pnpm writes its install copy with LF.
const lf=(file)=>readFileSync(path.join(repo,file),'utf8').replace(/\r\n/g,'\n');
assert.equal(lf('node_modules/.pnpm/lock.yaml'),lf('pnpm-lock.yaml'));
const requireFromCore=createRequire(path.join(process.cwd(),'package.json'));
let root;
try{root=path.dirname(requireFromCore.resolve('@cyb3rb1ade/plur1bus-memory/package.json'));}
catch{throw new Error('run pnpm test:prep (the engine package is not installed)');}
const {embeddingIdentity,identityId}=await import(pathToFileURL(path.join(root,'lib/providers/embedding-identity.js')));
const cases=JSON.parse(readFileSync(0,'utf8')).map(input=>{
 try{const normalized=embeddingIdentity(input);return {accepted:true,json:JSON.stringify(normalized),id:identityId(normalized)};}
 catch{return {accepted:false};}
});
const {MemoryDB}=await import(pathToFileURL(path.join(root,'engine/store/memory-db.js')));
const db=new MemoryDB(process.argv[1],384,null,{readOnly:true});
await db.init();
try{
 const metadata=await db.db.openTable('_embedding_identity');
 try{const rows=await metadata.query().limit(2).toArray();assert.equal(rows.length,1);console.log(JSON.stringify({cases,stored:rows[0]}));}
 finally{await metadata.close();}
}finally{await db.shutdown();}
"#;

#[test]
fn canonical_identity_matches_node_defaults_validation_json_and_persisted_hash() {
    let fixture_value: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture().join("identity.json")).unwrap())
            .unwrap();
    let mut inputs = vec![fixture_value.clone()];
    let mut defaults = fixture_value.clone();
    for field in ["artifacts", "pooling", "tokenCap"] {
        defaults.as_object_mut().unwrap().remove(field);
    }
    inputs.push(defaults);
    let mut reordered = fixture_value.clone();
    reordered["artifacts"] = json!([
        {"path":"\u{e000}","sha256":"a".repeat(64)},
        {"path":"\u{10000}","sha256":"b".repeat(64)},
        {"path":"a\\quote\"/🚀\n","sha256":"c".repeat(64)}
    ]);
    reordered["dimension"] = json!(384.0);
    reordered["tokenCap"] = json!(128.0);
    reordered["instruction"] = json!("line\n\t\u{0001}\"\\🚀\u{2028}\u{2029}");
    inputs.push(reordered);
    let mut empty_optional = fixture_value.clone();
    for field in [
        "revision",
        "normalization",
        "prefixScheme",
        "instruction",
        "dtype",
        "pooling",
    ] {
        empty_optional[field] = json!("");
    }
    empty_optional["dimension"] = json!(9_007_199_254_740_991_u64);
    empty_optional["tokenCap"] = json!(9_007_199_254_740_991_u64);
    inputs.push(empty_optional);
    for (field, values) in [
        (
            "dimension",
            vec![
                json!(0),
                json!(-1),
                json!(1.5),
                json!(9_007_199_254_740_992_u64),
            ],
        ),
        (
            "tokenCap",
            vec![
                json!(0),
                json!(-1),
                json!(1.5),
                json!(9_007_199_254_740_992_u64),
            ],
        ),
        ("provider", vec![json!("")]),
        ("model", vec![json!("")]),
    ] {
        for value in values {
            let mut invalid = fixture_value.clone();
            invalid[field] = value;
            inputs.push(invalid);
        }
    }
    for artifacts in [
        json!([{"path":"","sha256":"a".repeat(64)}]),
        json!([{"path":"a","sha256":"A".repeat(64)}]),
        json!([{"path":"a","sha256":"a".repeat(63)}]),
        json!([{"path":"a","sha256":"a".repeat(64)},{"path":"a","sha256":"b".repeat(64)}]),
    ] {
        let mut invalid = fixture_value.clone();
        invalid["artifacts"] = artifacts;
        inputs.push(invalid);
    }
    let guard = tempfile::tempdir().unwrap();
    let physical = guard.path().canonicalize().unwrap();
    copy(&fixture(), &physical);
    let core = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core");
    let mut child = Command::new("node")
        .args(["--input-type=module", "-e", NODE_CHECK])
        .arg(&physical)
        .current_dir(core)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Node must be installed and available on PATH");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&inputs).unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let node: Value = serde_json::from_slice(&output.stdout).unwrap();
    for (index, input) in inputs.into_iter().enumerate() {
        let identity: VectorSpaceIdentity = serde_json::from_value(input).unwrap();
        let rust = canonical_identity(&identity);
        if node["cases"][index]["accepted"] == json!(false) {
            assert!(
                matches!(rust, Err(StoreError::InvalidInput)),
                "case {index}"
            );
            continue;
        }
        let (normalized, json, id) = rust.unwrap();
        assert_eq!(
            json,
            node["cases"][index]["json"].as_str().unwrap(),
            "case {index}"
        );
        assert_eq!(
            id,
            node["cases"][index]["id"].as_str().unwrap(),
            "case {index}"
        );
        assert_eq!(canonical_json(&normalized).unwrap(), json);
        assert_eq!(identity_id(&normalized).unwrap(), id);
        if index == 0 {
            assert_eq!(json, node["stored"]["identity"].as_str().unwrap());
            assert_eq!(id, node["stored"]["identityId"].as_str().unwrap());
        }
    }
}
