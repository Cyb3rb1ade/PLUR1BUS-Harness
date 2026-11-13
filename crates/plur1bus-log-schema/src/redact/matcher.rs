//! One immutable automaton per secret-set generation (`secret-matcher.ts`). Queries keep their own state and never
//! enumerate suffix output chains.
//!
//! The automaton runs over UTF-16 code units, exactly like the TypeScript original, so that source coordinates (spans,
//! windows) are the ones the TypeScript redactor reports, and so that a lone surrogate in a form or in the text behaves
//! the same. The `*_units` methods take code units; the `&str` methods encode first. Each text is matched in four
//! spellings at once: as written, with lone surrogates replaced by U+FFFD, and the same two after one layer of legal
//! JSON escapes is decoded; a match is reported in the coordinates of the original text.
use super::json_escapes::{hex_digit, simple_escape};
use super::utf16::{is_high, is_low, is_well_formed, to_well_formed, utf16, utf8_len};
use crate::redaction;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// A half-open range of the original text (UTF-16 code units, or bytes for byte input) a registered value covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SecretSpan {
    /// First covered unit.
    pub start: usize,
    /// One past the last covered unit.
    pub end: usize,
}

/// The masked text and the spans it was cut at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretTextProjection {
    /// The text with every span replaced by the mask, well-formed.
    pub text: String,
    /// The replaced ranges in the original coordinates.
    pub spans: Vec<SecretSpan>,
}

/// Which forms occur in a JSON text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonSecretScan {
    /// Some form occurs (as wire text or in a decoded string).
    pub found: bool,
    /// One byte per form: 1 when it occurs.
    pub matches: Vec<u8>,
    /// Work counter of the scan (automaton steps), for tests that bound the effort.
    pub operations: u64,
}

/// A source window outside the text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RangeError;

impl std::fmt::Display for RangeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("invalid source window")
    }
}

impl std::error::Error for RangeError {}

/// `[REDACTED:secret]`: the replacement template of `redaction.json` for rule `secret`.
pub fn mask() -> &'static str {
    static MASK: OnceLock<String> = OnceLock::new();
    MASK.get_or_init(|| {
        redaction()["replacementTemplate"]
            .as_str()
            .unwrap_or("[REDACTED:{rule}]")
            .replace("{rule}", "secret")
    })
}

#[derive(Debug, Default)]
struct Node {
    next: HashMap<u16, u32>,
    fail: u32,
    text_max: usize,
    wire_max: usize,
    text: Vec<u32>,
    wire: Vec<u32>,
}

/// `JSON.stringify(s).slice(1, -1)` over code units: a lone surrogate is written as `\udxxx` (lower case).
pub fn json_body_units(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut at = 0;
    while at < units.len() {
        let u = units[at];
        let code = i32::from(u);
        if is_high(code) && units.get(at + 1).is_some_and(|n| is_low(i32::from(*n))) {
            out.push(u);
            out.push(units[at + 1]);
            at += 2;
            continue;
        }
        at += 1;
        match u {
            34 => out.extend(utf16("\\\"")),
            92 => out.extend(utf16("\\\\")),
            8 => out.extend(utf16("\\b")),
            12 => out.extend(utf16("\\f")),
            10 => out.extend(utf16("\\n")),
            13 => out.extend(utf16("\\r")),
            9 => out.extend(utf16("\\t")),
            u if u < 0x20 || is_high(code) || is_low(code) => {
                out.extend(utf16(&format!("\\u{u:04x}")));
            }
            u => out.push(u),
        }
    }
    out
}

/// The automaton of one generation of exact secret forms.
#[derive(Debug)]
pub struct SecretMatcher {
    forms: Vec<Vec<u16>>,
    max_form_units: usize,
    max_source_bytes: usize,
    min_form_units: usize,
    nodes: Vec<Node>,
    order: Vec<u32>,
    well_formed: Vec<bool>,
}

fn unit(code: i32) -> Option<u16> {
    u16::try_from(code).ok()
}

