//! Argument validation and repair (`toolcall/validation.ts`): the step between what a model wrote and what a tool is
//! called with. A call whose arguments do not fit the tool's schema is not executed; the model gets the list of issues.
//!
//! The rule of this port is that Rust never accepts what TypeScript refuses. The reader is `JSON.parse` itself
//! ([`super::json`]), the three repairs are the ones a model family's quirks allow and nothing else, patterns are
//! ECMAScript regular expressions with the `u` flag, and every text of an issue is the text TypeScript writes
//! (`fixtures/parity/toolcall/{arguments,validation}.json`).
use super::json::{parse_units, JsStr, Obj, Parsed, V};
use super::quirks::lookup_quirks;
use crate::metrics::registry::js_number_to_string;
use plur1bus_log_schema::redact::matcher::SecretMatcher;
use plur1bus_log_schema::redact::utf16::{utf8_len, well_formed_prefix};
use std::collections::{hash_map::Entry, HashMap};
use std::sync::Arc;

/// A thrown `Error`: a programmer's mistake (an unsupported schema, a tool name a provider refuses), never a model's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Thrown {
    /// `Error`, or `SyntaxError` for a pattern the regular-expression engine refuses.
    pub name: &'static str,
    /// The message. For a `SyntaxError` it is this engine's, not V8's.
    pub message: String,
}

impl Thrown {
    /// `Error(message)`.
    pub fn error(message: impl Into<String>) -> Thrown {
        Thrown {
            name: "Error",
            message: message.into(),
        }
    }

    /// A `SyntaxError` whose text does not matter.
    pub fn syntax() -> Thrown {
        Thrown {
            name: "SyntaxError",
            message: "invalid syntax".to_owned(),
        }
    }
}

/// One problem with the arguments (`ValidationIssue`): a JSON pointer, what was expected, what came, and a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Issue {
    /// JSON pointer to the offending value; empty for the arguments themselves.
    pub path: JsStr,
    /// What the schema wanted.
    pub expected: JsStr,
    /// What came, clipped to 80 code units and with known secrets masked.
    pub got: JsStr,
    /// The sentence for the model.
    pub message: JsStr,
}

impl Issue {
    fn new(
        path: &JsStr,
        expected: impl Into<JsStr>,
        got: impl Into<JsStr>,
        message: impl Into<JsStr>,
    ) -> Issue {
        Issue {
            path: path.clone(),
            expected: expected.into(),
            got: got.into(),
            message: message.into(),
        }
    }

    /// `{ path, expected, got, message }`.
    pub fn to_v(&self) -> V {
        V::obj([
            ("path", V::Str(self.path.clone())),
            ("expected", V::Str(self.expected.clone())),
            ("got", V::Str(self.got.clone())),
            ("message", V::Str(self.message.clone())),
        ])
    }
}

/// One repair that was applied (`RepairRecord`): `unwrap-json-string`, `trailing-comma` or `numeric-string`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepairRecord {
    /// Which repair.
    pub kind: &'static str,
    /// Where (a JSON pointer; empty for the document).
    pub path: JsStr,
}

/// What the model is asked in the one repair round (`RepairRequest`).
#[derive(Clone, Debug)]
pub struct RepairRequest {
    /// The tool's name.
    pub tool: String,
    /// The arguments as far as they were read: the parsed value, the raw text where it did not parse, nothing where
    /// the text was too large. A document deeper than the reader builds arrives as its raw text.
    pub args: Option<V>,
    /// The issues of the first attempt.
    pub issues: Vec<Issue>,
    /// The text to show the model.
    pub message: JsStr,
}

impl RepairRequest {
    /// `{ tool, args, issues, message }` (`args` left out where there is none, as `JSON.stringify` leaves `undefined` out).
    pub fn to_v(&self) -> V {
        let mut o = Obj::new();
        o.set("tool", V::s(&self.tool));
        if let Some(args) = &self.args {
            o.set("args", args.clone());
        }
        o.set(
            "issues",
            V::Arr(self.issues.iter().map(Issue::to_v).collect()),
        );
        o.set("message", V::Str(self.message.clone()));
        V::Obj(o)
    }
}

