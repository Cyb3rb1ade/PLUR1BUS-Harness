//! `session/rewind-checkpoints.ts`: D115 working-tree checkpoints and the human-approved restore of tracked files, over a
//! private temporary Git index. Everything Git does goes through [`super::rewind_git::GitProcess`] with an argument list; the
//! real index, `HEAD` and the working tree are touched by exactly one command, the approved `git restore --overlay`.
//!
//! **Where this code checks a path, and what it checks.** The TypeScript code does not use the policy path layer
//! (`policy/paths.ts`) here; it compares real paths: the bound root and the stored root with `realpath`, the Git top level
//! with the root, the Git directory with the stored one, the index must not be a link, and every untracked path a restore
//! would write is `lstat`ed segment by segment so no existing file or non-directory is overwritten. The same comparisons are
//! made here, through [`PathFs`] (`realpath`, `lstat`), in the same order. Nothing is checked less. Beyond the source this
//! port refuses (before anything is written) a path listed by Git that is absolute, has a `..` or empty segment or a `.git`
//! segment; a Git tree cannot hold one, so that refusal is never reached through Git itself, and it bounds what a hostile
//! Git program on the `PATH` could name.
//!
//! No project file is written by this module. The files change only inside the child `git restore --overlay`, with literal
//! pathspecs, in the order Git decides.
//!
//! Known difference: the audit detail of a restore holds `changes` as a nested object; [`crate::rbac::audit::AuditEvent`]
//! keeps nested members sorted where TypeScript keeps them in written order (the action hash is computed over the ordered
//! text and is unaffected).
use super::checkpoint_retention::{
    append_audit, CardEndedFn, CheckpointRetention, Remover, RetentionDeps, RetentionTurnsFn,
    SharedAudit,
};
use super::rewind::{RestoreInput, RewindFilesPort};
use super::rewind_git::{Cancel, GitFailure, GitProcess, RewindError};
use super::types::{MemoryMode, SessionKind, StoredCheckpoint};
use super::{Clock, ErrorCode, IdSource, SessionError, SessionStore};
use crate::approvals::js_json::J;
use crate::identity::sha256_hex;
use crate::js::{is_js_space, utf16_len};
use crate::policy::fs_paths::{error_code, FileKind, PathFs, RealFs};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

const CHECKPOINT: &str = "refs/plur1bus/checkpoints";
const MAX_PREVIEW_PATHS: usize = 200;
const MAX_PREVIEW_CHARS: usize = 4096;

/// `process.platform === "win32" ? "NUL" : devNull`.
pub const fn null_device() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
}

fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

