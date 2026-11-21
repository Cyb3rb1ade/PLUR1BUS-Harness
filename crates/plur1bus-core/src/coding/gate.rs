//! Coding review records and verification decisions.
use super::verifier::{detect_verifiers, CheckKind, Verifier, MAX_VERIFIER_OUTPUT};
use crate::budget::Clock;
use crate::collab::repo::RepoGit;
use crate::collab::{CollabError, CollabErrorCode as C};
use crate::js::{js_trim, utf16_len};
use crate::logs::methods::AbortSignal;
use crate::policy::fs_paths::FileKind;
use crate::rbac::audit::{AuditEvent, AuditSink};
use crate::rbac::authorize::authorize;
use crate::rbac::types::{AuthorizeContext, Principal, PrincipalKind, Resource};
use crate::toolcall::json::V;
use plur1bus_store::rusqlite::{params, Connection, Transaction, TransactionBehavior};
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreSpec};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;

type R<T> = Result<T, CollabError>;

/// Tracked working file information read without following symlinks.
pub struct WorktreeEntry {
    /// Kind of entry.
    pub kind: FileKind,
    /// Length before reading.
    pub size: u64,
    /// Number of hard links.
    pub links: u64,
}

/// Canonical working files. A file read must stay beneath the canonical root and verify the opened object.
pub trait WorktreeFiles {
    /// Resolves a native path.
    fn canonical(&self, path: &str) -> R<String>;
    /// Reads tracked-file metadata without following the final symlink.
    fn metadata(&self, root: &str, relative: &str) -> R<Option<WorktreeEntry>>;
    /// Reads a bounded regular file with one link. A missing name yields None.
    fn read(&self, root: &str, relative: &str, max_bytes: usize) -> R<Option<Vec<u8>>>;
    /// Whether the default command plan uses Windows separators.
    fn windows(&self) -> bool;
}

/// Git read port with an explicit result for a missing tracked manifest.
pub trait GateGit: RepoGit {
    /// Reads the manifest from the verified commit. Errors must remain errors.
    fn committed(&self, root: &str, head: &str, name: &str) -> R<Option<String>>;
}

/// The identity of a coding worktree at a point in time.
#[derive(Clone)]
pub struct Snapshot {
    /// Canonical worktree root.
    pub root: String,
    /// Commit being inspected.
    pub head: String,
    /// Hash of the worktree bytes and HEAD.
    pub tree_hash: String,
    /// Changed-line count used to require review.
    pub changed_lines: u64,
    /// Files that changed.
    pub files: Vec<String>,
}

/// Result of one verification step.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    /// Step kind.
    pub kind: CheckKind,
    /// Whether the step passed.
    pub ok: bool,
    /// Process exit code.
    pub exit_code: Option<i32>,
    /// Digest of the verifier's output.
    pub evidence: String,
    /// Safe failure reason.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Return value of the coding gate.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateResult {
    /// Whether the task can be completed.
    pub ok: bool,
    /// Verified or refused tree identity.
    pub tree_hash: String,
    /// Number of changed lines.
    pub changed_lines: u64,
    /// Recorded checks.
    pub checks: Vec<CheckResult>,
    /// Recorded documentation gaps.
    pub doc_gaps: Vec<String>,
    /// Why automatic verification was refused.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    /// True if the result uses an authorized explicit override.
    #[serde(rename = "override", skip_serializing_if = "std::ops::Not::not")]
    pub override_note: bool,
}

/// Explicit override from an authenticated lead.
pub struct GateOverride<'a> {
    /// Live actor.
    pub actor: &'a Principal,
    /// The project whose authority permits override.
    pub project: &'a str,
    /// Required audit note.
    pub note: &'a str,
}

/// Parameters of a gate invocation.
pub struct VerifyInput<'a> {
    /// Verified card or other stable task identifier.
    pub task: &'a str,
    /// The assigned local writer whose work is being verified.
    pub writer: &'a str,
    /// Bound worktree root.
    pub root: &'a str,
    /// Caller cancellation.
    pub abort: &'a AbortSignal,
    /// Optional explicit human override.
    pub override_note: Option<GateOverride<'a>>,
}

