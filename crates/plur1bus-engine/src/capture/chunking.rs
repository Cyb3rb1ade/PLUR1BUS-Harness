//! Capture splitting from the pinned Node engine, with ECMAScript UTF-16 boundaries.
//!
//! The legacy decimal/list defects are intentional parity (RE-D16/RE-D17). All indexing
//! uses `JsString`; no lossy UTF-8 conversion happens before a store boundary.

use crate::text::js::{is_js_whitespace, JsString};

/// The two thresholds read by Node's `planChunks` helper.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChunkLimits {
    /// Below this number of sentences, keep the full text.
    pub min_sentences: usize,
    /// At this number, prose without structural boundaries is split into sentences.
    pub llm_min_sentences: usize,
}

impl Default for ChunkLimits {
    fn default() -> Self {
        Self {
            min_sentences: 4,
            llm_min_sentences: 8,
        }
    }
}

/// The exact mode names returned by Node's chunk planner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChunkMode {
    /// The original text is kept as one memory.
    Whole,
    /// List, heading or paragraph boundaries determine the parts.
    Structural,
    /// Sentence boundaries determine the parts; `needsLlm` still remains true in Node.
    Sentence,
}

impl ChunkMode {
    /// The pinned JSON mode spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Whole => "whole",
            Self::Structural => "structural",
            Self::Sentence => "sentence",
        }
    }
}

/// Node's complete plan, including ordering and strings that contain lone surrogates.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChunkPlan {
    /// Splitter selected by the pinned engine.
    pub mode: ChunkMode,
    /// Parts in source order; the unchanged original text for whole mode.
    pub parts: Vec<JsString>,
    /// Node's historical eligibility marker, including after a deterministic sentence split.
    pub needs_llm: bool,
    /// Sentence/outline count used for the decision.
    pub sentences: usize,
}

impl ChunkPlan {
    /// Serialize in `JSON.stringify(planChunks(text))` field order, preserving UTF-16 cuts.
    #[must_use]
    pub fn to_node_json(&self) -> String {
        let parts = self.parts.iter().map(JsString::to_json).collect::<Vec<_>>();
        format!(
            "{{\"mode\":\"{}\",\"parts\":[{}],\"needsLlm\":{},\"sentences\":{}}}",
            self.mode.as_str(),
            parts.join(","),
            self.needs_llm,
            self.sentences
        )
    }
}

/// Cut capture input by JS code units, retaining an unpaired surrogate until serialization.
#[must_use]
pub fn truncate_for_capture(text: &JsString, max_chars: usize) -> JsString {
    text.utf16_slice(0, max_chars)
}

fn whitespace(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_js_whitespace)
}

fn digit(unit: u16) -> bool {
    (b'0' as u16..=b'9' as u16).contains(&unit)
}

fn punctuation(unit: u16) -> bool {
    matches!(unit, 0x002e | 0x0021 | 0x003f | 0x2026)
}

fn trim(units: &[u16]) -> Vec<u16> {
    let start = units.iter().position(|unit| !whitespace(*unit));
    let end = units.iter().rposition(|unit| !whitespace(*unit));
    match (start, end) {
        (Some(start), Some(end)) => units[start..=end].to_vec(),
        _ => Vec::new(),
    }
}

fn lines(units: &[u16]) -> Vec<Vec<u16>> {
    units
        .split(|unit| *unit == 0x000a)
        .map(<[u16]>::to_vec)
        .collect()
}

fn paragraphs(units: &[u16]) -> Vec<Vec<u16>> {
    let mut result = Vec::new();
    let mut start = 0;
    let mut cursor = 0;
    while cursor < units.len() {
        if units[cursor] != 0x000a {
            cursor += 1;
            continue;
        }
        let mut scan = cursor + 1;
        let mut last_newline = cursor;
        while scan < units.len() && whitespace(units[scan]) {
            if units[scan] == 0x000a {
                last_newline = scan;
            }
            scan += 1;
        }
        if last_newline == cursor {
            cursor += 1;
            continue;
        }
        result.push(units[start..cursor].to_vec());
        start = last_newline + 1;
        cursor = start;
    }
    result.push(units[start..].to_vec());
    result
}

/// Count Node's punctuation boundaries and outline items; decimal digits are ASCII-only.
#[must_use]
pub fn count_sentences(text: &JsString) -> usize {
    let value = trim(text.as_utf16_units());
    if value.is_empty() {
        return 0;
    }
    let mut punctuation_count = 0;
    for block in paragraphs(&value)
        .into_iter()
        .filter(|block| !trim(block).is_empty())
    {
        let mut count = 0;
        let mut cursor = 0;
        while cursor < block.len() {
            if !punctuation(block[cursor]) || cursor > 0 && digit(block[cursor - 1]) {
                cursor += 1;
                continue;
            }
            let mut end = cursor + 1;
            while end < block.len() && punctuation(block[end]) {
                end += 1;
            }
            if end == block.len() || whitespace(block[end]) {
                count += 1;
                cursor = end.saturating_add(1);
            } else {
                cursor += 1;
            }
        }
        punctuation_count += count.max(1);
    }
    let outline_count = lines(&value)
        .iter()
        .filter(|line| marker_end(line, false).is_some() || marker_end(line, true).is_some())
        .count();
    punctuation_count.max(outline_count)
}

