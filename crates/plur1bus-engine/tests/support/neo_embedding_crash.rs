//! Real process death at publication boundaries; restart does not repeat inference.
#![cfg(unix)]
use super::recovery::{expected_vectors, Interrupt};
use super::*;
#[test]
fn child_fixture() {
    use std::io::{Read, Write};
    let Some(root) = std::env::var_os("PLUR1BUS_DRAIN_CRASH_FIXTURE") else {
        return;
    };
    let root = PathBuf::from(root);
    let phase = std::env::var("PLUR1BUS_DRAIN_CRASH_PHASE").unwrap();
    struct Pause(Interrupt);
    impl CapturePolicy for Pause {
        fn allowed(&self, _: &RequestContext) -> Result<bool, EngineError> {
            if self.0.reached() {
                println!("DRAIN_CRASH_BOUNDARY");
                std::io::stdout().flush().unwrap();
                let _ = std::io::stdin().read(&mut [0]);
            }
            Ok(true)
        }
    }
    let host = Arc::new(support::TestHost::new(root.join("state")));
    host.set_workspace("alpha", root.clone());
    host.time.store(1_794_139_200_000, Ordering::SeqCst);
    let t = turn(&root, "one");
    let ctx = RequestContext::build(&t.principal, &t.agent, host.as_ref()).unwrap();
    let directory = root
        .join("workspaces")
        .join(Layout::for_key(&ctx.workspace_key).canonical);
    let policy = Arc::new(Pause(Interrupt {
        directory,
        stop: AtomicBool::new(true),
        phase,
    }));
    let mood = Arc::new(plur1bus_engine::capture::emotion_pool::EmotionalPool::new(
        host.clone(),
        json!({}),
    ));
    let episodes = Arc::new(EpisodeStore::open(&root, host, policy, mood).unwrap());
    EmbeddingDrain::new(episodes, Some(Arc::new(Embedder::new())))
        .unwrap()
        .drain(
            &t.principal,
            &t.agent,
            &DrainOptions {
                impact: Impact::All,
                ..Default::default()
            },
            &Cancel::never(),
        )
        .unwrap();
}
#[test]
fn sigkill_at_five_publication_boundaries_recovers_exactly_once() {
    use std::{
        io::{BufRead, BufReader},
        process::{Command, Stdio},
        time::Duration,
    };
    for phase in ["prepared", "vectors", "manifest", "target", "queue"] {
        let f = setup();
        f.journal
            .process(&f.turn, &f.context, &Cancel::never())
            .unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "crash::child_fixture", "--nocapture"])
            .env("PLUR1BUS_DRAIN_CRASH_FIXTURE", f.root.path())
            .env("PLUR1BUS_DRAIN_CRASH_PHASE", phase)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if line.unwrap().contains("DRAIN_CRASH_BOUNDARY") {
                    let _ = tx.send(());
                    break;
                }
            }
        });
        let ready = rx.recv_timeout(Duration::from_secs(20));
        child.kill().unwrap();
        assert!(!child.wait().unwrap().success());
        reader.join().unwrap();
        ready.unwrap();
        let expected = expected_vectors(&f);
        let provider = Arc::new(Embedder::new());
        let worker = drain(&f, provider.clone());
        let result = worker
            .drain(
                &f.turn.principal,
                &f.turn.agent,
                &DrainOptions {
                    impact: Impact::All,
                    ..Default::default()
                },
                &Cancel::never(),
            )
            .unwrap();
        assert_eq!(result.processed, 0, "{phase}");
        assert!(provider.calls.lock().unwrap().is_empty(), "{phase}");
        assert_eq!(
            fs::read(f.directory.join("vectors.0.f32")).unwrap(),
            expected,
            "{phase}"
        );
        let queue = rows(&f.directory, "embedding-queue.jsonl");
        assert_eq!(queue.len(), 24, "{phase}");
        assert_eq!(
            queue.iter().filter(|r| r["status"] == "done").count(),
            12,
            "{phase}"
        );
        let manifest: Value =
            serde_json::from_slice(&fs::read(f.directory.join("vector-index.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["entries"].as_object().unwrap().len(), 12);
    }
}
