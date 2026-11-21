use super::catalog::Operation;
use super::{Config, Failure};
use crate::gate::Caller;
use serde_json::{Map, Value};
use std::sync::LazyLock;

/// Trusted identities supplied by the native process port.
#[derive(Clone, Copy, Debug, Default)]
pub struct ProcessIdentity {
    /// Process running Hostctl.
    pub pid: u32,
    /// Supervisor or parent.
    pub parent: u32,
    /// Harness process group, where supported.
    pub group: Option<u32>,
}

pub(super) fn validate_runtime(
    op: Operation,
    input: &Map<String, Value>,
    config: &Config,
    caller: &Caller,
    process: ProcessIdentity,
) -> Result<(), Failure> {
    use Operation as O;
    if matches!(
        op,
        O::Exec | O::Start | O::Shell | O::ProcessList | O::ReadOutput | O::WriteStdin | O::Kill
    ) && caller.session_id.as_deref().is_none_or(str::is_empty)
    {
        return Err(Failure::denied(
            "A harness session is required for process ownership.",
        ));
    }
    match op {
        O::Shell => {
            if !config.shell_allowed {
                return Err(Failure::denied("Shell execution is disabled."));
            }
            let command = input["command"]
                .as_str()
                .ok_or_else(|| Failure::invalid("Expected a command."))?;
            let program = command
                .split_ascii_whitespace()
                .next()
                .filter(|word| !word.starts_with('-'))
                .ok_or_else(|| Failure::denied("Use one literal command."))?;
            if !command
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b" ._/-\t".contains(&byte))
            {
                return Err(Failure::denied(
                    "The verified shell subset supports one literal command.",
                ));
            }
            validate_command(config, program, command)?;
        }
        O::Exec | O::Start => {
            let program = input["program"]
                .as_str()
                .ok_or_else(|| Failure::invalid("Expected a program."))?;
            let mut command = String::from(program);
            if let Some(args) = input.get("args").and_then(Value::as_array) {
                for arg in args.iter().filter_map(Value::as_str) {
                    command.push(' ');
                    command.push_str(arg);
                }
            }
            validate_command(config, program, &command)?;
        }
        O::KillForeign => {
            let pid = input["pid"]
                .as_f64()
                .ok_or_else(|| Failure::invalid("Expected a process ID."))?
                as u32;
            if process.pid == 0
                || process.parent == 0
                || pid == process.pid
                || pid == process.parent
                || Some(pid) == process.group
            {
                return Err(Failure::denied(
                    "Use a PID outside the harness process group.",
                ));
            }
        }
        _ => (),
    }
    let text = match op {
        O::Write | O::Append => input.get("content"),
        O::Edit => input.get("newText"),
        O::WriteStdin | O::ClipboardWrite => input.get("text"),
        _ => None,
    };
    if text
        .and_then(Value::as_str)
        .is_some_and(|s| s.len() > config.output_bytes as usize)
    {
        return Err(Failure::too_large("The operation exceeds its byte limit."));
    }
    Ok(())
}

fn matches_hard_argument_rule(command: &str) -> bool {
    // ECMAScript \s and ASCII word boundaries/word characters used by Hostctl's command check.
    const SPACE: &str = r"\x09-\x0d\x20\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";
    static RULES: LazyLock<Option<regex::Regex>> = LazyLock::new(|| {
        regex::Regex::new(&format!(
            r#"(?i)(?:^|[{SPACE}/\\])(?-u:format(?:\.com)?|diskpart(?:\.exe)?|mkfs(?:\.\w+)?|sudo(?:\.exe)?|doas|pkexec|su|runas(?:\.exe)?|gsudo|expect|sshpass)(?:[{SPACE}]|$)|(?-u:\brm)[{SPACE}]+[^\n]*-(?-u:[a-z]*r[a-z]*f[a-z]*)[{SPACE}]+["']?/(?:["']?(?:[{SPACE}]|$))|(?-u:\breg(?:\.exe)?)[{SPACE}]+(?-u:(?:delete|load|restore)\b)|(?-u:HKEY_LOCAL_MACHINE|\\Device\\|\\\\\.\\)"#
        ))
        .ok()
    });
    RULES.as_ref().is_none_or(|rules| rules.is_match(command))
}

fn validate_command(config: &Config, program: &str, command: &str) -> Result<(), Failure> {
    if matches_hard_argument_rule(command) {
        return Err(Failure::denied(
            "Dangerous command refused; use a bounded file operation instead.",
        ));
    }
    let command = command.to_lowercase();
    if config
        .deny_patterns
        .iter()
        .any(|pattern| command.contains(&pattern.to_lowercase()))
    {
        return Err(Failure::denied(
            "The command matches a configured deny pattern.",
        ));
    }
    let name = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    // The wrapper's eventual target must be represented by its own explicit approval.
    if matches!(
        name,
        "bash"
            | "zsh"
            | "sh"
            | "dash"
            | "fish"
            | "pwsh"
            | "powershell"
            | "cmd"
            | "ash"
            | "ksh"
            | "mksh"
            | "csh"
            | "tcsh"
            | "hush"
            | "wsl"
            | "env"
            | "timeout"
            | "xargs"
            | "nice"
            | "nohup"
            | "busybox"
            | "sudo"
            | "doas"
            | "command"
            | "exec"
            | "time"
            | "setsid"
            | "stdbuf"
            | "ionice"
            | "taskset"
            | "chrt"
            | "flock"
            | "strace"
            | "watch"
            | "caffeinate"
            | "nsenter"
            | "unshare"
            | "chroot"
            | "runuser"
            | "setpriv"
            | "pkexec"
            | "su"
            | "runas"
            | "gsudo"
            | "sshpass"
            | "expect"
            | "rm"
            | "format"
            | "diskpart"
    ) || name == "mkfs"
        || name.starts_with("mkfs.")
    {
        return Err(Failure::denied(
            "Use a directly approved program or a bounded file operation.",
        ));
    }

    Ok(())
}
