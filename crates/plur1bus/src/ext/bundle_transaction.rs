//! Durable rollback scope for a composition. The supervisor copies only already installed opaque trees and its
//! own metadata; package parsing remains in the worker. A pending journal is restored before ordinary recovery.
use super::commit::{self, ModuleHost, Rollback};
use super::paths::ExtPaths;
use super::record::{active_code_dir, io_err, skill_id_ok};
use super::state::{self, ItemRecord};
use super::ExtError;
use crate::paths::Layout;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

const MAX_BYTES: u64 = 2 << 30;
const MAX_FILES: usize = 100_000;
const JOURNAL: &str = "journal.json";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: String,
    present: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u8,
    committed: bool,
    entries: Vec<Entry>,
    trash: Vec<String>,
    names: Vec<String>,
    absent_dirs: Vec<String>,
}
struct Snapshot {
    dir: PathBuf,
    journal: Journal,
}

fn invalid() -> ExtError {
    ExtError::new(
        "E_STORAGE",
        "state-invalid",
        "the bundle transaction journal is invalid or cannot be recovered",
    )
}
fn plain_dir(path: &Path) -> Result<(), ExtError> {
    if fs::symlink_metadata(path).is_ok_and(|m| !m.is_dir() || m.file_type().is_symlink()) {
        return Err(invalid());
    }
    Ok(())
}
fn remove(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() && !m.file_type().is_symlink() => state::remove_dir_all_retrying(path),
        Ok(_) => state::remove_retrying(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}
fn copy(from: &Path, to: &Path, budget: &mut (u64, usize), depth: usize) -> Result<(), ExtError> {
    if depth > 32 {
        return Err(invalid());
    }
    let meta = fs::symlink_metadata(from).map_err(|e| io_err("cannot snapshot", from, e))?;
    if meta.file_type().is_symlink() {
        return Err(invalid());
    }
    if meta.is_dir() {
        fs::create_dir_all(to).map_err(|e| io_err("cannot create", to, e))?;
        for item in fs::read_dir(from).map_err(|e| io_err("cannot read", from, e))? {
            let item = item.map_err(|_| invalid())?;
            copy(&item.path(), &to.join(item.file_name()), budget, depth + 1)?;
        }
    } else if meta.is_file() {
        budget.0 = budget
            .0
            .checked_add(meta.len())
            .filter(|b| *b <= MAX_BYTES)
            .ok_or_else(invalid)?;
        budget.1 += 1;
        if budget.1 > MAX_FILES {
            return Err(invalid());
        }
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|e| io_err("cannot create", parent, e))?;
        }
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x0020_0000);
        }
        let input = options
            .open(from)
            .map_err(|e| io_err("cannot read", from, e))?;
        let opened = input.metadata().map_err(|_| invalid())?;
        if !opened.is_file() || opened.len() != meta.len() {
            return Err(invalid());
        }
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(to)
            .map_err(|e| io_err("cannot create", to, e))?;
        let count = std::io::copy(&mut input.take(meta.len() + 1), &mut output)
            .map_err(|e| io_err("cannot copy", to, e))?;
        if count != meta.len() {
            return Err(invalid());
        }
        output
            .flush()
            .and_then(|_| output.sync_all())
            .map_err(|e| io_err("cannot write", to, e))?;
        fs::set_permissions(to, meta.permissions())
            .map_err(|e| io_err("cannot set permissions", to, e))?;
    } else {
        return Err(invalid());
    }
    Ok(())
}
fn allowed(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    let hash = |s: &str| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    match parts.as_slice() {
        ["config.json"] | ["skills", "index.json"] | ["extensions", "state.json"] => true,
        ["skills" | "modules", name] | ["extensions", "bundles", name] | ["data", "ext", name] => {
            skill_id_ok(name)
        }
        ["extensions", "trash", id] => super::remove::valid_trash_id(id),
        ["mcp", name] => skill_id_ok(name),
        ["mcp", name, version] => skill_id_ok(name) && super::packages::valid_version(version),
        ["extensions", "cache", file] => file
            .rsplit_once('.')
            .is_some_and(|(stem, ext)| hash(stem) && matches!(ext, "json" | "p1x")),
        _ => false,
    }
}
fn ancestors(home: &Path, rel: &str) -> Result<PathBuf, ExtError> {
    if !allowed(rel) {
        return Err(invalid());
    }
    let mut path = home.to_path_buf();
    let parts: Vec<_> = Path::new(rel).components().collect();
    for part in &parts[..parts.len() - 1] {
        let Component::Normal(name) = part else {
            return Err(invalid());
        };
        path.push(name);
        plain_dir(&path)?;
    }
    Ok(home.join(rel))
}
fn names(path: &Path) -> Result<Vec<String>, ExtError> {
    plain_dir(path)?;
    match fs::read_dir(path) {
        Ok(entries) => entries
            .map(|e| {
                e.map_err(|_| invalid())
                    .and_then(|e| e.file_name().into_string().map_err(|_| invalid()))
            })
            .collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err(invalid()),
    }
}
impl Snapshot {
    fn begin(
        layout: &Layout,
        records: &[ItemRecord],
        hashes: &[String],
        trash_ids: &[String],
    ) -> Result<Self, ExtError> {
        let paths = ExtPaths::of(layout);
        let root = paths.root.join("bundle-transactions");
        plain_dir(&paths.root)?;
        plain_dir(&root)?;
        fs::create_dir_all(&root).map_err(|e| io_err("cannot create", &root, e))?;
        let id = uuid::Uuid::new_v4().to_string();
        let dir = root.join(format!("{id}.tmp-{}", std::process::id()));
        fs::create_dir(&dir).map_err(|e| io_err("cannot create", &dir, e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|_| invalid())?;
        }
        let mut targets = BTreeSet::from([
            "config.json".to_string(),
            "skills/index.json".to_string(),
            "extensions/state.json".to_string(),
        ]);
        for record in records {
            let code = if record.kind == "mcp-server" {
                super::record::code_dir(layout, &record.name, &record.kind)
            } else {
                active_code_dir(layout, record)
            };
            let rel = code
                .strip_prefix(&layout.home)
                .map_err(|_| invalid())?
                .to_str()
                .ok_or_else(invalid)?
                .replace('\\', "/");
            targets.insert(rel);
            let data = format!("data/ext/{}", record.name);
            if !layout.ext_data(&record.name).exists() {
                targets.insert(data);
            }
        }
        for hash in hashes {
            targets.insert(format!("extensions/cache/{hash}.p1x"));
            targets.insert(format!("extensions/cache/{hash}.json"));
        }
        for id in trash_ids {
            if !super::remove::valid_trash_id(id) {
                let _ = remove(&dir);
                return Err(invalid());
            }
            targets.insert(format!("extensions/trash/{id}"));
        }
        let mut journal = Journal {
            version: 1,
            committed: false,
            entries: Vec::new(),
            trash: names(&paths.trash)?,
            names: records.iter().map(|r| r.name.clone()).collect(),
            absent_dirs: [
                "skills",
                "modules",
                "mcp",
                "data",
                "data/ext",
                "extensions/cache",
                "extensions/trash",
                "extensions/bundles",
            ]
            .into_iter()
            .filter(|rel| !layout.home.join(rel).exists())
            .map(str::to_string)
            .collect(),
        };
        let prepared = (|| {
            let mut budget = (0, 0);
            for (index, rel) in targets.into_iter().enumerate() {
                let target = ancestors(&layout.home, &rel)?;
                let present = match fs::symlink_metadata(&target) {
                    Ok(_) => true,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                    Err(error) => return Err(io_err("cannot snapshot", &target, error)),
                };
                // Existing immutable MCP versions are never written by an install. Saving them is nevertheless
                // necessary when this same scope is used for group uninstall.
                if present {
                    copy(&target, &dir.join(index.to_string()), &mut budget, 0)?;
                }
                journal.entries.push(Entry { path: rel, present });
            }
            let body = serde_json::to_vec(&journal).map_err(|_| invalid())?;
            state::write_private_atomic(&dir.join(JOURNAL), &body).map_err(|_| invalid())?;
            Ok::<(), ExtError>(())
        })();
        if let Err(error) = prepared {
            let _ = remove(&dir);
            let _ = fs::remove_dir(root);
            return Err(error);
        }
        let published = root.join(id);
        if state::rename_retrying(&dir, &published).is_err() {
            let _ = remove(&dir);
            let _ = fs::remove_dir(&root);
            return Err(invalid());
        }
        Ok(Self {
            dir: published,
            journal,
        })
    }
    fn finish(mut self) -> Result<(), ExtError> {
        self.journal.committed = true;
        let body = serde_json::to_vec(&self.journal).map_err(|_| invalid())?;
        state::write_private_atomic(&self.dir.join(JOURNAL), &body).map_err(|_| invalid())?;
        let root = self.dir.parent().map(Path::to_path_buf);
        let _ = remove(&self.dir);
        if let Some(root) = root {
            let _ = fs::remove_dir(root);
        }
        Ok(())
    }
    fn discard(self) {
        let root = self.dir.parent().map(Path::to_path_buf);
        let _ = remove(&self.dir);
        if let Some(root) = root {
            let _ = fs::remove_dir(root);
        }
    }
}

