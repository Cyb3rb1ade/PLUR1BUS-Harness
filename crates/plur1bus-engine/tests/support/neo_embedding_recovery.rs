//! Prepared publications preserve original caller grants and exact old/new file states.
use super::*;
pub(super) struct Interrupt {
    pub directory: PathBuf,
    pub stop: AtomicBool,
    pub phase: String,
}
impl Interrupt {
    pub fn reached(&self) -> bool {
        match self.phase.as_str() {
            "prepared" => fs::read_dir(&self.directory).is_ok_and(|mut e| {
                e.any(|v| {
                    v.unwrap()
                        .file_name()
                        .to_string_lossy()
                        .starts_with("native-embedding-pending-")
                })
            }),
            "vectors" => {
                fs::metadata(self.directory.join("vectors.0.f32")).is_ok_and(|m| m.len() > 0)
            }
            "manifest" => self.directory.join("vector-index.json").exists(),
            "target" => rows(&self.directory, "memory-candidates.jsonl")
                .iter()
                .any(|r| r["embeddingStatus"] == "fresh"),
            "queue" => rows(&self.directory, "embedding-queue.jsonl")
                .iter()
                .any(|r| r["status"] == "done"),
            _ => panic!("unknown fixture boundary"),
        }
    }
}
impl CapturePolicy for Interrupt {
    fn allowed(&self, ctx: &RequestContext) -> Result<bool, EngineError> {
        Ok(!(self.stop.load(Ordering::SeqCst) && ctx.chat_id() == "fixture" && self.reached()))
    }
}
pub(super) fn prepare(phase: &str) -> (Fixture, Arc<Interrupt>, EmbeddingDrain) {
    let f = setup();
    f.journal
        .process(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    let policy = Arc::new(Interrupt {
        directory: f.directory.clone(),
        stop: AtomicBool::new(true),
        phase: phase.into(),
    });
    let mood = Arc::new(plur1bus_engine::capture::emotion_pool::EmotionalPool::new(
        f.host.clone(),
        json!({}),
    ));
    let episodes =
        Arc::new(EpisodeStore::open(f.root.path(), f.host.clone(), policy.clone(), mood).unwrap());
    let provider = Arc::new(Embedder::new());
    let worker = EmbeddingDrain::new(episodes, Some(provider.clone())).unwrap();
    assert!(worker
        .drain(
            &f.turn.principal,
            &f.turn.agent,
            &DrainOptions {
                impact: Impact::All,
                ..Default::default()
            },
            &Cancel::never()
        )
        .is_err());
    assert_eq!(provider.calls.lock().unwrap().len(), 12);
    (f, policy, worker)
}
pub(super) fn expected_vectors(f: &Fixture) -> Vec<u8> {
    use base64::Engine;
    let value: Value = serde_json::from_slice(
        &fs::read(native_file(&f.directory, "native-embedding-pending-")).unwrap(),
    )
    .unwrap();
    base64::engine::general_purpose::STANDARD
        .decode(value["plan"]["vectors"]["suffix"].as_str().unwrap())
        .unwrap()
}
#[test]
fn recovery_cannot_borrow_later_chat_authority_and_new_capture_waits() {
    let (f, policy, worker) = prepare("prepared");
    let path = native_file(&f.directory, "native-embedding-pending-");
    let original = fs::read(&path).unwrap();
    let mut later = serde_json::to_value(&f.turn).unwrap();
    later["principal"]["chat"]["id"] = json!("later-chat");
    let later: TurnRecord = serde_json::from_value(later).unwrap();
    assert!(worker
        .drain(
            &later.principal,
            &later.agent,
            &DrainOptions::default(),
            &Cancel::never()
        )
        .is_err());
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(f
        .journal
        .record(&f.turn, &f.context, &Cancel::never())
        .is_err());
    policy.stop.store(false, Ordering::SeqCst);
    worker
        .drain(
            &later.principal,
            &later.agent,
            &DrainOptions::default(),
            &Cancel::never(),
        )
        .unwrap();
    let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert!(value["plan"].is_null());
    assert_eq!(rows(&f.directory, "embedding-queue.jsonl").len(), 24);
}
#[test]
fn exact_partial_binary_suffix_is_resumed_without_any_provider_call() {
    let (f, policy, _) = prepare("vectors");
    let expected = expected_vectors(&f);
    fs::write(f.directory.join("vectors.0.f32"), &expected[..17]).unwrap();
    policy.stop.store(false, Ordering::SeqCst);
    let provider = Arc::new(Embedder::new());
    let worker = drain(&f, provider.clone());
    assert_eq!(
        worker
            .drain(
                &f.turn.principal,
                &f.turn.agent,
                &DrainOptions {
                    impact: Impact::All,
                    ..Default::default()
                },
                &Cancel::never()
            )
            .unwrap()
            .processed,
        0
    );
    assert!(provider.calls.lock().unwrap().is_empty());
    assert_eq!(
        fs::read(f.directory.join("vectors.0.f32")).unwrap(),
        expected
    );
}
#[test]
fn corrupt_vector_tail_source_or_plan_is_retained_without_further_publication() {
    for corruption in ["tail", "source", "owner", "space", "manifest", "payload"] {
        let (f, policy, _) = prepare("vectors");
        policy.stop.store(false, Ordering::SeqCst);
        let path = native_file(&f.directory, "native-embedding-pending-");
        let mut plan: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        match corruption {
            "tail" => {
                let mut b = fs::read(f.directory.join("vectors.0.f32")).unwrap();
                b[0] ^= 1;
                fs::write(f.directory.join("vectors.0.f32"), b).unwrap();
            }
            "source" => {
                let mut r = rows(&f.directory, "memory-candidates.jsonl");
                r[0]["statement"] = json!("changed after plan");
                fs::write(
                    f.directory.join("memory-candidates.jsonl"),
                    r.iter().map(|v| format!("{v}\n")).collect::<String>(),
                )
                .unwrap();
            }
            "owner" => {
                plan["plan"]["caller"]["principal"]["user"] = json!(harness_user_principal("two"))
            }
            "space" => {
                plan["plan"]["vectors"]["space"]["workspaceIdentity"] = json!("foreign-workspace")
            }
            "manifest" => plan["plan"]["vectors"]["manifest"]["entries"]
                .as_object_mut()
                .unwrap()
                .clear(),
            _ => plan["plan"]["changes"][0]["after"]["statement"] = json!("invented replacement"),
        }
        fs::write(&path, serde_json::to_vec(&plan).unwrap()).unwrap();
        // RE-D159: a corrupt plan or source closes only its own binding's plans (removed);
        // nothing is published from it and the recovery as a whole does not fail.
        let report = f.journal.recover_pending(&Cancel::never()).unwrap();
        assert_eq!(report.closed, 1, "{corruption}");
        assert!(!path.exists(), "{corruption}");
        assert!(!f.directory.join("vector-index.json").exists());
    }
}
#[cfg(unix)]
#[test]
fn sidecar_symlinks_and_hardlinks_are_not_written() {
    for hard in [false, true] {
        let (f, policy, _) = prepare("vectors");
        policy.stop.store(false, Ordering::SeqCst);
        let path = f.directory.join("vectors.0.f32");
        let outside = f.root.path().join("outside-vectors");
        fs::rename(&path, &outside).unwrap();
        let before = fs::read(&outside).unwrap();
        if hard {
            fs::hard_link(&outside, &path).unwrap();
        } else {
            std::os::unix::fs::symlink(&outside, &path).unwrap();
        }
        // RE-D159: the linked sidecar closes this binding's plans; nothing is written through it.
        let report = f.journal.recover_pending(&Cancel::never()).unwrap();
        assert_eq!(report.closed, 1, "hard: {hard}");
        assert_eq!(fs::read(outside).unwrap(), before);
    }
}

#[test]
fn another_principal_cannot_append_behind_an_unfinished_shared_vector_prefix() {
    let (f, policy, _) = prepare("manifest");
    let vector = fs::read(f.directory.join("vectors.0.f32")).unwrap();
    let other = turn(f.root.path(), "two");
    // Construct a worker before the interruption's original grant is revoked. Its per-call
    // recovery path still must see every foreign pending vector publication in this directory.
    policy.stop.store(false, Ordering::SeqCst);
    let mood = Arc::new(plur1bus_engine::capture::emotion_pool::EmotionalPool::new(
        f.host.clone(),
        json!({}),
    ));
    let other_store =
        Arc::new(EpisodeStore::open(f.root.path(), f.host.clone(), policy, mood).unwrap());
    // Startup recovery is deliberately allowed to complete the original owner's plan first.
    // The stronger per-call fence is tested below against a new plan introduced after open.
    let provider = Arc::new(Embedder::new());
    let pending_path = native_file(&f.directory, "native-embedding-pending-");
    let pending = fs::read(&pending_path).unwrap();
    let worker = EmbeddingDrain::new(other_store, Some(provider.clone())).unwrap();
    fs::write(&pending_path, pending).unwrap();
    assert!(worker
        .drain(
            &other.principal,
            &other.agent,
            &DrainOptions::default(),
            &Cancel::never()
        )
        .is_err());
    assert!(provider.calls.lock().unwrap().is_empty());
    assert_eq!(fs::read(f.directory.join("vectors.0.f32")).unwrap(), vector);
}
