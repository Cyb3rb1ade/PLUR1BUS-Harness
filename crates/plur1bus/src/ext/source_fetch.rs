//! Worker-only bounded stdin/streaming stdout port to the Core's shared egress service (M-A11).
use plur1bus_ext::claude::EgressFetch;
use plur1bus_ext::refusal::Refusal;
use serde_json::{json, Value};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};

/// Runs only inside an isolated ext worker: its process group and deadline also cover this child.
pub struct NodeSourceFetch {
    home: PathBuf,
    node: PathBuf,
    entry: PathBuf,
}

impl NodeSourceFetch {
    /// Uses the caller's existing pinned-runtime and Core entry locators; no second search or shell.
    pub fn new(home: PathBuf, node: PathBuf, core_entry: PathBuf) -> Self {
        Self {
            home,
            node,
            entry: core_entry.with_file_name("extension-source.js"),
        }
    }
}

fn failure(code: &'static str, reason: &'static str) -> Refusal {
    Refusal {
        code,
        reason,
        detail: "plugin source fetch was refused or unavailable".into(),
    }
}

fn reply(value: &Value) -> Refusal {
    match value["reason"].as_str() {
        Some("egress-denied") => failure("E_DENIED", "egress-denied"),
        Some("config-invalid") => failure("E_CONFIG_INVALID", "config-invalid"),
        Some("download-too-large") => failure("E_INVALID_PARAMS", "download-too-large"),
        Some("package-invalid") => failure("E_INVALID_PARAMS", "package-invalid"),
        _ => failure("E_NOT_AVAILABLE", "source-unreachable"),
    }
}

struct Body {
    child: Child,
    stdout: ChildStdout,
    _stderr: BufReader<ChildStderr>,
    remaining: u64,
    finished: bool,
}

impl Read for Body {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() || self.finished {
            return Ok(0);
        }
        let limit = buffer
            .len()
            .min(self.remaining.saturating_add(1).min(usize::MAX as u64) as usize);
        let n = self.stdout.read(&mut buffer[..limit])?;
        if n as u64 > self.remaining {
            return Err(io::Error::other("plugin source exceeds its byte limit"));
        }
        self.remaining -= n as u64;
        if n == 0 {
            self.finished = true;
            let status = self.child.wait()?;
            if !status.success() {
                return Err(io::Error::other("plugin source stream failed"));
            }
        }
        Ok(n)
    }
}

impl Drop for Body {
    fn drop(&mut self) {
        // stderr is a closed, fixed vocabulary (at most readiness + one refusal), never an unbounded log.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl EgressFetch for NodeSourceFetch {
    fn fetch(&mut self, url: &str, max_bytes: u64) -> Result<Box<dyn Read>, Refusal> {
        let request = serde_json::to_vec(&json!({"home":self.home,"url":url,"maxBytes":max_bytes}))
            .map_err(|_| failure("E_INVALID_PARAMS", "package-invalid"))?;
        if request.len() > 16 * 1024 {
            return Err(failure("E_INVALID_PARAMS", "package-invalid"));
        }
        let mut command = Command::new(&self.node);
        command
            .arg(&self.entry)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Only platform runtime lookup variables cross the boundary; no proxy, auth, NODE_OPTIONS or caller secrets.
        for key in ["PATH", "SystemRoot", "WINDIR"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let mut child = command
            .spawn()
            .map_err(|_| failure("E_NOT_AVAILABLE", "source-unreachable"))?;
        let sent = child
            .stdin
            .take()
            .is_some_and(|mut input| input.write_all(&request).is_ok());
        let mut stderr = BufReader::new(child.stderr.take().expect("piped stderr"));
        let mut line = Vec::new();
        let read = (&mut stderr).take(4097).read_until(b'\n', &mut line);
        let ready = sent && read.is_ok() && line.len() <= 4096 && line.last() == Some(&b'\n');
        let value = ready
            .then(|| serde_json::from_slice::<Value>(&line).ok())
            .flatten()
            .unwrap_or(Value::Null);
        if value["ok"] != true {
            let _ = child.kill();
            let _ = child.wait();
            return Err(reply(&value));
        }
        let stdout = child.stdout.take().expect("piped stdout");
        Ok(Box::new(Body {
            child,
            stdout,
            _stderr: stderr,
            remaining: max_bytes,
            finished: false,
        }))
    }
}
