//! Library-only input and result shapes for RE-14/T2; RE-01/RE-08 own the eventual RPC schema.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How a count was obtained; tokenizer text counts do not claim knowledge of a provider's template.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TokenMethod {
    /// Exact raw-text encoding with a verified tokenizer artifact and no added special tokens.
    Exact,
    /// Exact encoding of visible message/tool text, with unknown provider framing.
    TokenizerText,
    /// The existing UTF-16-character estimate, rounded up at four code units per token.
    Heuristic,
}

/// Why a family can or cannot use a local tokenizer file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArtifactState {
    /// A pinned, permissively licensed file was verified and loaded.
    Present,
    /// A listed file is not installed in the supplied source directory.
    Missing,
    /// No owner approval exists for this family's conditional license.
    LicensePending,
    /// No compatible, approved tokenizer artifact is configured for this family.
    NotConfigured,
    /// The installed file is unreadable or is not a supported tokenizer.
    Invalid,
    /// The installed file differs from its pinned SHA-256.
    HashMismatch,
}

/// The available counting method and artifact state for one table-owned tokenizer family.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyInfo {
    /// Family name, taken from the cache-profile table.
    pub family: String,
    /// Raw-text counting method currently available.
    pub method: TokenMethod,
    /// Explicit availability, license or validation state.
    pub artifact_state: ArtifactState,
    /// The selected artifact's stable identifier, if listed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_id: Option<String>,
    /// Expected file digest, if an artifact is listed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

/// One resolved provider route. No field is used to emit or parse provider protocol data.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TokenRoute {
    /// Provider identifier retained for future route calibration; model/platform select the current table row.
    pub provider: String,
    /// Cache-profile platform, such as `first-party`, `bedrock` or `local`.
    pub platform: String,
    /// Wire identifier retained for future route calibration; the table does not yet select rows by wire.
    pub wire: String,
    /// Served model identifier; the shared normalizer resolves decorated aliases.
    pub model: String,
}

/// A visible text segment inside one message; adjacent segments are encoded as a joined prefix.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TextSegment {
    /// Visible text. Cache-intent fields belong to the eventual RE-01 contract, not this library input.
    pub text: String,
}

/// Visible text belonging to one message boundary; no chat template is invented by the counter.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TokenMessage {
    /// Role label retained as context; it is not silently rendered into a provider template.
    pub role: String,
    /// Text segments in their original order.
    pub segments: Vec<TextSegment>,
}

/// One independent item, containing exactly one of text, messages or a JSON tool block.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CountItem {
    /// Unique nonempty identifier within the batch.
    pub id: String,
    /// Raw visible text, encoded without provider framing.
    pub text: Option<String>,
    /// Each message is encoded separately so merges never cross its boundary.
    pub messages: Option<Vec<TokenMessage>>,
    /// JSON tool block, encoded as its compact serialization without provider framing.
    pub tools: Option<Value>,
}

/// A batched count selected by exactly one of an explicit family or a resolved route.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CountRequest {
    /// Known table-owned family; mutually exclusive with route.
    pub family: Option<String>,
    /// A model route resolved through the shared cache-profile table.
    pub route: Option<TokenRoute>,
    /// Independent, uniquely identified message-boundary items.
    pub items: Vec<CountItem>,
    /// Include running counts after each segment within each message.
    #[serde(default)]
    pub cumulative: bool,
}

/// Token count and uncertainty bounds. Unpublished provider framing has no finite proven bound.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenBounds {
    /// Measured or estimated visible-text token count.
    pub tokens: u64,
    /// Lower bound for the visible-text estimate.
    pub lower: u64,
    /// Conservative visible-text bound; not a guarantee about hidden provider framing.
    pub upper: u64,
}

/// Count and bounds for one independently encoded input item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemCount {
    /// Input item identifier.
    pub id: String,
    /// Measured or estimated visible-text token count.
    pub tokens: u64,
    /// Lower bound.
    pub lower: u64,
    /// Upper bound.
    pub upper: u64,
}

/// Counts of successive joined segment prefixes within one message, reset at each boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CumulativeCount {
    /// Input item identifier.
    pub id: String,
    /// Zero-based message index within the item (zero for raw text or tools).
    pub message: usize,
    /// One recount after each appended segment; these are not additive token deltas.
    pub counts: Vec<TokenBounds>,
}

/// Calibration state; RE-14/T2 has no observations or learned adjustments.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationInfo {
    /// Library count algorithm version.
    pub version: u32,
    /// Always zero until RE-14/T3 adds observation-based calibration.
    pub observations: u64,
}

/// A single-family batch result with the count provenance visible to consumers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CountResult {
    /// Selected table family, or `unknown` for an unmatched route.
    pub family: String,
    /// Least precise method used for any item in this batch.
    pub method: TokenMethod,
    /// Version and observation count.
    pub calibration: CalibrationInfo,
    /// Independently encoded item counts.
    pub items: Vec<ItemCount>,
    /// Requested per-message running prefix counts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cumulative: Option<Vec<CumulativeCount>>,
}