/// A port threw or rejected. What it said is not kept: no caller of this module shows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PortFailed;

/// The model repair port (`ModelRepairPort`), asked at most once per call. `Ok(None)` is an answer of `undefined`;
/// `Err` is a port that threw, which leaves the first attempt's issues standing.
pub trait RepairPort {
    /// Asks the model for corrected arguments.
    fn repair(&mut self, request: &RepairRequest) -> Result<Option<V>, PortFailed>;
}

/// The current secret matcher (`knownSecrets().matcher`); an `Err` withholds the value from the issue.
pub type KnownSecrets<'a> = &'a dyn Fn() -> Result<Arc<SecretMatcher>, PortFailed>;

/// The refusal a model sees (`ToolCallInvalid["error"]`).
#[derive(Clone, Debug)]
pub struct InvalidCall {
    /// `Invalid arguments for <tool>`.
    pub message: String,
    /// The issues of the last attempt.
    pub issues: Vec<Issue>,
}

/// The code of [`InvalidCall`].
pub const INVALID_CODE: &str = "tool-call-invalid";
/// The hint of [`InvalidCall`].
pub const INVALID_HINT: &str = "Use the input schema to correct the listed fields.";

/// What [`prepare_call`] decided (`PreparedCall`).
#[derive(Clone, Debug)]
pub struct PreparedCall {
    /// The repairs applied, in order, across both attempts.
    pub repairs: Vec<RepairRecord>,
    /// Whether the model was asked (0 or 1).
    pub repair_rounds: u8,
    /// The arguments to call the tool with, or the refusal.
    pub outcome: Result<V, InvalidCall>,
}

impl PreparedCall {
    /// The object TypeScript returns, member for member.
    pub fn to_v(&self) -> V {
        let repairs = V::Arr(
            self.repairs
                .iter()
                .map(|r| V::obj([("kind", V::s(r.kind)), ("path", V::Str(r.path.clone()))]))
                .collect(),
        );
        let rounds = V::Num(f64::from(self.repair_rounds));
        match &self.outcome {
            Ok(arguments) => V::obj([
                ("ok", V::Bool(true)),
                ("arguments", arguments.clone()),
                ("repairs", repairs),
                ("repairRounds", rounds),
            ]),
            Err(e) => V::obj([
                ("ok", V::Bool(false)),
                ("repairs", repairs),
                ("repairRounds", rounds),
                (
                    "error",
                    V::obj([
                        ("code", V::s(INVALID_CODE)),
                        ("message", V::s(&e.message)),
                        ("hint", V::s(INVALID_HINT)),
                        ("issues", V::Arr(e.issues.iter().map(Issue::to_v).collect())),
                    ]),
                ),
            ]),
        }
    }
}

const SUPPORTED: &[&str] = &[
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
    "uniqueItems",
    "anyOf",
    "oneOf",
    "allOf",
    "minProperties",
    "maxProperties",
    "description",
    "title",
    "$schema",
    "$id",
    "$comment",
    "default",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
];
const TYPES: &[&str] = &[
    "object", "array", "string", "number", "integer", "boolean", "null",
];
const NUMERIC: &[&str] = &[
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
];
const MAX_ARGUMENT_BYTES: usize = 256 * 1024;
const MAX_NODES: usize = 20_000;
const MAX_VALUE_DEPTH: usize = 64;
const MAX_SCHEMA_DEPTH: usize = 32;
const MAX_SCHEMA_PATTERN_UNITS: usize = 256;
const MAX_PATTERN_INPUT_UNITS: usize = 1024;
const MATCH_STEP_BUDGET: usize = 4_000_000;
const MAX_DISTINCT_PATTERNS: usize = 256;

/// `pointer(p, key)`: one more JSON pointer segment, `~` and `/` escaped.
pub fn pointer(p: &JsStr, key: &JsStr) -> JsStr {
    let mut out: Vec<u16> = p.units().to_vec();
    out.push(u16::from(b'/'));
    for u in key.units() {
        match *u {
            0x7e => out.extend("~0".encode_utf16()),
            0x2f => out.extend("~1".encode_utf16()),
            other => out.push(other),
        }
    }
    JsStr::new(out)
}

