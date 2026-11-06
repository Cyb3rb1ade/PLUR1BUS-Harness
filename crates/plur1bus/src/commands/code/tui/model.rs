//! Bounded display history. Durable transcripts and authority remain in the core.
use std::collections::VecDeque;

const HISTORY_BYTES: usize = 1024 * 1024;
const HISTORY_ENTRIES: usize = 512;
const ENTRY_BYTES: usize = 32 * 1024;

#[derive(Default)]
pub(super) struct Screen {
    pub messages: VecDeque<String>,
    pub bytes: usize,
    pub dropped: usize,
    pub tools: super::tools::ToolList,
    pub status: super::status::Status,
    pub transcript_scroll: usize,
    pub tool_scroll: usize,
}

impl Screen {
    /// Retain a bounded, terminal-safe window; discarded display rows remain in the core transcript.
    pub fn append(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        let text = text.strip_suffix('\n').unwrap_or(text);
        let safe =
            super::super::render::safe(&clipped(text, ENTRY_BYTES), true).replace('\t', "    ");
        let entry = clipped(&safe, ENTRY_BYTES);
        self.bytes += entry.len();
        self.messages.push_back(entry);
        while self.bytes > HISTORY_BYTES || self.messages.len() > HISTORY_ENTRIES {
            if let Some(removed) = self.messages.pop_front() {
                self.bytes -= removed.len();
                self.dropped = self.dropped.saturating_add(1);
            }
        }
    }
}

/// A display-only byte limit, with a visible marker and no split UTF-8 code point.
pub(super) fn clipped(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.into();
    }
    if limit < '…'.len_utf8() {
        return String::new();
    }
    let mut end = limit - '…'.len_utf8();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_history_is_bounded_without_losing_utf8_or_executing_controls() {
        let mut screen = Screen::default();
        screen.append("Hello 🧩\tworld\x1b[2J\u{202e}");
        let text = screen.messages.front().expect("visible message");
        assert!(text.contains("Hello 🧩    world"));
        assert!(!text.contains(['\x1b', '\t', '\u{202e}']));
        for n in 0..700 {
            screen.append(&format!("{n}:{}", "🧩".repeat(3000)));
        }
        assert!(screen.bytes <= HISTORY_BYTES);
        assert!(screen.messages.len() <= HISTORY_ENTRIES);
        assert!(screen.dropped > 0);
        assert_eq!(
            screen.bytes,
            screen.messages.iter().map(String::len).sum::<usize>()
        );
        assert!(screen.messages.back().expect("latest").starts_with("699:"));
    }

    #[test]
    fn an_oversized_display_entry_is_visibly_truncated_on_a_character_boundary() {
        let mut screen = Screen::default();
        screen.append(&"🧩".repeat(ENTRY_BYTES));
        let text = screen.messages.front().expect("entry");
        assert!(text.len() <= ENTRY_BYTES);
        assert!(text.ends_with('…'));
        assert!(std::str::from_utf8(text.as_bytes()).is_ok());
        let before = screen.messages.len();
        screen.append("");
        assert_eq!(screen.messages.len(), before);
    }
}
