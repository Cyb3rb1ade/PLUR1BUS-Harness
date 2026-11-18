//! D109 part 2, the pure half of the path layer (TypeScript: `policy/paths.ts`): the syntax rules per platform, the
//! deny-list matcher with its case and NFC folding, and the root and system-tree rules. Every function takes the platform
//! (or `windows`) as an argument, so the Windows rules are proven on every operating system.
//!
//! Not here: `canonicalisePath` (real-target resolution, identities, the hard-link scans) and `openVerified` (the
//! time-of-use re-check). They read the real file system and are the next part of this milestone (see the K2 entry of the
//! ledger); a flip must not call the TypeScript-equivalent answer of this module a canonical path.
//!
//! **Folding.** The deny side compares NFC- and case-folded (`foldForDeny`: NFC, `toUpperCase`, `toLowerCase`, NFC), so it
//! matches more, never less. NFC is a port ([`Nfc`]); the implementation is [`IcuNfc`]. The port may decline, and a fold
//! that cannot be done fails closed: the deny matcher counts it as a match, and the system-tree rules count the path as a
//! system tree. The tests keep a double that declines, so that path stays proven.
use crate::js;
use serde_json::{json, Value};

/// Unicode normalisation form C. `None` means this port cannot answer for the text, and the caller fails closed.
pub trait Nfc {
    /// `s.normalize("NFC")`.
    fn nfc(&self, s: &str) -> Option<String>;
}

/// [`Nfc`] over the Unicode data `icu_normalizer` compiles in. It always answers.
#[derive(Clone, Copy, Debug, Default)]
pub struct IcuNfc;

impl Nfc for IcuNfc {
    fn nfc(&self, s: &str) -> Option<String> {
        Some(
            icu_normalizer::ComposingNormalizerBorrowed::new_nfc()
                .normalize(s)
                .into_owned(),
        )
    }
}

/// A port that answers only where every code point is below U+0300 (such text is already NFC) and declines everything
/// else: the double for the fail-closed path.
#[cfg(test)]
#[derive(Clone, Copy, Debug, Default)]
pub struct LatinNfc;

#[cfg(test)]
impl Nfc for LatinNfc {
    fn nfc(&self, s: &str) -> Option<String> {
        s.chars().all(|c| c < '\u{300}').then(|| s.to_owned())
    }
}

/// A typed refusal of the path layer (`PathRefusal`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathRefusal {
    /// The `RefusalReason`.
    pub reason: &'static str,
    /// The text of the refusal.
    pub detail: String,
}

impl PathRefusal {
    /// The TypeScript object.
    pub fn json(&self) -> Value {
        json!({ "ok": false, "reason": self.reason, "detail": self.detail })
    }
}

fn refuse(reason: &'static str, detail: impl Into<String>) -> PathRefusal {
    PathRefusal {
        reason,
        detail: detail.into(),
    }
}

/// `SyntaxOk`: a path that passed the syntactic rules.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyntaxOk {
    /// The Windows rules applied.
    pub windows: bool,
    /// A UNC path.
    pub unc: bool,
    /// The upper-case drive letter, if any.
    pub drive: Option<String>,
    /// The segments, with `.` and duplicate separators collapsed.
    pub segments: Vec<String>,
    /// The path is absolute.
    pub absolute: bool,
}

impl SyntaxOk {
    /// The TypeScript object.
    pub fn json(&self) -> Value {
        json!({ "ok": true, "windows": self.windows, "unc": self.unc, "drive": self.drive, "segments": self.segments, "absolute": self.absolute })
    }
}

/// The options of `checkSyntax`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SyntaxOptions<'a> {
    /// `process.platform` (or another value in tests).
    pub platform: &'a str,
    /// Apply the Windows name rules regardless of the platform (`None`: when the platform is `win32`).
    pub windows_rules: Option<bool>,
    /// UNC paths are refused unless true.
    pub allow_unc: bool,
}

const MAX_PATH_UTF8: usize = 4096;
const MAX_SEGMENT_UTF8: usize = 255;

