//! `files.ts`: discovery and opening of the protected log files under `<home>/logs/` (D111 §2.1): `<role>.log` and its
//! rotated copies `<role>.log.<n>` (`.1` newest, the S17 rotation of module-api's logger) for the diagnostic stream,
//! `audit.log` (+ rotated copies) for the audit stream. `payload.log` is opt-in capture (§2.5) and is never read here.
use std::cmp::Ordering;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

/// Which stream a listing is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stream {
    /// `<role>.log` of every role but `audit` and `payload`.
    Diagnostic,
    /// `audit.log`.
    Audit,
}

/// A log file by name: its path, the role (`component`) and the rotation generation (0 = the live file).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogFileRef {
    /// The file's path.
    pub path: PathBuf,
    /// The role: the name before `.log`.
    pub component: String,
    /// 0 for `<role>.log`, `n` for `<role>.log.<n>`.
    pub generation: u64,
}

/// An open log file with the size it had when it was opened.
#[derive(Debug)]
pub struct OpenLogFile {
    /// The file's reference.
    pub file_ref: LogFileRef,
    /// The descriptor (read-only); closed when dropped.
    pub file: File,
    /// Its size at open time.
    pub size: u64,
}

/// `^([A-Za-z0-9][A-Za-z0-9._-]*)\.log(?:\.([0-9]+))?$`: the component and the generation, if `name` matches.
fn parse_name(name: &str) -> Option<(&str, u64)> {
    let valid_component = |c: &str| {
        let mut chars = c.chars();
        chars.next().is_some_and(|f| f.is_ascii_alphanumeric())
            && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    };
    // The component is greedy: try the longest `.log` suffix split first, as the regexp does.
    let mut candidates: Vec<(&str, u64)> = Vec::new();
    for (at, _) in name.match_indices(".log") {
        let (component, rest) = (&name[..at], &name[at + 4..]);
        if !valid_component(component) {
            continue;
        }
        if rest.is_empty() {
            candidates.push((component, 0));
        } else if let Some(digits) = rest.strip_prefix('.') {
            if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
                candidates.push((component, digits.parse().unwrap_or(u64::MAX)));
            }
        }
    }
    candidates.pop()
}

/// The primary collation key of `localeCompare` for the characters a component can hold: punctuation, then digits, then
/// letters, case ignored. A tie is broken by case (lower case first), then by code unit. This is the order ICU gives
/// ASCII names; the vectors `fixtures/parity/logs/files.json` pin it against the TypeScript listing.
fn collation_key(c: char) -> (u8, char) {
    match c {
        '_' => (0, '_'),
        '-' => (1, '-'),
        '.' => (2, '.'),
        '0'..='9' => (3, c),
        _ => (4, c.to_ascii_lowercase()),
    }
}

/// `a.localeCompare(b)` for component names.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let primary = a
        .chars()
        .map(collation_key)
        .cmp(b.chars().map(collation_key));
    primary.then_with(|| {
        // lower case before upper case at the first difference
        for (x, y) in a.chars().zip(b.chars()) {
            if x != y {
                return match (x.is_ascii_lowercase(), y.is_ascii_lowercase()) {
                    (true, false) => Ordering::Less,
                    (false, true) => Ordering::Greater,
                    _ => x.cmp(&y),
                };
            }
        }
        a.cmp(b)
    })
}

/// `listLogFiles(dir, stream)`: the files of the stream, by component, then oldest rotation first (higher generation
/// first, the live file last). An unreadable directory lists nothing.
pub fn list_log_files(dir: &Path, stream: Stream) -> Vec<LogFileRef> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some((component, generation)) = parse_name(name) else {
            continue;
        };
        if component == "payload" || (component == "audit") != (stream == Stream::Audit) {
            continue;
        }
        out.push(LogFileRef {
            path: dir.join(name),
            component: component.to_string(),
            generation,
        });
    }
    out.sort_by(|a, b| {
        locale_compare(&a.component, &b.component).then_with(|| b.generation.cmp(&a.generation))
    });
    out
}

type Identity = (u64, u64);

#[cfg(unix)]
fn regular_identity(meta: &fs::Metadata) -> Option<Identity> {
    use std::os::unix::fs::MetadataExt;
    meta.is_file().then(|| (meta.dev(), meta.ino()))
}