/// `new RegExp(pattern, "u")`. A lone surrogate in the pattern is the code point it is, as JavaScript reads it.
pub(super) fn unicode_regex(pattern: &JsStr) -> Result<regress::Regex, Thrown> {
    let points: Vec<u32> = char::decode_utf16(pattern.units().iter().copied())
        .map(|r| r.map_or_else(|e| u32::from(e.unpaired_surrogate()), u32::from))
        .collect();
    let flags = regress::Flags {
        unicode: true,
        ..regress::Flags::default()
    };
    regress::Regex::from_unicode(points.iter().copied(), flags).map_err(|e| Thrown {
        name: "SyntaxError",
        message: format!("Invalid regular expression: /{}/u: {e}", pattern.lossy()),
    })
}

fn is_safe_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0
}

/// `matches(t, v)`: an `integer` is a safe integer, a `number` is finite, anything else is the value's own type name.
fn matches(t: &V, v: &V) -> bool {
    if t.is_str("integer") {
        return v.as_f64().is_some_and(is_safe_integer);
    }
    if t.is_str("number") {
        return v.as_f64().is_some_and(f64::is_finite);
    }
    t.is_str(v.type_of())
}

/// `assertSchema`: the schema vocabulary is checked before any argument is, so that a constraint this validator does not
/// know can never pass silently. Keywords are read in the schema's own order, and the first problem is the one reported.
pub fn assert_schema(s: &V) -> Result<(), Thrown> {
    compile_patterns(s).map(|_| ())
}

type Patterns<'a> = HashMap<&'a JsStr, regress::Regex>;

fn compile_patterns(schema: &V) -> Result<Patterns<'_>, Thrown> {
    let mut patterns = HashMap::new();
    assert_at(schema, 0, &mut patterns)?;
    Ok(patterns)
}

fn assert_at<'a>(s: &'a V, depth: usize, patterns: &mut Patterns<'a>) -> Result<(), Thrown> {
    let Some(o) = s.as_obj().filter(|_| depth <= MAX_SCHEMA_DEPTH) else {
        return Err(Thrown::error("invalid or overly deep tool schema"));
    };
    for (key, v) in o.entries() {
        let k = key.lossy();
        let k = k.as_str();
        if !key.is(k) || !SUPPORTED.contains(&k) {
            return Err(Thrown::error(format!("unsupported schema keyword: {k}")));
        }
        let invalid = || Err(Thrown::error(format!("invalid {k}")));
        match k {
            "properties" => {
                let Some(props) = v.as_obj() else {
                    return invalid();
                };
                for (_, sub) in props.entries() {
                    assert_at(sub, depth + 1, patterns)?;
                }
            }
            "items" => assert_at(v, depth + 1, patterns)?,
            "additionalProperties" => match v {
                V::Obj(_) => assert_at(v, depth + 1, patterns)?,
                V::Bool(_) => {}
                _ => return invalid(),
            },
            "anyOf" | "oneOf" | "allOf" => {
                let Some(subs) = v.as_arr().filter(|a| !a.is_empty()) else {
                    return invalid();
                };
                for sub in subs {
                    assert_at(sub, depth + 1, patterns)?;
                }
            }
            "pattern" => {
                let Some(pattern) = v
                    .as_js()
                    .filter(|p| p.units().len() <= MAX_SCHEMA_PATTERN_UNITS)
                else {
                    return invalid();
                };
                let at_capacity = patterns.len() == MAX_DISTINCT_PATTERNS;
                if let Entry::Vacant(entry) = patterns.entry(pattern) {
                    if at_capacity {
                        return Err(Thrown::error("too many distinct tool schema patterns"));
                    }
                    entry.insert(unicode_regex(pattern)?);
                }
            }
            "type" => {
                let types = v.as_arr().unwrap_or(std::slice::from_ref(v));
                if types.is_empty()
                    || types
                        .iter()
                        .any(|t| !TYPES.iter().any(|name| t.is_str(name)))
                {
                    return invalid();
                }
            }
            "required"
                if !v
                    .as_arr()
                    .is_some_and(|a| a.iter().all(|x| matches!(x, V::Str(_)))) =>
            {
                return invalid();
            }
            "enum" if v.as_arr().is_none_or(|a| a.is_empty()) => return invalid(),
            "uniqueItems" | "deprecated" | "readOnly" | "writeOnly" if !matches!(v, V::Bool(_)) => {
                return invalid();
            }
            _ if NUMERIC.contains(&k) && !v.as_f64().is_some_and(f64::is_finite) => {
                return invalid();
            }
            _ => {}
        }
    }
    Ok(())
}

