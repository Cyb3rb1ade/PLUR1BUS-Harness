//! A coding diff over a private index and object directory. The process and scratch filesystem are ports.
use crate::collab::{CollabError, CollabErrorCode as C};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

type R<T> = Result<T, CollabError>;

/// A Git invocation built by the private-index diff library.
pub struct GitCall {
    /// Canonical working directory.
    pub cwd: PathBuf,
    /// Fixed argv, passed without shell interpretation.
    pub args: Vec<String>,
    /// Explicit environment, without inherited Git routing.
    pub env: BTreeMap<String, String>,
    /// Deadline supplied to the runner.
    pub timeout_ms: u64,
    /// Bounded stdout/stderr bytes.
    pub max_bytes: usize,
}

/// Execute only the supplied argv and environment using a configured Git binary.
pub trait GitProcess {
    /// Clear the inherited environment and capture bounded stdout with empty stdin.
    /// For HEAD verification, Git exit 1 and empty output mean an unborn branch.
    /// All other failed invocations return an error.
    fn git(&self, call: &GitCall) -> R<String>;
}

/// Owner-only scratch operations and reads of authorized Git metadata.
pub trait DiffFiles {
    /// Allocates an independent private directory and returns its canonical path.
    fn scratch(&self) -> R<PathBuf>;
    /// Authorize and canonicalize a discovered Git metadata path, including linked worktrees.
    /// Authorize all referenced object stores before admitting an objects directory.
    fn repository_metadata(&self, root: &Path, value: &str) -> R<PathBuf>;
    /// Copy a stable, regular, no-follow index into private scratch. Missing source yields false.
    fn copy_index(&self, source: &Path, destination: &Path, max: u64) -> R<bool>;
    /// Ensures a private subdirectory exists in scratch.
    fn mkdir(&self, path: &Path) -> R<()>;
    /// Writes owner-only metadata inside scratch.
    fn write(&self, path: &Path, bytes: &[u8]) -> R<()>;
    /// Releases only the private allocation returned by scratch.
    fn release(&self, path: &Path);
}

/// Bounded working diff recipe. The host owns process execution and private scratch files.
pub struct GitView<'a> {
    /// Configured Git runner.
    pub process: &'a dyn GitProcess,
    /// Read-only metadata and scratch port.
    pub files: &'a dyn DiffFiles,
    /// Minimal host environment, such as a trusted PATH.
    pub environment: &'a BTreeMap<String, String>,
    /// Native Windows Git uses NUL as its configuration null device.
    pub windows: bool,
}

const MAX_OUTPUT: usize = 4 * 1024 * 1024;
const MAX_INDEX: u64 = 64 * 1024 * 1024;

struct Scratch<'a> {
    path: PathBuf,
    files: &'a dyn DiffFiles,
}

impl Drop for Scratch<'_> {
    fn drop(&mut self) {
        self.files.release(&self.path);
    }
}

fn invalid(message: &str) -> CollabError {
    CollabError::new(C::Invalid, message)
}

fn git_line(text: &str) -> &str {
    text.strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(text)
}

fn path_text(path: &Path) -> R<&str> {
    path.to_str()
        .filter(|text| !text.contains('\0'))
        .ok_or_else(|| invalid("invalid native Git path"))
}

fn quoted_path(path: &str) -> String {
    use std::fmt::Write as _;
    let mut result = String::from("\"");
    for character in path.chars() {
        match character {
            '"' | '\\' => {
                result.push('\\');
                result.push(character);
            }
            c if c.is_ascii_control() => {
                let _ = write!(result, "\\{:03o}", u32::from(c));
            }
            c => result.push(c),
        }
    }
    result.push('"');
    result
}

fn object_id(text: &str, len: usize) -> R<&str> {
    let id = git_line(text);
    if id.len() != len
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid("invalid Git object id"));
    }
    Ok(id)
}

