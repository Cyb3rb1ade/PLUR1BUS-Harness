//! Fixed import.js child with bounded private controls, queued stdin and owned process-tree teardown.
use super::{
    import_controls::Host,
    imports::{self, Job},
    relock, Shared,
};
use crate::ext::ExtError;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

#[path = "import_worker_proof.rs"]
mod proof;

const MAX_LINE: usize = 64 * 1024;
const MAX_RESPONSE: usize = 4 * 1024 * 1024 + 4096;
pub const APPLY_DEADLINE: Duration = Duration::from_secs(60 * 60);
const RECOVER_DEADLINE: Duration = Duration::from_secs(10 * 60);

fn failed() -> ExtError {
    ExtError::new(
        "E_INTERNAL",
        "worker-failed",
        "import worker did not complete safely",
    )
}

fn keys(value: &Value, allowed: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|map| map.keys().all(|key| allowed.contains(&key.as_str())))
}

struct Input {
    sender: Option<mpsc::SyncSender<Zeroizing<Vec<u8>>>>,
}
impl Input {
    fn bytes(&self, bytes: Zeroizing<Vec<u8>>) -> Result<(), ExtError> {
        if bytes.len() > MAX_RESPONSE {
            return Err(failed());
        }
        self.sender
            .as_ref()
            .ok_or_else(failed)?
            .try_send(bytes)
            .map_err(|_| failed())
    }
    fn json(&self, value: &Value) -> Result<(), ExtError> {
        let mut bytes = Zeroizing::new(serde_json::to_vec(value).map_err(|_| failed())?);
        bytes.push(b'\n');
        self.bytes(bytes)
    }
    fn close(&mut self) {
        self.sender.take();
    }
}

fn input_pipe(mut pipe: std::process::ChildStdin) -> Input {
    let (sender, receiver) = mpsc::sync_channel::<Zeroizing<Vec<u8>>>(4);
    std::thread::spawn(move || {
        for bytes in receiver {
            if pipe.write_all(&bytes).and_then(|_| pipe.flush()).is_err() {
                return;
            }
        }
    });
    Input {
        sender: Some(sender),
    }
}

fn output_pipe(pipe: std::process::ChildStdout) -> mpsc::Receiver<Result<Value, ()>> {
    let (sender, receiver) = mpsc::sync_channel(16);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(pipe);
        loop {
            let mut line = Vec::new();
            let read = reader
                .by_ref()
                .take((MAX_LINE + 1) as u64)
                .read_until(b'\n', &mut line);
            match read {
                Ok(0) => return,
                Ok(_) if line.len() <= MAX_LINE && line.last() == Some(&b'\n') => {
                    let value = serde_json::from_slice(&line).map_err(|_| ());
                    if sender.send(value).is_err() {
                        return;
                    }
                }
                _ => {
                    let _ = sender.send(Err(()));
                    return;
                }
            }
        }
    });
    receiver
}

fn initial(job: &Job, layout: &Layout) -> Value {
    let mut value = json!({"v":1,"runId":job.run_id,"mode":job.mode,"home":layout.home,
        "plan":{"id":job.plan_id,"sha256":job.plan_sha256},"ownerId":job.owner_id,"attempt":job.attempt});
    if let Some(id) = &job.preflight_id {
        value["preflightId"] = json!(id);
    }
    if let Some(hash) = &job.target_sha256 {
        value["targetSha256"] = json!(hash);
    }
    if job.automatic_rollback {
        value["automaticRollback"] = json!(true);
    }
    value
}