/// One rollback stack for every member. The private journal is published before the first live mutation.
pub(crate) fn run<'a, T>(
    layout: &'a Layout,
    host: &mut dyn ModuleHost,
    records: &[ItemRecord],
    hashes: &[String],
    operation: impl FnOnce(&mut dyn ModuleHost, &mut Rollback<'a>) -> Result<T, ExtError>,
) -> Result<T, ExtError> {
    run_with_trash(layout, host, records, hashes, &[], operation)
}

/// Restore also mutates its source trash entries; they are included in the same durable beforeimage.
pub(crate) fn run_with_trash<'a, T>(
    layout: &'a Layout,
    host: &mut dyn ModuleHost,
    records: &[ItemRecord],
    hashes: &[String],
    trash_ids: &[String],
    operation: impl FnOnce(&mut dyn ModuleHost, &mut Rollback<'a>) -> Result<T, ExtError>,
) -> Result<T, ExtError> {
    let snapshot = Snapshot::begin(layout, records, hashes, trash_ids)?;
    let mut rollback = Rollback::default();
    let result = operation(host, &mut rollback);
    if commit::killed() {
        return result;
    }
    match result {
        Ok(value) => match snapshot.finish() {
            Ok(()) => Ok(value),
            Err(mut error) => {
                let failures = rollback.run(host);
                if !failures.is_empty() {
                    error
                        .message
                        .push_str("; bundle rollback requires recovery");
                }
                Err(error)
            }
        },
        Err(mut error) => {
            let failures = rollback.run(host);
            if failures.is_empty() {
                snapshot.discard();
            } else {
                error
                    .message
                    .push_str("; bundle rollback requires recovery");
            }
            Err(error)
        }
    }
}