#[cfg(windows)]
fn regular_identity(info: crate::policy::fs_windows::Info) -> Option<Identity> {
    (info.disk && !info.directory && !info.reparse && info.index != 0)
        .then_some((info.volume, info.index))
}

fn file_identity(file: &File) -> io::Result<Option<Identity>> {
    #[cfg(unix)]
    return file.metadata().map(|meta| regular_identity(&meta));
    #[cfg(windows)]
    return crate::policy::fs_windows::info(file).map(regular_identity);
}

fn named_identity(path: &Path) -> Option<Identity> {
    #[cfg(unix)]
    return fs::symlink_metadata(path)
        .ok()
        .as_ref()
        .and_then(regular_identity);
    #[cfg(windows)]
    return crate::policy::fs_windows::lstat(path)
        .ok()
        .and_then(regular_identity);
}

fn open_regular_candidate(path: &Path) -> io::Result<File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
    }
    #[cfg(windows)]
    {
        use crate::policy::fs_windows::{open_leaf, LeafOpen};
        open_leaf(
            path,
            LeafOpen {
                read: true,
                write: false,
                append: false,
                create_new: false,
            },
        )
    }
}

/// Options of [`open_log_files`].
#[derive(Default)]
pub struct OpenOptions<'a> {
    /// How often a changed set is re-opened; default 3.
    pub retries: Option<u32>,
    /// Called after each listing (a test seam for a rotation in the middle of an open).
    pub on_listed: Option<&'a dyn Fn()>,
}

