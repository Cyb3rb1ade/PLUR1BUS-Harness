//! The one verified extractor (⟂EXT 1): every package that comes from outside the binary (the Node archive, a core
//! payload, a module package, a skill bundle) goes through [`verify_and_extract`]. `.tar.gz` (flate2 + tar) and
//! `.zip` (zip) are recognised by their magic bytes.
//!
//! Refused with `archive-unsafe-entry`: absolute names, `..` components, drive or stream prefixes (any component
//! with a `:`), hard links, device, FIFO and socket entries, a symlink whose target leaves the tree or passes through
//! another symlink, and any entry beneath a symlink. A relative symlink that stays inside is kept (Node's tarballs
//! have `bin/npm` → `../lib/node_modules/npm/bin/npm-cli.js`). Symlinks are created last, after every regular file
//! and directory, so no write ever goes through one.
//!
//! `into` must not exist. Extraction writes to `<into>.tmp-<pid>` and renames it onto `into`; on any error that
//! directory is removed, so a refused or broken archive leaves nothing. The extracted total is capped at 2 GiB
//! (`download-too-large`).
//!
//! This file uses nothing from the rest of the crate (`tests/install_archive.rs` includes it by path).
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};

/// The cap on the total extracted size.
pub const MAX_EXTRACTED_BYTES: u64 = 2 << 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArchiveError {
    /// An entry that could write outside `into`, or a kind of entry that is never installed.
    UnsafeEntry(String),
    /// Not a `.tar.gz` or `.zip`, a corrupt archive, or an entry kind this platform cannot create.
    Unsupported(String),
    /// The extracted total exceeds [`MAX_EXTRACTED_BYTES`].
    TooLarge { limit: u64 },
    /// Writing the extracted tree failed.
    Io(String),
}

impl ArchiveError {
    /// The frozen refusal vocabulary (⟂EXT 2): extend, never rename.
    pub fn reason(&self) -> &'static str {
        match self {
            ArchiveError::UnsafeEntry(_) => "archive-unsafe-entry",
            ArchiveError::Unsupported(_) => "archive-unsupported",
            ArchiveError::TooLarge { .. } => "download-too-large",
            ArchiveError::Io(_) => "io",
        }
    }
}

impl std::fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ArchiveError::UnsafeEntry(d) => write!(f, "unsafe archive entry: {d}"),
            ArchiveError::Unsupported(d) => write!(f, "unsupported archive: {d}"),
            ArchiveError::TooLarge { limit } => {
                write!(f, "the archive extracts to more than {limit} bytes")
            }
            ArchiveError::Io(d) => f.write_str(d),
        }
    }
}

/// [`verify_and_extract`]'s error: the digest check, or the extraction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PayloadError {
    DigestMismatch { expected: String, actual: String },
    Archive(ArchiveError),
    Io(String),
}

impl PayloadError {
    pub fn reason(&self) -> &'static str {
        match self {
            PayloadError::DigestMismatch { .. } => "digest-mismatch",
            PayloadError::Archive(e) => e.reason(),
            PayloadError::Io(_) => "io",
        }
    }
}

impl std::fmt::Display for PayloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PayloadError::DigestMismatch { expected, actual } => {
                write!(f, "SHA-256 mismatch: expected {expected}, got {actual}")
            }
            PayloadError::Archive(e) => e.fmt(f),
            PayloadError::Io(d) => f.write_str(d),
        }
    }
}

/// Lower-case hex SHA-256 of a file.
pub fn sha256_file(p: &Path) -> io::Result<String> {
    let mut f = fs::File::open(p)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match f.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buf[..n]),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Checks that `archive` has the SHA-256 `sha256` before a single entry is read, then [`extract`]s it.
pub fn verify_and_extract(
    archive: &Path,
    sha256: &str,
    into: &Path,
    strip: usize,
) -> Result<(), PayloadError> {
    let expected = sha256.trim().to_ascii_lowercase();
    let actual = sha256_file(archive)
        .map_err(|e| PayloadError::Io(format!("{}: {e}", archive.display())))?;
    if actual != expected {
        return Err(PayloadError::DigestMismatch { expected, actual });
    }
    extract(archive, into, strip).map_err(PayloadError::Archive)
}

/// Extracts `archive` into the new directory `into`, dropping the first `strip_components` path components of every
/// entry (an entry with no more components than that is skipped, like `tar --strip-components`).
pub fn extract(archive: &Path, into: &Path, strip_components: usize) -> Result<(), ArchiveError> {
    extract_capped(archive, into, strip_components, MAX_EXTRACTED_BYTES)
}

