//! Linux: polkit. `pkcheck --action-id org.plur1bus.approve --process <pid> --allow-user-interaction` asks the session's polkit
//! authentication agent for the user's own password (policy: `auth_self`, never cached: `org.plur1bus.approve.policy`). Without a
//! graphical session or an agent there is nobody to ask, so the platform is "unavailable" and the approval stays at its T1 limits.
use crate::mapping::pkcheck_exit;
use crate::platform::Platform;
use crate::protocol::{Outcome, Probe};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const ACTION_ID: &str = "org.plur1bus.approve";
const METHOD: &str = "polkit";

pub struct Linux {
    /// `pkcheck`, found on a fixed set of system directories (not on `$PATH`, which an agent could shape).
    pkcheck: Option<PathBuf>,
    graphical: bool,
}

const PKCHECK_DIRS: [&str; 4] = ["/usr/bin", "/bin", "/usr/sbin", "/usr/local/bin"];

pub fn find_pkcheck(dirs: &[&str]) -> Option<PathBuf> {
    dirs.iter()
        .map(|d| Path::new(d).join("pkcheck"))
        .find(|p| p.is_file())
}

/// A session a polkit agent can run in: a display server is announced. (A bare TTY has `pkttyagent`, but the core runs us
/// without a terminal, so that cannot answer.)
pub fn graphical_session(get: impl Fn(&str) -> Option<String>) -> bool {
    ["WAYLAND_DISPLAY", "DISPLAY"]
        .iter()
        .any(|k| get(k).is_some_and(|v| !v.is_empty()))
}

pub fn pkcheck_args(pid: u32, text: &str) -> Vec<String> {
    vec![
        "--action-id".into(),
        ACTION_ID.into(),
        "--process".into(),
        pid.to_string(),
        "--allow-user-interaction".into(),
        "--detail".into(),
        "text".into(),
        text.to_string(),
    ]
}

impl Linux {
    pub fn from_env() -> Self {
        Linux {
            pkcheck: find_pkcheck(&PKCHECK_DIRS),
            graphical: graphical_session(|k| std::env::var(k).ok()),
        }
    }
}

impl Platform for Linux {
    fn probe(&self) -> Probe {
        if self.pkcheck.is_none() {
            return Probe::Unavailable {
                reason: "no-polkit".into(),
            };
        }
        if !self.graphical {
            return Probe::Unavailable {
                reason: "no-graphical-session".into(),
            };
        }
        Probe::Available {
            method: METHOD.into(),
        }
    }

    fn confirm(&self, text: &str, ttl: Duration) -> Outcome {
        let Some(bin) = &self.pkcheck else {
            return Outcome::Unavailable;
        };
        let mut child = match Command::new(bin)
            .args(pkcheck_args(std::process::id(), text))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(_) => return Outcome::Unavailable,
        };
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return pkcheck_exit(status.code(), METHOD),
                Ok(None) if start.elapsed() >= ttl => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Outcome::TimedOut;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => return Outcome::Failed,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkcheck_is_asked_about_our_action_for_our_process_with_interaction_allowed() {
        let a = pkcheck_args(4242, "Allow agent bernd");
        assert_eq!(
            a,
            [
                "--action-id",
                "org.plur1bus.approve",
                "--process",
                "4242",
                "--allow-user-interaction",
                "--detail",
                "text",
                "Allow agent bernd"
            ]
        );
    }

    #[test]
    fn a_graphical_session_needs_a_display_server() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| v.to_string())
            }
        };
        assert!(graphical_session(env(&[("WAYLAND_DISPLAY", "wayland-0")])));
        assert!(graphical_session(env(&[("DISPLAY", ":0")])));
        assert!(!graphical_session(env(&[("DISPLAY", "")])));
        assert!(!graphical_session(env(&[])));
    }

    #[test]
    fn without_polkit_or_a_display_the_platform_is_unavailable_and_says_why() {
        assert_eq!(
            Linux {
                pkcheck: None,
                graphical: true
            }
            .probe(),
            Probe::Unavailable {
                reason: "no-polkit".into()
            }
        );
        assert_eq!(
            Linux {
                pkcheck: Some("/usr/bin/pkcheck".into()),
                graphical: false
            }
            .probe(),
            Probe::Unavailable {
                reason: "no-graphical-session".into()
            }
        );
        assert_eq!(
            Linux {
                pkcheck: Some("/usr/bin/pkcheck".into()),
                graphical: true
            }
            .probe(),
            Probe::Available {
                method: "polkit".into()
            }
        );
        assert_eq!(
            Linux {
                pkcheck: None,
                graphical: true
            }
            .confirm("x", Duration::from_secs(1)),
            Outcome::Unavailable
        );
    }

    #[test]
    fn pkcheck_is_looked_up_in_system_directories_only() {
        assert_eq!(find_pkcheck(&["/definitely/not/here"]), None);
    }

    /// A stand-in `pkcheck` (a shell script) proves the exit status reaches the mapping and that a hanging check is killed at the deadline.
    #[cfg(unix)]
    #[test]
    fn exit_statuses_and_the_deadline_come_through() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("p1b-attest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = |name: &str, body: &str| {
            let d = dir.join(name);
            std::fs::create_dir_all(&d).unwrap();
            let p = d.join("pkcheck");
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p
        };
        let run = |p: PathBuf, ttl_ms: u64| {
            Linux {
                pkcheck: Some(p),
                graphical: true,
            }
            .confirm("x", Duration::from_millis(ttl_ms))
        };
        assert_eq!(
            run(script("ok", "exit 0"), 5000),
            Outcome::Confirmed {
                method: "polkit".into()
            }
        );
        assert_eq!(run(script("dismissed", "exit 2"), 5000), Outcome::Cancelled);
        assert_eq!(run(script("noagent", "exit 3"), 5000), Outcome::Unavailable);
        assert_eq!(run(script("denied", "exit 1"), 5000), Outcome::Failed);
        let t0 = Instant::now();
        assert_eq!(run(script("hang", "exec sleep 30"), 300), Outcome::TimedOut);
        assert!(t0.elapsed() < Duration::from_secs(5));
        let _ = std::fs::remove_dir_all(dir);
    }
}
