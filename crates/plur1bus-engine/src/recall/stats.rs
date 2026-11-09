//! A1 counting happens after the same aggregate render plan consumed by the host.
use super::{blocks::RenderedRecall, inject_budget};
use crate::{
    contract::{Cancel, EngineError, StoreError},
    store::recall_stats::RecallStats,
};
use std::sync::OnceLock;
/// Already authorized returned context. This is an internal composition input, not a wire payload.
pub struct ReturnedRecall<'a> {
    /// Original result blocks and the actual final global cap.
    pub rendered: &'a RenderedRecall,
    /// Agent from the authenticated recall request, never a rendered attribute.
    pub agent: &'a str,
    /// Exact original query; only its keyed digest reaches persistence.
    pub query: &'a str,
    /// Host clock captured after rendering.
    pub now: f64,
    /// Warm operations never count, even if an internal renderer produced records.
    pub warm_only: bool,
    /// Outer scheduler degradation, in addition to render-level degradation.
    pub degraded: bool,
    /// Original caller cancellation; never retry after cancellation.
    pub cancel: &'a Cancel,
}
/// Persist complete final records. Errors are returned separately for best-effort callers.
/// The caller must not replace or discard a successful recall because this side effect failed.
pub fn record_returned(
    stats: &RecallStats,
    request: &ReturnedRecall<'_>,
) -> Result<(), EngineError> {
    if request.warm_only || request.degraded || request.rendered.degraded.is_some() {
        return Ok(());
    }
    request.cancel.check()?;
    let rendered = inject_budget::plan(&request.rendered.blocks, request.rendered.cap_chars);
    static RECORDS: OnceLock<Option<regex::Regex>> = OnceLock::new();
    let regex = RECORDS
        .get_or_init(|| {
            regex::Regex::new(&format!(
        r#"(?is)<memory-record(?-u:\b)[^>]*{}id="([0-9a-f-]{{36}})"[^>]*>.*?</memory-record>"#,
        crate::text::js::JS_WHITESPACE_CLASS
    )).ok()
        })
        .as_ref()
        .ok_or(StoreError::Unavailable)?;
    // ASCII tag matching cannot be synthesized by replacing an unpaired UTF-16 unit.
    let text = rendered.text.to_utf8_lossy();
    let ids = regex
        .captures_iter(&text)
        .filter_map(|capture| capture.get(1).map(|id| id.as_str().to_owned()))
        .take(501)
        .collect::<Vec<_>>();
    // Preserve A1's before-dedupe 500-ID bound. The persistence layer deduplicates one call.
    stats.record(
        request.agent,
        &ids,
        request.query,
        request.now,
        request.cancel,
    )
}
