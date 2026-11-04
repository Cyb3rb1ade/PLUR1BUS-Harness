//! Pure UTF-8 editing and key intent. Delivery, cancellation and human decisions remain in the shared runtime.
use super::super::input::{AcceptKey, MAX_INPUT_BYTES, MAX_INPUT_CHARS};
use super::layout::Focus;
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Action {
    None,
    Accept(String, AcceptKey),
    Interrupt,
    Eof,
    Scroll { up: bool },
    Edge { start: bool },
    SelectTool { previous: bool },
    Fold,
    Help,
    Queue,
    TooLong,
}

#[derive(Default)]
pub(super) struct Editor {
    pub text: String,
    pub cursor: usize,
    pub focus: Focus,
    escaped: bool,
}

impl Editor {
    /// Convert a key press into local editing or the existing frontend's input intent.
    pub fn key(&mut self, key: KeyEvent, busy: bool) -> Action {
        if key.kind == KeyEventKind::Release {
            return Action::None;
        }
        self.normalize_cursor();
        let escaped = std::mem::take(&mut self.escaped);
        let control = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        if let KeyCode::Char(c) = key.code {
            if control {
                match c.to_ascii_lowercase() {
                    'c' => {
                        self.text.clear();
                        self.cursor = 0;
                        return Action::Interrupt;
                    }
                    'd' if self.text.is_empty() && !busy => return Action::Eof,
                    'd' => self.delete_next(),
                    'a' => self.cursor = 0,
                    'e' => self.cursor = self.text.len(),
                    'u' => {
                        self.text.drain(..self.cursor);
                        self.cursor = 0;
                    }
                    'k' => {
                        self.text.truncate(self.cursor);
                    }
                    'w' => {
                        while self.cursor > 0
                            && self.text[..self.cursor].ends_with(char::is_whitespace)
                        {
                            self.delete_previous();
                        }
                        while self.cursor > 0
                            && !self.text[..self.cursor].ends_with(char::is_whitespace)
                        {
                            self.delete_previous();
                        }
                    }
                    'f' => {
                        self.focus = Focus::Tools;
                        return Action::Fold;
                    }
                    _ => {}
                }
                return Action::None;
            }
            if !alt && !c.is_control() {
                return self.paste(&c.to_string());
            }
            return Action::None;
        }
        match key.code {
            KeyCode::Enter if !self.text.trim().is_empty() => {
                let text = std::mem::take(&mut self.text);
                self.cursor = 0;
                return Action::Accept(
                    text,
                    if alt || escaped {
                        AcceptKey::AltEnter
                    } else {
                        AcceptKey::Enter
                    },
                );
            }
            KeyCode::Esc => self.escaped = true,
            KeyCode::Left => self.cursor = self.previous(),
            KeyCode::Right => self.cursor = self.next(),
            KeyCode::Backspace => self.delete_previous(),
            KeyCode::Delete => self.delete_next(),
            KeyCode::Home if control => return Action::Edge { start: true },
            KeyCode::End if control => return Action::Edge { start: false },
            KeyCode::Home => self.cursor = 0,
            KeyCode::End => self.cursor = self.text.len(),
            KeyCode::Tab | KeyCode::BackTab => {
                self.focus = match self.focus {
                    Focus::Transcript => Focus::Tools,
                    Focus::Tools => Focus::Transcript,
                };
            }
            KeyCode::PageUp => return Action::Scroll { up: true },
            KeyCode::PageDown => return Action::Scroll { up: false },
            KeyCode::Up if alt => {
                self.focus = Focus::Tools;
                return Action::SelectTool { previous: true };
            }
            KeyCode::Down if alt => {
                self.focus = Focus::Tools;
                return Action::SelectTool { previous: false };
            }
            KeyCode::F(1) => return Action::Help,
            KeyCode::F(2) => return Action::Queue,
            _ => {}
        }
        Action::None
    }

    /// A paste remains one prompt and never executes an embedded terminal control sequence.
    pub fn paste(&mut self, text: &str) -> Action {
        if self.text.len().saturating_add(text.len()) > MAX_INPUT_BYTES
            || self
                .text
                .chars()
                .count()
                .saturating_add(text.chars().count())
                > MAX_INPUT_CHARS
        {
            return Action::TooLong;
        }
        self.normalize_cursor();
        self.text.insert_str(self.cursor, text);
        self.cursor += text.len();
        self.escaped = false;
        Action::None
    }

    /// Reinsert a rejected/deferred draft without changing the person's bytes.
    pub fn restore(&mut self, text: &str) -> Action {
        if text.len() > MAX_INPUT_BYTES || text.chars().count() > MAX_INPUT_CHARS {
            return Action::TooLong;
        }
        self.text = text.into();
        self.cursor = self.text.len();
        self.escaped = false;
        Action::None
    }