/// Injected verification and authority services.
pub struct GatePorts<'a> {
    /// Filesystem boundary.
    pub files: &'a dyn WorktreeFiles,
    /// Read-only git state.
    pub git: &'a dyn GateGit,
    /// Sandbox runner.
    pub verifier: &'a dyn Verifier,
    /// Live local-agent check.
    pub local: &'a dyn Fn(&str) -> bool,
    /// Host egress decision for this already authorized worktree.
    pub network_approved: bool,
    /// Clock used by auditing.
    pub clock: &'a dyn Clock,
    /// Append-only audit.
    pub audit: &'a mut dyn AuditSink,
}

const DDL: &str = "CREATE TABLE IF NOT EXISTS coding_reviews(task TEXT, tree_hash TEXT, reviewer TEXT, caller TEXT, PRIMARY KEY(task,tree_hash,reviewer));";
const MAX_FILES: usize = 20_000;
const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;
const MAX_GIT_BYTES: usize = 32 * 1024 * 1024;
const REVIEW_LINES: u64 = 200;

pub(super) const MANIFESTS: &[&str] = &[
    ".plur1bus-verifiers.json",
    "package.json",
    "pnpm-lock.yaml",
    "pyproject.toml",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
    "build.gradle",
    "build.gradle.kts",
];

/// Coding reviews stored by task, tree and reviewer.
pub struct CodingGate {
    db: Store,
}

pub(super) fn open_store(path: &Path, name: &'static str, ddl: &str) -> R<Store> {
    if path != Path::new(":memory:") {
        crate::private_store::prepare(path)
            .map_err(|_| CollabError::new(C::Storage, "could not prepare coding store"))?;
        #[cfg(unix)]
        if !crate::private_store::default_secure(path) {
            return Err(CollabError::new(
                C::Storage,
                "could not protect coding store",
            ));
        }
    }
    let owner = OwnerSpec {
        store: StoreSpec {
            foreign_keys: false,
            ..StoreSpec::new(name, 0)
        },
        journal: Journal::Unchanged,
        schema: Schema::Steps(&[]),
        create: true,
    };
    let db = Store::open_owner(path, &owner)?;
    write(db.conn(), |cx| {
        cx.execute_batch(ddl)?;
        Ok(())
    })?;
    Ok(db)
}

pub(super) fn write<T>(db: &Connection, effect: impl FnOnce(&Connection) -> R<T>) -> R<T> {
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
    let result = effect(&tx)?;
    tx.commit()?;
    Ok(result)
}

fn invalid(message: impl Into<String>) -> CollabError {
    CollabError::new(C::Invalid, message)
}

fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn review_key(snapshot: &Snapshot, writer: &str) -> String {
    let identity = V::Arr(vec![
        V::s("coding-review/2"),
        V::s(&snapshot.root),
        V::s(&snapshot.tree_hash),
        V::s(writer),
    ]);
    hash(identity.stringify())
}

fn git(port: &dyn GateGit, root: &str, args: &[&str]) -> R<String> {
    let value = port
        .read(root, args)
        .map_err(|_| invalid("bounded worktree Git read failed"))?;
    if value.len() > MAX_GIT_BYTES {
        return Err(invalid("worktree Git output exceeds safety cap"));
    }
    Ok(value)
}

fn relative_path(name: &str) -> bool {
    !name.contains(['\\', ':', '\0']) && name.split('/').all(|s| !matches!(s, "" | "." | ".."))
}

fn listed(value: &str) -> R<Vec<&str>> {
    let names: Vec<_> = value.split('\0').filter(|name| !name.is_empty()).collect();
    if names.len() > MAX_FILES {
        return Err(invalid("worktree file scan exceeds safety cap"));
    }
    if names.iter().any(|name| !relative_path(name)) {
        return Err(invalid("invalid repository-relative worktree path"));
    }
    Ok(names)
}

