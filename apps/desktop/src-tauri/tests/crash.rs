use plur1bus_desktop::{crash::CrashReporter, logging::*};
use std::{
    fs,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

fn writer(dir: &std::path::Path, resolver: Arc<dyn CredentialPathResolver>) -> Writer {
    let secrets = Arc::new(SecretRegistry::default());
    secrets.register("syntheticPanicSecretValue").unwrap();
    Writer::open(
        &dir.canonicalize().unwrap(),
        WriterOptions::default(),
        Formatter::new(secrets, resolver, false),
        Arc::new(SystemClock),
    )
    .unwrap()
}

#[test]
fn isolated_panic_child() {
    let Ok(dir) = std::env::var("WP06_CRASH_CHILD_DIR") else {
        return;
    };
    let blocked = std::env::var_os("WP06_CRASH_CHILD_BLOCKED").is_some();
    let writer = writer(
        std::path::Path::new(&dir),
        if blocked {
            Arc::new(PanickingResolver(Mutex::new(false)))
        } else {
            Arc::new(CredentialPaths::new("/synthetic/home"))
        },
    );
    let reporter = CrashReporter::new(writer.clone(), "synthetic-test-target").unwrap();
    reporter.install_hook().unwrap();
    for _ in 0..205 {
        let mut input = RecordInput::new(Event::AppCrashed {
            crash_id: "crash-prior".into(),
        });
        input.err = Some(DiagnosticError {
            code: ErrorCode::Auth,
            reason: "native_failure".into(),
            retryable: false,
            hint: None,
        });
        writer.emit(input).unwrap();
    }
    if blocked {
        writer.emit(RecordInput::new(Event::AppStarted)).unwrap();
    }
    panic!("syntheticPanicSecretValue token=syntheticPanicToken https://user:password@example.invalid/?ticket=syntheticTicket#syntheticFragment Cookie: sid=syntheticPanicCookie");
}

struct PanickingResolver(Mutex<bool>);
impl CredentialPathResolver for PanickingResolver {
    fn classify(&self, _: &str) -> Result<Option<DeniedPath>, RedactionError> {
        let mut seen = self.0.lock().unwrap();
        if !*seen {
            *seen = true;
            panic!("syntheticPanicSecretValue");
        }
        Ok(None)
    }
}

fn child(dir: &std::path::Path, blocked: bool) {
    let mut cmd = Command::new(std::env::current_exe().unwrap());
    cmd.args(["--exact", "isolated_panic_child", "--nocapture"])
        .env("WP06_CRASH_CHILD_DIR", dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if blocked {
        cmd.env("WP06_CRASH_CHILD_BLOCKED", "1");
    }
    let mut process = cmd.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if process.try_wait().unwrap().is_some() {
            break;
        }
        if Instant::now() > deadline {
            let _ = process.kill();
            panic!("panic hook exceeded bounded subprocess budget");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = process.wait_with_output().unwrap();
    assert!(!output.status.success());
    for bytes in [&output.stdout, &output.stderr] {
        let text = String::from_utf8_lossy(bytes);
        for secret in [
            "syntheticPanicSecretValue",
            "syntheticPanicToken",
            "syntheticTicket",
            "syntheticFragment",
            "syntheticPanicCookie",
        ] {
            assert!(!text.contains(secret), "default panic output leaked secret");
        }
    }
}

#[test]
fn panic_writes_a_redacted_crash_file_and_the_next_start_offers_it() {
    let dir = tempfile::tempdir().unwrap();
    child(dir.path(), false);
    let w = writer(
        dir.path(),
        Arc::new(CredentialPaths::new("/synthetic/home")),
    );
    let reporter = CrashReporter::new(w, "synthetic-test-target").unwrap();
    let pending = reporter.pending().unwrap();
    assert_eq!(pending.len(), 1);
    let text = pending[0].details();
    assert!(text.contains("PLUR1BUS desktop crash"));
    assert!(text.contains("Backtrace:"));
    assert!(text.contains("synthetic-test-target"));
    assert_eq!(text.matches("desktop.app.crashed").count(), 200);
    assert_eq!(
        text.matches("\"code\":\"auth\"").count(),
        200,
        "typed snapshot error codes must survive redaction"
    );
    for value in [
        "syntheticPanicSecretValue",
        "syntheticPanicToken",
        "syntheticTicket",
        "syntheticFragment",
        "syntheticPanicCookie",
    ] {
        assert!(!text.contains(value), "crash details leaked secret");
        for file in fs::read_dir(dir.path()).unwrap() {
            let path = file.unwrap().path();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
            assert!(
                !fs::read_to_string(path).unwrap().contains(value),
                "crash sink leaked secret"
            );
        }
    }
    assert_eq!(
        reporter.pending().unwrap().len(),
        1,
        "unopened evidence must remain pending"
    );
    let all: String = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .map(|p| fs::read_to_string(p).unwrap())
        .collect();
    assert_eq!(
        all.lines().filter(|l| l.contains(pending[0].id())).count(),
        1,
        "startup fatal must get a durable one-time receipt"
    );
    reporter.mark_handled(&pending[0]).unwrap();
    assert!(reporter.pending().unwrap().is_empty());
    assert!(
        fs::read_dir(dir.path()).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".txt")),
        "handling must not delete evidence"
    );
}

#[test]
fn panic_while_redactor_and_writer_are_locked_is_bounded_and_never_raw() {
    let dir = tempfile::tempdir().unwrap();
    child(dir.path(), true);
    let w = writer(
        dir.path(),
        Arc::new(CredentialPaths::new("/synthetic/home")),
    );
    let reporter = CrashReporter::new(w, "synthetic-test-target").unwrap();
    let pending = reporter.pending().unwrap();
    assert_eq!(pending.len(), 1);
    assert!(pending[0].details().contains("[REDACTED:unavailable]"));
    let records: String = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .map(|p| fs::read_to_string(p).unwrap())
        .collect();
    assert!(
        records.contains("\"event\":\"log.redaction.failed\""),
        "next startup must account for fail-closed crash formatting"
    );
}

#[test]
fn concurrent_crash_offer_requests_keep_the_offer_and_one_startup_receipt() {
    let dir = tempfile::tempdir().unwrap();
    child(dir.path(), false);
    let reporter = CrashReporter::new(
        writer(
            dir.path(),
            Arc::new(CredentialPaths::new("/synthetic/home")),
        ),
        "synthetic-test-target",
    )
    .unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(16));
    let results = std::thread::scope(|scope| {
        let readers: Vec<_> = (0..16)
            .map(|_| {
                let reporter = reporter.clone();
                let barrier = barrier.clone();
                scope.spawn(move || {
                    barrier.wait();
                    reporter.pending()
                })
            })
            .collect();
        readers
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>()
    });
    let mut id = None;
    for result in results {
        let offers = result.expect("simultaneous startup requests must not lose the crash offer");
        assert_eq!(offers.len(), 1);
        assert!(
            offers[0].details().contains("Backtrace:"),
            "concurrent readers must not contend with their own formatter"
        );
        assert!(!offers[0].details().contains("syntheticPanicSecretValue"));
        let same = id.get_or_insert_with(|| offers[0].id().to_owned());
        assert_eq!(same, offers[0].id());
    }
    let records: String = fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "jsonl")
        })
        .map(|path| fs::read_to_string(path).unwrap())
        .collect();
    assert_eq!(
        records
            .lines()
            .filter(|line| line.contains(id.as_ref().unwrap()))
            .count(),
        1
    );
}