enum Kind {
    TarGz,
    Zip,
}

fn sniff(archive: &Path) -> Result<Kind, ArchiveError> {
    let mut f = fs::File::open(archive)
        .map_err(|e| ArchiveError::Io(format!("{}: {e}", archive.display())))?;
    let mut magic = [0u8; 4];
    let mut got = 0;
    while got < magic.len() {
        match f.read(&mut magic[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(ArchiveError::Io(format!("{}: {e}", archive.display()))),
        }
    }
    match &magic[..got] {
        [0x1f, 0x8b, ..] => Ok(Kind::TarGz),
        [b'P', b'K', 3, 4] | [b'P', b'K', 5, 6] => Ok(Kind::Zip),
        _ => Err(ArchiveError::Unsupported(format!(
            "{} is neither a .tar.gz nor a .zip",
            archive.display()
        ))),
    }
}

fn temp_of(into: &Path) -> PathBuf {
    let mut name = into.as_os_str().to_owned();
    name.push(format!(".tmp-{}", std::process::id()));
    PathBuf::from(name)
}

pub(crate) fn extract_capped(
    archive: &Path,
    into: &Path,
    strip: usize,
    limit: u64,
) -> Result<(), ArchiveError> {
    if fs::symlink_metadata(into).is_ok() {
        return Err(ArchiveError::Io(format!(
            "{} already exists",
            into.display()
        )));
    }
    let kind = sniff(archive)?;
    let staging = temp_of(into);
    let io_err = |p: &Path, e: io::Error| ArchiveError::Io(format!("{}: {e}", p.display()));
    if fs::symlink_metadata(&staging).is_ok() {
        fs::remove_dir_all(&staging).map_err(|e| io_err(&staging, e))?;
    }
    if let Some(parent) = into.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|e| io_err(parent, e))?;
    }
    fs::create_dir(&staging).map_err(|e| io_err(&staging, e))?;
    let mut x = Extractor {
        root: staging.clone(),
        strip,
        limit,
        total: 0,
        links: Vec::new(),
        link_set: HashSet::new(),
    };
    let result = match kind {
        Kind::TarGz => x.tar_gz(archive),
        Kind::Zip => x.zip(archive),
    }
    .and_then(|()| x.finish_links())
    .and_then(|()| fs::rename(&staging, into).map_err(|e| io_err(into, e)));
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

/// The normal components of an entry name. Refuses absolute names, `..`, any component with a `:` (a drive prefix
/// or an NTFS stream), NUL and names that are not UTF-8. `/` and `\` both separate.
fn entry_components(raw: &[u8]) -> Result<Vec<String>, ArchiveError> {
    let shown = String::from_utf8_lossy(raw).into_owned();
    let unsafe_entry = |why: &str| Err(ArchiveError::UnsafeEntry(format!("{shown:?}: {why}")));
    let Ok(name) = std::str::from_utf8(raw) else {
        return unsafe_entry("the name is not UTF-8");
    };
    if name.contains('\0') {
        return unsafe_entry("NUL in the name");
    }
    if name.starts_with('/') || name.starts_with('\\') {
        return unsafe_entry("absolute path");
    }
    let mut out = Vec::new();
    for c in name.split(['/', '\\']) {
        match c {
            "" | "." => {}
            ".." => return unsafe_entry("parent-directory component"),
            c if c.contains(':') => return unsafe_entry("drive or stream prefix"),
            c => out.push(c.to_string()),
        }
    }
    Ok(out)
}

/// Whether a symlink at `link` (components inside the tree) pointing at `target` resolves inside the tree without
/// passing through another symlink of the archive (`links`). A final component that is itself a symlink is fine:
/// that link is checked on its own.
fn link_stays_inside(link: &[String], target: &str, links: &HashSet<Vec<String>>) -> bool {
    if target.is_empty()
        || target.starts_with('/')
        || target.starts_with('\\')
        || target.contains(':')
        || target.contains('\0')
    {
        return false;
    }
    let mut stack: Vec<String> = link[..link.len().saturating_sub(1)].to_vec();
    let comps: Vec<&str> = target
        .split(['/', '\\'])
        .filter(|c| !c.is_empty() && *c != ".")
        .collect();
    for (i, c) in comps.iter().enumerate() {
        if *c == ".." {
            if stack.pop().is_none() {
                return false;
            }
            continue;
        }
        stack.push((*c).to_string());
        if i + 1 < comps.len() && links.contains(&stack) {
            return false;
        }
    }
    true
}

