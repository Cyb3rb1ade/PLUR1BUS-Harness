//! launchd agent: `~/Library/LaunchAgents/<label>.plist`, loaded into the user's GUI domain with `launchctl`.
use super::{
    exec, exec_ok, os_args, remove_file, xml_escape, Runner, ServiceError, STOP_TIMEOUT_SECS,
};
use std::ffi::OsString;
use std::path::Path;
use std::time::{Duration, Instant};

/// `gui/<uid>`: the logged-in user's domain.
pub fn gui_domain() -> String {
    #[cfg(unix)]
    let uid = unsafe { libc::getuid() };
    #[cfg(not(unix))]
    let uid = 0;
    format!("gui/{uid}")
}

/// The property list. `KeepAlive.SuccessfulExit = false` restarts the supervisor after a crash or a kill, never after
/// a clean exit (`daemon stop`); `ThrottleInterval` spaces the restarts. `ExitTimeOut` and `AbandonProcessGroup`: see
/// the module docs of `service`. `StandardErrorPath` (`<home>/logs/supervisor.stderr`) keeps what `supervise` prints
/// before its own log is open (usage and set-up failures).
pub fn render(
    bin: &str,
    home: &str,
    label: &str,
    env: &[(String, String)],
    stderr: &str,
) -> String {
    let string = |s: &str| format!("<string>{}</string>", xml_escape(s));
    let mut s = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n<dict>\n",
    );
    s.push_str(&format!("  <key>Label</key>\n  {}\n", string(label)));
    s.push_str("  <key>ProgramArguments</key>\n  <array>\n");
    for a in [bin, "--home", home, "supervise"] {
        s.push_str(&format!("    {}\n", string(a)));
    }
    s.push_str("  </array>\n");
    if !env.is_empty() {
        s.push_str("  <key>EnvironmentVariables</key>\n  <dict>\n");
        for (k, v) in env {
            s.push_str(&format!(
                "    <key>{}</key>\n    {}\n",
                xml_escape(k),
                string(v)
            ));
        }
        s.push_str("  </dict>\n");
    }
    s.push_str(&format!(
        "  <key>StandardErrorPath</key>\n  {}\n",
        string(stderr)
    ));
    s.push_str(&format!(
        "  <key>RunAtLoad</key>\n  <true/>\n\
         \x20 <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n\
         \x20 <key>ThrottleInterval</key>\n  <integer>5</integer>\n\
         \x20 <key>ExitTimeOut</key>\n  <integer>{STOP_TIMEOUT_SECS}</integer>\n\
         \x20 <key>AbandonProcessGroup</key>\n  <true/>\n\
         </dict>\n</plist>\n"
    ));
    s
}

/// How long `install` and `uninstall` wait for a booted-out job to disappear: launchd sends SIGTERM and SIGKILLs
/// after `ExitTimeOut`, so the job is gone by then.
const UNLOAD_WAIT: Duration = Duration::from_secs(STOP_TIMEOUT_SECS as u64 + 10);
const UNLOAD_POLL: Duration = Duration::from_millis(100);

/// launchctl exit codes `bootout` may return without failing: 3 (ESRCH, not loaded) and 36 (EINPROGRESS, the job
/// is still being removed).
const BOOTOUT_TOLERATED: [i32; 2] = [3, 36];

/// With `start`: `bootout` any loaded instance (so a re-install loads the new plist; not loaded is fine), wait until
/// launchd has let go of the label, then `bootstrap`, which starts the agent (`RunAtLoad`). Without `start` the plist
/// is only written and a running agent is left alone: launchd loads the new plist at the next login.
pub fn install(r: &dyn Runner, label: &str, plist: &Path, start: bool) -> Result<(), ServiceError> {
    if !start {
        return Ok(());
    }
    let domain = gui_domain();
    exec(
        r,
        "launchctl",
        &os_args(&["bootout", &format!("{domain}/{label}")]),
    )?;
    wait_unloaded(r, label, UNLOAD_WAIT, UNLOAD_POLL)?;
    let args = vec![
        OsString::from("bootstrap"),
        OsString::from(&domain),
        plist.as_os_str().to_os_string(),
    ];
    exec_ok(r, "launchctl", &args)
}