/// Opens every file of the stream and keeps the descriptors, so a rotation during the scan (a rename never changes what an
/// open descriptor reads) cannot make one file be read twice or skipped. The set is verified after opening: when a name
/// now points at another file, or the set of names changed, the open is retried at most `retries` times. If the set
/// continues to change, the query must retry instead of reading an unverified snapshot. Only regular files are opened.
pub fn open_log_files(
    dir: &Path,
    stream: Stream,
    options: &OpenOptions<'_>,
) -> io::Result<Vec<OpenLogFile>> {
    let retries = options.retries.unwrap_or(3);
    let mut attempt = 0;
    loop {
        let refs = list_log_files(dir, stream);
        if let Some(on_listed) = options.on_listed {
            on_listed();
        }
        let mut opened = Vec::new();
        let mut changed = false;
        for file_ref in &refs {
            let Some(named) = named_identity(&file_ref.path) else {
                continue;
            };
            let Ok(file) = open_regular_candidate(&file_ref.path) else {
                changed |= named_identity(&file_ref.path) != Some(named);
                continue;
            };
            if file_identity(&file)? != Some(named) {
                changed = true;
                continue;
            }
            let size = file.metadata()?.len();
            opened.push((
                OpenLogFile {
                    file_ref: file_ref.clone(),
                    file,
                    size,
                },
                named,
            ));
        }
        let names_now: Vec<PathBuf> = list_log_files(dir, stream)
            .into_iter()
            .map(|r| r.path)
            .collect();
        let names_then: Vec<PathBuf> = refs.iter().map(|r| r.path.clone()).collect();
        let stable = !changed
            && names_now == names_then
            && opened
                .iter()
                .all(|(f, id)| named_identity(&f.file_ref.path) == Some(*id));
        if stable {
            return Ok(opened.into_iter().map(|(f, _)| f).collect());
        }
        if attempt >= retries {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "log rotation in progress",
            ));
        }
        attempt += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &Path, names: &[&str]) {
        for n in names {
            fs::write(dir.join(n), "").unwrap();
        }
    }

    fn listed(dir: &Path, stream: Stream) -> Vec<String> {
        list_log_files(dir, stream)
            .into_iter()
            .map(|r| r.path.file_name().unwrap().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn names_are_parsed_like_the_regexp() {
        assert_eq!(parse_name("core.log"), Some(("core", 0)));
        assert_eq!(parse_name("core.log.12"), Some(("core", 12)));
        assert_eq!(parse_name("a.b-c_d.log.3"), Some(("a.b-c_d", 3)));
        assert_eq!(parse_name("core.log.log"), Some(("core.log", 0)));
        assert_eq!(parse_name("x.log.log.4"), Some(("x.log", 4)));
        for no in [
            "core.log.",
            "core.log.x",
            "core.log.1a",
            ".log",
            "_x.log",
            "core.logx",
            "core",
            "core.log.1.bak",
            "-a.log",
            "",
        ] {
            assert_eq!(parse_name(no), None, "{no}");
        }
    }

    /// Order, stream split and the exclusion of `payload`.
    #[test]
    fn lists_the_stream_oldest_rotation_first_and_never_payload() {
        let d = tempfile::tempdir().unwrap();
        touch(
            d.path(),
            &[
                "core.log",
                "core.log.1",
                "core.log.2",
                "core.log.10",
                "audit.log",
                "audit.log.1",
                "payload.log",
                "payload.log.1",
                "agent.log",
                "notes.txt",
                "core.log.x",
                "mcp-b.log",
                "mcp_a.log",
                "mcp.a.log",
            ],
        );
        assert_eq!(
            listed(d.path(), Stream::Diagnostic),
            [
                "agent.log",
                "core.log.10",
                "core.log.2",
                "core.log.1",
                "core.log",
                "mcp_a.log",
                "mcp-b.log",
                "mcp.a.log"
            ]
        );
        assert_eq!(
            listed(d.path(), Stream::Audit),
            ["audit.log.1", "audit.log"]
        );
        assert!(list_log_files(&d.path().join("missing"), Stream::Diagnostic).is_empty());
    }

    #[test]
    fn opens_files_with_their_sizes_and_skips_symlinks_and_directories() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("core.log"), "12345").unwrap();
        fs::write(d.path().join("core.log.1"), "ab").unwrap();
        fs::create_dir(d.path().join("dir.log")).unwrap();
        #[cfg(unix)]
        {
            let target = d.path().join("target");
            fs::write(&target, "secret").unwrap();
            std::os::unix::fs::symlink(&target, d.path().join("link.log")).unwrap();
        }
        let files = open_log_files(d.path(), Stream::Diagnostic, &OpenOptions::default()).unwrap();
        let got: Vec<(String, u64)> = files
            .iter()
            .map(|f| {
                (
                    f.file_ref
                        .path
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    f.size,
                )
            })
            .collect();
        assert_eq!(
            got,
            [("core.log.1".to_string(), 2), ("core.log".to_string(), 5)]
        );
    }

    #[test]
    fn an_unstable_rotation_at_the_retry_limit_refuses_the_snapshot() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("core.log"), "previous").unwrap();
        let attempt = std::cell::Cell::new(0);
        let rotate_after_listing = || {
            let next = attempt.get() + 1;
            attempt.set(next);
            fs::rename(
                d.path().join("core.log"),
                d.path().join(format!("core.log.{next}")),
            )
            .unwrap();
            fs::write(d.path().join("core.log"), "current").unwrap();
        };
        let result = open_log_files(
            d.path(),
            Stream::Diagnostic,
            &OpenOptions {
                retries: Some(1),
                on_listed: Some(&rotate_after_listing),
            },
        );
        assert_eq!(attempt.get(), 2);
        assert!(matches!(result, Err(error) if error.kind() == io::ErrorKind::WouldBlock));
    }

    /// A rotation between the listing and the open: the set is verified and re-opened, so no file is read twice or skipped.
    #[test]
    fn a_rotation_during_the_open_is_retried() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("core.log"), "new\n").unwrap();
        fs::write(d.path().join("core.log.1"), "old\n").unwrap();
        let rotated = std::cell::Cell::new(false);
        let dir = d.path().to_path_buf();
        let on_listed = || {
            if !rotated.replace(true) {
                fs::rename(dir.join("core.log.1"), dir.join("core.log.2")).unwrap();
                fs::rename(dir.join("core.log"), dir.join("core.log.1")).unwrap();
                fs::write(dir.join("core.log"), "").unwrap();
            }
        };
        let files = open_log_files(
            d.path(),
            Stream::Diagnostic,
            &OpenOptions {
                retries: Some(3),
                on_listed: Some(&on_listed),
            },
        )
        .unwrap();
        let sizes: Vec<(u64, u64)> = files
            .iter()
            .map(|f| (f.file_ref.generation, f.size))
            .collect();
        assert_eq!(sizes, [(2, 4), (1, 4), (0, 0)]);
    }
}
