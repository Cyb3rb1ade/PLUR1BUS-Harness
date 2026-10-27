//! RE-14/T2: one library token counter, with explicit artifact provenance and estimator bounds.
//! Construction may read installed tokenizer files; counting performs no I/O. No Phase 1 runtime uses this service.

mod artifacts;
mod calibration;
mod calibration_fit;
mod calibration_store;
mod calibration_types;
mod methods;
mod types;

pub use artifacts::TokenizerArtifact;
pub use calibration::normalize_profile_usage;
pub use calibration_store::CalibrationStore;
pub use calibration_types::{
    BaseEstimate, CalibrationError, CalibrationFit, NormalizedTokenUsage, ObservationResult,
    ProfileUsage, PromptCountResult, TokenObservation, BASE_COUNT_VERSION, MAX_CALIBRATION_BYTES,
    MAX_CALIBRATION_COUNT, MAX_CALIBRATION_KEYS, MAX_CALIBRATION_KEY_BYTES,
    MAX_CALIBRATION_OBSERVATIONS, MIN_CALIBRATION_OBSERVATIONS,
};
pub use types::{
    ArtifactState, CalibrationInfo, CountItem, CountRequest, CountResult, CumulativeCount,
    FamilyInfo, ItemCount, TextSegment, TokenBounds, TokenMessage, TokenMethod, TokenRoute,
};

use crate::cache_profiles::{CacheProfileError, CacheProfileTable, CacheRoute};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::Path;
use tokenizers::Tokenizer;

/// Invalid library inputs, bundled metadata or tokenizer encoding; no count is silently dropped.
#[derive(Debug)]
pub enum TokenError {
    /// The provider-owned cache-profile table could not be loaded.
    Profiles(CacheProfileError),
    /// The bundled source list violates the small artifact-source contract.
    Manifest(String),
    /// Missing, ambiguous or malformed count inputs.
    InvalidInput(String),
    /// The verified tokenizer could not encode the supplied text.
    Encoding(String),
    /// Adding counts would exceed the u64 result shape.
    Overflow,
}

impl fmt::Display for TokenError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Profiles(error) => write!(output, "token counter profiles: {error}"),
            Self::Manifest(error) => write!(output, "tokenizer source list: {error}"),
            Self::InvalidInput(error) => write!(output, "token count input: {error}"),
            Self::Encoding(error) => write!(output, "tokenizer encoding: {error}"),
            Self::Overflow => output.write_str("token count exceeds u64"),
        }
    }
}

impl std::error::Error for TokenError {}

/// Loaded tokenizers and provider-family metadata. Raw counting performs no I/O; calibration has explicit edges.
pub struct TokenCounter {
    profiles: CacheProfileTable,
    artifacts: Vec<TokenizerArtifact>,
    families: BTreeMap<String, artifacts::LoadedFamily>,
}

impl TokenCounter {
    /// Construct a counter without reading files; every listed file is explicitly missing.
    pub fn heuristic() -> Result<Self, TokenError> {
        Self::new(None)
    }

    /// Load approved files at `<root>/<artifact-id>/<file>`, checking SHA-256 before deserialization.
    /// Missing, damaged or unapproved files remain explicit estimator states instead of aborting the library.
    pub fn from_directory(root: &Path) -> Result<Self, TokenError> {
        Self::new(Some(root))
    }

    fn new(root: Option<&Path>) -> Result<Self, TokenError> {
        let profiles = CacheProfileTable::bundled().map_err(TokenError::Profiles)?;
        let names = profiles
            .rows()
            .iter()
            .map(|row| row.tokenizer_family.clone())
            .collect();
        let artifacts = artifacts::manifest(&names)?;
        let families = artifacts::load(names, &artifacts, root);
        Ok(Self {
            profiles,
            artifacts,
            families,
        })
    }

    /// Immutable source list; each listed file is pinned and retains its own license metadata.
    pub fn artifacts(&self) -> &[TokenizerArtifact] {
        &self.artifacts
    }

    /// Known families in sorted order, with the loaded method and explicit artifact state.
    pub fn families(&self) -> Vec<FamilyInfo> {
        self.families
            .values()
            .map(|family| family.info.clone())
            .collect()
    }

    /// Count independent items; adjacent segments merge only within their own message boundary.
    /// `exact` covers raw text only; messages/tools are labeled `tokenizer-text` when a file is installed.
    /// Route family selection uses the table's model/platform semantics; full-prompt calibration uses all route fields.
    pub fn count(&self, request: &CountRequest) -> Result<CountResult, TokenError> {
        let family = self.select_family(request)?;
        validate_items(&request.items)?;
        let tokenizer = self
            .families
            .get(&family)
            .and_then(|entry| entry.tokenizer.as_ref());
        let framed = request.items.iter().any(|item| item.text.is_none());
        let method = match (tokenizer.is_some(), framed) {
            (false, _) => TokenMethod::Heuristic,
            (true, false) => TokenMethod::Exact,
            (true, true) => TokenMethod::TokenizerText,
        };
        let mut items = Vec::with_capacity(request.items.len());
        let mut cumulative = request.cumulative.then(Vec::new);
        for item in &request.items {
            let (bounds, prefixes) = count_item(item, tokenizer, request.cumulative)?;
            items.push(ItemCount {
                id: item.id.clone(),
                tokens: bounds.tokens,
                lower: bounds.lower,
                upper: bounds.upper,
            });
            if let Some(cumulative) = &mut cumulative {
                cumulative.extend(prefixes);
            }
        }
        Ok(CountResult {
            family,
            method,
            calibration: CalibrationInfo {
                version: 1,
                observations: 0,
            },
            items,
            cumulative,
        })
    }