/// `Math.round`: half goes up, towards positive infinity.
fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

struct Checker<'a, 's> {
    known: Option<KnownSecrets<'a>>,
    patterns: &'s Patterns<'s>,
    steps_left: usize,
}

impl Checker<'_, '_> {
    fn issue(
        &self,
        v: &V,
        path: &JsStr,
        out: &mut Vec<Issue>,
        expected: JsStr,
        message: Option<&str>,
    ) {
        out.push(self.issue_for(v, path, expected, message));
    }

    /// Show the JSON argument with known secrets masked, cut to 80 code units.
    fn issue_for(&self, v: &V, path: &JsStr, expected: JsStr, message: Option<&str>) -> Issue {
        let mut shown = v.stringify();
        if let Some(known) = self.known {
            shown = match known() {
                Ok(matcher) => matcher.mask_text(&shown),
                Err(PortFailed) => "[value withheld]".to_owned(),
            };
        }
        let message =
            message.map_or_else(|| JsStr::from("expected ").plus_js(&expected), JsStr::from);
        Issue {
            path: path.clone(),
            expected,
            got: JsStr::from(well_formed_prefix(&shown, 80)),
            message,
        }
    }

    fn check(
        &mut self,
        s: &V,
        v: &V,
        path: &JsStr,
        out: &mut Vec<Issue>,
        depth: usize,
    ) -> Result<(), Issue> {
        let text = |t: String| JsStr::from(t);
        if depth > MAX_VALUE_DEPTH {
            self.issue(v, path, out, JsStr::from("bounded JSON value"), None);
            return Ok(());
        }
        if let Some(t) = s.get("type") {
            let types = t.as_arr().unwrap_or(std::slice::from_ref(t));
            if !types.iter().any(|t| matches(t, v)) {
                self.issue(v, path, out, t.to_js_string(), None);
                return Ok(());
            }
        }
        if let Some(list) = s.get("enum").filter(|e| e.as_arr().is_some()) {
            if !list
                .as_arr()
                .is_some_and(|a| a.iter().any(|e| e.deep_equal(v)))
            {
                self.issue(
                    v,
                    path,
                    out,
                    text(format!("one of {}", list.stringify())),
                    None,
                );
            }
        }
        if let Some(c) = s.get("const") {
            if !c.deep_equal(v) {
                self.issue(v, path, out, text(c.stringify()), None);
            }
        }
        for k in ["anyOf", "oneOf", "allOf"] {
            let Some(subs) = s.get(k).and_then(V::as_arr) else {
                continue;
            };
            let mut good = 0;
            for sub in subs {
                let mut errors = Vec::new();
                self.check(sub, v, path, &mut errors, depth + 1)?;
                good += usize::from(errors.is_empty());
            }
            if (k == "anyOf" && good == 0)
                || (k == "oneOf" && good != 1)
                || (k == "allOf" && good != subs.len())
            {
                self.issue(v, path, out, JsStr::from(k), None);
            }
        }
        let number = |key: &str| s.get(key).and_then(V::as_f64);
        let shown = js_number_to_string;
        match v {
            V::Obj(o) => {
                let props = s.get("properties").and_then(V::as_obj);
                for key in s.get("required").and_then(V::as_arr).unwrap_or(&[]) {
                    if let Some(key) = key.as_js().filter(|key| !o.has(key)) {
                        out.push(Issue::new(
                            &pointer(path, key),
                            "required value",
                            "missing",
                            "required property missing",
                        ));
                    }
                }
                let additional = s.get("additionalProperties");
                for (key, val) in o.entries() {
                    if let Some(sub) = props.and_then(|p| p.get_js(key)) {
                        self.check(sub, val, &pointer(path, key), out, depth + 1)?;
                    } else if matches!(additional, Some(V::Bool(false))) {
                        out.push(Issue::new(
                            &pointer(path, key),
                            "no additional property",
                            val.type_of(),
                            "unknown property",
                        ));
                    } else if let Some(sub) = additional.filter(|a| a.as_obj().is_some()) {
                        self.check(sub, val, &pointer(path, key), out, depth + 1)?;
                    }
                }
                let count = o.len() as f64;
                if let Some(n) = number("minProperties").filter(|n| count < *n) {
                    self.issue(
                        v,
                        path,
                        out,
                        text(format!("at least {} properties", shown(n))),
                        None,
                    );
                }
                if let Some(n) = number("maxProperties").filter(|n| count > *n) {
                    self.issue(
                        v,
                        path,
                        out,
                        text(format!("at most {} properties", shown(n))),
                        None,
                    );
                }
            }
            V::Arr(a) => {
                let count = a.len() as f64;
                if let Some(n) = number("minItems").filter(|n| count < *n) {
                    self.issue(
                        v,
                        path,
                        out,
                        text(format!("at least {} items", shown(n))),
                        None,
                    );
                }
                if let Some(n) = number("maxItems").filter(|n| count > *n) {
                    self.issue(
                        v,
                        path,
                        out,
                        text(format!("at most {} items", shown(n))),
                        None,
                    );
                }
                if matches!(s.get("uniqueItems"), Some(V::Bool(true)))
                    && a.iter()
                        .enumerate()
                        .any(|(i, x)| a[..i].iter().any(|y| x.deep_equal(y)))
                {
                    self.issue(v, path, out, JsStr::from("unique items"), None);
                }
                if let Some(items) = s.get("items").filter(|i| i.as_obj().is_some()) {
                    for (i, x) in a.iter().enumerate() {
                        self.check(
                            items,
                            x,
                            &pointer(path, &JsStr::from(i.to_string())),
                            out,
                            depth + 1,
                        )?;
                    }
                }
            }
            V::Str(string) => {
                let count = string.code_points() as f64;
                if let Some(n) = number("minLength").filter(|n| count < *n) {
                    self.issue(
                        v,
                        path,
                        out,
                        text(format!("at least {} characters", shown(n))),
                        None,
                    );
                }
                let over_schema_limit = number("maxLength").filter(|n| count > *n);
                if let Some(n) = over_schema_limit {
                    self.issue(
                        v,
                        path,
                        out,
                        text(format!("at most {} characters", shown(n))),
                        None,
                    );
                }
                if let Some(pattern) = s.get("pattern").and_then(V::as_js) {
                    let refused = if string.units().len() > MAX_PATTERN_INPUT_UNITS {
                        // The existing length issue already refuses the value.
                        over_schema_limit.is_none()
                    } else {
                        let matched = self.patterns[pattern]
                            .test_utf16_with_budget(string.units(), 0, &mut self.steps_left)
                            .map_err(|_| {
                                self.issue_for(
                                    v,
                                    path,
                                    JsStr::from("pattern ").plus_js(pattern),
                                    Some("pattern match budget exhausted"),
                                )
                            })?;
                        !matched
                    };
                    if refused {
                        self.issue(v, path, out, JsStr::from("pattern ").plus_js(pattern), None);
                    }
                }
            }
            V::Num(n) => {
                let n = *n;
                if !n.is_finite() {
                    self.issue(v, path, out, JsStr::from("finite number"), None);
                }
                if let Some(m) = number("minimum").filter(|m| n < *m) {
                    self.issue(v, path, out, text(format!(">= {}", shown(m))), None);
                }
                if let Some(m) = number("maximum").filter(|m| n > *m) {
                    self.issue(v, path, out, text(format!("<= {}", shown(m))), None);
                }
                if let Some(m) = number("exclusiveMinimum").filter(|m| n <= *m) {
                    self.issue(v, path, out, text(format!("> {}", shown(m))), None);
                }
                if let Some(m) = number("exclusiveMaximum").filter(|m| n >= *m) {
                    self.issue(v, path, out, text(format!("< {}", shown(m))), None);
                }
                if let Some(m) = number("multipleOf") {
                    if m <= 0.0 || (n / m - js_round(n / m)).abs() > 1e-10 {
                        self.issue(
                            v,
                            path,
                            out,
                            text(format!("multiple of {}", shown(m))),
                            None,
                        );
                    }
                }
            }
            V::Null | V::Bool(_) => {}
        }
        Ok(())
    }
}

