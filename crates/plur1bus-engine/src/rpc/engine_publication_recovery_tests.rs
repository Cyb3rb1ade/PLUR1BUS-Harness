//! Count the sync that makes already visible rows durable before recovery clears a plan.
use super::{neo_host, user_turn};
use crate::{
    capture::{emotion_pool::EmotionalPool, shared_scope::WorkspaceCapturePolicy},
    context::RequestContext,
    contract::{Cancel, TurnRecord},
    embedding::seam::FlatEmbedder,
    neo::{
        embedding_drain::{DrainOptions, EmbeddingDrain, Impact},
        episode_store::EpisodeStore,
        merged::Layout,
    },
    store::durability_probe::Probe,
};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

fn fixture(root: &Path) -> (Arc<EpisodeStore>, TurnRecord, RequestContext, PathBuf) {
    let host = neo_host(root);
    let mut turn = user_turn(root, "owner", "publication-recovery");
    turn.messages = serde_json::from_value(json!([
        {"role":"user","content":"Architecture decision chosen"},
        {"role":"assistant","content":"I will plan the implementation"},
        {"role":"user","content":"yes exactly"},
        {"role":"assistant","content":"maybe we could use a queue"},
        {"role":"user","content":"keep project files private"}
    ]))
    .unwrap();
    let ctx = RequestContext::build(&turn.principal, &turn.agent, host.as_ref()).unwrap();
    let files = root
        .join("workspaces")
        .join(Layout::for_key(&ctx.workspace_key).canonical);
    let mood = Arc::new(EmotionalPool::new(host.clone(), json!({})));
    let policy = Arc::new(WorkspaceCapturePolicy::new(root.join("db")));
    let store = Arc::new(EpisodeStore::open(root, host, policy, mood).unwrap());
    (store, turn, ctx, files)
}

#[test]
fn episode_recovery_syncs_a_visible_row_before_clearing_the_plan() {
    let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let (store, turn, ctx, files) = fixture(root.path());
    let episodes = files.join("episodes.jsonl");
    let cancel = Cancel::never();
    {
        let probe = Probe::start(&episodes);
        let interrupt = cancel.clone();
        probe.after_sync("append-file", move || interrupt.cancel());
        assert!(store.process(&turn, &ctx, &cancel).is_err());
        assert_eq!(probe.counts().get("append-file"), Some(&1));
    }
    let visible = fs::read(&episodes).unwrap();
    assert!(!visible.is_empty());
    let probe = Probe::start(&episodes);
    let report = store.recover_pending(&Cancel::never()).unwrap();
    assert_eq!(
        (report.bindings, report.closed, report.episode_revisions),
        (1, 0, 0)
    );
    assert!(report.deferred.is_empty());
    assert_eq!(fs::read(&episodes).unwrap(), visible);
    assert_eq!(probe.counts().get("append-file"), Some(&1));
    assert_eq!(store.recover_pending(&Cancel::never()).unwrap().bindings, 0);
}

#[test]
fn embedding_recovery_syncs_a_visible_queue_row_before_clearing_the_plan() {
    let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let (store, turn, ctx, files) = fixture(root.path());
    store.process(&turn, &ctx, &Cancel::never()).unwrap();
    let provider = Arc::new(FlatEmbedder::new(3, false));
    let worker = EmbeddingDrain::new(store.clone(), Some(provider)).unwrap();
    let queue = files.join("embedding-queue.jsonl");
    let before = fs::read(&queue).unwrap();
    let options = DrainOptions {
        max_items: 1,
        impact: Impact::All,
    };
    let cancel = Cancel::never();
    {
        let probe = Probe::start(&queue);
        let interrupt = cancel.clone();
        probe.after_sync("append-file", move || interrupt.cancel());
        assert!(worker
            .drain(&turn.principal, &turn.agent, &options, &cancel)
            .is_err());
        assert_eq!(probe.counts().get("append-file"), Some(&1));
    }
    let visible = fs::read(&queue).unwrap();
    assert!(visible.starts_with(&before) && visible.len() > before.len());
    let vectors = fs::read(files.join("vectors.0.f32")).unwrap();
    assert!(!vectors.is_empty());
    let probe = Probe::start(&queue);
    let report = store.recover_pending(&Cancel::never()).unwrap();
    assert_eq!(
        (report.bindings, report.closed, report.embedding_revisions),
        (1, 0, 0)
    );
    assert!(report.deferred.is_empty());
    assert_eq!(fs::read(&queue).unwrap(), visible);
    assert_eq!(fs::read(files.join("vectors.0.f32")).unwrap(), vectors);
    assert_eq!(probe.counts().get("append-file"), Some(&1));
    assert_eq!(store.recover_pending(&Cancel::never()).unwrap().bindings, 0);
}
