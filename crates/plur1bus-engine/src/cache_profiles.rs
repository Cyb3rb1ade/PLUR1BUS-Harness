//! Provider-owned prompt-cache facts and model/URL lookup, shared with TypeScript (RE-D21, RE-14/T1).
//! This module only loads and queries data. No engine runtime consumes it in Phase 1 (RE-R1).

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fmt;
use url::Url;

const TABLE: &str = include_str!("../../../packages/providers/schema/cache-profiles.json");
const SCHEMA: &str = include_str!("../../../packages/providers/schema/cache-profiles.schema.json");

/// A failure to load the provider-owned table; no partially validated table is returned.
#[derive(Debug)]
pub enum CacheProfileError {
    /// Invalid JSON in the table or schema.
    Json(serde_json::Error),
    /// The table or the schema does not satisfy the shared JSON Schema contract.
    Schema(String),
    /// Two rows use the same identifier.
    DuplicateRowId(String),
    /// A row's model pattern cannot be compiled.
    InvalidMatchPattern(String),
    /// A host pattern cannot be compiled.
    InvalidHostPattern(String),
    /// Explicit rows need positive breakpoint counts; implicit rows need zero.
    InconsistentBreakpoints(String),
    /// A fixed model-normalization expression cannot be compiled.
    NormalizerPattern(regex::Error),
}

impl fmt::Display for CacheProfileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("cache-profiles.json: ")?;
        match self {
            Self::Json(error) => write!(formatter, "invalid JSON: {error}"),
            Self::Schema(error) => formatter.write_str(error),
            Self::DuplicateRowId(id) => write!(formatter, "duplicate row id {id}"),
            Self::InvalidMatchPattern(id) => {
                write!(formatter, "row {id} has an invalid match pattern")
            }
            Self::InvalidHostPattern(pattern) => {
                write!(formatter, "host pattern {pattern} is invalid")
            }
            Self::InconsistentBreakpoints(id) => {
                write!(formatter, "row {id}: only explicit rows have breakpoints")
            }
            Self::NormalizerPattern(error) => {
                write!(formatter, "invalid normalizer pattern: {error}")
            }
        }
    }
}

impl std::error::Error for CacheProfileError {}

/// A selectable TTL tier. Null price multipliers mean undocumented, rather than zero.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CacheTtlEntry {
    /// TTL label from the shared schema.
    pub ttl: String,
    /// Write-price multiple of base input, when documented.
    pub write: Option<f64>,
    /// Read-price multiple of base input, when documented.
    pub read: Option<f64>,
    /// Accepted wires; absent means every wire of the row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wires: Option<Vec<String>>,
}

/// A session-affinity field accepted by a provider or gateway.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CacheAffinity {
    /// Wire field or header name.
    pub field: String,
    /// Field location, serialized as `in` (`body` or `header`).
    #[serde(rename = "in")]
    pub location: String,
    /// Maximum key length, or null when undocumented.
    pub max_length: Option<u64>,
    /// Accepted wires; absent means every wire of the row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wires: Option<Vec<String>>,
}

/// Usage-field metadata only; the engine does not parse provider usage (RE-D22).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CacheUsageMap {
    /// Candidate cache-read field paths, in preference order.
    pub read: Vec<String>,
    /// Candidate cache-write field paths, in preference order.
    pub write: Vec<String>,
    /// Candidate explicit cache-miss paths, when the provider reports them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub miss: Option<Vec<String>>,
    /// Whether reported input totals include cache reads and writes.
    pub input_includes_cache: bool,
}

