//! The path cleaning of `doctor-report.ts` (`literal`, `FOREIGN_HOME`, `safe`): every text the report shows passes the
//! redactor (PII on), then this core's home and the user's home become markers, then any other person's home directory
//! becomes `[user-home]`, then the text is cut to 4096 UTF-16 units.
use crate::logs::redact::TextRedactor;
use std::sync::Arc;

/// The longest text the report shows, in UTF-16 code units.
pub const MAX_TEXT_UNITS: usize = 4096;
const FOREIGN_MARKER: &str = "[user-home]";

/// `\s` of JavaScript regular expressions.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `literal(text, home, marker)`: every occurrence of `home` (without its trailing separators) becomes `marker`.
/// Replacing "" would interleave the marker between every character, and "/" would eat every path separator: a root of
/// one UTF-16 unit or none is left alone.
pub fn literal(text: &str, home: &str, marker: &str) -> String {
    let root = home.trim_end_matches(['\\', '/']);
    if root.encode_utf16().count() > 1 {
        text.replace(root, marker)
    } else {
        text.to_owned()
    }
}

fn is_sep(c: char) -> bool {
    c == '\\' || c == '/'
}

/// A character of the user name: `[^\s"'<>|:;,()[\]{}\\/]`.
fn is_name_char(c: char) -> bool {
    !(is_js_space(c)
        || matches!(
            c,
            '"' | '\''
                | '<'
                | '>'
                | '|'
                | ':'
                | ';'
                | ','
                | '('
                | ')'
                | '['
                | ']'
                | '{'
                | '}'
                | '\\'
                | '/'
        ))
}

/// The end of `[\\/](?:home|Users)[\\/][^...]+` (case-insensitive) starting at `at`.
fn after_separator(chars: &[char], at: usize) -> Option<usize> {
    if !chars.get(at).copied().is_some_and(is_sep) {
        return None;
    }
    let word = |name: &str| -> Option<usize> {
        let end = at + 1 + name.len();
        let slice = chars.get(at + 1..end)?;
        slice
            .iter()
            .zip(name.chars())
            .all(|(c, n)| c.to_ascii_lowercase() == n)
            .then_some(end)
    };
    let end = word("home").or_else(|| word("users"))?;
    if !chars.get(end).copied().is_some_and(is_sep) {
        return None;
    }
    let mut stop = end + 1;
    while chars.get(stop).copied().is_some_and(is_name_char) {
        stop += 1;
    }
    (stop > end + 1).then_some(stop)
}

/// The end of a match of `FOREIGN_HOME` starting at `at`: the optional drive first, then without it.
fn foreign_home_at(chars: &[char], at: usize) -> Option<usize> {
    let drive =
        chars.get(at).is_some_and(char::is_ascii_alphabetic) && chars.get(at + 1) == Some(&':');
    if drive {
        if let Some(end) = after_separator(chars, at + 2) {
            return Some(end);
        }
    }
    after_separator(chars, at)
}

/// `text.replace(FOREIGN_HOME, "[user-home]")`: another person's home directory (the CLI may report any path it touched)
/// is personal data: keep only the marker.
pub fn replace_foreign_homes(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < chars.len() {
        match foreign_home_at(&chars, at) {
            Some(end) => {
                out.push_str(FOREIGN_MARKER);
                at = end;
            }
            None => {
                out.push(chars[at]);
                at += 1;
            }
        }
    }
    out
}

/// `slice(0, 4096)` in UTF-16 units. A character that straddles the limit is dropped whole (a JavaScript string keeps
/// its first surrogate, which no Rust string can hold).
pub fn cut(text: &str) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        units += c.len_utf16();
        if units > MAX_TEXT_UNITS {
            break;
        }
        out.push(c);
    }
    out
}

/// `safe(text)`.
pub struct Sanitizer {
    redactor: Arc<dyn TextRedactor>,
    home: String,
    user_home: String,
}

impl Sanitizer {
    /// A sanitizer for this core's `home` and the user's home directory (`homedir()`).
    pub fn new(redactor: Arc<dyn TextRedactor>, home: &str, user_home: &str) -> Sanitizer {
        Sanitizer {
            redactor,
            home: home.to_owned(),
            user_home: user_home.to_owned(),
        }
    }

    /// The text the report may show.
    pub fn safe(&self, text: &str) -> String {
        let redacted = self.redactor.text(text);
        let homed = literal(&redacted, &self.home, "[home]");
        let user = literal(&homed, &self.user_home, "[user-home]");
        cut(&replace_foreign_homes(&user))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_leaves_an_empty_or_root_home_alone() {
        for home in ["", "/", "//", "\\", "a"] {
            assert_eq!(
                literal("cache /var/lib/x is stale", home, "[home]"),
                "cache /var/lib/x is stale",
                "{home:?}"
            );
        }
        assert_eq!(
            literal("/srv/p/x and /srv/p", "/srv/p/", "[home]"),
            "[home]/x and [home]"
        );
        assert_eq!(literal("C:\\h\\x", "C:\\h\\\\", "[home]"), "[home]\\x");
        assert_eq!(literal("ab", "ab", "[home]"), "[home]");
    }

    #[test]
    fn foreign_homes_become_the_marker() {
        let cases = [
            (
                "cannot open /home/bob/notes.txt",
                "cannot open [user-home]/notes.txt",
            ),
            ("C:\\Users\\Carol\\x.db", "[user-home]\\x.db"),
            ("c:/users/carol/x", "[user-home]/x"),
            ("/Users/anna/Library/foo", "[user-home]/Library/foo"),
            ("/HOME/Bob", "[user-home]"),
            ("/home//x", "/home//x"),
            ("/home/", "/home/"),
            ("/homes/bob", "/homes/bob"),
            (
                "(/home/bob) and \"/Users/x y\"",
                "([user-home]) and \"[user-home] y\"",
            ),
            ("xC:\\Users\\a", "x[user-home]"),
            ("1:/home/a", "1:[user-home]"),
            ("/home/a:/home/b", "[user-home]:[user-home]"),
            ("D:\\home\\a b", "[user-home] b"),
        ];
        for (input, want) in cases {
            assert_eq!(replace_foreign_homes(input), want, "{input}");
        }
    }

    #[test]
    fn a_name_stops_at_javascript_white_space() {
        assert_eq!(
            replace_foreign_homes("/home/a\u{a0}b"),
            "[user-home]\u{a0}b"
        );
        assert_eq!(replace_foreign_homes("/home/a\u{85}b"), "[user-home]");
    }

    #[test]
    fn the_cut_counts_utf16_units_and_never_splits_a_character() {
        assert_eq!(cut(&"a".repeat(5000)).len(), 4096);
        let pairs = "\u{1F600}".repeat(3000);
        assert_eq!(cut(&pairs).chars().count(), 2048);
        let odd = format!("a{}", "\u{1F600}".repeat(3000));
        assert_eq!(cut(&odd).encode_utf16().count(), 4095);
    }
}