fn result(value: &Value) -> Result<Value, ExtError> {
    if !keys(
        value,
        &[
            "v",
            "type",
            "runId",
            "ok",
            "status",
            "restored",
            "resumable",
            "report",
            "error",
        ],
    ) || !value["ok"].is_boolean()
        || !value["restored"].is_boolean()
        || !value["resumable"].is_boolean()
        || !matches!(
            value["status"].as_str(),
            Some("completed" | "aborted" | "failed")
        )
    {
        return Err(failed());
    }
    let mut result = json!({"ok":value["ok"],"status":value["status"],"restored":value["restored"],"resumable":value["resumable"]});
    if let Some(report) = value.get("report") {
        if !keys(report, &["schema", "sha256", "bytes"])
            || report["schema"]
                .as_str()
                .is_none_or(|text| text.is_empty() || text.len() > 256)
            || report["sha256"]
                .as_str()
                .is_none_or(|hash| !super::import_records::hash(hash))
            || report["bytes"]
                .as_u64()
                .is_none_or(|bytes| bytes > 256 * 1024 * 1024)
        {
            return Err(failed());
        }
        result["report"] = report.clone();
    }
    if let Some(error) = value.get("error") {
        if !keys(error, &["code", "reason"]) {
            return Err(failed());
        }
        let reason = error["reason"]
            .as_str()
            .filter(|reason| {
                [
                    "apply-failed",
                    "aborted",
                    "restore-failed",
                    "source-changed",
                    "target-changed",
                    "busy",
                    "worker-control-unavailable",
                    "worker-failed",
                    "already-completed",
                    "import-record-unavailable",
                ]
                .contains(reason)
            })
            .unwrap_or("worker-failed");
        let code = if reason == "target-changed" {
            "E_CONFLICT"
        } else {
            "E_IMPORT_FAILED"
        };
        result["error"] = json!({"code":code,"reason":reason});
    }
    Ok(result)
}

fn control(
    shared: &Arc<Shared>,
    layout: &Layout,
    job: &Job,
    value: Value,
    input: &Input,
    seen: &mut BTreeSet<u64>,
    deadline: Instant,
) -> Result<Option<Value>, ExtError> {
    if value["v"] != 1 || value["runId"] != job.run_id {
        return Err(failed());
    }
    match value["type"].as_str() {
        Some("progress") => {
            imports::progress(shared, layout, job, &value)?;
            Ok(None)
        }
        Some("result") => result(&value).map(Some),
        Some("request") => {
            if !keys(&value, &["v", "type", "runId", "id", "method", "params"]) {
                return Err(failed());
            }
            let id = value["id"]
                .as_u64()
                .filter(|id| *id > 0 && *id < 100_001)
                .ok_or_else(failed)?;
            if !seen.insert(id) {
                return Err(failed());
            }
            let method = value["method"].as_str().ok_or_else(failed)?;
            let response = match (Host {
                shared,
                layout,
                job,
                deadline: Some(deadline),
            })
            .request(method, &value["params"])
            {
                Ok(value) => {
                    json!({"v":1,"type":"response","runId":job.run_id,"id":id,"ok":true,"result":value})
                }
                Err(error) => json!({"v":1,"type":"response","runId":job.run_id,"id":id,"ok":false,
                    "error":{"code":error.code,"reason":error.reason.unwrap_or("worker-control-unavailable")}}),
            };
            input.json(&response)?;
            Ok(None)
        }
        _ => Err(failed()),
    }
}

pub fn run(
    shared: &Arc<Shared>,
    layout: &Layout,
    job: &Job,
    secrets: Option<Zeroizing<Vec<u8>>>,
) -> Result<Value, ExtError> {
    run_bounded(
        shared,
        layout,
        job,
        secrets,
        Instant::now()
            + if job.mode == "recover" {
                RECOVER_DEADLINE
            } else {
                APPLY_DEADLINE
            },
    )
}

/// Runs inside the caller's total maintenance deadline, including the time already spent holding runtimes.
pub fn run_bounded(
    shared: &Arc<Shared>,
    layout: &Layout,
    job: &Job,
    secrets: Option<Zeroizing<Vec<u8>>>,
    deadline: Instant,
) -> Result<Value, ExtError> {
    let node = super::spawn_secrets::executable(&crate::commands::core::locate_node(layout))
        .ok_or_else(failed)?;
    let entry = crate::commands::import::locate_import_js(layout);
    execute(shared, layout, job, secrets, (&node, &entry), deadline)
}

/// A refused or crashed attempt is harmless only while its independently verified journal proves no admitted mutations.
pub fn safe_refusal(layout: &Layout, job: &Job, result: Option<&Value>) -> bool {
    proof::safe_refusal(layout, job, result)
}

