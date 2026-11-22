//! `session/rewind-path.ts` and `session/rewind-cycles.ts`: the pure transcript overlays the store's readers apply
//! (D120 H4, Q13). Persistent messages, events and summaries stay unchanged; these functions only choose what a reader
//! sees, and compute the digest that ties an overlay to the text it hid. They live here because `store.ts` calls them
//! (`contextMessages`, `forkSession`, `rewindPath`, `rewindProposal`); the rewind service of K5c reuses them.
use super::types::{EventRecord, MessageRecord, RewindRecord};
use crate::approvals::js_json::J;
use crate::js::{is_js_space, json_stringify};
use crate::metrics::registry::js_number_to_string;
use std::collections::{HashMap, HashSet};

/// `RewindRange`: the visibility fields of a stored rewind. An undone rewind has no effect on the active path.
#[derive(Clone, Debug, PartialEq)]
pub struct RewindRange {
    /// First hidden seq.
    pub hidden_from_seq: i64,
    /// Last hidden seq.
    pub hidden_to_seq: i64,
    /// Undo instant; `Some` means the range no longer hides anything.
    pub undone_at: Option<i64>,
    /// The lesson message, which an undo makes obsolete.
    pub lesson_message_id: Option<String>,
}

impl From<&RewindRecord> for RewindRange {
    fn from(r: &RewindRecord) -> Self {
        Self {
            hidden_from_seq: r.hidden_from_seq,
            hidden_to_seq: r.hidden_to_seq,
            undone_at: r.undone_at,
            lesson_message_id: r.lesson_message_id.clone(),
        }
    }
}

/// What `activePath` needs of an item: its seq and, optionally, its id.
pub trait PathItem {
    /// `seq`.
    fn seq(&self) -> i64;
    /// `id`, where the item has one.
    fn id(&self) -> Option<&str>;
}

impl PathItem for MessageRecord {
    fn seq(&self) -> i64 {
        self.seq
    }
    fn id(&self) -> Option<&str> {
        Some(&self.id)
    }
}

/// `activePath`: the items in their original order that no live overlay hides, minus the lesson of every undone rewind.
pub fn active_path<T: PathItem + Clone>(items: &[T], rewinds: &[RewindRange]) -> Vec<T> {
    let ranges: Vec<&RewindRange> = rewinds.iter().filter(|r| r.undone_at.is_none()).collect();
    // Undo removes the overlay's note from the view as well; the note remains in the append-only transcript.
    let obsolete: HashSet<&str> = rewinds
        .iter()
        .filter(|r| r.undone_at.is_some())
        .filter_map(|r| r.lesson_message_id.as_deref())
        .collect();
    items
        .iter()
        .filter(|m| {
            !m.id().is_some_and(|id| obsolete.contains(id))
                && !ranges
                    .iter()
                    .any(|r| m.seq() >= r.hidden_from_seq && m.seq() <= r.hidden_to_seq)
        })
        .cloned()
        .collect()
}

/// `activeSummaries`: excludes summaries whose original inclusive range overlaps a live rewind.
pub fn active_summaries(
    summaries: &[super::types::SummaryRecord],
    rewinds: &[RewindRange],
) -> Vec<super::types::SummaryRecord> {
    let ranges: Vec<&RewindRange> = rewinds.iter().filter(|r| r.undone_at.is_none()).collect();
    summaries
        .iter()
        .filter(|s| {
            !ranges
                .iter()
                .any(|r| s.from_seq <= r.hidden_to_seq && s.to_seq >= r.hidden_from_seq)
        })
        .cloned()
        .collect()
}

/// `hiddenDigest`: SHA-256 of the ordered JSON `[id, text]` tuples, `[` and `]` around them, as lower-case hex
/// (D120 section 10.4). The text is hashed as its UTF-8 bytes.
pub fn hidden_digest(messages: &[MessageRecord]) -> String {
    let mut text = String::from("[");
    for (i, m) in messages.iter().enumerate() {
        if i > 0 {
            text.push(',');
        }
        text.push('[');
        text.push_str(&json_stringify(&m.id));
        text.push(',');
        text.push_str(&json_stringify(&m.text));
        text.push(']');
    }
    text.push(']');
    crate::identity::sha256_hex(&[text.as_bytes()])
}

