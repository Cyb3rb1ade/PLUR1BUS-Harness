//! Real file-backed NeoPrelude composition with a deterministic offline provider.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::RequestContext,
    contract::{AgentContext, Cancel, Principal},
    embedding::{EmbedError, EmbedKind, EmbeddingProvider, VectorSpaceIdentity},
    neo::{
        merged::{Layout, MetadataReader},
        prelude::{Config, GlobalConfig, NativePrelude},
    },
    recall::neo_prelude::{NeoPrelude, NeoRequest},
    text::js::JsString,
};
use serde_json::{json, Value};
use std::{fs, sync::Mutex, time::Duration};
fn context(host: &support::TestHost) -> RequestContext {
    let p: Principal=serde_json::from_value(json!({"agentId":"alpha","workspace":"workspace:v1:one","channel":"telegram","accountId":"fixture-account","chat":{"id":"fixture-chat","kind":"direct"},"trust":"proved"})).unwrap();
    let a: AgentContext =
        serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    RequestContext::build(&p, &a, host).unwrap()
}

struct Provider {
    identity: VectorSpaceIdentity,
    fail: bool,
    calls: Mutex<Vec<String>>,
}
impl Provider {
    fn new(fail: bool) -> Self {
        Self {
            identity: plur1bus_engine::embedding::identity::identity_from_value(
                &json!({"provider":"fixture","model":"neo-offline","dimension":2}),
            )
            .unwrap(),
            fail,
            calls: Mutex::new(Vec::new()),
        }
    }
}
impl EmbeddingProvider for Provider {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        assert_eq!(kind, EmbedKind::Query);
        assert!(cancel.remaining().is_some());
        cancel.check().map_err(EmbedError::Cancelled)?;
        self.calls.lock().unwrap().extend_from_slice(texts);
        if self.fail {
            Err(EmbedError::Unavailable)
        } else {
            Ok(texts.iter().map(|_| vec![1., 0.]).collect())
        }
    }
}
fn config(global: bool) -> Config {
    Config {
        embedding_timeout: Duration::from_secs(4),
        now_ms: 1700000000000.,
        global: global.then_some(GlobalConfig {
            top_k: 30,
            min_similarity: 0.35,
            half_life_days: 30.,
            max_candidates: 20000,
            dedupe_threshold: 0.8,
        }),
        format: plur1bus_engine::neo::format::Options {
            idempotency_key: Some(JsString::from("fixture-turn")),
            ..Default::default()
        },
    }
}
#[test]
fn actual_neo_prelude_composition_matches_node_and_writes_no_state() {
    let f: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/neo-prelude.json")).unwrap();
    for c in f["cases"].as_array().unwrap() {
        let root = support::canonical_tempdir();
        let host = support::TestHost::new(root.path().join("state"));
        let ctx = context(&host);
        let dir = root
            .path()
            .join("workspaces")
            .join(Layout::for_key("workspace").canonical);
        fs::create_dir_all(&dir).unwrap();
        let mut originals = Vec::new();
        for file in c["files"].as_array().unwrap() {
            let bytes = file["text"]
                .as_str()
                .map(|s| s.as_bytes().to_vec())
                .unwrap_or_else(|| {
                    file["bytes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_u64().unwrap() as u8)
                        .collect()
                });
            let path = dir.join(file["name"].as_str().unwrap());
            fs::write(&path, &bytes).unwrap();
            originals.push((path, bytes));
        }
        let reader = MetadataReader::open(root.path(), "workspace").unwrap();
        let provider = Provider::new(c["failure"].as_bool().unwrap());
        let prelude = NativePrelude::new(
            &reader,
            &ctx,
            &provider,
            config(c["globalEnabled"].as_bool().unwrap()),
            Cancel::never(),
        )
        .unwrap();
        let excluded: Vec<_> = c["excludeTexts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| JsString::from(v.as_str().unwrap()))
            .collect();
        let request = NeoRequest {
            prompt: c["prompt"].as_str().unwrap(),
            exclude_texts: &excluded,
            warm_only: c["warmOnly"].as_bool().unwrap(),
        };
        let result = prelude.read_detailed(&request).unwrap();
        assert_eq!(
            result.text,
            JsString::from(c["output"].as_str().unwrap()),
            "{}",
            c["name"]
        );
        assert_eq!(
            usize::from(result.global_attempted),
            c["globalCalls"].as_u64().unwrap() as usize,
            "{}",
            c["name"]
        );
        assert!(!result.global_failed);
        assert_eq!(
            *provider.calls.lock().unwrap(),
            vec![c["prompt"].as_str().unwrap().to_owned()]
        );
        // Exercise the consumed trait as well, against the same real files.
        assert_eq!(prelude.read(&request).unwrap(), result.text);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), originals.len());
        for (path, bytes) in originals {
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
    }
}

fn own_window(root: &std::path::Path) -> std::path::PathBuf {
    let dir = root
        .join("workspaces")
        .join(Layout::for_key("workspace").canonical);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("memory-candidates.jsonl"),r#"{"id":"a","agentId":"alpha","statement":"green memory workspace","category":"project_fact"}"#).unwrap();
    dir
}
#[test]
fn short_prompts_and_cancelled_reads_never_reach_the_provider() {
    use plur1bus_engine::recall::render::RenderError;
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    let reader = MetadataReader::open(root.path(), "workspace").unwrap();
    let provider = Provider::new(false);
    let prelude =
        NativePrelude::new(&reader, &ctx, &provider, config(true), Cancel::never()).unwrap();
    assert!(prelude
        .read(&NeoRequest {
            prompt: "🙂",
            exclude_texts: &[],
            warm_only: false
        })
        .unwrap()
        .is_empty());
    assert!(provider.calls.lock().unwrap().is_empty());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    let cancel = Cancel::never();
    cancel.cancel();
    let prelude = NativePrelude::new(&reader, &ctx, &provider, config(true), cancel).unwrap();
    assert_eq!(
        prelude.read(&NeoRequest {
            prompt: "green workspace",
            exclude_texts: &[],
            warm_only: true
        }),
        Err(RenderError::Aborted)
    );
    assert!(provider.calls.lock().unwrap().is_empty());
}
struct EndedProvider {
    identity: VectorSpaceIdentity,
    reason: plur1bus_engine::contract::CancelReason,
}
impl EmbeddingProvider for EndedProvider {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }
    fn embed(&self, _: &[String], _: EmbedKind, _: &Cancel) -> Result<Vec<Vec<f32>>, EmbedError> {
        Err(EmbedError::Cancelled(
            plur1bus_engine::contract::Cancelled {
                reason: self.reason,
            },
        ))
    }
}
#[test]
fn a_feature_timeout_keeps_lexical_reads_but_caller_cancellation_aborts() {
    use plur1bus_engine::{
        contract::CancelReason, neo::prelude::EmbeddingOutcome, recall::render::RenderError,
    };
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    own_window(root.path());
    let reader = MetadataReader::open(root.path(), "workspace").unwrap();
    let provider = EndedProvider {
        identity: Provider::new(false).identity,
        reason: CancelReason::Deadline,
    };
    let prelude =
        NativePrelude::new(&reader, &ctx, &provider, config(true), Cancel::never()).unwrap();
    let request = NeoRequest {
        prompt: "green workspace",
        exclude_texts: &[],
        warm_only: false,
    };
    let result = prelude.read_detailed(&request).unwrap();
    assert_eq!(result.embedding, EmbeddingOutcome::TimedOut);
    assert!(!result.global_attempted);
    assert!(result
        .text
        .to_utf8_lossy()
        .contains("green memory workspace"));
    let provider = EndedProvider {
        reason: CancelReason::Caller,
        ..provider
    };
    let prelude =
        NativePrelude::new(&reader, &ctx, &provider, config(true), Cancel::never()).unwrap();
    assert_eq!(prelude.read(&request), Err(RenderError::Aborted));
}
#[cfg(unix)]
#[test]
fn real_global_file_failure_keeps_the_window_and_reports_degradation() {
    use std::os::unix::fs::symlink;
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    let dir = own_window(root.path());
    let outside = root.path().join("outside");
    fs::write(&outside, "synthetic index").unwrap();
    symlink(&outside, dir.join("candidate-index.jsonl")).unwrap();
    let reader = MetadataReader::open(root.path(), "workspace").unwrap();
    let provider = Provider::new(false);
    let prelude =
        NativePrelude::new(&reader, &ctx, &provider, config(true), Cancel::never()).unwrap();
    let result = prelude
        .read_detailed(&NeoRequest {
            prompt: "green workspace",
            exclude_texts: &[],
            warm_only: false,
        })
        .unwrap();
    assert!(result.global_attempted);
    assert!(result.global_failed);
    assert_eq!(result.global_hits, 0);
    assert!(result
        .text
        .to_utf8_lossy()
        .contains("green memory workspace"));
}

