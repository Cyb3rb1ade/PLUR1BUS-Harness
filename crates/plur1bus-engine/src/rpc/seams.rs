//! Explicitly authorized process seams. Production configuration never selects them.

use crate::{
    embedding::{seam::FlatEmbedder, EmbedError, EmbeddingProvider, VectorSpaceIdentity},
    recall::hash_embed::HashEmbedder,
};
use std::{env, ffi::OsStr, fmt};

/// Deterministic embedding variants available to process acceptance tests.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Seam {
    /// A fixed unit vector with no model downloads or reranker.
    FlatEmbedder,
    /// The same vector, with two serialized 350 ms query warm-up calls.
    FlatEmbedderCold,
    /// RE-04's deterministic 384-dimensional hash vectors.
    HashEmbedder,
}

impl Seam {
    /// Reuse the RE-03 provider, including its cancellation-aware cold delay.
    pub fn embedder(
        self,
        dimensions: usize,
        identity: &VectorSpaceIdentity,
    ) -> Result<Box<dyn EmbeddingProvider>, EmbedError> {
        match self {
            Self::FlatEmbedder | Self::FlatEmbedderCold => Ok(Box::new(
                FlatEmbedder::new(dimensions, self == Self::FlatEmbedderCold)
                    .bind_identity(identity)?,
            )),
            Self::HashEmbedder => Ok(Box::new(HashEmbedder::new().bind_identity(identity)?)),
        }
    }
}

/// A refused or unrecognized seam selection, without echoing environment contents.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SeamError {
    /// Test seams require explicit authorization.
    NotAllowed,
    /// The requested variant is unknown or not valid Unicode.
    UnknownVariant,
    /// The offline clock was not a nonnegative JavaScript-safe epoch integer.
    InvalidClock,
}

impl fmt::Display for SeamError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NotAllowed => "test seams require PLUR1BUS_ALLOW_TEST_INTERNALS=1",
            Self::UnknownVariant => "unknown PLUR1BUS_TEST_INTERNALS variant",
            Self::InvalidClock => "PLUR1BUS_TEST_CLOCK_MS must be a nonnegative safe integer",
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
        "hash-embedder" => Ok(Seam::HashEmbedder),
        _ => Err(SeamError::UnknownVariant),
    }
}

/// Read the requested process seam, refusing any selection without the exact allow flag.
/// An absent selection never enables a seam, even when the allow flag is present.
pub fn from_env() -> Result<Option<Seam>, SeamError> {
    let Some(variant) = env::var_os("PLUR1BUS_TEST_INTERNALS") else {
        return Ok(None);
    };
    let allow = env::var_os("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() == Some(OsStr::new("1"));
    if !allow {
        return Err(SeamError::NotAllowed);
    }
    parse(variant.to_str().ok_or(SeamError::UnknownVariant)?, allow).map(Some)
}

/// Fix logical host timestamps only after an explicit seam has been authorized.
/// IO deadlines and lifeline timers keep using monotonic time.
pub fn fixture_clock(value: Option<&OsStr>, seam: Option<Seam>) -> Result<Option<i64>, SeamError> {
    let Some(value) = value else { return Ok(None) };
    if seam.is_none() {
        return Err(SeamError::NotAllowed);
    }
    value
        .to_str()
        .and_then(|text| text.parse::<i64>().ok())
        .filter(|now| (0..=9_007_199_254_740_991).contains(now))
        .map(Some)
        .ok_or(SeamError::InvalidClock)
}

/// Private fault selection for process-level accept cleanup tests.
/// The server consumes it once after binding and publishing its owned run files.
pub(super) fn permission_denied_accept_from_env() -> Result<bool, SeamError> {
    let Some(variant) = env::var_os("PLUR1BUS_TEST_ACCEPT_ERROR") else {
        return Ok(false);
    };
    if env::var_os("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() != Some(OsStr::new("1")) {
        return Err(SeamError::NotAllowed);
    }
    match variant.to_str() {
        Some("permission-denied") => Ok(true),
        _ => Err(SeamError::UnknownVariant),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parity_clock_and_hash_require_an_authorized_seam() {
        let instant = OsStr::new("1768305600000");
        assert_eq!(
            fixture_clock(Some(instant), None),
            Err(SeamError::NotAllowed)
        );
        assert_eq!(parse("hash-embedder", false), Err(SeamError::NotAllowed));
        let hash = Seam::HashEmbedder;
        assert_eq!(parse("hash-embedder", true), Ok(hash));
        assert_eq!(
            fixture_clock(Some(instant), Some(hash)),
            Ok(Some(1_768_305_600_000))
        );
        assert_eq!(fixture_clock(None, Some(hash)), Ok(None));
        for invalid in ["-1", "1.25", "9007199254740992"] {
            assert_eq!(
                fixture_clock(Some(OsStr::new(invalid)), Some(hash)),
                Err(SeamError::InvalidClock)
            );
        }
    }
}
