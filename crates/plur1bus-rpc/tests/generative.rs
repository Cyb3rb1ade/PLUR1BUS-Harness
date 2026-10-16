//! Generative round trips and hostile input for every generated request, result and notification type.
//!
//! The instances are produced from `packages/rpc-schema/schema/rpc.schema.json` itself (read-only) by a small schema-driven generator
//! with a fixed seed, so a change of the schema changes what is tested without a hand-kept list of values. The one hand-kept list is
//! the type table at the bottom; `the_table_covers_every_schema_method_notification_and_generated_type` fails when it falls behind
//! the schema or the generated `types.rs`.
//!
//! Conventions under test (docs/rpc.md, ADR-016 §2, `build.rs`):
//! - a valid instance deserializes and serializes back to the same JSON; an optional field that is absent stays absent (no `null`);
//! - `Params` objects are closed (an unknown field is refused), results, notifications and shared definitions are open (an unknown
//!   field is ignored, so a newer 1.x core can add one);
//! - hostile input is an error, never a panic and never a stack overflow.
//!
//! Every failure message carries the seed, the type and the instance index, so a failure replays exactly.
use plur1bus_rpc::types;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::marker::PhantomData;
use std::{fs, path::PathBuf};

const SEED: u64 = 0x504c_5552_3162_7532;
const INSTANCES: usize = 200;
const MARK: &str = "\u{1}MARK\u{1}";

// ---------------------------------------------------------------------------------------------------------------------
// deterministic randomness
// ---------------------------------------------------------------------------------------------------------------------

