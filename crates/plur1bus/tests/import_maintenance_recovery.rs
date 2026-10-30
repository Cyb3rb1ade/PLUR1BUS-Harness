//! Real supervisor/Core acceptance: explicit same-plan resume and killed cold-copy startup recovery.
mod common;

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(150);

struct HttpFixture {
    child: Child,
    input: Option<ChildStdin>,
    output: Receiver<Value>,
    errors: PathBuf,
}

impl HttpFixture {
    fn start(home: &Path, source: &Path, mode: &str, errors: PathBuf) -> Self {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut child = Command::new("node")
            .args([
                "--experimental-strip-types",
                "--conditions=source",
                "--no-warnings=ExperimentalWarning",
            ])
            .arg(root.join("packages/api/test/fixtures/import-maintenance-recovery.mjs"))
            .args([home.as_os_str(), source.as_os_str(), mode.as_ref()])
            .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(std::fs::File::create(&errors).unwrap())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let (send, output) = mpsc::sync_channel(4);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                if line.len() > 65_536 {
                    break;
                }
                let Ok(value) = serde_json::from_str(&line) else {
                    break;
                };
                if send.send(value).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            output,
            errors,
        }
    }

    fn next(&self) -> Value {
        self.output.recv_timeout(WAIT).unwrap_or_else(|_| {
            panic!(
                "actual recovery HTTP fixture ended before its metadata handshake: {}{}",
                std::fs::read_to_string(&self.errors).unwrap_or_default(),
                common::log_tails()
            )
        })
    }

    fn command(&mut self, name: &str) {
        let input = self.input.as_mut().unwrap();
        writeln!(input, "{}", json!({"type":name})).unwrap();
        input.flush().unwrap();
    }

    fn finish(mut self, expected: &[&str]) {
        let result = self.next();
        assert_eq!(result["phase"], "complete", "{result}");
        let proofs = result["proofs"].as_object().unwrap();
        assert_eq!(proofs.len(), expected.len());
        for name in expected {
            assert_eq!(
                proofs[*name], true,
                "missing real-stack recovery proof {name}"
            );
        }
        self.input.take();
        common::wait_until(
            "recovery HTTP fixture exit",
            Duration::from_secs(10),
            || self.child.try_wait().unwrap().is_some(),
        );
        assert!(
            self.child.wait().unwrap().success(),
            "{}",
            std::fs::read_to_string(&self.errors).unwrap_or_default()
        );
    }
}

