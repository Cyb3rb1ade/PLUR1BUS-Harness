//! Defect-faithful parity ports of `lib/text-utils.js` (`RE-04/T0`, `RE-D17`).
//!
//! These functions preserve the exact Node 24.21 behaviour of the legacy JavaScript
//! implementation—including NFKD decomposition splitting decomposed German umlauts on the
//! combining diaeresis (`U+0308` is `Mn`, not `\p{L}`).

/// Legacy `lib/text-utils.js` functions ported at parity.
pub mod text_utils {
    use std::sync::OnceLock;

    use crate::text::js::{
        is_js_whitespace, js_regex, js_to_lower_case, js_trim, js_trim_end, nfkd, utf16_len,
        JsRegex,
    };

    /// Memory entry fields consumed by [`compress_memory_slots_for_prompt`].
    #[derive(Clone, Debug, Default, PartialEq, Eq)]
    pub struct PromptMemoryEntry {
        /// Memory identifier.
        pub id: String,
        /// Full memory text.
        pub text: String,
        /// Optional pre-generated summary (used instead of `text` when non-empty).
        pub summary: String,
        /// Memory category (`"canonical"`, `"project"`, `"decision"`, etc.).
        pub category: String,
        /// Memory class (`"core"`, `"standard"`, etc.).
        pub memory_class: String,
    }

    /// A recall memory slot wrapping a [`PromptMemoryEntry`].
    #[derive(Clone, Debug, Default, PartialEq, Eq)]
    pub struct PromptMemorySlot {
        /// The underlying memory entry.
        pub entry: PromptMemoryEntry,
    }

