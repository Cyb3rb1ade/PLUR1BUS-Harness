//! Real native code CLI → two RPC connections → Core/router/dispatcher; deterministic coding tasks, no network/model downloads.
use assert_cmd::Command;
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Stdio},
    sync::mpsc::{self, Receiver},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

struct CoreFixture {
    child: Child,
    input: Option<ChildStdin>,
    output: Receiver<String>,
    reader: Option<JoinHandle<()>>,
    stderr: PathBuf,
}
impl CoreFixture {
    fn start(home: &Path, root: &Path, mode: &str) -> Self {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/core/test/coding/cli-core.mjs");
        let stderr = home.join("fixture-stderr.log");
        let log = std::fs::File::create(&stderr).expect("fixture log");
        let mut child = std::process::Command::new("node")
            .args([
                "--experimental-strip-types",
                "--conditions=source",
                "--no-warnings=ExperimentalWarning",
            ])
            .arg(fixture)
            .arg(home)
            .arg(root)
            .arg(mode)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log)
            .spawn()
            .expect("fixture Core");
        let input = child.stdin.take();
        let output = child.stdout.take().expect("Core stdout");
        let (sender, receiver) = mpsc::sync_channel(8);
        let reader = thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                match line {
                    Ok(line) => {
                        if sender.send(line).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        let mut fixture = Self {
            child,
            input,
            output: receiver,
            reader: Some(reader),
            stderr,
        };
        assert_eq!(fixture.read()["ready"], true);
        fixture
    }
    fn read(&mut self) -> Value {
        let line = self
            .output
            .recv_timeout(Duration::from_secs(30))
            .unwrap_or_else(|error| {
                panic!(
                    "Core fixture output: {error}; {}",
                    std::fs::read_to_string(&self.stderr).unwrap_or_default()
                )
            });
        serde_json::from_str(&line).expect("fixture JSON")
    }
    fn stats(&mut self) -> Value {
        writeln!(self.input.as_mut().expect("fixture stdin"), "stats").expect("control");
        self.input
            .as_mut()
            .expect("fixture stdin")
            .flush()
            .expect("flush");
        self.read()
    }
}
impl Drop for CoreFixture {
    fn drop(&mut self) {
        self.input.take();
        let deadline = Instant::now() + Duration::from_secs(6);
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        let (_, replacement) = mpsc::channel();
        drop(std::mem::replace(&mut self.output, replacement));
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
fn workspace() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().expect("temp");
    // Native paths avoid Windows 8.3 aliases and macOS /var → /private/var aliases in D109.
    let home = temp.path().join("home");
    let root = temp.path().join("repo");
    std::fs::create_dir(&home).expect("home");
    std::fs::create_dir(&root).expect("root");
    let root = std::fs::canonicalize(root).expect("native root");
    let home = std::fs::canonicalize(home).expect("native home");
    assert!(std::process::Command::new("git")
        .args(["init", "-q"])
        .arg(&root)
        .status()
        .expect("git")
        .success());
    std::fs::write(
        root.join("calc.ts"),
        "export const add = (a: number, b: number) => a - b;\n",
    )
    .expect("calc");
    std::fs::write(root.join("settings.json"), "{\"enabled\":false}\n").expect("settings");
    (temp, home, root)
}
fn documents(output: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(output)
        .lines()
        .map(|line| {
            serde_json::from_str(line).unwrap_or_else(|_| panic!("invalid CLI JSON: {line}"))
        })
        .collect()
}

#[test]
fn native_json_runs_two_coding_fixtures_through_the_real_dispatcher_and_two_connections() {
    let (_temp, home, root) = workspace();
    let mut core = CoreFixture::start(&home, &root, "tasks");
    let output = Command::cargo_bin("plur1bus")
        .expect("binary")
        .arg("--home")
        .arg(&home)
        .args(["--json", "code"])
        .arg(&root)
        .env("NO_COLOR", "1")
        .write_stdin("repair calculation\nrepair configuration\n")
        .timeout(Duration::from_secs(45))
        .output()
        .expect("CLI");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let docs = documents(&output.stdout);
    assert!(!docs.is_empty());
    assert!(docs.iter().all(|v| v["schema"] == "code.event/1"));
    assert!(!output.stdout.contains(&0x1b));
    let events: Vec<_> = docs
        .iter()
        .filter(|v| v["method"] == "session.event")
        .map(|v| &v["params"]["event"])
        .collect();
    assert_eq!(
        events
            .iter()
            .filter(|e| e["type"] == "turn.completed")
            .count(),
        2
    );
    let seq: Vec<_> = events
        .iter()
        .map(|e| e["seq"].as_u64().expect("seq"))
        .collect();
    assert_eq!(seq, (1..=seq.len() as u64).collect::<Vec<_>>());
    assert!(String::from_utf8_lossy(&output.stdout).contains("futureEnvelopeField"));
    let stats = core.stats();
    assert_eq!(stats["connections"], 2);
    assert_eq!(stats["sessions"], 1);
    assert_eq!(stats["bindings"], 1);
    assert_eq!(stats["edits"], 1);
    assert_eq!(stats["codingInstructions"], true);
    assert!(stats["calc"].as_str().expect("calc").contains("a + b"));
    assert_eq!(
        serde_json::from_str::<Value>(stats["settings"].as_str().expect("settings"))
            .expect("settings JSON")["enabled"],
        true
    );
    let tools = stats["tools"].as_array().expect("tools");
    assert!(tools.iter().any(|n| n == "file_write"));
    assert!(tools.iter().any(|n| n == "file_edit"));
    assert!(!tools.iter().any(|n| n == "code_session_open"));
}

#[test]
fn a_fullscreen_request_with_piped_json_keeps_the_line_protocol_and_two_connections() {
    let (_temp, home, root) = workspace();
    let mut core = CoreFixture::start(&home, &root, "tasks");
    let output = Command::cargo_bin("plur1bus")
        .expect("binary")
        .arg("--home")
        .arg(&home)
        .args(["--json", "code"])
        .arg(&root)
        .arg("--tui")
        .env("LC_ALL", "en_US.UTF-8")
        .write_stdin("repair calculation\n")
        .timeout(Duration::from_secs(45))
        .output()
        .expect("piped CLI");
    assert!(output.status.success(), "{output:?}");
    assert!(!output.stdout.contains(&0x1b));
    assert!(!output.stderr.contains(&0x1b));
    assert!(String::from_utf8_lossy(&output.stderr).contains("using line mode"));
    let docs = documents(&output.stdout);
    assert!(!docs.is_empty());
    assert!(docs.iter().all(|doc| doc["schema"] == "code.event/1"));
    assert!(docs.iter().any(|doc| {
        doc["method"] == "session.event" && doc["params"]["event"]["type"] == "turn.completed"
    }));
    let stats = core.stats();
    assert_eq!(stats["connections"], 2);
    assert_eq!(stats["bindings"], 1);
}

#[test]
fn incognito_keeps_the_worktree_binding_and_transcript_out_of_the_persistent_session_store() {
    let (_temp, home, root) = workspace();
    let mut core = CoreFixture::start(&home, &root, "tasks");
    let output = Command::cargo_bin("plur1bus")
        .expect("binary")
        .arg("--home")
        .arg(&home)
        .args(["--json", "code"])
        .arg(&root)
        .arg("repair calculation")
        .arg("--no-memory")
        .timeout(Duration::from_secs(45))
        .output()
        .expect("CLI");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(documents(&output.stdout)
        .iter()
        .any(|v| v["params"]["event"]["type"] == "turn.completed"));
    let stats = core.stats();
    assert_eq!(stats["sessions"], 0);
    assert_eq!(stats["bindings"], 0);
}

#[test]
fn a_non_tty_never_approves_a_tool_even_when_yes_is_set() {
    let (_temp, home, root) = workspace();
    let mut core = CoreFixture::start(&home, &root, "approval");
    let output = Command::cargo_bin("plur1bus")
        .expect("binary")
        .arg("--home")
        .arg(&home)
        .args(["--json", "code"])
        .arg(&root)
        .arg("run the fixture command")
        .arg("--yes")
        .timeout(Duration::from_secs(45))
        .output()
        .expect("CLI");
    let docs = documents(&output.stdout);
    assert!(
        !root.join("must-not-run").exists(),
        "--yes is never a tool approval"
    );
    assert!(
        docs.iter()
            .any(|v| v["method"] == "approval.decide"
                && v["result"]["approval"]["status"] == "denied"),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(docs.iter().any(|v| v["method"] == "code.approval-required"));
    assert!(!output.status.success());
    assert_eq!(
        docs.last().expect("final error")["error"],
        "E_APPROVAL_REQUIRED"
    );
    assert_eq!(core.stats()["connections"], 2);
}

#[cfg(unix)]
mod tty {
    use super::*;
    use std::{
        fs::File,
        io::Read,
        os::fd::{AsRawFd, FromRawFd},
        sync::{Arc, Mutex},
    };

    /// A real disposable terminal, including answers to cursor-position queries. No test touches the user's terminal.
    struct Terminal {
        slave: Option<File>,
        writer: Arc<Mutex<File>>,
        output: Option<Receiver<Vec<u8>>>,
        reader: Option<JoinHandle<()>>,
        transcript: Vec<u8>,
        cursor: usize,
        original: libc::tcflag_t,
    }
    impl Terminal {
        fn new() -> Self {
            let (mut master, mut slave) = (-1, -1);
            let mut size = libc::winsize {
                ws_row: 30,
                ws_col: 100,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            // SAFETY: openpty writes two owned descriptors into valid pointers; null requests default termios/no name.
            assert_eq!(
                unsafe {
                    libc::openpty(
                        &mut master,
                        &mut slave,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        &mut size,
                    )
                },
                0,
                "openpty"
            );
            for descriptor in [master, slave] {
                // SAFETY: openpty returned live owned descriptors; preserve them locally and prevent unintended child inheritance.
                assert_ne!(
                    unsafe { libc::fcntl(descriptor, libc::F_SETFD, libc::FD_CLOEXEC) },
                    -1
                );
            }
            // SAFETY: successful openpty returned distinct owned descriptors; each is transferred exactly once to File.
            let (master, slave) = unsafe { (File::from_raw_fd(master), File::from_raw_fd(slave)) };
            let original = flags(&slave);
            let mut input = master.try_clone().expect("PTY reader");
            let writer = Arc::new(Mutex::new(master));
            let replies = writer.clone();
            let (sender, output) = mpsc::sync_channel(32);
            let reader = thread::spawn(move || {
                let mut bytes = [0; 8192];
                let mut tail = Vec::new();
                loop {
                    match input.read(&mut bytes) {
                        Ok(0) | Err(_) => break,
                        Ok(count) => {
                            tail.extend_from_slice(&bytes[..count]);
                            while let Some(at) = tail.windows(4).position(|v| v == b"\x1b[6n") {
                                let _ = replies
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                    .write_all(b"\x1b[1;1R");
                                tail.drain(..at + 4);
                            }
                            if tail.len() > 8 {
                                tail.drain(..tail.len() - 8);
                            }
                            if sender.send(bytes[..count].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
            });
            Self {
                slave: Some(slave),
                writer,
                output: Some(output),
                reader: Some(reader),
                transcript: vec![],
                cursor: 0,
                original,
            }
        }
        fn launch(&self, home: &Path, root: &Path) -> Child {
            self.launch_frontend(home, root, false)
        }
        fn launch_frontend(&self, home: &Path, root: &Path, fullscreen: bool) -> Child {
            self.launch_with_term(home, root, fullscreen, "xterm-256color")
        }
        fn launch_with_term(
            &self,
            home: &Path,
            root: &Path,
            fullscreen: bool,
            term: &str,
        ) -> Child {
            let slave = self.slave.as_ref().expect("slave");
            let mut command = std::process::Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
            command.arg("--home").arg(home).arg("code").arg(root);
            if fullscreen {
                command.arg("--tui");
            }
            command
                .env("LC_ALL", "en_US.UTF-8")
                .env("TERM", term)
                .env("NO_COLOR", "1")
                .stdin(slave.try_clone().expect("stdin"))
                .stdout(slave.try_clone().expect("stdout"))
                .stderr(slave.try_clone().expect("stderr"))
                .spawn()
                .expect("TTY CLI")
        }
        fn send(&self, bytes: &[u8]) {
            self.writer
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .write_all(bytes)
                .expect("TTY input");
        }
        fn until(&mut self, text: &str) {
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                if let Some(at) = self.transcript[self.cursor..]
                    .windows(text.len())
                    .position(|part| part == text.as_bytes())
                {
                    self.cursor += at + text.len();
                    return;
                }
                assert!(
                    self.transcript.len() < 4 * 1024 * 1024,
                    "bounded terminal transcript"
                );
                let remaining = deadline.saturating_duration_since(Instant::now());
                let chunk = self
                    .output
                    .as_ref()
                    .expect("output")
                    .recv_timeout(remaining)
                    .unwrap_or_else(|error| {
                        panic!(
                            "waiting for {text}: {error}\n{}",
                            String::from_utf8_lossy(&self.transcript)
                        )
                    });
                self.transcript.extend(chunk);
            }
        }
        fn restored(&self) {
            assert_eq!(
                flags(self.slave.as_ref().expect("slave")) & (libc::ICANON | libc::ECHO),
                self.original & (libc::ICANON | libc::ECHO)
            );
        }
    }
    impl Drop for Terminal {
        fn drop(&mut self) {
            self.output.take();
            self.slave.take();
            if let Some(reader) = self.reader.take() {
                let _ = reader.join();
            }
        }
    }
    fn flags(file: &File) -> libc::tcflag_t {
        let mut value = std::mem::MaybeUninit::<libc::termios>::uninit();
        // SAFETY: file owns a live PTY descriptor and value is valid writable termios storage.
        assert_eq!(
            unsafe { libc::tcgetattr(file.as_raw_fd(), value.as_mut_ptr()) },
            0
        );
        // SAFETY: successful tcgetattr initialized all fields.
        unsafe { value.assume_init().c_lflag }
    }
    struct Process(Child);
    impl Process {
        fn wait(&mut self) -> std::process::ExitStatus {
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                if let Some(status) = self.0.try_wait().expect("wait") {
                    return status;
                }
                assert!(Instant::now() < deadline, "CLI must stop");
                thread::sleep(Duration::from_millis(10));
            }
        }
    }
    impl Drop for Process {
        fn drop(&mut self) {
            if self.0.try_wait().ok().flatten().is_none() {
                let _ = self.0.kill();
            }
            let _ = self.0.wait();
        }
    }

    #[test]
    fn scripted_real_tty_approves_once_and_restores_echo_and_canonical_input() {
        let (_temp, home, root) = workspace();
        let _core = CoreFixture::start(&home, &root, "attested");
        let mut terminal = Terminal::new();
        let mut process = Process(terminal.launch(&home, &root));
        terminal.until("[idle]");
        terminal.send(b"run the fixture command\r");
        terminal.until("Approval:");
        terminal.until("[y]");
        terminal.send(b"y\r");
        terminal.until("Approved fixture completed.");
        terminal.until("[idle]");
        terminal.send(b"\x04");
        assert!(process.wait().success());
        terminal.restored();
        assert!(
            root.join("must-not-run").is_file(),
            "execution requires the scripted physical y\n{}",
            String::from_utf8_lossy(&terminal.transcript)
        );
    }

    #[test]
    fn a_dumb_terminal_uses_line_input_and_never_enters_the_fullscreen_view() {
        let (_temp, home, root) = workspace();
        let mut core = CoreFixture::start(&home, &root, "tasks");
        let mut terminal = Terminal::new();
        let mut process = Process(terminal.launch_with_term(&home, &root, true, "dumb"));
        terminal.until("using line mode");
        terminal.until("[idle]");
        terminal.send(b"\x04");
        assert!(process.wait().success());
        terminal.restored();
        assert!(!String::from_utf8_lossy(&terminal.transcript).contains("\x1b[?1049h"));
        let stats = core.stats();
        assert_eq!(stats["bindings"], 1);
        assert!(stats["connections"].as_u64().expect("connection count") <= 2);
    }

    #[cfg(feature = "tui")]
    #[test]
    fn fullscreen_sigterm_uses_the_shared_core_and_restores_before_exit_without_approval() {
        let (_temp, home, root) = workspace();
        let mut core = CoreFixture::start(&home, &root, "approval");
        let mut terminal = Terminal::new();
        let mut process = Process(terminal.launch_frontend(&home, &root, true));
        terminal.until("\x1b[?1049h");
        terminal.until("Transcript");
        terminal.send(b"run the fixture command\r");
        terminal.until("Approval");
        // SAFETY: this live unreaped disposable Child owns the positive process id; no other process is signalled.
        assert_eq!(
            unsafe { libc::kill(process.0.id() as libc::pid_t, libc::SIGTERM) },
            0
        );
        assert!(!process.wait().success());
        terminal.until("\x1b[?1049l");
        terminal.restored();
        assert!(!root.join("must-not-run").exists());
        let stats = core.stats();
        assert_eq!(stats["bindings"], 1);
        assert!(stats["connections"].as_u64().expect("connection count") <= 2);
    }

    #[cfg(feature = "tui")]
    #[test]
    fn fullscreen_human_confirmation_runs_once_then_idle_eof_restores_the_terminal() {
        let (_temp, home, root) = workspace();
        let mut core = CoreFixture::start(&home, &root, "attested");
        let mut terminal = Terminal::new();
        let mut process = Process(terminal.launch_frontend(&home, &root, true));
        terminal.until("\x1b[?1049h");
        terminal.until("Transcript");
        terminal.send(b"run the fixture command\r");
        terminal.until("[y]");
        assert!(!root.join("must-not-run").exists());
        terminal.send(b"y\r");
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let stats = core.stats();
            if root.join("must-not-run").is_file() && stats["running"] == 0 {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "explicit human confirmation must complete the turn: {stats}"
            );
            thread::sleep(Duration::from_millis(10));
        }
        terminal.until("idle");
        terminal.send(b"\x04");
        assert!(process.wait().success());
        terminal.until("\x1b[?1049l");
        terminal.restored();
        let stats = core.stats();
        assert_eq!(stats["bindings"], 1);
        assert!(stats["connections"].as_u64().expect("connection count") <= 2);
    }
    #[test]
    fn a_real_tty_gets_one_core_folder_request_and_the_t1_os_confirmation_path() {
        let (_temp, home, root) = workspace();
        let mut core = CoreFixture::start(&home, &root, "folder");
        let mut terminal = Terminal::new();
        let mut process = Process(terminal.launch(&home, &root));
        terminal.until("folder recursively?");
        terminal.until("[y/N]");
        terminal.send(b"y\r");
        terminal.until("[idle]");
        terminal.send(b"fix calculation\r");
        terminal.until("Calculation fixed.");
        terminal.until("[idle]");
        terminal.send(b"\x04");
        assert!(process.wait().success());
        terminal.restored();
        let stats = core.stats();
        assert_eq!(
            stats["osConfirmations"], 1,
            "one OS-bound decision, no T3 assertion"
        );
        assert_eq!(stats["bindings"], 1);
        assert!(stats["connections"].as_u64().unwrap() <= 2);
        assert!(stats["calc"].as_str().unwrap().contains("a + b"));
    }

    #[test]
    fn sigterm_during_an_approval_restores_the_terminal_and_never_executes_the_tool() {
        let (_temp, home, root) = workspace();
        let _core = CoreFixture::start(&home, &root, "approval");
        let mut terminal = Terminal::new();
        let mut process = Process(terminal.launch(&home, &root));
        terminal.until("[idle]");
        terminal.send(b"run the fixture command\r");
        terminal.until("Approval:");
        // SAFETY: the unreaped Child owns this positive process id; SIGTERM is delivered only to that disposable CLI.
        assert_eq!(
            unsafe { libc::kill(process.0.id() as libc::pid_t, libc::SIGTERM) },
            0
        );
        assert!(!process.wait().success());
        terminal.restored();
        assert!(!root.join("must-not-run").exists());
    }
    #[test]
    fn two_control_c_keys_exit_a_busy_real_tty_and_restore_it() {
        let (_temp, home, root) = workspace();
        let _core = CoreFixture::start(&home, &root, "approval");
        let mut terminal = Terminal::new();
        let mut process = Process(terminal.launch(&home, &root));
        terminal.until("[idle]");
        terminal.send(b"run the fixture command\r");
        terminal.until("Approval:");
        terminal.send(b"\x03\x03");
        process.wait();
        terminal.restored();
        assert!(!root.join("must-not-run").exists());
    }
}
