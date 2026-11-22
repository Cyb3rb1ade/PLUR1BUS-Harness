//! Program and argument validation (`tools/exec/args.ts`). Arguments are an array handed to the operating system as it
//! is (no shell), so there is nothing to escape; what is refused is what cannot be passed faithfully or must never be
//! started from here.
use super::{ExecFailure, ExecFailureCode};
use plur1bus_core::js;
use serde_json::Value;

const MAX_ARGS: usize = 256;
const MAX_ARG_BYTES: usize = 32 * 1024;
const MAX_TOTAL_BYTES: usize = 256 * 1024;

// RULING (TypeScript): shell interpreters are never started (they would turn the argument array back into a command
// string), and privilege escalators belong to `os.privilege`, which this tool does not serve. Fail closed, in every tier.
const SHELLS: [&str; 14] = [
    "sh",
    "bash",
    "zsh",
    "dash",
    "ash",
    "ksh",
    "csh",
    "tcsh",
    "fish",
    "cmd",
    "powershell",
    "pwsh",
    "wsl",
    "busybox",
];
const PRIVILEGED: [&str; 8] = [
    "sudo", "doas", "pkexec", "su", "runas", "gsudo", "expect", "sshpass",
];

/// One entry of the allowlist (`AllowedProgram`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AllowedProgram {
    /// A bare name (`git`) or an absolute path; compared exactly (case-folded on Windows).
    pub program: String,
    /// Every argument must match this pattern (see [`super::pattern`]).
    pub arg_pattern: Option<String>,
}

fn invalid(message: &str) -> ExecFailure {
    ExecFailure::new(ExecFailureCode::InvalidInput, message)
}

/// Windows drops trailing dots and spaces from a file name, so `bash.exe.` starts bash.exe and `x.bat.` is x.bat.
fn trim_win_tail(s: &str) -> &str {
    s.trim_end_matches(['.', ' '])
}

/// Node's `path.basename` of a path whose separators are all `/`: `path.posix.basename`, or on a Windows host
/// `path.win32.basename`, which also leaves out a drive prefix (`C:sh` is `sh`).
fn basename(p: &str, windows_host: bool) -> &str {
    let b = p.as_bytes();
    let p = if windows_host && b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        &p[2..]
    } else {
        p
    };
    let trimmed = p.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or("")
}

/// `programKey`: the name a program is recognised by, whatever directory, case, `.exe` or trailing dots it is spelled with.
/// `windows_host` is the system this process runs on (the TypeScript code uses the host's `node:path`).
pub fn program_key(program: &str, windows_host: bool) -> String {
    let slashed = program.replace('\\', "/");
    let name = trim_win_tail(basename(trim_win_tail(&slashed), windows_host)).to_lowercase();
    for ext in [".exe", ".com"] {
        if let Some(stem) = name.strip_suffix(ext) {
            return stem.to_owned();
        }
    }
    name
}

fn is_batch_script(program: &str) -> bool {
    let t = trim_win_tail(program);
    let lower = t.to_ascii_lowercase();
    lower.ends_with(".bat") || lower.ends_with(".cmd")
}

/// `validateProgram`.
pub fn validate_program(
    program: Option<&Value>,
    windows_host: bool,
) -> Result<String, ExecFailure> {
    let p = match program.and_then(Value::as_str) {
        Some(p) if !p.is_empty() && js::utf16_len(p) <= 4096 => p,
        _ => return Err(invalid("program must be a non-empty string")),
    };
    if p.contains(['\0', '\r', '\n']) {
        return Err(invalid("program contains a control character"));
    }
    if p != js::js_trim(p) {
        return Err(invalid("program has surrounding whitespace"));
    }
    let refused = |m: String| ExecFailure::new(ExecFailureCode::ProgramRefused, &m);
    if p.starts_with('-') {
        return Err(refused("program may not start with '-'".to_owned()));
    }
    if is_batch_script(p) {
        return Err(refused(
            "batch scripts are not started (they re-parse arguments as a command line)".to_owned(),
        ));
    }
    let key = program_key(p, windows_host);
    if SHELLS.contains(&key.as_str()) {
        return Err(refused(format!(
            "{key} is a shell interpreter; pass the program and its arguments directly"
        )));
    }
    if PRIVILEGED.contains(&key.as_str()) {
        return Err(refused(format!(
            "{key} escalates privileges; not available through exec.run"
        )));
    }
    Ok(p.to_owned())
}

/// `validateArgs`: `None` is an absent `args` member.
pub fn validate_args(args: Option<&Value>) -> Result<Vec<String>, ExecFailure> {
    let Some(args) = args else {
        return Ok(Vec::new());
    };
    let list = match args.as_array() {
        Some(l) if l.len() <= MAX_ARGS => l,
        _ => {
            return Err(invalid(&format!(
                "args must be an array of at most {MAX_ARGS} strings"
            )))
        }
    };
    let mut out = Vec::with_capacity(list.len());
    let mut total = 0usize;
    for a in list {
        let Some(a) = a.as_str() else {
            return Err(invalid("every argument must be a string"));
        };
        if a.contains('\0') {
            return Err(invalid("an argument contains NUL"));
        }
        total += a.len();
        if a.len() > MAX_ARG_BYTES || total > MAX_TOTAL_BYTES {
            return Err(invalid("arguments too large"));
        }
        out.push(a.to_owned());
    }
    Ok(out)
}

/// `findAllowed`: the allowlist entry for `program`. A bare entry matches the bare name only, a path entry that exact
/// path; `windows` folds the case.
pub fn find_allowed<'a>(
    list: &'a [AllowedProgram],
    program: &str,
    windows: bool,
) -> Option<&'a AllowedProgram> {
    let fold = |s: &str| {
        if windows {
            s.to_lowercase()
        } else {
            s.to_owned()
        }
    };
    let want = fold(program);
    list.iter().find(|e| fold(&e.program) == want)
}
