//! Actual Node/Lance copied-store inspection, source immutability and bounded cancellation.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "synthetic fixture assertions"
)]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    contract::*,
    ops::adopt::{CopiedStoreRoutes, StoreAdopter},
    store::paths::assert_trusted_path,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ops")
}
fn golden() -> Value {
    serde_json::from_str(include_str!("fixtures/ops/golden/adopt.json")).unwrap()
}
struct Embed {
    case: Value,
    calls: Mutex<Vec<Value>>,
}
impl EmbeddingService for Embed {
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        _identity: &EmbeddingIdentity,
        _cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EngineError> {
        assert_eq!(kind, EmbedKind::Passage);
        self.calls
            .lock()
            .unwrap()
            .push(json!({"texts":texts,"concurrency":8,"options":{"purpose":"adopt-probe"}}));
        let mode = self.case["embed"].as_str().unwrap_or("");
        if mode == "throws" {
            return Err(StoreError::Unavailable.into());
        }
        if mode == "count" {
            return Ok(vec![]);
        }
        Ok(texts
            .iter()
            .enumerate()
            .map(|(i, t)| match mode {
                "half" if i >= 8 => vec![f32::NAN, 0., 0., 0.],
                "seven" if i >= 7 => vec![f32::NAN, 0., 0., 0.],
                "dimension" => vec![1., 0., 0.],
                "zero" => vec![0.; 4],
                "nan" => vec![f32::NAN, 0., 0., 0.],
                "other" => vec![0., 1., 0., 0.],
                "median" => vec![0.9994, (1. - 0.9994_f64.powi(2)).sqrt() as f32, 0., 0.],
                "minimum" if i == 0 => {
                    vec![0.9989, (1. - 0.9989_f64.powi(2)).sqrt() as f32, 0., 0.]
                }
                _ if t == "second" && mode != "uniform" => vec![0., 1., 0., 0.],
                _ => vec![1., 0., 0., 0.],
            })
            .collect())
    }
    fn rerank(
        &self,
        _: &str,
        _: &[String],
        _: usize,
        _: &Cancel,
    ) -> Result<Vec<RerankHit>, EngineError> {
        Err(StoreError::Unavailable.into())
    }
    fn probe(&self, _: bool, _: &Cancel) -> Result<EmbeddingProbeResult, EngineError> {
        Err(StoreError::Unavailable.into())
    }
    fn identities(&self) -> Vec<EmbeddingIdentity> {
        vec![]
    }
    fn serve(&self) -> Result<EmbeddingServeResult, EngineError> {
        Err(StoreError::Unavailable.into())
    }
}
fn copy(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).unwrap();
    for e in fs::read_dir(src).unwrap() {
        let e = e.unwrap();
        let next = dst.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy(&e.path(), &next)
        } else {
            fs::copy(e.path(), next).unwrap();
        }
    }
}
fn copy_fixture(name: &str, dst: &Path) {
    copy(&fixture().join("adopt-stores").join(name), dst)
}
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(root: &Path, p: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for e in fs::read_dir(p).unwrap() {
            let e = e.unwrap();
            let file = e.path();
            let key = file.strip_prefix(root).unwrap().to_owned();
            let ty = e.file_type().unwrap();
            if ty.is_symlink() {
                out.insert(key, b"link".to_vec());
            } else if ty.is_dir() {
                out.insert(key, b"dir".to_vec());
                walk(root, &file, out);
            } else {
                out.insert(key, fs::read(file).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}
#[cfg(unix)]
fn symlink(from: &Path, to: &Path) {
    std::os::unix::fs::symlink(from, to).unwrap()
}
#[cfg(windows)]
fn symlink(from: &Path, to: &Path) {
    std::os::windows::fs::symlink_dir(from, to).unwrap()
}
fn setup(work: &Path, c: &Value, identity: &Value) -> PathBuf {
    let base = work.join("store");
    if c["missing"] != true {
        fs::create_dir(&base).unwrap();
    }
    if c["missing"] != true && c["noSchema"] != true {
        let marker = base.join("_schema.json");
        if c["markerDirectory"] == true {
            fs::create_dir(marker).unwrap()
        } else {
            fs::write(
                marker,
                c["schemaRaw"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        json!({"schemaVersion":c.get("schema").unwrap_or(&json!("1"))}).to_string()
                    }),
            )
            .unwrap();
        }
    }
    if let Some(table) = c["table"].as_str() {
        let mut dest = base.clone();
        if let Some(ns) = c["namespace"].as_str() {
            dest.push(ns)
        }
        dest.push(c["agent"].as_str().unwrap_or("agent"));
        if c["linkAgent"] == true {
            let linked = work.join("linked");
            copy_fixture(table, &linked);
            symlink(&linked, &dest)
        } else {
            copy_fixture(table, &dest)
        }
    }
    if let Some(table) = c["second"].as_str() {
        copy_fixture(table, &base.join("z-agent"))
    }
    if !c["generation"].is_null() || !c["generationRaw"].is_null() {
        let gen = base.join("generations/g1");
        fs::create_dir_all(&gen).unwrap();
        let mut manifest = identity.clone();
        manifest["schemaVersion"] = json!(1);
        manifest["generation"] = json!("g1");
        manifest["tables"] = json!({});
        if let Some(fields) = c["generation"].as_object() {
            for (k, v) in fields {
                manifest[k] = v.clone();
            }
        }
        fs::write(
            gen.join("generation.json"),
            c["generationRaw"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| manifest.to_string()),
        )
        .unwrap();
        if let Some(table) = c["genTable"].as_str() {
            copy_fixture(table, &gen.join("agent"))
        }
    }
    if c["relative"] == true {
        return PathBuf::from("relative");
    }
    if c["traversal"] == true {
        // Joining onto a Windows verbatim path would normalize away the parent component.
        let mut raw = base.into_os_string();
        let sep = std::path::MAIN_SEPARATOR;
        raw.push(format!("{sep}x{sep}..{sep}"));
        let path = PathBuf::from(raw);
        assert!(path
            .components()
            .any(|part| part == std::path::Component::ParentDir));
        return path;
    }
    if c["symlink"] == true {
        let link = work.join("link");
        symlink(&base, &link);
        return link;
    }
    base
}
fn make(c: &Value, identity: &Value, cancel: Cancel) -> (StoreAdopter, Arc<Embed>) {
    let mut actual = identity.clone();
    if let Some(fields) = c["engine"].as_object() {
        for (k, v) in fields {
            actual[k] = v.clone();
        }
    }
    let actual = if c["noIdentity"] == true {
        None
    } else {
        Some(serde_json::from_value(actual).unwrap())
    };
    let embed = Arc::new(Embed {
        case: c.clone(),
        calls: Mutex::new(vec![]),
    });
    let unsafe_host = c["unsafe"] == true;
    let platform = PlatformCapabilities {
        is_unsafe_link: Arc::new(move |p| unsafe_host || assert_trusted_path(p).is_err()),
        ..Default::default()
    };
    (
        StoreAdopter::new(
            embed.clone(),
            actual,
            platform,
            Arc::new(CopiedStoreRoutes),
            cancel,
        ),
        embed,
    )
}
#[test]
fn actual_node_lance_adoption_matrix_keeps_copies_byte_unchanged() {
    let g = golden();
    let exceptions: Value =
        serde_json::from_str(include_str!("fixtures/ops/adopt-exceptions.json")).unwrap();
    use sha2::{Digest, Sha256};
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("fixtures/ops/golden/adopt.json"))
        ),
        exceptions["goldenSha256"]
    );
    for c in g["cases"].as_array().unwrap() {
        let work = support::canonical_tempdir();
        let requested = setup(work.path(), c, &g["identity"]);
        let before = snapshot(work.path());
        let (adopter, embed) = make(c, &g["identity"], Cancel::never());
        let mut req = json!({"path":requested,"expectedIdentity":g["identity"],"dryRun":c.get("dryRun").unwrap_or(&json!(true))});
        if let Some(fields) = c["request"].as_object() {
            for (k, v) in fields {
                req[k] = v.clone();
            }
        }
        let result = match adopter.adopt(serde_json::from_value(req).unwrap()) {
            Ok(r) => serde_json::to_value(r).unwrap(),
            Err(EngineError::MemoryOp(e)) => json!({"error":e.code}),
            Err(e) => panic!("{}: {e}", c["name"]),
        };
        let expected = exceptions["cases"][c["name"].as_str().unwrap()]
            .get("result")
            .unwrap_or(&c["result"]);
        assert_eq!(&result, expected, "{}", c["name"]);
        assert_eq!(
            *embed.calls.lock().unwrap(),
            *c["calls"].as_array().unwrap(),
            "{} probe order",
            c["name"]
        );
        assert_eq!(
            snapshot(work.path()),
            before,
            "{} changed source",
            c["name"]
        );
    }
}
#[test]
fn closed_or_cancelled_inspection_does_not_read_or_embed() {
    let g = golden();
    let work = support::canonical_tempdir();
    let cancel = Cancel::never();
    cancel.cancel();
    let (a, e) = make(&json!({}), &g["identity"], cancel);
    let req = || {
        serde_json::from_value(
            json!({"path":work.path().join("missing"),"expectedIdentity":g["identity"]}),
        )
        .unwrap()
    };
    assert!(matches!(a.adopt(req()), Err(EngineError::Cancelled(_))));
    let (a, _) = make(&json!({}), &g["identity"], Cancel::never());
    let request = Cancel::never();
    request.cancel();
    assert!(matches!(
        a.inspect(&req(), &request),
        Err(EngineError::Cancelled(_))
    ));
    assert!(e.calls.lock().unwrap().is_empty());
    assert!(snapshot(work.path()).is_empty());
}
