//! Explicitly authorized process seams. Production configuration never selects them.

use crate::embedding::seam::FlatEmbedder;
use std::{env, fmt};

/// Deterministic embedding variants available to process acceptance tests.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Seam {
    /// A fixed unit vector with no model downloads or reranker.
    FlatEmbedder,
    /// The same vector, with two serialized 350 ms query warm-up calls.
    FlatEmbedderCold,
}

impl Seam {
    /// Reuse the RE-03 provider, including its cancellation-aware cold delay.
    pub fn embedder(self, dimensions: usize) -> FlatEmbedder {
        FlatEmbedder::new(dimensions, self == Self::FlatEmbedderCold)
    }
}

/// A refused or unrecognized seam selection, without echoing environment contents.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SeamError {
    /// Test seams require explicit authorization.
    NotAllowed,
    /// The requested variant is unknown or not valid Unicode.
    UnknownVariant,
}

impl fmt::Display for SeamError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NotAllowed => "test seams require PLUR1BUS_ALLOW_TEST_INTERNALS=1",
            Self::UnknownVariant => "unknown PLUR1BUS_TEST_INTERNALS variant",
        })
    }
}

impl std::error::Error for SeamError {}

/// Parse a CLI or environment selection with its explicit test authorization.
pub fn parse(variant: &str, allow: bool) -> Result<Seam, SeamError> {
    if !allow {
        return Err(SeamError::NotAllowed);
    }
    match variant {
        "flat-embedder" => Ok(Seam::FlatEmbedder),
        "flat-embedder-cold" => Ok(Seam::FlatEmbedderCold),
        _ => Err(SeamError::UnknownVariant),
    }
}

/// Read the requested process seam, refusing any selection without the exact allow flag.
/// An absent selection never enables a seam, even when the allow flag is present.
pub fn from_env() -> Result<Option<Seam>, SeamError> {
    let Some(variant) = env::var_os("PLUR1BUS_TEST_INTERNALS") else {
        return Ok(None);
    };
    let allow =
        env::var_os("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() == Some(std::ffi::OsStr::new("1"));
    if !allow {
        return Err(SeamError::NotAllowed);
    }
    parse(variant.to_str().ok_or(SeamError::UnknownVariant)?, allow).map(Some)
}

/// Private fault selection for process-level accept cleanup tests.
/// The server consumes it once after binding and publishing its owned run files.
pub(super) fn permission_denied_accept_from_env() -> Result<bool, SeamError> {
    let Some(variant) = env::var_os("PLUR1BUS_TEST_ACCEPT_ERROR") else {
        return Ok(false);
    };
    if env::var_os("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() != Some(std::ffi::OsStr::new("1")) {
        return Err(SeamError::NotAllowed);
    }
    match variant.to_str() {
        Some("permission-denied") => Ok(true),
        _ => Err(SeamError::UnknownVariant),
    }
}