/// Called before the normal commit/trash recovery and before config or children are loaded.
pub(crate) fn recover(layout: &Layout) -> Result<Vec<String>, ExtError> {
    let paths = ExtPaths::of(layout);
    let root = paths.root.join("bundle-transactions");
    let mut done = Vec::new();
    for name in names(&root)? {
        if let Some((_, pid)) = name.rsplit_once(".tmp-") {
            if pid
                .parse::<u32>()
                .is_ok_and(|pid| !crate::proc::pid_alive(pid))
            {
                let _ = remove(&root.join(&name));
            }
            continue;
        }
        if !super::record::valid_id(&name) {
            return Err(invalid());
        }
        let dir = root.join(&name);
        plain_dir(&dir)?;
        let path = dir.join(JOURNAL);
        let meta = fs::symlink_metadata(&path).map_err(|_| invalid())?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 512 * 1024 {
            return Err(invalid());
        }
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x0020_0000);
        }
        let input = options.open(&path).map_err(|_| invalid())?;
        if !input.metadata().map_err(|_| invalid())?.is_file() {
            return Err(invalid());
        }
        let mut body = Vec::new();
        input
            .take(512 * 1024 + 1)
            .read_to_end(&mut body)
            .map_err(|_| invalid())?;
        if body.len() > 512 * 1024 {
            return Err(invalid());
        }
        let journal: Journal = serde_json::from_slice(&body).map_err(|_| invalid())?;
        let dirs_allowed = [
            "skills",
            "modules",
            "mcp",
            "data",
            "data/ext",
            "extensions/cache",
            "extensions/trash",
            "extensions/bundles",
        ];
        if journal
            .absent_dirs
            .iter()
            .any(|path| !dirs_allowed.contains(&path.as_str()))
        {
            return Err(invalid());
        }
        if journal.version != 1
            || journal.entries.len() > 4096
            || journal.trash.len() > 100_000
            || journal.names.len() > 513
            || journal.names.iter().any(|n| !skill_id_ok(n))
        {
            return Err(invalid());
        }
        if !journal.committed {
            // Confirm every required beforeimage exists before removing any live target.
            for (index, entry) in journal.entries.iter().enumerate() {
                ancestors(&layout.home, &entry.path)?;
                if entry.present {
                    let backup =
                        fs::symlink_metadata(dir.join(index.to_string())).map_err(|_| invalid())?;
                    if backup.file_type().is_symlink() || (!backup.is_file() && !backup.is_dir()) {
                        return Err(invalid());
                    }
                }
            }
            let mut budget = (0, 0);
            for (index, entry) in journal.entries.iter().enumerate().rev() {
                let target = ancestors(&layout.home, &entry.path)?;
                remove(&target).map_err(|_| invalid())?;
                if entry.present {
                    copy(&dir.join(index.to_string()), &target, &mut budget, 0)?;
                }
            }
            for trash in names(&paths.trash)? {
                if !journal.trash.contains(&trash) {
                    remove(&paths.trash.join(trash)).map_err(|_| invalid())?;
                }
            }
            for rel in journal.absent_dirs.iter().rev() {
                let _ = fs::remove_dir(layout.home.join(rel));
            }
            // Ordinary per-item recovery must not treat restored old code as the killed replacement.
            if let Ok(staging) = fs::read_dir(&paths.staging) {
                for staged in staging.flatten() {
                    let mark = staged.path().join(commit::COMMIT_MARK);
                    let parsed = fs::symlink_metadata(&mark)
                        .ok()
                        .filter(|m| m.is_file() && !m.file_type().is_symlink() && m.len() < 16384)
                        .and_then(|_| fs::read(&mark).ok())
                        .and_then(|bytes| {
                            serde_json::from_slice::<commit::CommitMark>(&bytes).ok()
                        });
                    if parsed.is_some_and(|mark| journal.names.contains(&mark.name)) {
                        let _ = remove(&staged.path());
                    }
                }
            }
            done.push("rolled back an interrupted bundle transaction".into());
        }
        remove(&dir).map_err(|_| invalid())?;
    }
    let _ = fs::remove_dir(root);
    Ok(done)
}

/// Pending recovery blocks extension execution until the complete beforeimage can be restored.
pub(crate) fn pending(layout: &Layout) -> bool {
    let root = ExtPaths::of(layout).root.join("bundle-transactions");
    match fs::read_dir(root) {
        Ok(mut entries) => entries.next().is_some(),
        Err(e) => e.kind() != std::io::ErrorKind::NotFound,
    }
}