fn is_bidi(c: char) -> bool {
    matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

/// `isReservedDeviceName`: the DOS device names Windows reserves in any directory, with an extension or trailing spaces.
pub fn is_reserved_device_name(segment: &str) -> bool {
    let first = segment.split('.').next().unwrap_or("");
    let stem = js::to_lower_case(first.trim_end_matches(' '));
    if matches!(
        stem.as_str(),
        "con" | "prn" | "aux" | "nul" | "conin$" | "conout$" | "clock$"
    ) {
        return true;
    }
    let port = stem
        .strip_prefix("com")
        .or_else(|| stem.strip_prefix("lpt"));
    port.is_some_and(|p| {
        let mut it = p.chars();
        matches!(
            (it.next(), it.next()),
            (Some('1'..='9' | '\u{b9}' | '\u{b2}' | '\u{b3}'), None)
        )
    })
}

/// `SHORT_NAME`: `^[^.]{1,6}~[0-9]+(\.[^.]{0,3})?$` over code points: an 8.3 alias.
fn short_name(seg: &str) -> bool {
    let (stem, ext) = match seg.split_once('.') {
        Some((s, e)) => (s, Some(e)),
        None => (seg, None),
    };
    if ext.is_some_and(|e| e.contains('.') || e.chars().count() > 3) {
        return false;
    }
    stem.char_indices()
        .filter(|(_, c)| *c == '~')
        .any(|(at, _)| {
            let base = stem[..at].chars().count();
            let digits = &stem[at + 1..];
            (1..=6).contains(&base)
                && !digits.is_empty()
                && digits.bytes().all(|b| b.is_ascii_digit())
        })
}

/// `checkSyntax`: the pure, file-system-free refusal rules. `..` is refused outright (RULING (TypeScript): even where it
/// would lexically stay inside, so a rule never depends on a later normalisation).
pub fn check_syntax(input: &Value, o: SyntaxOptions<'_>) -> Result<SyntaxOk, PathRefusal> {
    let Some(input) = input.as_str() else {
        return Err(refuse("not-a-string", "path must be a string"));
    };
    if input.is_empty() {
        return Err(refuse("empty", "empty path"));
    }
    if input.len() > MAX_PATH_UTF8 {
        return Err(refuse(
            "too-long",
            format!("longer than {MAX_PATH_UTF8} bytes"),
        ));
    }
    if input.chars().any(char::is_control) {
        return Err(refuse("control-char", "NUL or control character"));
    }
    if input.chars().any(is_bidi) {
        return Err(refuse("bidi-control", "Unicode bidirectional control"));
    }
    let windows = o.windows_rules.unwrap_or(o.platform == "win32");
    let (mut drive, mut unc, mut absolute) = (None, false, false);
    let normalised;
    let rest: &str = if windows {
        // Mixed separators are normalised to one; every refusal below sees the normalised form.
        normalised = input.replace('/', "\\");
        let n = normalised.as_str();
        let b = n.as_bytes();
        let device = b.len() >= 3
            && n.starts_with("\\\\")
            && (b[2] == b'?' || b[2] == b'.')
            && (b.len() == 3 || b[3] == b'\\');
        if device {
            return Err(refuse(
                "device-path",
                "\\\\?\\ and \\\\.\\ paths are refused",
            ));
        }
        if n.starts_with("\\??\\") {
            return Err(refuse("device-path", "NT object path"));
        }
        if let Some(r) = n.strip_prefix("\\\\") {
            if !o.allow_unc {
                return Err(refuse(
                    "unc-not-allowed",
                    "UNC paths are refused unless a root is UNC",
                ));
            }
            unc = true;
            absolute = true;
            r
        } else if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
            if b.get(2) != Some(&b'\\') {
                return Err(refuse("drive-relative", "drive-relative path (C:foo)"));
            }
            drive = Some(n[..1].to_ascii_uppercase());
            absolute = true;
            &n[3..]
        } else if n.starts_with('\\') {
            return Err(refuse("drive-relative", "rooted path without a drive"));
        } else {
            n
        }
    } else {
        if input.contains('\\') {
            return Err(refuse(
                "backslash",
                "backslash in a POSIX path (RULING: ambiguous with a separator, refused)",
            ));
        }
        absolute = input.starts_with('/');
        input
    };
    let mut segments = Vec::new();
    for seg in rest.split(if windows { '\\' } else { '/' }) {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err(refuse("dot-dot", "'..' segment"));
        }
        if seg.len() > MAX_SEGMENT_UTF8 {
            return Err(refuse(
                "too-long",
                format!("segment longer than {MAX_SEGMENT_UTF8} bytes"),
            ));
        }
        if windows {
            let q = js::json_stringify(seg);
            if seg.contains(':') {
                return Err(refuse(
                    "alternate-stream",
                    format!("':' in segment {q} (drive spec or NTFS stream)"),
                ));
            }
            if seg.contains(['<', '>', '"', '|', '?', '*']) {
                return Err(refuse(
                    "forbidden-char",
                    format!("one of < > \" | ? * in {q}"),
                ));
            }
            if seg.ends_with('.') || seg.ends_with(' ') {
                return Err(refuse(
                    "trailing-dot-space",
                    format!("segment {q} ends in a dot or space"),
                ));
            }
            if is_reserved_device_name(seg) {
                return Err(refuse(
                    "reserved-device-name",
                    format!("{q} is a Windows device name"),
                ));
            }
            if short_name(seg) {
                return Err(refuse(
                    "short-name",
                    format!("{q} looks like an 8.3 short name"),
                ));
            }
        }
        segments.push(seg.to_owned());
    }
    if segments.is_empty() && !absolute {
        return Err(refuse("empty", "path has no segments"));
    }
    Ok(SyntaxOk {
        windows,
        unc,
        drive,
        segments,
        absolute,
    })
}