impl SecretMatcher {
    /// The matcher of `forms` (duplicates and empty forms are dropped, the first spelling keeps its position). Forms are
    /// matched as text and, JSON-escaped, as wire text (a form with a lone surrogate also as written).
    pub fn new(forms: Vec<Vec<u16>>) -> SecretMatcher {
        let mut seen = HashSet::new();
        let forms: Vec<Vec<u16>> = forms
            .into_iter()
            .filter(|f| !f.is_empty() && seen.insert(f.clone()))
            .collect();
        let well_formed: Vec<bool> = forms.iter().map(|f| is_well_formed(f)).collect();
        let mut nodes = vec![Node::default()];
        let (mut max, mut bytes, mut min) = (0usize, 0usize, usize::MAX);
        for (id, form) in forms.iter().enumerate() {
            max = max.max(form.len());
            min = min.min(form.len());
            bytes = bytes.max(utf8_len(form));
            Self::add(&mut nodes, form, id, false);
            Self::add(&mut nodes, &json_body_units(form), id, true);
            if !well_formed[id] {
                Self::add(&mut nodes, form, id, true);
            }
        }
        // A match can begin/end in half a code point. Include its paired neighbour at both edges, even in a fully
        // escaped view.
        let max_source_bytes = if max == 0 {
            0
        } else {
            bytes.max((max + 2) * 6)
        };
        let mut order: Vec<u32> = nodes[0].next.values().copied().collect();
        let mut at = 0;
        while at < order.len() {
            let state = order[at] as usize;
            at += 1;
            let fail_state = nodes[state].fail as usize;
            let (text_max, wire_max) = (nodes[fail_state].text_max, nodes[fail_state].wire_max);
            nodes[state].text_max = nodes[state].text_max.max(text_max);
            nodes[state].wire_max = nodes[state].wire_max.max(wire_max);
            let children: Vec<(u16, u32)> =
                nodes[state].next.iter().map(|(c, n)| (*c, *n)).collect();
            for (code, next) in children {
                let mut fail = nodes[state].fail as usize;
                while fail != 0 && !nodes[fail].next.contains_key(&code) {
                    fail = nodes[fail].fail as usize;
                }
                nodes[next as usize].fail = nodes[fail].next.get(&code).copied().unwrap_or(0);
                order.push(next);
            }
        }
        SecretMatcher {
            forms,
            max_form_units: max,
            max_source_bytes,
            min_form_units: if min == usize::MAX { 0 } else { min },
            nodes,
            order,
            well_formed,
        }
    }

    /// The matcher of well-formed strings.
    pub fn from_strs<'a>(forms: impl IntoIterator<Item = &'a str>) -> SecretMatcher {
        SecretMatcher::new(forms.into_iter().map(utf16).collect())
    }

    fn add(nodes: &mut Vec<Node>, text: &[u16], id: usize, wire: bool) {
        let mut state = 0usize;
        for code in text {
            state = match nodes[state].next.get(code) {
                Some(next) => *next as usize,
                None => {
                    nodes.push(Node::default());
                    let next = nodes.len() - 1;
                    nodes[state].next.insert(*code, next as u32);
                    next
                }
            };
        }
        let node = &mut nodes[state];
        if wire {
            node.wire.push(id as u32);
            node.wire_max = node.wire_max.max(text.len());
        } else {
            node.text.push(id as u32);
            node.text_max = node.text_max.max(text.len());
        }
    }

    /// The distinct forms, in the order they were given.
    pub fn forms(&self) -> &[Vec<u16>] {
        &self.forms
    }

    /// The longest form in UTF-16 code units.
    pub fn max_form_units(&self) -> usize {
        self.max_form_units
    }

    /// Bytes of source a match can span: the longest form's UTF-8 length, or every unit written as a `\uXXXX` escape
    /// plus a paired neighbour at either edge.
    pub fn max_source_bytes(&self) -> usize {
        self.max_source_bytes
    }

    /// No form: nothing is ever masked.
    pub fn is_empty(&self) -> bool {
        self.forms.is_empty()
    }

    fn advance(&self, mut state: u32, code: i32) -> u32 {
        let Some(code) = unit(code) else {
            return 0;
        };
        while state != 0 && !self.nodes[state as usize].next.contains_key(&code) {
            state = self.nodes[state as usize].fail;
        }
        self.nodes[state as usize]
            .next
            .get(&code)
            .copied()
            .unwrap_or(0)
    }
}

