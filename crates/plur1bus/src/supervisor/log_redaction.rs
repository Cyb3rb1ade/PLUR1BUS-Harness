//! SH2: one schema-derived value registry for Supervisor records and every captured child output stream.
use crate::config_redaction::ConfigDisclosurePolicy;
use crate::firstaid_bundle::redact::known_secret_forms;
use crate::paths::Layout;
use serde_json::Value;
use std::collections::{BTreeSet, VecDeque};
use std::fmt;
use std::ops::Range;
use std::sync::{Arc, Mutex, Weak};

const MARKER: &[u8] = b"[REDACTED:secret]";
// SH2 retains the existing Core/bundle minimum for unstructured value matching.
const MIN_SECRET_BYTES: usize = 8;
const MAX_RETIRED_VALUES: usize = 256;
// A pump retains at most one longest-match suffix plus its fixed read buffer, never a whole line.
const MAX_MATCH_BYTES: usize = 64 * 1024;
const MAX_PATTERN_BYTES: usize = 2 * 1024 * 1024;
const MAX_MATCHER_STATES: usize = 128 * 1024;
const UTF8_SUFFIX_BYTES: usize = 3;

/// Value-free failures for unreadable configuration or bounded matcher resources.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Unavailable {
    Config,
    Capacity,
    Matcher,
    Poisoned,
    Utf8,
}

impl fmt::Display for Unavailable {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(match self {
            Self::Config => "configuration is unreadable; repair config.json to resume log output",
            Self::Capacity => "configuration redaction exceeds its bounded matcher capacity; reduce configuration values and restart the Supervisor",
            Self::Matcher => "configuration redaction matcher is unavailable; repair configuration and restart the Supervisor",
            Self::Poisoned => "configuration redaction registry is unavailable; restart the Supervisor",
            Self::Utf8 => "configuration redaction could not preserve UTF-8; restart the Supervisor",
        })
    }
}

struct State {
    current: BTreeSet<String>,
    fallback: BTreeSet<String>,
    retired: VecDeque<String>,
    matcher: Result<Arc<Matcher>, Unavailable>,
    pins: Vec<Weak<Matcher>>,
}

/// Current configuration values stay pinned; only the newest 256 retired values remain registered.
pub(super) struct Registry {
    state: Mutex<State>,
}

impl Registry {
    /// An empty registry for null sinks and tests; production logs initialize it through `from_file`.
    pub(super) fn new() -> Self {
        Self {
            state: Mutex::new(State {
                current: BTreeSet::new(),
                fallback: BTreeSet::new(),
                retired: VecDeque::new(),
                matcher: Ok(Arc::new(Matcher::empty())),
                pins: Vec::new(),
            }),
        }
    }

    /// Raw JSON is intentional: invalid config values need protection before validation diagnostics too.
    pub(super) fn from_file(layout: &Layout) -> Self {
        let registry = Self::new();
        match std::fs::read(layout.config_path()) {
            Ok(bytes) => registry.replace_bytes(layout, &bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                registry.replace_config(layout, &plur1bus_config::defaults());
            }
            Err(_) => registry.disable(Unavailable::Config),
        }
        registry
    }

    /// Register a captured JSON snapshot; unreadable JSON withholds payloads until a valid running snapshot arrives.
    pub(super) fn replace_bytes(&self, layout: &Layout, bytes: &[u8]) {
        match serde_json::from_slice::<Value>(bytes) {
            Ok(config) => self.replace_config(layout, &config),
            Err(_) => self.disable(Unavailable::Config),
        }
    }

    /// Withhold unreadable payloads with a value-free reason until a usable snapshot arrives.
    pub(super) fn disable(&self, reason: Unavailable) {
        if let Ok(mut state) = self.state.lock() {
            state.matcher = Err(reason);
        }
    }