/// The safety walk before any schema is applied: at most 20 000 nodes, at most 64 levels, finite numbers only.
fn bounded(v: &V, depth: usize, nodes: &mut usize) -> bool {
    *nodes += 1;
    if *nodes > MAX_NODES || depth > MAX_VALUE_DEPTH {
        return false;
    }
    match v {
        V::Null | V::Str(_) | V::Bool(_) => true,
        V::Num(n) => n.is_finite(),
        V::Arr(a) => a.iter().all(|x| bounded(x, depth + 1, nodes)),
        V::Obj(o) => o
            .entries()
            .iter()
            .all(|(_, x)| bounded(x, depth + 1, nodes)),
    }
}

fn unsafe_value(got: &str) -> Vec<Issue> {
    vec![Issue::new(
        &JsStr::default(),
        "bounded finite acyclic JSON",
        got,
        "invalid JSON arguments",
    )]
}

/// `validateArguments`: the issues of `value` against `schema`; none means the arguments fit. `None` is `undefined`.
pub fn validate_arguments(
    schema: &V,
    value: Option<&V>,
    known: Option<KnownSecrets<'_>>,
) -> Result<Vec<Issue>, Thrown> {
    let patterns = compile_patterns(schema)?;
    let Some(value) = value else {
        return Ok(unsafe_value("undefined"));
    };
    if !bounded(value, 0, &mut 0) {
        return Ok(unsafe_value(value.type_of()));
    }
    let mut issues = Vec::new();
    let mut checker = Checker {
        known,
        patterns: &patterns,
        steps_left: MATCH_STEP_BUDGET,
    };
    if let Err(exhausted) = checker.check(schema, value, &JsStr::default(), &mut issues, 0) {
        issues.push(exhausted);
    }
    Ok(issues)
}