/// Feeds both the original UTF-16 and its well-formed spelling without changing source coordinates. A high surrogate waits
/// one unit, so a lone one can be replaced by U+FFFD and a pair stays a pair.
#[derive(Default)]
struct Spelling {
    pending: Option<(i32, usize, usize)>,
}

type SpellingOut<'a> = &'a mut dyn FnMut(i32, usize, usize, bool);

impl Spelling {
    fn put(&mut self, code: i32, start: usize, end: usize, out: SpellingOut<'_>) {
        out(code, start, end, false);
        if let Some((pending, begin, finish)) = self.pending.take() {
            if is_low(code) {
                out(pending, begin, finish, true);
                out(code, start, end, true);
                return;
            }
            out(0xfffd, begin, finish, true);
        }
        if is_high(code) {
            self.pending = Some((code, start, end));
        } else {
            out(if is_low(code) { 0xfffd } else { code }, start, end, true);
        }
    }

    fn finish(&mut self, out: SpellingOut<'_>) {
        if let Some((_, begin, finish)) = self.pending.take() {
            out(0xfffd, begin, finish, true);
        }
    }

    fn reset(&mut self) {
        self.pending = None;
    }
}

/// Decodes one legal JSON-escape layer. At most six pending units; invalid spellings stay literal.
#[derive(Default)]
struct EscapeSink {
    codes: Vec<i32>,
    starts: Vec<usize>,
    ends: Vec<usize>,
}

type EscapeOut<'a> = &'a mut dyn FnMut(i32, usize, usize);

impl EscapeSink {
    fn clear(&mut self) {
        self.codes.clear();
        self.starts.clear();
        self.ends.clear();
    }

    fn put(&mut self, code: i32, start: usize, end: usize, out: EscapeOut<'_>) {
        if self.codes.is_empty() {
            if code == 92 {
                self.codes.push(code);
                self.starts.push(start);
                self.ends.push(end);
            } else {
                out(code, start, end);
            }
            return;
        }
        self.codes.push(code);
        self.starts.push(start);
        self.ends.push(end);
        if self.codes.len() == 2 {
            if let Some(simple) = simple_escape(code) {
                out(simple, self.starts[0], end);
                self.clear();
                return;
            }
        }
        if self.codes[1] == 117 && (self.codes.len() == 2 || hex_digit(code) >= 0) {
            if self.codes.len() < 6 {
                return;
            }
            let decoded = self.codes[2..6]
                .iter()
                .fold(0, |acc, c| acc * 16 + hex_digit(*c));
            out(decoded, self.starts[0], end);
            self.clear();
            return;
        }
        let (codes, starts, ends) = (
            std::mem::take(&mut self.codes),
            std::mem::take(&mut self.starts),
            std::mem::take(&mut self.ends),
        );
        out(codes[0], starts[0], ends[0]);
        for at in 1..codes.len() {
            self.put(codes[at], starts[at], ends[at], out);
        }
    }

    fn finish(&mut self, out: EscapeOut<'_>) {
        for at in 0..self.codes.len() {
            out(self.codes[at], self.starts[at], self.ends[at]);
        }
        self.clear();
    }

    fn reset(&mut self) {
        self.clear();
    }
}

/// The match ends by start offset: `ends[begin]` is the furthest end of a match that begins at `begin`.
struct Ends {
    length: usize,
    data: Vec<usize>,
}

impl Ends {
    fn collect(&mut self, begin: usize, end: usize) {
        if self.data.is_empty() {
            self.data = vec![0; self.length];
        }
        self.data[begin] = self.data[begin].max(end);
    }