    /// Replace current literals and retain bounded history; repaired metadata is applied on the next refresh.
    pub(super) fn replace_config(&self, layout: &Layout, config: &Value) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        // Unavailable module metadata gets a private fallback, so diagnostics still flow during repair.
        let (values, fallback) = match ConfigDisclosurePolicy::load(layout, config) {
            Ok(policy) => (policy.secret_values(config), false),
            Err(_) => (
                plur1bus_config::secret_text_values_with_schema(
                    config,
                    &serde_json::json!({"x-sensitive":true}),
                ),
                true,
            ),
        };
        let current: BTreeSet<String> = values
            .into_iter()
            .filter(|value| value.len() >= MIN_SECRET_BYTES)
            .collect();
        let previous = if fallback {
            &state.fallback
        } else {
            &state.current
        };
        let retired: Vec<String> = previous.difference(&current).cloned().collect();
        state.retired.retain(|value| !current.contains(value));
        state.retired.extend(retired);
        while state.retired.len() > MAX_RETIRED_VALUES {
            state.retired.pop_front();
        }
        if fallback {
            state.fallback = current;
        } else {
            state.current = current;
            state.fallback.clear();
        }
        state.matcher = Matcher::build(
            state
                .current
                .iter()
                .chain(state.fallback.iter())
                .chain(state.retired.iter()),
        )
        .map(Arc::new);
        state.pins.retain(|pin| pin.strong_count() > 0);
    }

    /// Keep a generation's initial values protected until its output streams close, even after retirement eviction.
    pub(super) fn pin(&self) -> Option<Arc<Matcher>> {
        let mut state = self.state.lock().ok()?;
        let matcher = state.matcher.as_ref().ok()?.clone();
        state.pins.retain(|pin| pin.strong_count() > 0);
        let weak = Arc::downgrade(&matcher);
        if !state.pins.iter().any(|pin| Weak::ptr_eq(pin, &weak)) {
            state.pins.push(weak);
        }
        Some(matcher)
    }

    /// Hold the registry until the sink write completes, so updates precede all later consumer writes.
    pub(super) fn with_matcher<T>(
        &self,
        apply: impl FnOnce(&Matchers) -> Result<T, Unavailable>,
    ) -> Result<T, Unavailable> {
        let state = self.state.lock().map_err(|_| Unavailable::Poisoned)?;
        match &state.matcher {
            Ok(matcher) => {
                let mut matchers = vec![matcher.clone()];
                for pin in state.pins.iter().filter_map(Weak::upgrade) {
                    if !matchers
                        .iter()
                        .any(|registered| Arc::ptr_eq(registered, &pin))
                    {
                        matchers.push(pin);
                    }
                }
                apply(&Matchers(matchers))
            }
            Err(reason) => Err(*reason),
        }
    }
}

/// One immutable, bounded literal matcher, shared with output generations through reference-counted pins.
pub(super) struct Matcher {
    nodes: Vec<Node>,
    longest: usize,
}

#[derive(Default)]
struct Node {
    edges: Vec<(u8, usize)>,
    failure: usize,
    depth: usize,
    matched: usize,
}

impl Matcher {
    fn empty() -> Self {
        Self {
            nodes: vec![Node::default()],
            longest: 0,
        }
    }