fn safe_file() -> CollabError {
    invalid("worktree file must be a bounded regular file without hardlinks")
}

fn read_file(files: &dyn WorktreeFiles, root: &str, name: &str) -> R<Option<Vec<u8>>> {
    if let Some(entry) = files.metadata(root, name)? {
        if entry.kind != FileKind::File || entry.links != 1 || entry.size > MAX_FILE_BYTES as u64 {
            return Err(safe_file());
        }
    }
    let bytes = files.read(root, name, MAX_FILE_BYTES)?;
    if bytes
        .as_ref()
        .is_some_and(|bytes| bytes.len() > MAX_FILE_BYTES)
    {
        return Err(safe_file());
    }
    Ok(bytes)
}

fn field_number(value: Option<&str>) -> R<u64> {
    value
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| invalid("invalid worktree line counts"))
}

fn changed_lines(stats: &str) -> R<u64> {
    stats
        .lines()
        .filter(|line| !line.is_empty())
        .try_fold(0_u64, |n, line| {
            let mut fields = line.split('\t');
            let (added, removed) = (fields.next(), fields.next());
            let increment = if added == Some("-") || removed == Some("-") {
                REVIEW_LINES
            } else {
                field_number(added)?
                    .checked_add(field_number(removed)?)
                    .ok_or_else(|| invalid("worktree line count overflow"))?
            };
            n.checked_add(increment)
                .ok_or_else(|| invalid("worktree line count overflow"))
        })
}

fn documentation_gaps(files: &[String]) -> Vec<String> {
    let changed_code = files.iter().any(|f| {
        f.rsplit_once('.')
            .is_some_and(|(_, ext)| matches!(ext, "ts" | "js" | "py" | "rs" | "go" | "java" | "kt"))
    });
    let has_docs = files
        .iter()
        .any(|f| f.starts_with("docs/") || f.contains("README") || f.ends_with(".md"));
    if changed_code && !has_docs {
        vec![
            "Document changed behavior or explain why no documentation change is needed."
                .to_owned(),
        ]
    } else {
        vec![]
    }
}

fn canonical_review_id(value: &str) -> bool {
    let alpha = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    value.len() <= 64
        && value.as_bytes().first().copied().is_some_and(alpha)
        && value.bytes().all(|b| alpha(b) || b == b'_' || b == b'-')
}

fn local(id: &str, ports: &GatePorts<'_>) -> bool {
    canonical_review_id(id) && (ports.local)(id)
}

fn audit(
    ports: &mut GatePorts<'_>,
    action: &str,
    actor: &str,
    task: &str,
    detail: Vec<(String, serde_json::Value)>,
) -> R<()> {
    ports
        .audit
        .append(&AuditEvent {
            at: ports.clock.now(),
            user: actor.to_owned(),
            host: String::new(),
            action: action.to_owned(),
            target: task.to_owned(),
            detail,
        })
        .map_err(|_| CollabError::new(C::Storage, "coding audit failed"))
}

fn abort_check(abort: &AbortSignal) -> R<()> {
    if abort.is_aborted() {
        return Err(CollabError::new(C::Aborted, "coding verification aborted"));
    }
    Ok(())
}

impl CodingGate {
    /// Open the unversioned coding-gate store.
    pub fn open(path: &Path) -> R<Self> {
        Ok(Self {
            db: open_store(path, "coding-gate", DDL)?,
        })
    }

