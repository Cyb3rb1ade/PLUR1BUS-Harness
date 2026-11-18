//! The argument pattern of an allowlist entry (`argsMatchPattern` of `tools/exec/args.ts`).
//!
//! TypeScript compiles the pattern with `new RegExp(pattern, "u")` and tests every argument (a search, not a full match;
//! an unreadable pattern allows nothing). There is no engine for JavaScript's dialect in this workspace, and the `regex`
//! crate reads several constructs differently (`\d`, `\w` and `.` are wider, classes nest and have set operators, `\s`
//! and `\b` are defined on other character sets). A pattern read differently could allow an argument the person's
//! pattern refuses, so only a subset is accepted in which both engines mean the same, with three constructs translated
//! (`.` to JavaScript's "anything but a line terminator", `\d` and `\w` to their ASCII sets). Everything else is
//! declined: the entry then allows nothing (fail closed), exactly as an unreadable pattern does in TypeScript.
//!
//! The subset: ASCII only; literals; `.`; `^` and `$`; `*`, `+`, `?` (also lazy); `{m}`, `{m,}`, `{m,n}`; groups `( )` and
//! `(?: )`; `|`; classes `[...]` and `[^...]` of literals, ranges, `\d` and `\w`; the escapes `\d`, `\w`, `\n`, `\r`,
//! `\t` and an escaped syntax character or `/` (`\-` only inside a class, as JavaScript reads it with the `u` flag).
use regex::Regex;

/// A compiled pattern of the subset.
#[derive(Debug)]
pub struct ArgPattern(Regex);

const ESCAPABLE: &str = "^$\\.*+?()[]{}|/-";

/// What the translator saw last, for the rule that a quantifier needs something to repeat (JavaScript refuses `a**`
/// and `^*` with the `u` flag; the `regex` crate reads both).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Last {
    /// The start, `(`, `|`, `^` or `$`: nothing a quantifier could repeat.
    Nothing,
    /// A literal, a class, an escape or a closed group.
    Atom,
    /// A quantifier (a `?` may follow and makes it lazy).
    Quantifier,
    /// A lazy quantifier.
    Lazy,
}

