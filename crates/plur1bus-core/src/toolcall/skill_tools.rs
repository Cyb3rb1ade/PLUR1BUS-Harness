//! `skill.load` and `skill.read` (`skill-tools.ts`): the two read-only tools that expose an admitted skill's instructions
//! and resource files, and nothing else. No execution, no ambient file system access: a name must be in the agent's
//! admitted view, a path must be a plain relative path, every component is checked for symlinks and for a canonical
//! spelling at use time, a credential-style file is neither listed nor read, and a file is at most 64 KiB.
//!
//! The tool registry and the dispatcher are not ported here (P4-43): the two tools are [`SkillTools::execute`] and
//! [`SkillTools::classify`], and [`tool_definitions`] is the data of the two `ToolDef`s. The admitted view is a list of
//! skill names (the `entry.name` of each `IndexedSkill` of `live-index.ts`); it joins the live index when that is ported.
//! Cancellation is the [`Cancelled`] port (`AbortSignal.throwIfAborted`).
//!
//! Errors carry fixed, path-free texts ([`SkillAccessCode::message`]); a file system error of any kind becomes
//! `unsafe-path`, as the TypeScript `catch` turns it into one.
use super::json::{JsStr, Obj, V};
use crate::js;
use crate::policy::paths::{match_deny, DenyEntry, DenyMatch, IcuNfc};
use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The read limit of one skill file (`MAX_SKILL_FILE_BYTES`).
pub const MAX_SKILL_FILE_BYTES: usize = 64 * 1024;
const MAX_SKILL_FILES: usize = 1024;
const MAX_SKILL_LIST_BYTES: usize = 16 * 1024;
const MAX_SKILL_DIRECTORY_DEPTH: usize = 32;
const MAX_SKILL_RESULT_BYTES: f64 = 128.0 * 1024.0;

/// The typed refusals of the skill tools (`SkillAccessError.code`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkillAccessCode {
    /// The name is not a safe skill name or not in the admitted view.
    SkillUnavailable,
    /// Anything wrong with the path or the file system, deliberately not told apart.
    UnsafePath,
    /// A credential-style file.
    SecretFile,
    /// A file over 64 KiB.
    TooLarge,
    /// The file list over its count, byte or depth bound.
    FileListTooLarge,
}

impl SkillAccessCode {
    /// The code as TypeScript spells it.
    pub fn code(self) -> &'static str {
        match self {
            SkillAccessCode::SkillUnavailable => "skill-unavailable",
            SkillAccessCode::UnsafePath => "unsafe-path",
            SkillAccessCode::SecretFile => "secret-file",
            SkillAccessCode::TooLarge => "too-large",
            SkillAccessCode::FileListTooLarge => "file-list-too-large",
        }
    }

    /// The fixed message the model gets; it names no path and no content.
    pub fn message(self) -> &'static str {
        match self {
            SkillAccessCode::SkillUnavailable => {
                "The skill is unavailable to this agent; use capabilities.search to find an available skill."
            }
            SkillAccessCode::UnsafePath => {
                "The resource is unavailable or unsafe; use a regular file relative to the listed skill directory."
            }
            SkillAccessCode::SecretFile => {
                "Credential-style files are never exposed by skills; use a resource from the listed files."
            }
            SkillAccessCode::TooLarge => {
                "The skill resource exceeds the 64 KiB read limit; request a smaller resource."
            }
            SkillAccessCode::FileListTooLarge => {
                "The skill file list exceeds its limit; reduce the number or depth of skill resources."
            }
        }
    }
}

/// Why a skill tool did not answer: a typed refusal, or the call was cancelled (`AbortError`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkillError {
    /// `SkillAccessError`.
    Access(SkillAccessCode),
    /// The signal was aborted.
    Aborted,
}

impl From<SkillAccessCode> for SkillError {
    fn from(code: SkillAccessCode) -> Self {
        SkillError::Access(code)
    }
}

/// The cancellation port: `signal.aborted`.
pub trait Cancelled {
    /// Whether the call has been cancelled.
    fn aborted(&self) -> bool;
}

/// A signal that is never aborted.
pub struct NeverCancelled;

impl Cancelled for NeverCancelled {
    fn aborted(&self) -> bool {
        false
    }
}

fn check(signal: &dyn Cancelled) -> Result<(), SkillError> {
    if signal.aborted() {
        Err(SkillError::Aborted)
    } else {
        Ok(())
    }
}

