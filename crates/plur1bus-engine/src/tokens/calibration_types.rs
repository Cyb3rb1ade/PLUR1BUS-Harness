//! Library-only calibration inputs and provenance. Provider JSON and RPC schemas belong to their adapters.

use super::{CalibrationInfo, CountResult, TokenBounds, TokenMethod, TokenRoute};
use serde::{Deserialize, Serialize};
use std::{fmt, io};

/// Maximum retained recent observations per route/family/base-method key.
pub const MAX_CALIBRATION_OBSERVATIONS: usize = 64;
/// Maximum keys; a new key at capacity is refused rather than discarding learned state.
pub const MAX_CALIBRATION_KEYS: usize = 128;
/// Maximum persisted JSON bytes, checked before parsing and before replacement.
pub const MAX_CALIBRATION_BYTES: usize = 1024 * 1024;
/// Maximum UTF-8 bytes in each route component or family name.
pub const MAX_CALIBRATION_KEY_BYTES: usize = 1024;
/// Minimum samples for a fit; at least two distinct base counts are also required.
pub const MIN_CALIBRATION_OBSERVATIONS: usize = 6;
/// Largest exact integer accepted for floating-point learning; prediction saturates safely at u64 limits.
pub const MAX_CALIBRATION_COUNT: u64 = (1_u64 << 53) - 1;
/// Counting algorithm and artifact identity version; incompatible observations must not be mixed.
pub const BASE_COUNT_VERSION: u32 = 1;

/// Invalid calibration inputs, incompatible state or a failed transactional persistence boundary.
#[derive(Debug)]
pub enum CalibrationError {
    /// Filesystem failure; the prior state is retained when an observation fails.
    Io(io::Error),
    /// Another store owns the state directory; retry after its handle is dropped.
    Locked,
    /// The state JSON is corrupt or has an unknown field; repair it explicitly before reopening.
    Malformed(serde_json::Error),
    /// The persisted format is not supported; use a compatible engine.
    UnsupportedVersion(u32),
    /// Invalid key, base provenance or count, rejected before mutation.
    InvalidObservation(&'static str),
    /// The key limit was reached; existing learned routes remain intact.
    Capacity,
    /// The serialized state exceeds the bounded parser or writer budget.
    TooLarge,
    /// Exclusive numeric usage components exceed u64 when added.
    Overflow,
}

impl fmt::Display for CalibrationError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(output, "token calibration state: {error}"),
            Self::Locked => {
                output.write_str("token calibration store is locked; close its other owner")
            }
            Self::Malformed(error) => write!(output, "invalid token calibration state: {error}"),
            Self::UnsupportedVersion(version) => {
                write!(output, "unsupported token calibration format {version}")
            }
            Self::InvalidObservation(reason) => {
                write!(output, "invalid token calibration observation: {reason}")
            }
            Self::Capacity => output.write_str("token calibration key capacity reached"),
            Self::TooLarge => output.write_str("token calibration state exceeds byte limit"),
            Self::Overflow => output.write_str("token calibration usage sum exceeds u64"),
        }
    }
}

impl std::error::Error for CalibrationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Malformed(error) => Some(error),
            Self::Locked
            | Self::UnsupportedVersion(_)
            | Self::InvalidObservation(_)
            | Self::Capacity
            | Self::TooLarge
            | Self::Overflow => None,
        }
    }
}

/// Adapter-normalized inclusive prompt usage; optional cache counts are subsets, never added again.
/// The supplied total is authoritative even when the adapter cannot report component completeness.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NormalizedTokenUsage {
    /// Inclusive input total; absent means no accepted calibration observation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_total: Option<u64>,
    /// Known cache-read subset, preserving unknown versus explicit zero.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<u64>,
    /// Known cache-write subset, preserving unknown versus explicit zero.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<u64>,
}

/// Host-extracted numeric parts whose meaning is selected by a resolved cache usage map.
/// Never construct this from already-normalized usage; no field-path parsing happens in the engine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProfileUsage {
    /// Inclusive total or uncached input, according to the selected map.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<u64>,
    /// Disjoint cache-read count when input is exclusive.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<u64>,
    /// Disjoint cache-write count when input is exclusive; aggregate or TTL sum, never both.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<u64>,
}

/// A raw, uncalibrated full-prompt sum with its underlying counting algorithm identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BaseEstimate {
    /// Sum of raw item counts before any learned prompt overhead.
    pub tokens: u64,
    /// Underlying method; `calibrated` is rejected to prevent feedback.
    pub method: TokenMethod,
    /// Base counting algorithm version, currently 1; bump for incompatible artifact/count changes.
    pub version: u32,
}

/// One full-prompt base count paired with normalized inclusive usage for its resolved route.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TokenObservation {
    /// All four resolved route fields participate in key isolation, without alias collapsing.
    pub route: TokenRoute,
    /// Family selected for this route by the shared profile table.
    pub family: String,
    /// Uncalibrated prompt sum and provenance.
    pub base: BaseEstimate,
    /// Already-normalized authoritative usage; cache subsets do not affect the target.
    pub reported: NormalizedTokenUsage,
}

/// Outcome of an atomic observation batch; counts refer to supplied observations, not retained history.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationResult {
    /// Known input totals successfully persisted, including explicit zero.
    pub accepted: usize,
    /// Observations ignored because no inclusive input total was reported.
    pub missing_input: usize,
}

/// Robust affine parameters derived from a bounded recent sample window, never a provider guarantee.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationFit {
    /// Median pairwise slope; finite and strictly positive.
    pub slope: f64,
    /// Median of reported minus slope times base; may legitimately be negative.
    pub intercept: f64,
    /// Median absolute residual in tokens, used for empirical uncertainty.
    pub residual: f64,
    /// Smallest base count in the retained observations.
    pub minimum: u64,
    /// Largest base count in the retained observations.
    pub maximum: u64,
    /// Number of retained observations used to derive this fit.
    pub observations: usize,
}

/// One complete prompt prediction alongside unchanged independent item and message-prefix counts.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptCountResult {
    /// Raw count result; its method, item counts and cumulative prefixes are unmodified.
    pub base: CountResult,
    /// Sum of raw items, adjusted once when a usable fit exists.
    pub total: TokenBounds,
    /// `calibrated` only with a usable fit; otherwise the raw base method.
    pub method: TokenMethod,
    /// Base counting version and retained observation count, including sparse/degenerate history.
    pub calibration: CalibrationInfo,
    /// Learned prompt parameters when usable; absent for a raw fallback.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fit: Option<CalibrationFit>,
}