    fn normalize_cursor(&mut self) {
        self.cursor = self.cursor.min(self.text.len());
        while !self.text.is_char_boundary(self.cursor) {
            self.cursor -= 1;
        }
    }

    fn previous(&self) -> usize {
        self.text[..self.cursor]
            .char_indices()
            .next_back()
            .map_or(0, |(i, _)| i)
    }

    fn next(&self) -> usize {
        self.text[self.cursor..]
            .chars()
            .next()
            .map_or(self.cursor, |c| self.cursor + c.len_utf8())
    }

    fn delete_previous(&mut self) {
        let start = self.previous();
        self.text.drain(start..self.cursor);
        self.cursor = start;
    }

    fn delete_next(&mut self) {
        let end = self.next();
        self.text.drain(self.cursor..end);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn typing_navigation_and_deletion_preserve_utf8_and_the_surrounding_text() {
        let mut editor = Editor::default();
        editor.key(key(KeyCode::Char('🧩')), false);
        editor.key(key(KeyCode::Char('x')), false);
        assert_eq!(editor.text, "🧩x");
        editor.key(key(KeyCode::Left), false);
        editor.key(key(KeyCode::Backspace), false);
        assert_eq!(editor.text, "x");
        assert_eq!(editor.cursor, 0);
        editor.key(key(KeyCode::Char('ä')), false);
        editor.key(key(KeyCode::Delete), false);
        assert_eq!(editor.text, "ä");
        assert_eq!(editor.cursor, "ä".len());
    }

    #[test]
    fn enter_alt_enter_and_escape_enter_keep_native_delivery_intents_and_ignore_release() {
        let mut editor = Editor::default();
        editor.paste("steer");
        let mut released = key(KeyCode::Enter);
        released.kind = KeyEventKind::Release;
        assert_eq!(editor.key(released, true), Action::None);
        assert_eq!(editor.text, "steer");
        assert_eq!(
            editor.key(key(KeyCode::Enter), true),
            Action::Accept("steer".into(), AcceptKey::Enter)
        );
        editor.paste("queued");
        assert_eq!(
            editor.key(KeyEvent::new(KeyCode::Enter, KeyModifiers::ALT), true),
            Action::Accept("queued".into(), AcceptKey::AltEnter)
        );
        editor.paste("fallback");
        editor.key(key(KeyCode::Esc), true);
        assert_eq!(
            editor.key(key(KeyCode::Enter), true),
            Action::Accept("fallback".into(), AcceptKey::AltEnter)
        );
        assert_eq!(editor.key(key(KeyCode::Enter), false), Action::None);
    }

    #[test]
    fn cancellation_idle_eof_paste_bounds_and_pane_selection_are_independent_of_rpc() {
        let mut editor = Editor::default();
        assert_eq!(
            editor.key(
                KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
                true
            ),
            Action::Interrupt
        );
        assert_eq!(
            editor.key(
                KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL),
                true
            ),
            Action::None
        );
        assert_eq!(
            editor.key(
                KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL),
                false
            ),
            Action::Eof
        );
        assert_eq!(
            editor.paste(&"x".repeat(MAX_INPUT_BYTES + 1)),
            Action::TooLong
        );
        assert_eq!(editor.text, "");
        editor.paste("line one\nline two\t🧩");
        assert_eq!(editor.text, "line one\nline two\t🧩");
        editor.key(key(KeyCode::Tab), false);
        assert_eq!(editor.focus, Focus::Tools);
        editor.key(key(KeyCode::Tab), false);
        assert_eq!(editor.focus, Focus::Transcript);
        assert_eq!(
            editor.key(key(KeyCode::PageUp), false),
            Action::Scroll { up: true }
        );
        assert_eq!(
            editor.key(
                KeyEvent::new(KeyCode::Char('f'), KeyModifiers::CONTROL),
                false
            ),
            Action::Fold
        );
        assert_eq!(editor.key(key(KeyCode::F(2)), false), Action::Queue);
    }

    #[test]
    fn paste_and_restored_drafts_enforce_the_rpc_character_limit_as_well_as_bytes() {
        let mut editor = Editor::default();
        assert_eq!(editor.paste(&"x".repeat(200_001)), Action::TooLong);
        assert_eq!(editor.text, "");
        assert_eq!(editor.restore(&"x".repeat(200_001)), Action::TooLong);
        assert_eq!(editor.text, "");
        assert_eq!(editor.paste(&"🧩".repeat(200_000)), Action::None);
        assert_eq!(editor.text.len(), MAX_INPUT_BYTES);
        assert_eq!(editor.paste("x"), Action::TooLong);
    }
}