/// The two tools' modes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkillMode {
    /// `skill.load`: `SKILL.md` without its front matter, and the file list.
    Load,
    /// `skill.read`: one listed resource as text.
    Read,
}

impl SkillMode {
    fn word(self) -> &'static str {
        match self {
            SkillMode::Load => "load",
            SkillMode::Read => "read",
        }
    }
}

/// `isSecretFileName` (`import/secret-file-names.ts`): a file name that carries credentials by convention.
pub fn is_secret_file_name(name: &str) -> bool {
    let n = js::to_lower_case(name);
    matches!(
        n.as_str(),
        ".env" | "auth.json" | "credentials.json" | ".netrc" | ".npmrc" | ".pypirc"
    ) || n.starts_with(".env.")
        || n.ends_with(".pem")
        || n.ends_with(".key")
        || n.starts_with("id_rsa")
        || n.starts_with("id_ed25519")
        || n.starts_with("id_ecdsa")
}

/// The name entries of the policy deny list (`denyEntriesFor("/", {}, "linux")` filtered to `{ name }`), in its order.
/// The vectors compare this table with the TypeScript one, so the two cannot drift apart.
pub const DENY_NAMES: &[&str] = &[
    ".env",
    ".env.local",
    ".netrc",
    ".npmrc",
    ".ssh",
    ".gnupg",
    "credentials",
    "credentials.json",
    "auth.json",
    "auth-profiles.json",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "application_default_credentials.json",
];

fn deny_names() -> &'static [DenyEntry] {
    static ENTRIES: OnceLock<Vec<DenyEntry>> = OnceLock::new();
    ENTRIES.get_or_init(|| {
        DENY_NAMES
            .iter()
            .map(|n| DenyEntry::Name((*n).to_owned()))
            .collect()
    })
}

/// `isCredentialPath(parts)`: a secret file name in any component, or a name the deny list covers. A lone surrogate
/// becomes U+FFFD first; no rule here looks at a surrogate, so the answer is the same.
pub fn is_credential_path(parts: &[JsStr]) -> bool {
    let names: Vec<String> = parts.iter().map(JsStr::lossy).collect();
    names.iter().any(|n| is_secret_file_name(n))
        // A fold the port cannot decide counts as a hit: fail closed.
        || !matches!(
            match_deny(&names.join("/"), deny_names(), &IcuNfc),
            DenyMatch::Miss
        )
}

/// `relativeParts(path)`: a non-empty string without a backslash, a control character or a drive prefix, whose `/`
/// segments are all non-empty and neither `.` nor `..`.
fn relative_parts(path: Option<&V>) -> Result<Vec<JsStr>, SkillAccessCode> {
    let Some(V::Str(path)) = path else {
        return Err(SkillAccessCode::UnsafePath);
    };
    let units = path.units();
    let drive = units.len() >= 2
        && u8::try_from(units[0]).is_ok_and(|b| b.is_ascii_alphabetic())
        && units[1] == u16::from(b':');
    if units.is_empty() || drive || units.iter().any(|u| *u == 0x5c || *u < 0x20 || *u == 0x7f) {
        return Err(SkillAccessCode::UnsafePath);
    }
    let parts: Vec<JsStr> = units
        .split(|u| *u == u16::from(b'/'))
        .map(|p| JsStr::new(p.to_vec()))
        .collect();
    if parts
        .iter()
        .any(|p| p.is_empty() || p.is(".") || p.is(".."))
    {
        return Err(SkillAccessCode::UnsafePath);
    }
    Ok(parts)
}

/// `requestsCredential(args)`: whether `args.path` names a credential-style file, split at every run of `/` and `\`.
/// Never refuses a malformed path: that is the path check's business.
pub fn requests_credential(args: Option<&V>) -> bool {
    let Some(V::Str(path)) = args.and_then(|a| a.get("path")) else {
        return false;
    };
    let parts: Vec<JsStr> = path
        .units()
        .split(|u| *u == 0x2f || *u == 0x5c)
        .filter(|p| !p.is_empty())
        .map(|p| JsStr::new(p.to_vec()))
        .collect();
    is_credential_path(&parts)
}

fn frontmatter_pattern() -> Option<&'static regress::Regex> {
    static PATTERN: OnceLock<Option<regress::Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| regress::Regex::new(r"^﻿?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)").ok())
        .as_ref()
}