struct Rng(u64);
impl Rng {
    fn for_case(parts: &[&str]) -> Self {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325 ^ SEED;
        for p in parts {
            for b in p.bytes().chain([0xff]) {
                h = (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
        Rng(h)
    }
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
    fn range(&mut self, lo: usize, hi: usize) -> usize {
        lo + self.below(hi - lo + 1)
    }
    fn chance(&mut self, p: f64) -> bool {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64 <= p
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// schema access
// ---------------------------------------------------------------------------------------------------------------------

struct Schema {
    root: Value,
}
impl Schema {
    fn load() -> Self {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/rpc-schema/schema/rpc.schema.json");
        Schema {
            root: serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap(),
        }
    }
    /// Follows `$ref`s; the flag says whether one was followed (shared definitions are opened by `build.rs`).
    fn resolve<'a>(&'a self, mut node: &'a Value) -> (&'a Value, bool) {
        let mut via_ref = false;
        while let Some(r) = node.get("$ref").and_then(Value::as_str) {
            let name = r
                .strip_prefix("#/$defs/")
                .unwrap_or_else(|| panic!("ref {r}"));
            node = &self.root["$defs"][name];
            assert!(!node.is_null(), "dangling $ref {r}");
            via_ref = true;
        }
        (node, via_ref)
    }
    fn methods(&self) -> &Map<String, Value> {
        self.root["$defs"]["methods"].as_object().unwrap()
    }
    fn notifications(&self) -> &Map<String, Value> {
        self.root["$defs"]["notifications"].as_object().unwrap()
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// regular expressions of the schema's `pattern`s: the subset the schema uses, as a generator
// ---------------------------------------------------------------------------------------------------------------------

enum Atom {
    Lit(char),
    Class(Vec<(char, char)>),
    Group(Vec<Item>),
    /// A `(...|...)` alternation: one of the alternatives, each a sequence of its own.
    Alt(Vec<Vec<Item>>),
}
struct Item {
    atom: Atom,
    min: usize,
    max: usize,
}
struct Pattern {
    items: Vec<Item>,
    anchored_end: bool,
}

fn parse_pattern(p: &str) -> Pattern {
    let chars: Vec<char> = p.chars().collect();
    let mut i = 0;
    if chars.first() == Some(&'^') {
        i = 1;
    }
    let (items, end) = parse_seq(&chars, i, p);
    let anchored_end = end < chars.len() && chars[end] == '$' && end + 1 == chars.len();
    assert!(
        end == chars.len() || anchored_end,
        "pattern {p}: unparsed rest at {end}"
    );
    Pattern {
        items,
        anchored_end,
    }
}

fn parse_seq(c: &[char], mut i: usize, p: &str) -> (Vec<Item>, usize) {
    let mut items = Vec::new();
    while i < c.len() && c[i] != ')' && c[i] != '$' && c[i] != '|' {
        let atom = match c[i] {
            '(' => {
                let (alts, end) = parse_alt(c, i + 1, p);
                assert!(c.get(end) == Some(&')'), "pattern {p}: unclosed group");
                i = end + 1;
                if alts.len() == 1 {
                    Atom::Group(alts.into_iter().next().unwrap())
                } else {
                    Atom::Alt(alts)
                }
            }
            '[' => {
                i += 1;
                let mut ranges = Vec::new();
                assert!(c[i] != '^', "pattern {p}: negated class not supported");
                while c[i] != ']' {
                    let mut lo = c[i];
                    if lo == '\\' {
                        i += 1;
                        lo = c[i];
                    }
                    if c.get(i + 1) == Some(&'-') && c.get(i + 2) != Some(&']') {
                        ranges.push((lo, c[i + 2]));
                        i += 3;
                    } else {
                        ranges.push((lo, lo));
                        i += 1;
                    }
                }
                i += 1;
                Atom::Class(ranges)
            }
            '\\' => {
                let e = c[i + 1];
                i += 2;
                match e {
                    'd' => Atom::Class(vec![('0', '9')]),
                    '.' | '\\' | '/' | '-' | '^' | '$' | '(' | ')' | '[' | ']' | '{' | '}' => {
                        Atom::Lit(e)
                    }
                    other => panic!("pattern {p}: escape \\{other} not supported"),
                }
            }
            '.' | '*' | '+' | '?' | '{' => panic!("pattern {p}: {} not supported here", c[i]),
            lit => {
                i += 1;
                Atom::Lit(lit)
            }
        };
        let (min, max) = match c.get(i) {
            Some('{') => {
                let close = c[i..].iter().position(|&x| x == '}').unwrap() + i;
                let body: String = c[i + 1..close].iter().collect();
                i = close + 1;
                match body.split_once(',') {
                    Some((a, b)) => (a.parse().unwrap(), b.parse().unwrap()),
                    None => (body.parse().unwrap(), body.parse().unwrap()),
                }
            }
            Some('?') => {
                i += 1;
                (0, 1)
            }
            Some('*') => {
                i += 1;
                (0, 4)
            }
            Some('+') => {
                i += 1;
                (1, 4)
            }
            _ => (1, 1),
        };
        items.push(Item { atom, min, max });
    }
    (items, i)
}

/// Parses the inside of a `(...)` group as a list of `|`-separated alternatives. `i` points just
/// past the opening `(`; the returned end points at the closing `)`.
fn parse_alt(c: &[char], mut i: usize, p: &str) -> (Vec<Vec<Item>>, usize) {
    let mut alts = Vec::new();
    loop {
        let (items, end) = parse_seq(c, i, p);
        alts.push(items);
        if c.get(end) == Some(&'|') {
            i = end + 1;
        } else {
            return (alts, end);
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Size {
    Min,
    Max,
    Random,
}

fn emit(items: &[Item], size: Size, rng: &mut Rng, out: &mut String) {
    for item in items {
        let n = match size {
            Size::Min => item.min,
            Size::Max => item.max,
            Size::Random => rng.range(item.min, item.max),
        };
        for _ in 0..n {
            match &item.atom {
                Atom::Lit(c) => out.push(*c),
                Atom::Class(ranges) => {
                    let (lo, hi) = ranges[rng.below(ranges.len())];
                    let span = hi as u32 - lo as u32;
                    out.push(
                        char::from_u32(lo as u32 + rng.below(span as usize + 1) as u32).unwrap(),
                    );
                }
                Atom::Group(inner) => emit(inner, size, rng, out),
                Atom::Alt(alts) => {
                    let alt = &alts[rng.below(alts.len())];
                    emit(alt, size, rng, out);
                }
            }
        }
    }
}

fn from_pattern(pattern: &str, size: Size, rng: &mut Rng) -> String {
    let p = parse_pattern(pattern);
    let mut s = String::new();
    emit(&p.items, size, rng, &mut s);
    if !p.anchored_end {
        for _ in 0..rng.range(0, 4) {
            s.push((b'a' + rng.below(26) as u8) as char);
        }
    }
    s
}

// ---------------------------------------------------------------------------------------------------------------------
// instance generator
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Optionals {
    /// Only the required properties, shortest arrays and strings: the minimal valid instance.
    None,
    /// Every property, longest arrays and strings.
    All,
    Half,
}
impl Optionals {
    fn size(self) -> Size {
        match self {
            Optionals::None => Size::Min,
            Optionals::All => Size::Max,
            Optionals::Half => Size::Random,
        }
    }
}

const CHARSET: &[char] = &[
    'a', 'b', 'c', 'x', 'y', 'z', 'A', 'Z', '0', '7', ' ', '-', '_', '.', ':', '/', '@', '"', '\\',
    '\n', 'ä', 'ö', '€', '😀',
];

struct Gen<'a> {
    schema: &'a Schema,
    rng: &'a mut Rng,
    optionals: Optionals,
}

impl Gen<'_> {
    fn gen(&mut self, node: &Value, depth: usize) -> Value {
        let (node, _) = self.schema.resolve(node);
        if let Some(c) = node.get("const") {
            return c.clone();
        }
        if let Some(e) = node.get("enum").and_then(Value::as_array) {
            return e[self.rng.below(e.len())].clone();
        }
        for key in ["oneOf", "anyOf"] {
            if let Some(v) = node.get(key).and_then(Value::as_array) {
                let pick = &v[self.rng.below(v.len())];
                return self.gen(pick, depth + 1);
            }
        }
        match self.pick_type(node) {
            "object" => self.object(node, depth),
            "array" => self.array(node, depth),
            "string" => self.string(node),
            "integer" => self.integer(node),
            "number" => self.number(node),
            "boolean" => Value::Bool(self.rng.chance(0.5)),
            "null" => Value::Null,
            "any" => self.any(),
            t => panic!("unsupported type {t}"),
        }
    }

    fn pick_type(&mut self, node: &Value) -> &'static str {
        let names: Vec<&str> = match node.get("type") {
            Some(Value::String(s)) => vec![s.as_str()],
            Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).collect(),
            _ if node.get("properties").is_some() => vec!["object"],
            _ if node.get("items").is_some() => vec!["array"],
            _ => return "any",
        };
        let non_null: Vec<&str> = names.iter().copied().filter(|t| *t != "null").collect();
        let chosen = if names.contains(&"null") && (non_null.is_empty() || self.rng.chance(0.15)) {
            "null"
        } else {
            non_null[self.rng.below(non_null.len())]
        };
        match chosen {
            "object" => "object",
            "array" => "array",
            "string" => "string",
            "integer" => "integer",
            "number" => "number",
            "boolean" => "boolean",
            "null" => "null",
            other => panic!("unsupported type name {other}"),
        }
    }

    /// A schema without a type (`{}`) accepts anything; keep it small and plain.
    fn any(&mut self) -> Value {
        match self.rng.below(5) {
            0 => json!(self.rng.below(1000)),
            1 => json!("any"),
            2 => json!(true),
            3 => json!({ "k": [1, "two", null] }),
            _ => json!([]),
        }
    }

    fn object(&mut self, node: &Value, depth: usize) -> Value {
        let mut out = Map::new();
        let empty = Map::new();
        let props = node
            .get("properties")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        let required: BTreeSet<&str> = node
            .get("required")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        for (k, sub) in props {
            let include = required.contains(k.as_str())
                || (depth < 10
                    && match self.optionals {
                        Optionals::None => false,
                        Optionals::All => true,
                        Optionals::Half => self.rng.chance(0.5),
                    });
            if include {
                out.insert(k.clone(), self.gen(sub, depth + 1));
            }
        }
        if let Some(extra) = node.get("additionalProperties").filter(|v| v.is_object()) {
            let n = match self.optionals {
                Optionals::None => 0,
                Optionals::All => 2,
                Optionals::Half => self.rng.below(3),
            };
            for i in 0..n {
                out.insert(format!("key{i}"), self.gen(extra, depth + 1));
            }
        }
        let min = node
            .get("minProperties")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        for (k, sub) in props {
            if out.len() >= min {
                break;
            }
            if !out.contains_key(k) {
                out.insert(k.clone(), self.gen(sub, depth + 1));
            }
        }
        if let Some(max) = node.get("maxProperties").and_then(Value::as_u64) {
            let removable: Vec<String> = out
                .keys()
                .filter(|k| !required.contains(k.as_str()))
                .cloned()
                .collect();
            for k in removable {
                if out.len() <= max as usize {
                    break;
                }
                out.remove(&k);
            }
        }
        // `not: { required: [a, b] }`: the keys are exclusive (config.get's `key` and `tier`).
        if let Some(excl) = node
            .pointer("/not/required")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        {
            if excl.iter().all(|k| out.contains_key(*k)) {
                if let Some(drop) = excl.iter().rev().find(|k| !required.contains(**k)) {
                    out.remove(*drop);
                }
            }
        }
        Value::Object(out)
    }

    fn array(&mut self, node: &Value, depth: usize) -> Value {
        let min = node.get("minItems").and_then(Value::as_u64).unwrap_or(0) as usize;
        let max = node
            .get("maxItems")
            .and_then(Value::as_u64)
            .map(|m| m as usize)
            .unwrap_or(min + 3)
            .min(min + 3);
        let len = if depth >= 10 {
            min
        } else {
            match self.optionals {
                Optionals::None => min,
                Optionals::All => max,
                Optionals::Half => self.rng.range(min, max),
            }
        };
        let unique = node.get("uniqueItems") == Some(&Value::Bool(true));
        let items = node.get("items").cloned().unwrap_or(json!({}));
        let mut out: Vec<Value> = Vec::new();
        let mut attempts = 0;
        while out.len() < len && attempts < 50 {
            attempts += 1;
            let v = self.gen(&items, depth + 1);
            if unique && out.contains(&v) {
                continue;
            }
            out.push(v);
        }
        Value::Array(out)
    }

    fn string(&mut self, node: &Value) -> Value {
        let min = node.get("minLength").and_then(Value::as_u64).unwrap_or(0) as usize;
        let max = node
            .get("maxLength")
            .and_then(Value::as_u64)
            .map(|m| m as usize);
        if let Some(pattern) = node.get("pattern").and_then(Value::as_str) {
            let mut s = from_pattern(pattern, self.optionals.size(), self.rng);
            if max.is_some_and(|m| s.chars().count() > m) {
                s = from_pattern(pattern, Size::Min, self.rng);
            }
            if s.chars().count() < min {
                s = from_pattern(pattern, Size::Max, self.rng);
            }
            return Value::String(s);
        }
        match node.get("format").and_then(Value::as_str) {
            Some("date") => return json!("2026-10-12"),
            Some("date-time") => return json!("2026-10-12T10:00:00Z"),
            Some("uuid") => return json!("123e4567-e89b-42d3-a456-426614174000"),
            _ => {}
        }
        let cap = max.unwrap_or(min + 12).min(min + 40);
        let len = match self.optionals {
            Optionals::None => min.max(usize::from(min == 0 && self.rng.chance(0.5))),
            Optionals::All => cap,
            Optionals::Half => self.rng.range(min, cap),
        };
        let s: String = (0..len)
            .map(|_| CHARSET[self.rng.below(CHARSET.len())])
            .collect();
        Value::String(s)
    }

    fn bounds(node: &Value, dlo: f64, dhi: f64) -> (f64, f64) {
        let mut lo = node.get("minimum").and_then(Value::as_f64).unwrap_or(dlo);
        if let Some(x) = node.get("exclusiveMinimum").and_then(Value::as_f64) {
            lo = x;
        }
        let hi = node
            .get("maximum")
            .and_then(Value::as_f64)
            .unwrap_or(dhi.max(lo + 1_000_000.0));
        (lo, hi)
    }

    fn integer(&mut self, node: &Value) -> Value {
        let (mut lo, hi) = Self::bounds(node, -1000.0, 1_000_000.0);
        if node.get("exclusiveMinimum").is_some() {
            lo += 1.0;
        }
        let (lo, hi) = (lo.ceil() as i64, hi.floor() as i64);
        let v = match self.rng.below(4) {
            0 => lo,
            1 => hi.min(lo.saturating_add(1 << 40)),
            2 => lo.saturating_add(1).min(hi),
            _ => lo + self.rng.below(((hi - lo).min(1 << 30) + 1) as usize) as i64,
        };
        json!(v)
    }

    fn number(&mut self, node: &Value) -> Value {
        let (lo, hi) = Self::bounds(node, -1000.0, 1000.0);
        let step = if node.get("exclusiveMinimum").is_some() {
            0.001
        } else {
            0.0
        };
        let x = (lo + step + (hi - lo - step) * self.rng.unit()).clamp(lo + step, hi);
        let x = (x * 1000.0).round() / 1000.0;
        let x = if x < lo + step { lo + step } else { x.min(hi) };
        Value::Number(serde_json::Number::from_f64(x).unwrap())
    }
}

fn generate(schema: &Schema, node: &Value, optionals: Optionals, rng: &mut Rng) -> Value {
    Gen {
        schema,
        rng,
        optionals,
    }
    .gen(node, 0)
}

/// `build.rs` strips the JSON Schema *keyword* `format` (uuid, date-time stay plain strings in Rust), but a *property* named
/// `format` is kept: `media.generate` and `media.edit` (`request.format`: png, jpeg or webp) and `agent.export` (`bundle.format`,
/// `bundle.manifest.format`, a pinned value). Until 2026-10 the keyword removal took the property with it (#405).
#[test]
fn properties_named_format_survive() {
    let schema = Schema::load();
    let mut failures = Vec::new();
    let mut hit = BTreeSet::new();
    for e in table() {
        let x = Gen {
            schema: &schema,
            rng: &mut Rng::for_case(&[e.name, e.type_name, "format"]),
            optionals: Optionals::All,
        }
        .gen(e.node(&schema), 0);
        if !x.to_string().contains("\"format\"") {
            continue;
        }
        hit.insert(e.name);
        match e.probe.through_value(&x) {
            Err(err) => failures.push(format!("{}: refused: {err}", e.label())),
            Ok(v) if !same(&schema, e.node(&schema), &v, &x) => failures.push(format!(
                "{}: lost a field at {}",
                e.label(),
                diff(&schema, e.node(&schema), &x, &v)
            )),
            Ok(_) => {}
        }
    }
    assert_eq!(
        hit.len(),
        3,
        "the schema has three methods with a `format` property: {hit:?}"
    );
    report("properties named format", &failures);
}

/// `x` in the form the Rust types agree on, so that `canonical(x) == canonical(serialize(deserialize(x)))` is the round-trip claim:
/// - a property with a schema `default` that is absent gets its default (typify makes it a plain field, so the Rust type writes
///   `memory.recall`'s `joined: false`, `memory.capture`'s `wait: true`, `waitMs: 60000`: the value the core assumes anyway);
/// - an optional property that is `null`, or an empty array or object, is left out (an optional field is absent, not `null`; typify
///   writes a `None` as nothing and some empty `Vec`s and maps as nothing too). A required nullable property keeps its `null`.
///   In params an explicit `null` or `[]` is kept (`explicit_null_and_empty_survive_for_optional_params`); this form treats it
///   like a missing key so that one comparison serves params, results and notifications.
fn canonical(schema: &Schema, node: &Value, x: &Value) -> Value {
    let (node, _) = schema.resolve(node);
    // `oneOf`/`anyOf`: the variant the value was generated from is the first one it fits (type, required keys, closed objects).
    let node = ["oneOf", "anyOf"]
        .iter()
        .find_map(|k| node.get(k).and_then(Value::as_array))
        .and_then(|variants| {
            variants
                .iter()
                .map(|v| schema.resolve(v).0)
                .find(|v| fits(v, x))
        })
        .unwrap_or(node);
    match x {
        Value::Object(map) if node.get("properties").is_some_and(Value::is_object) => {
            let required: BTreeSet<&str> = node
                .get("required")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let mut out = Map::new();
            for (k, v) in map {
                let sub = node["properties"].get(k);
                let c = sub.map_or_else(|| v.clone(), |sub| canonical(schema, sub, v));
                let empty = c.is_null()
                    || c.as_array().is_some_and(Vec::is_empty)
                    || c.as_object().is_some_and(Map::is_empty);
                if sub.is_some() && !required.contains(k.as_str()) && empty {
                    continue;
                }
                out.insert(k.clone(), c);
            }
            for (k, sub) in node["properties"].as_object().unwrap() {
                if !map.contains_key(k) {
                    if let Some(d) = schema.resolve(sub).0.get("default") {
                        out.insert(k.clone(), d.clone());
                    }
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => match node.get("items") {
            Some(sub) => Value::Array(items.iter().map(|v| canonical(schema, sub, v)).collect()),
            None => x.clone(),
        },
        _ => x.clone(),
    }
}

fn fits(variant: &Value, x: &Value) -> bool {
    match (x, allowed_types(variant)) {
        (Value::Object(map), Some(types)) if types.contains("object") => {
            let props = variant.get("properties").and_then(Value::as_object);
            let required_ok = variant
                .get("required")
                .and_then(Value::as_array)
                .is_none_or(|r| {
                    r.iter()
                        .filter_map(Value::as_str)
                        .all(|k| map.contains_key(k))
                });
            let closed_ok = variant.get("additionalProperties") != Some(&Value::Bool(false))
                || props.is_some_and(|p| map.keys().all(|k| p.contains_key(k)));
            required_ok && closed_ok
        }
        (_, Some(types)) => {
            let kind = match x {
                Value::Null => "null",
                Value::Bool(_) => "boolean",
                Value::Number(_) => "number",
                Value::String(_) => "string",
                Value::Array(_) => "array",
                Value::Object(_) => "object",
            };
            types.contains(kind)
        }
        (_, None) => false,
    }
}

/// Do `a` and `b` agree once both are in canonical form?
fn same(schema: &Schema, node: &Value, a: &Value, b: &Value) -> bool {
    canonical(schema, node, a) == canonical(schema, node, b)
}

fn diff(schema: &Schema, node: &Value, a: &Value, b: &Value) -> String {
    first_diff(&canonical(schema, node, a), &canonical(schema, node, b))
}

fn optionals_for(index: usize) -> Optionals {
    match index % 4 {
        0 => Optionals::None,
        1 => Optionals::All,
        _ => Optionals::Half,
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// the types under test
// ---------------------------------------------------------------------------------------------------------------------

trait Probe {
    /// `from_value` then `to_value`.
    fn through_value(&self, v: &Value) -> Result<Value, String>;
    /// The wire path: text → type → text → type → text. Returns both texts.
    fn through_text(&self, text: &[u8]) -> Result<(String, String), String>;
}
struct Typed<T>(PhantomData<T>);
impl<T: DeserializeOwned + Serialize> Probe for Typed<T> {
    fn through_value(&self, v: &Value) -> Result<Value, String> {
        let typed: T = serde_json::from_value(v.clone()).map_err(|e| e.to_string())?;
        serde_json::to_value(&typed).map_err(|e| e.to_string())
    }
    fn through_text(&self, text: &[u8]) -> Result<(String, String), String> {
        let typed: T = serde_json::from_slice(text).map_err(|e| e.to_string())?;
        let first = serde_json::to_string(&typed).map_err(|e| e.to_string())?;
        let again: T = serde_json::from_str(&first).map_err(|e| e.to_string())?;
        let second = serde_json::to_string(&again).map_err(|e| e.to_string())?;
        Ok((first, second))
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Kind {
    Params,
    Result,
    Notification,
}
struct Entry {
    name: &'static str,
    kind: Kind,
    type_name: &'static str,
    probe: Box<dyn Probe>,
}
impl Entry {
    fn node<'a>(&self, schema: &'a Schema) -> &'a Value {
        match self.kind {
            Kind::Params => &schema.methods()[self.name]["params"],
            Kind::Result => &schema.methods()[self.name]["result"],
            Kind::Notification => &schema.notifications()[self.name],
        }
    }
    fn label(&self) -> String {
        format!("{} ({:?}, {})", self.name, self.kind, self.type_name)
    }
}

macro_rules! table {
    ($($kind:ident $name:literal $ty:ident),* $(,)?) => {
        fn table() -> Vec<Entry> {
            vec![$(Entry {
                name: $name,
                kind: Kind::$kind,
                type_name: stringify!($ty),
                probe: Box::new(Typed::<types::$ty>(PhantomData)),
            }),*]
        }
    };
}

fn pascal(s: &str) -> String {
    s.split(['.', '-', '_'])
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect()
}

fn report(what: &str, failures: &[String]) {
    assert!(
        failures.is_empty(),
        "{what}: {} failure(s), seed {SEED:#x}\n{}",
        failures.len(),
        failures
            .iter()
            .take(8)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// Where two documents first differ, as `path: left ≠ right`, so a failure does not print both documents.
fn first_diff(a: &Value, b: &Value) -> String {
    fn walk(a: &Value, b: &Value, path: &mut String) -> Option<String> {
        match (a, b) {
            (Value::Object(x), Value::Object(y)) => {
                for k in x.keys().chain(y.keys()) {
                    let at = path.len();
                    path.push('/');
                    path.push_str(k);
                    let found = match (x.get(k), y.get(k)) {
                        (Some(l), Some(r)) => walk(l, r, path),
                        (l, r) => Some(format!(
                            "{path}: {} ≠ {}",
                            l.map_or("(absent)".into(), clip),
                            r.map_or("(absent)".into(), clip)
                        )),
                    };
                    path.truncate(at);
                    if found.is_some() {
                        return found;
                    }
                }
                None
            }
            (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
                for (i, (l, r)) in x.iter().zip(y).enumerate() {
                    let at = path.len();
                    path.push_str(&format!("/{i}"));
                    let found = walk(l, r, path);
                    path.truncate(at);
                    if found.is_some() {
                        return found;
                    }
                }
                None
            }
            _ if a == b => None,
            _ => Some(format!("{path}: {} ≠ {}", clip(a), clip(b))),
        }
    }
    walk(a, b, &mut String::new()).unwrap_or_else(|| "(equal)".into())
}

fn clip(v: &Value) -> String {
    let s = v.to_string();
    if s.len() > 100 {
        format!("{}…", s.chars().take(100).collect::<String>())
    } else {
        s
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// the table is complete
// ---------------------------------------------------------------------------------------------------------------------

/// Names ending in `Params`, `Result` or `Notification` in the generated `types.rs` that are not a method's or notification's own
/// type: a nested object named `…Result` in `models.scan`'s result and the schema's generic `Notification` envelope.
const NOT_ENTRY_TYPES: [&str; 2] = ["ModelScanProviderResult", "Notification"];

#[test]
fn the_table_covers_every_schema_method_notification_and_generated_type() {
    let schema = Schema::load();
    let entries = table();
    let have: BTreeSet<(Kind, &str)> = entries.iter().map(|e| (e.kind, e.name)).collect();
    assert_eq!(have.len(), entries.len(), "duplicate table entry");
    let mut problems = Vec::new();
    for m in schema.methods().keys() {
        for kind in [Kind::Params, Kind::Result] {
            if !have.contains(&(kind, m.as_str())) {
                problems.push(format!(
                    "schema method {m} has no {kind:?} entry in the table"
                ));
            }
        }
    }
    for n in schema.notifications().keys() {
        if !have.contains(&(Kind::Notification, n.as_str())) {
            problems.push(format!("schema notification {n} has no entry in the table"));
        }
    }
    for e in &entries {
        let known = match e.kind {
            Kind::Params | Kind::Result => schema.methods().contains_key(e.name),
            Kind::Notification => schema.notifications().contains_key(e.name),
        };
        if !known {
            problems.push(format!("table entry {} is not in the schema", e.label()));
        }
        let expected = match e.kind {
            Kind::Params => format!("{}Params", pascal(e.name)),
            Kind::Result => format!("{}Result", pascal(e.name)),
            Kind::Notification => format!("{}Notification", pascal(e.name)),
        };
        if e.type_name != expected {
            problems.push(format!("{} should map to {expected}", e.label()));
        }
    }
    // Every generated type with one of the three suffixes is in the table (the list comes from the code, not from this file).
    let generated = include_str!(concat!(env!("OUT_DIR"), "/types.rs"));
    let in_table: BTreeSet<&str> = entries.iter().map(|e| e.type_name).collect();
    for line in generated.lines() {
        let Some(rest) = ["pub struct ", "pub enum ", "pub type "]
            .iter()
            .find_map(|p| line.strip_prefix(p))
        else {
            continue;
        };
        let name: String = rest
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        let suffixed = ["Params", "Result", "Notification"]
            .iter()
            .any(|s| name.ends_with(s));
        if suffixed
            && !in_table.contains(name.as_str())
            && !NOT_ENTRY_TYPES.contains(&name.as_str())
        {
            problems.push(format!("generated type {name} is not in the table"));
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
    assert_eq!(
        entries.len(),
        schema.methods().len() * 2 + schema.notifications().len()
    );
}

// ---------------------------------------------------------------------------------------------------------------------
// valid instances
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn generated_valid_instances_round_trip_stably_and_absent_fields_stay_absent() {
    let schema = Schema::load();
    let mut failures = Vec::new();
    let mut instances = 0usize;
    for e in table() {
        let node = e.node(&schema);
        let mut rng = Rng::for_case(&[e.name, e.type_name, "valid"]);
        for i in 0..INSTANCES {
            let x = generate(&schema, node, optionals_for(i), &mut rng);
            instances += 1;
            let ctx = format!("{} #{i}", e.label());
            match e.probe.through_value(&x) {
                Err(err) => failures.push(format!(
                    "{ctx}: valid instance refused: {err}\n    {}",
                    clip(&x)
                )),
                Ok(v1) if !same(&schema, node, &v1, &x) => failures.push(format!(
                    "{ctx}: serialize(deserialize(x)) != x (canonical form) at {}",
                    diff(&schema, node, &x, &v1)
                )),
                Ok(_) => {}
            }
            // The wire path. Map-typed fields are `HashMap`s, whose key order differs from one serialization to the next, so
            // stability is judged on the parsed JSON and not on the bytes.
            match e.probe.through_text(x.to_string().as_bytes()) {
                Err(err) => failures.push(format!("{ctx}: wire path refused: {err}")),
                Ok((first, second)) => {
                    let (a, b): (Value, Value) = (
                        serde_json::from_str(&first).unwrap(),
                        serde_json::from_str(&second).unwrap(),
                    );
                    if !same(&schema, node, &a, &b) || !same(&schema, node, &a, &x) {
                        failures.push(format!(
                            "{ctx}: text → type → text → type → text is not stable at {}",
                            diff(&schema, node, &a, &b)
                        ));
                    }
                }
            }
        }
    }
    assert!(instances >= 463 * INSTANCES);
    report("valid instances", &failures);
}

#[test]
fn the_minimal_instance_has_only_required_fields_and_no_nulls() {
    let schema = Schema::load();
    let mut failures = Vec::new();
    for e in table() {
        let node = e.node(&schema);
        let mut rng = Rng::for_case(&[e.name, e.type_name, "minimal"]);
        let x = generate(&schema, node, Optionals::None, &mut rng);
        match e.probe.through_value(&x) {
            Ok(v) => {
                if !same(&schema, node, &v, &x) {
                    failures.push(format!(
                        "{}: the minimal instance changed beyond schema defaults at {}",
                        e.label(),
                        diff(&schema, node, &x, &v)
                    ));
                }
                if has_null_absent_in(&v, &x) {
                    failures.push(format!(
                        "{}: an absent optional field came back as null at {}",
                        e.label(),
                        first_diff(&x, &v)
                    ));
                }
            }
            Err(err) => failures.push(format!("{}: minimal instance refused: {err}", e.label())),
        }
    }
    report("minimal instances", &failures);
}

/// Is there a `null` in `out` where `input` has no such key?
fn has_null_absent_in(out: &Value, input: &Value) -> bool {
    match (out, input) {
        (Value::Object(o), Value::Object(i)) => o.iter().any(|(k, v)| match i.get(k) {
            None => v.is_null(),
            Some(iv) => has_null_absent_in(v, iv),
        }),
        (Value::Array(o), Value::Array(i)) => {
            o.iter().zip(i).any(|(a, b)| has_null_absent_in(a, b))
        }
        _ => false,
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// hostile input
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Clone)]
enum Seg {
    Key(String),
    Idx(usize),
}
struct Point {
    path: Vec<Seg>,
    schema: Value,
    required: bool,
    /// A closed object of a `Params` type: not behind a shared definition, which `build.rs` opens.
    closed: bool,
    /// An object with named properties that accepts no free-form extra keys either way.
    has_properties: bool,
}

struct Walk<'a> {
    schema: &'a Schema,
    kind: Kind,
    path: Vec<Seg>,
    out: Vec<Point>,
}

impl Walk<'_> {
    fn visit(&mut self, node: &Value, value: &Value, opened: bool, required: bool) {
        let (resolved, via_ref) = self.schema.resolve(node);
        let opened = opened || via_ref;
        let object_with_props = resolved.get("properties").is_some_and(Value::is_object);
        let free_map = resolved
            .get("additionalProperties")
            .is_some_and(Value::is_object);
        self.out.push(Point {
            path: self.path.clone(),
            schema: resolved.clone(),
            required,
            closed: self.kind == Kind::Params
                && !opened
                && resolved.get("additionalProperties") == Some(&Value::Bool(false)),
            has_properties: object_with_props && !free_map,
        });
        if resolved.get("oneOf").is_some() || resolved.get("anyOf").is_some() {
            return;
        }
        match value {
            Value::Object(map) if object_with_props => {
                let req: BTreeSet<&str> = resolved
                    .get("required")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                for (k, sub) in resolved["properties"].as_object().unwrap() {
                    if let Some(v) = map.get(k) {
                        self.path.push(Seg::Key(k.clone()));
                        self.visit(sub, v, opened, req.contains(k.as_str()));
                        self.path.pop();
                    }
                }
            }
            Value::Array(items) if !items.is_empty() => {
                if let Some(sub) = resolved.get("items") {
                    self.path.push(Seg::Idx(0));
                    self.visit(sub, &items[0], opened, true);
                    self.path.pop();
                }
            }
            _ => {}
        }
    }
}

fn set_at(root: &mut Value, path: &[Seg], new: Value) {
    let mut cur = root;
    for seg in path {
        cur = match seg {
            Seg::Key(k) => cur.get_mut(k).unwrap(),
            Seg::Idx(i) => cur.get_mut(*i).unwrap(),
        };
    }
    *cur = new;
}

fn get_at<'a>(root: &'a Value, path: &[Seg]) -> &'a Value {
    let mut cur = root;
    for seg in path {
        cur = match seg {
            Seg::Key(k) => &cur[k.as_str()],
            Seg::Idx(i) => &cur[*i],
        };
    }
    cur
}

/// The JSON types a schema node allows; `None` when the node does not say (no `type`, or a `oneOf`).
fn allowed_types(node: &Value) -> Option<BTreeSet<&'static str>> {
    fn kind(v: &Value) -> &'static str {
        match v {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        }
    }
    if node.get("oneOf").is_some() || node.get("anyOf").is_some() {
        return None;
    }
    let mut set = BTreeSet::new();
    let mut add = |t: &str| {
        match t {
            "integer" => {
                set.insert("number");
            }
            "number" => {
                set.insert("number");
            }
            "object" => {
                set.insert("object");
            }
            "array" => {
                set.insert("array");
            }
            "string" => {
                set.insert("string");
            }
            "boolean" => {
                set.insert("boolean");
            }
            "null" => {
                set.insert("null");
            }
            other => panic!("type {other}"),
        };
    };
    match node.get("type") {
        Some(Value::String(s)) => add(s),
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).for_each(&mut add),
        _ => {
            if let Some(c) = node.get("const") {
                set.insert(kind(c));
            } else if let Some(e) = node.get("enum").and_then(Value::as_array) {
                e.iter().for_each(|v| {
                    set.insert(kind(v));
                });
            } else if node.get("properties").is_some() {
                set.insert("object");
            } else {
                return None;
            }
        }
    }
    Some(set)
}

fn wrong_value(allowed: &BTreeSet<&'static str>, include_null: bool) -> Option<Value> {
    let pool: [(&str, Value); 6] = [
        ("boolean", json!(true)),
        ("string", json!("wrong")),
        ("number", json!(12345)),
        ("array", json!([])),
        ("object", json!({})),
        ("null", Value::Null),
    ];
    pool.into_iter()
        .find(|(t, _)| !allowed.contains(t) && (include_null || *t != "null"))
        .map(|(_, v)| v)
}

/// Instances of `e`'s type to mutate: a minimal and a full one, plus a random one.
fn bases(schema: &Schema, e: &Entry, tag: &str) -> Vec<Value> {
    let mut rng = Rng::for_case(&[e.name, e.type_name, tag]);
    [Optionals::None, Optionals::All, Optionals::Half]
        .into_iter()
        .map(|o| generate(schema, e.node(schema), o, &mut rng))
        .collect()
}

fn all_points(schema: &Schema, e: &Entry, x: &Value) -> Vec<Point> {
    let mut walk = Walk {
        schema,
        kind: e.kind,
        path: Vec::new(),
        out: Vec::new(),
    };
    walk.visit(e.node(schema), x, false, true);
    walk.out
}

/// A node the generated types do not pin to its value: a `const`, or an `enum` with a single value.
fn is_pinned(node: &Value) -> bool {
    node.get("const").is_some()
        || node
            .get("enum")
            .and_then(Value::as_array)
            .is_some_and(|e| e.len() == 1)
}

/// Wrong-typed values at every field (`const_nodes`: only at the pinned fields, otherwise only at the others).
fn wrong_type_failures(const_nodes: bool) -> (usize, Vec<String>) {
    let schema = Schema::load();
    let mut failures = Vec::new();
    let mut tried = 0usize;
    for e in table() {
        for (b, x) in bases(&schema, &e, "wrong-type").iter().enumerate() {
            for p in all_points(&schema, &e, x) {
                if is_pinned(&p.schema) != const_nodes {
                    continue;
                }
                let Some(allowed) = allowed_types(&p.schema) else {
                    continue;
                };
                // `null` for an optional field is `None`, which is fine; only a required, non-nullable field refuses it.
                let Some(wrong) = wrong_value(&allowed, p.required) else {
                    continue;
                };
                let mut doc = x.clone();
                set_at(&mut doc, &p.path, wrong.clone());
                tried += 1;
                if let Ok(v) = e.probe.through_value(&doc) {
                    failures.push(format!(
                        "{} base {b}: accepted {wrong} where the schema allows {allowed:?}, path {}, out {}",
                        e.label(),
                        path_text(&p.path),
                        clip(get_at_opt(&v, &p.path).unwrap_or(&Value::Null))
                    ));
                }
            }
        }
    }
    (tried, failures)
}

#[test]
fn a_value_of_the_wrong_json_type_is_refused_at_every_field() {
    let (tried, failures) = wrong_type_failures(false);
    assert!(tried > 5000, "only {tried} mutations were possible");
    report("wrong types", &failures);
}

/// A property whose schema is `{ "const": … }` or an `enum` with one value (29 consts: `accepted: true`, `ok: true`,
/// `confirm: true`, `open: false`, `provider: "searxng"`, `v: 1`, …; the export bundle's `format`) is typed so that it accepts
/// that value only: a value of another JSON type and another value of the same type are both refused. Until 2026-10 typify made
/// a `const` a `serde_json::Value` that accepted anything (#405).
#[test]
fn pinned_fields_are_enforced_by_the_types() {
    let (tried, mut failures) = wrong_type_failures(true);
    assert!(tried > 0);
    let schema = Schema::load();
    let mut near = 0usize;
    for e in table() {
        for (b, x) in bases(&schema, &e, "near-miss").iter().enumerate() {
            for p in all_points(&schema, &e, x) {
                let Some(other) = near_miss(&p.schema) else {
                    continue;
                };
                let mut doc = x.clone();
                set_at(&mut doc, &p.path, other.clone());
                near += 1;
                if e.probe.through_value(&doc).is_ok() {
                    failures.push(format!(
                        "{} base {b}: accepted {other} where the schema pins {}, path {}",
                        e.label(),
                        pinned_value(&p.schema).unwrap(),
                        path_text(&p.path)
                    ));
                }
            }
        }
    }
    assert!(near >= 29, "only {near} pinned fields were reached");
    report("const fields", &failures);
}

/// The one value a pinned node allows.
fn pinned_value(node: &Value) -> Option<&Value> {
    if !is_pinned(node) {
        return None;
    }
    node.get("const")
        .or_else(|| node.get("enum").and_then(|e| e.get(0)))
}

/// A value of the same JSON type as the pinned one, but another value.
fn near_miss(node: &Value) -> Option<Value> {
    Some(match pinned_value(node)? {
        Value::Bool(b) => Value::Bool(!b),
        Value::String(s) => Value::String(format!("{s}x")),
        Value::Number(n) => match n.as_i64() {
            Some(i) => json!(i + 1),
            None => json!(n.as_f64()? + 1.0),
        },
        _ => return None,
    })
}

fn path_text(path: &[Seg]) -> String {
    path.iter()
        .map(|s| match s {
            Seg::Key(k) => format!("/{k}"),
            Seg::Idx(i) => format!("/{i}"),
        })
        .collect()
}

#[test]
fn an_unknown_field_is_refused_in_params_and_ignored_everywhere_else() {
    let schema = Schema::load();
    let mut failures = Vec::new();
    let (mut closed_checked, mut open_checked) = (0usize, 0usize);
    for e in table() {
        for (b, x) in bases(&schema, &e, "unknown-field").iter().enumerate() {
            for p in all_points(&schema, &e, x) {
                if !p.has_properties || !get_at(x, &p.path).is_object() {
                    continue;
                }
                let mut doc = x.clone();
                set_at_key(&mut doc, &p.path, "zzUnknownField", json!(1));
                let outcome = e.probe.through_value(&doc);
                if p.closed {
                    closed_checked += 1;
                    if outcome.is_ok() {
                        failures.push(format!(
                            "{} base {b}: a closed params object accepted an unknown field at {}",
                            e.label(),
                            path_text(&p.path)
                        ));
                    }
                } else {
                    open_checked += 1;
                    match outcome {
                        Err(err) => failures.push(format!(
                            "{} base {b}: an open object refused an unknown field at {}: {err}",
                            e.label(),
                            path_text(&p.path)
                        )),
                        Ok(v) if !same(&schema, e.node(&schema), &v, x) => failures.push(format!(
                            "{} base {b}: unknown field at {} changed the rest of the document at {}",
                            e.label(),
                            path_text(&p.path),
                            diff(&schema, e.node(&schema), x, &v)
                        )),
                        Ok(_) => {}
                    }
                }
            }
        }
    }
    assert!(
        closed_checked > 300 && open_checked > 300,
        "{closed_checked} closed, {open_checked} open"
    );
    report("unknown fields", &failures);
}

fn set_at_key(root: &mut Value, path: &[Seg], key: &str, v: Value) {
    let mut cur = root;
    for seg in path {
        cur = match seg {
            Seg::Key(k) => cur.get_mut(k).unwrap(),
            Seg::Idx(i) => cur.get_mut(*i).unwrap(),
        };
    }
    cur.as_object_mut().unwrap().insert(key.into(), v);
}

/// Replaces every required string with a hostile one and checks the outcome against what the schema says about the string.
#[test]
fn hostile_strings_are_an_error_where_the_schema_constrains_them_and_never_a_panic() {
    let schema = Schema::load();
    let mut failures = Vec::new();
    let mut checked = 0usize;
    for e in table() {
        for (b, x) in bases(&schema, &e, "hostile-string").iter().enumerate() {
            for p in all_points(&schema, &e, x) {
                if !get_at(x, &p.path).is_string() || allowed_types(&p.schema).is_none() {
                    continue;
                }
                // A schema `const` is not enforced by the generated types (see `pinned_fields_are_enforced_by_the_types`).
                if is_pinned(&p.schema) {
                    continue;
                }
                let constrained =
                    p.schema.get("pattern").is_some() || p.schema.get("enum").is_some();
                let has_max = p.schema.get("maxLength").is_some();
                let ctx = format!("{} base {b} at {}", e.label(), path_text(&p.path));
                checked += 1;

                // NUL: refused where a pattern, enum or const pins the characters; elsewhere any answer but a panic.
                let mut doc = x.clone();
                set_at(&mut doc, &p.path, json!("nul\u{0}nul"));
                let nul = e.probe.through_value(&doc);
                if constrained && nul.is_ok() {
                    failures.push(format!("{ctx}: a NUL passed a pattern/enum/const"));
                }
                if let Ok(v) = nul {
                    if !same(&schema, e.node(&schema), &v, &doc) {
                        failures.push(format!(
                            "{ctx}: an accepted NUL string did not round-trip, at {}",
                            diff(&schema, e.node(&schema), &doc, &v)
                        ));
                    }
                }

                // A very long string: refused where the schema has a maximum length.
                let mut doc = x.clone();
                set_at(&mut doc, &p.path, Value::String("x".repeat(1_100_000)));
                let long = e.probe.through_value(&doc);
                if (has_max || constrained) && long.is_ok() {
                    failures.push(format!(
                        "{ctx}: 1.1 million characters passed maxLength/pattern/enum"
                    ));
                }

                // Invalid UTF-16 surrogates and invalid UTF-8 are not JSON text at all: always an error.
                let mut doc = x.clone();
                set_at(&mut doc, &p.path, json!(MARK));
                let text = doc.to_string();
                let quoted = serde_json::to_string(MARK).unwrap();
                for (what, raw) in [
                    ("lone high surrogate", br#""\ud800""#.to_vec()),
                    ("lone low surrogate", br#""\udc00""#.to_vec()),
                    (
                        "high surrogate followed by a non-surrogate escape",
                        br#""\ud800A""#.to_vec(),
                    ),
                    ("invalid UTF-8", vec![b'"', 0xff, 0xfe, b'"']),
                ] {
                    let bytes = replace_bytes(text.as_bytes(), quoted.as_bytes(), &raw);
                    if e.probe.through_text(&bytes).is_ok() {
                        failures.push(format!("{ctx}: {what} was accepted"));
                    }
                }
            }
        }
    }
    assert!(checked > 2000, "only {checked} strings were hostile-tested");
    report("hostile strings", &failures);
}

fn replace_bytes(hay: &[u8], needle: &[u8], with: &[u8]) -> Vec<u8> {
    let at = hay
        .windows(needle.len())
        .position(|w| w == needle)
        .expect("marker in document");
    let mut out = hay[..at].to_vec();
    out.extend_from_slice(with);
    out.extend_from_slice(&hay[at + needle.len()..]);
    out
}

#[test]
fn integers_beyond_64_bits_are_refused_for_integer_fields() {
    let schema = Schema::load();
    let mut failures = Vec::new();
    let mut checked = 0usize;
    for e in table() {
        for (b, x) in bases(&schema, &e, "big-number").iter().enumerate() {
            for p in all_points(&schema, &e, x) {
                let integer_only = p.schema.get("type") == Some(&json!("integer"));
                if !integer_only || !get_at(x, &p.path).is_i64() && !get_at(x, &p.path).is_u64() {
                    continue;
                }
                let text = {
                    let mut doc = x.clone();
                    set_at(&mut doc, &p.path, json!(MARK));
                    doc.to_string()
                };
                let quoted = serde_json::to_string(MARK).unwrap();
                for big in [
                    "18446744073709551616",
                    "-9223372036854775809",
                    "99999999999999999999999999999999",
                    "1e30",
                    "-1e30",
                ] {
                    let bytes = replace_bytes(text.as_bytes(), quoted.as_bytes(), big.as_bytes());
                    checked += 1;
                    if let Ok((first, _)) = e.probe.through_text(&bytes) {
                        failures.push(format!(
                            "{} base {b} at {}: {big} was accepted for an integer field → {first}",
                            e.label(),
                            path_text(&p.path)
                        ));
                    }
                }
            }
        }
    }
    assert!(checked > 1000, "only {checked} cases");
    report("numbers beyond 64 bits", &failures);
}

#[test]
fn nesting_1000_deep_is_an_error_and_never_a_stack_overflow() {
    let schema = Schema::load();
    let depth = 1000;
    let arrays = format!("{}{}", "[".repeat(depth), "]".repeat(depth));
    let objects = format!("{}1{}", r#"{"a":"#.repeat(depth), "}".repeat(depth));
    let mut failures = Vec::new();
    for e in table() {
        let x = generate(
            &schema,
            e.node(&schema),
            Optionals::None,
            &mut Rng::for_case(&[e.name, e.type_name, "deep"]),
        );
        let doc = x.to_string();
        let mut candidates: Vec<(&str, String)> = vec![
            ("deep array as the document", arrays.clone()),
            ("deep object as the document", objects.clone()),
        ];
        if doc.starts_with('{') && doc.len() > 2 {
            let open = format!("{{\"zzDeep\":{arrays},{}", &doc[1..]);
            candidates.push(("deep array as an extra field", open));
            let open = format!("{{\"zzDeep\":{objects},{}", &doc[1..]);
            candidates.push(("deep object as an extra field", open));
        }
        for (what, text) in candidates {
            // serde_json skips an ignored value iteratively and without a depth limit: an open object may take a deep unknown
            // field (and drop it), a closed `Params` object must refuse it, and a deep document in place of the object is refused
            // by the recursion limit (128). None of them may overflow the stack, which is what the call returning shows.
            let outcome = e.probe.through_text(text.as_bytes());
            let as_field = what.ends_with("extra field");
            // A deep object in place of the whole document is refused unless the type has no required field and ignores unknown
            // ones (some notifications are like that): it is then an empty object with an ignored key.
            let takes_any_object =
                !has_required(&schema, e.node(&schema)) && e.kind != Kind::Params;
            let must_refuse = if as_field {
                e.kind == Kind::Params
            } else {
                !(takes_any_object && what.starts_with("deep object"))
            };
            if must_refuse && outcome.is_ok() {
                failures.push(format!("{}: {what} was accepted", e.label()));
            }
            if let (true, Ok((first, _))) = (as_field, &outcome) {
                if first.contains("zzDeep") {
                    failures.push(format!("{}: {what} was kept in the output", e.label()));
                }
            }
        }
    }
    report("deep nesting", &failures);
}

fn has_required(schema: &Schema, node: &Value) -> bool {
    let (node, _) = schema.resolve(node);
    node.get("required")
        .and_then(Value::as_array)
        .is_some_and(|r| !r.is_empty())
        || node.get("oneOf").is_some()
}

/// In an update the core reads an explicit `null` or `[]` as "clear the value" and a missing key as "leave it"
/// (`packages/core/src/collab/board.ts`: `patch.dueAt !== undefined`, `patch.labels !== undefined`). So in every params type an
/// optional property whose schema allows `null`, or that is an array, keeps all three states through the typed round trip:
/// missing stays missing, `null` stays `null`, `[]` stays `[]` (`project.card.update`'s `dueAt`, `labels`, `links`,
/// `project.column.update`'s `wipLimit`, `budget.set`'s `limit.soft`/`limit.hard`, …). Until 2026-10 the typed params wrote an
/// explicit `null` or `[]` as a missing key, so a typed client could not clear a field (#405).
#[test]
fn explicit_null_and_empty_survive_for_optional_params() {
    let schema = Schema::load();
    let mut failures = Vec::new();
    let mut tried = 0usize;
    for e in table().into_iter().filter(|e| e.kind == Kind::Params) {
        let x = generate(
            &schema,
            e.node(&schema),
            Optionals::All,
            &mut Rng::for_case(&[e.name, "null"]),
        );
        for p in all_points(&schema, &e, &x) {
            if p.path.is_empty() || p.required {
                continue;
            }
            let allowed = allowed_types(&p.schema).unwrap_or_default();
            let clears: Vec<Value> = [("null", Value::Null), ("array", json!([]))]
                .into_iter()
                .filter(|(t, _)| allowed.contains(t))
                .map(|(_, v)| v)
                .collect();
            if clears.is_empty() {
                continue;
            }
            for clear in clears {
                let mut doc = x.clone();
                set_at(&mut doc, &p.path, clear.clone());
                tried += 1;
                match e.probe.through_value(&doc) {
                    Ok(v) if get_at_opt(&v, &p.path) == Some(&clear) => {}
                    Ok(v) => failures.push(format!(
                        "{}: an explicit {clear} at {} was written as {}",
                        e.label(),
                        path_text(&p.path),
                        get_at_opt(&v, &p.path)
                            .map_or("nothing (the key is gone)".to_string(), |v| v.to_string())
                    )),
                    Err(err) => failures.push(format!("{}: {err}", e.label())),
                }
            }
            // An array that does not allow `null` still refuses it; a missing key stays missing.
            if !allowed.contains("null") {
                let mut doc = x.clone();
                set_at(&mut doc, &p.path, Value::Null);
                if e.probe.through_value(&doc).is_ok() {
                    failures.push(format!(
                        "{}: null accepted at {}",
                        e.label(),
                        path_text(&p.path)
                    ));
                }
            }
            let mut doc = x.clone();
            let (key, parent) = p.path.split_last().unwrap();
            let Seg::Key(key) = key else { continue };
            get_at_mut(&mut doc, parent)
                .as_object_mut()
                .unwrap()
                .remove(key);
            match e.probe.through_value(&doc) {
                Ok(v) if get_at_opt(&v, &p.path).is_none() => {}
                Ok(v) => failures.push(format!(
                    "{}: a missing {} came back as {}",
                    e.label(),
                    path_text(&p.path),
                    get_at_opt(&v, &p.path).unwrap()
                )),
                Err(err) => failures.push(format!(
                    "{}: without {}: {err}",
                    e.label(),
                    path_text(&p.path)
                )),
            }
        }
    }
    // 21 places in 13 params types on 2026-10-14 (schema rpc 1.x).
    assert!(tried >= 21, "only {tried} cases");
    report("explicit null / empty", &failures);
}

fn get_at_mut<'a>(root: &'a mut Value, path: &[Seg]) -> &'a mut Value {
    let mut cur = root;
    for seg in path {
        cur = match seg {
            Seg::Key(k) => cur.get_mut(k).unwrap(),
            Seg::Idx(i) => cur.get_mut(*i).unwrap(),
        };
    }
    cur
}

fn get_at_opt<'a>(root: &'a Value, path: &[Seg]) -> Option<&'a Value> {
    let mut cur = root;
    for seg in path {
        cur = match seg {
            Seg::Key(k) => cur.get(k)?,
            Seg::Idx(i) => cur.get(*i)?,
        };
    }
    Some(cur)
}

// ---------------------------------------------------------------------------------------------------------------------
// the type table: `Kind "wire name" RustType`, one line per method parameter and result and per notification
// ---------------------------------------------------------------------------------------------------------------------

table! {
    Params "voice.status" VoiceStatusParams,
    Result "voice.status" VoiceStatusResult,
    Params "voice.agent.override.get" VoiceAgentOverrideGetParams,
    Result "voice.agent.override.get" VoiceAgentOverrideGetResult,
    Params "voice.agent.override.set" VoiceAgentOverrideSetParams,
    Result "voice.agent.override.set" VoiceAgentOverrideSetResult,
    Params "voice.agent.override.clear" VoiceAgentOverrideClearParams,
    Result "voice.agent.override.clear" VoiceAgentOverrideClearResult,
    Params "voice.realtime.start" VoiceRealtimeStartParams,
    Result "voice.realtime.start" VoiceRealtimeStartResult,
    Params "voice.realtime.stop" VoiceRealtimeStopParams,
    Result "voice.realtime.stop" VoiceRealtimeStopResult,
    Params "voice.models.list" VoiceModelsListParams,
    Result "voice.models.list" VoiceModelsListResult,
    Params "voice.models.install" VoiceModelsInstallParams,
    Result "voice.models.install" VoiceModelsInstallResult,
    Params "voice.language.list" VoiceLanguageListParams,
    Result "voice.language.list" VoiceLanguageListResult,
    Params "voice.language.get" VoiceLanguageGetParams,
    Result "voice.language.get" VoiceLanguageGetResult,
    Params "voice.language.set" VoiceLanguageSetParams,
    Result "voice.language.set" VoiceLanguageSetResult,
    Params "voice.realtime.profile.get" VoiceRealtimeProfileGetParams,
    Result "voice.realtime.profile.get" VoiceRealtimeProfileGetResult,
    Params "voice.realtime.profile.set" VoiceRealtimeProfileSetParams,
    Result "voice.realtime.profile.set" VoiceRealtimeProfileSetResult,
    Params "voice.metrics.get" VoiceMetricsGetParams,
    Result "voice.metrics.get" VoiceMetricsGetResult,
    Params "project.column.list" ProjectColumnListParams,
    Result "project.column.list" ProjectColumnListResult,
    Params "project.column.create" ProjectColumnCreateParams,
    Result "project.column.create" ProjectColumnCreateResult,
    Params "project.column.update" ProjectColumnUpdateParams,
    Result "project.column.update" ProjectColumnUpdateResult,
    Params "project.column.move" ProjectColumnMoveParams,
    Result "project.column.move" ProjectColumnMoveResult,
    Params "project.column.delete" ProjectColumnDeleteParams,
    Result "project.column.delete" ProjectColumnDeleteResult,
    Params "project.card.list" ProjectCardListParams,
    Result "project.card.list" ProjectCardListResult,
    Params "project.card.get" ProjectCardGetParams,
    Result "project.card.get" ProjectCardGetResult,
    Params "project.card.create" ProjectCardCreateParams,
    Result "project.card.create" ProjectCardCreateResult,
    Params "project.card.update" ProjectCardUpdateParams,
    Result "project.card.update" ProjectCardUpdateResult,
    Params "project.card.move" ProjectCardMoveParams,
    Result "project.card.move" ProjectCardMoveResult,
    Params "project.card.assign" ProjectCardAssignParams,
    Result "project.card.assign" ProjectCardAssignResult,
    Params "project.card.unassign" ProjectCardUnassignParams,
    Result "project.card.unassign" ProjectCardUnassignResult,
    Params "project.card.archive" ProjectCardArchiveParams,
    Result "project.card.archive" ProjectCardArchiveResult,
    Params "project.card.unarchive" ProjectCardUnarchiveParams,
    Result "project.card.unarchive" ProjectCardUnarchiveResult,
    Params "project.card.comment.add" ProjectCardCommentAddParams,
    Result "project.card.comment.add" ProjectCardCommentAddResult,
    Params "project.card.comment.list" ProjectCardCommentListParams,
    Result "project.card.comment.list" ProjectCardCommentListResult,
    Params "project.card.activity.list" ProjectCardActivityListParams,
    Result "project.card.activity.list" ProjectCardActivityListResult,
    Params "device.list" DeviceListParams,
    Result "device.list" DeviceListResult,
    Params "device.revoke" DeviceRevokeParams,
    Result "device.revoke" DeviceRevokeResult,
    Params "device.rename" DeviceRenameParams,
    Result "device.rename" DeviceRenameResult,
    Params "media.preferences.set" MediaPreferencesSetParams,
    Result "media.preferences.set" MediaPreferencesSetResult,
    Params "media.preferences.get" MediaPreferencesGetParams,
    Result "media.preferences.get" MediaPreferencesGetResult,
    Params "media.generate" MediaGenerateParams,
    Result "media.generate" MediaGenerateResult,
    Params "media.edit" MediaEditParams,
    Result "media.edit" MediaEditResult,
    Params "media.job.get" MediaJobGetParams,
    Result "media.job.get" MediaJobGetResult,
    Params "media.job.cancel" MediaJobCancelParams,
    Result "media.job.cancel" MediaJobCancelResult,
    Params "media.job.list" MediaJobListParams,
    Result "media.job.list" MediaJobListResult,
    Params "media.output.get" MediaOutputGetParams,
    Result "media.output.get" MediaOutputGetResult,
    Params "media.output.list" MediaOutputListParams,
    Result "media.output.list" MediaOutputListResult,
    Params "media.output.delete" MediaOutputDeleteParams,
    Result "media.output.delete" MediaOutputDeleteResult,
    Params "media.adapters.list" MediaAdaptersListParams,
    Result "media.adapters.list" MediaAdaptersListResult,
    Params "project.create" ProjectCreateParams,
    Result "project.create" ProjectCreateResult,
    Params "project.get" ProjectGetParams,
    Result "project.get" ProjectGetResult,
    Params "project.list" ProjectListParams,
    Result "project.list" ProjectListResult,
    Params "project.update" ProjectUpdateParams,
    Result "project.update" ProjectUpdateResult,
    Params "project.archive" ProjectArchiveParams,
    Result "project.archive" ProjectArchiveResult,
    Params "project.member.add" ProjectMemberAddParams,
    Result "project.member.add" ProjectMemberAddResult,
    Params "project.member.remove" ProjectMemberRemoveParams,
    Result "project.member.remove" ProjectMemberRemoveResult,
    Params "project.member.role" ProjectMemberRoleParams,
    Result "project.member.role" ProjectMemberRoleResult,
    Params "project.agent.add" ProjectAgentAddParams,
    Result "project.agent.add" ProjectAgentAddResult,
    Params "project.agent.remove" ProjectAgentRemoveParams,
    Result "project.agent.remove" ProjectAgentRemoveResult,
    Params "collab.trace.get" CollabTraceGetParams,
    Result "collab.trace.get" CollabTraceGetResult,
    Params "collab.trace.list" CollabTraceListParams,
    Result "collab.trace.list" CollabTraceListResult,
    Params "collab.chain.cancel" CollabChainCancelParams,
    Result "collab.chain.cancel" CollabChainCancelResult,
    Params "identity.link.request" IdentityLinkRequestParams,
    Result "identity.link.request" IdentityLinkRequestResult,
    Params "identity.link.list" IdentityLinkListParams,
    Result "identity.link.list" IdentityLinkListResult,
    Params "identity.link.approve" IdentityLinkApproveParams,
    Result "identity.link.approve" IdentityLinkApproveResult,
    Params "identity.link.decline" IdentityLinkDeclineParams,
    Result "identity.link.decline" IdentityLinkDeclineResult,
    Params "identity.link.remove" IdentityLinkRemoveParams,
    Result "identity.link.remove" IdentityLinkRemoveResult,
    Params "identity.principals" IdentityPrincipalsParams,
    Result "identity.principals" IdentityPrincipalsResult,
    Params "core.auth" CoreAuthParams,
    Result "core.auth" CoreAuthResult,
    Params "core.status" CoreStatusParams,
    Result "core.status" CoreStatusResult,
    Params "core.shutdown" CoreShutdownParams,
    Result "core.shutdown" CoreShutdownResult,
    Params "core.adopt" CoreAdoptParams,
    Result "core.adopt" CoreAdoptResult,
    Params "memory.recall" MemoryRecallParams,
    Result "memory.recall" MemoryRecallResult,
    Params "memory.capture" MemoryCaptureParams,
    Result "memory.capture" MemoryCaptureResult,
    Params "memory.checkpoint" MemoryCheckpointParams,
    Result "memory.checkpoint" MemoryCheckpointResult,
    Params "memory.list" MemoryListParams,
    Result "memory.list" MemoryListResult,
    Params "memory.show" MemoryShowParams,
    Result "memory.show" MemoryShowResult,
    Params "memory.forget" MemoryForgetParams,
    Result "memory.forget" MemoryForgetResult,
    Params "memory.correct" MemoryCorrectParams,
    Result "memory.correct" MemoryCorrectResult,
    Params "memory.share" MemoryShareParams,
    Result "memory.share" MemoryShareResult,
    Params "memory.state" MemoryStateParams,
    Result "memory.state" MemoryStateResult,
    Params "memory.propose" MemoryProposeParams,
    Result "memory.propose" MemoryProposeResult,
    Params "memory.proposals.list" MemoryProposalsListParams,
    Result "memory.proposals.list" MemoryProposalsListResult,
    Params "memory.proposals.accept" MemoryProposalsAcceptParams,
    Result "memory.proposals.accept" MemoryProposalsAcceptResult,
    Params "memory.proposals.reject" MemoryProposalsRejectParams,
    Result "memory.proposals.reject" MemoryProposalsRejectResult,
    Params "agent.list" AgentListParams,
    Result "agent.list" AgentListResult,
    Params "agent.open" AgentOpenParams,
    Result "agent.open" AgentOpenResult,
    Params "agent.close" AgentCloseParams,
    Result "agent.close" AgentCloseResult,
    Params "doctor.report" DoctorReportParams,
    Result "doctor.report" DoctorReportResult,
    Params "agent.activity.list" AgentActivityListParams,
    Result "agent.activity.list" AgentActivityListResult,
    Params "agent.status" AgentStatusParams,
    Result "agent.status" AgentStatusResult,
    Params "jobs.create" JobsCreateParams,
    Result "jobs.create" JobsCreateResult,
    Params "jobs.update" JobsUpdateParams,
    Result "jobs.update" JobsUpdateResult,
    Params "jobs.delete" JobsDeleteParams,
    Result "jobs.delete" JobsDeleteResult,
    Params "jobs.list" JobsListParams,
    Result "jobs.list" JobsListResult,
    Params "jobs.run" JobsRunParams,
    Result "jobs.run" JobsRunResult,
    Params "jobs.history" JobsHistoryParams,
    Result "jobs.history" JobsHistoryResult,
    Params "dreams.status" DreamsStatusParams,
    Result "dreams.status" DreamsStatusResult,
    Params "dreams.log" DreamsLogParams,
    Result "dreams.log" DreamsLogResult,
    Params "dreams.run" DreamsRunParams,
    Result "dreams.run" DreamsRunResult,
    Params "dreams.schedule.get" DreamsScheduleGetParams,
    Result "dreams.schedule.get" DreamsScheduleGetResult,
    Params "dreams.schedule.set" DreamsScheduleSetParams,
    Result "dreams.schedule.set" DreamsScheduleSetResult,
    Params "dreams.enable" DreamsEnableParams,
    Result "dreams.enable" DreamsEnableResult,
    Params "dreams.disable" DreamsDisableParams,
    Result "dreams.disable" DreamsDisableResult,
    Params "dreams.diary" DreamsDiaryParams,
    Result "dreams.diary" DreamsDiaryResult,
    Params "chat.create" ChatCreateParams,
    Result "chat.create" ChatCreateResult,
    Params "chat.list" ChatListParams,
    Result "chat.list" ChatListResult,
    Params "chat.get" ChatGetParams,
    Result "chat.get" ChatGetResult,
    Params "chat.events" ChatEventsParams,
    Result "chat.events" ChatEventsResult,
    Params "chat.submit" ChatSubmitParams,
    Result "chat.submit" ChatSubmitResult,
    Params "chat.update" ChatUpdateParams,
    Result "chat.update" ChatUpdateResult,
    Params "chat.archive" ChatArchiveParams,
    Result "chat.archive" ChatArchiveResult,
    Params "chat.restore" ChatRestoreParams,
    Result "chat.restore" ChatRestoreResult,
    Params "chat.cancel" ChatCancelParams,
    Result "chat.cancel" ChatCancelResult,
    Params "chat.fork" ChatForkParams,
    Result "chat.fork" ChatForkResult,
    Params "chat.delete" ChatDeleteParams,
    Result "chat.delete" ChatDeleteResult,
    Params "chat.export" ChatExportParams,
    Result "chat.export" ChatExportResult,
    Params "admin.obsidian.detect" AdminObsidianDetectParams,
    Result "admin.obsidian.detect" AdminObsidianDetectResult,
    Params "admin.obsidian.prepare" AdminObsidianPrepareParams,
    Result "admin.obsidian.prepare" AdminObsidianPrepareResult,
    Params "admin.obsidian.confirm" AdminObsidianConfirmParams,
    Result "admin.obsidian.confirm" AdminObsidianConfirmResult,
    Params "admin.migrate" AdminMigrateParams,
    Result "admin.migrate" AdminMigrateResult,
    Params "admin.backup.snapshot" AdminBackupSnapshotParams,
    Result "admin.backup.snapshot" AdminBackupSnapshotResult,
    Params "logs.levels" LogsLevelsParams,
    Result "logs.levels" LogsLevelsResult,
    Params "logs.query" LogsQueryParams,
    Result "logs.query" LogsQueryResult,
    Params "logs.tail" LogsTailParams,
    Result "logs.tail" LogsTailResult,
    Params "audit.verify" AuditVerifyParams,
    Result "audit.verify" AuditVerifyResult,
    Params "admin.embedding.probe" AdminEmbeddingProbeParams,
    Result "admin.embedding.probe" AdminEmbeddingProbeResult,
    Params "admin.embedding.serve" AdminEmbeddingServeParams,
    Result "admin.embedding.serve" AdminEmbeddingServeResult,
    Params "admin.reembed.plan" AdminReembedPlanParams,
    Result "admin.reembed.plan" AdminReembedPlanResult,
    Params "admin.reembed.run" AdminReembedRunParams,
    Result "admin.reembed.run" AdminReembedRunResult,
    Params "admin.reembed.status" AdminReembedStatusParams,
    Result "admin.reembed.status" AdminReembedStatusResult,
    Params "admin.reembed.abort" AdminReembedAbortParams,
    Result "admin.reembed.abort" AdminReembedAbortResult,
    Params "events.subscribe" EventsSubscribeParams,
    Result "events.subscribe" EventsSubscribeResult,
    Params "events.unsubscribe" EventsUnsubscribeParams,
    Result "events.unsubscribe" EventsUnsubscribeResult,
    Params "supervisor.auth" SupervisorAuthParams,
    Result "supervisor.auth" SupervisorAuthResult,
    Params "daemon.status" DaemonStatusParams,
    Result "daemon.status" DaemonStatusResult,
    Params "daemon.start" DaemonStartParams,
    Result "daemon.start" DaemonStartResult,
    Params "daemon.stop" DaemonStopParams,
    Result "daemon.stop" DaemonStopResult,
    Params "config.get" ConfigGetParams,
    Result "config.get" ConfigGetResult,
    Params "config.set" ConfigSetParams,
    Result "config.set" ConfigSetResult,
    Params "config.watch" ConfigWatchParams,
    Result "config.watch" ConfigWatchResult,
    Params "module.watch" ModuleWatchParams,
    Result "module.watch" ModuleWatchResult,
    Params "module.list" ModuleListParams,
    Result "module.list" ModuleListResult,
    Params "module.start" ModuleStartParams,
    Result "module.start" ModuleStartResult,
    Params "module.stop" ModuleStopParams,
    Result "module.stop" ModuleStopResult,
    Params "module.restart" ModuleRestartParams,
    Result "module.restart" ModuleRestartResult,
    Params "module.graph" ModuleGraphParams,
    Result "module.graph" ModuleGraphResult,
    Params "module.install" ModuleInstallParams,
    Result "module.install" ModuleInstallResult,
    Params "module.uninstall" ModuleUninstallParams,
    Result "module.uninstall" ModuleUninstallResult,
    Params "module.auth" ModuleAuthParams,
    Result "module.auth" ModuleAuthResult,
    Params "module.status" ModuleStatusParams,
    Result "module.status" ModuleStatusResult,
    Params "module.adopt" ModuleAdoptParams,
    Result "module.adopt" ModuleAdoptResult,
    Params "module.shutdown" ModuleShutdownParams,
    Result "module.shutdown" ModuleShutdownResult,
    Params "ext.list" ExtListParams,
    Result "ext.list" ExtListResult,
    Params "ext.show" ExtShowParams,
    Result "ext.show" ExtShowResult,
    Params "ext.inspect" ExtInspectParams,
    Result "ext.inspect" ExtInspectResult,
    Params "ext.install" ExtInstallParams,
    Result "ext.install" ExtInstallResult,
    Params "ext.uninstall" ExtUninstallParams,
    Result "ext.uninstall" ExtUninstallResult,
    Params "ext.restore" ExtRestoreParams,
    Result "ext.restore" ExtRestoreResult,
    Params "ext.enable" ExtEnableParams,
    Result "ext.enable" ExtEnableResult,
    Params "ext.disable" ExtDisableParams,
    Result "ext.disable" ExtDisableResult,
    Params "ext.watch" ExtWatchParams,
    Result "ext.watch" ExtWatchResult,
    Params "models.list" ModelsListParams,
    Result "models.list" ModelsListResult,
    Params "models.scan" ModelsScanParams,
    Result "models.scan" ModelsScanResult,
    Params "models.setOverride" ModelsSetOverrideParams,
    Result "models.setOverride" ModelsSetOverrideResult,
    Params "models.removeManual" ModelsRemoveManualParams,
    Result "models.removeManual" ModelsRemoveManualResult,
    Params "models.acknowledge" ModelsAcknowledgeParams,
    Result "models.acknowledge" ModelsAcknowledgeResult,
    Params "budget.status" BudgetStatusParams,
    Result "budget.status" BudgetStatusResult,
    Params "egress.status" EgressStatusParams,
    Result "egress.status" EgressStatusResult,
    Params "budget.set" BudgetSetParams,
    Result "budget.set" BudgetSetResult,
    Params "secret.status" SecretStatusParams,
    Result "secret.status" SecretStatusResult,
    Params "secret.list" SecretListParams,
    Result "secret.list" SecretListResult,
    Params "auth.login.start" AuthLoginStartParams,
    Result "auth.login.start" AuthLoginStartResult,
    Params "auth.login.await" AuthLoginAwaitParams,
    Result "auth.login.await" AuthLoginAwaitResult,
    Params "auth.login.cancel" AuthLoginCancelParams,
    Result "auth.login.cancel" AuthLoginCancelResult,
    Params "auth.credentials.list" AuthCredentialsListParams,
    Result "auth.credentials.list" AuthCredentialsListResult,
    Params "auth.logout" AuthLogoutParams,
    Result "auth.logout" AuthLogoutResult,
    Params "agent.pause" AgentPauseParams,
    Result "agent.pause" AgentPauseResult,
    Params "agent.resume" AgentResumeParams,
    Result "agent.resume" AgentResumeResult,
    Params "agent.archive" AgentArchiveParams,
    Result "agent.archive" AgentArchiveResult,
    Params "agent.unarchive" AgentUnarchiveParams,
    Result "agent.unarchive" AgentUnarchiveResult,
    Params "agent.export" AgentExportParams,
    Result "agent.export" AgentExportResult,
    Params "agent.delete" AgentDeleteParams,
    Result "agent.delete" AgentDeleteResult,
    Params "agent.create" AgentCreateParams,
    Result "agent.create" AgentCreateResult,
    Params "agent.validate" AgentValidateParams,
    Result "agent.validate" AgentValidateResult,
    Params "agent.import" AgentImportParams,
    Result "agent.import" AgentImportResult,
    Params "user.list" UserListParams,
    Result "user.list" UserListResult,
    Params "user.disable" UserDisableParams,
    Result "user.disable" UserDisableResult,
    Params "user.enable" UserEnableParams,
    Result "user.enable" UserEnableResult,
    Params "admin.api.person.resolve" AdminApiPersonResolveParams,
    Result "admin.api.person.resolve" AdminApiPersonResolveResult,
    Params "admin.api.invite.validate" AdminApiInviteValidateParams,
    Result "admin.api.invite.validate" AdminApiInviteValidateResult,
    Params "user.role.set" UserRoleSetParams,
    Result "user.role.set" UserRoleSetResult,
    Params "user.invite.create" UserInviteCreateParams,
    Result "user.invite.create" UserInviteCreateResult,
    Params "user.invite.list" UserInviteListParams,
    Result "user.invite.list" UserInviteListResult,
    Params "user.invite.revoke" UserInviteRevokeParams,
    Result "user.invite.revoke" UserInviteRevokeResult,
    Params "user.invite.redeem" UserInviteRedeemParams,
    Result "user.invite.redeem" UserInviteRedeemResult,
    Params "agent.rights.get" AgentRightsGetParams,
    Result "agent.rights.get" AgentRightsGetResult,
    Params "agent.rights.set" AgentRightsSetParams,
    Result "agent.rights.set" AgentRightsSetResult,
    Params "breakglass.request" BreakglassRequestParams,
    Result "breakglass.request" BreakglassRequestResult,
    Params "inbox.list" InboxListParams,
    Result "inbox.list" InboxListResult,
    Params "inbox.count" InboxCountParams,
    Result "inbox.count" InboxCountResult,
    Params "inbox.markRead" InboxMarkReadParams,
    Result "inbox.markRead" InboxMarkReadResult,
    Params "inbox.dismiss" InboxDismissParams,
    Result "inbox.dismiss" InboxDismissResult,
    Params "breakglass.notices" BreakglassNoticesParams,
    Result "breakglass.notices" BreakglassNoticesResult,
    Params "breakglass.list" BreakglassListParams,
    Result "breakglass.list" BreakglassListResult,
    Params "breakglass.revoke" BreakglassRevokeParams,
    Result "breakglass.revoke" BreakglassRevokeResult,
    Params "pairing.qr" PairingQrParams,
    Result "pairing.qr" PairingQrResult,
    Params "auth.status" AuthStatusParams,
    Result "auth.status" AuthStatusResult,
    Params "channel.list" ChannelListParams,
    Result "channel.list" ChannelListResult,
    Params "channel.get" ChannelGetParams,
    Result "channel.get" ChannelGetResult,
    Params "channel.enable" ChannelEnableParams,
    Result "channel.enable" ChannelEnableResult,
    Params "channel.disable" ChannelDisableParams,
    Result "channel.disable" ChannelDisableResult,
    Params "channel.set" ChannelSetParams,
    Result "channel.set" ChannelSetResult,
    Params "channel.test" ChannelTestParams,
    Result "channel.test" ChannelTestResult,
    Params "channel.status" ChannelStatusParams,
    Result "channel.status" ChannelStatusResult,
    Params "media.search" MediaSearchParams,
    Result "media.search" MediaSearchResult,
    Params "media.index.status" MediaIndexStatusParams,
    Result "media.index.status" MediaIndexStatusResult,
    Params "media.index.pause" MediaIndexPauseParams,
    Result "media.index.pause" MediaIndexPauseResult,
    Params "media.index.resume" MediaIndexResumeParams,
    Result "media.index.resume" MediaIndexResumeResult,
    Params "media.index.reindex" MediaIndexReindexParams,
    Result "media.index.reindex" MediaIndexReindexResult,
    Params "media.caption.set" MediaCaptionSetParams,
    Result "media.caption.set" MediaCaptionSetResult,
    Params "secret.set" SecretSetParams,
    Result "secret.set" SecretSetResult,
    Params "secret.get" SecretGetParams,
    Result "secret.get" SecretGetResult,
    Params "secret.delete" SecretDeleteParams,
    Result "secret.delete" SecretDeleteResult,
    Params "identity.list" IdentityListParams,
    Result "identity.list" IdentityListResult,
    Params "identity.human.create" IdentityHumanCreateParams,
    Result "identity.human.create" IdentityHumanCreateResult,
    Params "identity.link" IdentityLinkParams,
    Result "identity.link" IdentityLinkResult,
    Params "identity.pair.start" IdentityPairStartParams,
    Result "identity.pair.start" IdentityPairStartResult,
    Params "identity.pair.claim" IdentityPairClaimParams,
    Result "identity.pair.claim" IdentityPairClaimResult,
    Params "identity.pair.confirm" IdentityPairConfirmParams,
    Result "identity.pair.confirm" IdentityPairConfirmResult,
    Params "identity.unlink" IdentityUnlinkParams,
    Result "identity.unlink" IdentityUnlinkResult,
    Params "session.create" SessionCreateParams,
    Result "session.create" SessionCreateResult,
    Params "session.list" SessionListParams,
    Result "session.list" SessionListResult,
    Params "session.get" SessionGetParams,
    Result "session.get" SessionGetResult,
    Params "session.resume" SessionResumeParams,
    Result "session.resume" SessionResumeResult,
    Params "session.archive" SessionArchiveParams,
    Result "session.archive" SessionArchiveResult,
    Params "session.submit" SessionSubmitParams,
    Result "session.submit" SessionSubmitResult,
    Params "session.events" SessionEventsParams,
    Result "session.events" SessionEventsResult,
    Params "session.cancel" SessionCancelParams,
    Result "session.cancel" SessionCancelResult,
    Params "grant.list" GrantListParams,
    Result "grant.list" GrantListResult,
    Params "grant.get" GrantGetParams,
    Result "grant.get" GrantGetResult,
    Params "grant.create" GrantCreateParams,
    Result "grant.create" GrantCreateResult,
    Params "grant.revoke" GrantRevokeParams,
    Result "grant.revoke" GrantRevokeResult,
    Params "approval.list" ApprovalListParams,
    Result "approval.list" ApprovalListResult,
    Params "approval.get" ApprovalGetParams,
    Result "approval.get" ApprovalGetResult,
    Params "approval.decide" ApprovalDecideParams,
    Result "approval.decide" ApprovalDecideResult,
    Params "approval.cancel" ApprovalCancelParams,
    Result "approval.cancel" ApprovalCancelResult,
    Params "approval.verify" ApprovalVerifyParams,
    Result "approval.verify" ApprovalVerifyResult,
    Params "approval.audit" ApprovalAuditParams,
    Result "approval.audit" ApprovalAuditResult,
    Notification "voice.realtime.state" VoiceRealtimeStateNotification,
    Notification "voice.realtime.transcript" VoiceRealtimeTranscriptNotification,
    Notification "voice.download.progress" VoiceDownloadProgressNotification,
    Notification "inbox.changed" InboxChangedNotification,
    Notification "project.card.changed" ProjectCardChangedNotification,
    Notification "project.column.changed" ProjectColumnChangedNotification,
    Notification "breakglass.notice" BreakglassNoticeNotification,
    Notification "media.job.progress" MediaJobProgressNotification,
    Notification "media.job.finished" MediaJobFinishedNotification,
    Notification "core.state" CoreStateNotification,
    Notification "agent.activity" AgentActivityNotification,
    Notification "engine.event" EngineEventNotification,
    Notification "recall.completed" RecallCompletedNotification,
    Notification "recall.degraded" RecallDegradedNotification,
    Notification "recall.block-clipped" RecallBlockClippedNotification,
    Notification "recall.block-dropped" RecallBlockDroppedNotification,
    Notification "job.run" JobRunNotification,
    Notification "memory.proposal" MemoryProposalNotification,
    Notification "dream.completed" DreamCompletedNotification,
    Notification "acl.denied" AclDeniedNotification,
    Notification "embedding.identity.changed" EmbeddingIdentityChangedNotification,
    Notification "config.changed" ConfigChangedNotification,
    Notification "module.state" ModuleStateNotification,
    Notification "ext.changed" ExtChangedNotification,
    Notification "models.changed" ModelsChangedNotification,
    Notification "session.event" SessionEventNotification,
    Notification "approval.requested" ApprovalRequestedNotification,
    Notification "approval.resolved" ApprovalResolvedNotification,
    Notification "approval.parked" ApprovalParkedNotification,
    Notification "api.account.changed" ApiAccountChangedNotification,
    Notification "grant.changed" GrantChangedNotification,
}

/// The Rust shape the generator gives the explicit-value fields and the pinned values, as a typed client sees them.
#[test]
fn typed_params_say_missing_null_and_empty_apart_and_consts_are_literals() {
    let p: types::ProjectCardUpdateParams = serde_json::from_value(
        json!({ "projectId": "p", "cardId": "c", "dueAt": null, "labels": [] }),
    )
    .unwrap();
    assert_eq!(p.due_at, Some(None));
    assert_eq!(p.labels.as_deref().map(<[_]>::len), Some(0));
    assert!(p.links.is_none());
    assert_eq!(
        serde_json::to_value(&p).unwrap(),
        json!({ "projectId": "p", "cardId": "c", "dueAt": null, "labels": [] })
    );
    let p: types::ProjectCardUpdateParams =
        serde_json::from_value(json!({ "projectId": "p", "cardId": "c", "dueAt": 5 })).unwrap();
    assert_eq!(p.due_at, Some(Some(5)));
    assert!(p.labels.is_none());

    let r: types::CoreShutdownResult = serde_json::from_value(json!({ "accepted": true })).unwrap();
    assert_eq!(r.accepted, types::ConstTrue);
    assert!(
        serde_json::from_value::<types::CoreShutdownResult>(json!({ "accepted": false })).is_err()
    );
    let closed = |open: bool| {
        serde_json::from_value::<types::AgentCloseResult>(json!({ "agentId": "a1", "open": open }))
    };
    assert_eq!(closed(false).unwrap().open, types::ConstFalse);
    assert!(closed(true).is_err());
}