/// One validated row, retaining the provider-owned facts and optional-field presence.
/// Enumerated strings are checked against the shared schema before deserialization.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CacheProfileRow {
    /// Stable row identifier.
    pub id: String,
    /// Pattern over the normalized model identifier.
    #[serde(rename = "match")]
    pub model_match: String,
    /// Upstream provider.
    pub provider: String,
    /// Platforms where this row applies.
    pub platforms: Vec<String>,
    /// Provider caching class.
    pub class: String,
    /// Explicit markers or implicit prefix reuse.
    pub mechanism: String,
    /// Smallest cacheable prefix, in tokens.
    pub min_tokens: u64,
    /// Whether the floor counts prefix tokens or visible input.
    pub min_tokens_counts: String,
    /// Behavior of markers below the minimum.
    pub below_minimum: String,
    /// Maximum explicit breakpoints; zero for implicit rows.
    pub max_breakpoints: u64,
    /// Documented cache-read lookback positions.
    pub lookback_positions: u64,
    /// Whether consecutive tool blocks count as one lookback position.
    pub lookback_collapses_runs: bool,
    /// Supported TTL tiers in provider-owned order.
    pub ttls: Vec<CacheTtlEntry>,
    /// Warm-prefix prediction window in milliseconds, or null when unknown.
    pub warm_ms: Option<u64>,
    /// TTL wire-field metadata, or null when the TTL is not sent.
    pub ttl_field: Option<String>,
    /// Session-affinity fields.
    pub affinity: Vec<CacheAffinity>,
    /// Cache usage metadata.
    pub usage: CacheUsageMap,
    /// Request parameters that must remain constant, when specified.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hold_constant: Option<Vec<String>>,
    /// Provider-specific method of avoiding a paid cache write.
    pub suppress_write: String,
    /// Token-counting family identifier.
    pub tokenizer_family: String,
    /// Documentation source.
    pub source: String,
    /// Verification date in YYYY-MM-DD form.
    pub verified: String,
    /// Evidence status (`verified`, `unverified`, or `conflict`).
    pub status: String,
    /// Additional source notes, when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Gateway-specific metadata retained from the shared table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CacheGatewayProfile {
    /// Recognized OpenRouter slug prefixes mapped to upstream providers.
    pub slug_prefixes: HashMap<String, String>,
    /// Gateway session-affinity fields.
    pub affinity: Vec<CacheAffinity>,
    /// Supported marker locations.
    pub markers: Vec<String>,
    /// Upstream providers receiving explicit markers, when specified.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker_providers: Option<Vec<String>>,
    /// Whether the gateway forwards TTL markers.
    pub ttl_forwarded: String,
    /// Gateway usage-field metadata.
    pub usage: CacheUsageMap,
    /// Documentation source.
    pub source: String,
    /// Verification date.
    pub verified: String,
    /// Evidence status.
    pub status: String,
    /// Additional source notes, when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Known facts about a request route; absent facts stay absent on serialization.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CacheRoute {
    /// Explicit gateway override (`direct` or `openrouter`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway: Option<String>,
    /// Explicit platform override.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    /// A true local override takes precedence over every platform hint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local: Option<bool>,
    /// Provider reached through its own API; independent of row selection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
}

/// A normalized model identifier and route hints inferred from its decoration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NormalizedModelRef {
    /// Lowercase model identifier, dots replaced with dashes and one served alias applied.
    pub id: String,
    /// Gateway inferred from a known slug prefix.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway: Option<String>,
    /// Platform inferred from a Bedrock or Google decorated model identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
}

/// The first matching row and the effective route, including unmatched model identifiers.
#[derive(Debug)]
pub struct CacheProfileMatch<'a> {
    /// The matching row, or none when this platform/model pair is unknown.
    pub row: Option<&'a CacheProfileRow>,
    /// Model normalization result, retaining hints even when the route overrides them.
    pub model_ref: NormalizedModelRef,
    /// Effective platform (`local` overrides explicit and inferred platform hints).
    pub platform: String,
    /// Effective gateway (explicit overrides inferred, with `direct` as default).
    pub gateway: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TableData {
    version: u64,
    aliases: Vec<Alias>,
    hosts: Vec<Host>,
    rows: Vec<CacheProfileRow>,
    gateways: Gateways,
}

#[derive(Debug, Deserialize)]
struct Alias {
    from: String,
    to: String,
}

#[derive(Debug, Deserialize)]
struct Host {
    pattern: String,
    #[serde(flatten)]
    route: CacheRoute,
}