/// `foldForDeny`: NFC, then an upper/lower round trip so `ß`/`ss`, `İ`, `K` (Kelvin) and friends fold together, then NFC.
/// `None` where the [`Nfc`] port cannot answer.
pub fn fold_for_deny(s: &str, nfc: &dyn Nfc) -> Option<String> {
    let first = nfc.nfc(s)?;
    nfc.nfc(&js::to_lower_case(&js::to_upper_case(&first)))
}

/// A deny-list entry (`DenyEntry`): a path and everything below it, or any segment equal to a name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DenyEntry {
    /// `{ path }`.
    Path(String),
    /// `{ name }`.
    Name(String),
}

impl DenyEntry {
    /// The entry of a `{ path }` or `{ name }` object.
    pub fn of(v: &Value) -> Option<DenyEntry> {
        if let Some(n) = v.get("name").and_then(Value::as_str) {
            return Some(DenyEntry::Name(n.to_owned()));
        }
        v.get("path")
            .and_then(Value::as_str)
            .map(|p| DenyEntry::Path(p.to_owned()))
    }

    /// The TypeScript object.
    pub fn json(&self) -> Value {
        match self {
            DenyEntry::Path(p) => json!({ "path": p }),
            DenyEntry::Name(n) => json!({ "name": n }),
        }
    }
}

/// The answer of [`match_deny`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DenyMatch {
    /// The first entry that matches.
    Hit(usize),
    /// No entry matches.
    Miss,
    /// Entry `n` could not be decided (the fold declined); callers treat it as a hit (fail closed).
    Unknown(usize),
}

fn split_any(p: &str) -> impl Iterator<Item = &str> {
    p.split(['\\', '/']).filter(|s| !s.is_empty())
}

