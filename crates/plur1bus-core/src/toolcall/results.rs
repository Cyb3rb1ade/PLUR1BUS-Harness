//! Result shaping and idempotency (`toolcall/results.ts`): what a model is shown of a tool's return value, and the key
//! under which a call is remembered.
//!
//! A result is never cut in the middle: it fits the byte budget whole or the model gets a reference to the full value. An
//! error keeps its code and a one-line hint and loses everything else (no stack, no payload). The idempotency key is the
//! SHA-256 of canonical JSON over scope, name and arguments, so the same call in the same scope runs once
//! (`fixtures/parity/toolcall/results.json`).
use super::json::{parse, JsStr, Obj, V};
use super::validation::{PortFailed, Thrown};
use plur1bus_log_schema::redact::utf16::well_formed_prefix_units;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// The default budget: 8k tokens, conservatively counted as 32 KiB.
pub const DEFAULT_RESULT_BYTES: usize = 32 * 1024;

/// The codes a tool's own error envelope may carry to the model (`ToolErrorCode`); any other becomes `tool-failed`.
pub const TOOL_ERROR_CODES: &[&str] = &[
    "tool-unknown",
    "tool-call-invalid",
    "tool-denied",
    "tool-not-approved",
    "tool-timeout",
    "tool-failed",
    "tool-result-too-large",
    "tool-result-invalid",
    "aborted",
];