fn marker_end(line: &[u16], heading: bool) -> Option<usize> {
    let mut cursor = 0;
    while cursor < line.len() && whitespace(line[cursor]) {
        cursor += 1;
    }
    let marker = *line.get(cursor)?;
    if heading {
        let start = cursor;
        while cursor < line.len() && line[cursor] == 0x0023 && cursor - start < 6 {
            cursor += 1;
        }
        if cursor == start {
            return None;
        }
    } else if matches!(marker, 0x002d | 0x002a | 0x2022) {
        cursor += 1;
    } else if digit(marker) {
        while cursor < line.len() && digit(line[cursor]) {
            cursor += 1;
        }
        if !matches!(line.get(cursor), Some(0x002e | 0x0029)) {
            return None;
        }
        cursor += 1;
    } else {
        return None;
    }
    if !line.get(cursor).copied().is_some_and(whitespace) {
        return None;
    }
    while cursor < line.len() && whitespace(line[cursor]) {
        cursor += 1;
    }
    Some(cursor)
}

fn join(parts: &[Vec<u16>]) -> Vec<u16> {
    let mut result = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            result.push(0x0020);
        }
        result.extend_from_slice(part);
    }
    result
}

fn collect_sections(value: &[u16], heading: bool) -> Vec<Vec<u16>> {
    let mut sections: Vec<Vec<Vec<u16>>> = Vec::new();
    let mut prefix = Vec::new();
    for line in lines(value) {
        if let Some(end) = marker_end(&line, heading) {
            sections.push(vec![trim(if heading { &line } else { &line[end..] })]);
        } else {
            let line = trim(&line);
            if line.is_empty() {
                continue;
            }
            if let Some(section) = sections.last_mut() {
                section.push(line);
            } else {
                prefix.push(line);
            }
        }
    }
    if let Some(first) = sections.first_mut() {
        prefix.append(first);
        *first = prefix;
    }
    sections
        .into_iter()
        .map(|section| trim(&join(&section)))
        .filter(|part| !part.is_empty())
        .collect()
}

fn preserve_short_parts(parts: Vec<Vec<u16>>) -> Vec<Vec<u16>> {
    let mut result: Vec<Vec<u16>> = Vec::new();
    let mut pending = Vec::new();
    for part in parts {
        let mut pieces = Vec::new();
        if !pending.is_empty() {
            pieces.push(std::mem::take(&mut pending));
        }
        let part = trim(&part);
        if !part.is_empty() {
            pieces.push(part);
        }
        let text = join(&pieces);
        if text.len() >= 8 {
            result.push(text);
        } else if let Some(previous) = result.last_mut() {
            previous.push(0x0020);
            previous.extend_from_slice(&text);
        } else {
            pending = text;
        }
    }
    if !pending.is_empty() {
        result.push(pending);
    }
    result
}

fn useful(parts: Vec<Vec<u16>>) -> Option<Vec<Vec<u16>>> {
    let parts = preserve_short_parts(parts);
    (parts.len() >= 2).then_some(parts)
}

fn structural_parts(value: &[u16]) -> Option<Vec<Vec<u16>>> {
    for heading in [false, true] {
        let parts = collect_sections(value, heading);
        if parts.len() >= 2 {
            if let Some(parts) = useful(parts) {
                return Some(parts);
            }
        }
    }
    useful(paragraphs(value))
}

fn sentence_parts(value: &[u16]) -> Option<Vec<Vec<u16>>> {
    let mut result = Vec::new();
    for block in lines(value) {
        let block = trim(&block);
        let mut start = 0;
        let mut cursor = 1;
        while cursor < block.len() {
            if !whitespace(block[cursor])
                || !punctuation(block[cursor - 1])
                || cursor > 1 && digit(block[cursor - 2])
            {
                cursor += 1;
                continue;
            }
            let mut end = cursor + 1;
            while end < block.len() && whitespace(block[end]) {
                end += 1;
            }
            if end < block.len() && digit(block[end]) {
                if end == cursor + 1 {
                    cursor = end;
                    continue;
                }
                // JS backtracks `\s+` by one unit to satisfy the following `(?!\d)`.
                end -= 1;
            }
            let part = trim(&block[start..cursor]);
            if !part.is_empty() {
                result.push(part);
            }
            start = end;
            cursor = end.saturating_add(1);
        }
        let part = trim(&block[start..]);
        if !part.is_empty() {
            result.push(part);
        }
    }
    useful(result)
}