    fn non_letter_number_ws_regex() -> Option<&'static JsRegex> {
        static REGEX: OnceLock<Option<JsRegex>> = OnceLock::new();
        REGEX
            .get_or_init(|| js_regex(r"[^\p{L}\p{N}\s]", "u").ok())
            .as_ref()
    }

    fn letter_or_number_regex() -> Option<&'static JsRegex> {
        static REGEX: OnceLock<Option<JsRegex>> = OnceLock::new();
        REGEX
            .get_or_init(|| js_regex(r"[\p{L}\p{N}]+", "u").ok())
            .as_ref()
    }

    /// Splits `s` on contiguous runs of ECMAScript whitespace (`/\s+/`), matching
    /// `s.split(/\s+/)` in JavaScript.
    fn split_js_whitespace(s: &str) -> Vec<&str> {
        if s.is_empty() {
            return vec![""];
        }
        let mut parts = Vec::new();
        let mut last_end = 0;
        let mut in_ws = false;
        let mut ws_start = 0;

        for (idx, ch) in s.char_indices() {
            if is_js_whitespace(ch) {
                if !in_ws {
                    ws_start = idx;
                    in_ws = true;
                }
            } else if in_ws {
                parts.push(&s[last_end..ws_start]);
                last_end = idx;
                in_ws = false;
            }
        }
        if in_ws {
            parts.push(&s[last_end..ws_start]);
            parts.push("");
        } else {
            parts.push(&s[last_end..]);
        }
        parts
    }

    /// Tokenizes `text` into unique lowercase tokens of at least 2 UTF-16 code units, matching
    /// `lib/text-utils.js:tokenize`:
    ///
    /// `String(text || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(w => w.length >= 2)`
    #[must_use]
    pub fn tokenize(text: &str) -> Vec<String> {
        if text.is_empty() {
            return Vec::new();
        }
        let lowered = js_to_lower_case(text);
        let decomposed = nfkd(&lowered);

        let mut raw_tokens: Vec<String> = Vec::new();
        if let Some(re) = letter_or_number_regex() {
            if let Ok(matches) = re.find_all(&decomposed) {
                for m in matches {
                    if utf16_len(&m.matched) >= 2 {
                        raw_tokens.push(m.matched);
                    }
                }
            }
        } else if let Some(non_re) = non_letter_number_ws_regex() {
            let mut replaced = String::with_capacity(decomposed.len());
            for ch in decomposed.chars() {
                let mut buf = [0u8; 4];
                let s = ch.encode_utf8(&mut buf);
                if non_re.is_match(s).unwrap_or(false) {
                    replaced.push(' ');
                } else {
                    replaced.push(ch);
                }
            }
            for part in split_js_whitespace(&replaced) {
                if utf16_len(part) >= 2 {
                    raw_tokens.push(part.to_owned());
                }
            }
        }

        let mut unique: Vec<String> = Vec::with_capacity(raw_tokens.len());
        for tok in raw_tokens {
            if !unique.contains(&tok) {
                unique.push(tok);
            }
        }
        unique
    }

    /// Computes Jaccard similarity over [`tokenize`] token sets, matching
    /// `lib/text-utils.js:jaccardSimilarity`.
    #[must_use]
    #[allow(clippy::cast_precision_loss)]
    pub fn jaccard_similarity(a: &str, b: &str) -> f64 {
        let sa = tokenize(a);
        let sb = tokenize(b);
        if sa.is_empty() || sb.is_empty() {
            return 0.0;
        }
        let mut inter: usize = 0;
        for w in &sa {
            if sb.contains(w) {
                inter += 1;
            }
        }
        let union = sa.len() + sb.len() - inter;
        if union == 0 {
            0.0
        } else {
            (inter as f64) / (union as f64)
        }
    }

    /// Generates an extractive summary truncated to at most `max_words` whitespace-delimited
    /// words, preferring a sentence boundary (`.`, `!`, `?`) within the `[ceil(0.9 * max_words), max_words]`
    /// window and falling back to an ellipsis (`…`), matching `lib/text-utils.js:generateSummary`.
    #[must_use]
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss
    )]
    pub fn generate_summary(text: &str, max_words: usize) -> String {
        let str_trimmed = js_trim(text);
        let words = split_js_whitespace(str_trimmed);
        if words.len() <= max_words {
            return str_trimmed.to_owned();
        }

        let lower_bound = ((max_words as f64) * 0.9).ceil() as usize;

        let mut count: usize = 0;
        let mut cut_pos: usize = str_trimmed.len();
        let mut in_word = false;

        for (idx, ch) in str_trimmed.char_indices() {
            if !is_js_whitespace(ch) {
                if !in_word {
                    in_word = true;
                    count += 1;
                }
                if count == max_words {
                    // Advance to the end of this non-whitespace run.
                    let rest = &str_trimmed[idx..];
                    let word_byte_len = rest.find(is_js_whitespace).unwrap_or(rest.len());
                    cut_pos = idx + word_byte_len;
                    break;
                }
            } else {
                in_word = false;
            }
        }

        let before_cut = &str_trimmed[..cut_pos];
        for (idx, ch) in before_cut.char_indices().rev() {
            if matches!(ch, '.' | '!' | '?') {
                let candidate = &before_cut[..=idx];
                let text_up_to_boundary = js_trim_end(candidate);
                let word_count = split_js_whitespace(text_up_to_boundary).len();
                if word_count >= lower_bound && word_count <= max_words {
                    return text_up_to_boundary.to_owned();
                }
            }
        }

        format!("{}…", js_trim_end(before_cut))
    }

    /// Compresses memory slots to fit within `token_budget` words using priority multipliers
    /// (`1.5` for `core`/`canonical`, `1.0` for `project`/`decision`, `0.6` otherwise) and
    /// round-robin excess reduction from lowest to highest priority, matching
    /// `lib/text-utils.js:compressMemorySlotsForPrompt`.
    #[must_use]
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss
    )]
    pub fn compress_memory_slots_for_prompt(
        memories: &[PromptMemorySlot],
        token_budget: usize,
    ) -> Vec<String> {
        if memories.is_empty() {
            return Vec::new();
        }
        let count = memories.len();
        let base = (token_budget as f64) / (count as f64);

        struct Allocation {
            prio_group: u8,
            max_words: usize,
        }

        let mut allocations: Vec<Allocation> = memories
            .iter()
            .map(|m| {
                let is_core = m.entry.memory_class == "core" || m.entry.category == "canonical";
                let is_proj = m.entry.category == "project" || m.entry.category == "decision";
                let (prio_group, mul) = if is_core {
                    (2u8, 1.5_f64)
                } else if is_proj {
                    (1u8, 1.0_f64)
                } else {
                    (0u8, 0.6_f64)
                };
                let max_words = (base * mul).floor().max(0.0) as usize;
                Allocation {
                    prio_group,
                    max_words,
                }
            })
            .collect();

        let total: usize = allocations.iter().map(|a| a.max_words).sum();
        if total > token_budget {
            let mut excess = total - token_budget;
            for prio_group in [0u8, 1, 2] {
                if excess == 0 {
                    break;
                }
                let group_indices: Vec<usize> = allocations
                    .iter()
                    .enumerate()
                    .filter_map(|(idx, a)| (a.prio_group == prio_group).then_some(idx))
                    .collect();
                if group_indices.is_empty() {
                    continue;
                }
                while excess > 0
                    && group_indices
                        .iter()
                        .any(|&idx| allocations[idx].max_words > 0)
                {
                    for &idx in &group_indices {
                        if excess == 0 {
                            break;
                        }
                        if allocations[idx].max_words > 0 {
                            allocations[idx].max_words -= 1;
                            excess -= 1;
                        }
                    }
                }
            }
        }

        memories
            .iter()
            .zip(allocations.iter())
            .map(|(m, a)| {
                if a.max_words == 0 {
                    return String::new();
                }
                let source = if m.entry.summary.is_empty() {
                    m.entry.text.as_str()
                } else {
                    m.entry.summary.as_str()
                };
                generate_summary(source, a.max_words)
            })
            .collect()
    }
}