/// `trailingCommas`: drops a comma that only white space separates from a closing `}` or `]`. Tokens are scanned, so a
/// comma inside a quoted string is never changed.
fn trailing_commas(text: &[u16]) -> Vec<u16> {
    let (mut quoted, mut escaped) = (false, false);
    let mut out = Vec::with_capacity(text.len());
    for (i, c) in text.iter().copied().enumerate() {
        if quoted {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == 0x5c {
                escaped = true;
            } else if c == 0x22 {
                quoted = false;
            }
            continue;
        }
        if c == 0x22 {
            quoted = true;
        }
        if c == 0x2c {
            let next = text[i + 1..]
                .iter()
                .find(|u| !crate::js::is_space_unit(**u));
            if matches!(next, Some(0x7d | 0x5d)) {
                continue;
            }
        }
        out.push(c);
    }
    out
}

/// `normalize`: a string that is a JSON number literal becomes that number where the schema asks for one.
fn normalize(
    s: &V,
    v: V,
    path: &JsStr,
    log: &mut Vec<RepairRecord>,
    allowed: &[&str],
    depth: usize,
) -> V {
    if depth > MAX_VALUE_DEPTH {
        return v;
    }
    let wanted = s
        .get("type")
        .filter(|t| t.is_str("integer") || t.is_str("number"));
    if let (true, Some(t), V::Str(text)) = (allowed.contains(&"numeric-string"), wanted, &v) {
        if let Some(n) =
            super::json::number_literal(text.units()).filter(|n| matches(t, &V::Num(*n)))
        {
            log.push(RepairRecord {
                kind: "numeric-string",
                path: path.clone(),
            });
            return V::Num(n);
        }
    }
    match (
        v,
        s.get("properties").and_then(V::as_obj),
        s.get("items").filter(|i| i.as_obj().is_some()),
    ) {
        (V::Obj(o), Some(props), _) => {
            let mut pairs = Vec::with_capacity(o.len());
            for (key, val) in o.entries() {
                let val = match props.get_js(key).filter(|sub| sub.as_obj().is_some()) {
                    Some(sub) => normalize(
                        sub,
                        val.clone(),
                        &pointer(path, key),
                        log,
                        allowed,
                        depth + 1,
                    ),
                    None => val.clone(),
                };
                pairs.push((key.clone(), val));
            }
            V::Obj(Obj::from_pairs(pairs))
        }
        (V::Arr(a), _, Some(items)) => V::Arr(
            a.into_iter()
                .enumerate()
                .map(|(i, val)| {
                    normalize(
                        items,
                        val,
                        &pointer(path, &JsStr::from(i.to_string())),
                        log,
                        allowed,
                        depth + 1,
                    )
                })
                .collect(),
        ),
        (v, _, _) => v,
    }
}

