//! The helper as the core sees it (TypeScript: `attestation/helper.ts`, `attestation/resolve.ts`): which binary counts as
//! pinned, what the installation expects of it, and the rule that an answer counts only if the file that gave it is still
//! the one that was checked.
use serde_json::{Map, Value};

/// What the installation expects of the helper binary (`HelperPin`). An absent member is not checked.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HelperPin {
    /// Lower-case hex SHA-256 of the binary.
    pub sha256: Option<String>,
    /// macOS: the Apple team id the code signature must carry.
    pub mac_team_id: Option<String>,
    /// Windows: the SHA-1 thumbprint (upper case) of the Authenticode signer.
    pub win_thumbprint: Option<String>,
}

/// `HelperSpec`: the binary, the arguments before the mode flag, extra environment, the pin.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HelperSpec {
    /// Absolute path of the executable.
    pub path: String,
    /// Arguments before `--attest` / `--probe`.
    pub args: Vec<String>,
    /// Extra environment.
    pub env: Vec<(String, String)>,
    /// What the binary must be.
    pub pin: Option<HelperPin>,
}

/// `HelperOutcome`.
#[derive(Clone, Debug, PartialEq)]
pub enum HelperOutcome {
    /// One JSON object line.
    Reply(Map<String, Value>),
    /// No answer within the deadline (the helper was killed).
    Timeout,
    /// No helper (not pinned, not startable).
    Missing,
    /// An answer that is not one JSON object line, or none at all.
    Broken,
    /// The helper failed its pin (`HelperRefusal`, for the audit log).
    Refused(&'static str),
}

/// The production side of the helper: the checks of `verifyHelper` and one run of the pinned binary. The flip supplies it.
pub trait HelperHost {
    /// `verifyHelper(spec)`: `Ok(fingerprint)` (empty without a pin), or the `HelperRefusal`; `helper-not-pinned` where the
    /// file is no pinned helper at all.
    fn verify(&self, spec: &HelperSpec) -> Result<String, &'static str>;
    /// One run with `--attest` or `--probe`: `request` as one JSON line on stdin (none for a probe), killed at `deadline_ms`.
    fn run(
        &self,
        spec: &HelperSpec,
        mode: &str,
        request: Option<&Value>,
        deadline_ms: f64,
    ) -> HelperOutcome;
}

/// `runHelper`: verify, run, and (with a pin) verify again; an answer from a file that changed during the run is refused.
pub fn run_helper(
    host: &dyn HelperHost,
    spec: &HelperSpec,
    mode: &str,
    request: Option<&Value>,
    deadline_ms: f64,
) -> HelperOutcome {
    let before = match host.verify(spec) {
        Ok(f) => f,
        Err("helper-not-pinned") => return HelperOutcome::Missing,
        Err(reason) => return HelperOutcome::Refused(reason),
    };
    let out = host.run(spec, mode, request, deadline_ms);
    if !matches!(out, HelperOutcome::Reply(_)) || spec.pin.is_none() {
        return out;
    }
    // The answer counts only if the file that gave it is still the one that was checked.
    match host.verify(spec) {
        Ok(after) if after == before => out,
        _ => HelperOutcome::Refused("helper-changed-during-run"),
    }
}

/// What `helperPinned` reads of a path (`lstat`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileStat {
    /// A regular file.
    pub is_file: bool,
    /// A directory.
    pub is_dir: bool,
    /// The permission bits.
    pub mode: u32,
    /// The owner.
    pub uid: u32,
}

/// The file system and identity facts behind `helperPinned` (a port: the production adapter is `symlink_metadata` and the
/// process's user id).
pub trait FileProbe {
    /// `lstat(path)`, `None` where it fails.
    fn lstat(&self, path: &str) -> Option<FileStat>;
    /// `process.getuid()`, `None` where there is none (Windows).
    fn uid(&self) -> Option<u32>;
    /// Windows path and permission rules.
    fn windows(&self) -> bool;
}

/// `path.isAbsolute` for the platform.
fn is_absolute(p: &str, windows: bool) -> bool {
    let b = p.as_bytes();
    if !windows {
        return p.starts_with('/');
    }
    matches!(b.first(), Some(b'/' | b'\\'))
        || (b.len() >= 3
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && matches!(b[2], b'/' | b'\\'))
}

/// `path.dirname` of an absolute path.
fn dirname(p: &str, windows: bool) -> &str {
    let is_sep = |c: char| c == '/' || (windows && c == '\\');
    let trimmed = p.trim_end_matches(is_sep);
    match trimmed.rfind(is_sep) {
        Some(0) => &p[..1],
        Some(i) => {
            let d = &trimmed[..i];
            if windows && d.len() == 2 && d.ends_with(':') {
                &p[..3]
            } else {
                d
            }
        }
        None => p,
    }
}

/// `helperPinned`: absolute, a regular file, not writable by group or others, owned by root or the core's own user, in a
/// directory that is neither group- nor world-writable nor owned by anyone else (POSIX). This stops other users, not the
/// owner's own processes.
pub fn helper_pinned(path: &str, probe: &dyn FileProbe) -> bool {
    let windows = probe.windows();
    if !is_absolute(path, windows) {
        return false;
    }
    let Some(st) = probe.lstat(path) else {
        return false;
    };
    if !st.is_file {
        return false;
    }
    if windows {
        return true;
    }
    let me = probe.uid();
    let owned = |uid: u32| uid == 0 || Some(uid) == me;
    if st.mode & 0o022 != 0 || !owned(st.uid) {
        return false;
    }
    // A sticky shared directory (/tmp) is writable by everyone on purpose and is still no place for a helper.
    probe
        .lstat(dirname(path, windows))
        .is_some_and(|d| d.is_dir && d.mode & 0o022 == 0 && owned(d.uid))
}

fn hex_of_len(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `helperFromEnv`: the helper the supervisor or CLI points the core at (`PLUR1BUS_ATTEST_BIN`), with the pin the same
/// caller may hand over. Container mode has no helper; a variable that is set but malformed makes the result `None` (a
/// broken pin must not read as "no pin").
pub fn helper_from_env(
    env: &dyn Fn(&str) -> Option<String>,
    probe: &dyn FileProbe,
) -> Option<HelperSpec> {
    if env("PLUR1BUS_CONTAINER").as_deref() == Some("1") {
        return None;
    }
    let path = env("PLUR1BUS_ATTEST_BIN").filter(|p| !p.is_empty())?;
    if !helper_pinned(&path, probe) {
        return None;
    }
    let mut pin = HelperPin::default();
    if let Some(sha) = env("PLUR1BUS_ATTEST_SHA256") {
        if !hex_of_len(&sha, 64) {
            return None;
        }
        pin.sha256 = Some(sha.to_ascii_lowercase());
    }
    if let Some(team) = env("PLUR1BUS_ATTEST_TEAM_ID") {
        if team.len() != 10
            || !team
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        {
            return None;
        }
        pin.mac_team_id = Some(team);
    }
    if let Some(thumb) = env("PLUR1BUS_ATTEST_WIN_THUMBPRINT") {
        if !hex_of_len(&thumb, 40) {
            return None;
        }
        pin.win_thumbprint = Some(thumb.to_ascii_uppercase());
    }
    let any = pin != HelperPin::default();
    Some(HelperSpec {
        path,
        args: Vec::new(),
        env: Vec::new(),
        pin: any.then_some(pin),
    })
}