struct Extractor {
    root: PathBuf,
    strip: usize,
    limit: u64,
    total: u64,
    /// `(components, target)` of every symlink entry, created by [`Extractor::finish_links`].
    links: Vec<(Vec<String>, String)>,
    link_set: HashSet<Vec<String>>,
}

impl Extractor {
    /// The stripped components, or `None` for an entry that the strip removes entirely.
    fn place(&self, raw: &[u8]) -> Result<Option<Vec<String>>, ArchiveError> {
        let comps = entry_components(raw)?;
        if comps.len() <= self.strip {
            return Ok(None);
        }
        let comps = comps[self.strip..].to_vec();
        // Nothing is ever written at or beneath a symlink of the archive.
        for n in 1..=comps.len() {
            if self.link_set.contains(&comps[..n]) {
                return Err(ArchiveError::UnsafeEntry(format!(
                    "{:?}: at or beneath the symlink {:?}",
                    String::from_utf8_lossy(raw),
                    comps[..n].join("/")
                )));
            }
        }
        Ok(Some(comps))
    }

    fn path_of(&self, comps: &[String]) -> PathBuf {
        let mut p = self.root.clone();
        for c in comps {
            p.push(c);
        }
        p
    }

    fn dir(&self, comps: &[String]) -> Result<(), ArchiveError> {
        let p = self.path_of(comps);
        fs::create_dir_all(&p).map_err(|e| ArchiveError::Io(format!("{}: {e}", p.display())))
    }