/// `withoutFrontmatter(text)`: the text without a leading `---` block (an optional BOM before it).
pub fn without_frontmatter(text: &JsStr) -> JsStr {
    let units = text.units();
    match frontmatter_pattern().and_then(|p| p.find_from_utf16(units, 0).next()) {
        Some(m) => {
            let mut out = units[..m.start()].to_vec();
            out.extend_from_slice(&units[m.end()..]);
            JsStr::new(out)
        }
        None => text.clone(),
    }
}

fn name_of(part: &JsStr) -> String {
    part.lossy()
}

/// `checkedPath(root, parts)`: every component from `root` down exists, is not a symlink, is a directory except the last,
/// and is its own canonical spelling.
fn checked_path(root: &Path, parts: &[JsStr]) -> Result<PathBuf, SkillAccessCode> {
    let mut components = vec![root.to_path_buf()];
    let mut current = root.to_path_buf();
    for part in parts {
        current = current.join(name_of(part));
        components.push(current.clone());
    }
    let last = components.len() - 1;
    for (index, component) in components.iter().enumerate() {
        let info = fs::symlink_metadata(component).map_err(|_| SkillAccessCode::UnsafePath)?;
        if info.file_type().is_symlink() || (index < last && !info.is_dir()) {
            return Err(SkillAccessCode::UnsafePath);
        }
        let real = fs::canonicalize(component).map_err(|_| SkillAccessCode::UnsafePath)?;
        if &real != component {
            return Err(SkillAccessCode::UnsafePath);
        }
    }
    let resolved = components.swap_remove(last);
    if resolved != root && !resolved.starts_with(root) {
        return Err(SkillAccessCode::UnsafePath);
    }
    Ok(resolved)
}

fn skill_root(home: &Path, name: &str) -> Result<PathBuf, SkillAccessCode> {
    let canonical_home = fs::canonicalize(home).map_err(|_| SkillAccessCode::UnsafePath)?;
    let root = checked_path(&canonical_home, &[JsStr::from("skills"), JsStr::from(name)])?;
    if !fs::symlink_metadata(&root)
        .map_err(|_| SkillAccessCode::UnsafePath)?
        .is_dir()
    {
        return Err(SkillAccessCode::UnsafePath);
    }
    Ok(root)
}

#[cfg(unix)]
fn open_regular(path: &Path) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    // A regular file can be replaced between lstat and open; non-blocking mode also keeps a raced FIFO harmless.
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
}

#[cfg(not(unix))]
fn open_regular(path: &Path) -> std::io::Result<fs::File> {
    fs::OpenOptions::new().read(true).open(path)
}

#[cfg(unix)]
fn same_file(named: &fs::Metadata, opened: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    named.dev() == opened.dev() && named.ino() == opened.ino()
}

/// Windows: the standard library does not give a file's volume and index on stable Rust, so the identity of the opened
/// handle and the named path is not compared there (TypeScript compares `dev`/`ino`). The path is still re-checked for
/// symlinks and canonical spelling before and after the read; what remains open is a swap of one regular file for
/// another regular file inside the skill folder during the read.
#[cfg(not(unix))]
fn same_file(_named: &fs::Metadata, _opened: &fs::Metadata) -> bool {
    true
}

fn verify_handle(root: &Path, parts: &[JsStr], handle: &fs::File) -> Result<(), SkillAccessCode> {
    let path = checked_path(root, parts)?;
    let named = fs::symlink_metadata(&path).map_err(|_| SkillAccessCode::UnsafePath)?;
    let opened = handle.metadata().map_err(|_| SkillAccessCode::UnsafePath)?;
    if !opened.is_file() || !same_file(&named, &opened) {
        return Err(SkillAccessCode::UnsafePath);
    }
    if opened.len() > MAX_SKILL_FILE_BYTES as u64 {
        return Err(SkillAccessCode::TooLarge);
    }
    Ok(())
}