    fn build<'a>(values: impl Iterator<Item = &'a String>) -> Result<Self, Unavailable> {
        let mut forms = BTreeSet::new();
        let mut bytes = 0usize;
        let mut longest = 0;
        for value in values {
            if value.len() > MAX_MATCH_BYTES {
                return Err(Unavailable::Capacity);
            }
            let mut variants = known_secret_forms(value);
            // JSON-encoded multiline, quoted and control-bearing strings appear in captured diagnostics.
            let encoded = serde_json::to_string(value).map_err(|_| Unavailable::Matcher)?;
            variants.push(encoded[1..encoded.len() - 1].to_string());
            for variant in variants {
                if variant.len() > MAX_MATCH_BYTES {
                    return Err(Unavailable::Capacity);
                }
                longest = longest.max(variant.len());
                let length = variant.len();
                if forms.insert(variant) {
                    bytes = bytes.saturating_add(length);
                    if bytes > MAX_PATTERN_BYTES {
                        return Err(Unavailable::Capacity);
                    }
                }
            }
        }
        let mut matcher = Self::empty();
        matcher.longest = longest;
        for form in forms {
            matcher.insert(form.as_bytes())?;
        }
        matcher.link_failures();
        Ok(matcher)
    }

    fn insert(&mut self, bytes: &[u8]) -> Result<(), Unavailable> {
        let mut at = 0;
        for byte in bytes {
            match self.nodes[at]
                .edges
                .binary_search_by_key(byte, |edge| edge.0)
            {
                Ok(index) => at = self.nodes[at].edges[index].1,
                Err(index) => {
                    if self.nodes.len() >= MAX_MATCHER_STATES {
                        return Err(Unavailable::Capacity);
                    }
                    let next = self.nodes.len();
                    let depth = self.nodes[at].depth + 1;
                    self.nodes.push(Node {
                        depth,
                        ..Node::default()
                    });
                    self.nodes[at].edges.insert(index, (*byte, next));
                    at = next;
                }
            }
        }
        self.nodes[at].matched = bytes.len();
        Ok(())
    }

    fn next(&self, at: usize, byte: u8) -> Option<usize> {
        self.nodes[at]
            .edges
            .binary_search_by_key(&byte, |edge| edge.0)
            .ok()
            .map(|index| self.nodes[at].edges[index].1)
    }

    fn advance(&self, mut at: usize, byte: u8) -> usize {
        loop {
            if let Some(next) = self.next(at, byte) {
                return next;
            }
            if at == 0 {
                return 0;
            }
            at = self.nodes[at].failure;
        }
    }

    fn link_failures(&mut self) {
        let mut queue: VecDeque<usize> = self.nodes[0].edges.iter().map(|edge| edge.1).collect();
        while let Some(at) = queue.pop_front() {
            // Copy this node's bounded byte edges so failure metadata can be assigned in the same graph.
            let edges = self.nodes[at].edges.clone();
            for (byte, next) in edges {
                let failure = self.advance(self.nodes[at].failure, byte);
                self.nodes[next].failure = failure;
                self.nodes[next].matched =
                    self.nodes[next].matched.max(self.nodes[failure].matched);
                queue.push_back(next);
            }
        }
    }

    fn ranges(&self, bytes: &[u8]) -> Vec<Range<usize>> {
        let mut at = 0;
        let mut found: Vec<Range<usize>> = Vec::new();
        for (index, byte) in bytes.iter().enumerate() {
            at = self.advance(at, *byte);
            let matched = self.nodes[at].matched;
            if matched == 0 {
                continue;
            }
            let mut range = index + 1 - matched..index + 1;
            while found
                .last()
                .is_some_and(|previous| previous.end > range.start)
            {
                let previous = found.pop().expect("the previous overlapping range exists");
                range.start = range.start.min(previous.start);
            }
            found.push(range);
        }
        found
    }

    fn suffix_len(&self, bytes: &[u8]) -> usize {
        let mut at = bytes.iter().fold(0, |at, byte| self.advance(at, *byte));
        // Only a proper candidate prefix needs another read. Public tails and complete leaf matches flush now.
        while at != 0 && self.nodes[at].edges.is_empty() {
            at = self.nodes[at].failure;
        }
        self.nodes[at].depth
    }
}

/// The current registry plus live generation snapshots; matches use the original bytes before any replacement.
pub(super) struct Matchers(Vec<Arc<Matcher>>);