    /// Adjacent matches retain separate markers; overlapping ones are merged.
    fn union(self) -> Vec<SecretSpan> {
        let ends = self.data;
        let mut spans = Vec::new();
        let mut start = 0;
        while start < ends.len() {
            if ends[start] == 0 {
                start += 1;
                continue;
            }
            let mut end = ends[start];
            let mut at = start + 1;
            while at < end {
                end = end.max(ends[at]);
                at += 1;
            }
            spans.push(SecretSpan { start, end });
            start = end;
        }
        spans
    }
}

/// One match lane: a spelling of the text run through the automaton, with the ring of the last units seen.
struct Lane {
    starts: Vec<usize>,
    codes: Vec<i32>,
    state: u32,
    position: usize,
    pending: Option<(usize, usize)>,
}

impl Lane {
    fn new(capacity: usize) -> Lane {
        Lane {
            starts: vec![0; capacity],
            codes: vec![0; capacity],
            state: 0,
            position: 0,
            pending: None,
        }
    }

    fn put(&mut self, m: &SecretMatcher, ends: &mut Ends, code: i32, start: usize, end: usize) {
        let cap = self.starts.len();
        // Wait one unit after a high surrogate, so no replacement can orphan the low half that follows it.
        if let Some((begin, finish)) = self.pending.take() {
            ends.collect(begin, if is_low(code) { end } else { finish });
        }
        self.starts[self.position % cap] = start;
        self.codes[self.position % cap] = code;
        self.position += 1;
        self.state = m.advance(self.state, code);
        let matched = m.nodes[self.state as usize].text_max;
        if matched == 0 {
            return;
        }
        let first = self.position - matched;
        let mut begin = self.starts[first % cap];
        if first > 0 && is_low(self.codes[first % cap]) && is_high(self.codes[(first - 1) % cap]) {
            begin = self.starts[(first - 1) % cap];
        }
        if is_high(code) {
            self.pending = Some((begin, end));
        } else {
            ends.collect(begin, end);
        }
    }

    fn finish(&mut self, ends: &mut Ends) {
        if let Some((begin, finish)) = self.pending.take() {
            ends.collect(begin, finish);
        }
    }
}

/// The four lanes (as written, well-formed, and the two after one escape layer) behind the raw and escape sinks.
struct Pipeline<'a> {
    m: &'a SecretMatcher,
    ends: Ends,
    lanes: [Lane; 4],
    raw: Spelling,
    escaped: EscapeSink,
    escaped_spelling: Spelling,
}

impl Pipeline<'_> {
    fn put(&mut self, code: i32, start: usize, end: usize) {
        let Pipeline {
            m,
            ends,
            lanes,
            raw,
            escaped,
            escaped_spelling,
        } = self;
        raw.put(code, start, end, &mut |c, s, e, normalized| {
            lanes[usize::from(normalized)].put(m, ends, c, s, e);
        });
        escaped.put(code, start, end, &mut |c, s, e| {
            escaped_spelling.put(c, s, e, &mut |c, s, e, normalized| {
                lanes[2 + usize::from(normalized)].put(m, ends, c, s, e);
            });
        });
    }

    fn finish(&mut self) {
        let Pipeline {
            m,
            ends,
            lanes,
            raw,
            escaped,
            escaped_spelling,
        } = self;
        raw.finish(&mut |c, s, e, normalized| lanes[usize::from(normalized)].put(m, ends, c, s, e));
        escaped.finish(&mut |c, s, e| {
            escaped_spelling.put(c, s, e, &mut |c, s, e, normalized| {
                lanes[2 + usize::from(normalized)].put(m, ends, c, s, e);
            });
        });
        escaped_spelling.finish(&mut |c, s, e, normalized| {
            lanes[2 + usize::from(normalized)].put(m, ends, c, s, e);
        });
        for lane in lanes.iter_mut() {
            lane.finish(ends);
        }
    }
}

fn window_bounds(length: usize, begin: usize, end: usize) -> Result<(), RangeError> {
    if end < begin || end > length {
        return Err(RangeError);
    }
    Ok(())
}

