//! systemd user unit: `<unit dir>/<name>.service`, managed with `systemctl --user`.
use super::{exec, exec_ok, os_args, remove_file, Runner, ServiceError, STOP_TIMEOUT_SECS};
use std::path::{Path, PathBuf};

/// `$XDG_CONFIG_HOME/systemd/user` when set (and absolute), else `~/.config/systemd/user` — the first user unit
/// directory systemd searches.
pub fn unit_dir() -> PathBuf {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| super::user_home().join(".config"));
    config.join("systemd").join("user")
}

/// The unit. `Restart=on-failure` restarts a crashed or killed supervisor after `RestartSec=1`; a clean exit
/// (`daemon stop`) is not restarted. `RestartPreventExitStatus=2 3` keeps a usage error (2) and "another supervisor
/// owns this home" (3) from looping. `KillMode=process` and `TimeoutStopSec`: see the module docs of `service`.
pub fn render(bin: &Path, home: &Path, env: &[(String, String)]) -> String {
    let mut s = String::from("[Unit]\nDescription=PLUR1BUS supervisor\n\n[Service]\nType=simple\n");
    s.push_str(&format!(
        "ExecStart={} --home {} supervise\n",
        quote_exec(&bin.to_string_lossy()),
        quote_exec(&home.to_string_lossy())
    ));
    for (k, v) in env {
        s.push_str(&format!("Environment={}\n", quote_env(&format!("{k}={v}"))));
    }
    s.push_str(&format!(
        "Restart=on-failure\nRestartSec=1\nRestartPreventExitStatus=2 3\nKillMode=process\nTimeoutStopSec={STOP_TIMEOUT_SECS}\n\n\
         [Install]\nWantedBy=default.target\n"
    ));
    s
}

/// A double-quoted `ExecStart=` word: C-style escapes for `\` and `"`, `%%` for a literal `%` (specifiers) and `$$`
/// for a literal `$` (variable expansion); control characters as `\xNN`. Non-ASCII passes through as UTF-8.
fn quote_exec(s: &str) -> String {
    quote(s, true)
}

/// A double-quoted `Environment=` assignment: as [`quote_exec`], but `$` is literal there.
fn quote_env(s: &str) -> String {
    quote(s, false)
}

fn quote(s: &str, exec: bool) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '%' => out.push_str("%%"),
            '$' if exec => out.push_str("$$"),
            c if (c as u32) < 0x20 || c == '\u{7f}' => {
                out.push_str(&format!("\\x{:02x}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn unit_name(name: &str) -> String {
    format!("{name}.service")
}

pub fn install(r: &dyn Runner, name: &str, start: bool) -> Result<(), ServiceError> {
    exec_ok(r, "systemctl", &os_args(&["--user", "daemon-reload"]))?;
    let unit = unit_name(name);
    if start {
        exec_ok(
            r,
            "systemctl",
            &os_args(&["--user", "enable", "--now", &unit]),
        )
    } else {
        exec_ok(r, "systemctl", &os_args(&["--user", "enable", &unit]))
    }
}

/// Registered means the unit file exists. `disable --now` stops the supervisor (SIGTERM → the `daemon.stop` path).
pub fn uninstall(r: &dyn Runner, name: &str, path: &Path) -> Result<bool, ServiceError> {
    if !path.exists() {
        return Ok(false);
    }
    exec_ok(
        r,
        "systemctl",
        &os_args(&["--user", "disable", "--now", &unit_name(name)]),
    )?;
    remove_file(path)?;
    exec_ok(r, "systemctl", &os_args(&["--user", "daemon-reload"]))?;
    Ok(true)
}

pub fn status(r: &dyn Runner, name: &str, path: &Path) -> (bool, bool) {
    let registered = path.exists();
    let running = registered
        && exec(
            r,
            "systemctl",
            &os_args(&["--user", "is-active", &unit_name(name)]),
        )
        .map(|o| o.status.success())
        .unwrap_or(false);
    (registered, running)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn systemd_unit_runs_supervise_with_restart_on_failure() {
        let u = render(
            Path::new("/opt/p1b/bin/plur1bus"),
            Path::new("/home/u/.plur1bus"),
            &[],
        );
        assert!(
            u.contains(
                "\nExecStart=\"/opt/p1b/bin/plur1bus\" --home \"/home/u/.plur1bus\" supervise\n"
            ),
            "{u}"
        );
        for line in [
            "Restart=on-failure",
            "RestartSec=1",
            "WantedBy=default.target",
            "KillMode=process",
            "TimeoutStopSec=150",
            "RestartPreventExitStatus=2 3",
        ] {
            assert!(u.lines().any(|l| l == line), "{line} missing in {u}");
        }
        assert!(!u.contains("Environment="));
        // The stop timeout outlasts the largest daemon.stop budget (120 s) plus the 5 s hard-stop grace.
        const { assert!(STOP_TIMEOUT_SECS > 125) };
    }

    #[test]
    fn renders_a_home_with_spaces_and_umlauts() {
        let u = render(
            Path::new("/opt/p1b 2/plur1bus"),
            Path::new("/tmp/p1b sys ü \"q\" 100% $HOME\\x"),
            &[("PLUR1BUS_NODE".into(), "/opt/n ü/node $x 5%".into())],
        );
        assert!(
            u.contains(
                "ExecStart=\"/opt/p1b 2/plur1bus\" --home \"/tmp/p1b sys ü \\\"q\\\" 100%% $$HOME\\\\x\" supervise\n"
            ),
            "{u}"
        );
        assert!(
            u.contains("Environment=\"PLUR1BUS_NODE=/opt/n ü/node $x 5%%\"\n"),
            "{u}"
        );
        assert_eq!(quote_exec("a\nb"), "\"a\\x0ab\"");
    }
}
