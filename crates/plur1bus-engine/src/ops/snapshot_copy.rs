//! Internal payload copier. Host authority, publication and retention belong to the
//! snapshot facade (controller F9, `snapshot_create.rs`); this module never publishes or
//! deletes a snapshot.
use super::{safe_relative, SnapshotError};
use crate::{contract::Cancel, store::directory::TrustedDirectory};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
};

const TABLE_TRIES: usize = 3;
const TABLE_ORDER: [&str; 4] = ["data", "_indices", "_deletions", "_transactions"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct PayloadFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

/// Decimal comparison avoids a new bigint dependency, while retaining Node's
/// arbitrary-length v1 version names and inverted, exactly 20-digit v2 names.
fn manifest_version(name: &str) -> Option<String> {
    let digits = name.strip_suffix(".manifest")?;
    if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if digits.len() == 20 {
        let inverted = digits.parse::<u128>().ok()?;
        Some((u64::MAX as u128).checked_sub(inverted)?.to_string())
    } else {
        let value = digits.trim_start_matches('0');
        Some(if value.is_empty() { "0" } else { value }.to_owned())
    }
}

#[derive(PartialEq, Eq)]
struct Head {
    name: String,
    bytes: Vec<u8>,
}
#[allow(
    clippy::needless_pass_by_value,
    reason = "map_err consumes and discards backend text"
)]
fn io(e: std::io::Error) -> SnapshotError {
    if e.kind() == std::io::ErrorKind::NotFound {
        SnapshotError::NotFound
    } else {
        SnapshotError::Storage
    }
}
fn check(cancel: &Cancel) -> Result<(), SnapshotError> {
    cancel.check().map_err(|_| SnapshotError::Cancelled)
}
fn names(dir: &TrustedDirectory) -> Result<Vec<String>, SnapshotError> {
    dir.assert_unchanged()?;
    let mut names = Vec::new();
    for entry in fs::read_dir(dir.path()).map_err(io)? {
        let name = entry
            .map_err(io)?
            .file_name()
            .into_string()
            .map_err(|_| SnapshotError::UnsafePath)?;
        if !safe_relative(&name) {
            return Err(SnapshotError::UnsafePath);
        }
        names.push(name);
    }
    dir.assert_unchanged()?;
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Ok(names)
}
fn newest_manifest(dir: &TrustedDirectory, cancel: &Cancel) -> Result<Option<Head>, SnapshotError> {
    check(cancel)?;
    let versions = match dir.open_child("_versions") {
        Ok(v) => v,
        Err(e) => match SnapshotError::from(e) {
            SnapshotError::NotFound => return Ok(None),
            error => return Err(error),
        },
    };
    let mut best: Option<(String, String)> = None;
    for name in names(&versions)? {
        check(cancel)?;
        if let Some(version) = manifest_version(&name) {
            if best
                .as_ref()
                .is_none_or(|(_, old)| (version.len(), &version) > (old.len(), old))
            {
                best = Some((name, version));
            }
        }
    }
    let Some((name, _)) = best else {
        return Ok(None);
    };
    let mut file = versions.open_file(&name)?;
    let mut bytes = Vec::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        check(cancel)?;
        let n = file.read(&mut buffer).map_err(io)?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..n]);
    }
    versions.assert_unchanged()?;
    dir.assert_unchanged()?;
    Ok(Some(Head { name, bytes }))
}
fn ref_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"_-./".contains(&b)
}
/// Same bounded protobuf-string scan as Node, not a whole-manifest protobuf decoder.
fn manifest_references(bytes: &[u8]) -> Vec<String> {
    let mut refs = BTreeMap::new();
    for (ext, dir) in [
        (b".lance".as_slice(), "data"),
        (b".txn".as_slice(), "_transactions"),
    ] {
        for at in 0..bytes.len().saturating_sub(ext.len() - 1) {
            if &bytes[at..at + ext.len()] != ext {
                continue;
            }
            let end = at + ext.len();
            let mut found = None;
            for start in (1..at).rev() {
                if !ref_char(bytes[start]) {
                    break;
                }
                let len = end - start;
                let one = len < 128 && bytes[start - 1] as usize == len;
                let two = start >= 2
                    && len >= 128
                    && bytes[start - 2] & 0x80 != 0
                    && ((bytes[start - 2] as usize & 0x7f) | ((bytes[start - 1] as usize) << 7))
                        == len;
                if one || two {
                    found = Some(&bytes[start..end]);
                }
            }
            if let Some(found) = found {
                // Only ASCII REF_CHAR bytes occur here.
                let name = String::from_utf8_lossy(found);
                if !name.starts_with('/') && !name.split('/').any(|c| c == "..") {
                    refs.insert(format!("{dir}/{name}"), ());
                }
            }
        }
    }
    refs.into_keys().collect()
}
fn is_table(dir: &TrustedDirectory) -> Result<bool, SnapshotError> {
    match fs::symlink_metadata(dir.path().join("_versions")) {
        Ok(m) if m.file_type().is_symlink() => Err(SnapshotError::UnsafePath),
        Ok(m) => Ok(m.is_dir()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(io(e)),
    }
}
fn derived_cache(relative: &str) -> bool {
    let mut parts = relative.split('/');
    parts.next() == Some("store")
        && parts
            .next()
            .is_some_and(|s| s.eq_ignore_ascii_case("llm-result-cache-v1"))
}

#[cfg(test)]
type AfterCopy = Box<dyn FnMut(&str)>;

/// Owns only the file index, never the source or publication authority. The caller
/// supplies a newly created private staging directory and removes it on failure.
pub(crate) struct Copier<'a> {
    root: &'a TrustedDirectory,
    cancel: &'a Cancel,
    files: BTreeMap<String, PayloadFile>,
    progress: Option<super::snapshot_create::Progress<'a>>,
    #[cfg(test)]
    after_copy: Option<AfterCopy>,
}
impl<'a> Copier<'a> {
    /// Report each copied file (an authorized process test seam may hold here).
    pub(crate) fn set_progress(&mut self, progress: super::snapshot_create::Progress<'a>) {
        self.progress = Some(progress);
    }
    pub(crate) fn new(
        root: &'a TrustedDirectory,
        cancel: &'a Cancel,
    ) -> Result<Self, SnapshotError> {
        check(cancel)?;
        if !names(root)?.is_empty() {
            return Err(SnapshotError::UnsafePath);
        }
        Ok(Self {
            root,
            cancel,
            files: BTreeMap::new(),
            progress: None,
            #[cfg(test)]
            after_copy: None,
        })
    }
    fn separated(&self, source: &TrustedDirectory) -> Result<(), SnapshotError> {
        // A staging tree inside the source would recursively copy itself; source
        // inside staging could let retry cleanup delete the input. Neither is valid.
        if source.path().starts_with(self.root.path())
            || self.root.path().starts_with(source.path())
        {
            return Err(SnapshotError::UnsafePath);
        }
        Ok(())
    }
    pub(crate) fn files(&self) -> Vec<PayloadFile> {
        let mut files: Vec<_> = self.files.values().cloned().collect();
        files.sort_by(|a, b| a.path.encode_utf16().cmp(b.path.encode_utf16()));
        files
    }
    fn destination(&self, relative: &str) -> Result<TrustedDirectory, SnapshotError> {
        if !safe_relative(relative) {
            return Err(SnapshotError::UnsafePath);
        }
        self.root.assert_unchanged()?;
        let mut current = TrustedDirectory::open(self.root.path())?;
        for part in relative.split('/') {
            check(self.cancel)?;
            current = current.create_child(part)?;
        }
        self.root.assert_unchanged()?;
        Ok(current)
    }
    pub(crate) fn copy_file(
        &mut self,
        src: &TrustedDirectory,
        name: &str,
        relative: &str,
    ) -> Result<(), SnapshotError> {
        check(self.cancel)?;
        if !safe_relative(relative) || !safe_relative(name) || name.contains('/') {
            return Err(SnapshotError::UnsafePath);
        }
        if derived_cache(relative) {
            return Ok(());
        }
        // One file needs only that it is neither read from staging nor the staging tree
        // itself: the pin's side files (`<state>/memory/run-state.json`) are siblings of the
        // engine root `<state>/memory/.snapshots` (RE-D170).
        if src.path().starts_with(self.root.path())
            || self.root.path().starts_with(src.path().join(name))
        {
            return Err(SnapshotError::UnsafePath);
        }
        let mut input = src.open_file(name)?;
        let (parent, leaf) = relative.rsplit_once('/').ok_or(SnapshotError::UnsafePath)?;
        let dest = self.destination(parent)?;
        let mut output = dest.create_file(leaf)?;
        let mut buffer = [0; 64 * 1024];
        let mut bytes = 0_u64;
        let mut hash = Sha256::new();
        loop {
            check(self.cancel)?;
            let n = input.read(&mut buffer).map_err(io)?;
            if n == 0 {
                break;
            }
            output.write_all(&buffer[..n]).map_err(io)?;
            hash.update(&buffer[..n]);
            bytes += n as u64;
        }
        output.sync_all().map_err(io)?;
        drop(output);
        src.assert_unchanged()?;
        dest.assert_unchanged()?;
        self.root.assert_unchanged()?;
        self.files.insert(
            relative.to_owned(),
            PayloadFile {
                path: relative.to_owned(),
                bytes,
                sha256: format!("{:x}", hash.finalize()),
            },
        );
        #[cfg(test)]
        if let Some(hook) = &mut self.after_copy {
            hook(relative);
        }
        if let Some(progress) = self.progress {
            progress(relative)?;
        }
        check(self.cancel)
    }
    pub(crate) fn copy_directory(
        &mut self,
        source: &TrustedDirectory,
        relative: &str,
    ) -> Result<(), SnapshotError> {
        self.separated(source)?;
        self.copy_directory_inner(source, relative, false)
    }
    fn copy_directory_inner(
        &mut self,
        source: &TrustedDirectory,
        relative: &str,
        in_table: bool,
    ) -> Result<(), SnapshotError> {
        check(self.cancel)?;
        if derived_cache(relative) {
            return Ok(());
        }
        if !in_table && is_table(source)? {
            return self.copy_table(source, relative);
        }
        let dest = self.destination(relative)?;
        for name in names(source)? {
            check(self.cancel)?;
            let result = self.copy_entry(source, &name, &format!("{relative}/{name}"), in_table);
            if result == Err(SnapshotError::NotFound) && !in_table {
                continue;
            }
            result?;
        }
        source.assert_unchanged()?;
        dest.assert_unchanged()?;
        Ok(())
    }
    fn copy_entry(
        &mut self,
        source: &TrustedDirectory,
        name: &str,
        relative: &str,
        in_table: bool,
    ) -> Result<(), SnapshotError> {
        if derived_cache(relative) {
            return Ok(());
        }
        let kind = fs::symlink_metadata(source.path().join(name))
            .map_err(io)?
            .file_type();
        if kind.is_dir() {
            self.copy_directory_inner(&source.open_child(name)?, relative, in_table)
        } else if kind.is_file() {
            self.copy_file(source, name, relative)
        } else {
            Ok(())
        } // Node skips links and special files, never follows either.
    }
    fn forget(&mut self, relative: &str) -> Result<(), SnapshotError> {
        if !safe_relative(relative) {
            return Err(SnapshotError::UnsafePath);
        }
        self.root.assert_unchanged()?;
        self.files
            .retain(|key, _| !key.starts_with(&format!("{relative}/")));
        match fs::remove_dir_all(self.root.path().join(relative)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io(e)),
        }
        self.root.assert_unchanged()?;
        Ok(())
    }
    fn table_attempt(
        &mut self,
        source: &TrustedDirectory,
        relative: &str,
    ) -> Result<(), SnapshotError> {
        let head = newest_manifest(source, self.cancel)?;
        let dest = self.destination(relative)?;
        let mut ordered = names(source)?;
        ordered.sort_by(|a, b| {
            let rank = |n: &str| {
                if n == "_versions" {
                    5
                } else {
                    TABLE_ORDER.iter().position(|v| *v == n).unwrap_or(4)
                }
            };
            rank(a)
                .cmp(&rank(b))
                .then_with(|| a.encode_utf16().cmp(b.encode_utf16()))
        });
        for name in ordered {
            check(self.cancel)?;
            self.copy_entry(source, &name, &format!("{relative}/{name}"), true)?;
        }
        if newest_manifest(source, self.cancel)? != head {
            return Err(SnapshotError::SourceBusy);
        }
        let copied = newest_manifest(&dest, self.cancel)?;
        if copied != head {
            return Err(SnapshotError::SourceBusy);
        }
        if let Some(head) = copied {
            for path in manifest_references(&head.bytes) {
                check(self.cancel)?;
                if !dest.path().join(path).try_exists().map_err(io)? {
                    return Err(SnapshotError::SourceBusy);
                }
            }
        }
        source.assert_unchanged()?;
        dest.assert_unchanged()?;
        Ok(())
    }
    fn copy_table(
        &mut self,
        source: &TrustedDirectory,
        relative: &str,
    ) -> Result<(), SnapshotError> {
        for _ in 0..TABLE_TRIES {
            check(self.cancel)?;
            self.forget(relative)?;
            match self.table_attempt(source, relative) {
                Err(SnapshotError::NotFound | SnapshotError::SourceBusy) => {}
                result => return result,
            }
        }
        self.forget(relative)?;
        Err(SnapshotError::SourceBusy)
    }
}

#[cfg(test)]
#[path = "snapshot_copy_tests.rs"]
mod tests;