struct BoundaryProvider {
    identity: VectorSpaceIdentity,
    mode: &'static str,
}
impl EmbeddingProvider for BoundaryProvider {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }
    fn embed(
        &self,
        _: &[String],
        _: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        match self.mode {
            "late" => {
                while cancel.check().is_ok() {
                    std::thread::yield_now();
                }
                Ok(vec![vec![1., 0.]])
            }
            "nonfinite" => Ok(vec![vec![f32::NAN, 0.]]),
            "width" => Ok(vec![vec![1.]]),
            "count" => Ok(Vec::new()),
            _ => panic!("unknown fixture mode"),
        }
    }
}
#[test]
fn successful_but_late_replies_cannot_extend_the_feature_or_parent_deadline() {
    use plur1bus_engine::{neo::prelude::EmbeddingOutcome, recall::render::RenderError};
    use std::time::Instant;
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    own_window(root.path());
    let reader = MetadataReader::open(root.path(), "workspace").unwrap();
    let provider = BoundaryProvider {
        identity: Provider::new(false).identity,
        mode: "late",
    };
    let request = NeoRequest {
        prompt: "green workspace",
        exclude_texts: &[],
        warm_only: false,
    };
    let mut cfg = config(true);
    cfg.embedding_timeout = Duration::from_millis(1);
    let prelude = NativePrelude::new(&reader, &ctx, &provider, cfg, Cancel::never()).unwrap();
    let out = prelude.read_detailed(&request).unwrap();
    assert_eq!(out.embedding, EmbeddingOutcome::TimedOut);
    assert!(!out.global_attempted);
    assert!(!out.text.is_empty());
    let cancel = Cancel::with_deadline(Instant::now() + Duration::from_millis(1));
    let prelude = NativePrelude::new(&reader, &ctx, &provider, config(true), cancel).unwrap();
    assert_eq!(prelude.read(&request), Err(RenderError::Aborted));
}
#[test]
fn invalid_provider_vectors_never_reach_global_search_or_lane_cosine() {
    use plur1bus_engine::neo::prelude::EmbeddingOutcome;
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    own_window(root.path());
    let reader = MetadataReader::open(root.path(), "workspace").unwrap();
    for mode in ["nonfinite", "width", "count"] {
        let provider = BoundaryProvider {
            identity: Provider::new(false).identity,
            mode,
        };
        let prelude =
            NativePrelude::new(&reader, &ctx, &provider, config(true), Cancel::never()).unwrap();
        let out = prelude
            .read_detailed(&NeoRequest {
                prompt: "green workspace",
                exclude_texts: &[],
                warm_only: false,
            })
            .unwrap();
        assert_eq!(out.embedding, EmbeddingOutcome::Unavailable);
        assert!(!out.global_attempted);
        assert!(!out.text.is_empty());
    }
}
