//! Test seam: a fake service manager for `tests/service.rs`, selected by `PLUR1BUS_SERVICE_FAKE=<dir>` and honoured
//! only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`. It appends every command to `<dir>/calls.jsonl` as
//! `{"program","args"}` and keeps just enough state in `<dir>/state.json` (registered and running names) to answer
//! `systemctl is-active`, `launchctl print|bootout` and `schtasks /Query|/Run|/End|/Delete` like the real tools.
use super::Runner;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Output;

pub struct FakeRunner {
    dir: PathBuf,
}

#[derive(Default)]
struct State {
    registered: BTreeSet<String>,
    running: BTreeSet<String>,
}

impl FakeRunner {
    pub fn new(dir: PathBuf) -> Self {
        FakeRunner { dir }
    }
    fn load(&self) -> State {
        let v: Value = std::fs::read_to_string(self.dir.join("state.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null);
        let set = |k: &str| -> BTreeSet<String> {
            v[k].as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default()
        };
        State {
            registered: set("registered"),
            running: set("running"),
        }
    }
    fn save(&self, s: &State) -> io::Result<()> {
        std::fs::write(
            self.dir.join("state.json"),
            json!({ "registered": s.registered, "running": s.running }).to_string(),
        )
    }
    fn record(&self, program: &str, args: &[String]) -> io::Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("calls.jsonl"))?;
        writeln!(f, "{}", json!({ "program": program, "args": args }))
    }
}

impl Runner for FakeRunner {
    fn run(&self, program: &str, args: &[OsString]) -> io::Result<Output> {
        let args: Vec<String> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        self.record(program, &args)?;
        let mut st = self.load();
        let a: Vec<&str> = args.iter().map(String::as_str).collect();
        let (code, stdout) = match (program, a.as_slice()) {
            ("systemctl", ["--user", "daemon-reload"]) => (0, String::new()),
            ("systemctl", ["--user", "enable", "--now", unit]) => {
                st.registered.insert(unit.to_string());
                st.running.insert(unit.to_string());
                (0, String::new())
            }
            ("systemctl", ["--user", "enable", unit]) => {
                st.registered.insert(unit.to_string());
                (0, String::new())
            }
            ("systemctl", ["--user", "restart", unit]) if st.registered.contains(*unit) => {
                st.running.insert(unit.to_string());
                (0, String::new())
            }
            ("systemctl", ["--user", "start", unit]) if st.registered.contains(*unit) => {
                st.running.insert(unit.to_string());
                (0, String::new())
            }
            ("systemctl", ["--user", "disable", "--now", unit]) => {
                st.registered.remove(*unit);
                st.running.remove(*unit);
                (0, String::new())
            }
            ("systemctl", ["--user", "is-active", unit]) => {
                if st.running.contains(*unit) {
                    (0, "active\n".into())
                } else {
                    (3, "inactive\n".into())
                }
            }
            ("launchctl", ["bootstrap", _domain, plist]) => {
                let label = Path::new(plist)
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if st.registered.contains(&label) {
                    (5, String::new())
                } else {
                    st.registered.insert(label.clone());
                    st.running.insert(label);
                    (0, String::new())
                }
            }
            ("launchctl", ["kickstart", target]) => {
                let label = target.rsplit('/').next().unwrap_or("").to_string();
                if st.registered.contains(&label) {
                    st.running.insert(label);
                    (0, String::new())
                } else {
                    (3, String::new())
                }
            }
            ("launchctl", ["bootout", target]) => {
                let label = target.rsplit('/').next().unwrap_or("").to_string();
                st.running.remove(&label);
                if st.registered.remove(&label) {
                    (0, String::new())
                } else {
                    (3, String::new())
                }
            }
            ("launchctl", ["print", target]) => {
                let label = target.rsplit('/').next().unwrap_or("");
                if st.registered.contains(label) {
                    let state = if st.running.contains(label) {
                        "running"
                    } else {
                        "not running"
                    };
                    (0, format!("{target} = {{\n\tstate = {state}\n}}\n"))
                } else {
                    (113, String::new())
                }
            }
            ("schtasks", ["/Create", "/XML", _xml, "/TN", name, "/F"]) => {
                st.registered.insert(name.to_string());
                (0, String::new())
            }
            ("schtasks", ["/Run", "/TN", name]) if st.registered.contains(*name) => {
                st.running.insert(name.to_string());
                (0, String::new())
            }
            ("schtasks", ["/End", "/TN", name]) if st.running.remove(*name) => (0, String::new()),
            ("schtasks", ["/Delete", "/TN", name, "/F"]) if st.registered.remove(*name) => {
                (0, String::new())
            }
            ("schtasks", ["/Query", "/TN", name, "/FO", "CSV"])
                if st.registered.contains(*name) =>
            {
                let status = if st.running.contains(*name) {
                    "Running"
                } else {
                    "Ready"
                };
                (
                    0,
                    format!("\"TaskName\",\"Next Run Time\",\"Status\"\r\n\"\\{name}\",\"N/A\",\"{status}\"\r\n"),
                )
            }
            ("schtasks", _) => (1, String::new()),
            _ => {
                let mut out = exit_output(2);
                out.stderr = format!("fake service manager: unexpected command {program} {args:?}")
                    .into_bytes();
                return Ok(out);
            }
        };
        self.save(&st)?;
        let mut out = exit_output(code);
        out.stdout = stdout.into_bytes();
        Ok(out)
    }
}

/// An `Output` with exit `code` and no output.
#[cfg(unix)]
pub(crate) fn exit_output(code: i32) -> Output {
    use std::os::unix::process::ExitStatusExt;
    Output {
        status: std::process::ExitStatus::from_raw(code << 8),
        stdout: Vec::new(),
        stderr: Vec::new(),
    }
}
#[cfg(windows)]
pub(crate) fn exit_output(code: i32) -> Output {
    use std::os::windows::process::ExitStatusExt;
    Output {
        status: std::process::ExitStatus::from_raw(code as u32),
        stdout: Vec::new(),
        stderr: Vec::new(),
    }
}