/// A source window may bisect a public code point; omit its incomplete half rather than introduce a new replacement
/// spelling.
fn source_text_slice(input: &[u16], mut begin: usize, mut end: usize) -> &[u16] {
    if begin < end
        && begin > 0
        && is_low(i32::from(input[begin]))
        && is_high(i32::from(input[begin - 1]))
    {
        begin += 1;
    }
    if end > begin
        && end < input.len()
        && is_high(i32::from(input[end - 1]))
        && is_low(i32::from(input[end]))
    {
        end -= 1;
    }
    &input[begin..end.max(begin)]
}

impl SecretMatcher {
    fn source_spans(&self, length: usize, feed: impl FnOnce(&mut Pipeline<'_>)) -> Vec<SecretSpan> {
        if self.forms.is_empty() || length < self.min_form_units {
            return Vec::new();
        }
        let capacity = (length + 1).min(self.max_form_units + 1);
        let mut pipe = Pipeline {
            m: self,
            ends: Ends {
                length,
                data: Vec::new(),
            },
            lanes: [
                Lane::new(capacity),
                Lane::new(capacity),
                Lane::new(capacity),
                Lane::new(capacity),
            ],
            raw: Spelling::default(),
            escaped: EscapeSink::default(),
            escaped_spelling: Spelling::default(),
        };
        feed(&mut pipe);
        pipe.ends.union()
    }

    /// The spans of `input` (UTF-16 code units) any form covers, in the original coordinates.
    pub fn find_text_spans_units(&self, input: &[u16]) -> Vec<SecretSpan> {
        self.source_spans(input.len(), |sink| {
            for (at, unit) in input.iter().enumerate() {
                sink.put(i32::from(*unit), at, at + 1);
            }
            sink.finish();
        })
    }

    /// [`find_text_spans_units`](Self::find_text_spans_units) of a string; offsets count UTF-16 code units.
    pub fn find_text_spans(&self, input: &str) -> Vec<SecretSpan> {
        self.find_text_spans_units(&utf16(input))
    }

    fn render_text_window(
        input: &[u16],
        spans: &[SecretSpan],
        source_begin: usize,
        source_end: usize,
    ) -> String {
        let mut pieces: Vec<u16> = Vec::new();
        let mask = utf16(mask());
        let mut last = source_begin;
        for span in spans {
            if span.end <= source_begin || span.start >= source_end {
                continue;
            }
            pieces.extend_from_slice(source_text_slice(input, last, source_begin.max(span.start)));
            pieces.extend_from_slice(&mask);
            last = source_end.min(span.end);
        }
        pieces.extend_from_slice(source_text_slice(input, last, source_end));
        to_well_formed(&pieces)
    }

    /// The final text and every replacement's original coordinates come from the same pair-complete source projection.
    pub fn project_text_units(&self, input: &[u16]) -> SecretTextProjection {
        let spans = self.find_text_spans_units(input);
        SecretTextProjection {
            text: Self::render_text_window(input, &spans, 0, input.len()),
            spans,
        }
    }

    /// [`project_text_units`](Self::project_text_units) of a string.
    pub fn project_text(&self, input: &str) -> SecretTextProjection {
        self.project_text_units(&utf16(input))
    }

    /// The window `[source_begin, source_end)` of `input` (UTF-16 offsets) with every form masked, including a form that
    /// begins before or ends after the window. An empty window emits no mask even inside a registered value.
    pub fn mask_text_window_units(
        &self,
        input: &[u16],
        source_begin: usize,
        source_end: usize,
    ) -> Result<String, RangeError> {
        window_bounds(input.len(), source_begin, source_end)?;
        if source_begin == source_end {
            return Ok(String::new());
        }
        let spans = self.find_text_spans_units(input);
        Ok(Self::render_text_window(
            input,
            &spans,
            source_begin,
            source_end,
        ))
    }

    /// [`mask_text_window_units`](Self::mask_text_window_units) of a string.
    pub fn mask_text_window(
        &self,
        input: &str,
        source_begin: usize,
        source_end: usize,
    ) -> Result<String, RangeError> {
        self.mask_text_window_units(&utf16(input), source_begin, source_end)
    }

    /// `input` with every form replaced by the mask; lone surrogates become U+FFFD.
    pub fn mask_text_units(&self, input: &[u16]) -> String {
        self.project_text_units(input).text
    }

    /// `input` with every form replaced by the mask.
    pub fn mask_text(&self, input: &str) -> String {
        if self.forms.is_empty() {
            return input.to_string();
        }
        self.mask_text_units(&utf16(input))
    }

    /// The spans of a byte string any form covers (bytes are read as UTF-8; an invalid byte matches nothing and is not
    /// replaced by a character that could match).
    pub fn find_byte_spans(&self, input: &[u8]) -> Vec<SecretSpan> {
        self.source_spans(input.len(), |sink| {
            let mut at = 0;
            while at < input.len() {
                let start = at;
                let first = input[at];
                at += 1;
                let (mut code, remaining, minimum): (u32, usize, u32) = match first {
                    0xc2..=0xdf => (u32::from(first & 31), 1, 0x80),
                    0xe0..=0xef => (u32::from(first & 15), 2, 0x800),
                    0xf0..=0xf4 => (u32::from(first & 7), 3, 0x10000),
                    0x80..=0xff => {
                        sink.put(-1, start, at);
                        continue;
                    }
                    _ => (u32::from(first), 0, 0),
                };
                let mut valid = at + remaining <= input.len();
                for i in 0..remaining {
                    if !valid {
                        break;
                    }
                    let next = input[at + i];
                    if next & 0xc0 != 0x80 {
                        valid = false;
                    } else {
                        code = code * 64 + u32::from(next & 63);
                    }
                }
                if !valid || code < minimum || code > 0x10ffff || (0xd800..=0xdfff).contains(&code)
                {
                    sink.put(-1, start, at);
                    continue;
                }
                at += remaining;
                if code > 0xffff {
                    let pair = code - 0x10000;
                    sink.put(0xd800 + (pair >> 10) as i32, start, at);
                    sink.put(0xdc00 + (pair & 1023) as i32, start, at);
                } else {
                    sink.put(code as i32, start, at);
                }
            }
            sink.finish();
        })
    }

    /// The window `[source_begin, source_end)` of `input` with every form masked.
    pub fn mask_bytes_window(
        &self,
        input: &[u8],
        source_begin: usize,
        source_end: usize,
    ) -> Result<Vec<u8>, RangeError> {
        window_bounds(input.len(), source_begin, source_end)?;
        if source_begin == source_end {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        let mut last = source_begin;
        for span in self.find_byte_spans(input) {
            if span.end <= source_begin || span.start >= source_end {
                continue;
            }
            out.extend_from_slice(&input[last..source_begin.max(span.start)]);
            out.extend_from_slice(mask().as_bytes());
            last = source_end.min(span.end);
        }
        out.extend_from_slice(&input[last..source_end]);
        Ok(out)
    }

    /// `input` with every form replaced by the mask.
    pub fn mask_bytes(&self, input: &[u8]) -> Vec<u8> {
        self.mask_bytes_window(input, 0, input.len())
            .unwrap_or_default()
    }

    /// Scan JSON wire text, and each decoded string or key plus one embedded escape layer, without retaining token views.
    pub fn scan_json_units(&self, json: &[u16]) -> JsonSecretScan {
        let mut matches = vec![0u8; self.forms.len()];
        if self.forms.is_empty() {
            return JsonSecretScan {
                found: false,
                matches,
                operations: 0,
            };
        }
        struct Scan<'a> {
            m: &'a SecretMatcher,
            visited: Vec<u8>,
            operations: u64,
            found: bool,
        }
        impl Scan<'_> {
            fn advance(&mut self, mut state: u32, code: i32, lane: u8) -> u32 {
                self.operations += 1;
                let code = unit(code);
                while state != 0
                    && !code.is_some_and(|c| self.m.nodes[state as usize].next.contains_key(&c))
                {
                    self.operations += 1;
                    state = self.m.nodes[state as usize].fail;
                }
                state = code
                    .and_then(|c| self.m.nodes[state as usize].next.get(&c).copied())
                    .unwrap_or(0);
                self.visited[state as usize] |= lane;
                let node = &self.m.nodes[state as usize];
                if (if lane == 1 {
                    node.text_max
                } else {
                    node.wire_max
                }) != 0
                {
                    self.found = true;
                }
                state
            }
        }
        let mut scan = Scan {
            m: self,
            visited: vec![0; self.nodes.len()],
            operations: 0,
            found: false,
        };
        let mut wire = 0u32;
        for unit in json {
            wire = scan.advance(wire, i32::from(*unit), 2);
        }
        let mut payload = Spelling::default();
        let mut embedded = EscapeSink::default();
        let mut embedded_spelling = Spelling::default();
        let mut at = 0;
        while at < json.len() {
            if json[at] != 34 {
                at += 1;
                continue;
            }
            // direct, normalized, nested, nested normalized
            let mut states = [0u32; 4];
            payload.reset();
            embedded.reset();
            embedded_spelling.reset();
            at += 1;
            while at < json.len() && json[at] != 34 {
                let start = at;
                let mut code = i32::from(json[at]);
                if code == 92 && at + 1 < json.len() {
                    let next = i32::from(json[at + 1]);
                    if let Some(simple) = simple_escape(next) {
                        code = simple;
                        at += 1;
                    } else if next == 117 && at + 5 < json.len() {
                        let digits: Vec<i32> =
                            (2..6).map(|i| hex_digit(i32::from(json[at + i]))).collect();
                        if digits.iter().all(|d| *d >= 0) {
                            code = digits.iter().fold(0, |acc, d| acc * 16 + d);
                            at += 5;
                        }
                    }
                }
                payload.put(code, start, at + 1, &mut |c, _s, _e, normalized| {
                    let i = usize::from(normalized);
                    states[i] = scan.advance(states[i], c, 1);
                });
                embedded.put(code, start, at + 1, &mut |c, s, e| {
                    embedded_spelling.put(c, s, e, &mut |c, _s, _e, normalized| {
                        let i = 2 + usize::from(normalized);
                        states[i] = scan.advance(states[i], c, 1);
                    });
                });
                at += 1;
            }
            payload.finish(&mut |c, _s, _e, normalized| {
                let i = usize::from(normalized);
                states[i] = scan.advance(states[i], c, 1);
            });
            embedded.finish(&mut |c, s, e| {
                embedded_spelling.put(c, s, e, &mut |c, _s, _e, normalized| {
                    let i = 2 + usize::from(normalized);
                    states[i] = scan.advance(states[i], c, 1);
                });
            });
            embedded_spelling.finish(&mut |c, _s, _e, normalized| {
                let i = 2 + usize::from(normalized);
                states[i] = scan.advance(states[i], c, 1);
            });
            at += 1;
        }
        let found = scan.found;
        let mut operations = scan.operations;
        let mut visited = scan.visited;
        if found {
            // Mark terminal ancestors once per automaton state, rather than once per match (periodic inputs have
            // enormous hit sets).
            for state in self.order.iter().rev() {
                let fail = self.nodes[*state as usize].fail as usize;
                visited[fail] |= visited[*state as usize];
                operations += 1;
            }
            for (state, node) in self.nodes.iter().enumerate() {
                if visited[state] & 1 != 0 {
                    for id in &node.text {
                        matches[*id as usize] = 1;
                        operations += 1;
                    }
                }
                if visited[state] & 2 != 0 {
                    for id in &node.wire {
                        matches[*id as usize] = 1;
                        operations += 1;
                    }
                }
            }
        }
        JsonSecretScan {
            found,
            matches,
            operations,
        }
    }

    /// [`scan_json_units`](Self::scan_json_units) of a JSON text.
    pub fn scan_json(&self, json: &str) -> JsonSecretScan {
        self.scan_json_units(&utf16(json))
    }

    /// A well-formed form that the scan found in `before` is still in `after`: it was not in a string, so masking could
    /// not remove it.
    pub fn has_residual(&self, before: &JsonSecretScan, after: &JsonSecretScan) -> bool {
        self.well_formed
            .iter()
            .enumerate()
            .any(|(id, well_formed)| {
                *well_formed && before.matches[id] == 1 && after.matches[id] == 1
            })
    }
}