/// What a tool returned, as far as its shape matters to the cap.
#[derive(Clone, Copy, Debug)]
pub enum ResultValue<'a> {
    /// The tool failed with an exception (`value instanceof Error`).
    Failed,
    /// Binary data (`Uint8Array`, `ArrayBuffer`): always referenced, never inlined.
    Binary(&'a [u8]),
    /// `undefined`.
    Undefined,
    /// A JSON value.
    Json(&'a V),
}

/// Where the full value goes when it does not fit (`FullResultPort`); returns the reference the model is given.
pub trait FullResultPort {
    /// Stores the value.
    fn put(&mut self, value: &ResultValue<'_>) -> Result<String, PortFailed>;
}

/// The error of a capped result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CappedError {
    /// One of [`TOOL_ERROR_CODES`].
    pub code: &'static str,
    /// One line, at most 80 UTF-16 code units.
    pub hint: String,
}

/// What the model is shown (`CappedResult`).
#[derive(Clone, Debug)]
pub struct CappedResult {
    /// The tool reported or raised an error.
    pub is_error: bool,
    /// The value, where it fits.
    pub value: Option<V>,
    /// Code and hint of an error that fits.
    pub error: Option<CappedError>,
    /// The full value is behind `reference`.
    pub truncated: bool,
    /// The reference of the full value.
    pub reference: Option<String>,
}

impl CappedResult {
    /// The object TypeScript returns, member for member.
    pub fn to_v(&self) -> V {
        let mut o = Obj::new();
        o.set("isError", V::Bool(self.is_error));
        if let Some(value) = &self.value {
            o.set("value", value.clone());
        }
        if let Some(error) = &self.error {
            o.set(
                "error",
                V::obj([("code", V::s(error.code)), ("hint", V::s(&error.hint))]),
            );
        }
        o.set("truncated", V::Bool(self.truncated));
        if let Some(reference) = &self.reference {
            o.set("reference", V::s(reference));
        }
        V::Obj(o)
    }
}

/// One call of a batch (`BatchCall`).
#[derive(Clone, Debug)]
pub struct BatchCall {
    /// The tool.
    pub name: String,
    /// Its arguments.
    pub arguments: V,
    /// Whether it may overlap with its neighbours; a call that may not is a barrier.
    pub parallel_safe: bool,
    /// Separates calls that are otherwise equal.
    pub operation_id: Option<String>,
}

/// Runs a call once per key (`IdempotencyPort`). The in-memory port forgets at a restart; a durable one is needed
/// across them.
pub trait IdempotencyPort {
    /// The remembered result for `key`, or the result of `execute`, remembered.
    fn run(&mut self, key: &str, execute: &mut dyn FnMut() -> V) -> V;
}

/// `MemoryIdempotency`: repeated calls with one key share the first result.
#[derive(Debug, Default)]
pub struct MemoryIdempotency {
    calls: HashMap<String, V>,
}

impl MemoryIdempotency {
    /// An empty memory.
    pub fn new() -> Self {
        MemoryIdempotency::default()
    }

    /// Forgets everything.
    pub fn clear(&mut self) {
        self.calls.clear();
    }
}

impl IdempotencyPort for MemoryIdempotency {
    fn run(&mut self, key: &str, execute: &mut dyn FnMut() -> V) -> V {
        if let Some(v) = self.calls.get(key) {
            return v.clone();
        }
        let v = execute();
        self.calls.insert(key.to_owned(), v.clone());
        v
    }
}

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// A hint as the model sees it: line breaks become one space each run, then the first 80 code units.
fn one_line(hint: &JsStr) -> String {
    let mut units = Vec::with_capacity(hint.len());
    let mut in_break = false;
    for u in hint.units() {
        let line_break = matches!(*u, 0x0a | 0x0d);
        if !line_break {
            units.push(*u);
        } else if !in_break {
            units.push(0x20);
        }
        in_break = line_break;
    }
    well_formed_prefix_units(&units, 80)
}

/// `capResult`: the result as the model sees it, whole within `max_bytes` or as a reference to the stored full value.
/// A reference that does not fit the budget either is an error of the caller's configuration, not a result.
pub fn cap_result(
    value: ResultValue<'_>,
    store: &mut dyn FullResultPort,
    max_bytes: usize,
) -> Result<CappedResult, Thrown> {
    if max_bytes < 128 || u64::try_from(max_bytes).map_or(true, |n| n > MAX_SAFE_INTEGER) {
        return Err(Thrown::error("result budget must be at least 128 bytes"));
    }
    let shaped = |is_error: bool,
                  value: Option<V>,
                  error: Option<CappedError>,
                  reference: Option<String>| CappedResult {
        is_error,
        value,
        error,
        truncated: reference.is_some(),
        reference,
    };
    let referenced =
        |is_error: bool, store: &mut dyn FullResultPort| -> Result<CappedResult, Thrown> {
            let reference = store
                .put(&value)
                .map_err(|PortFailed| Thrown::error("full-result store failed"))?;
            let compact = shaped(is_error, None, None, Some(reference));
            if compact.to_v().stringify().len() > max_bytes {
                return Err(Thrown::error("full-result reference exceeds result budget"));
            }
            Ok(compact)
        };
    let envelope = match value {
        ResultValue::Failed => {
            let error = CappedError {
                code: "tool-failed",
                hint: "Tool failed; inspect its trace or try a different approach.".to_owned(),
            };
            return Ok(shaped(true, None, Some(error), None));
        }
        // A tool's own error envelope: only an object with `isError: true`, and of it only a known code and a hint.
        ResultValue::Json(V::Obj(o)) if matches!(o.get("isError"), Some(V::Bool(true))) => {
            let error = o.get("error").and_then(V::as_obj);
            let code = error
                .and_then(|e| e.get("code"))
                .and_then(|c| TOOL_ERROR_CODES.iter().find(|known| c.is_str(known)))
                .copied()
                .unwrap_or("tool-failed");
            let hint = error
                .and_then(|e| e.get("hint"))
                .and_then(V::as_js)
                .map_or_else(|| "Tool reported an error.".to_owned(), one_line);
            let result = shaped(true, None, Some(CappedError { code, hint }), None);
            if result.to_v().stringify().len() <= max_bytes {
                return Ok(result);
            }
            return referenced(true, store);
        }
        ResultValue::Json(v) => Some(V::obj([
            ("isError", V::Bool(false)),
            ("value", v.clone()),
            ("truncated", V::Bool(false)),
        ])),
        ResultValue::Undefined => Some(V::obj([
            ("isError", V::Bool(false)),
            ("truncated", V::Bool(false)),
        ])),
        ResultValue::Binary(_) => None,
    };
    // What is returned is the text read back, as TypeScript returns `JSON.parse(text)`: `-0` is `0` afterwards and a
    // number that is not finite is `null`.
    let text = envelope
        .map(|e| e.stringify())
        .filter(|t| t.len() <= max_bytes);
    if let Some(parsed) = text.as_deref().and_then(parse) {
        return Ok(shaped(false, parsed.get("value").cloned(), None, None));
    }
    referenced(false, store)
}

fn canonical(value: &V, out: &mut String) -> Result<(), Thrown> {
    match value {
        V::Num(n) if !n.is_finite() => {
            return Err(Thrown::error(
                "idempotency arguments must be finite acyclic JSON",
            ));
        }
        V::Null | V::Bool(_) | V::Num(_) | V::Str(_) => out.push_str(&value.stringify()),
        V::Arr(a) => {
            out.push('[');
            for (i, v) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical(v, out)?;
            }
            out.push(']');
        }
        V::Obj(o) => {
            // `Object.keys(value).sort()`: by UTF-16 code unit.
            let mut members: Vec<&(JsStr, V)> = o.entries().iter().collect();
            members.sort_by(|a, b| a.0.cmp(&b.0));
            out.push('{');
            for (i, (k, v)) in members.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&V::Str(k.clone()).stringify());
                out.push(':');
                canonical(v, out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// `idempotencyKey`: SHA-256 (hex) of the canonical JSON of `[scope, name, args]`, members sorted. The scope should
/// name agent, session and logical task; it is never reused across unrelated actions of a person.
pub fn idempotency_key(scope: &str, name: &str, args: &V) -> Result<String, Thrown> {
    let mut text = format!("[{},{},", V::s(scope).stringify(), V::s(name).stringify());
    canonical(args, &mut text)?;
    text.push(']');
    Ok(Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Joins scope and operation id injectively: `\` and `:` inside a part are escaped, so `("a:b", "c")` and
/// `("a", "b:c")` never share a key, and so never a remembered, approved result.
fn scoped_operation(scope: &str, operation_id: Option<&str>) -> String {
    let escape = |part: &str| {
        let mut out = String::with_capacity(part.len());
        for c in part.chars() {
            if matches!(c, '\\' | ':') {
                out.push('\\');
            }
            out.push(c);
        }
        out
    };
    format!("{}:{}", escape(scope), escape(operation_id.unwrap_or("")))
}

/// The runs of a batch that may overlap: neighbouring parallel-safe calls form one group, every other call is a group
/// of its own and a barrier between the groups around it.
pub fn batch_groups(calls: &[BatchCall]) -> Vec<std::ops::Range<usize>> {
    let mut groups: Vec<std::ops::Range<usize>> = Vec::new();
    for (i, call) in calls.iter().enumerate() {
        match groups.last_mut() {
            Some(last) if call.parallel_safe && calls[last.start].parallel_safe => last.end = i + 1,
            _ => groups.push(i..i + 1),
        }
    }
    groups
}

/// `executeBatch`, one call after the other: results in request order, each call under its idempotency key, a failed
/// execution as a typed `tool-failed` result (which is remembered like any other). Policy is the executor's. A caller
/// with a runtime may overlap the calls of one group of [`batch_groups`]; the results and what runs are the same.
pub fn execute_batch(
    scope: &str,
    calls: &[BatchCall],
    execute: &mut dyn FnMut(&BatchCall, &str) -> Result<V, PortFailed>,
    idempotency: &mut dyn IdempotencyPort,
) -> Result<Vec<V>, Thrown> {
    let mut out = Vec::with_capacity(calls.len());
    for call in calls {
        let key = idempotency_key(
            &scoped_operation(scope, call.operation_id.as_deref()),
            &call.name,
            &call.arguments,
        )?;
        let mut run = || {
            execute(call, &key).unwrap_or_else(|PortFailed| {
                V::obj([
                    ("isError", V::Bool(true)),
                    (
                        "error",
                        V::obj([
                            ("code", V::s("tool-failed")),
                            ("hint", V::s("Tool execution failed.")),
                        ]),
                    ),
                ])
            })
        };
        out.push(idempotency.run(&key, &mut run));
    }
    Ok(out)
}
