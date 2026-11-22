//! The rule classifier (`ruleClassifier` of `packages/core/src/triage/index.ts`): a conservative baseline that splits a
//! message at explicit task connectors and names one category per part by keyword.
//!
//! The TypeScript rules are regular expressions with the `i` flag and without `u`. They are written out by hand here,
//! over UTF-16 code units, because the dialect matters at the edges and the `regex` crate has a different one: `\b`
//! and `\w` are ASCII-only, `\s` is JavaScript's white space, the separator uses a look-behind, and case-insensitive
//! matching is the specification's `Canonicalize` ([`eq_ignore_case`]: `Ü` matches `ü`, but neither the long s nor
//! the Kelvin sign matches an ASCII letter, and `ß` matches only itself). Offsets in the decision are code units.
use super::{choose_class, CostPreference, Effort, ModelClass, TriageDecision, SCHEMA};
use crate::approvals::js_json::J;
use crate::js::{eq_ignore_case, is_boundary, is_space_unit, trim_units, utf16};

/// Whether `units[at..]` starts with `word`, ignoring case the JavaScript way. Returns the end of the match.
fn starts_with(units: &[u16], at: usize, word: &str) -> Option<usize> {
    let mut i = at;
    for w in word.encode_utf16() {
        if !eq_ignore_case(*units.get(i)?, w) {
            return None;
        }
        i += 1;
    }
    Some(i)
}

/// `/\b(a|b|...)\w*/i.test(text)`: one of the words starts at a word boundary. The trailing `\w*` never decides a test.
fn has_word(units: &[u16], words: &[&str]) -> bool {
    (0..units.len())
        .any(|i| is_boundary(units, i) && words.iter().any(|w| starts_with(units, i, w).is_some()))
}

/// `/\b(a|b|...)\b/i.test(text)`: one of the words stands between two word boundaries.
fn has_whole_word(units: &[u16], words: &[&str]) -> bool {
    (0..units.len()).any(|i| {
        is_boundary(units, i)
            && words
                .iter()
                .any(|w| starts_with(units, i, w).is_some_and(|end| is_boundary(units, end)))
    })
}

/// The keyword rules in table order: `(words, whole word only, category)`.
const RULES: [(&[&str], bool, &str); 11] = [
    (
        &[
            "search",
            "research",
            "review",
            "find online",
            "suche",
            "recherch",
            "bewertungen",
        ],
        false,
        "web.research",
    ),
    (
        &[
            "browser",
            "browse",
            "scroll",
            "navigate",
            "website",
            "webseite",
            "scrolle",
            "navigiere",
        ],
        false,
        "web.browse",
    ),
    (
        &[
            "report", "pdf", "document", "bericht", "dokument", "write", "schreibe", "erstelle",
        ],
        false,
        "docs.create",
    ),
    (
        &[
            "debug",
            "code",
            "implement",
            "fix",
            "test",
            "fehler",
            "programmiere",
        ],
        false,
        "code.edit",
    ),
    (&["review", "audit", "prüfe"], true, "code.review"),
    (
        &["file", "files", "datei", "ordner", "move", "verschiebe"],
        false,
        "files.manage",
    ),
    (
        &[
            "system", "disk", "process", "install", "speicher", "prozess",
        ],
        false,
        "ops.system",
    ),
    (
        &["data", "analyse", "analyze", "daten"],
        false,
        "data.analyse",
    ),
    (
        &["email", "mail", "message", "nachricht"],
        false,
        "comm.email",
    ),
    (&["image", "photo", "bild", "foto"], false, "media.image"),
    (
        &["memory", "remember", "recall", "erinnere", "gedächtnis"],
        false,
        "memory.manage",
    ),
];
const COMPLEX: [&str; 8] = [
    "architecture",
    "architect",
    "security",
    "proof",
    "distributed",
    "sicherheit",
    "architektur",
    "beweis",
];

fn rule_matches(units: &[u16], rule: &(&[&str], bool, &str)) -> bool {
    if rule.1 {
        has_whole_word(units, rule.0)
    } else {
        has_word(units, rule.0)
    }
}

/// When several rules match, `code.review` and `media.image` win, otherwise the first rule in table order.
fn category_of(units: &[u16]) -> &'static str {
    RULES
        .iter()
        .filter(|r| r.2 == "code.review" || r.2 == "media.image")
        .chain(RULES.iter())
        .find(|r| rule_matches(units, r))
        .map_or("general.chat", |r| r.2)
}

/// `/^(w1|w2|...)[!.\s]*$/i.test(message.trim())`.
fn is_closed_phrase(message: &str, words: &[&str]) -> bool {
    let all = utf16(message);
    let units = trim_units(&all);
    words.iter().any(|w| {
        starts_with(units, 0, w).is_some_and(|end| {
            units[end..]
                .iter()
                .all(|u| *u == 0x21 || *u == 0x2e || is_space_unit(*u))
        })
    })
}

/// The continuation words that make a message a follow-up of the active task.
pub(crate) fn is_followup(message: &str) -> bool {
    is_closed_phrase(
        message,
        &[
            "yes", "no", "ok", "continue", "ja", "nein", "weiter", "genau",
        ],
    )
}

/// `[^\S\n]`: JavaScript white space other than a line feed.
fn is_inline_space(u: u16) -> bool {
    u != 0x0a && is_space_unit(u)
}

fn skip(units: &[u16], mut at: usize, class: impl Fn(u16) -> bool) -> usize {
    while units.get(at).is_some_and(|u| class(*u)) {
        at += 1;
    }
    at
}

