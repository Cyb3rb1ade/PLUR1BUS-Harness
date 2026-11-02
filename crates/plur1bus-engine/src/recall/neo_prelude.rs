//! CA5-owned Neo prelude port. T5 consumes a trait, not a Neo implementation.

use super::render::RenderError;
use crate::text::js::JsString;

/// The caller supplies the visible query and selected memory texts for global dedupe.
pub struct NeoRequest<'a> {
    /// Current visible query.
    pub prompt: &'a str,
    /// Texts already selected by the ordinary recall pipeline.
    pub exclude_texts: &'a [JsString],
    /// Read-only warming: no injection mark or hook counter may be persisted.
    pub warm_only: bool,
}

/// CA5 implements the read, lane and dedupe policy; T5 merely places its text.
pub trait NeoPrelude: Send + Sync {
    /// On a warm request the returned text is discarded; implementations must not write.
    fn read(&self, request: &NeoRequest<'_>) -> Result<JsString, RenderError>;
}
