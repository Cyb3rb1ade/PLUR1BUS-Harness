//! Human coding advisory outputs and bounded diff paging.
use super::gate::{GateGit, WorktreeFiles, MANIFESTS};
use super::sessions::{CodingSessions, SessionPorts};
use super::verifier::{detect_verifiers, CheckKind, Verifier, VerifierResult, MAX_VERIFIER_OUTPUT};
use crate::collab::{CollabError, CollabErrorCode as C};
use crate::logs::methods::AbortSignal;
use crate::policy::fs_paths::{CanonicalPath, FileKind};
use crate::rbac::types::Principal;
use crate::sessions::store::SessionStore;
use crate::toolcall::json::{parse, V};
use serde::Serialize;
use std::collections::BTreeMap;

type R<T> = Result<T, CollabError>;

/// A bounded page of redacted diff text in UTF-16 offsets.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffPage {
    /// Authorized coding session.
    pub session_id: String,
    /// Provenance of this patch.
    pub source: &'static str,
    /// Whole Unicode code points.
    pub diff: String,
    /// Start position.
    pub offset: usize,
    /// Resume position, when more text remains.
    pub next_offset: Option<usize>,
}

fn invalid(message: &str) -> CollabError {
    CollabError::new(C::Invalid, message)
}

fn page(session: &str, source: &'static str, patch: &str, offset: i64, limit: i64) -> R<DiffPage> {
    let units: Vec<_> = patch.encode_utf16().collect();
    let invalid_page = || invalid("invalid diff page");
    let start = usize::try_from(offset)
        .ok()
        .filter(|start| *start <= units.len())
        .ok_or_else(invalid_page)?;
    let count = usize::try_from(limit)
        .ok()
        .filter(|limit| (1..=65536).contains(limit))
        .ok_or_else(invalid_page)?;
    let low = |idx: usize| {
        units
            .get(idx)
            .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
    };
    if start > 0 && low(start) {
        return Err(invalid("diff offset must not split a Unicode code point"));
    }
    let mut end = start.saturating_add(count).min(units.len());
    if low(end) {
        end += 1;
    }
    let diff = String::from_utf16(&units[start..end]).map_err(|_| invalid("invalid diff page"))?;
    Ok(DiffPage {
        session_id: session.to_owned(),
        source,
        diff,
        offset: start,
        next_offset: (end < units.len()).then_some(end),
    })
}

fn inline_patch(text: Option<&str>) -> R<String> {
    let text = text.ok_or_else(|| CollabError::new(C::NotFound, "tool result not found"))?;
    let parsed = parse(text);
    let mut candidate = parsed.as_ref();
    for _ in 0..4 {
        let Some(value) = candidate.filter(|v| v.as_obj().is_some()) else {
            break;
        };
        if let Some(diff) = value
            .get("diff")
            .and_then(V::as_js)
            .or_else(|| value.get("unifiedDiff").and_then(V::as_js))
        {
            return Ok(diff.lossy());
        }
        candidate = ["value", "data", "result"]
            .into_iter()
            .filter_map(|key| value.get(key))
            .find(|next| !matches!(next, V::Null));
    }
    Err(CollabError::with_reason(
        C::NotFound,
        "this tool result has no inline patch; use /diff for the current worktree",
        "tool-diff-unavailable",
    ))
}

/// Page a tool result's patch and redact all content before clipping it.
pub fn tool_diff(
    session: &str,
    output: Option<&str>,
    offset: i64,
    limit: i64,
    redact: &dyn Fn(&str) -> String,
) -> R<DiffPage> {
    page(
        session,
        "call",
        &redact(&inline_patch(output)?),
        offset,
        limit,
    )
}

fn release_advisory_output(
    mut result: VerifierResult,
    redact: &dyn Fn(&str) -> String,
) -> VerifierResult {
    let output = (result.output.len() <= MAX_VERIFIER_OUTPUT)
        .then(|| redact(&result.output))
        .filter(|text| text.len() <= MAX_VERIFIER_OUTPUT);
    if let Some(output) = output {
        result.output = output;
    } else {
        result.ok = false;
        result.reason = Some("output-limit".to_owned());
        result.output.clear();
    }
    result
}

/// Produces the diff through a private index and read-only object alternates.
pub trait WorktreeDiff {
    /// Returns bounded working bytes for the verified native checkout.
    fn worktree_diff(&self, root: &CanonicalPath) -> R<String>;
}

/// Authorization for the current human action.
pub struct ActionInput<'a> {
    /// Session already bound by the coding service.
    pub session: &'a str,
    /// Live authenticated person.
    pub who: &'a Principal,
    /// Linked caller identity, if needed by a legacy session.
    pub caller: Option<&'a str>,
    /// The session task observed on the authenticated connection.
    pub task: Option<&'a str>,
}

/// Advisory check result. It conveys no card completion or review evidence.
pub struct Advisory {
    /// Whether the requested checks passed.
    pub ok: bool,
    /// Whether the operation was cancelled before the requested checks ended.
    pub aborted: bool,
    /// Redacted results in plan order.
    pub checks: Vec<(CheckKind, VerifierResult)>,
}