    fn file(
        &mut self,
        comps: &[String],
        announced: u64,
        executable: bool,
        data: &mut dyn Read,
    ) -> Result<(), ArchiveError> {
        if self.total.saturating_add(announced) > self.limit {
            return Err(ArchiveError::TooLarge { limit: self.limit });
        }
        let p = self.path_of(comps);
        let io_err = |e: io::Error| ArchiveError::Io(format!("{}: {e}", p.display()));
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(io_err)?;
        }
        let mut f = fs::File::create(&p).map_err(io_err)?;
        let budget = self.limit - self.total;
        let mut buf = vec![0u8; 64 * 1024];
        let mut written: u64 = 0;
        loop {
            let n = match data.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(ArchiveError::Unsupported(format!("reading an entry: {e}"))),
            };
            written += n as u64;
            if written > budget {
                return Err(ArchiveError::TooLarge { limit: self.limit });
            }
            f.write_all(&buf[..n]).map_err(io_err)?;
        }
        self.total += written;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if executable { 0o755 } else { 0o644 };
            f.set_permissions(fs::Permissions::from_mode(mode))
                .map_err(io_err)?;
        }
        #[cfg(not(unix))]
        let _ = executable;
        Ok(())
    }

    fn link(&mut self, comps: Vec<String>, target: String) {
        self.link_set.insert(comps.clone());
        self.links.push((comps, target));
    }

    /// Checks every symlink against the complete set, then creates them.
    fn finish_links(&mut self) -> Result<(), ArchiveError> {
        for (comps, target) in &self.links {
            if !link_stays_inside(comps, target, &self.link_set) {
                return Err(ArchiveError::UnsafeEntry(format!(
                    "{:?}: symlink to {target:?} leaves the archive",
                    comps.join("/")
                )));
            }
        }
        for (comps, _) in &self.links {
            if fs::symlink_metadata(self.path_of(comps)).is_ok() {
                return Err(ArchiveError::UnsafeEntry(format!(
                    "{:?}: a symlink over another entry",
                    comps.join("/")
                )));
            }
        }
        #[cfg(not(unix))]
        if let Some((comps, _)) = self.links.first() {
            return Err(ArchiveError::Unsupported(format!(
                "{:?}: symlink entries are not created on this platform",
                comps.join("/")
            )));
        }
        #[cfg(unix)]
        for (comps, target) in &self.links {
            let p = self.path_of(comps);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| ArchiveError::Io(format!("{}: {e}", parent.display())))?;
            }
            std::os::unix::fs::symlink(target, &p)
                .map_err(|e| ArchiveError::Io(format!("{}: {e}", p.display())))?;
        }
        Ok(())
    }

    fn tar_gz(&mut self, archive: &Path) -> Result<(), ArchiveError> {
        let bad = |e: io::Error| ArchiveError::Unsupported(format!("{}: {e}", archive.display()));
        let f = fs::File::open(archive)
            .map_err(|e| ArchiveError::Io(format!("{}: {e}", archive.display())))?;
        let mut ar = tar::Archive::new(flate2::read::GzDecoder::new(BufReader::new(f)));
        for entry in ar.entries().map_err(bad)? {
            let mut e = entry.map_err(bad)?;
            let raw = e.path_bytes().into_owned();
            let ty = e.header().entry_type();
            let shown = String::from_utf8_lossy(&raw).into_owned();
            match ty {
                tar::EntryType::Link => {
                    return Err(ArchiveError::UnsafeEntry(format!("{shown:?}: hard link")))
                }
                tar::EntryType::Char | tar::EntryType::Block | tar::EntryType::Fifo => {
                    return Err(ArchiveError::UnsafeEntry(format!(
                        "{shown:?}: device or FIFO entry"
                    )))
                }
                tar::EntryType::XGlobalHeader => continue,
                _ => {}
            }
            let Some(comps) = self.place(&raw)? else {
                continue;
            };
            match ty {
                tar::EntryType::Regular | tar::EntryType::Continuous => {
                    let size = e.size();
                    let exec = e.header().mode().map(|m| m & 0o111 != 0).unwrap_or(false);
                    self.file(&comps, size, exec, &mut e)?;
                }
                tar::EntryType::Directory => self.dir(&comps)?,
                tar::EntryType::Symlink => {
                    let target = e
                        .link_name_bytes()
                        .map(|b| String::from_utf8_lossy(&b).into_owned())
                        .unwrap_or_default();
                    self.link(comps, target);
                }
                other => {
                    return Err(ArchiveError::Unsupported(format!(
                        "{shown:?}: entry type {other:?}"
                    )))
                }
            }
        }
        Ok(())
    }

    fn zip(&mut self, archive: &Path) -> Result<(), ArchiveError> {
        let bad = |e: zip::result::ZipError| {
            ArchiveError::Unsupported(format!("{}: {e}", archive.display()))
        };
        let f = fs::File::open(archive)
            .map_err(|e| ArchiveError::Io(format!("{}: {e}", archive.display())))?;
        let mut z = zip::ZipArchive::new(BufReader::new(f)).map_err(bad)?;
        for i in 0..z.len() {
            let mut e = z.by_index(i).map_err(bad)?;
            let raw = e.name_raw().to_vec();
            let shown = String::from_utf8_lossy(&raw).into_owned();
            let mode = e.unix_mode().unwrap_or(0);
            let file_type = mode & 0o170000;
            if matches!(file_type, 0o020000 | 0o060000 | 0o010000 | 0o140000) {
                return Err(ArchiveError::UnsafeEntry(format!(
                    "{shown:?}: device, FIFO or socket entry"
                )));
            }
            let Some(comps) = self.place(&raw)? else {
                continue;
            };
            if file_type == 0o120000 {
                let mut target = String::new();
                (&mut e)
                    .take(4096)
                    .read_to_string(&mut target)
                    .map_err(|err| ArchiveError::Unsupported(format!("{shown:?}: {err}")))?;
                self.link(comps, target);
            } else if file_type == 0o040000 || shown.ends_with('/') || shown.ends_with('\\') {
                self.dir(&comps)?;
            } else {
                let size = e.size();
                self.file(&comps, size, mode & 0o111 != 0, &mut e)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|c| c.to_string()).collect()
    }

    #[test]
    fn entry_names_are_split_and_unsafe_ones_refused() {
        assert_eq!(entry_components(b"a/./b//c").unwrap(), s(&["a", "b", "c"]));
        assert_eq!(entry_components(b"a\\b").unwrap(), s(&["a", "b"]));
        for bad in [
            &b"/etc/passwd"[..],
            b"\\x",
            b"a/../../x",
            b"..",
            b"C:/x",
            b"C:x",
            b"a/file:stream",
            b"a\0b",
            b"\xff",
        ] {
            assert!(
                matches!(entry_components(bad), Err(ArchiveError::UnsafeEntry(_))),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn symlink_targets_must_stay_inside_and_not_pass_through_links() {
        let none = HashSet::new();
        assert!(link_stays_inside(
            &s(&["bin", "npm"]),
            "../lib/cli.js",
            &none
        ));
        assert!(link_stays_inside(&s(&["x"]), ".", &none));
        assert!(!link_stays_inside(&s(&["bin", "npm"]), "../../x", &none));
        assert!(!link_stays_inside(&s(&["x"]), "/etc", &none));
        assert!(!link_stays_inside(&s(&["x"]), "", &none));
        // `x -> .` then `y -> x/..`: lexically the root, really the parent of the tree.
        let mut links = HashSet::new();
        links.insert(s(&["x"]));
        assert!(!link_stays_inside(&s(&["y"]), "x/..", &links));
        assert!(link_stays_inside(&s(&["y"]), "x", &links));
    }
}