/// `matchDeny`: the first deny entry matching `p` (case- and NFC-folded, segment-aligned).
pub fn match_deny(p: &str, deny: &[DenyEntry], nfc: &dyn Nfc) -> DenyMatch {
    let segs: Option<Vec<String>> = split_any(p).map(|s| fold_for_deny(s, nfc)).collect();
    for (i, e) in deny.iter().enumerate() {
        let Some(segs) = segs.as_ref() else {
            return DenyMatch::Unknown(i);
        };
        match e {
            DenyEntry::Name(name) => match fold_for_deny(name, nfc) {
                None => return DenyMatch::Unknown(i),
                Some(n) if segs.contains(&n) => return DenyMatch::Hit(i),
                Some(_) => {}
            },
            DenyEntry::Path(path) => {
                let Some(want) = split_any(path)
                    .map(|s| fold_for_deny(s, nfc))
                    .collect::<Option<Vec<_>>>()
                else {
                    return DenyMatch::Unknown(i);
                };
                if !want.is_empty()
                    && want.len() <= segs.len()
                    && want.iter().zip(segs).all(|(w, s)| w == s)
                {
                    return DenyMatch::Hit(i);
                }
            }
        }
    }
    DenyMatch::Miss
}

fn absolute_spelling(p: &str) -> bool {
    let b = p.as_bytes();
    p.starts_with('/')
        || p.starts_with("\\\\")
        || (b.len() >= 3
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && (b[2] == b'\\' || b[2] == b'/'))
}

/// `invalidDenyEntry`. RULING (TypeScript): an entry that can never match is refused up front instead of being skipped.
/// `None` for an absent list.
pub fn invalid_deny_entry(deny: Option<&Value>) -> Option<String> {
    let deny = deny?;
    let Some(list) = deny.as_array() else {
        return Some("the deny-list is not an array".to_owned());
    };
    for (i, e) in list.iter().enumerate() {
        let at = format!("#{i}");
        let Some(rec) = e.as_object() else {
            return Some(format!("{at} is not an object"));
        };
        let (has_name, has_path) = (rec.contains_key("name"), rec.contains_key("path"));
        if has_name == has_path {
            return Some(format!("{at} must have exactly one of name or path"));
        }
        if has_name {
            let ok = rec["name"].as_str().is_some_and(|n| {
                !n.is_empty() && n != "." && n != ".." && !n.contains(['\\', '/', '\0'])
            });
            if !ok {
                return Some(format!("{at} has a name that cannot equal a path segment"));
            }
        } else {
            let Some(q) = rec["path"]
                .as_str()
                .filter(|q| !q.contains('\0') && absolute_spelling(q))
            else {
                return Some(format!("{at} has a path that is not absolute"));
            };
            if q.split(['\\', '/']).any(|s| s == "." || s == "..") {
                return Some(format!("{at} has a path with a '.' or '..' segment (it can never match a canonical path)"));
            }
        }
    }
    None
}

/// `containsExact`: allow-side containment, exact string comparison, whole segments only.
pub fn contains_exact(root: &str, p: &str, sep: &str) -> bool {
    if p == root {
        return true;
    }
    if root.ends_with(sep) {
        p.starts_with(root)
    } else {
        p.starts_with(&format!("{root}{sep}"))
    }
}

const POSIX_SYSTEM: [&str; 13] = [
    "/etc",
    "/usr",
    "/System",
    "/Library",
    "/bin",
    "/sbin",
    "/boot",
    "/proc",
    "/sys",
    "/dev",
    "/private/etc",
    "/private/var/db",
    "/private/var/root",
];
const WIN_SYSTEM: [&str; 4] = [
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "C:\\ProgramData",
];
const POSIX_HOMES_PARENT: [&str; 2] = ["/Users", "/home"];
const WIN_HOMES_PARENT: [&str; 1] = ["C:\\Users"];

fn is_sep(c: u8, windows: bool) -> bool {
    c == b'/' || (windows && c == b'\\')
}