fn loaded(r: &dyn Runner, label: &str) -> Option<std::process::Output> {
    let out = exec(
        r,
        "launchctl",
        &os_args(&["print", &format!("{}/{label}", gui_domain())]),
    )
    .ok()?;
    out.status.success().then_some(out)
}

/// Polls `print` until the label is gone; [`ServiceError::StillLoaded`] after `within`.
fn wait_unloaded(
    r: &dyn Runner,
    label: &str,
    within: Duration,
    poll: Duration,
) -> Result<(), ServiceError> {
    let deadline = Instant::now() + within;
    while loaded(r, label).is_some() {
        if Instant::now() >= deadline {
            return Err(ServiceError::StillLoaded {
                name: label.to_string(),
                secs: within.as_secs(),
            });
        }
        std::thread::sleep(poll);
    }
    Ok(())
}

/// Registered means the plist exists or the label is loaded. `bootout` stops the supervisor (SIGTERM → the
/// `daemon.stop` path, waiting up to `ExitTimeOut`); it may answer EINPROGRESS while the job is still going away, so
/// the plist is removed only once `print` no longer finds the label.
pub fn uninstall(r: &dyn Runner, label: &str, plist: &Path) -> Result<bool, ServiceError> {
    uninstall_within(r, label, plist, UNLOAD_WAIT, UNLOAD_POLL)
}