impl Drop for HttpFixture {
    fn drop(&mut self) {
        self.input.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn prepare(home: &Path) {
    std::fs::create_dir(home).unwrap();
    let mut config = serde_json::to_value(plur1bus_config::defaults()).unwrap();
    config["engine"] =
        json!({"neo":{"enabled":false},"reranker":{"enabled":false},"dreaming":{"enabled":false}});
    std::fs::write(
        home.join("config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
}

fn start(home: &Path, events: &Path) -> common::Supervisor {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let entry = root.join("packages/core/dist/core.js");
    assert!(
        entry.is_file(),
        "standard Core build prerequisite is required"
    );
    common::start_with_core(
        home,
        events,
        "0.2",
        &[
            ("PLUR1BUS_CORE_JS", entry.to_str().unwrap()),
            ("PLUR1BUS_TEST_INTERNALS", "flat-embedder"),
        ],
    )
}

fn ready(home: &Path) {
    let mut client = common::client(home);
    common::wait_child(
        &mut client,
        "actual Core ready",
        Duration::from_secs(40),
        |child| child["process"]["state"] == "ready",
    );
}

#[cfg(unix)]
fn worker(supervisor: u32) -> Option<u32> {
    let output = Command::new("ps")
        .args(["-ww", "-axo", "pid=,ppid=,command="])
        .output()
        .ok()?;
    String::from_utf8(output.stdout)
        .ok()?
        .lines()
        .find_map(|line| {
            let mut words = line.split_whitespace();
            let pid = words.next()?.parse().ok()?;
            let parent: u32 = words.next()?.parse().ok()?;
            let command = words.collect::<Vec<_>>().join(" ");
            (parent == supervisor
                && command.contains("import.js")
                && command.ends_with(" --supervised"))
            .then_some(pid)
        })
}

#[cfg(windows)]
fn worker(supervisor: u32) -> Option<u32> {
    let root = std::env::var_os("SystemRoot")?;
    let command = format!(
        "Get-CimInstance Win32_Process -Filter 'ParentProcessId = {supervisor}' | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    );
    let output =
        Command::new(PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe"))
            .args(["-NoProfile", "-NonInteractive", "-Command", &command])
            .output()
            .ok()?;
    let value: Value = serde_json::from_slice(&output.stdout).ok()?;
    let values = value.as_array().cloned().unwrap_or_else(|| vec![value]);
    values.into_iter().find_map(|value| {
        let command = value["CommandLine"].as_str()?;
        (command.contains("import.js") && command.ends_with(" --supervised"))
            .then_some(value["ProcessId"].as_u64()? as u32)
    })
}

fn kill_worker(pid: u32) {
    #[cfg(unix)]
    // SAFETY: this is the isolated process group of the actual import worker identified under our supervisor.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot").unwrap();
        let _ = Command::new(PathBuf::from(root).join("System32/taskkill.exe"))
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[test]
fn aborted_native_import_resumes_the_same_plan_only_after_a_fresh_preflight_and_completes_attempt_two(
) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let home = root.join("h");
    prepare(&home);
    let _supervisor = start(&home, &root.join("events.jsonl"));
    ready(&home);
    let fixture = HttpFixture::start(&home, &root.join("source"), "resume", root.join("http.log"));
    fixture.finish(&[
        "aborted",
        "baselineExact",
        "freshPreflight",
        "samePlan",
        "attemptTwo",
        "importedDisabledSkill",
    ]);
    common::client(&home)
        .call("daemon.stop", json!({"budgetMs":5000}))
        .unwrap();
}

#[test]
fn killed_supervisor_and_cold_copy_worker_recover_every_root_before_a_new_core_opens() {
    #[cfg(target_os = "linux")]
    // SAFETY: reap only the specific worker orphaned by this test, never another test's children.
    unsafe {
        libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
    }
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let home = root.join("h");
    prepare(&home);
    let events = root.join("events.jsonl");
    let mut supervisor = start(&home, &events);
    ready(&home);
    let mut fixture =
        HttpFixture::start(&home, &root.join("source"), "crash", root.join("http.log"));
    let checkpoint = fixture.next();
    assert_eq!(checkpoint["phase"], "dirty-cold-copy", "{checkpoint}");
    let run_id = checkpoint["runId"].as_str().unwrap();
    assert!(uuid::Uuid::parse_str(run_id).is_ok());
    #[cfg(unix)]
    // SAFETY: pause our supervisor first so its scheduler cannot race the simulated process loss.
    unsafe {
        assert_eq!(libc::kill(supervisor.child.id() as i32, libc::SIGSTOP), 0);
    }
    let worker = worker(supervisor.child.id())
        .expect("the actual cold-copy Node worker must still be running");
    supervisor.child.kill().unwrap();
    supervisor.child.wait().unwrap();
    kill_worker(worker);
    #[cfg(unix)]
    {
        let mut status = 0;
        // SAFETY: only the verified child of our killed supervisor can be reaped here.
        unsafe {
            libc::waitpid(worker as i32, &mut status, 0);
        }
    }
    let journal_path = home.join("imports").join(run_id).join("maintenance.json");
    let journal: Value = serde_json::from_slice(&std::fs::read(&journal_path).unwrap()).unwrap();
    assert_eq!(
        journal["phase"], "snapshotting",
        "kill must interrupt the real partial cold copy"
    );
    let _restarted = start(&home, &events);
    fixture.command("recovering");
    let mut client = common::client(&home);
    let until = Instant::now() + WAIT;
    let mut offline_status = false;
    loop {
        let core_missing = !home.join("run/api-delegation.token").exists();
        let status = client
            .call("admin.import.status", json!({"runId":run_id}))
            .unwrap();
        offline_status |= core_missing && !home.join("run/api-delegation.token").exists();
        let daemon = client.call("daemon.status", json!({})).unwrap();
        let core = daemon["children"]
            .as_array()
            .unwrap()
            .iter()
            .find(|child| child["role"] == "core");
        if core.is_some_and(|child| child["pid"].is_u64()) {
            let journal: Value =
                serde_json::from_slice(&std::fs::read(&journal_path).unwrap()).unwrap();
            assert_eq!(journal["phase"], "prepared");
            assert_eq!(
                journal["history"].as_array().unwrap().last().unwrap()["reason"],
                "recovered"
            );
        }
        if status["run"]["restored"] == true {
            assert!(matches!(
                status["run"]["state"].as_str(),
                Some("completed" | "failed" | "aborted")
            ));
            break;
        }
        assert!(
            Instant::now() < until,
            "native LocalOwner recovery metadata stays bounded"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        offline_status,
        "native LocalOwner status must work while Core is absent"
    );
    ready(&home);
    fixture.command("recovered");
    fixture.finish(&[
        "dirtyColdCopy",
        "oldProofDenied",
        "recoveredBeforeCore",
        "nativeOfflineStatus",
        "baselineExact",
        "freshApi",
    ]);
    client
        .call("daemon.stop", json!({"budgetMs":5000}))
        .unwrap();
}