/// `path.win32.parse(p).root` / `path.posix.parse(p).root`.
fn parse_root(p: &str, windows: bool) -> &str {
    let b = p.as_bytes();
    if !windows {
        return if p.starts_with('/') { "/" } else { "" };
    }
    let len = b.len();
    if len == 0 {
        return "";
    }
    if len == 1 {
        return if is_sep(b[0], true) { p } else { "" };
    }
    let mut root_end = 0;
    if is_sep(b[0], true) {
        root_end = 1;
        if is_sep(b[1], true) {
            let mut j = 2;
            let mut last = j;
            while j < len && !is_sep(b[j], true) {
                j += 1;
            }
            if j < len && j != last {
                last = j;
                while j < len && is_sep(b[j], true) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && !is_sep(b[j], true) {
                        j += 1;
                    }
                    if j == len {
                        root_end = j;
                    } else if j != last {
                        root_end = j + 1;
                    }
                }
            }
        }
    } else if b[0].is_ascii_alphabetic() && b[1] == b':' {
        if len <= 2 {
            return p;
        }
        root_end = 2;
        if is_sep(b[2], true) {
            if len == 3 {
                return p;
            }
            root_end = 3;
        }
    }
    &p[..root_end]
}

/// `path.resolve(home)` for an absolute home (POSIX `/…`; Windows `X:\…` or UNC). `None` for any other spelling, whose
/// resolution would depend on the current directory; the caller then fails closed.
fn resolve_absolute(home: &str, windows: bool) -> Option<String> {
    let mut out: Vec<&str> = Vec::new();
    let (prefix, rest) = if windows {
        let b = home.as_bytes();
        if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && is_sep(b[2], true) {
            (format!("{}\\", &home[..2]), &home[3..])
        } else if home.starts_with("\\\\") || home.starts_with("//") {
            let root = parse_root(home, true);
            if root.len() <= 2 {
                return None;
            }
            let device = root.trim_end_matches(['\\', '/']).replace('/', "\\");
            (format!("{device}\\"), &home[root.len()..])
        } else {
            return None;
        }
    } else if let Some(rest) = home.strip_prefix('/') {
        ("/".to_owned(), rest)
    } else {
        return None;
    };
    for seg in rest.split(|c: char| c == '/' || (windows && c == '\\')) {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    let sep = if windows { "\\" } else { "/" };
    Some(format!("{prefix}{}", out.join(sep)))
}

/// `isForbiddenRoot`: a home, a drive root, `/`, `/Users`, `C:\Users` and the system trees are never roots.
pub fn is_forbidden_root(real: &str, windows: bool, home: &str) -> bool {
    if parse_root(real, windows) == real {
        return true;
    }
    let eq = |a: &str, b: &str| {
        if windows {
            js::to_lower_case(a) == js::to_lower_case(b)
        } else {
            a == b
        }
    };
    if !home.is_empty() {
        match resolve_absolute(home, windows) {
            None => return true, // a home this port cannot resolve: fail closed
            Some(h) if eq(real, &h) => return true,
            Some(_) => {}
        }
    }
    let sep = if windows { "\\" } else { "/" };
    let fixed: Vec<&str> = if windows {
        WIN_HOMES_PARENT
            .iter()
            .chain(&WIN_SYSTEM)
            .copied()
            .collect()
    } else {
        POSIX_HOMES_PARENT
            .iter()
            .chain(&POSIX_SYSTEM)
            .copied()
            .collect()
    };
    for f in fixed {
        let (a, b) = if windows {
            (js::to_lower_case(real), js::to_lower_case(f))
        } else {
            (real.to_owned(), f.to_owned())
        };
        let parent = matches!(f, "/Users" | "/home" | "C:\\Users");
        if a == b || (!parent && a.starts_with(&format!("{b}{sep}"))) {
            return true;
        }
    }
    false
}

/// Case-, NFC- and separator-folded segments; `None` where a fold declines.
fn fold_segments(p: &str, windows: bool, nfc: &dyn Nfc) -> Option<Vec<String>> {
    let parts: Vec<&str> = if windows {
        p.split(['\\', '/']).collect()
    } else {
        p.split('/').collect()
    };
    parts
        .into_iter()
        .filter(|s| !s.is_empty())
        .map(|s| fold_for_deny(s, nfc))
        .collect()
}

fn starts_with_segs(a: &[String], prefix: &[String]) -> bool {
    prefix.len() <= a.len() && prefix.iter().zip(a).all(|(x, y)| x == y)
}

/// The options of the system-tree rules: the spelling and the home directories (the home and, when it is a link, its real
/// path). There is no default: the caller passes the homes it has.
#[derive(Clone, Copy, Debug)]
pub struct TreeOptions<'a> {
    /// Windows spelling (separators `\` and `/`, drive letters, case-insensitive).
    pub windows: bool,
    /// The home directories.
    pub homes: &'a [String],
}