fn is_id(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn is_oid(s: &str) -> bool {
    (40..=64).contains(&s.len()) && s.bytes().all(|b| matches!(b, b'a'..=b'f' | b'0'..=b'9'))
}

fn storage(message: &str, reason: Option<&str>) -> RewindError {
    SessionError::new(ErrorCode::Storage, message, reason).into()
}

fn conflict(message: &str, reason: &str) -> RewindError {
    SessionError::conflict(message, reason).into()
}

fn checkpoint_ref(session_id: &str, turn_id: &str) -> Result<String, RewindError> {
    if !is_id(session_id) || !is_id(turn_id) {
        return Err(
            SessionError::invalid("invalid checkpoint identity", "rewind-checkpoint").into(),
        );
    }
    Ok(format!("{CHECKPOINT}/{session_id}/{turn_id}"))
}

/// `path.resolve(base, rel)` for an absolute `base`: a later absolute `rel` wins; `.` and `..` fold lexically.
fn resolve(base: &str, rel: &str) -> String {
    let joined = Path::new(base).join(rel);
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                if !matches!(
                    out.components().next_back(),
                    Some(Component::RootDir | Component::Prefix(_)) | None
                ) {
                    out.pop();
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().into_owned()
}

fn fs_err(e: &std::io::Error) -> RewindError {
    RewindError::Fs(error_code(e))
}

/// `checkpointEnvironment`: the inherited environment minus every `GIT_` name (any case), plus the harness policy, plus the
/// private index when one is bound. Callers add only trusted operation bindings.
pub fn checkpoint_environment(
    source: &[(String, String)],
    index: Option<&str>,
    null: &str,
) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = source
        .iter()
        .filter(|(k, _)| !k.to_uppercase().starts_with("GIT_"))
        .cloned()
        .collect();
    for (k, v) in [
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_CONFIG_GLOBAL", null),
        ("GIT_ATTR_NOSYSTEM", "1"),
        ("GIT_NO_REPLACE_OBJECTS", "1"),
        ("GIT_OPTIONAL_LOCKS", "0"),
        ("GIT_TERMINAL_PROMPT", "0"),
    ] {
        set_env(&mut env, k, v);
    }
    if let Some(i) = index.filter(|i| !i.is_empty()) {
        set_env(&mut env, "GIT_INDEX_FILE", i);
    }
    env
}

fn set_env(env: &mut Vec<(String, String)>, key: &str, value: &str) {
    match env.iter_mut().find(|(k, _)| k == key) {
        Some(slot) => slot.1 = value.to_owned(),
        None => env.push((key.to_owned(), value.to_owned())),
    }
}

/// The D115 binding of a session: project, card and the canonical worktree root.
#[derive(Clone, Debug, PartialEq)]
pub struct ProjectBinding {
    /// The project.
    pub project_id: String,
    /// The card.
    pub card_id: String,
    /// The worktree root.
    pub root: String,
}

/// `TurnApprover`: who decides, and on which surface.
#[derive(Clone, Debug, PartialEq)]
pub struct TurnApprover {
    /// The person; absent for an unattended turn.
    pub person: Option<String>,
    /// The surface number.
    pub surface: i64,
}

/// The `ApprovalAsk` of a file restore, with the members that vary; the constant members (`capability` `fs.write`, effect
/// `local-destructive`, risk `high`, reversible, grant option `once` at surface 2, no taint, `access` `write`, no parking)
/// are fixed by [`RewindCheckpoints`].
#[derive(Clone, Debug, PartialEq)]
pub struct ApprovalAsk {
    /// `randomUUID()`.
    pub call_id: String,
    /// The tool: `rewind.files.restore`.
    pub tool: &'static str,
    /// The arguments the action hash covers, members in written order.
    pub args: J,
    /// SHA-256 of `JSON.stringify(args)`.
    pub action_hash: String,
    /// The surface the approver is on.
    pub origin_surface: i64,
    /// The session's agent.
    pub agent_id: String,
    /// The approving person.
    pub principal: String,
    /// The session.
    pub session_id: String,
    /// The project.
    pub project_id: String,
    /// `targets`: the root.
    pub targets: Vec<String>,
    /// The preview text.
    pub diff: String,
}

/// What the approval port answers.
#[derive(Clone, Debug, PartialEq)]
pub struct ApprovalAnswer {
    /// Approved or not.
    pub approved: bool,
    /// The scope (`once` is the only one accepted).
    pub scope: Option<String>,
    /// The id of the request.
    pub request_id: Option<String>,
}

/// `ApprovalPort` as the restore uses it. `request` may wait for a person; it is given the store so a host can run
/// maintenance meanwhile, and the combined signal, which maintenance aborts when the card ends.
pub trait RestoreApproval {
    /// `request(ask)`.
    fn request(
        &self,
        store: &mut SessionStore,
        ask: &ApprovalAsk,
        cancel: &Cancel,
    ) -> Result<ApprovalAnswer, RewindError>;
    /// `begin(answer, ask)`: consumes a once-approval. `false` when it is missing or already consumed.
    fn begin(&self, answer: &ApprovalAnswer, ask: &ApprovalAsk) -> bool;
}

/// `project(sessionId, personId)`: the trusted binding, `None` when there is none, an error when the lookup itself failed.
pub type ProjectLookup = Rc<dyn Fn(&str, &str) -> Result<Option<ProjectBinding>, String>>;

/// The dependencies of [`RewindCheckpoints`] (`CheckpointDeps` without the store, which every call takes).
pub struct CheckpointDeps<F: PathFs = RealFs> {
    /// The audit sink.
    pub audit: SharedAudit,
    /// `now`.
    pub clock: Arc<dyn Clock>,
    /// `randomUUID()` of the approval call id.
    pub ids: Arc<dyn IdSource>,
    /// Git as a process.
    pub git: Arc<dyn GitProcess>,
    /// `realpath` and `lstat`.
    pub fs: F,
    /// The directory `mkdtemp` makes the private index directory in (`os.tmpdir()`).
    pub temp_dir: PathBuf,
    /// The null device name (`NUL` on Windows).
    pub null_device: &'static str,
    /// The trusted D115 binding of a session and person.
    pub project: ProjectLookup,
    /// The approval port.
    pub approval: Box<dyn RestoreApproval>,
    /// `fileProjects()`: the live per-project opt-in; empty or absent disables checkpoints.
    pub file_projects: Option<Rc<dyn Fn() -> Vec<String>>>,
    /// `retentionTurns`.
    pub retention_turns: Option<RetentionTurnsFn>,
    /// `cardEnded`.
    pub card_ended: Option<CardEndedFn>,
    /// `onCleanupError`.
    pub on_cleanup_error: Option<Rc<dyn Fn()>>,
}

struct Bound {
    project_id: String,
    card_id: String,
    root: String,
    agent_id: String,
}

struct Tree {
    tree: String,
    index_hash: String,
}

struct GitOpts<'a> {
    cancel: &'a Cancel,
    index: Option<&'a str>,
    env: Vec<(String, String)>,
}

/// D115 checkpoints and restore (`RewindCheckpoints`).
pub struct RewindCheckpoints<F: PathFs = RealFs> {
    d: CheckpointDeps<F>,
    retention: CheckpointRetention,
}

impl<F: PathFs> RewindCheckpoints<F> {
    /// Creates the service; the retention lifecycle observes the store's archives from here on.
    pub fn new(store: &mut SessionStore, deps: CheckpointDeps<F>) -> Result<Self, SessionError> {
        let retention = CheckpointRetention::new(
            store,
            RetentionDeps {
                audit: deps.audit.clone(),
                clock: deps.clock.clone(),
                retention_turns: deps.retention_turns.clone(),
                card_ended: deps.card_ended.clone(),
                on_cleanup_error: deps.on_cleanup_error.clone(),
            },
        )?;
        Ok(Self { d: deps, retention })
    }