struct Decoded {
    value: Option<V>,
    issues: Vec<Issue>,
}

fn decode(
    raw: Option<&V>,
    s: &V,
    log: &mut Vec<RepairRecord>,
    allowed: &[&str],
    known: Option<KnownSecrets<'_>>,
) -> Result<Decoded, Thrown> {
    let root = JsStr::default();
    let mut value = raw.cloned();
    if let Some(V::Str(raw_text)) = raw {
        if utf8_len(raw_text.units()) > MAX_ARGUMENT_BYTES {
            let issues = vec![Issue::new(
                &root,
                "arguments <= 256 KiB",
                "oversized",
                "arguments too large",
            )];
            return Ok(Decoded {
                value: None,
                issues,
            });
        }
        let mut text = raw_text.units().to_vec();
        for round in 0..2 {
            let fixed = if allowed.contains(&"trailing-comma") {
                trailing_commas(&text)
            } else {
                text.clone()
            };
            if fixed != text {
                log.push(RepairRecord {
                    kind: "trailing-comma",
                    path: root.clone(),
                });
            }
            let parsed = match parse_units(&fixed) {
                Ok(Parsed::Value(v)) => v,
                // Well-formed but deeper than the reader builds: the safety walk below would refuse it for its depth.
                Ok(Parsed::TooDeep { array }) => {
                    let issues = unsafe_value(if array { "array" } else { "object" });
                    return Ok(Decoded {
                        value: raw.cloned(),
                        issues,
                    });
                }
                Err(_) => {
                    let issues = vec![Issue::new(
                        &root,
                        "valid JSON",
                        "invalid JSON",
                        "JSON parse failed",
                    )];
                    return Ok(Decoded {
                        value: raw.cloned(),
                        issues,
                    });
                }
            };
            let unwrap = allowed.contains(&"unwrap-json-string")
                && !s.get("type").is_some_and(|t| t.is_str("string"))
                && round == 0;
            match parsed {
                V::Str(inner) if unwrap => {
                    log.push(RepairRecord {
                        kind: "unwrap-json-string",
                        path: root.clone(),
                    });
                    text = inner.units().to_vec();
                }
                other => {
                    value = Some(other);
                    break;
                }
            }
        }
    }
    let safety = validate_arguments(&V::Obj(Obj::new()), value.as_ref(), known)?;
    if !safety.is_empty() {
        return Ok(Decoded {
            value,
            issues: safety,
        });
    }
    let value = value.map(|v| normalize(s, v, &root, log, allowed, 0));
    let issues = validate_arguments(s, value.as_ref(), known)?;
    Ok(Decoded { value, issues })
}

