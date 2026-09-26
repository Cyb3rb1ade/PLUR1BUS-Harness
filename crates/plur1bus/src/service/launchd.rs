//! launchd agent: `~/Library/LaunchAgents/<label>.plist`, loaded into the user's GUI domain with `launchctl`.
use super::{
    exec, exec_ok, os_args, remove_file, xml_escape, Runner, ServiceError, STOP_TIMEOUT_SECS,
};
use std::ffi::OsString;
use std::path::Path;

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
/// the module docs of `service`.
pub fn render(bin: &Path, home: &Path, label: &str, env: &[(String, String)]) -> String {
    let string = |s: &str| format!("<string>{}</string>", xml_escape(s));
    let mut s = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n<dict>\n",
    );
    s.push_str(&format!("  <key>Label</key>\n  {}\n", string(label)));
    s.push_str("  <key>ProgramArguments</key>\n  <array>\n");
    for a in [
        bin.to_string_lossy().as_ref(),
        "--home",
        home.to_string_lossy().as_ref(),
        "supervise",
    ] {
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
        "  <key>RunAtLoad</key>\n  <true/>\n\
         \x20 <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n\
         \x20 <key>ThrottleInterval</key>\n  <integer>5</integer>\n\
         \x20 <key>ExitTimeOut</key>\n  <integer>{STOP_TIMEOUT_SECS}</integer>\n\
         \x20 <key>AbandonProcessGroup</key>\n  <true/>\n\
         </dict>\n</plist>\n"
    ));
    s
}

/// `bootout` first, so a re-install loads the new plist (it fails when nothing is loaded; that is fine), then
/// `bootstrap`, which starts the agent (`RunAtLoad`). Without `start` the plist is only written: launchd loads it at
/// the next login.
pub fn install(r: &dyn Runner, label: &str, plist: &Path, start: bool) -> Result<(), ServiceError> {
    let domain = gui_domain();
    exec(
        r,
        "launchctl",
        &os_args(&["bootout", &format!("{domain}/{label}")]),
    )?;
    if start {
        let args = vec![
            OsString::from("bootstrap"),
            OsString::from(&domain),
            plist.as_os_str().to_os_string(),
        ];
        exec_ok(r, "launchctl", &args)?;
    }
    Ok(())
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

/// Registered means the plist exists or the label is loaded. `bootout` stops the supervisor (SIGTERM → the
/// `daemon.stop` path, waiting up to `ExitTimeOut`).
pub fn uninstall(r: &dyn Runner, label: &str, plist: &Path) -> Result<bool, ServiceError> {
    let had_file = plist.exists();
    let was_loaded = loaded(r, label).is_some();
    if !had_file && !was_loaded {
        return Ok(false);
    }
    if was_loaded {
        exec_ok(
            r,
            "launchctl",
            &os_args(&["bootout", &format!("{}/{label}", gui_domain())]),
        )?;
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
            Path::new("/Applications/p1b/plur1bus"),
            Path::new("/Users/u/.plur1bus"),
            "dev.plur1bus.supervisor",
            &[],
        ));
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
        let xml = render(
            Path::new("/Applications/P1B & Co/plur1bus"),
            Path::new(home),
            "dev.plur1bus.supervisor-12345678",
            &[("PLUR1BUS_NODE".into(), "/opt/n ü & <n>/node".into())],
        );
        assert!(
            xml.contains("p1b ü &amp; &lt;x&gt; &quot;q&quot; &apos;a&apos;"),
            "{xml}"
        );
        let p = plist_json(&xml);
        assert_eq!(p["ProgramArguments"][0], "/Applications/P1B & Co/plur1bus");
        assert_eq!(p["ProgramArguments"][2], home);
        assert_eq!(
            p["EnvironmentVariables"]["PLUR1BUS_NODE"],
            "/opt/n ü & <n>/node"
        );
    }
}
