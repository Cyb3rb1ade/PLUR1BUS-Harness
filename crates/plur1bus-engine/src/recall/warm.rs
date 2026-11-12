//! Read-only warming policy; no writer, ledger or activity hook is available here.

use super::blocks::{RenderDegraded, RenderedRecall};
use super::neo_prelude::{NeoPrelude, NeoRequest};
use super::render::RenderError;
use crate::text::js::JsString;

/// Narrow warm-query inputs after the caller resolves its canonical principal.
pub struct WarmRequest {
    /// Visible query.
    pub prompt: String,
    /// Whether the CA5 read prelude should warm too.
    pub neo_enabled: bool,
    /// The ordinary configured recall limit.
    pub top_n: usize,
    /// Existing automatic workspace-policy decision.
    pub allowed: bool,
}

/// Flags forwarded to the read-only heavy path, matching autoRecallParams.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WarmParameters {
    /// Never create/migrate a table or update canonical cache/graph metrics.
    pub read_only: bool,
    /// Every embedding identity/provider uses only its memory cache.
    pub persist_embeddings: bool,
    /// No retrieval ledger callback.
    pub retrieval_logger: bool,
    /// No query-summary LLM.
    pub query_summarizer: bool,
    /// No emotion inference/state changes.
    pub emotional_state: bool,
    /// Same limit as a normal recall.
    pub top_n: usize,
}

/// Caller-owned read-only leases and heavy pipeline; no store writer is supplied.
pub trait WarmRecall {
    /// Open existing namespaces read-only; false does not create a missing table.
    fn has_table(&self) -> Result<bool, RenderError>;
    /// Honor all read-only/provider-memory flags, including alternate identities.
    fn recall(&mut self, parameters: &WarmParameters) -> Result<(), RenderError>;
}

/// Warm without injecting blocks or updating files, counters or ledger state.
pub fn run(
    request: &WarmRequest,
    recall: &mut dyn WarmRecall,
    neo: &dyn NeoPrelude,
) -> Result<RenderedRecall, RenderError> {
    if !request.allowed {
        return Ok(RenderedRecall::default());
    }
    let long_enough = crate::text::js::utf16_len(&request.prompt) >= 5;
    if request.neo_enabled && long_enough {
        // Neo prelude errors are best-effort like the pin; never fall back to a writing path.
        let _ = neo.read(&NeoRequest {
            prompt: &request.prompt,
            exclude_texts: &[],
            warm_only: true,
        });
    }
    if !long_enough {
        return Ok(RenderedRecall::default());
    }
    let parameters = WarmParameters {
        read_only: true,
        persist_embeddings: false,
        retrieval_logger: false,
        query_summarizer: false,
        emotional_state: false,
        top_n: request.top_n,
    };
    let attempt = recall.has_table().and_then(|exists| {
        if exists {
            recall.recall(&parameters)
        } else {
            Ok(())
        }
    });
    result(attempt)
}

fn result(attempt: Result<(), RenderError>) -> Result<RenderedRecall, RenderError> {
    let degraded = match attempt {
        Ok(()) => None,
        Err(RenderError::Unavailable(detail)) => Some(RenderDegraded {
            reason: "warm-failed".into(),
            capability: "recall".into(),
            detail: super::output_unicode::well_formed(JsString::from(detail).utf16_slice(0, 200)),
        }),
        Err(
            error @ (RenderError::InvalidTimestamp
            | RenderError::InvalidTimezone
            | RenderError::InvalidIndex
            | RenderError::InvalidMemory),
        ) => Some(RenderDegraded {
            reason: "warm-failed".into(),
            capability: "recall".into(),
            detail: error.to_string().into(),
        }),
        Err(RenderError::Aborted) => return Err(RenderError::Aborted),
    };
    Ok(RenderedRecall {
        degraded,
        ..RenderedRecall::default()
    })
}
