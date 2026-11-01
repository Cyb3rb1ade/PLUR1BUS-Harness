//! Local media embedding building blocks, independent of text providers, stores and RPC.
//!
//! Media preprocessing and encoders are called by background jobs only (MM-1/E1).

/// Immutable media encoder files, verified before native loading.
pub mod artifacts;
/// Finite mono audio windows and pinned log-Mel preprocessing.
pub mod audio;
/// Background image, audio and video embedding with explicit cancellation.
pub mod embedder;
mod fft;
/// Media vector-space identity, including preprocessing and dtype.
pub mod identity;
/// Bounded image decoding and patchification for EmbeddingGemma 2.
pub mod image;
mod resize;
/// Explicit deterministic test boundary; production selects the local encoder.
pub mod seam;
/// Independent CPU ONNX slots for media roles.
pub mod session;
/// Uniform bounded frame sampling and vision batches.
pub mod video;

pub use embedder::{
    LocalMediaEmbedder, MediaEmbedder, MediaEmbedding, MediaError, MediaInput, MediaModality,
    MediaSegment, VideoFrame,
};