#[derive(Debug, Deserialize)]
struct Gateways {
    openrouter: CacheGatewayProfile,
}

/// A schema-validated, compiled table. Construction performs no filesystem or network I/O.
#[derive(Debug)]
pub struct CacheProfileTable {
    /// Shared table format version.
    pub version: u64,
    rows: Vec<CacheProfileRow>,
    openrouter: CacheGatewayProfile,
    aliases: HashMap<String, String>,
    matchers: Vec<Regex>,
    hosts: Vec<(Regex, CacheRoute)>,
    bedrock: Regex,
    google: Regex,
    suffix: Regex,
}

impl CacheProfileTable {
    /// Validated rows in first-match order; immutable so compiled matchers remain aligned.
    pub fn rows(&self) -> &[CacheProfileRow] {
        &self.rows
    }

    /// OpenRouter gateway metadata and recognized model-slug prefixes.
    pub fn openrouter(&self) -> &CacheGatewayProfile {
        &self.openrouter
    }

    /// Load the table embedded at compile time, validating its shared schema and invariants.
    pub fn bundled() -> Result<Self, CacheProfileError> {
        let raw = serde_json::from_str(TABLE).map_err(CacheProfileError::Json)?;
        Self::load(&raw)
    }

    /// Validate arbitrary table JSON against the bundled schema, then compile lookup patterns.
    /// Rejects schema violations, duplicate row IDs, invalid patterns and inconsistent breakpoints.
    pub fn load(raw: &Value) -> Result<Self, CacheProfileError> {
        let schema = serde_json::from_str(SCHEMA).map_err(CacheProfileError::Json)?;
        let validator = jsonschema::validator_for(&schema)
            .map_err(|error| CacheProfileError::Schema(error.to_string()))?;
        if let Some(error) = validator.iter_errors(raw).next() {
            return Err(CacheProfileError::Schema(format!(
                "{}: {error}",
                error.instance_path
            )));
        }
        let data: TableData =
            serde_json::from_value(raw.clone()).map_err(CacheProfileError::Json)?;
        let matchers = compile_rows(&data.rows)?;
        let hosts = data
            .hosts
            .into_iter()
            .map(|host| {
                compile_pattern(&host.pattern)
                    .map(|pattern| (pattern, host.route))
                    .map_err(|_| CacheProfileError::InvalidHostPattern(host.pattern))
            })
            .collect::<Result<_, _>>()?;
        Ok(Self {
            version: data.version,
            rows: data.rows,
            openrouter: data.gateways.openrouter,
            aliases: data.aliases.into_iter().map(|alias| (alias.from, alias.to)).collect(),
            matchers,
            hosts,
            bedrock: Regex::new(r"^(?:(?:us|eu|apac|jp|au|global)\.)?anthropic\.(claude-[a-z0-9.-]+?)(?:-v[0-9]+(?::[0-9]+)?)?$").map_err(CacheProfileError::NormalizerPattern)?,
            google: Regex::new(r"^claude-[^@]+@[0-9]{8}$").map_err(CacheProfileError::NormalizerPattern)?,
            suffix: Regex::new(r":[a-z]+$").map_err(CacheProfileError::NormalizerPattern)?,
        })
    }

    /// Normalize exactly as the TypeScript loader: trim/lowercase, strip known gateway and platform
    /// decoration, replace dots with dashes, then apply one served-model alias.
    pub fn normalize_model_ref(&self, model: &str) -> NormalizedModelRef {
        let mut id = model.trim_matches(is_ecmascript_whitespace).to_lowercase();
        let mut gateway = None;
        let mut platform = None;
        if let Some(slash) = id.find('/') {
            if slash > 0 && self.openrouter.slug_prefixes.contains_key(&id[..slash]) {
                gateway = Some("openrouter".to_owned());
                id = self.suffix.replace(&id[slash + 1..], "").into_owned();
            }
        }
        if let Some(bedrock) = self.bedrock.captures(&id) {
            let normalized = bedrock[1].to_owned();
            id = normalized;
            platform = Some("bedrock".to_owned());
        } else if self.google.is_match(&id) {
            id.truncate(id.find('@').unwrap_or(id.len()));
            platform = Some("google-managed".to_owned());
        }
        id = id.replace('.', "-");
        if let Some(alias) = self.aliases.get(&id) {
            id = alias.clone();
        }
        NormalizedModelRef {
            id,
            gateway,
            platform,
        }
    }

