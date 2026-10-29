//! Closed binary grammar, job binding and private frame bounds; no assertion formats credential contents.
use super::*;
use sha2::{Digest, Sha256};
use std::io::{BufRead, Read};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use zeroize::Zeroize;

struct Fixture {
    child: Child,
    input: Option<ChildStdin>,
    messages: mpsc::Receiver<serde_json::Value>,
    history: Vec<serde_json::Value>,
    stderr: Arc<AtomicBool>,
}

impl Fixture {
    fn start(home: &std::path::Path, scenario: &str) -> (Self, serde_json::Value) {
        let mut fixture = Self::spawn(home.to_str().unwrap());
        serde_json::to_writer(
            fixture.input.as_mut().unwrap(),
            &serde_json::json!({"job":job(),"scenario":scenario}),
        )
        .unwrap();
        fixture.input.as_mut().unwrap().write_all(b"\n").unwrap();
        let ready = fixture.message();
        assert_eq!(ready["ready"], true, "private broker did not become ready");
        (fixture, ready)
    }

    fn spawn(argument: &str) -> Self {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/core/test/fixtures/import-secrets-native.mjs");
        let mut child = Command::new("node")
            .args([
                "--experimental-strip-types",
                "--conditions=source",
                "--no-warnings=ExperimentalWarning",
            ])
            .arg(path)
            .arg(argument)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("pinned Node and installed workspace source packages are required");
        let input = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let seen = Arc::new(AtomicBool::new(false));
        let observed = seen.clone();
        std::thread::spawn(move || {
            let mut bytes = Zeroizing::new([0u8; 4096]);
            while let Ok(read) = stderr.read(&mut bytes[..]) {
                if read == 0 {
                    break;
                }
                observed.store(true, Ordering::SeqCst);
                bytes.zeroize();
            }
        });
        let (sender, receiver) = mpsc::sync_channel(8);
        std::thread::spawn(move || {
            let mut stdout = std::io::BufReader::new(stdout);
            loop {
                let mut bytes = Zeroizing::new(Vec::new());
                let read = (&mut stdout).take(4097).read_until(b'\n', &mut bytes);
                if !matches!(read, Ok(1..=4096)) {
                    break;
                }
                let Ok(value) = serde_json::from_slice(&bytes) else {
                    break;
                };
                if sender.send(value).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            messages: receiver,
            history: Vec::new(),
            stderr: seen,
        }
    }

    fn message(&mut self) -> serde_json::Value {
        let value = self
            .messages
            .recv_timeout(Duration::from_secs(8))
            .expect("private fixture produced no bounded metadata response");
        self.history.push(value.clone());
        value
    }

    fn status(&mut self) -> serde_json::Value {
        self.input.as_mut().unwrap().write_all(b"status\n").unwrap();
        self.message()
    }

    fn assert_private(&self, home: &std::path::Path) {
        assert!(
            !self.stderr.load(Ordering::SeqCst),
            "private fixture must not print diagnostics"
        );
        let token = Zeroizing::new(std::fs::read_to_string(home.join("run/core.token")).unwrap());
        for value in &self.history {
            let text = serde_json::to_string(value).unwrap();
            assert!(
                !text.contains("PRIVATE_IMPORT_SOURCE_TEST_"),
                "source credential reached metadata output"
            );
            assert!(
                !text.contains(token.trim()),
                "Core token reached metadata output"
            );
        }
        fn scan(path: &std::path::Path) {
            for entry in std::fs::read_dir(path).unwrap() {
                let entry = entry.unwrap();
                let kind = entry.file_type().unwrap();
                if kind.is_dir() {
                    scan(&entry.path());
                } else if kind.is_file() {
                    let bytes = Zeroizing::new(std::fs::read(entry.path()).unwrap());
                    assert!(
                        !bytes
                            .windows(27)
                            .any(|part| part == b"PRIVATE_IMPORT_SOURCE_TEST_"),
                        "source credential reached a value file"
                    );
                }
            }
        }
        scan(home);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.input.take();
        let deadline = Instant::now() + Duration::from_secs(2);
        while self.child.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn job() -> Job {
    Job {
        invocation_id: "3cdf9150-beb5-438b-b2c9-2c67f1decf90".into(),
        run_id: "80a6dd53-a640-47fd-9948-a55fa2a4d115".into(),
        plan_id: "1158b21f-29ba-4992-bfa9-e89b71816c79".into(),
        plan_sha256: "a".repeat(64),
        owner_id: "owner".into(),
        role: "owner".into(),
        source_type: "fixture".into(),
        mode: "apply".into(),
        attempt: 1,
        preflight_id: Some("90408488-6fc1-49d9-b82a-76bb370440e5".into()),
        target_sha256: Some("b".repeat(64)),
        migrate_secrets: true,
        automatic_rollback: false,
    }
}

fn packet(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut bytes = vec![0];
    bytes.extend_from_slice(&(entries.len() as u16).to_be_bytes());
    for (name, value) in entries {
        bytes.extend_from_slice(&(name.len() as u16).to_be_bytes());
        bytes.extend_from_slice(name.as_bytes());
        bytes.extend_from_slice(&(value.len() as u32).to_be_bytes());
        bytes.extend_from_slice(value);
    }
    bytes
}

fn decode(bytes: &[u8]) -> Result<SourceSecrets, ExtError> {
    SourceSecrets::decode(bytes, &job())
}

#[test]
fn a_private_transfer_cannot_be_rebound_to_another_job_or_privilege() {
    let original = job();
    for field in [
        "run",
        "plan",
        "hash",
        "owner",
        "preflight",
        "role",
        "mode",
        "migration",
        "automatic",
        "invocation",
    ] {
        let mut changed = original.clone();
        match field {
            "run" => changed.run_id = "18dbfd7f-61d1-46ef-a316-87cb62d0cb95".into(),
            "plan" => changed.plan_id = "18dbfd7f-61d1-46ef-a316-87cb62d0cb95".into(),
            "hash" => changed.plan_sha256 = "c".repeat(64),
            "owner" => changed.owner_id = "another-owner".into(),
            "preflight" => {
                changed.preflight_id = Some("18dbfd7f-61d1-46ef-a316-87cb62d0cb95".into())
            }
            "role" => changed.role = "admin".into(),
            "mode" => changed.mode = "rollback".into(),
            "automatic" => changed.automatic_rollback = true,
            "invocation" => changed.invocation_id = uuid::Uuid::new_v4().to_string(),
            _ => changed.migrate_secrets = false,
        }
        let secrets = decode(&packet(&[("OPENAI_API_KEY", b"fixture-private-value")])).unwrap();
        assert!(
            secrets.frame(&changed).is_err(),
            "private transfer accepted a changed {field}"
        );
    }
}

#[test]
fn status_unknown_slots_duplicates_bad_utf8_and_truncation_never_produce_a_worker_frame() {
    for status in [1, 2, 3, 4, 255] {
        assert!(decode(&[status, 0, 0]).is_err());
    }
    assert!(decode(&packet(&[("UNDECLARED_PRIVATE_NAME", b"fixture")])).is_err());
    assert!(decode(&packet(&[
        ("OPENAI_API_KEY", b"first"),
        ("OPENAI_API_KEY", b"second")
    ]))
    .is_err());
    assert!(decode(&packet(&[("OPENAI_API_KEY", &[0xff, 0xfe])])).is_err());
    let valid = packet(&[("OPENAI_API_KEY", b"fixture")]);
    for end in 0..valid.len() {
        assert!(decode(&valid[..end]).is_err());
    }
    let mut trailing = valid;
    trailing.push(0);
    assert!(decode(&trailing).is_err());
}

#[test]
fn per_value_and_total_frame_caps_are_checked_before_accepting_values() {
    let large = vec![b'x'; MAX_VALUE + 1];
    assert!(decode(&packet(&[("OPENAI_API_KEY", &large)])).is_err());
    let oversized = vec![0; MAX_FRAME + 1];
    assert!(decode(&oversized).is_err());
    // UTF-8 is valid, but JSON escaping expands these values beyond the private worker frame limit.
    let controls = vec![0; MAX_VALUE];
    let secrets = decode(&packet(&[
        ("OPENAI_API_KEY", &controls),
        ("ANTHROPIC_API_KEY", &controls),
        ("COHERE_API_KEY", &controls),
    ]))
    .unwrap();
    assert!(secrets.frame(&job()).is_err());
}

#[test]
fn the_owned_worker_frame_is_bounded_and_can_be_wiped_after_its_private_pipe_write() {
    let secrets = decode(&packet(&[("OPENAI_API_KEY", b"fixture-private-value")])).unwrap();
    let mut frame: Zeroizing<Vec<u8>> = secrets.frame(&job()).unwrap();
    assert!(frame.len() <= MAX_FRAME);
    assert_eq!(frame.last(), Some(&b'\n'));
    frame.as_mut_slice().zeroize();
    assert!(frame.iter().all(|byte| *byte == 0));
}

#[test]
fn actual_core_role_i_lease_crosses_native_acquisition_and_the_private_worker_port_then_is_zeroed()
{
    let home = tempfile::tempdir().unwrap();
    let layout = Layout::new(home.path().into());
    let (mut broker, ready) = Fixture::start(home.path(), "real");
    let secrets = acquire(&layout, &job())
        .expect("real Core private broker must authenticate the native owner job");
    let mut frame = secrets.frame(&job()).unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(&*frame)),
        ready["frameSha256"].as_str().unwrap()
    );
    let status = broker.status();
    assert_eq!(status["taken"], 1);
    assert_eq!(
        status["released"], true,
        "native ACK must revoke the actual Core lease"
    );
    assert_eq!(status["preparedInputZeroed"], true);

    let mut worker = Fixture::spawn("worker");
    let job = job();
    let header = serde_json::json!({"v":1,"runId":job.run_id,"mode":"apply","home":home.path(),
        "plan":{"id":job.plan_id,"sha256":job.plan_sha256},"ownerId":job.owner_id,"attempt":1,
        "preflightId":job.preflight_id,"targetSha256":job.target_sha256});
    serde_json::to_writer(worker.input.as_mut().unwrap(), &header).unwrap();
    worker.input.as_mut().unwrap().write_all(b"\n").unwrap();
    worker.input.as_mut().unwrap().write_all(&frame).unwrap();
    frame.as_mut_slice().zeroize();
    assert!(frame.iter().all(|byte| *byte == 0));
    let accepted = worker.message();
    assert_eq!(accepted["slots"], 1);
    assert_eq!(accepted["hashes"][0], ready["valueSha256"]);
    assert_eq!(
        accepted["zeroed"], true,
        "actual worker lease release must wipe its values"
    );
    broker.assert_private(home.path());
    worker.assert_private(home.path());
}

#[test]
fn actual_broker_bad_auth_and_an_overlong_private_response_never_reach_the_worker() {
    for scenario in ["denied", "oversized"] {
        let home = tempfile::tempdir().unwrap();
        let layout = Layout::new(home.path().into());
        let (mut fixture, _) = Fixture::start(home.path(), scenario);
        assert!(acquire(&layout, &job()).is_err());
        let status = fixture.status();
        assert_eq!(status["taken"], 0);
        assert_eq!(status["lookups"], 0);
        fixture.assert_private(home.path());
    }
}

#[test]
fn non_owner_rollback_and_unselected_migration_never_lease_from_the_actual_core() {
    let home = tempfile::tempdir().unwrap();
    let layout = Layout::new(home.path().into());
    let (mut fixture, _) = Fixture::start(home.path(), "real");
    for field in ["role", "mode", "migration", "preflight"] {
        let mut denied = job();
        match field {
            "role" => denied.role = "admin".into(),
            "mode" => denied.mode = "rollback".into(),
            "migration" => denied.migrate_secrets = false,
            _ => denied.preflight_id = None,
        }
        assert!(acquire(&layout, &denied).is_err());
    }
    let status = fixture.status();
    assert_eq!(status["lookups"], 0);
    assert_eq!(status["taken"], 0);
    fixture.assert_private(home.path());
}

#[test]
fn a_stalled_live_core_binding_cannot_extend_the_native_absolute_deadline() {
    let home = tempfile::tempdir().unwrap();
    let layout = Layout::new(home.path().into());
    let (mut fixture, _) = Fixture::start(home.path(), "delay");
    let started = Instant::now();
    assert!(acquire_with_timeout(&layout, &job(), Duration::from_millis(200)).is_err());
    assert!(started.elapsed() < Duration::from_millis(800));
    let status = fixture.status();
    assert_eq!(status["taken"], 0);
    fixture.assert_private(home.path());
}

#[test]
fn an_expired_absolute_deadline_never_sends_a_core_authentication_request() {
    let home = tempfile::tempdir().unwrap();
    let layout = Layout::new(home.path().into());
    let (mut fixture, _) = Fixture::start(home.path(), "real");
    assert!(acquire_with_timeout(&layout, &job(), Duration::ZERO).is_err());
    // Status uses a different private pipe, so give an incorrectly queued socket request its event-loop turn.
    std::thread::sleep(Duration::from_millis(50));
    let status = fixture.status();
    assert_eq!(status["lookups"], 0);
    assert_eq!(status["taken"], 0);
    fixture.assert_private(home.path());
}

#[test]
fn private_channel_identity_and_token_file_limits_are_checked_before_a_core_lookup() {
    for oversized_token in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let layout = Layout::new(home.path().into());
        let (mut fixture, _) = Fixture::start(home.path(), "real");
        if oversized_token {
            std::fs::write(layout.core_token(), vec![b'x'; MAX_REQUEST + 1]).unwrap();
        } else {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(layout.run(), std::fs::Permissions::from_mode(0o777))
                    .unwrap();
            }
            #[cfg(windows)]
            std::fs::write(
                layout.core_pid(),
                format!("{} fixture\n", std::process::id()),
            )
            .unwrap();
        }
        assert!(acquire(&layout, &job()).is_err());
        let status = fixture.status();
        assert_eq!(status["lookups"], 0);
        assert_eq!(status["taken"], 0);
        fixture.assert_private(home.path());
    }
}

#[test]
fn source_policy_contains_the_same_sixteen_unique_names_as_the_core() {
    let allowed = names().unwrap();
    let source: Vec<String> = serde_json::from_str(SOURCE_NAMES).unwrap();
    assert_eq!(allowed.len(), 16);
    assert_eq!(source.len(), allowed.len());
    assert!(source.iter().all(|name| allowed.contains(name)));
}
