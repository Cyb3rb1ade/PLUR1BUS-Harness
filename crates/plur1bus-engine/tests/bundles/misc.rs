//! One test executable for the integration tests outside the six large groups of the engine.
//!
//! Every file under `tests/` used to be an executable of its own, each linking the whole store stack. The files
//! stay where they are and are mounted here as modules, so a test is now named `<file>::<test>`. A file mounted
//! with `#[path]` resolves its own `mod` and `#[path]` declarations relative to `tests/`, as before.
//!
//! Each file brings its own copy of the support modules it mounts, as it did as an executable of its own.
#![allow(clippy::duplicate_mod)]

#[path = "../cache_profiles_parity.rs"]
mod cache_profiles_parity;
#[path = "../cli.rs"]
mod cli;
#[path = "../config_parity.rs"]
mod config_parity;
#[path = "../contract_roundtrip.rs"]
mod contract_roundtrip;
#[path = "../corrupt_state_diagnostics.rs"]
mod corrupt_state_diagnostics;
#[path = "../embedding_artifacts.rs"]
mod embedding_artifacts;
#[path = "../embedding_identity.rs"]
mod embedding_identity;
#[path = "../embedding_local.rs"]
mod embedding_local;
#[path = "../embedding_service.rs"]
mod embedding_service;
#[path = "../embedding_tokens.rs"]
mod embedding_tokens;
#[path = "../msvc_crt.rs"]
mod msvc_crt;
#[path = "../provider_key_scope.rs"]
mod provider_key_scope;
#[path = "../rerank_key_scope.rs"]
mod rerank_key_scope;
#[path = "../rerank_providers.rs"]
mod rerank_providers;
#[path = "../seams.rs"]
mod seams;
#[path = "../text_js.rs"]
mod text_js;
#[path = "../token_calibration.rs"]
mod token_calibration;
#[path = "../token_calibration_state.rs"]
mod token_calibration_state;
#[path = "../tokens.rs"]
mod tokens;
#[path = "../transport_guard.rs"]
mod transport_guard;

/// With `autotests = false` a new file under `tests/` is compiled only when a bundle mounts it or `Cargo.toml` names
/// it. This fails for a file that is neither, so a forgotten mount cannot silently drop its tests.
#[test]
#[allow(clippy::unwrap_used)]
fn every_test_file_is_built() {
    use std::{collections::BTreeSet, fs, path::Path};
    // Modules of other test files, never test roots.
    const SUPPORT: [&str; 2] = ["capture_pipeline_support", "recall_support"];
    let tests = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    let stems = |dir: &Path| -> BTreeSet<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "rs"))
            .map(|path| path.file_stem().unwrap().to_string_lossy().into_owned())
            .collect()
    };
    let mut built: Vec<String> = Vec::new();
    for bundle in stems(&tests.join("bundles")) {
        let source =
            fs::read_to_string(tests.join("bundles").join(format!("{bundle}.rs"))).unwrap();
        built.extend(
            source
                .lines()
                .filter_map(|line| line.strip_prefix("#[path = \"../")?.strip_suffix(".rs\"]"))
                .map(str::to_owned),
        );
    }
    let manifest =
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")).unwrap();
    built.extend(
        manifest
            .lines()
            .filter_map(|line| line.strip_prefix("path = \"tests/")?.strip_suffix(".rs\""))
            .filter(|stem| !stem.contains('/'))
            .map(str::to_owned),
    );
    let mut seen = BTreeSet::new();
    let twice: Vec<&String> = built
        .iter()
        .filter(|stem| !seen.insert(stem.as_str()))
        .collect();
    assert!(twice.is_empty(), "built more than once: {twice:?}");
    let left_out: Vec<String> = stems(&tests)
        .into_iter()
        .filter(|stem| !seen.contains(stem.as_str()) && !SUPPORT.contains(&stem.as_str()))
        .collect();
    assert!(
        left_out.is_empty(),
        "not built: {left_out:?}; mount each in a file under tests/bundles/ or name it in Cargo.toml"
    );
    let missing: Vec<&str> = seen
        .iter()
        .copied()
        .filter(|stem| !tests.join(format!("{stem}.rs")).is_file())
        .collect();
    assert!(
        missing.is_empty(),
        "mounted or named, but no such file: {missing:?}"
    );
}
