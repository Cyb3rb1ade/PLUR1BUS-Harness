//! Repository binding dependencies.
use crate::policy::fs_paths::PathFs;
use crate::rbac::audit::AuditSink;

/// The read-only git checks used to validate a binding.
pub trait RepoGit {
    /// Runs the given read-only git command from a canonical directory.
    fn read(&self, cwd: &str, args: &[&str]) -> Result<String, String>;
}

impl<F: Fn(&str, &[&str]) -> Result<String, String>> RepoGit for F {
    fn read(&self, cwd: &str, args: &[&str]) -> Result<String, String> {
        self(cwd, args)
    }
}

/// Ports and configuration used for repository binding.
pub struct BindRepoPorts<'a, F: PathFs> {
    /// Verified installation home.
    pub home: Option<&'a str>,
    /// Canonical paths and metadata.
    pub fs: &'a F,
    /// Git repository metadata.
    pub git: &'a dyn RepoGit,
    /// Audit event sink used before changing the binding.
    pub audit: &'a mut dyn AuditSink,
}

use super::errors::{CollabError, CollabErrorCode as C};
use super::store::R;
use super::types::RepoBinding;
use crate::js::js_trim;
use crate::policy::fs_paths::FileKind;
use crate::policy::paths::{contains_exact, fold_for_deny, IcuNfc};

fn invalid(reason: &str, message: impl Into<String>) -> CollabError {
    CollabError::with_reason(C::Invalid, message, reason)
}

fn safe_branch(name: &str) -> bool {
    name.len() <= 128
        && name
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
        && !name
            .split('/')
            .any(|s| s == "." || s == ".." || s.starts_with('-'))
}

fn under_home<F: PathFs>(fs: &F, home: &str, repo: &str) -> R<bool> {
    if fs.platform() != "win32" {
        return Ok(contains_exact(home, repo, "/"));
    }
    let fold = |path: &str| {
        fold_for_deny(&path.replace('/', "\\"), &IcuNfc)
            .ok_or_else(|| invalid("repo-path", "repository path cannot be verified"))
    };
    Ok(contains_exact(&fold(home)?, &fold(repo)?, "\\"))
}

pub(super) fn validate<F: PathFs>(
    repo_path: &str,
    branch: &str,
    ports: &BindRepoPorts<'_, F>,
) -> R<RepoBinding> {
    let home = ports.home.ok_or_else(|| {
        invalid(
            "home-required",
            "harness home is required to bind a repository",
        )
    })?;
    if repo_path.is_empty() || branch.is_empty() {
        return Err(invalid(
            "repo-binding",
            "repoPath and baseBranch are required",
        ));
    }
    if !safe_branch(branch) {
        return Err(invalid(
            "base-branch",
            "baseBranch is not a safe branch name",
        ));
    }
    let missing = |_| invalid("repo-path", "repo path or harness home does not exist");
    let repo = ports.fs.realpath(repo_path).map_err(missing)?;
    let home = ports.fs.realpath(home).map_err(missing)?;
    if under_home(ports.fs, &home, &repo)? {
        return Err(invalid(
            "home-path",
            "a repository under the harness home is refused",
        ));
    }
    if !ports
        .fs
        .stat(&repo)
        .is_ok_and(|stat| stat.kind == FileKind::Dir)
    {
        return Err(invalid("repo-path", "repo path is not a directory"));
    }
    let not_repo = |_| invalid("not-a-repo", "git rev-parse --show-toplevel failed");
    let bare = ports
        .git
        .read(&repo, &["rev-parse", "--is-bare-repository"])
        .map_err(not_repo)?;
    match js_trim(&bare) {
        "true" => return Err(invalid("bare-repo", "a bare repository cannot be bound")),
        "false" => {}
        _ => {
            return Err(invalid(
                "not-a-repo",
                "git rev-parse --is-bare-repository returned an invalid result",
            ))
        }
    }
    let top = ports
        .git
        .read(&repo, &["rev-parse", "--show-toplevel"])
        .map_err(not_repo)?;
    let top = ports
        .fs
        .realpath(js_trim(&top))
        .map_err(|_| invalid("not-a-repo", "git rev-parse --show-toplevel failed"))?;
    if top != repo {
        return Err(invalid(
            "toplevel-mismatch",
            "git rev-parse --show-toplevel does not equal repoPath",
        ));
    }
    let name = format!("refs/heads/{branch}");
    ports
        .git
        .read(&repo, &["rev-parse", "--verify", "--quiet", &name])
        .map_err(|_| {
            invalid(
                "base-branch",
                format!("base branch {branch} does not exist"),
            )
        })?;
    Ok(RepoBinding {
        repo_path: repo,
        base_branch: branch.to_owned(),
    })
}