fn uninstall_within(
    r: &dyn Runner,
    label: &str,
    plist: &Path,
    within: Duration,
    poll: Duration,
) -> Result<bool, ServiceError> {
    let had_file = plist.exists();
    let was_loaded = loaded(r, label).is_some();
    if !had_file && !was_loaded {
        return Ok(false);
    }
    if was_loaded {
        let args = os_args(&["bootout", &format!("{}/{label}", gui_domain())]);
        let out = exec(r, "launchctl", &args)?;
        let code = out.status.code();
        if !out.status.success() && !code.is_some_and(|c| BOOTOUT_TOLERATED.contains(&c)) {
            return Err(ServiceError::Command {
                program: "launchctl".into(),
                args: args
                    .iter()
                    .map(|a| a.to_string_lossy().into_owned())
                    .collect(),
                code,
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        wait_unloaded(r, label, within, poll)?;
    }
    remove_file(plist)?;
    Ok(true)
}

/// `print` succeeds for a loaded label and shows `state = running` while the process runs.
pub fn status(r: &dyn Runner, label: &str, plist: &Path) -> (bool, bool) {
    match loaded(r, label) {
        Some(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            (true, text.lines().any(|l| l.trim() == "state = running"))
        }
        None => (plist.exists(), false),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::plist_json;
    use super::*;

    #[test]
    fn launchd_plist_keeps_alive_only_on_failure() {
        let p = plist_json(&render(
            "/Applications/p1b/plur1bus",
            "/Users/u/.plur1bus",
            "dev.plur1bus.supervisor",
            &[],
            "/Users/u/.plur1bus/logs/supervisor.stderr",
        ));
        assert_eq!(
            p["StandardErrorPath"],
            "/Users/u/.plur1bus/logs/supervisor.stderr"
        );
        assert_eq!(p["Label"], "dev.plur1bus.supervisor");
        assert_eq!(p["KeepAlive"]["SuccessfulExit"], false);
        assert_eq!(p["RunAtLoad"], true);
        assert_eq!(p["ThrottleInterval"], 5);
        assert_eq!(p["ExitTimeOut"], STOP_TIMEOUT_SECS);
        assert_eq!(p["AbandonProcessGroup"], true);
        assert_eq!(
            p["ProgramArguments"],
            serde_json::json!([
                "/Applications/p1b/plur1bus",
                "--home",
                "/Users/u/.plur1bus",
                "supervise"
            ])
        );
        assert_eq!(p["ProgramArguments"][3], "supervise");
        assert!(p.get("EnvironmentVariables").is_none());
    }

    #[test]
    fn renders_a_home_with_spaces_and_umlauts() {
        let home = "/Users/Max Mustermann/p1b ü & <x> \"q\" 'a'";
        let stderr = format!("{home}/logs/supervisor.stderr");
        let xml = render(
            "/Applications/P1B & Co/plur1bus",
            home,
            "dev.plur1bus.supervisor-12345678",
            &[("PLUR1BUS_NODE".into(), "/opt/n ü & <n>/node".into())],
            &stderr,
        );
        assert!(
            xml.contains("p1b ü &amp; &lt;x&gt; &quot;q&quot; &apos;a&apos;"),
            "{xml}"
        );
        let p = plist_json(&xml);
        assert_eq!(p["ProgramArguments"][0], "/Applications/P1B & Co/plur1bus");
        assert_eq!(p["ProgramArguments"][2], home);
        assert_eq!(p["StandardErrorPath"], stderr.as_str());
        assert_eq!(
            p["EnvironmentVariables"]["PLUR1BUS_NODE"],
            "/opt/n ü & <n>/node"
        );
    }

    /// Answers `print` with exit 0 for the first `loaded_prints` calls and 113 afterwards; `bootout` with `bootout`.
    struct Unloading {
        loaded_prints: std::cell::Cell<u32>,
        bootout: i32,
        calls: std::cell::RefCell<Vec<String>>,
    }
    impl Runner for Unloading {
        fn run(&self, _: &str, args: &[OsString]) -> std::io::Result<std::process::Output> {
            let verb = args[0].to_string_lossy().into_owned();
            self.calls.borrow_mut().push(verb.clone());
            let code = match verb.as_str() {
                "print" if self.loaded_prints.get() > 0 => {
                    self.loaded_prints.set(self.loaded_prints.get() - 1);
                    0
                }
                "print" => 113,
                "bootout" => self.bootout,
                _ => 0,
            };
            Ok(super::super::testing::output(code))
        }
    }

    fn unloading(loaded_prints: u32, bootout: i32) -> Unloading {
        Unloading {
            loaded_prints: std::cell::Cell::new(loaded_prints),
            bootout,
            calls: Default::default(),
        }
    }

    #[test]
    fn uninstall_waits_out_bootout_in_progress() {
        let tmp = tempfile::tempdir().unwrap();
        let plist = tmp.path().join("l.plist");
        std::fs::write(&plist, "x").unwrap();
        // Loaded at the first print, bootout answers EINPROGRESS (36), still loaded for two more polls.
        let r = unloading(3, 36);
        let ms = Duration::from_millis(1);
        assert!(uninstall_within(&r, "l", &plist, Duration::from_secs(5), ms).unwrap());
        assert!(!plist.exists());
        assert_eq!(
            *r.calls.borrow(),
            ["print", "bootout", "print", "print", "print"]
        );

        // Never goes away: bounded, and the plist stays so a retry can find it.
        std::fs::write(&plist, "x").unwrap();
        let r = unloading(u32::MAX, 36);
        let err = uninstall_within(&r, "l", &plist, Duration::from_millis(20), ms).unwrap_err();
        assert!(matches!(err, ServiceError::StillLoaded { .. }), "{err}");
        assert!(plist.exists());

        // Any other bootout failure is an error.
        let r = unloading(1, 5);
        let err = uninstall_within(&r, "l", &plist, Duration::from_secs(5), ms).unwrap_err();
        assert!(
            matches!(err, ServiceError::Command { code: Some(5), .. }),
            "{err}"
        );
    }
}
