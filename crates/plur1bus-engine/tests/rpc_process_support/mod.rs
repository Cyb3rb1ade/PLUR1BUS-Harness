//! Black-box process support: every spawned engine is killed and reaped on every test path.

use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub const GRACE: Duration = Duration::from_millis(1000);
const PROCESS_TIMEOUT: Duration = Duration::from_secs(10);
const CALL_TIMEOUT: Duration = Duration::from_secs(3);
static PROCESS_TEST: Mutex<()> = Mutex::new(());

pub fn process_test() -> MutexGuard<'static, ()> {
    // Bound process count even when cargo's test harness runs tests concurrently.
    PROCESS_TEST
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

pub fn home() -> tempfile::TempDir {
    // A short path also keeps the Unix socket below sockaddr_un's platform limit.
    let home = tempfile::Builder::new()
        .prefix("pe-")
        .tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap())
        .unwrap();
    let mut config = plur1bus_config::defaults();
    // Keep the real schemaVersion and defaults; only shorten the documented orphan grace.
    config["supervisor"]["graceMs"] = json!(1000);
    fs::write(
        home.path().join("config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    home
}

pub fn supervisor_token(home: &Path, token: &str) {
    let path = home.join("run/supervisor.token");
    fs::write(&path, token).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }
}

pub struct EngineProcess {
    child: Child,
    logs: tempfile::TempDir,
    pub home: PathBuf,
    pub ready: Value,
}

impl EngineProcess {
    pub fn spawn(home: &Path, instance: Option<&str>) -> Self {
        Self::spawn_configured(home, instance, true, None, None)
    }

    pub fn spawn_with_seam(home: &Path, variant: &str, allow: bool) -> Self {
        Self::spawn_configured(home, None, true, Some((variant, allow)), None)
    }