    /// Select the first row matching the effective platform and normalized identifier.
    /// Unknown pairs retain their normalized reference and effective route with no row.
    pub fn find_cache_profile(&self, model: &str, route: &CacheRoute) -> CacheProfileMatch<'_> {
        let model_ref = self.normalize_model_ref(model);
        let platform = if route.local == Some(true) {
            "local".to_owned()
        } else {
            route
                .platform
                .as_ref()
                .or(model_ref.platform.as_ref())
                .map_or_else(|| "first-party".to_owned(), Clone::clone)
        };
        let gateway = route
            .gateway
            .as_ref()
            .or(model_ref.gateway.as_ref())
            .map_or_else(|| "direct".to_owned(), Clone::clone);
        let row = self
            .rows
            .iter()
            .zip(&self.matchers)
            .find_map(|(row, pattern)| {
                (row.platforms.contains(&platform) && pattern.is_match(&model_ref.id))
                    .then_some(row)
            });
        CacheProfileMatch {
            row,
            model_ref,
            platform,
            gateway,
        }
    }

    /// Parse an absolute URL with WHATWG rules, then select the first lowercased hostname match.
    /// Malformed URLs and unknown hosts return an empty route; hostless URLs use an empty hostname.
    pub fn cache_route_for_url(&self, url: &str) -> CacheRoute {
        let Ok(parsed) = Url::parse(url) else {
            return CacheRoute::default();
        };
        let host = parsed.host_str().unwrap_or_default().to_lowercase();
        self.hosts
            .iter()
            .find(|(pattern, _)| pattern.is_match(&host))
            .map_or_else(CacheRoute::default, |(_, route)| route.clone())
    }
}

fn compile_rows(rows: &[CacheProfileRow]) -> Result<Vec<Regex>, CacheProfileError> {
    let mut ids = HashSet::new();
    let mut matchers = Vec::with_capacity(rows.len());
    for row in rows {
        if !ids.insert(&row.id) {
            return Err(CacheProfileError::DuplicateRowId(row.id.clone()));
        }
        matchers.push(
            compile_pattern(&row.model_match)
                .map_err(|_| CacheProfileError::InvalidMatchPattern(row.id.clone()))?,
        );
        if (row.mechanism == "explicit") != (row.max_breakpoints > 0) {
            return Err(CacheProfileError::InconsistentBreakpoints(row.id.clone()));
        }
    }
    Ok(matchers)
}

fn compile_pattern(pattern: &str) -> Result<Regex, regex::Error> {
    // JavaScript \d is ASCII even with `u`; dot excludes all four ECMAScript line terminators.
    // Preserve escaped literals and character classes while translating the table's regex subset.
    let mut translated = String::with_capacity(pattern.len());
    let mut characters = pattern.chars();
    let mut in_class = false;
    while let Some(character) = characters.next() {
        match character {
            '\\' => match characters.next() {
                Some('d') => translated.push_str(if in_class { "0-9" } else { "[0-9]" }),
                Some(escaped) => {
                    translated.push('\\');
                    translated.push(escaped);
                }
                None => translated.push('\\'),
            },
            '[' => {
                in_class = true;
                translated.push('[');
            }
            ']' => {
                in_class = false;
                translated.push(']');
            }
            '.' if !in_class => translated.push_str(r"[^\r\n\x{2028}\x{2029}]"),
            other => translated.push(other),
        }
    }
    Regex::new(&translated)
}

fn is_ecmascript_whitespace(character: char) -> bool {
    // ECMAScript TrimString includes BOM and excludes Rust's U+0085 NEXT LINE.
    matches!(character, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}'
        | '\u{3000}' | '\u{feff}')
}