/// Translate a pattern of the subset into the `regex` crate's syntax; `None` for anything outside it.
fn translate(pattern: &str) -> Option<String> {
    if !pattern.is_ascii() {
        return None;
    }
    let b = pattern.as_bytes();
    let mut out = String::with_capacity(b.len() + 8);
    let mut i = 0;
    let mut in_class = false;
    let mut class_len = 0usize;
    // Inside a class: the last item was `\d` or `\w`, which cannot be the end of a range.
    let mut class_escape = false;
    let mut last = Last::Nothing;
    while i < b.len() {
        let c = b[i] as char;
        if in_class {
            match c {
                '\\' => {
                    let e = *b.get(i + 1)? as char;
                    class_escape = false;
                    match e {
                        'd' => {
                            out.push_str("0-9");
                            class_escape = true;
                        }
                        'w' => {
                            out.push_str("A-Za-z0-9_");
                            class_escape = true;
                        }
                        'n' | 'r' | 't' => {
                            out.push('\\');
                            out.push(e);
                        }
                        _ if ESCAPABLE.contains(e) => {
                            out.push('\\');
                            out.push(e);
                        }
                        _ => return None,
                    }
                    class_len += 1;
                    i += 2;
                    continue;
                }
                // A nested class in the `regex` crate, a literal in JavaScript.
                '[' => return None,
                ']' => {
                    // `[]` matches nothing and `[^]` anything in JavaScript; the `regex` crate reads neither that way.
                    if class_len == 0 {
                        return None;
                    }
                    in_class = false;
                    last = Last::Atom;
                    out.push(']');
                }
                '-' => {
                    let next = b.get(i + 1).copied();
                    if class_len == 0 || next == Some(b']') {
                        out.push_str("\\-"); // a literal at either end, in both engines
                    } else {
                        // A range. Its ends are single characters: not a class escape, and not a set operator (`--`).
                        let escape_next =
                            next == Some(b'\\') && matches!(b.get(i + 2), Some(b'd' | b'w'));
                        if class_escape || escape_next || next == Some(b'-') {
                            return None;
                        }
                        out.push('-');
                    }
                    class_escape = false;
                    class_len += 1;
                }
                _ => {
                    // Set operators of the `regex` crate (`&&`, `~~`) are literals in JavaScript.
                    if matches!(c, '&' | '~') && b.get(i + 1) == Some(&(c as u8)) {
                        return None;
                    }
                    if c == '^' {
                        out.push('\\');
                    }
                    out.push(c);
                    class_escape = false;
                    class_len += 1;
                }
            }
            i += 1;
            continue;
        }
        match c {
            '\\' => {
                let e = *b.get(i + 1)? as char;
                match e {
                    'd' => out.push_str("[0-9]"),
                    'w' => out.push_str("[A-Za-z0-9_]"),
                    'n' | 'r' | 't' => {
                        out.push('\\');
                        out.push(e);
                    }
                    '/' => out.push('/'),
                    // With the `u` flag `\-` is a literal inside a class only; outside one JavaScript refuses the pattern.
                    '-' => return None,
                    _ if ESCAPABLE.contains(e) => {
                        out.push('\\');
                        out.push(e);
                    }
                    _ => return None,
                }
                last = Last::Atom;
                i += 2;
                continue;
            }
            '[' => {
                in_class = true;
                class_len = 0;
                class_escape = false;
                out.push('[');
                if b.get(i + 1) == Some(&b'^') {
                    out.push('^');
                    i += 1;
                }
            }
            '.' => {
                out.push_str("[^\\n\\r\\x{2028}\\x{2029}]");
                last = Last::Atom;
            }
            '(' => {
                last = Last::Nothing;
                if b.get(i + 1) == Some(&b'?') {
                    if b.get(i + 2) != Some(&b':') {
                        return None; // look-around, named groups, inline flags
                    }
                    out.push_str("(?:");
                    i += 3;
                    continue;
                }
                out.push('(');
            }
            ')' => {
                last = Last::Atom;
                out.push(')');
            }
            '|' | '^' | '$' => {
                last = Last::Nothing;
                out.push(c);
            }
            '*' | '+' => {
                if last != Last::Atom {
                    return None;
                }
                last = Last::Quantifier;
                out.push(c);
            }
            '?' => {
                last = match last {
                    Last::Atom => Last::Quantifier,
                    Last::Quantifier => Last::Lazy,
                    Last::Nothing | Last::Lazy => return None,
                };
                out.push('?');
            }
            '{' => {
                // Only a well-formed repetition of something; a lone brace is a syntax error with the `u` flag.
                if last != Last::Atom {
                    return None;
                }
                let end = pattern[i..].find('}')? + i;
                let body = &pattern[i + 1..end];
                let (min, max) = match body.split_once(',') {
                    Some((m, n)) => (m, Some(n)),
                    None => (body, None),
                };
                let digits = |s: &str| !s.is_empty() && s.bytes().all(|d| d.is_ascii_digit());
                if !digits(min) || max.is_some_and(|n| !n.is_empty() && !digits(n)) {
                    return None;
                }
                out.push_str(&pattern[i..=end]);
                last = Last::Quantifier;
                i = end + 1;
                continue;
            }
            '}' | ']' => return None,
            _ => {
                out.push(c);
                last = Last::Atom;
            }
        }
        i += 1;
    }
    if in_class {
        return None;
    }
    Some(out)
}

impl ArgPattern {
    /// The pattern, or `None` when it is outside the subset or does not compile: the entry then allows nothing.
    pub fn compile(pattern: &str) -> Option<ArgPattern> {
        Regex::new(&translate(pattern)?).ok().map(ArgPattern)
    }

    /// `args.every((a) => re.test(a))`.
    pub fn allows(&self, args: &[String]) -> bool {
        args.iter().all(|a| self.0.is_match(a))
    }
}

/// `argsMatchPattern`: an entry without a pattern allows every argument list; one whose pattern cannot be read allows none.
pub fn args_match_pattern(pattern: Option<&str>, args: &[String]) -> bool {
    match pattern {
        None => true,
        Some(p) => ArgPattern::compile(p).is_some_and(|re| re.allows(args)),
    }
}
