//! Bounded C4 source acquisition for A1 curation; no source is ACL-filtered before cross-file latest.
use super::{
    curation,
    merged::{optional, Layout, MetadataReader},
    merged_order, revision_io,
};
use crate::{
    context::RequestContext,
    contract::{Cancel, EngineError, StoreError},
    store::directory::TrustedDirectory,
    text::json::{parse_json, TolerantJsonValue as Json},
};

fn read(
    dir: Option<&TrustedDirectory>,
    file: &str,
    ctx: &RequestContext,
    cancel: &Cancel,
    budget: &mut usize,
) -> Result<Vec<String>, EngineError> {
    let Some(dir) = dir else { return Ok(vec![]) };
    let Some(bytes) = super::journal_io::bytes(dir, file, cancel)? else {
        return Ok(vec![]);
    };
    *budget += bytes.len();
    if *budget > 64 * 1024 * 1024 {
        return Err(StoreError::Corrupt.into());
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| StoreError::Corrupt)?;
    let mut lines = text
        .rsplit('\n')
        .filter(|s| !s.is_empty())
        .take(10_000)
        .collect::<Vec<_>>();
    lines.reverse();
    for line in &lines {
        cancel.check()?;
        let row = parse_json(line).map_err(|_| StoreError::Corrupt)?;
        // Validation only: never use this single-row ACL result to filter source revisions.
        let _ = curation::queue(std::slice::from_ref(&row), &[], ctx, cancel)?;
    }
    Ok(lines.into_iter().map(str::to_owned).collect())
}
fn merged(canonical: &[String], legacy: &[String]) -> Result<Vec<Json>, EngineError> {
    let rows = if legacy.is_empty() {
        // C4 keeps canonical-only duplicate rows until the final A1 queue resolves them.
        let mut rows = canonical
            .iter()
            .map(|s| {
                parse_json(s)
                    .map(|metadata| merged_order::Sourced {
                        metadata,
                        legacy: false,
                    })
                    .map_err(|_| EngineError::from(StoreError::Corrupt))
            })
            .collect::<Result<Vec<_>, _>>()?;
        rows.sort_by(|a, b| {
            merged_order::time(&a.metadata, false)
                .partial_cmp(&merged_order::time(&b.metadata, false))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        rows
    } else {
        merged_order::merge(canonical, legacy)
    };
    Ok(merged_order::select(rows, 10_000)
        .into_iter()
        .map(|v| v.metadata)
        .collect())
}
impl MetadataReader {
    /// Read actual C4 candidate/behavior files and project a human A1 curation list.
    /// No files, locks, indexes or vector sidecars are created. The caller supplies its original
    /// authenticated context; its workspace must match this held reader. Opaque UTF-16 stays
    /// native data, not a frozen wire result. At most 64 MiB across all source files is accepted.
    pub fn read_curation(
        &self,
        limit: Option<f64>,
        ctx: &RequestContext,
        cancel: &Cancel,
    ) -> Result<Json, EngineError> {
        // Origin, cancellation and query bounds precede filesystem reads.
        let _ = curation::list(&[], &[], ctx, limit, cancel)?;
        self.with_curation_sources(ctx, cancel, |a, b| curation::list(a, b, ctx, limit, cancel))
    }
    pub(crate) fn curation_records(
        &self,
        ctx: &RequestContext,
        cancel: &Cancel,
    ) -> Result<Vec<Json>, EngineError> {
        self.with_curation_sources(ctx, cancel, |a, b| curation::queue(a, b, ctx, cancel))
    }
    fn with_curation_sources<T>(
        &self,
        ctx: &RequestContext,
        cancel: &Cancel,
        project: impl FnOnce(&[Json], &[Json]) -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        let _ = curation::queue(&[], &[], ctx, cancel)?;
        if Layout::for_key(&ctx.workspace_key).canonical != self.layout.canonical {
            return Err(StoreError::InvalidInput.into());
        }
        self.root.assert_unchanged()?;
        let Some(parent) = optional(self.root.open_child("workspaces"))? else {
            return project(&[], &[]);
        };
        let canonical = optional(parent.open_child(&self.layout.canonical))?;
        let legacy = self
            .layout
            .legacy
            .as_ref()
            .map(|s| optional(parent.open_child(s)))
            .transpose()?
            .flatten();
        if let Some(dir) = &canonical {
            revision_io::guard_pending(dir, cancel)?;
        }
        let mut budget = 0;
        let mut sources = Vec::new();
        for file in ["memory-candidates.jsonl", "behavior-cards.jsonl"] {
            let a = read(canonical.as_ref(), file, ctx, cancel, &mut budget)?;
            let b = read(legacy.as_ref(), file, ctx, cancel, &mut budget)?;
            sources.push(merged(&a, &b)?);
        }
        let result = project(&sources[0], &sources[1])?;
        if let Some(dir) = &canonical {
            revision_io::guard_pending(dir, cancel)?;
            dir.assert_unchanged()?;
        }
        if let Some(dir) = &legacy {
            dir.assert_unchanged()?;
        }
        parent.assert_unchanged()?;
        self.root.assert_unchanged()?;
        cancel.check()?;
        Ok(result)
    }
}