/// The folded homes; `None` where one cannot be folded (fail closed).
fn home_segments(o: TreeOptions<'_>, nfc: &dyn Nfc) -> Option<Vec<Vec<String>>> {
    let mut out = Vec::new();
    for h in o.homes.iter().filter(|h| !h.is_empty()) {
        let segs = fold_segments(h, o.windows, nfc)?;
        if !segs.is_empty() {
            out.push(segs);
        }
    }
    Some(out)
}

fn folded_list(list: &[&str], windows: bool, nfc: &dyn Nfc) -> Vec<Vec<String>> {
    // The fixed lists are ASCII, which every fold answers.
    list.iter()
        .filter_map(|f| fold_segments(f, windows, nfc))
        .collect()
}

/// `isSystemTreePath`: is `p` a home, a drive root, `/`, `/Users`, `/home`, `C:\Users`, or in a system tree? Compared case-
/// and NFC-folded, so it can only classify more as a system tree, never less; a path or home the fold declines counts as a
/// system tree.
pub fn is_system_tree_path(p: &str, o: TreeOptions<'_>, nfc: &dyn Nfc) -> bool {
    let Some(segs) = fold_segments(p, o.windows, nfc) else {
        return true;
    };
    if segs.is_empty() {
        return true; // `/`, or nothing readable: fail closed
    }
    let b = p.as_bytes();
    let unc = o.windows && p.starts_with("\\\\");
    let drive = b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
    if o.windows && (unc || drive) && segs.len() <= if unc { 2 } else { 1 } {
        return true;
    }
    let Some(homes) = home_segments(o, nfc) else {
        return true;
    };
    if homes.contains(&segs) {
        return true;
    }
    let parents: &[&str] = if o.windows {
        &WIN_HOMES_PARENT
    } else {
        &POSIX_HOMES_PARENT
    };
    if folded_list(parents, o.windows, nfc).contains(&segs) {
        return true;
    }
    let system: &[&str] = if o.windows {
        &WIN_SYSTEM
    } else {
        &POSIX_SYSTEM
    };
    folded_list(system, o.windows, nfc)
        .iter()
        .any(|f| starts_with_segs(&segs, f))
}

/// `grantReachesSystemTree`: a path grant reaches a system tree when its path is one, when it contains a home, or (when
/// recursive) when it contains a system tree or the container of the homes.
pub fn grant_reaches_system_tree(
    grant_path: &str,
    recursive: bool,
    o: TreeOptions<'_>,
    nfc: &dyn Nfc,
) -> bool {
    if is_system_tree_path(grant_path, o, nfc) {
        return true;
    }
    let Some(g) = fold_segments(grant_path, o.windows, nfc) else {
        return true;
    };
    let Some(homes) = home_segments(o, nfc) else {
        return true;
    };
    if homes.iter().any(|h| starts_with_segs(h, &g)) {
        return true;
    }
    if !recursive {
        return false;
    }
    let all: Vec<&str> = if o.windows {
        WIN_HOMES_PARENT
            .iter()
            .chain(&WIN_SYSTEM)
            .copied()
            .collect()
    } else {
        POSIX_HOMES_PARENT
            .iter()
            .chain(&POSIX_SYSTEM)
            .copied()
            .collect()
    };
    folded_list(&all, o.windows, nfc)
        .iter()
        .any(|f| starts_with_segs(f, &g))
}