/// `String(value)` for a parsed JSON value (`undefined` for a missing member).
pub(crate) fn js_string(v: Option<&J>) -> String {
    match v {
        None => "undefined".to_owned(),
        Some(J::Null) => "null".to_owned(),
        Some(J::Bool(b)) => b.to_string(),
        Some(J::Num(n)) => js_number_to_string(*n),
        Some(J::Str(s)) => s.clone(),
        Some(J::Arr(a)) => a
            .iter()
            .map(|x| match x {
                J::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(J::Obj(_)) => "[object Object]".to_owned(),
    }
}

fn record(v: Option<&J>) -> J {
    match v {
        Some(o @ J::Obj(_)) => o.clone(),
        _ => J::Obj(Vec::new()),
    }
}

fn is_nullish(v: Option<&J>) -> bool {
    matches!(v, None | Some(J::Null))
}

/// `rewindResult`: reads a stored dispatcher envelope; malformed or plain output provides no trustworthy result facts.
pub fn rewind_result(event: &EventRecord) -> J {
    let mut output: Option<J> = event.data.get("output").cloned();
    if let Some(J::Str(text)) = &output {
        match J::parse(text) {
            Some(parsed) => output = Some(parsed),
            None => return J::Obj(Vec::new()),
        }
    }
    let envelope = record(output.as_ref());
    let inner = envelope.get("value");
    let base = if is_nullish(inner) {
        record(Some(&envelope))
    } else {
        record(inner)
    };
    let mut out = base;
    if let Some(J::Bool(b)) = envelope.get("isError") {
        out.set("isError", J::Bool(*b));
    }
    out
}

fn single_line(s: &str) -> bool {
    !s.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
}

/// `/^(?:--test(?:=.*)?|test(?::[^\s]+)?|pytest|vitest|jest|mocha|ctest|go-test)$/`, written out: `.` stops at a line
/// terminator, `\s` is JavaScript's white space.
fn is_test_argument(s: &str) -> bool {
    if s == "--test"
        || [
            "pytest", "vitest", "jest", "mocha", "ctest", "go-test", "test",
        ]
        .contains(&s)
    {
        return true;
    }
    if let Some(rest) = s.strip_prefix("--test=") {
        return single_line(rest);
    }
    if let Some(rest) = s.strip_prefix("test:") {
        return !rest.is_empty() && !rest.chars().any(is_js_space);
    }
    false
}

fn is_check(call: &EventRecord) -> bool {
    let name = js_string(call.data.get("name"));
    if name == "code.check" || name == "coding_complete" {
        return true;
    }
    if call.data.get("name").and_then(J::as_str) != Some("exec.run") {
        return false;
    }
    let args = record(call.data.get("args"));
    match args.get("argv") {
        Some(J::Arr(argv)) => argv
            .iter()
            .any(|a| matches!(a, J::Str(s) if is_test_argument(s))),
        _ => false,
    }
}

/// What `failedEditCycles` counts.
#[derive(Clone, Debug, PartialEq)]
pub struct EditCycles {
    /// Failed edit/check cycles in a row.
    pub failed_cycles: i64,
    /// The turn of the first edit of the streak.
    pub from_turn_id: Option<String>,
    /// The seq of the last check result.
    pub last_check_seq: i64,
    /// An edit without a check after it.
    pub pending_edit: bool,
}

/// `failedEditCycles` (D120 Q13): counts successful edits followed by failed checks on the active transcript, never agent
/// claims. N=3 is fixed by Q13; extra checks without a new successful edit never increment the streak.
pub fn failed_edit_cycles(events: &[EventRecord]) -> EditCycles {
    let mut calls: HashMap<String, (&EventRecord, bool)> = HashMap::new();
    let (mut dirty, mut write_turn, mut from_turn): (bool, Option<String>, Option<String>) =
        (false, None, None);
    let (mut failed_cycles, mut last_check_seq) = (0_i64, 0_i64);
    for event in events {
        let key = format!(
            "{}:{}",
            event.turn_id.as_deref().unwrap_or("null"),
            js_string(event.data.get("id"))
        );
        if event.kind == "tool.call" {
            calls.insert(key, (event, dirty));
            continue;
        }
        if event.kind != "tool.result" {
            continue;
        }
        let Some((call, after_write)) = calls.remove(&key) else {
            continue;
        };
        let value = rewind_result(event);
        let value_is_error = value.get("isError");
        let failed = event.data.get("isError") == Some(&J::Bool(true))
            || value_is_error == Some(&J::Bool(true))
            || value.get("ok") == Some(&J::Bool(false))
            || matches!(value.get("exitCode"), Some(J::Num(n)) if *n != 0.0);
        let name = js_string(call.data.get("name"));
        if (name == "file.edit" || name == "file.write")
            && !failed
            && (value_is_error == Some(&J::Bool(false))
                || event.data.get("isError") == Some(&J::Bool(false)))
        {
            dirty = true;
            if write_turn.is_none() {
                write_turn = event.turn_id.clone();
            }
        } else if is_check(call) {
            last_check_seq = event.seq;
            let ok = value.get("ok") == Some(&J::Bool(true))
                || matches!(value.get("exitCode"), Some(J::Num(n)) if *n == 0.0);
            if !failed && ok {
                failed_cycles = 0;
                from_turn = None;
                dirty = false;
                write_turn = None;
            } else if failed && dirty && after_write {
                failed_cycles += 1;
                if from_turn.is_none() {
                    from_turn = write_turn.clone();
                }
                dirty = false;
                write_turn = None;
            }
        }
    }
    EditCycles {
        failed_cycles,
        from_turn_id: from_turn,
        last_check_seq,
        pending_edit: dirty,
    }
}