impl GitView<'_> {
    fn command(&self, root: &Path, args: &[&str], routes: &[(&str, &str)]) -> R<String> {
        let null = if self.windows { "NUL" } else { "/dev/null" };
        let hooks = format!("core.hooksPath={null}");
        let attributes = format!("core.attributesFile={null}");
        let fixed = [
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-c",
            &hooks,
            "-c",
            "diff.external=",
            "-c",
            &attributes,
            "-c",
            "core.quotePath=false",
        ];
        let mut env: BTreeMap<_, _> = self
            .environment
            .iter()
            .filter(|(key, _)| {
                ["PATH", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL"]
                    .iter()
                    .any(|known| key.eq_ignore_ascii_case(known))
            })
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        env.extend(
            [
                ("GIT_CONFIG_NOSYSTEM", "1"),
                ("GIT_CONFIG_GLOBAL", null),
                ("GIT_OPTIONAL_LOCKS", "0"),
                ("GIT_TERMINAL_PROMPT", "0"),
                ("GIT_ATTR_NOSYSTEM", "1"),
                ("GIT_NO_REPLACE_OBJECTS", "1"),
            ]
            .into_iter()
            .chain(routes.iter().copied())
            .map(|(key, value)| (key.into(), value.into())),
        );
        let output = self
            .process
            .git(&GitCall {
                cwd: root.into(),
                args: fixed.iter().chain(args).map(|&arg| arg.into()).collect(),
                env,
                timeout_ms: 5000,
                max_bytes: MAX_OUTPUT,
            })
            .map_err(|_| invalid("bounded Git command failed"))?;
        if output.len() > MAX_OUTPUT {
            return Err(invalid("Git output exceeds its byte limit"));
        }
        Ok(output)
    }

    fn discover(&self, root: &Path, args: &[&str]) -> R<PathBuf> {
        let stdout = self.command(root, args, &[])?;
        self.metadata(root, git_line(&stdout))
    }

    fn metadata(&self, root: &Path, value: &str) -> R<PathBuf> {
        if value.is_empty() || value.contains(['\0', '\r', '\n']) {
            return Err(invalid("invalid Git metadata path"));
        }
        let canonical = self.files.repository_metadata(root, value)?;
        if !canonical.is_absolute() {
            return Err(invalid("Git metadata path must be absolute"));
        }
        Ok(canonical)
    }

    fn capture(&self, root: &Path) -> R<String> {
        let path = self.files.scratch()?;
        let (scratch_compare, root_compare) = if self.windows {
            (
                PathBuf::from(path_text(&path)?.to_lowercase()),
                PathBuf::from(path_text(root)?.to_lowercase()),
            )
        } else {
            (path.clone(), root.to_path_buf())
        };
        if !path.is_absolute()
            || !root.is_absolute()
            || scratch_compare.starts_with(&root_compare)
            || root_compare.starts_with(&scratch_compare)
        {
            return Err(invalid("independent Git scratch directory required"));
        }
        let scratch = Scratch {
            path,
            files: self.files,
        };
        let metadata = scratch.path.join("git");
        let template = scratch.path.join("template");
        let index = scratch.path.join("index");
        let format = self.command(root, &["rev-parse", "--show-object-format"], &[])?;
        let format = git_line(&format);
        let id_len = match format {
            "sha1" => 40,
            "sha256" => 64,
            _ => return Err(invalid("unsupported Git object format")),
        };
        let objects = self.discover(root, &["rev-parse", "--git-path", "objects"])?;
        let source = self.discover(root, &["rev-parse", "--git-path", "index"])?;
        let has_index = self.files.copy_index(&source, &index, MAX_INDEX)?;
        self.files.mkdir(&template)?;
        self.command(
            root,
            &[
                "init",
                "--bare",
                &format!("--template={}", path_text(&template)?),
                &format!("--object-format={format}"),
                path_text(&metadata)?,
            ],
            &[],
        )?;
        self.files.mkdir(&metadata.join("info"))?;
        self.files.write(
            &metadata.join("info/attributes"),
            b"* -filter -text -eol -ident -working-tree-encoding\n",
        )?;
        let shared = self.command(root, &["rev-parse", "--shared-index-path"], &[])?;
        let shared = git_line(&shared);
        if !shared.is_empty() {
            let source = self.metadata(root, shared)?;
            let basename = Path::new(shared)
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| invalid("invalid Git shared index name"))?;
            let suffix = basename
                .strip_prefix("sharedindex.")
                .ok_or_else(|| invalid("invalid Git shared index name"))?;
            object_id(suffix, id_len)?;
            if !self
                .files
                .copy_index(&source, &metadata.join(basename), MAX_INDEX)?
            {
                return Err(invalid("Git shared index changed during diff"));
            }
        }
        let private_objects = metadata.join("objects");
        let alternate = quoted_path(path_text(&objects)?);
        let routes = [
            ("GIT_DIR", path_text(&metadata)?),
            ("GIT_WORK_TREE", path_text(root)?),
            ("GIT_INDEX_FILE", path_text(&index)?),
            ("GIT_OBJECT_DIRECTORY", path_text(&private_objects)?),
            ("GIT_ALTERNATE_OBJECT_DIRECTORIES", &alternate),
        ];
        let git = |args: &[&str]| self.command(root, args, &routes);
        // The port reports empty stdout only for the documented missing HEAD outcome.
        let head = self.command(root, &["rev-parse", "--verify", "--quiet", "HEAD"], &[])?;
        let base = if head.is_empty() {
            let empty = git(&["hash-object", "-w", "-t", "tree", "--stdin"])?;
            object_id(&empty, id_len)?.to_owned()
        } else {
            let id = object_id(&head, id_len)?;
            self.files
                .write(&metadata.join("HEAD"), format!("{id}\n").as_bytes())?;
            id.to_owned()
        };
        if !has_index {
            git(&["read-tree", "--empty"])?;
        }
        git(&["add", "--update", "--"])?;
        git(&["add", "--renormalize", "--update", "--"])?;
        git(&[
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--binary",
            &base,
            "--",
        ])
    }
}

impl super::actions::WorktreeDiff for GitView<'_> {
    fn worktree_diff(&self, root: &crate::policy::fs_paths::CanonicalPath) -> R<String> {
        self.capture(Path::new(root.canonical()))
    }
}

#[cfg(test)]
#[path = "git_view_vectors.rs"]
mod vectors;