    fn select_family(&self, request: &CountRequest) -> Result<String, TokenError> {
        match (&request.family, &request.route) {
            (Some(family), None) if self.families.contains_key(family) => Ok(family.clone()),
            (None, Some(route)) => {
                if [&route.provider, &route.platform, &route.wire, &route.model]
                    .iter()
                    .any(|value| value.is_empty())
                {
                    return Err(invalid("route fields must be nonempty"));
                }
                let cache_route = CacheRoute {
                    platform: Some(route.platform.clone()),
                    ..CacheRoute::default()
                };
                let family = self
                    .profiles
                    .find_cache_profile(&route.model, &cache_route)
                    .row
                    .map_or_else(|| "unknown".to_owned(), |row| row.tokenizer_family.clone());
                if route.platform == "chatgpt-plan" && family == "o200k" {
                    // RE-D20: a plan's generic cache row must not turn an unpublished model tokenizer into o200k.
                    let first_party = CacheRoute {
                        platform: Some("first-party".to_owned()),
                        ..CacheRoute::default()
                    };
                    if let Some(row) = self
                        .profiles
                        .find_cache_profile(&route.model, &first_party)
                        .row
                        .filter(|row| row.tokenizer_family == "openai-unpublished")
                    {
                        return Ok(row.tokenizer_family.clone());
                    }
                }
                Ok(family)
            }
            (Some(_), None) => Err(invalid("unknown tokenizer family")),
            _ => Err(invalid("supply exactly one of family or route")),
        }
    }
}

fn invalid(message: &str) -> TokenError {
    TokenError::InvalidInput(message.to_owned())
}

fn validate_items(items: &[CountItem]) -> Result<(), TokenError> {
    let mut ids = BTreeSet::new();
    for item in items {
        if item.id.is_empty() || !ids.insert(&item.id) {
            return Err(invalid("item ids must be nonempty and unique"));
        }
        if usize::from(item.text.is_some())
            + usize::from(item.messages.is_some())
            + usize::from(item.tools.is_some())
            != 1
        {
            return Err(invalid(
                "each item needs exactly one of text, messages or tools",
            ));
        }
        if item
            .messages
            .as_ref()
            .is_some_and(|messages| messages.iter().any(|message| message.role.is_empty()))
        {
            return Err(invalid("message roles must be nonempty"));
        }
    }
    Ok(())
}

fn count_item(
    item: &CountItem,
    tokenizer: Option<&Tokenizer>,
    cumulative: bool,
) -> Result<(TokenBounds, Vec<CumulativeCount>), TokenError> {
    if let Some(text) = &item.text {
        let count = methods::count_text(tokenizer, text)?;
        return Ok((
            count,
            if cumulative {
                vec![CumulativeCount {
                    id: item.id.clone(),
                    message: 0,
                    counts: vec![count],
                }]
            } else {
                Vec::new()
            },
        ));
    }
    if let Some(tools) = &item.tools {
        let text = serde_json::to_string(tools).map_err(|error| invalid(&error.to_string()))?;
        let count = methods::count_text(tokenizer, &text)?;
        let count = if tokenizer.is_some() {
            methods::visible_template_bounds(count, &text)
        } else {
            count
        };
        return Ok((
            count,
            if cumulative {
                vec![CumulativeCount {
                    id: item.id.clone(),
                    message: 0,
                    counts: vec![count],
                }]
            } else {
                Vec::new()
            },
        ));
    }
    count_messages(item, tokenizer, cumulative)
}

fn count_messages(
    item: &CountItem,
    tokenizer: Option<&Tokenizer>,
    cumulative: bool,
) -> Result<(TokenBounds, Vec<CumulativeCount>), TokenError> {
    let mut total = TokenBounds::default();
    let mut prefixes = Vec::new();
    if let Some(messages) = &item.messages {
        for (index, message) in messages.iter().enumerate() {
            let mut text = String::new();
            let mut counts = Vec::new();
            let mut count = TokenBounds::default();
            if cumulative {
                // A merge across a segment boundary changes the count, so each running total recounts its whole prefix.
                for segment in &message.segments {
                    text.push_str(&segment.text);
                    count = count_message_text(tokenizer, &text)?;
                    counts.push(count);
                }
            } else if !message.segments.is_empty() {
                // Only the message total is returned: count the joined text once, not every growing prefix.
                for segment in &message.segments {
                    text.push_str(&segment.text);
                }
                count = count_message_text(tokenizer, &text)?;
            }
            methods::add(&mut total, count)?;
            if cumulative {
                prefixes.push(CumulativeCount {
                    id: item.id.clone(),
                    message: index,
                    counts,
                });
            }
        }
    }
    Ok((total, prefixes))
}

/// A message's visible text: tokenizer counts carry the template-overhead bounds, the heuristic stays as it is.
fn count_message_text(
    tokenizer: Option<&Tokenizer>,
    text: &str,
) -> Result<TokenBounds, TokenError> {
    let count = methods::count_text(tokenizer, text)?;
    Ok(if tokenizer.is_some() {
        methods::visible_template_bounds(count, text)
    } else {
        count
    })
}