/// `prepareCall`: reads the arguments a model wrote for the tool `name`, applies the repairs the model family's quirks
/// allow, validates against `schema`, and on failure asks the repair port once. `raw` is a string (the text the model
/// wrote), an already parsed value, or `None` for `undefined`. An `Err` is an invalid schema, which is the programmer's.
pub fn prepare_call(
    name: &str,
    schema: &V,
    raw: Option<&V>,
    repair: Option<&mut dyn RepairPort>,
    model_family: Option<&str>,
    known: Option<KnownSecrets<'_>>,
) -> Result<PreparedCall, Thrown> {
    assert_schema(schema)?;
    let model_family = model_family.unwrap_or("unknown");
    let allowed = lookup_quirks(model_family, None).malformed_arguments;
    let mut repairs = Vec::new();
    let mut decoded = decode(raw, schema, &mut repairs, allowed, known)?;
    let mut repair_rounds = 0;
    if let (false, Some(port)) = (decoded.issues.is_empty(), repair) {
        repair_rounds = 1;
        let mut message = JsStr::from(format!(
            "Correct arguments for {name}. Return JSON only. Known {model_family} slips: {}.\n",
            allowed.join(", ")
        ));
        for (i, issue) in decoded.issues.iter().enumerate() {
            if i > 0 {
                message.push_str("\n");
            }
            if issue.path.is_empty() {
                message.push_str("(arguments)");
            } else {
                message.push(&issue.path);
            }
            message.push_str(": expected ");
            message.push(&issue.expected);
            message.push_str("; got ");
            message.push(&issue.got);
        }
        let request = RepairRequest {
            tool: name.to_owned(),
            args: decoded.value.clone(),
            issues: decoded.issues.clone(),
            message,
        };
        // A port that fails leaves the issues of the first attempt standing; the round still counts.
        if let Ok(answer) = port.repair(&request) {
            if let Ok(again) = decode(answer.as_ref(), schema, &mut repairs, allowed, known) {
                decoded = again;
            }
        }
    }
    let outcome = match (decoded.issues.is_empty(), decoded.value) {
        (true, Some(arguments)) => Ok(arguments),
        (_, _) => Err(InvalidCall {
            message: format!("Invalid arguments for {name}"),
            issues: decoded.issues,
        }),
    };
    Ok(PreparedCall {
        repairs,
        repair_rounds,
        outcome,
    })
}

#[cfg(test)]
mod budget_tests {
    use super::{validate_arguments, V};
    use crate::toolcall::json::parse;

    #[test]
    fn ordinary_items_share_the_validation_budget() {
        let schema = parse(r#"{"type":"array","items":{"pattern":"^[a-z]+$"}}"#).unwrap();
        let item = V::Str("a".repeat(768).into());
        let started = std::time::Instant::now();
        let issues = validate_arguments(&schema, Some(&V::Arr(vec![item; 8_000])), None).unwrap();
        if !cfg!(debug_assertions) {
            assert!(started.elapsed() < std::time::Duration::from_millis(100));
        }
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].message, "pattern match budget exhausted".into());
    }

    #[test]
    fn exhausting_a_branch_refuses_the_whole_value() {
        let branch = r#"{"items":{"pattern":"^[a-z]+$"}}"#;
        let alternatives = std::iter::repeat_n(branch, 20)
            .collect::<Vec<_>>()
            .join(",");
        let schema = parse(&format!(r#"{{"anyOf":[{{}},{alternatives}]}}"#)).unwrap();
        let item = V::Str("a".repeat(512).into());
        let value = V::Arr(vec![item; 512]);
        let started = std::time::Instant::now();
        let issues = validate_arguments(&schema, Some(&value), None).unwrap();
        if !cfg!(debug_assertions) {
            assert!(started.elapsed() < std::time::Duration::from_millis(100));
        }
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].message, "pattern match budget exhausted".into());
    }

    #[test]
    fn schema_compiles_at_most_256_distinct_patterns() {
        let field = |i| format!(r#""field{i}":{{"pattern":"^value{i}$"}}"#);
        let value = |i| format!(r#""field{i}":"value{i}""#);
        let schema = (0..256).map(field).collect::<Vec<_>>().join(",");
        let args = (0..256).map(value).collect::<Vec<_>>().join(",");
        let accepted = parse(&format!(r#"{{"properties":{{{schema}}}}}"#)).unwrap();
        let args = parse(&format!("{{{args}}}")).unwrap();
        assert!(validate_arguments(&accepted, Some(&args), None)
            .unwrap()
            .is_empty());
        let too_many = parse(&format!(r#"{{"properties":{{{schema},{}}}}}"#, field(256))).unwrap();
        assert!(validate_arguments(&too_many, Some(&args), None).is_err());
    }
}