    /// Compute a snapshot through trusted file and Git ports.
    pub fn snapshot(&self, root: &str, ports: &GatePorts<'_>) -> R<Snapshot> {
        let canonical = ports.files.canonical(root)?;
        let top = git(ports.git, &canonical, &["rev-parse", "--show-toplevel"])?;
        if ports.files.canonical(js_trim(&top))? != canonical {
            return Err(invalid("verifier requires the bound Git worktree root"));
        }
        let head = git(ports.git, &canonical, &["rev-parse", "HEAD"])?;
        let head = js_trim(&head).to_owned();
        if !matches!(head.len(), 40 | 64)
            || !head
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid("invalid Git HEAD"));
        }
        // Refuse unsafe entries before invoking a command whose implementation can touch tracked files.
        let tracked = git(ports.git, &canonical, &["ls-files", "-z"])?;
        for name in listed(&tracked)? {
            if let Some(stat) = ports.files.metadata(&canonical, name)? {
                match stat.kind {
                    FileKind::Symlink => {}
                    FileKind::File if stat.links == 1 && stat.size <= MAX_FILE_BYTES as u64 => {}
                    _ => return Err(safe_file()),
                }
            }
        }
        let untracked = git(
            ports.git,
            &canonical,
            &["ls-files", "--others", "--exclude-standard", "-z"],
        )?;
        let untracked = listed(&untracked)?;
        let diff = git(ports.git, &canonical, &["diff", "--binary", "HEAD", "--"])?;
        let stats = git(ports.git, &canonical, &["diff", "--numstat", "HEAD", "--"])?;
        let mut lines = changed_lines(js_trim(&stats))?;
        let mut extra = Vec::new();
        for name in &untracked {
            let bytes = read_file(ports.files, &canonical, name)?.ok_or_else(safe_file)?;
            let count = bytes.iter().filter(|&&byte| byte == b'\n').count() as u64 + 1;
            lines = lines
                .checked_add(count)
                .ok_or_else(|| invalid("worktree line count overflow"))?;
            extra.push(format!("{name}:{}", hash(&bytes)));
        }
        let files = git(
            ports.git,
            &canonical,
            &["diff", "--name-only", "HEAD", "--"],
        )?;
        let files = js_trim(&files)
            .lines()
            .filter(|name| !name.is_empty())
            .chain(untracked)
            .map(str::to_owned)
            .collect();
        let data = V::Arr(vec![V::s(&head), V::s(&diff), V::strs(&extra)]);
        Ok(Snapshot {
            root: canonical,
            head,
            tree_hash: hash(data.stringify()),
            changed_lines: lines,
            files,
        })
    }

    /// Record an independent local review for the current worktree.
    pub fn record_review(
        &self,
        task: &str,
        snapshot: &Snapshot,
        reviewer: &str,
        caller: &str,
        ports: &mut GatePorts<'_>,
    ) -> R<()> {
        let invalid_review = || {
            CollabError::new(
                C::Conflict,
                "independent local review of current tree required",
            )
        };
        if reviewer == caller || !local(reviewer, ports) || !local(caller, ports) {
            return Err(invalid_review());
        }
        let live = self.snapshot(&snapshot.root, ports)?;
        if live.root != snapshot.root || live.tree_hash != snapshot.tree_hash {
            return Err(invalid_review());
        }
        audit(
            ports,
            "coding.review",
            reviewer,
            task,
            vec![
                ("treeHash".to_owned(), json!(snapshot.tree_hash)),
                ("caller".to_owned(), json!(caller)),
            ],
        )?;
        write(self.db.conn(), |cx| {
            cx.execute(
                "INSERT OR REPLACE INTO coding_reviews VALUES (?,?,?,?)",
                params![task, review_key(snapshot, caller), reviewer, caller],
            )?;
            Ok(())
        })
    }

    fn has_review(
        &self,
        task: &str,
        snapshot: &Snapshot,
        writer: &str,
        ports: &GatePorts<'_>,
    ) -> R<bool> {
        let key = review_key(snapshot, writer);
        let mut sql = self.db.conn().prepare(
            "SELECT reviewer FROM coding_reviews WHERE task=? AND tree_hash=? AND caller=?",
        )?;
        let rows = sql.query_map([task, key.as_str(), writer], |row| row.get::<_, String>(0))?;
        for row in rows {
            let reviewer = row?;
            if reviewer != writer && local(&reviewer, ports) && local(writer, ports) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Verify current work and evidence. Only a committed plan can run and only host policy can grant network access.
    pub fn verify(&self, input: VerifyInput<'_>, ports: &mut GatePorts<'_>) -> R<GateResult> {
        abort_check(input.abort)?;
        let before = self.snapshot(input.root, ports)?;
        let mut result = GateResult {
            ok: false,
            tree_hash: before.tree_hash.clone(),
            changed_lines: before.changed_lines,
            doc_gaps: documentation_gaps(&before.files),
            checks: vec![],
            reason: None,
            override_note: false,
        };
        if let Some(skip) = input.override_note {
            let resource = Resource::Project {
                project_id: skip.project.to_owned(),
            };
            if skip.actor.kind != Some(PrincipalKind::Person)
                || !input
                    .task
                    .strip_prefix(skip.project)
                    .is_some_and(|rest| rest.starts_with('/'))
                || !authorize(
                    Some(skip.actor),
                    "project.manage",
                    &resource,
                    &AuthorizeContext::default(),
                )
                .is_allow()
            {
                return Err(CollabError::new(
                    C::Unauthorized,
                    "a project lead must explicitly override",
                ));
            }
            if js_trim(skip.note).is_empty() || utf16_len(skip.note) > 2000 {
                return Err(invalid("override requires a bounded note"));
            }
            audit(
                ports,
                "coding.override",
                &skip.actor.user_id,
                input.task,
                vec![
                    ("treeHash".to_owned(), json!(before.tree_hash)),
                    ("note".to_owned(), json!(skip.note)),
                ],
            )?;
            result.ok = true;
            result.override_note = true;
            return Ok(result);
        }
        let mut manifests = BTreeMap::new();
        for name in MANIFESTS {
            let committed = ports.git.committed(&before.root, &before.head, name)?;
            let current = read_file(ports.files, &before.root, name)?;
            if current.as_deref() != committed.as_deref().map(str::as_bytes) {
                result.reason = Some("verifier-conventions-changed");
                return Ok(result);
            }
            if let Some(committed) = committed {
                manifests.insert((*name).to_owned(), committed);
            }
        }
        let plan = detect_verifiers(&manifests, ports.files.windows())?;
        for command in &plan.commands {
            abort_check(input.abort)?;
            let run = ports.verifier.run(
                &before.root,
                command,
                plan.network_allowed && ports.network_approved,
                input.abort,
            );
            let oversize = run.output.len() > MAX_VERIFIER_OUTPUT;
            let evidence = if oversize {
                hash(&[] as &[u8])
            } else {
                hash(run.output.as_bytes())
            };
            result.checks.push(CheckResult {
                kind: command.kind,
                ok: run.ok
                    && !oversize
                    && run.exit_code == Some(0)
                    && (!command.empty_output || js_trim(&run.output).is_empty()),
                exit_code: run.exit_code,
                evidence,
                reason: if oversize {
                    Some("output-limit".to_owned())
                } else {
                    run.reason
                },
            });
        }
        abort_check(input.abort)?;
        let after = self.snapshot(input.root, ports)?;
        let unchanged = after.root == before.root && after.tree_hash == before.tree_hash;
        let reviewed = before.changed_lines < REVIEW_LINES
            || self.has_review(input.task, &before, input.writer, ports)?;
        result.reason = if !unchanged {
            Some("worktree-changed-during-verification")
        } else if result.checks.iter().any(|check| !check.ok) {
            Some("verifiers-failed")
        } else if !reviewed {
            Some("review-required")
        } else {
            None
        };
        result.ok = result.reason.is_none();
        audit(
            ports,
            "coding.verified",
            "",
            input.task,
            vec![("result".to_owned(), json!(result))],
        )?;
        Ok(result)
    }
}

#[cfg(test)]
#[path = "gate_vectors.rs"]
mod vectors;
