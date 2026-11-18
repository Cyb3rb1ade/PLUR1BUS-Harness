//! `system-jobs/ledger.ts`: the run ledger of the system jobs, `state/system-jobs/ledger.jsonl` (the core's `paths.systemJobs`
//! directory), one JSON row per line, appended and synced; at 1 MiB the file is renamed to `ledger.jsonl.1` (one generation).
//! A run writes a `started` row when it begins and a `finished` row when it ends; a `started` row with no `finished` row and no
//! run in flight is read back as `abandoned` (`core_stopped`). Every row TypeScript ever wrote has `v: 1` (the first version of
//! the file, `ce1162af34`, already wrote the rows this reads; rotation and the repair of a torn last line came later and add no
//! row shape), so there is one version to read and to write.
//!
//! The file is read leniently: a line that is not JSON, a row of another version or without a run id, an unknown phase, a
//! `started` row without a job or a finite start, a `finished` row without a known outcome or finite times are each skipped
//! with one warning that never carries the line (it can carry run arguments). A last line without its newline (a torn write) is
//! finished with one before the next row is appended.
use crate::approvals::js_json::J;
use crate::jobs::JobsError;
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// `MAX_LEDGER_BYTES`: 1 MiB.
pub const MAX_LEDGER_BYTES: u64 = 1024 * 1024;

const OUTCOMES: [&str; 5] = ["completed", "skipped", "incomplete", "failed", "abandoned"];

/// `logger.warn(message, fields)`.
pub type Warn = std::rc::Rc<dyn Fn(&str, &J)>;
/// `securePath(path)`: whether the owner-only protection was applied (`applied !== false`).
pub type SecureHook = Box<dyn Fn(&Path) -> bool>;

/// `SystemRunRecord`, with the members that pass through a read untouched kept as the JSON that was read.
#[derive(Clone, Debug, PartialEq)]
pub struct SystemRunRecord {
    /// The run id.
    pub run_id: String,
    /// The job name.
    pub job: String,
    /// `trigger` as written (not checked on a read); `None` is `undefined`.
    pub trigger: Option<J>,
    /// When it began (epoch ms).
    pub started_at: f64,
    /// When it ended.
    pub finished_at: f64,
    /// How long it took.
    pub duration_ms: f64,
    /// `completed`, `skipped`, `incomplete`, `failed` or `abandoned`.
    pub outcome: String,
    /// Why, where the job said.
    pub reason: Option<J>,
    /// The holder of the registry lock a skipped run found.
    pub running_run_id: Option<J>,
    /// The arguments the run was started with.
    pub args: Option<J>,
}

impl SystemRunRecord {
    /// The record as JSON, members in the order TypeScript builds them.
    pub fn to_j(&self) -> J {
        let mut o = J::obj([
            ("runId", J::s(&self.run_id)),
            ("job", J::s(&self.job)),
            ("kind", J::s("system")),
        ]);
        if let Some(t) = &self.trigger {
            o.set("trigger", t.clone());
        }
        o.set("startedAt", J::Num(self.started_at));
        o.set("finishedAt", J::Num(self.finished_at));
        o.set("durationMs", J::Num(self.duration_ms));
        o.set("outcome", J::s(&self.outcome));
        o.set("attempt", J::Num(1.0));
        for (k, v) in [
            ("reason", &self.reason),
            ("runningRunId", &self.running_run_id),
            ("args", &self.args),
        ] {
            if let Some(v) = v {
                o.set(k, v.clone());
            }
        }
        o
    }
}

/// `StartedEntry`.
#[derive(Clone, Debug)]
pub struct StartedEntry {
    /// The run id.
    pub run_id: String,
    /// The job name.
    pub job: String,
    /// What started it.
    pub trigger: String,
    /// When (epoch ms).
    pub started_at: f64,
    /// The arguments.
    pub args: Option<J>,
}

/// The ledger.
pub struct SystemJobsLedger {
    path: PathBuf,
    secure_path: SecureHook,
    warn: Warn,
    secured: std::cell::Cell<bool>,
}

fn rotated_of(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".1");
    PathBuf::from(s)
}

fn exists(p: &Path) -> bool {
    fs::metadata(p).is_ok()
}