fn bundle(parts: &[Vec<u16>]) -> Vec<JsString> {
    let width = parts.len().div_ceil(20).max(1);
    parts
        .chunks(width)
        .map(|parts| JsString::from_utf16_units(join(parts)))
        .collect()
}

/// Produce Node's deterministic capture split plan with unchanged full text in whole mode.
#[must_use]
pub fn plan_chunks(text: &JsString, limits: ChunkLimits) -> ChunkPlan {
    let sentences = count_sentences(text);
    let whole = || ChunkPlan {
        mode: ChunkMode::Whole,
        parts: vec![text.clone()],
        needs_llm: false,
        sentences,
    };
    if sentences < limits.min_sentences {
        return whole();
    }
    let value = trim(text.as_utf16_units());
    if let Some(parts) = structural_parts(&value) {
        return ChunkPlan {
            mode: ChunkMode::Structural,
            parts: bundle(&parts),
            needs_llm: false,
            sentences,
        };
    }
    if sentences >= limits.llm_min_sentences {
        if let Some(parts) = sentence_parts(&value) {
            return ChunkPlan {
                mode: ChunkMode::Sentence,
                parts: bundle(&parts),
                needs_llm: true,
                sentences,
            };
        }
    }
    whole()
}

/// How the prepared capture list is expanded before embedding.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExpansionMode {
    /// Do not ask the planner or decider.
    Disabled,
    /// Keep each original in addition to deterministic parts.
    WholeAndParts,
    /// Keep only parts when a split is possible.
    PartsOnly,
    /// Let the caller's decider select whole, parts or both for splittable messages.
    Decided,
}

/// A normalized decider result; errors and unknown answers use `Both`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StorageDecision {
    /// Keep the original only.
    Whole,
    /// Keep parts only.
    Parts,
    /// Keep original and parts.
    Both,
}

/// One prepared message and its caller-owned provenance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedCapture<T> {
    /// Original-message provenance; each produced part keeps the same value.
    pub item: T,
    /// Text after optional summary/truncation and before embedding.
    pub text: JsString,
    /// Missing remains missing on an unsplit original, as with Node's spread operation.
    pub chunk_group_id: Option<String>,
}

/// Counts produced only by Node's decider-aware expansion.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DecisionCounts {
    /// Whole-only decisions among splittable inputs.
    pub whole: usize,
    /// Parts-only decisions among splittable inputs.
    pub parts: usize,
    /// Whole-and-parts decisions among splittable inputs.
    pub both: usize,
}

/// Expanded inputs and Node's diagnostic counters.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptureExpansion<T> {
    /// Original rows and produced parts, in Node storage order.
    pub items: Vec<PreparedCapture<T>>,
    /// Number of inputs that actually produced parts.
    pub split: usize,
    /// Total produced parts, excluding preserved originals.
    pub parts: usize,
    /// Number of plans carrying the legacy LLM eligibility marker.
    pub needs_llm: usize,
    /// Present only for decider-aware mode, including when no input is splittable.
    pub decisions: Option<DecisionCounts>,
}

/// Expand prepared capture messages exactly where Node does, before vector computation.
/// A preserved original keeps its own group value; generated parts share a new group.
#[must_use]
pub fn expand_for_capture<T: Clone>(
    preps: &[PreparedCapture<T>],
    mode: ExpansionMode,
    mut decide: impl FnMut(&JsString) -> StorageDecision,
    mut make_group_id: impl FnMut() -> String,
) -> CaptureExpansion<T> {
    let mut result = CaptureExpansion {
        items: Vec::new(),
        split: 0,
        parts: 0,
        needs_llm: 0,
        decisions: (mode == ExpansionMode::Decided).then(DecisionCounts::default),
    };
    if mode == ExpansionMode::Disabled {
        result.items = preps.to_vec();
        return result;
    }
    for prep in preps {
        let plan = plan_chunks(&prep.text, ChunkLimits::default());
        result.needs_llm += usize::from(plan.needs_llm);
        if plan.mode == ChunkMode::Whole || plan.parts.len() < 2 {
            result.items.push(prep.clone());
            continue;
        }
        let decision = match mode {
            ExpansionMode::PartsOnly => StorageDecision::Parts,
            ExpansionMode::Decided => decide(&prep.text),
            _ => StorageDecision::Both,
        };
        if let Some(counts) = &mut result.decisions {
            match decision {
                StorageDecision::Whole => counts.whole += 1,
                StorageDecision::Parts => counts.parts += 1,
                StorageDecision::Both => counts.both += 1,
            }
        }
        if decision == StorageDecision::Whole {
            result.items.push(prep.clone());
            continue;
        }
        let group = make_group_id();
        result.split += 1;
        result.parts += plan.parts.len();
        if decision == StorageDecision::Both {
            result.items.push(prep.clone());
        }
        for text in plan.parts {
            result.items.push(PreparedCapture {
                item: prep.item.clone(),
                text,
                chunk_group_id: Some(group.clone()),
            });
        }
    }
    result
}