/// Human-only check and diff operations, revalidating the live coding binding.
pub struct CodingActions<'a, 'ports> {
    /// Session authority and presence.
    pub coding: &'a CodingSessions,
    /// Store used by this session.
    pub store: &'a SessionStore,
    /// Authority ports for a fresh root check.
    pub sessions: &'a SessionPorts<'ports>,
    /// Verified manifest reads.
    pub files: &'a dyn WorktreeFiles,
    /// Committed manifest reads.
    pub git: &'a dyn GateGit,
    /// Sandboxed check execution.
    pub verifier: &'a dyn Verifier,
    /// Scratch index and diff port.
    pub git_view: &'a dyn WorktreeDiff,
    /// Current host egress decision for committed project conventions.
    pub network_approved: bool,
    /// Redacts every released output.
    pub redact: &'a dyn Fn(&str) -> String,
}

impl CodingActions<'_, '_> {
    fn root(&self, input: &ActionInput<'_>) -> R<CanonicalPath> {
        Ok(self
            .coding
            .require_root(
                input.session,
                input.who,
                input.caller,
                input.task,
                self.store,
                self.sessions,
            )?
            .root)
    }

    /// Run advisory checks in the coding session; a live model turn owns the workspace until it stops.
    pub fn check(
        &self,
        input: &ActionInput<'_>,
        kind: Option<CheckKind>,
        abort: &AbortSignal,
    ) -> R<Advisory> {
        let path = self.root(input)?;
        if self
            .store
            .running_turn(input.session)
            .map_err(|_| CollabError::new(C::Storage, "coding session could not be read"))?
            .is_some()
        {
            return Err(CollabError::with_reason(
                C::Conflict,
                "finish or cancel the model turn before running human checks",
                "session-busy",
            ));
        }
        let root = path.canonical();
        let head = self
            .git
            .read(root, &["rev-parse", "--verify", "--quiet", "HEAD"])
            .ok();
        let head = head.as_deref().map(super::root::git_line).filter(|head| {
            matches!(head.len(), 40 | 64) && head.bytes().all(|b| b.is_ascii_hexdigit())
        });
        let mut files = BTreeMap::new();
        let mut committed = head.is_some();
        const CAP: usize = 1_048_576;
        for name in MANIFESTS {
            let outside = || {
                CollabError::new(
                    C::Unauthorized,
                    "verifier convention is outside the worktree or exceeds 1 MiB",
                )
            };
            if self
                .files
                .metadata(root, name)?
                .is_some_and(|m| m.kind != FileKind::File || m.size > CAP as u64 || m.links != 1)
            {
                return Err(outside());
            }
            let text = self
                .files
                .read(root, name, CAP)?
                .map(|b| {
                    if b.len() > CAP {
                        return Err(outside());
                    }
                    String::from_utf8(b)
                        .map_err(|_| invalid("invalid or unsupported project verifier conventions"))
                })
                .transpose()?;
            let original = match head {
                Some(head) => self.git.committed(root, head, name)?,
                None => None,
            };
            committed &= original == text;
            if let Some(text) = text {
                files.insert((*name).to_owned(), text);
            }
        }
        let plan = detect_verifiers(&files, self.files.windows()).map_err(|_| {
            CollabError::with_reason(
                C::Invalid,
                "invalid or unsupported project verifier conventions",
                "verifier-conventions",
            )
        })?;
        let mut checks = vec![];
        for command in plan
            .commands
            .iter()
            .filter(|command| kind.is_none_or(|kind| command.kind == kind))
        {
            if abort.is_aborted() {
                break;
            }
            let result = self.verifier.run(
                root,
                command,
                committed && plan.network_allowed && self.network_approved,
                abort,
            );
            checks.push((command.kind, release_advisory_output(result, self.redact)));
            if abort.is_aborted() {
                break;
            }
            if self.root(input)?.canonical() != root {
                return Err(CollabError::new(
                    C::Unauthorized,
                    "coding root changed during verification",
                ));
            }
        }
        let aborted = abort.is_aborted();
        Ok(Advisory {
            ok: !aborted && !checks.is_empty() && checks.iter().all(|(_, check)| check.ok),
            aborted,
            checks,
        })
    }

    /// Read and page a bound tool patch or a working diff without upgrading the caller's authority.
    pub fn diff(
        &self,
        input: &ActionInput<'_>,
        call: Option<&str>,
        offset: i64,
        limit: i64,
    ) -> R<DiffPage> {
        let root = self.root(input)?;
        if let Some(call) = call {
            let output = self.store.tool_result(input.session, call).map_err(|_| {
                CollabError::new(C::Storage, "coding tool result could not be read")
            })?;
            tool_diff(input.session, output.as_deref(), offset, limit, self.redact)
        } else {
            let patch = self.git_view.worktree_diff(&root)?;
            if self.root(input)?.canonical() != root.canonical() {
                return Err(CollabError::new(
                    C::Unauthorized,
                    "coding root changed during diff",
                ));
            }
            page(
                input.session,
                "worktree",
                &(self.redact)(&patch),
                offset,
                limit,
            )
        }
    }
}

#[cfg(test)]
#[path = "action_vectors.rs"]
mod vectors;