/// One match of the separator at `at`, as its end:
/// `;[^\S\n]*(?:(?:then|danach|anschließend)[^\S\n]+)?` or `\n+(?:[-*][^\S\n]*|\d+[.)][^\S\n]*)?` or
/// `(?<=\s)(?:and then|und danach|then|danach)\s+`, in that order.
fn separator_at(units: &[u16], at: usize) -> Option<usize> {
    let unit = *units.get(at)?;
    if unit == 0x3b {
        let spaces = skip(units, at + 1, is_inline_space);
        let connector = ["then", "danach", "anschließend"].iter().find_map(|w| {
            let end = starts_with(units, spaces, w)?;
            let after = skip(units, end, is_inline_space);
            (after > end).then_some(after)
        });
        return Some(connector.unwrap_or(spaces));
    }
    if unit == 0x0a {
        let lines = skip(units, at, |u| u == 0x0a);
        let marker = match units.get(lines) {
            Some(0x2d | 0x2a) => Some(lines + 1),
            Some(_) => {
                let digits = skip(units, lines, |u| (0x30..=0x39).contains(&u));
                (digits > lines && matches!(units.get(digits), Some(0x2e | 0x29)))
                    .then_some(digits + 1)
            }
            None => None,
        };
        return Some(marker.map_or(lines, |m| skip(units, m, is_inline_space)));
    }
    if at > 0 && is_space_unit(units[at - 1]) {
        return ["and then", "und danach", "then", "danach"]
            .iter()
            .find_map(|w| {
                let end = starts_with(units, at, w)?;
                let after = skip(units, end, is_space_unit);
                (after > end).then_some(after)
            });
    }
    None
}

/// `/then|danach|anschließend/i.test(text)`.
fn names_a_sequence(units: &[u16]) -> bool {
    (0..units.len()).any(|i| {
        ["then", "danach", "anschließend"]
            .iter()
            .any(|w| starts_with(units, i, w).is_some())
    })
}

struct Part {
    start: usize,
    end: usize,
    dependent: bool,
}

/// The parts of a message between separators, without surrounding white space; empty fragments are dropped.
fn parts_of(units: &[u16]) -> Vec<Part> {
    let mut parts = Vec::new();
    let mut add = |a: usize, b: usize, dependent: bool| {
        let slice = &units[a..b];
        let text = trim_units(slice);
        if !text.is_empty() {
            let offset = slice.iter().position(|u| !is_space_unit(*u)).unwrap_or(0);
            parts.push(Part {
                start: a + offset,
                end: a + offset + text.len(),
                dependent,
            });
        }
    };
    let (mut start, mut dependent, mut at) = (0, false, 0);
    while at < units.len() {
        match separator_at(units, at) {
            Some(end) => {
                add(start, at, dependent);
                dependent = names_a_sequence(&units[at..end]);
                start = end;
                at = end;
            }
            None => at += 1,
        }
    }
    add(start, units.len(), dependent);
    parts
}

fn distribution_j(d: [f64; 4]) -> J {
    J::obj([
        ("small", J::Num(d[0])),
        ("medium", J::Num(d[1])),
        ("large", J::Num(d[2])),
        ("frontier", J::Num(d[3])),
    ])
}

/// `ruleClassifier({ message, cost })`. Explicit task connectors split, an ordinary "and" inside a task does not.
pub fn rule_classifier(message: &str, cost: CostPreference) -> TriageDecision {
    let decision = |shape: &str, tasks: Vec<J>| {
        TriageDecision(J::obj([
            ("schema", J::s(SCHEMA)),
            ("shape", J::s(shape)),
            ("tasks", J::Arr(tasks)),
        ]))
    };
    let all = utf16(message);
    if trim_units(&all).is_empty()
        || is_closed_phrase(message, &["hi", "hello", "hallo", "danke", "thanks"])
    {
        return decision("chat", Vec::new());
    }
    let parts = parts_of(&all);
    let tasks: Vec<J> = parts
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let text = &all[p.start..p.end];
            let category = category_of(text);
            let complex = has_word(text, &COMPLEX);
            let medium = ["code.", "data.", "web."]
                .iter()
                .any(|prefix| category.starts_with(prefix));
            let model_class = if complex {
                [0.0, 0.1, 0.85, 0.05]
            } else if medium {
                [0.1, 0.75, 0.12, 0.03]
            } else {
                [0.85, 0.1, 0.04, 0.01]
            };
            let confidence = if category == "general.chat" {
                0.4
            } else {
                0.85
            };
            // The three distributions are valid, so a class always comes back.
            let chosen =
                choose_class(model_class, cost, confidence).unwrap_or(ModelClass::Frontier);
            let effort = if complex {
                Effort::High
            } else if medium {
                Effort::Medium
            } else {
                Effort::Low
            };
            let depends_on = if p.dependent && i > 0 {
                vec![J::Str(format!("k{i}"))]
            } else {
                Vec::new()
            };
            let mut categories = J::Obj(Vec::new());
            categories.set(category, J::Num(1.0));
            J::obj([
                ("id", J::Str(format!("k{}", i + 1))),
                ("summary", J::Str(String::from_utf16_lossy(text))),
                ("start", J::Num(p.start as f64)),
                ("end", J::Num(p.end as f64)),
                ("categories", categories),
                ("modelClass", distribution_j(model_class)),
                ("chosenClass", J::s(chosen.as_str())),
                ("effort", J::s(effort.as_str())),
                ("dependsOn", J::Arr(depends_on)),
                ("confidence", J::Num(confidence)),
                (
                    "reason",
                    J::Str(format!(
                        "rule:{category}; smallest class above-tail <= {}",
                        cost.threshold_text()
                    )),
                ),
            ])
        })
        .collect();
    decision(if tasks.len() > 1 { "multi" } else { "single" }, tasks)
}