fn read_skill_file(
    root: &Path,
    parts: &[JsStr],
    signal: &dyn Cancelled,
) -> Result<JsStr, SkillError> {
    check(signal)?;
    let path = checked_path(root, parts)?;
    if !fs::symlink_metadata(&path)
        .map_err(|_| SkillAccessCode::UnsafePath)?
        .is_file()
    {
        return Err(SkillAccessCode::UnsafePath.into());
    }
    let handle = open_regular(&path).map_err(|_| SkillAccessCode::UnsafePath)?;
    verify_handle(root, parts, &handle)?;
    let mut buffer = Vec::with_capacity(MAX_SKILL_FILE_BYTES + 1);
    let mut chunk = [0u8; 16 * 1024];
    let mut reader = (&handle).take(MAX_SKILL_FILE_BYTES as u64 + 1);
    loop {
        check(signal)?;
        let read = reader
            .read(&mut chunk)
            .map_err(|_| SkillAccessCode::UnsafePath)?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    if buffer.len() > MAX_SKILL_FILE_BYTES {
        return Err(SkillAccessCode::TooLarge.into());
    }
    verify_handle(root, parts, &handle)?;
    check(signal)?;
    // `buffer.toString("utf8")`: an ill-formed sequence becomes U+FFFD, a BOM stays.
    Ok(JsStr::from(String::from_utf8_lossy(&buffer).into_owned()))
}

fn list_skill_files(root: &Path, signal: &dyn Cancelled) -> Result<Vec<JsStr>, SkillError> {
    let mut files: Vec<String> = Vec::new();
    let mut pending: Vec<Vec<JsStr>> = vec![Vec::new()];
    let mut bytes = 0usize;
    let mut directories = 0usize;
    while let Some(parts) = pending.pop() {
        check(signal)?;
        directories += 1;
        if parts.len() > MAX_SKILL_DIRECTORY_DEPTH || directories > MAX_SKILL_FILES {
            return Err(SkillAccessCode::FileListTooLarge.into());
        }
        let folder = checked_path(root, &parts)?;
        let entries = fs::read_dir(&folder).map_err(|_| SkillAccessCode::UnsafePath)?;
        for entry in entries {
            let entry = entry.map_err(|_| SkillAccessCode::UnsafePath)?;
            let kind = entry.file_type().map_err(|_| SkillAccessCode::UnsafePath)?;
            let mut child = parts.clone();
            child.push(JsStr::from(
                entry.file_name().to_string_lossy().into_owned(),
            ));
            if kind.is_symlink() || is_credential_path(&child) {
                continue;
            }
            if kind.is_dir() {
                pending.push(child);
                if pending.len() > MAX_SKILL_FILES {
                    return Err(SkillAccessCode::FileListTooLarge.into());
                }
            } else if kind.is_file() {
                let relative = child.iter().map(JsStr::lossy).collect::<Vec<_>>().join("/");
                bytes += relative.len();
                files.push(relative);
                if files.len() > MAX_SKILL_FILES || bytes > MAX_SKILL_LIST_BYTES {
                    return Err(SkillAccessCode::FileListTooLarge.into());
                }
            }
        }
    }
    js::sort_default(&mut files);
    Ok(files.into_iter().map(JsStr::from).collect())
}

/// `SAFE_NAME`: `/^[a-z0-9][a-z0-9._-]{0,63}$/`.
fn safe_name(name: &JsStr) -> Option<String> {
    let units = name.units();
    let ok = !units.is_empty()
        && units.len() <= 64
        && units.iter().enumerate().all(|(i, u)| {
            u8::try_from(*u).is_ok_and(|b| {
                b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || (i > 0 && matches!(b, b'.' | b'_' | b'-'))
            })
        });
    ok.then(|| name.lossy())
}

/// `onLoad`: records a successful load, including a harness-triggered one through the same tool.
pub type LoadHook = Box<dyn FnMut(&str) + Send>;

/// The two skill tools over one admitted view (`createSkillTools`).
pub struct SkillTools {
    home: PathBuf,
    admitted: BTreeSet<String>,
    on_load: Option<LoadHook>,
}

/// `createSkillTools(options)`: `None` where no skill is admitted (TypeScript returns no tools).
pub fn create_skill_tools(
    home: &Path,
    skills: &[&str],
    on_load: Option<LoadHook>,
) -> Option<SkillTools> {
    if skills.is_empty() {
        return None;
    }
    Some(SkillTools {
        home: home.to_path_buf(),
        admitted: skills.iter().map(|s| (*s).to_owned()).collect(),
        on_load,
    })
}

impl SkillTools {
    /// `execute(args, signal, mode)`. `args` is `None` for `undefined`.
    pub fn execute(
        &mut self,
        mode: SkillMode,
        args: Option<&V>,
        signal: &dyn Cancelled,
    ) -> Result<V, SkillError> {
        check(signal)?;
        let name = match args.and_then(|a| a.get("name")) {
            Some(V::Str(n)) => safe_name(n).filter(|n| self.admitted.contains(n)),
            _ => None,
        };
        let Some(name) = name else {
            return Err(SkillAccessCode::SkillUnavailable.into());
        };
        match self.run(mode, args, &name, signal) {
            Ok(v) => Ok(v),
            Err(e) => {
                check(signal)?;
                Err(e)
            }
        }
    }

    fn run(
        &mut self,
        mode: SkillMode,
        args: Option<&V>,
        name: &str,
        signal: &dyn Cancelled,
    ) -> Result<V, SkillError> {
        let parts = match mode {
            SkillMode::Load => vec![JsStr::from("SKILL.md")],
            SkillMode::Read => relative_parts(args.and_then(|a| a.get("path")))?,
        };
        if is_credential_path(&parts) {
            return Err(SkillAccessCode::SecretFile.into());
        }
        let root = skill_root(&self.home, name)?;
        let text = read_skill_file(&root, &parts, signal)?;
        let mut out = Obj::new();
        out.set("name", V::s(name));
        if mode == SkillMode::Read {
            let mut path = JsStr::default();
            for (i, p) in parts.iter().enumerate() {
                if i > 0 {
                    path.push_str("/");
                }
                path.push(p);
            }
            out.set("path", V::Str(path));
            out.set("text", V::Str(text));
            return Ok(V::Obj(out));
        }
        let files = list_skill_files(&root, signal)?;
        if let Some(on_load) = self.on_load.as_mut() {
            on_load(name);
        }
        out.set("text", V::Str(without_frontmatter(&text)));
        out.set("files", V::Arr(files.into_iter().map(V::Str).collect()));
        Ok(V::Obj(out))
    }

    /// `classify(args)`: `{ flags: { outsideRoots: false, denyListHit } }`; only `skill.read` of a credential path hits.
    pub fn classify(mode: SkillMode, args: Option<&V>) -> V {
        V::obj([(
            "flags",
            V::obj([
                ("outsideRoots", V::Bool(false)),
                (
                    "denyListHit",
                    V::Bool(mode == SkillMode::Read && requests_credential(args)),
                ),
            ]),
        )])
    }
}

/// The data of the two `ToolDef`s, as `JSON.stringify` writes them (the functions are not data).
pub fn tool_definitions() -> V {
    V::Arr(
        [SkillMode::Load, SkillMode::Read]
            .iter()
            .map(|mode| {
                let load = *mode == SkillMode::Load;
                let mut properties = Obj::new();
                properties.set(
                    "name",
                    V::obj([
                        ("type", V::s("string")),
                        ("minLength", V::Num(1.0)),
                        ("maxLength", V::Num(64.0)),
                    ]),
                );
                if !load {
                    properties.set(
                        "path",
                        V::obj([
                            ("type", V::s("string")),
                            ("minLength", V::Num(1.0)),
                            ("maxLength", V::Num(4096.0)),
                        ]),
                    );
                }
                V::obj([
                    ("name", V::s(&format!("skill.{}", mode.word()))),
                    (
                        "description",
                        V::s(if load {
                            "Load an available skill's instructions and relative resource file list. Follow the loaded workflow."
                        } else {
                            "Read one listed skill resource as text. Paths are relative to that skill; scripts are never executed."
                        }),
                    ),
                    (
                        "inputSchema",
                        V::obj([
                            ("type", V::s("object")),
                            ("additionalProperties", V::Bool(false)),
                            ("properties", V::Obj(properties)),
                            (
                                "required",
                                if load {
                                    V::strs(&["name"])
                                } else {
                                    V::strs(&["name", "path"])
                                },
                            ),
                        ]),
                    ),
                    ("capability", V::s("fs.read")),
                    ("effect", V::s("read")),
                    ("risk", V::s("low")),
                    ("trust", V::s("first-party")),
                    (
                        "limits",
                        V::obj([("maxResultBytes", V::Num(MAX_SKILL_RESULT_BYTES))]),
                    ),
                    (
                        "discovery",
                        V::obj([
                            ("category", V::s("general.chat")),
                            (
                                "summary",
                                V::s(&format!(
                                    "Read available skill {}.",
                                    if load { "instructions" } else { "resources" }
                                )),
                            ),
                            (
                                "useWhen",
                                V::s(if load {
                                    "An available skill matches the task."
                                } else {
                                    "A loaded skill refers to a resource file."
                                }),
                            ),
                            (
                                "notFor",
                                V::s("Executing scripts, reading other skills or bypassing agent visibility."),
                            ),
                        ]),
                    ),
                ])
            })
            .collect(),
    )
}