    /// The retention lifecycle, for hosts that drive it.
    pub fn retention(&self) -> &CheckpointRetention {
        &self.retention
    }

    fn remover(&self) -> impl Remover + '_ {
        move |store: &mut SessionStore, row: &StoredCheckpoint, cancel: &Cancel| {
            self.remove(store, row, cancel)
        }
    }

    /// `idle()`: pending cleanup has run.
    pub fn idle(&self, store: &mut SessionStore) {
        self.retention.idle(store, &self.remover());
    }

    /// The maintenance timer (see [`CheckpointRetention::tick`]).
    pub fn tick(&self, store: &mut SessionStore) -> bool {
        self.retention.tick(store, &self.remover())
    }

    /// `close()`.
    pub fn close(&self, store: &mut SessionStore) {
        self.retention.close(store);
    }

    // ---- Git ---------------------------------------------------------------------------------------------------------

    fn git(&self, root: &str, args: &[&str], opts: &GitOpts<'_>) -> Result<String, RewindError> {
        let null = self.d.null_device;
        let mut argv: Vec<String> = [
            "--no-pager",
            "--literal-pathspecs",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "commit.gpgSign=false",
            "-c",
            "tag.gpgSign=false",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
        argv.push("-c".into());
        argv.push(format!("core.hooksPath={null}"));
        argv.push("-c".into());
        argv.push(format!("core.attributesFile={null}"));
        argv.push("-C".into());
        argv.push(root.to_owned());
        argv.extend(args.iter().map(|s| (*s).to_owned()));
        let mut env = checkpoint_environment(&self.d.git.base_env(), opts.index, null);
        for (k, v) in &opts.env {
            set_env(&mut env, k, v);
        }
        match self.d.git.run(&argv, &env, opts.cancel) {
            Ok(out) => Ok(out),
            Err(failure) => {
                if let Some(reason) = opts.cancel.reason() {
                    // The raw failure (an AbortError) of an aborted signal, not the wrapped storage error.
                    return Err(match failure {
                        GitFailure::Aborted(r) => RewindError::Aborted(r),
                        _ => RewindError::Aborted(reason),
                    });
                }
                match failure {
                    GitFailure::Aborted(r) => Err(RewindError::Aborted(r)),
                    other => Err(RewindError::Session {
                        error: SessionError::new(
                            ErrorCode::Storage,
                            "checkpoint Git failed",
                            Some("rewind-checkpoint"),
                        ),
                        cause: Some(other),
                    }),
                }
            }
        }
    }

    fn plain<'a>(&self, cancel: &'a Cancel) -> GitOpts<'a> {
        GitOpts {
            cancel,
            index: None,
            env: Vec::new(),
        }
    }

    fn realpath(&self, p: &str) -> Result<String, RewindError> {
        Ok(self.d.fs.realpath(p)?)
    }

    fn common_git_directory(&self, root: &str, cancel: &Cancel) -> Result<String, RewindError> {
        let out = self.git(
            root,
            &["rev-parse", "--git-common-dir"],
            &self.plain(cancel),
        )?;
        self.realpath(&resolve(root, trim(&out)))
    }

    fn index_path(&self, root: &str, cancel: &Cancel) -> Result<String, RewindError> {
        let out = self.git(
            root,
            &["rev-parse", "--git-path", "index"],
            &self.plain(cancel),
        )?;
        let path = resolve(root, trim(&out));
        if self.d.fs.lstat(&path)?.kind == FileKind::Symlink {
            return Err(conflict(
                "checkpoint index must not be a link",
                "rewind-checkpoint",
            ));
        }
        Ok(path)
    }

    fn index_digest(&self, root: &str, cancel: &Cancel) -> Result<String, RewindError> {
        let path = self.index_path(root, cancel)?;
        let bytes = std::fs::read(&path).map_err(|e| fs_err(&e))?;
        Ok(sha256_hex(&[&bytes]))
    }

    fn mkdtemp(&self) -> Result<PathBuf, RewindError> {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        for attempt in 0..64_u32 {
            let name = format!(
                "p1b-checkpoint-{:x}{:x}{attempt:x}",
                std::process::id(),
                nanos
            );
            let dir = self.d.temp_dir.join(name);
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&dir) {
                Ok(()) => return Ok(dir),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(fs_err(&e)),
            }
        }
        Err(RewindError::Fs(crate::policy::fs_paths::FsError::new(
            "EEXIST",
        )))
    }

    /// `workingIndex`: a private copy of the index and a private Git directory over the same object store, in which `run`
    /// executes. The private directory is removed afterwards, whatever happened.
    fn working_index<T>(
        &self,
        root: &str,
        cancel: &Cancel,
        run: impl FnOnce(&GitOpts<'_>, &str) -> Result<T, RewindError>,
    ) -> Result<T, RewindError> {
        let temporary = self.mkdtemp()?;
        let result = self.working_index_in(&temporary, root, cancel, run);
        let _ = std::fs::remove_dir_all(&temporary);
        result
    }

    fn working_index_in<T>(
        &self,
        temporary: &Path,
        root: &str,
        cancel: &Cancel,
        run: impl FnOnce(&GitOpts<'_>, &str) -> Result<T, RewindError>,
    ) -> Result<T, RewindError> {
        let index = temporary.join("index");
        let metadata = temporary.join("git");
        let template = temporary.join("template");
        let source = self.index_path(root, cancel)?;
        let bytes = std::fs::read(&source).map_err(|e| fs_err(&e))?;
        let index_hash = sha256_hex(&[&bytes]);
        std::fs::copy(&source, &index).map_err(|e| fs_err(&e))?;
        let copied = std::fs::read(&index).map_err(|e| fs_err(&e))?;
        if sha256_hex(&[&copied]) != index_hash {
            return Err(conflict(
                "index changed while copying the checkpoint",
                "rewind-files-changed",
            ));
        }
        let format = self.git(
            root,
            &["rev-parse", "--show-object-format"],
            &self.plain(cancel),
        )?;
        let format = trim(&format).to_owned();
        if format != "sha1" && format != "sha256" {
            return Err(storage("unsupported Git object format", None));
        }
        let objects = self.git(
            root,
            &["rev-parse", "--git-path", "objects"],
            &self.plain(cancel),
        )?;
        let objects = resolve(root, trim(&objects));
        std::fs::create_dir(&template).map_err(|e| fs_err(&e))?;
        let metadata_s = metadata.to_string_lossy().into_owned();
        let template_arg = format!("--template={}", template.to_string_lossy());
        let format_arg = format!("--object-format={format}");
        self.git(
            root,
            &["init", "--bare", &template_arg, &format_arg, &metadata_s],
            &self.plain(cancel),
        )?;
        std::fs::create_dir_all(metadata.join("info")).map_err(|e| fs_err(&e))?;
        // Highest-precedence attributes in a trusted temporary Git directory defeat included/worktree config and races
        // introducing a new filter name. Both capture and restore operate on raw bytes, never EOL/encoding/ident transforms.
        std::fs::write(
            metadata.join("info").join("attributes"),
            "* -filter -text -eol -ident -working-tree-encoding\n",
        )
        .map_err(|e| fs_err(&e))?;
        let shared = self.git(
            root,
            &["rev-parse", "--shared-index-path"],
            &self.plain(cancel),
        )?;
        let shared = trim(&shared);
        if !shared.is_empty() {
            let from = resolve(root, shared);
            let name = Path::new(shared)
                .file_name()
                .map(|n| n.to_owned())
                .unwrap_or_default();
            std::fs::copy(from, metadata.join(name)).map_err(|e| fs_err(&e))?;
        }
        let index_s = index.to_string_lossy().into_owned();
        let opts = GitOpts {
            cancel,
            index: Some(&index_s),
            env: vec![
                ("GIT_DIR".into(), metadata_s),
                ("GIT_WORK_TREE".into(), root.to_owned()),
                ("GIT_OBJECT_DIRECTORY".into(), objects),
            ],
        };
        run(&opts, &index_hash)
    }

    fn working_tree(&self, root: &str, cancel: &Cancel) -> Result<Tree, RewindError> {
        self.working_index(root, cancel, |opts, index_hash| {
            // Remove unstaged deletions from the private index first: --renormalize alone tries to stat them and fails.
            self.git(root, &["add", "--update", "--", "."], opts)?;
            // Re-read all tracked contents: a normal index may cache an EOL-normalized blob for an otherwise unchanged file.
            self.git(root, &["add", "--renormalize", "--update", "--", "."], opts)?;
            let tree = self.git(root, &["write-tree"], opts)?;
            let tree = trim(&tree).to_owned();
            if !is_oid(&tree) {
                return Err(storage(
                    "invalid checkpoint tree",
                    Some("rewind-checkpoint"),
                ));
            }
            if self.index_digest(root, cancel)? != index_hash {
                return Err(conflict(
                    "index changed while preparing the checkpoint",
                    "rewind-files-changed",
                ));
            }
            Ok(Tree {
                tree,
                index_hash: index_hash.to_owned(),
            })
        })
    }

    fn protect_untracked(
        &self,
        root: &str,
        tree: &str,
        cancel: &Cancel,
    ) -> Result<(), RewindError> {
        let listed = self.git(
            root,
            &["ls-tree", "-r", "--name-only", "-z", tree],
            &self.plain(cancel),
        )?;
        let tracked_raw = self.git(root, &["ls-files", "--cached", "-z"], &self.plain(cancel))?;
        let tracked: std::collections::HashSet<&str> = tracked_raw.split('\0').collect();
        for path in listed.split('\0').filter(|p| !p.is_empty()) {
            if tracked.contains(path) {
                continue;
            }
            let segments: Vec<&str> = path.split('/').collect();
            if path.starts_with('/')
                || segments.iter().any(|s| {
                    s.is_empty() || *s == ".." || *s == "." || s.eq_ignore_ascii_case(".git")
                })
            {
                return Err(conflict(
                    "restore path is outside the project",
                    "rewind-files-changed",
                ));
            }
            for index in 1..=segments.len() {
                let mut p = PathBuf::from(root);
                for s in &segments[..index] {
                    p.push(s);
                }
                match self.d.fs.lstat(&p.to_string_lossy()) {
                    Ok(stat) => {
                        if index == segments.len() || stat.kind != FileKind::Dir {
                            return Err(conflict(
                                "untracked path would be overwritten by restore",
                                "rewind-files-changed",
                            ));
                        }
                    }
                    Err(e) if e.code == "ENOENT" => break,
                    Err(e) => return Err(e.into()),
                }
            }
        }
        Ok(())
    }

    /// Both trees are immutable native snapshots. Name-status output never invokes a repository diff program.
    fn restore_preview(
        &self,
        root: &str,
        checkpoint: &str,
        current: &str,
        cancel: &Cancel,
    ) -> Result<(J, String), RewindError> {
        let raw = self.git(
            root,
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "--name-status",
                "-z",
                checkpoint,
                current,
                "--",
            ],
            &self.plain(cancel),
        )?;
        let fields: Vec<&str> = if raw.is_empty() {
            Vec::new()
        } else {
            let mut f: Vec<&str> = raw.split('\0').collect();
            f.pop();
            f
        };
        if (!raw.is_empty() && !raw.ends_with('\0'))
            || !fields.len().is_multiple_of(2)
            || raw.contains('\u{fffd}')
        {
            return Err(storage(
                "file restore paths cannot be represented exactly",
                Some("rewind-files-preview"),
            ));
        }
        let (mut overwritten, mut preserved): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
        for pair in fields.chunks(2) {
            let (status, path) = (pair[0], pair[1]);
            if !matches!(status, "A" | "M" | "D" | "T") || path.is_empty() {
                return Err(storage(
                    "invalid file restore preview",
                    Some("rewind-files-preview"),
                ));
            }
            if status == "A" {
                &mut preserved
            } else {
                &mut overwritten
            }
            .push(path.to_owned());
        }
        let strings = |v: &[String]| J::Arr(v.iter().map(|p| J::s(p)).collect());
        let changes = J::obj([
            ("overwritten", strings(&overwritten)),
            ("preserved", strings(&preserved)),
            ("overwrittenCount", J::Num(overwritten.len() as f64)),
            ("preservedCount", J::Num(preserved.len() as f64)),
        ]);
        let mut lines = vec![format!(
            "Overlay restore: overwrite {}; preserve {} newly tracked paths.",
            overwritten.len(),
            preserved.len()
        )];
        lines.extend(
            overwritten
                .iter()
                .map(|p| format!("Overwrite: {}", J::s(p).stringify())),
        );
        lines.extend(
            preserved
                .iter()
                .map(|p| format!("Preserve new tracked: {}", J::s(p).stringify())),
        );
        let diff = lines.join("\n");
        // Refuse an incomplete preview rather than ask for an operation whose affected paths cannot all be shown.
        if overwritten.len() + preserved.len() > MAX_PREVIEW_PATHS
            || utf16_len(&diff) > MAX_PREVIEW_CHARS
            || utf16_len(&changes.stringify()) > MAX_PREVIEW_CHARS
        {
            return Err(conflict(
                "file restore exceeds the bounded approval preview",
                "rewind-files-preview-limit",
            ));
        }
        Ok((changes, diff))
    }

    // ---- cleanup -----------------------------------------------------------------------------------------------------

    fn remove(
        &self,
        store: &mut SessionStore,
        row: &StoredCheckpoint,
        cancel: &Cancel,
    ) -> Result<(), RewindError> {
        let _ = &store;
        let sid = row.session_id.as_str();
        if row.ref_name != checkpoint_ref(sid, &row.turn_id)? || !is_oid(&row.commit_id) {
            return Err(conflict(
                "checkpoint cleanup identity changed",
                "rewind-checkpoint",
            ));
        }
        let mut result = "present";
        let outer = (|| -> Result<(), RewindError> {
            let root = self.realpath(&row.root)?;
            if root != row.root {
                return Err(conflict(
                    "checkpoint cleanup root changed",
                    "rewind-checkpoint",
                ));
            }
            let inner = (|| -> Result<(), RewindError> {
                let top = self.git(
                    &root,
                    &["rev-parse", "--show-toplevel"],
                    &self.plain(cancel),
                )?;
                let top = self.realpath(trim(&top))?;
                if top != root || self.common_git_directory(&root, cancel)? != row.common_git_dir {
                    return Err(conflict(
                        "checkpoint cleanup repository changed",
                        "rewind-checkpoint",
                    ));
                }
                Ok(())
            })();
            match inner {
                Ok(()) => Ok(()),
                Err(e) if e.git_exit() == Some(128) => {
                    result = "root-not-repository";
                    Ok(())
                }
                Err(e) => Err(e),
            }
        })();
        if let Err(e) = outer {
            if !e.missing_path() {
                return Err(e);
            }
            result = "root-missing";
        }
        let audit_missing = |this: &Self| -> Result<(), RewindError> {
            append_audit(
                &this.d.audit,
                this.d.clock.now(),
                "core",
                "session.checkpoint.pruning",
                sid,
                vec![
                    ("turnId".into(), Value::String(row.turn_id.clone())),
                    ("projectId".into(), Value::String(row.project_id.clone())),
                    ("cardId".into(), Value::String(row.card_id.clone())),
                    ("result".into(), Value::String(result.into())),
                ],
            )
        };
        let common = match self.realpath(&row.common_git_dir) {
            Ok(c) => c,
            Err(e) => {
                if result != "present" && e.missing_path() {
                    return audit_missing(self);
                }
                return Err(e);
            }
        };
        if common != row.common_git_dir {
            return Err(conflict(
                "checkpoint cleanup Git directory changed",
                "rewind-checkpoint",
            ));
        }
        let opts = GitOpts {
            cancel,
            index: None,
            env: vec![("GIT_DIR".into(), common.clone())],
        };
        let verified = self.git(&common, &["rev-parse", "--git-common-dir"], &opts)?;
        let verified = self.realpath(&resolve(&common, trim(&verified)))?;
        if verified != common {
            return Err(conflict(
                "checkpoint common directory changed",
                "rewind-checkpoint",
            ));
        }
        let actual = match self.git(
            &common,
            &["rev-parse", "--verify", "--quiet", &row.ref_name],
            &opts,
        ) {
            Ok(s) => Some(trim(&s).to_owned()),
            Err(e) if e.git_exit() == Some(1) => None, // Interrupted ref publication or earlier completed cleanup.
            Err(e) => return Err(e),
        };
        if actual.as_deref().is_some_and(|a| a != row.commit_id) {
            return Err(conflict(
                "checkpoint cleanup ref changed",
                "rewind-checkpoint",
            ));
        }
        if result != "present" {
            audit_missing(self)?;
        }
        if actual.is_some() {
            self.git(
                &common,
                &["update-ref", "-d", &row.ref_name, &row.commit_id],
                &opts,
            )?;
        }
        if result != "present" {
            self.git(&common, &["worktree", "prune", "--expire", "now"], &opts)?;
        }
        Ok(())
    }

    // ---- capture and restore -----------------------------------------------------------------------------------------

    fn projects(&self) -> Vec<String> {
        self.d
            .file_projects
            .as_ref()
            .map(|f| f())
            .unwrap_or_default()
    }

    fn lookup(
        &self,
        session_id: &str,
        person: &str,
    ) -> Result<Option<ProjectBinding>, RewindError> {
        (self.d.project)(session_id, person).map_err(RewindError::Other)
    }

    fn card_ended(&self, project_id: &str, card_id: &str) -> Result<bool, RewindError> {
        match &self.d.card_ended {
            None => Ok(false),
            Some(f) => f(project_id, card_id).map_err(RewindError::Other),
        }
    }

    fn bound(
        &self,
        store: &mut SessionStore,
        session_id: &str,
        person: &str,
        cancel: &Cancel,
        cached: Option<ProjectBinding>,
    ) -> Result<Bound, RewindError> {
        let projects = self.projects();
        if projects.is_empty() {
            return Err(conflict(
                "file checkpoints are disabled for this project",
                "rewind-files-disabled",
            ));
        }
        let session = store.get_session(session_id)?;
        let project = match &session {
            Some(s)
                if s.kind == SessionKind::Card
                    && s.memory_mode != MemoryMode::Incognito
                    && s.archived_at.is_none() =>
            {
                match cached {
                    Some(c) => Some(c),
                    None => self.lookup(session_id, person)?,
                }
            }
            _ => None,
        };
        let (Some(session), Some(project), false) = (session, project, person.is_empty()) else {
            return Err(conflict(
                "D115 worktree checkpoint unavailable",
                "rewind-checkpoint-unavailable",
            ));
        };
        if !projects.contains(&project.project_id) {
            return Err(conflict(
                "file checkpoints are disabled for this project",
                "rewind-files-disabled",
            ));
        }
        if self.card_ended(&project.project_id, &project.card_id)? {
            return Err(conflict(
                "checkpoint card has ended",
                "rewind-checkpoint-unavailable",
            ));
        }
        let root = self.realpath(&project.root)?;
        let top = self.git(
            &root,
            &["rev-parse", "--show-toplevel"],
            &self.plain(cancel),
        )?;
        let top = self.realpath(trim(&top))?;
        if top != root {
            return Err(conflict(
                "checkpoint requires the bound worktree root",
                "rewind-checkpoint",
            ));
        }
        Ok(Bound {
            project_id: project.project_id,
            card_id: project.card_id,
            root,
            agent_id: session.agent_id,
        })
    }

    /// `capture`: before a model turn, snapshot tracked working bytes under the Q14 ref, without touching the real index.
    pub fn capture(
        &self,
        store: &mut SessionStore,
        session_id: &str,
        turn_id: &str,
        person_id: &str,
        signal: &Cancel,
    ) -> Result<(), RewindError> {
        self.retention.run(
            store,
            &self.remover(),
            session_id,
            signal,
            |store, cancel| self.capture_inner(store, session_id, turn_id, person_id, cancel),
        )
    }

    fn capture_inner(
        &self,
        store: &mut SessionStore,
        session_id: &str,
        turn_id: &str,
        person_id: &str,
        cancel: &Cancel,
    ) -> Result<(), RewindError> {
        let session = store.get_session(session_id)?;
        let Some(session) = session.filter(|s| {
            s.kind == SessionKind::Card
                && s.memory_mode != MemoryMode::Incognito
                && s.archived_at.is_none()
        }) else {
            return Ok(());
        };
        if self.projects().is_empty() {
            return Ok(());
        }
        let Some(project) = self.lookup(session_id, person_id)? else {
            return Ok(());
        };
        if !self.projects().contains(&project.project_id) {
            return Ok(());
        }
        let bound = self.bound(store, session_id, person_id, cancel, Some(project))?;
        if store.get_turn(turn_id)?.map(|t| t.session_id) != Some(session.id.clone()) {
            return Err(SessionError::invalid(
                "checkpoint turn is not in the session",
                "rewind-checkpoint",
            )
            .into());
        }
        let r = checkpoint_ref(&session.id, turn_id)?;
        let common_git_dir = self.common_git_directory(&bound.root, cancel)?;
        let snapshot = self.working_tree(&bound.root, cancel)?;
        let head = self.git(
            &bound.root,
            &["rev-parse", "--verify", "HEAD"],
            &self.plain(cancel),
        )?;
        let head = trim(&head).to_owned();
        if !is_oid(&head) {
            return Err(conflict(
                "checkpoint requires a committed worktree",
                "rewind-checkpoint",
            ));
        }
        let identity = GitOpts {
            cancel,
            index: None,
            env: ["AUTHOR", "COMMITTER"]
                .iter()
                .flat_map(|who| {
                    [
                        (format!("GIT_{who}_NAME"), "PLUR1BUS".to_owned()),
                        (
                            format!("GIT_{who}_EMAIL"),
                            "checkpoint@plur1bus.invalid".to_owned(),
                        ),
                    ]
                })
                .collect(),
        };
        let commit = self.git(
            &bound.root,
            &[
                "commit-tree",
                &snapshot.tree,
                "-p",
                &head,
                "-m",
                "PLUR1BUS turn checkpoint",
            ],
            &identity,
        )?;
        let commit = trim(&commit).to_owned();
        if !is_oid(&commit) {
            return Err(storage(
                "invalid checkpoint commit",
                Some("rewind-checkpoint"),
            ));
        }
        cancel.throw_if_aborted()?;
        if !self.projects().contains(&bound.project_id)
            || self.card_ended(&bound.project_id, &bound.card_id)?
        {
            return Err(conflict(
                "checkpoint project policy changed",
                "rewind-files-disabled",
            ));
        }
        append_audit(
            &self.d.audit,
            self.d.clock.now(),
            person_id,
            "session.checkpoint.created",
            &session.id,
            vec![
                ("turnId".into(), Value::String(turn_id.into())),
                ("ref".into(), Value::String(r.clone())),
                ("tree".into(), Value::String(snapshot.tree.clone())),
            ],
        )?;
        cancel.throw_if_aborted()?;
        // Persist intent first: cancellation during update-ref cannot leave a private ref undiscoverable by cleanup.
        store.record_checkpoint(&StoredCheckpoint {
            session_id: session.id.clone(),
            turn_id: turn_id.to_owned(),
            root: bound.root.clone(),
            common_git_dir,
            project_id: bound.project_id.clone(),
            card_id: bound.card_id.clone(),
            ref_name: r.clone(),
            tree: snapshot.tree,
            commit_id: commit.clone(),
        })?;
        // The all-zero old value makes a turn checkpoint immutable, including across a restart/retry.
        let zeros = "0".repeat(commit.len());
        self.git(
            &bound.root,
            &["update-ref", &r, &commit, &zeros],
            &self.plain(cancel),
        )?;
        Ok(())
    }

    /// `restore`: tracked working files only, after a content-bound, single-use human decision; staging and untracked files
    /// stay as they are.
    pub fn restore_files(
        &self,
        store: &mut SessionStore,
        input: RestoreInput<'_>,
    ) -> Result<(), RewindError> {
        let signal = input.signal.clone();
        let session_id = input.session_id.clone();
        self.retention.run(
            store,
            &self.remover(),
            &session_id,
            &signal,
            move |store, cancel| self.restore_inner(store, input, cancel),
        )
    }

    fn restore_inner(
        &self,
        store: &mut SessionStore,
        input: RestoreInput<'_>,
        cancel: &Cancel,
    ) -> Result<(), RewindError> {
        let RestoreInput {
            session_id,
            checkpoint_turn_id,
            approver,
            validate,
            ..
        } = input;
        let Some(person) = approver.person.clone().filter(|p| !p.is_empty()) else {
            return Err(SessionError::new(
                ErrorCode::Immutable,
                "file restore requires a person",
                Some("rewind-person-required"),
            )
            .into());
        };
        let bound = self.bound(store, &session_id, &person, cancel, None)?;
        let r = checkpoint_ref(&session_id, &checkpoint_turn_id)?;
        let recorded = store.checkpoint(&session_id, &checkpoint_turn_id)?;
        let recorded = match recorded {
            Some(rec)
                if rec.root == bound.root
                    && rec.ref_name == r
                    && rec.project_id == bound.project_id
                    && rec.card_id == bound.card_id =>
            {
                rec
            }
            _ => {
                return Err(conflict(
                    "recorded rewind checkpoint is unavailable",
                    "rewind-checkpoint-unavailable",
                ))
            }
        };
        let tree_ref = format!("{r}^{{tree}}");
        let checkpoint = match self.git(
            &bound.root,
            &["rev-parse", "--verify", &tree_ref],
            &self.plain(cancel),
        ) {
            Ok(s) => trim(&s).to_owned(),
            Err(_) => {
                return Err(conflict(
                    "rewind checkpoint is unavailable",
                    "rewind-checkpoint-unavailable",
                ))
            }
        };
        if !is_oid(&checkpoint) {
            return Err(storage(
                "invalid rewind checkpoint",
                Some("rewind-checkpoint"),
            ));
        }
        let commit = self.git(
            &bound.root,
            &["rev-parse", "--verify", &r],
            &self.plain(cancel),
        )?;
        if checkpoint != recorded.tree || trim(&commit) != recorded.commit_id {
            return Err(conflict(
                "recorded checkpoint was changed outside the harness",
                "rewind-checkpoint",
            ));
        }
        self.protect_untracked(&bound.root, &checkpoint, cancel)?;
        let before = self.working_tree(&bound.root, cancel)?;
        let (changes, diff) =
            self.restore_preview(&bound.root, &checkpoint, &before.tree, cancel)?;
        let args = J::obj([
            ("sessionId", J::s(&session_id)),
            ("root", J::s(&bound.root)),
            ("ref", J::s(&r)),
            ("checkpoint", J::s(&checkpoint)),
            ("beforeTree", J::s(&before.tree)),
            ("indexHash", J::s(&before.index_hash)),
            ("changes", changes),
        ]);
        let action_hash = sha256_hex(&[args.stringify().as_bytes()]);
        let ask = ApprovalAsk {
            call_id: self.d.ids.next_id(),
            tool: "rewind.files.restore",
            args: args.clone(),
            action_hash: action_hash.clone(),
            origin_surface: approver.surface,
            agent_id: bound.agent_id.clone(),
            principal: person.clone(),
            session_id: session_id.clone(),
            project_id: bound.project_id.clone(),
            targets: vec![bound.root.clone()],
            diff,
        };
        let answer = self.d.approval.request(store, &ask, cancel)?;
        cancel.throw_if_aborted()?;
        if !answer.approved || answer.scope.as_deref() != Some("once") {
            return Err(SessionError::new(
                ErrorCode::Immutable,
                "file restore was not approved",
                Some("rewind-files-not-approved"),
            )
            .into());
        }
        let current = self.bound(store, &session_id, &person, cancel, None)?;
        let actual = self.working_tree(&bound.root, cancel)?;
        // Like the source, the ref is read again only when the cheaper checks passed (the order of the Git calls is part of the
        // contract the vectors check).
        let moved = if current.root != bound.root
            || current.card_id != bound.card_id
            || current.project_id != bound.project_id
            || actual.tree != before.tree
            || actual.index_hash != before.index_hash
        {
            true
        } else {
            let still = self.git(
                &bound.root,
                &["rev-parse", "--verify", &tree_ref],
                &self.plain(cancel),
            )?;
            trim(&still) != checkpoint
        };
        if moved {
            return Err(conflict(
                "worktree changed while file restore awaited approval",
                "rewind-files-changed",
            ));
        }
        self.protect_untracked(&bound.root, &checkpoint, cancel)?;
        validate(store)?;
        if !self.d.approval.begin(&answer, &ask) {
            return Err(SessionError::new(
                ErrorCode::Immutable,
                "file approval is missing or already consumed",
                Some("rewind-files-not-approved"),
            )
            .into());
        }
        let mut detail: Vec<(String, Value)> = args
            .members()
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.to_value()))
            .collect();
        detail.push(("actionHash".into(), Value::String(action_hash)));
        if let Some(id) = &answer.request_id {
            detail.push(("requestId".into(), Value::String(id.clone())));
        }
        append_audit(
            &self.d.audit,
            self.d.clock.now(),
            &person,
            "session.rewind.files",
            &session_id,
            detail,
        )?;
        self.working_index(&bound.root, cancel, |opts, index_hash| {
            if index_hash != before.index_hash {
                return Err(conflict(
                    "index changed before approved restore",
                    "rewind-files-changed",
                ));
            }
            let source = format!("--source={checkpoint}");
            self.git(
                &bound.root,
                &["restore", "--overlay", &source, "--worktree", "--", "."],
                opts,
            )?;
            Ok(())
        })?;
        if self.index_digest(&bound.root, cancel)? != before.index_hash {
            return Err(conflict(
                "index changed during approved restore",
                "rewind-files-changed",
            ));
        }
        Ok(())
    }
}

impl<F: PathFs> RewindFilesPort for RewindCheckpoints<F> {
    fn capture(
        &self,
        store: &mut SessionStore,
        session_id: &str,
        turn_id: &str,
        person_id: &str,
        signal: &Cancel,
    ) -> Result<(), RewindError> {
        RewindCheckpoints::capture(self, store, session_id, turn_id, person_id, signal)
    }

    fn restore(
        &self,
        store: &mut SessionStore,
        input: RestoreInput<'_>,
    ) -> Result<(), RewindError> {
        self.restore_files(store, input)
    }
}
