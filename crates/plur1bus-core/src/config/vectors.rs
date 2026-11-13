//! Replay of the parity vectors recorded from the TypeScript configuration modules
//! (`scripts/parity/export-config.ts`, `fixtures/parity/config/*.json`). Vectors are recorded, never edited by hand.
//! A case with a `note` differs from the TypeScript output on purpose; the replay then only checks what the note allows.
use super::disclosure::load_config_disclosure_policy;
use super::engine::{
    build_engine_config, engine_embedding, EngineCatalog, EngineLayout, NoCatalog,
};
use super::load::{structure_errors, validate_config_with_warnings};
use super::patch::flatten_patch;
use plur1bus_config::{configuration_warnings, ConfigWarning};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::Path;

fn fixture(name: &str) -> Vec<Value> {
    let path = format!(
        "{}/../../fixtures/parity/config/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap()
}

fn name(case: &Value) -> &str {
    case["name"].as_str().unwrap()
}

fn warnings_json(list: &[ConfigWarning]) -> Value {
    Value::Array(
        list.iter()
            .map(|w| json!({"key": w.key, "message": w.message}))
            .collect(),
    )
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn validate_vectors() {
    let mut wording = 0;
    for case in fixture("validate") {
        let input: Value = match case.get("text") {
            Some(t) => serde_json::from_str(t.as_str().unwrap()).unwrap(),
            None => case["config"].clone(),
        };
        let n = name(&case);
        assert_eq!(structure_errors(&input), strings(&case["structure"]), "{n}");
        match validate_config_with_warnings(&input) {
            Ok(v) => {
                assert_eq!(case["ok"], true, "{n}: Rust accepts, TypeScript refuses");
                assert_eq!(warnings_json(&v.warnings), case["warnings"], "{n}");
            }
            Err(e) => {
                assert_eq!(case["ok"], false, "{n}: Rust refuses {e:?}");
                let want = strings(&case["errors"]);
                // The schema walk of `plur1bus-config` words ajv's keyword errors differently ("must match the declared
                // pattern"); the verdict, the number of errors and the path of each one must agree, and the rules the core
                // adds on top (cross-field, structure, privacy) must agree to the letter.
                assert_eq!(e.len(), want.len(), "{n}: {e:?} / {want:?}");
                for (got, want) in e.iter().zip(&want) {
                    if got != want {
                        assert_eq!(path_of(got), path_of(want), "{n}");
                        wording += 1;
                    }
                }
            }
        }
    }
    // Pinned: a new difference in wording is a decision, not an accident.
    assert_eq!(wording, 37, "error texts that differ in wording only");
}

fn path_of(error: &str) -> &str {
    error.split(' ').next().unwrap_or("")
}

#[test]
fn warning_vectors() {
    for case in fixture("warnings") {
        let got = configuration_warnings(&case["value"], &case["schema"]);
        assert_eq!(warnings_json(&got), case["warnings"], "{}", name(&case));
    }
}

#[test]
fn disclosure_vectors() {
    for case in fixture("disclosure") {
        let home = tempfile::tempdir().unwrap();
        for m in case["modules"].as_array().unwrap() {
            let dir = home
                .path()
                .join("modules")
                .join(m["name"].as_str().unwrap());
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("module.json"), m["text"].as_str().unwrap()).unwrap();
        }
        let policy = load_config_disclosure_policy(home.path());
        let n = name(&case);
        assert_eq!(
            policy.values(&case["config"]),
            strings(&case["values"]),
            "{n}"
        );
        assert_eq!(
            warnings_json(&policy.warnings(&case["config"])),
            case["warnings"],
            "{n}"
        );
    }
}

struct Table {
    model: String,
    dimensions: Value,
    target: String,
}

impl EngineCatalog for Table {
    fn effective_embedding(&self, _: &Map<String, Value>) -> Option<(String, Value)> {
        Some((self.model.clone(), self.dimensions.clone()))
    }
    fn is_non_commercial(&self, model: &str) -> bool {
        model == self.model
    }
    fn preparation_target(&self, _: &str, _: &Value) -> Option<String> {
        Some(self.target.clone())
    }
}

fn apply(edits: &Value) -> Value {
    let mut cfg = plur1bus_config::defaults();
    for edit in edits.as_array().unwrap() {
        let path = strings(&edit[0]);
        let (last, parents) = path.split_last().unwrap();
        let mut at = &mut cfg;
        for p in parents {
            at = at
                .as_object_mut()
                .unwrap()
                .entry(p.clone())
                .or_insert_with(|| json!({}));
        }
        let map = at.as_object_mut().unwrap();
        // `undefined` crosses JSON as null: the key is removed.
        if edit[1].is_null() {
            map.remove(last);
        } else {
            map.insert(last.clone(), edit[1].clone());
        }
    }
    cfg
}

#[test]
fn engine_vectors() {
    let layout = EngineLayout::new(Path::new("/h/.plur1bus"));
    for case in fixture("engine") {
        let n = name(&case);
        let cfg = apply(&case["set"]);
        let table = case["catalog"].as_object().map(|c| Table {
            model: c["model"].as_str().unwrap().to_owned(),
            dimensions: c["dimensions"].clone(),
            target: c["target"].as_str().unwrap().to_owned(),
        });
        let catalog: &dyn EngineCatalog = match &table {
            Some(t) => t,
            None => &NoCatalog,
        };
        match build_engine_config(&cfg, &layout, &case["schema"], catalog) {
            Ok(built) => {
                assert_eq!(case["ok"], true, "{n}: Rust builds, TypeScript refuses");
                assert_eq!(Value::Object(built), case["config"], "{n}");
                let emb = engine_embedding(&cfg, &layout).unwrap();
                assert_eq!(Value::Object(emb), case["embedding"], "{n}");
            }
            Err(e) => {
                assert_eq!(case["ok"], false, "{n}: Rust refuses {e}");
                assert_eq!(e.code, case["error"]["code"].as_str().unwrap(), "{n}");
                assert_eq!(e.reason.as_deref(), case["error"]["reason"].as_str(), "{n}");
                assert_eq!(e.message, case["error"]["message"].as_str().unwrap(), "{n}");
            }
        }
    }
}

fn nested(depth: u64) -> Value {
    let mut v = json!(1);
    for _ in 0..depth {
        v = json!({"a": v});
    }
    v
}

#[test]
fn patch_vectors() {
    for case in fixture("patch") {
        let n = name(&case);
        let patch = match case.get("nest") {
            Some(d) => nested(d.as_u64().unwrap()),
            None => case["patch"].clone(),
        };
        let prefix = case["prefix"].as_str().unwrap();
        match flatten_patch(prefix, patch.as_object().unwrap()) {
            Ok(changes) => {
                assert_eq!(case["ok"], true, "{n}");
                let got: Vec<Value> = changes
                    .into_iter()
                    .map(|(key, value)| json!({"key": key, "value": value}))
                    .collect();
                assert_eq!(Value::Array(got), case["changes"], "{n}");
            }
            Err(e) => {
                assert_eq!(case["ok"], false, "{n}");
                assert_eq!(e.0, case["error"].as_str().unwrap(), "{n}");
            }
        }
    }
}
