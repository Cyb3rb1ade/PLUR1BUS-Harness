//! Owned, demand-started stdio helper. No permission requests exist in D1.
pub use plur1bus_host::response;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[derive(Default)]
pub struct Restart(crate::events::EventStream);
impl Restart {
    pub fn failed(&mut self, sample: f64) -> Duration {
        self.0.next_delay(sample)
    }
}
pub fn environment(vars: impl IntoIterator<Item = (String, String)>) -> Vec<(String, String)> {
    vars.into_iter()
        .filter(|(name, _)| matches!(name.as_str(), "PATH" | "HOME" | "USERPROFILE" | "LANG"))
        .collect()
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Pane {
    Accessibility,
    ScreenCapture,
    Automation,
}
impl Pane {
    pub fn uri(self) -> Option<&'static str> {
        #[cfg(target_os = "macos")]
        {
            Some(match self {
                Self::Accessibility => {
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
                }
                Self::ScreenCapture => {
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
                }
                Self::Automation => {
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
                }
            })
        }
        #[cfg(target_os = "windows")]
        {
            Some(match self {
                Self::Accessibility => "ms-settings:easeofaccess",
                Self::ScreenCapture => "ms-settings:privacy-screenshotborders",
                Self::Automation => "ms-settings:privacy-broadfilesystemaccess",
            })
        }
        #[cfg(target_os = "linux")]
        {
            None
        } // No D1 grants and no cross-desktop system-permissions pane.
    }
    pub fn open(self) -> Result<(), String> {
        let uri = self.uri().ok_or("E_NOT_AVAILABLE")?;
        #[cfg(target_os = "macos")]
        let status = std::process::Command::new("/usr/bin/open")
            .arg(uri)
            .status();
        #[cfg(target_os = "windows")]
        let status = std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", uri])
            .status();
        #[cfg(target_os = "linux")]
        let status = std::process::Command::new("xdg-open").arg(uri).status();
        status
            .map_err(|_| "E_NOT_AVAILABLE".to_owned())
            .and_then(|s| {
                if s.success() {
                    Ok(())
                } else {
                    Err("E_NOT_AVAILABLE".into())
                }
            })
    }
}
#[derive(Clone, Serialize, Default)]
pub struct Status {
    pub ready: bool,
    pub attempts: u32,
    pub restarting: bool,
    pub capabilities: Vec<String>,
    pub grants: Vec<String>,
}
#[derive(Default)]
pub struct Owner {
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub status: Arc<Mutex<Status>>,
}
impl Owner {
    pub fn stop(&self) {
        if let Some(t) = self.task.lock().unwrap().take() {
            t.abort();
        }
        *self.status.lock().unwrap() = Status::default();
    }
    pub fn start(&self) {
        self.start_at(binary(), environment(std::env::vars()), rand::random::<f64>);
    }
    pub fn start_at(&self, path: PathBuf, vars: Vec<(String, String)>, jitter: fn() -> f64) {
        let mut task = self.task.lock().unwrap();
        if task.as_ref().is_some_and(|t| !t.is_finished()) {
            return;
        }
        let status = self.status.clone();
        *task = Some(tokio::spawn(async move {
            let mut retry = Restart::default();
            let mut attempts = 0u32;
            loop {
                attempts = attempts.saturating_add(1);
                status.lock().unwrap().attempts = attempts;
                let mut command = command(&path, vars.clone());
                if let Ok(mut child) = command.spawn() {
                    if let (Some(mut input), Some(stdout)) =
                        (child.stdin.take(), child.stdout.take())
                    {
                        let mut reader = BufReader::new(stdout);
                        if exchange(&mut input, &mut reader, "hello").await.is_ok()
                            && exchange(&mut input, &mut reader, "os.permissions.status")
                                .await
                                .is_ok()
                        {
                            status.lock().unwrap().ready = true;
                            status.lock().unwrap().restarting = false;
                            let _ = child.wait().await;
                        }
                    }
                    let _ = child.kill().await;
                }
                *status.lock().unwrap() = Status {
                    restarting: true,
                    attempts,
                    ..Status::default()
                };
                tokio::time::sleep(retry.failed(jitter())).await;
            }
        }));
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        self.stop();
    }
}
pub fn command(path: &Path, vars: Vec<(String, String)>) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(path);
    cmd.env_clear()
        .envs(environment(vars))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    cmd
}
pub fn binary() -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("PLUR1BUS_DESKTOP_HELPER") {
        return path.into();
    }
    std::env::current_exe()
        .ok()
        .and_then(|p| {
            p.parent().map(|p| {
                p.join(if cfg!(windows) {
                    "plur1bus-host.exe"
                } else {
                    "plur1bus-host"
                })
            })
        })
        .unwrap_or_default()
}
async fn exchange(
    input: &mut tokio::process::ChildStdin,
    reader: &mut BufReader<tokio::process::ChildStdout>,
    method: &str,
) -> Result<(), ()> {
    tokio::time::timeout(Duration::from_secs(5), async {
        input
            .write_all(format!("{{\"method\":\"{method}\"}}\n").as_bytes())
            .await
            .map_err(|_| ())?;
        let mut bytes = vec![];
        loop {
            let buffer = reader.fill_buf().await.map_err(|_| ())?;
            if buffer.is_empty() {
                return Err(());
            }
            let n = buffer
                .iter()
                .position(|b| *b == b'\n')
                .map(|n| n + 1)
                .unwrap_or(buffer.len());
            if bytes.len() + n > 65536 {
                return Err(());
            }
            bytes.extend_from_slice(&buffer[..n]);
            reader.consume(n);
            if bytes.last() == Some(&b'\n') {
                break;
            }
        }
        let v: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
        if Some(v) == response(method) {
            Ok(())
        } else {
            Err(())
        }
    })
    .await
    .map_err(|_| ())?
}