    pub fn spawn_configured(
        home: &Path,
        instance: Option<&str>,
        stdin_lifeline: bool,
        seam: Option<(&str, bool)>,
        configure_child: Option<fn(&mut Command)>,
    ) -> Self {
        let logs = tempfile::Builder::new()
            .prefix("pe-log-")
            .tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap())
            .unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_plur1bus-engine"));
        command
            .arg("serve")
            .arg("--home")
            .arg(home)
            .env_remove("PLUR1BUS_TEST_INTERNALS")
            .env_remove("PLUR1BUS_TEST_ACCEPT_ERROR")
            .env_remove("PLUR1BUS_ALLOW_TEST_INTERNALS")
            // Files avoid blocking pipe-reader threads when startup or shutdown fails.
            .stdout(Stdio::from(
                File::create(logs.path().join("stdout")).unwrap(),
            ))
            .stderr(Stdio::from(
                File::create(logs.path().join("stderr")).unwrap(),
            ))
            // EOF also reclaims engines when the test runner exits without unwinding.
            .stdin(Stdio::piped());
        if let Some(instance) = instance {
            command.args(["--instance", instance]);
        }
        if stdin_lifeline {
            command.args(["--lifeline", "stdin"]);
        }
        if let Some((variant, allow)) = seam {
            command.args(["--test-internals", variant]);
            if allow {
                command.env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1");
            }
        }
        if let Some(configure) = configure_child {
            configure(&mut command);
        }
        Self {
            child: command.spawn().unwrap(),
            logs,
            home: home.to_path_buf(),
            ready: Value::Null,
        }
    }

    pub fn start(home: &Path, instance: Option<&str>) -> Self {
        Self::spawn(home, instance).wait_ready()
    }

    pub fn start_without_lifeline(home: &Path) -> Self {
        Self::spawn_configured(home, None, false, None, None).wait_ready()
    }

    #[cfg(unix)]
    pub fn start_with_umask_022(home: &Path, instance: Option<&str>) -> Self {
        fn configure(command: &mut Command) {
            use std::os::unix::process::CommandExt;
            // SAFETY: this hook runs only in the forked child, before exec, and
            // calls only the async-signal-safe umask syscall. The test runner's
            // process-wide umask is never changed.
            unsafe {
                command.pre_exec(|| {
                    libc::umask(0o022);
                    Ok(())
                });
            }
        }
        Self::spawn_configured(home, instance, true, None, Some(configure)).wait_ready()
    }

    pub fn start_with_seam(home: &Path, variant: &str) -> Self {
        Self::spawn_with_seam(home, variant, true).wait_ready()
    }

    fn wait_ready(self) -> Self {
        let mut process = self;
        let deadline = Instant::now() + PROCESS_TIMEOUT;
        loop {
            let stdout = process.log("stdout");
            if let Some(line) = stdout.lines().find(|line| line.ends_with('}')) {
                let ready: Value = serde_json::from_str(line)
                    .unwrap_or_else(|error| panic!("invalid readiness JSON: {error}\n{stdout}"));
                assert_eq!(ready["ready"], true, "{ready}");
                assert_eq!(ready["pid"].as_u64(), Some(u64::from(process.pid())));
                assert!(ready["address"].as_str().is_some_and(|s| !s.is_empty()));
                process.ready = ready;
                return process;
            }
            assert!(
                process.child.try_wait().unwrap().is_none(),
                "engine exited before readiness\n{}",
                process.diagnostics()
            );
            assert!(
                Instant::now() < deadline,
                "engine did not publish readiness\n{}",
                process.diagnostics()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn address(&self) -> &str {
        self.ready["address"].as_str().unwrap()
    }

    pub fn token(&self) -> String {
        fs::read_to_string(self.home.join("run/engine.token"))
            .unwrap()
            .trim()
            .to_owned()
    }

    pub fn connect(&self) -> Client {
        Client::connect_with_auth(
            self.address(),
            json!({"token": self.token(), "clientId": "rpc-process-test"}),
            ConnectOptions {
                endpoint: Endpoint::Engine,
                expected_server_pid: Some(self.pid()),
                connect_timeout: CALL_TIMEOUT,
                call_timeout: CALL_TIMEOUT,
            },
        )
        .unwrap_or_else(|error| {
            panic!(
                "engine authentication failed: {error}\n{}",
                self.diagnostics()
            )
        })
    }

    pub fn close_stdin(&mut self) {
        assert!(
            self.child.stdin.take().is_some(),
            "stdin lifeline was present"
        );
    }

    pub fn kill_and_wait(&mut self) -> ExitStatus {
        self.child.kill().unwrap();
        self.child.wait().unwrap()
    }

    pub fn assert_running_for(&mut self, duration: Duration) {
        let deadline = Instant::now() + duration;
        while Instant::now() < deadline {
            assert!(
                self.child.try_wait().unwrap().is_none(),
                "engine exited while its lifeline should keep it alive\n{}",
                self.diagnostics()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn wait_for_exit(&mut self) -> ExitStatus {
        let deadline = Instant::now() + PROCESS_TIMEOUT;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(
                Instant::now() < deadline,
                "engine did not exit\n{}",
                self.diagnostics()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn assert_run_files_removed(&self) {
        for name in ["engine.token", "engine.pid"] {
            assert!(
                !self.home.join("run").join(name).exists(),
                "{name} remained"
            );
        }
        #[cfg(unix)]
        assert!(!self.home.join("run/engine.sock").exists());
    }

    pub fn diagnostics(&self) -> String {
        format!(
            "stdout: {}\nstderr: {}",
            self.log("stdout"),
            self.log("stderr")
        )
    }

    pub fn stderr(&self) -> String {
        self.log("stderr")
    }

    fn log(&self, stream: &str) -> String {
        fs::read_to_string(self.logs.path().join(stream)).unwrap_or_default()
    }
}

impl Drop for EngineProcess {
    fn drop(&mut self) {
        // Child::kill + wait covers Unix and Windows, including assertion unwinding.
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

pub struct RawConnection {
    reader: BufReader<Box<dyn plur1bus_rpc::transport::Stream>>,
}

impl RawConnection {
    pub fn connect(address: &str) -> Self {
        let stream = plur1bus_rpc::transport::connect(address, CALL_TIMEOUT).unwrap();
        stream.set_read_timeout(Some(CALL_TIMEOUT)).unwrap();
        Self {
            reader: BufReader::new(stream),
        }
    }

    pub fn send(&mut self, request: Value) {
        self.send_batch(&[request]);
    }

    pub fn send_batch(&mut self, requests: &[Value]) {
        let mut lines = String::new();
        for request in requests {
            lines.push_str(&request.to_string());
            lines.push('\n');
        }
        let stream = self.reader.get_mut();
        stream.write_all(lines.as_bytes()).unwrap();
        stream.flush().unwrap();
    }

    pub fn response(&mut self) -> io::Result<Option<Value>> {
        let mut line = String::new();
        if self.reader.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        serde_json::from_str(&line)
            .map(Some)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    pub fn call(&mut self, id: u64, method: &str, params: Value) -> Value {
        let mut message = json!({"jsonrpc": "2.0", "id": id, "method": method});
        message["params"] = params;
        self.send(message);
        let response = self.response().unwrap().expect("RPC response before EOF");
        assert_eq!(response["id"], id);
        response
    }
}

pub fn assert_unauthorized(response: &Value) {
    assert_eq!(
        response["error"]["data"]["error"], "E_UNAUTHORIZED",
        "{response}"
    );
    assert!(response.get("result").is_none(), "{response}");
}