fn execute(
    shared: &Arc<Shared>,
    layout: &Layout,
    job: &Job,
    secrets: Option<Zeroizing<Vec<u8>>>,
    program: (&std::path::Path, &std::path::Path),
    deadline: Instant,
) -> Result<Value, ExtError> {
    if Instant::now() >= deadline {
        return Err(failed());
    }
    let (node, entry) = program;
    if !entry.is_file() {
        return Err(failed());
    }
    let mut command = Command::new(node);
    command
        .arg(entry)
        .arg("--supervised")
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in [
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "HOME",
        "LOCALAPPDATA",
        "APPDATA",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
        "PLUR1BUS_MODELS_CACHE",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command.env("LANG", "C.UTF-8");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0).env("PATH", "/usr/bin:/bin");
    }
    if std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() == Ok("1") {
        command.env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1");
        if let Some(value) = std::env::var_os("PLUR1BUS_SECRETS_KEYRING") {
            command.env("PLUR1BUS_SECRETS_KEYRING", value);
        }
        if std::env::var("PLUR1BUS_TEST_IMPORT_FAIL_AFTER_ENTITY").as_deref() == Ok("1") {
            command.env("PLUR1BUS_TEST_IMPORT_FAIL_AFTER_ENTITY", "1");
        }
        if std::env::var("PLUR1BUS_TEST_INTERNALS").as_deref() == Ok("flat-embedder") {
            command.env("PLUR1BUS_TEST_INTERNALS", "flat-embedder");
        }
    }
    let mut child = command.spawn().map_err(|_| failed())?;
    let tree = match crate::ext::worker::ProcessTree::attach(&child) {
        Ok(tree) => tree,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(failed());
        }
    };
    let mut input = input_pipe(child.stdin.take().ok_or_else(failed)?);
    let output = output_pipe(child.stdout.take().ok_or_else(failed)?);
    if let Some(mut stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        });
    }
    let operation = (|| {
        input.json(&initial(job, layout))?;
        if let Some(frame) = secrets {
            input.bytes(frame)?;
        }
        let mut abort_at = None;
        let mut seen = BTreeSet::new();
        let mut answer = None;
        loop {
            let stop_deadline = stopping_deadline(shared);
            let abort_requested = relock(&shared.maintenance).abort_requested;
            if answer.is_none()
                && job.mode == "apply"
                && abort_at.is_none()
                && (abort_requested || stop_deadline.is_some())
            {
                input.json(&json!({"v":1,"type":"abort","runId":job.run_id}))?;
                abort_at = Some(Instant::now() + Duration::from_secs(30));
            }
            if Instant::now() >= deadline
                || abort_at.is_some_and(|at| Instant::now() >= at)
                || stop_deadline.is_some_and(|at| Instant::now() >= at)
            {
                return Err(failed());
            }
            if let Some(status) = child.try_wait().map_err(|_| failed())? {
                // Drain final protocol lines already read when the process exited.
                let finish_by = Instant::now() + Duration::from_secs(1);
                loop {
                    let drain_deadline = deadline
                        .min(stopping_deadline(shared).unwrap_or(deadline))
                        .min(abort_at.unwrap_or(deadline))
                        .min(finish_by);
                    let left = drain_deadline
                        .checked_duration_since(Instant::now())
                        .filter(|left| !left.is_zero())
                        .ok_or_else(failed)?;
                    match output.recv_timeout(left.min(Duration::from_millis(50))) {
                        Ok(value) => {
                            if answer.is_some() {
                                return Err(failed());
                            }
                            if let Some(result) = control(
                                shared,
                                layout,
                                job,
                                value.map_err(|_| failed())?,
                                &input,
                                &mut seen,
                                deadline,
                            )? {
                                answer = Some(result);
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    }
                }
                let answer = answer.ok_or_else(failed)?;
                if status.success() != (answer["ok"] == true) {
                    return Err(failed());
                }
                proof::verify(layout, job, &answer)?;
                return Ok(answer);
            }
            match output.recv_timeout(Duration::from_millis(50)) {
                Ok(value) => {
                    if answer.is_some() {
                        return Err(failed());
                    }
                    if let Some(result) = control(
                        shared,
                        layout,
                        job,
                        value.map_err(|_| failed())?,
                        &input,
                        &mut seen,
                        deadline,
                    )? {
                        answer = Some(result);
                        input.close();
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
    })();
    input.close();
    tree.kill();
    let _ = child.wait();
    operation
}

fn stopping_deadline(shared: &Shared) -> Option<Instant> {
    let state = shared.lock();
    state
        .stopping
        .map(|stop| stop.requested_at + stop.budget + super::child::stop_grace(state.time_scale))
}

#[cfg(test)]
#[path = "import_worker_tests.rs"]
mod tests;
