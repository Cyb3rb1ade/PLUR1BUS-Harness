//! The Core-authorized entry to the optional native media index.

use super::Principal;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The family of an admitted media source.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    /// A static image.
    Image,
    /// A video whose frames are supplied through the host codec port.
    Video,
    /// Audio decoded through the host codec port.
    Audio,
}

/// The evidence used by the Core's caption pipeline.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptionSource {
    /// The production prompt of generated media.
    Prompt,
    /// The user's own caption.
    User,
    /// The result of an admitted captioning provider.
    Auto,
}

/// One source. A production backend must bind path reads to the verified
/// media root and recheck file identity through its storage port before use.
#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum MediaIndexSource {
    /// A path supplied by the authenticated Core.
    Path {
        /// Host-resolved path in the Core's media store.
        path: PathBuf,
    },
    /// A bounded payload already read by the Core.
    Bytes {
        /// Bytes read from the admitted media record.
        bytes: Vec<u8>,
    },
}

/// One indexing operation. Contents and paths have no Debug projection.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaIndexRequest {
    /// Safe identifier in the admitted scope.
    pub media_id: String,
    /// Family selected by Core admission.
    pub kind: MediaKind,
    /// Recorded media MIME type.
    pub mime: String,
    /// Bytes or a host-owned path.
    pub source: MediaIndexSource,
    /// The Core's already authorized principal.
    pub scope: Principal,
    /// Optional caption produced by the Core.
    pub caption: Option<String>,
    /// Provenance of the caption.
    pub caption_source: Option<CaptionSource>,
}

/// State of the request in the media index.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaIndexState {
    /// Segments are durably indexed.
    Indexed,
    /// Index work was accepted for later completion.
    Pending,
    /// The admitted profile has no encoder for this kind.
    UnsupportedKind,
    /// The configured index could not commit the operation.
    Failed,
}

/// Public acknowledgement of the index operation.
#[derive(Serialize)]
pub struct MediaIndexResult {
    /// Number of valid segments admitted by the backend.
    pub segments: u64,
    /// Outcome visible to the Core hook.
    pub state: MediaIndexState,
}