impl Matchers {
    /// Redact values before serialization, keeping JSON valid even for a classified numeric value.
    pub(super) fn redact_value(&self, value: &mut Value) -> Result<(), Unavailable> {
        match value {
            Value::String(text) => {
                let (bytes, _) = self.prefix(text.as_bytes(), text.len());
                *text = String::from_utf8(bytes).map_err(|_| Unavailable::Utf8)?;
            }
            Value::Number(_) | Value::Bool(_) => {
                let text = value.to_string();
                let (bytes, _) = self.prefix(text.as_bytes(), text.len());
                if bytes != text.as_bytes() {
                    *value =
                        Value::String(String::from_utf8(bytes).map_err(|_| Unavailable::Utf8)?);
                }
            }
            Value::Array(items) => {
                for item in items {
                    self.redact_value(item)?;
                }
            }
            Value::Object(map) => {
                for item in map.values_mut() {
                    self.redact_value(item)?;
                }
            }
            Value::Null => {}
        }
        Ok(())
    }

    fn prefix(&self, bytes: &[u8], cutoff: usize) -> (Vec<u8>, usize) {
        let mut matches: Vec<_> = self
            .0
            .iter()
            .flat_map(|matcher| matcher.ranges(bytes))
            .filter(|found| found.start < cutoff)
            .collect();
        matches.sort_by_key(|found| (found.start, std::cmp::Reverse(found.end)));
        let mut redacted = Vec::with_capacity(cutoff);
        let mut consumed = 0;
        for found in matches {
            if found.start < consumed {
                consumed = consumed.max(found.end);
                continue;
            }
            redacted.extend_from_slice(&bytes[consumed..found.start]);
            redacted.extend_from_slice(MARKER);
            consumed = found.end;
        }
        if consumed < cutoff {
            redacted.extend_from_slice(&bytes[consumed..cutoff]);
            consumed = cutoff;
        }
        (redacted, consumed)
    }

    fn longest(&self) -> usize {
        self.0
            .iter()
            .map(|matcher| matcher.longest)
            .max()
            .unwrap_or(0)
    }

    fn suffix_len(&self, bytes: &[u8]) -> usize {
        self.0
            .iter()
            .map(|matcher| matcher.suffix_len(bytes))
            .max()
            .unwrap_or(0)
    }
}

/// A byte-preserving, bounded suffix for one stdout/stderr stream; line length and UTF-8 read splits do not matter.
#[derive(Default)]
pub(super) struct Stream {
    pending: Vec<u8>,
}

impl Stream {
    /// Consume one bounded pump read, returning only a safe prefix; EOF flushes the remaining suffix.
    pub(super) fn redact(&mut self, chunk: &[u8], eof: bool, matcher: &Matchers) -> Vec<u8> {
        self.pending.extend_from_slice(chunk);
        let suffix = if eof {
            0
        } else {
            matcher
                .suffix_len(&self.pending)
                .min(matcher.longest().saturating_sub(1))
        };
        let mut cutoff = self.pending.len().saturating_sub(suffix);
        if !eof {
            // Preserve complete UTF-8 writes when stdout/stderr share a file, without altering arbitrary bytes.
            for start in cutoff.saturating_sub(UTF8_SUFFIX_BYTES)..cutoff {
                let width = match self.pending[start] {
                    0xc2..=0xdf => 2,
                    0xe0..=0xef => 3,
                    0xf0..=0xf4 => 4,
                    _ => continue,
                };
                if start + width > cutoff
                    && self.pending[start + 1..cutoff]
                        .iter()
                        .all(|byte| byte & 0xc0 == 0x80)
                {
                    cutoff = start;
                    break;
                }
            }
        }
        let (redacted, consumed) = matcher.prefix(&self.pending, cutoff);
        self.pending.drain(..consumed);
        redacted
    }

    /// Drop withheld pending bytes after registry failure rather than releasing them through a fallback sink.
    pub(super) fn discard(&mut self) {
        self.pending.clear();
    }
}

#[cfg(test)]
#[path = "log_redaction_tests.rs"]
mod tests;