fn finite(v: Option<&J>) -> Option<f64> {
    match v {
        Some(J::Num(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}

fn type_of(v: Option<&J>) -> &'static str {
    match v {
        None => "undefined",
        Some(J::Str(_)) => "string",
        Some(J::Num(_)) => "number",
        Some(J::Bool(_)) => "boolean",
        Some(_) => "object",
    }
}

impl SystemJobsLedger {
    /// `new SystemJobsLedger(deps)`.
    pub fn new(path: PathBuf, secure_path: SecureHook, warn: Warn) -> Self {
        Self {
            path,
            secure_path,
            warn,
            secured: std::cell::Cell::new(false),
        }
    }

    /// `secureOnce`.
    fn secure_once(&self, p: &Path) -> Result<(), JobsError> {
        if (self.secure_path)(p) {
            Ok(())
        } else {
            Err(JobsError::Other(format!(
                "securePath failed to apply permissions to {}",
                p.display()
            )))
        }
    }

    fn append_line(&self, row: &J) -> Result<(), JobsError> {
        let io = |e: std::io::Error| JobsError::Other(e.to_string());
        if let Some(dir) = self.path.parent().filter(|d| !d.as_os_str().is_empty()) {
            if !exists(dir) {
                let mut b = fs::DirBuilder::new();
                b.recursive(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::DirBuilderExt;
                    b.mode(0o700);
                }
                b.create(dir).map_err(io)?;
                self.secure_once(dir)?;
            }
        }
        if exists(&self.path) {
            let rotate = || -> std::io::Result<()> {
                let st = fs::metadata(&self.path)?;
                if st.len() >= MAX_LEDGER_BYTES {
                    let rotated = rotated_of(&self.path);
                    if exists(&rotated) {
                        let _ = fs::remove_file(&rotated);
                    }
                    fs::rename(&self.path, &rotated)?;
                    self.secured.set(false);
                }
                Ok(())
            };
            if let Err(e) = rotate() {
                (self.warn)(
                    "failed to rotate system jobs ledger",
                    &J::obj([("error", J::Str(format!("Error: {e}")))]),
                );
            }
        }
        let file_existed = exists(&self.path);
        if !file_existed {
            open_append(&self.path).map_err(io)?;
            self.secure_once(&self.path)?;
            self.secured.set(true);
        } else if !self.secured.get() {
            self.secure_once(&self.path)?;
            self.secured.set(true);
        }
        let mut prefix = "";
        if file_existed {
            // A torn last line is finished before the next row; a read error here is ignored.
            let torn = || -> std::io::Result<bool> {
                let len = fs::metadata(&self.path)?.len();
                if len == 0 {
                    return Ok(false);
                }
                let mut f = fs::File::open(&self.path)?;
                f.seek(SeekFrom::Start(len - 1))?;
                let mut b = [0u8; 1];
                Ok(f.read(&mut b)? == 1 && b[0] != 0x0a)
            };
            if torn().unwrap_or(false) {
                prefix = "\n";
            }
        }
        let line = format!("{prefix}{}\n", row.stringify());
        let mut f = open_append(&self.path).map_err(io)?;
        f.write_all(line.as_bytes()).map_err(io)?;
        f.sync_all().map_err(io)?;
        Ok(())
    }

    /// `begin(entry)`.
    pub fn begin(&self, e: &StartedEntry) -> Result<(), JobsError> {
        let mut row = J::obj([
            ("v", J::Num(1.0)),
            ("phase", J::s("started")),
            ("runId", J::s(&e.run_id)),
            ("job", J::s(&e.job)),
            ("trigger", J::s(&e.trigger)),
            ("startedAt", J::Num(e.started_at)),
        ]);
        if let Some(a) = &e.args {
            row.set("args", a.clone());
        }
        self.append_line(&row)
    }

    /// `finish(entry)`.
    pub fn finish(&self, r: &SystemRunRecord) -> Result<(), JobsError> {
        let mut row = J::obj([
            ("v", J::Num(1.0)),
            ("phase", J::s("finished")),
            ("runId", J::s(&r.run_id)),
            ("job", J::s(&r.job)),
        ]);
        if let Some(t) = &r.trigger {
            row.set("trigger", t.clone());
        }
        row.set("startedAt", J::Num(r.started_at));
        row.set("finishedAt", J::Num(r.finished_at));
        row.set("durationMs", J::Num(r.duration_ms));
        row.set("outcome", J::s(&r.outcome));
        if let Some(v) = &r.reason {
            row.set("reason", v.clone());
        }
        if let Some(v) = &r.running_run_id {
            row.set("runningRunId", v.clone());
        }
        row.set("attempt", J::Num(1.0));
        if let Some(v) = &r.args {
            row.set("args", v.clone());
        }
        self.append_line(&row)
    }

    /// `readAll(inFlightRunIds)`: the runs in the order they first appeared (the rotated file first), the unfinished ones
    /// that are not in flight as `abandoned`.
    pub fn read_all(&self, in_flight: &HashSet<String>) -> Vec<SystemRunRecord> {
        let rotated = rotated_of(&self.path);
        let files: Vec<PathBuf> = [rotated, self.path.clone()]
            .into_iter()
            .filter(|p| exists(p))
            .collect();
        if files.is_empty() {
            return Vec::new();
        }
        let mut started: HashMap<String, Started> = HashMap::new();
        let mut records: HashMap<String, SystemRunRecord> = HashMap::new();
        let mut order: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for file in files {
            let content = match fs::read(&file) {
                // `readFileSync(path, "utf8")`: malformed UTF-8 becomes U+FFFD.
                Ok(b) => String::from_utf8_lossy(&b).into_owned(),
                Err(e) => {
                    (self.warn)(
                        "failed to read system jobs ledger",
                        &J::obj([
                            ("path", J::Str(file.display().to_string())),
                            ("error", J::Str(format!("Error: {e}"))),
                        ]),
                    );
                    continue;
                }
            };
            for raw in content.split('\n') {
                let trimmed = crate::js::js_trim(raw);
                if trimmed.is_empty() {
                    continue;
                }
                let Some(parsed) = J::parse(&trimmed) else {
                    // Never log the line itself: it can carry run arguments.
                    (self.warn)(
                        "unreadable line in system jobs ledger",
                        &J::obj([("length", J::Num(crate::js::utf16_len(&trimmed) as f64))]),
                    );
                    continue;
                };
                let version_ok = parsed.get("v").and_then(J::as_f64) == Some(1.0);
                let run_id = match parsed.get("runId") {
                    Some(J::Str(s)) if version_ok => s.clone(),
                    _ => {
                        let fields = J::obj([("runIdType", J::s(type_of(parsed.get("runId"))))]);
                        (self.warn)("corrupt entry in system jobs ledger", &fields);
                        continue;
                    }
                };
                match parsed.get("phase").and_then(J::as_str) {
                    Some("started") => {
                        let (Some(J::Str(job)), Some(at)) =
                            (parsed.get("job"), finite(parsed.get("startedAt")))
                        else {
                            (self.warn)(
                                "invalid started entry in system jobs ledger",
                                &J::obj([("runId", J::s(&run_id))]),
                            );
                            continue;
                        };
                        started.insert(
                            run_id.clone(),
                            Started {
                                job: job.clone(),
                                trigger: parsed.get("trigger").cloned(),
                                started_at: at,
                                args: parsed.get("args").cloned(),
                            },
                        );
                        if seen.insert(run_id.clone()) {
                            order.push(run_id);
                        }
                    }
                    Some("finished") => {
                        let outcome = parsed.get("outcome").and_then(J::as_str);
                        let valid = matches!(parsed.get("job"), Some(J::Str(_)))
                            && outcome.is_some_and(|o| OUTCOMES.contains(&o))
                            && finite(parsed.get("startedAt")).is_some()
                            && finite(parsed.get("finishedAt")).is_some()
                            && finite(parsed.get("durationMs")).is_some();
                        if !valid {
                            (self.warn)(
                                "invalid finished entry in system jobs ledger",
                                &J::obj([("runId", J::s(&run_id))]),
                            );
                            continue;
                        }
                        let rec = SystemRunRecord {
                            run_id: run_id.clone(),
                            job: parsed
                                .get("job")
                                .and_then(J::as_str)
                                .unwrap_or_default()
                                .to_owned(),
                            trigger: parsed.get("trigger").cloned(),
                            started_at: finite(parsed.get("startedAt")).unwrap_or_default(),
                            finished_at: finite(parsed.get("finishedAt")).unwrap_or_default(),
                            duration_ms: finite(parsed.get("durationMs")).unwrap_or_default(),
                            outcome: outcome.unwrap_or_default().to_owned(),
                            reason: parsed.get("reason").cloned(),
                            running_run_id: parsed.get("runningRunId").cloned(),
                            args: parsed.get("args").cloned(),
                        };
                        records.insert(run_id.clone(), rec);
                        if seen.insert(run_id.clone()) {
                            order.push(run_id);
                        }
                    }
                    _ => {
                        // `{ phase: parsed.phase }`: an absent phase is no member at all.
                        let fields = match parsed.get("phase") {
                            Some(v) => J::obj([("phase", v.clone())]),
                            None => J::Obj(Vec::new()),
                        };
                        (self.warn)("unknown phase in system jobs ledger", &fields);
                    }
                }
            }
        }
        // A run that started and never finished, and is not in flight in this process, was cut off.
        for (run_id, s) in started {
            if records.contains_key(&run_id) || in_flight.contains(&run_id) {
                continue;
            }
            records.insert(
                run_id.clone(),
                SystemRunRecord {
                    run_id,
                    job: s.job,
                    trigger: s.trigger,
                    started_at: s.started_at,
                    finished_at: s.started_at,
                    duration_ms: 0.0,
                    outcome: "abandoned".into(),
                    reason: Some(J::s("core_stopped")),
                    running_run_id: None,
                    args: s.args,
                },
            );
        }
        order
            .into_iter()
            .filter_map(|id| records.remove(&id))
            .collect()
    }
}

/// What a `started` row said, as written.
struct Started {
    job: String,
    trigger: Option<J>,
    started_at: f64,
    args: Option<J>,
}

fn open_append(path: &Path) -> std::io::Result<fs::File> {
    let mut o = OpenOptions::new();
    o.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(path)
}
