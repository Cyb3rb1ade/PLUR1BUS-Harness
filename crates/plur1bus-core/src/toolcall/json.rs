//! JSON values the way the JavaScript runtime holds them, for the one place where that matters to the byte: the arguments
//! a model wrote for a tool call, and the texts the model gets back about them.
//!
//! `serde_json::Value` cannot stand in. It refuses documents `JSON.parse` accepts (an escape of a lone surrogate, more
//! than 128 levels, `1e400`), it sorts object members, and a Rust `String` cannot hold a lone surrogate, which a model can
//! write and which then appears in an issue's path or value. [`V`] keeps strings as UTF-16 code units ([`JsStr`]), numbers
//! as doubles, and object members in the order a JavaScript object enumerates them: array-index keys ascending, then the
//! others as inserted. [`parse_units`] is `JSON.parse` and [`V::stringify`] is `JSON.stringify`
//! (`fixtures/parity/toolcall/json.json`).
use crate::js::json_stringify_units;
use crate::metrics::registry::js_number_to_string;
use std::collections::HashMap;
use std::fmt;

/// The deepest nesting [`parse_units`] builds. A deeper document is still checked for syntax to its last character, but
/// not materialised ([`Parsed::TooDeep`]): every later step refuses a value deeper than 64 anyway, and a tree of a
/// hundred thousand levels would overflow the stack of whatever dropped or cloned it.
pub const MAX_PARSE_DEPTH: usize = 512;

/// A JavaScript string: UTF-16 code units, possibly with a lone surrogate. Ordered by code unit, as `<` orders strings.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
pub struct JsStr(Vec<u16>);

impl JsStr {
    /// A string from its code units.
    pub fn new(units: Vec<u16>) -> Self {
        JsStr(units)
    }

    /// The code units.
    pub fn units(&self) -> &[u16] {
        &self.0
    }

    /// `s.length`.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// `s === ""`.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// `[...s].length`: code points, a lone surrogate counting as one.
    pub fn code_points(&self) -> usize {
        char::decode_utf16(self.0.iter().copied()).count()
    }

    /// `s.toWellFormed()` as a Rust string (a lone surrogate becomes U+FFFD).
    pub fn lossy(&self) -> String {
        String::from_utf16_lossy(&self.0)
    }

    /// `s === other`.
    pub fn is(&self, other: &str) -> bool {
        self.0.iter().copied().eq(other.encode_utf16())
    }

    /// `s += other`.
    pub fn push(&mut self, other: &JsStr) {
        self.0.extend_from_slice(&other.0);
    }

    /// `s += other`.
    pub fn push_str(&mut self, other: &str) {
        self.0.extend(other.encode_utf16());
    }

    /// `s + other`.
    pub fn plus(mut self, other: &str) -> JsStr {
        self.push_str(other);
        self
    }

    /// `s + other`.
    pub fn plus_js(mut self, other: &JsStr) -> JsStr {
        self.push(other);
        self
    }
}

impl From<&str> for JsStr {
    fn from(s: &str) -> Self {
        JsStr(s.encode_utf16().collect())
    }
}

impl From<String> for JsStr {
    fn from(s: String) -> Self {
        JsStr::from(s.as_str())
    }
}

impl fmt::Debug for JsStr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&json_stringify_units(&self.0))
    }
}

impl fmt::Display for JsStr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.lossy())
    }
}

/// The array index a property key names (`"0"` to `"4294967294"`, canonical decimal), else `None`. Such keys enumerate
/// first, in ascending order.
fn array_index(key: &[u16]) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key[0] == u16::from(b'0')) {
        return None;
    }
    let mut n: u64 = 0;
    for u in key {
        let d = u.checked_sub(u16::from(b'0')).filter(|d| *d <= 9)?;
        n = n * 10 + u64::from(d);
    }
    u32::try_from(n).ok().filter(|n| *n < u32::MAX)
}

/// A JavaScript object with own, enumerable data properties only (what `JSON.parse` makes), in enumeration order.
/// `__proto__` is a key like any other.
#[derive(Clone, Debug, Default)]
pub struct Obj {
    members: Vec<(JsStr, V)>,
    /// How many leading members have array-index keys (they are kept sorted).
    indexed: usize,
}

impl Obj {
    /// `{}`.
    pub fn new() -> Self {
        Obj::default()
    }

    /// Members in the order given, a repeated key keeping its first place and its last value (`JSON.parse`,
    /// `Object.fromEntries`); linear in the number of members.
    pub fn from_pairs(pairs: Vec<(JsStr, V)>) -> Self {
        let mut slot: HashMap<JsStr, usize> = HashMap::with_capacity(pairs.len());
        let mut plain: Vec<(JsStr, V)> = Vec::with_capacity(pairs.len());
        for (k, v) in pairs {
            match slot.get(&k) {
                Some(i) => plain[*i].1 = v,
                None => {
                    slot.insert(k.clone(), plain.len());
                    plain.push((k, v));
                }
            }
        }
        let mut indexed: Vec<(u32, (JsStr, V))> = Vec::new();
        let mut rest: Vec<(JsStr, V)> = Vec::with_capacity(plain.len());
        for m in plain {
            match array_index(m.0.units()) {
                Some(i) => indexed.push((i, m)),
                None => rest.push(m),
            }
        }
        indexed.sort_by_key(|(i, _)| *i);
        let n = indexed.len();
        let mut members: Vec<(JsStr, V)> = indexed.into_iter().map(|(_, m)| m).collect();
        members.extend(rest);
        Obj {
            members,
            indexed: n,
        }
    }

    /// `o[key] = value` for an own data property: an existing key keeps its place, a new array index is sorted in, any
    /// other new key goes last.
    pub fn set(&mut self, key: impl Into<JsStr>, value: V) {
        let key = key.into();
        if let Some(slot) = self.members.iter_mut().find(|(k, _)| *k == key) {
            slot.1 = value;
            return;
        }
        match array_index(key.units()) {
            Some(i) => {
                let at = self.members[..self.indexed]
                    .partition_point(|(k, _)| array_index(k.units()).is_some_and(|j| j < i));
                self.members.insert(at, (key, value));
                self.indexed += 1;
            }
            None => self.members.push((key, value)),
        }
    }

    /// The own property `key`.
    pub fn get(&self, key: &str) -> Option<&V> {
        self.members.iter().find(|(k, _)| k.is(key)).map(|(_, v)| v)
    }

    /// The own property `key`.
    pub fn get_js(&self, key: &JsStr) -> Option<&V> {
        self.members.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// `Object.hasOwn(o, key)`.
    pub fn has(&self, key: &JsStr) -> bool {
        self.get_js(key).is_some()
    }

    /// `delete o[key]`.
    pub fn remove(&mut self, key: &str) -> Option<V> {
        let at = self.members.iter().position(|(k, _)| k.is(key))?;
        if at < self.indexed {
            self.indexed -= 1;
        }
        Some(self.members.remove(at).1)
    }

    /// `Object.entries(o)`.
    pub fn entries(&self) -> &[(JsStr, V)] {
        &self.members
    }

    /// `Object.keys(o).length`.
    pub fn len(&self) -> usize {
        self.members.len()
    }

    /// No own property.
    pub fn is_empty(&self) -> bool {
        self.members.is_empty()
    }
}

/// A JSON value as JavaScript holds it.
#[derive(Clone, Debug)]
pub enum V {
    /// `null`.
    Null,
    /// `true` or `false`.
    Bool(bool),
    /// A number. `JSON.parse` yields `Infinity` for `1e400` and keeps the sign of `-0`.
    Num(f64),
    /// A string.
    Str(JsStr),
    /// An array.
    Arr(Vec<V>),
    /// An object.
    Obj(Obj),
}

impl V {
    /// A string value.
    pub fn s(text: &str) -> V {
        V::Str(JsStr::from(text))
    }

    /// An object from members in the given order.
    pub fn obj<const N: usize>(members: [(&str, V); N]) -> V {
        let mut o = Obj::new();
        for (k, v) in members {
            o.set(k, v);
        }
        V::Obj(o)
    }

    /// An array of strings.
    pub fn strs<S: AsRef<str>>(items: &[S]) -> V {
        V::Arr(items.iter().map(|s| V::s(s.as_ref())).collect())
    }

    /// The validator's `typeOf`: `null`, `array`, `object`, `string`, `number` or `boolean`.
    pub fn type_of(&self) -> &'static str {
        match self {
            V::Null => "null",
            V::Bool(_) => "boolean",
            V::Num(_) => "number",
            V::Str(_) => "string",
            V::Arr(_) => "array",
            V::Obj(_) => "object",
        }
    }

    /// The object, when this is one (`object(v)` of `validation.ts`: not `null`, not an array).
    pub fn as_obj(&self) -> Option<&Obj> {
        match self {
            V::Obj(o) => Some(o),
            _ => None,
        }
    }

    /// The array, when this is one.
    pub fn as_arr(&self) -> Option<&[V]> {
        match self {
            V::Arr(a) => Some(a),
            _ => None,
        }
    }

    /// The string, when this is one.
    pub fn as_js(&self) -> Option<&JsStr> {
        match self {
            V::Str(s) => Some(s),
            _ => None,
        }
    }

    /// The number, when this is one.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            V::Num(n) => Some(*n),
            _ => None,
        }
    }

    /// `v === text`.
    pub fn is_str(&self, text: &str) -> bool {
        self.as_js().is_some_and(|s| s.is(text))
    }

    /// The own property `key` of an object; `None` for anything else.
    pub fn get(&self, key: &str) -> Option<&V> {
        self.as_obj().and_then(|o| o.get(key))
    }

    /// JavaScript truthiness (`filter(Boolean)`): everything but `null`, `false`, `0`, `NaN` and `""`.
    pub fn truthy(&self) -> bool {
        match self {
            V::Null => false,
            V::Bool(b) => *b,
            V::Num(n) => *n != 0.0 && !n.is_nan(),
            V::Str(s) => !s.is_empty(),
            V::Arr(_) | V::Obj(_) => true,
        }
    }

    /// `String(v)`, as `Array.prototype.join` converts an element that is not `null`: an array joins its elements with
    /// `,` (a `null` inside is empty), an object is `[object Object]`.
    pub fn to_js_string(&self) -> JsStr {
        match self {
            V::Null => JsStr::from("null"),
            V::Bool(b) => JsStr::from(if *b { "true" } else { "false" }),
            V::Num(n) => JsStr::from(js_number_to_string(*n)),
            V::Str(s) => s.clone(),
            V::Arr(a) => {
                let mut out = JsStr::default();
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push_str(",");
                    }
                    if !matches!(v, V::Null) {
                        out.push(&v.to_js_string());
                    }
                }
                out
            }
            V::Obj(_) => JsStr::from("[object Object]"),
        }
    }

    /// `isDeepStrictEqual(a, b)` of `node:util` for JSON values: numbers by `Object.is` (`-0` is not `0`), arrays by
    /// position, objects by their set of own keys whatever the order.
    pub fn deep_equal(&self, other: &V) -> bool {
        match (self, other) {
            (V::Null, V::Null) => true,
            (V::Bool(a), V::Bool(b)) => a == b,
            (V::Num(a), V::Num(b)) => {
                (a.is_nan() && b.is_nan())
                    || (a == b && a.is_sign_negative() == b.is_sign_negative())
            }
            (V::Str(a), V::Str(b)) => a == b,
            (V::Arr(a), V::Arr(b)) => {
                a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.deep_equal(y))
            }
            (V::Obj(a), V::Obj(b)) => {
                a.len() == b.len()
                    && a.entries()
                        .iter()
                        .all(|(k, x)| b.get_js(k).is_some_and(|y| x.deep_equal(y)))
            }
            _ => false,
        }
    }

    /// `JSON.stringify(v)`: members in enumeration order, numbers as `String(number)`, a number that is not finite as
    /// `null`, a lone surrogate as a lower-case `\udxxx` escape.
    pub fn stringify(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            V::Null => out.push_str("null"),
            V::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            V::Num(n) if n.is_finite() => out.push_str(&js_number_to_string(*n)),
            V::Num(_) => out.push_str("null"),
            V::Str(s) => out.push_str(&json_stringify_units(s.units())),
            V::Arr(a) => {
                out.push('[');
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    v.write(out);
                }
                out.push(']');
            }
            V::Obj(o) => {
                out.push('{');
                for (i, (k, v)) in o.entries().iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&json_stringify_units(k.units()));
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }

    /// A value from `serde_json` (members arrive sorted, so their order is the sorted one unless a key is an index).
    pub fn from_serde(v: &serde_json::Value) -> V {
        match v {
            serde_json::Value::Null => V::Null,
            serde_json::Value::Bool(b) => V::Bool(*b),
            serde_json::Value::Number(n) => V::Num(n.as_f64().unwrap_or(f64::NAN)),
            serde_json::Value::String(s) => V::s(s),
            serde_json::Value::Array(a) => V::Arr(a.iter().map(V::from_serde).collect()),
            serde_json::Value::Object(o) => V::Obj(Obj::from_pairs(
                o.iter()
                    .map(|(k, x)| (JsStr::from(k.as_str()), V::from_serde(x)))
                    .collect(),
            )),
        }
    }
}

/// `JSON.parse` threw a `SyntaxError`. The engine's message is not kept: no caller shows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SyntaxError;

/// What [`parse_units`] read.
#[derive(Clone, Debug)]
pub enum Parsed {
    /// The value.
    Value(V),
    /// A well-formed document nested deeper than [`MAX_PARSE_DEPTH`]; `array` says what its root is (else an object).
    TooDeep {
        /// The root is an array.
        array: bool,
    },
}

enum Frame {
    Arr(Vec<V>),
    Obj(Vec<(JsStr, V)>, JsStr),
}

struct Reader<'a> {
    text: &'a [u16],
    pos: usize,
}

impl Reader<'_> {
    fn peek(&self) -> Option<u16> {
        self.text.get(self.pos).copied()
    }

    /// JSON white space only: tab, line feed, carriage return, space (no BOM, no U+00A0).
    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(0x09 | 0x0a | 0x0d | 0x20)) {
            self.pos += 1;
        }
    }

    fn eat(&mut self, c: u8) -> Result<(), SyntaxError> {
        if self.peek() == Some(u16::from(c)) {
            self.pos += 1;
            Ok(())
        } else {
            Err(SyntaxError)
        }
    }

    fn literal(&mut self, word: &str, value: V) -> Result<V, SyntaxError> {
        for b in word.bytes() {
            self.eat(b)?;
        }
        Ok(value)
    }

    fn string(&mut self) -> Result<JsStr, SyntaxError> {
        self.eat(b'"')?;
        let mut out = Vec::new();
        loop {
            let u = self.peek().ok_or(SyntaxError)?;
            self.pos += 1;
            match u {
                0x22 => return Ok(JsStr(out)),
                0x00..=0x1f => return Err(SyntaxError),
                0x5c => {
                    let e = self.peek().ok_or(SyntaxError)?;
                    self.pos += 1;
                    out.push(match u8::try_from(e).map_err(|_| SyntaxError)? {
                        b'"' => 0x22,
                        b'\\' => 0x5c,
                        b'/' => 0x2f,
                        b'b' => 0x08,
                        b'f' => 0x0c,
                        b'n' => 0x0a,
                        b'r' => 0x0d,
                        b't' => 0x09,
                        b'u' => {
                            let mut n: u16 = 0;
                            for _ in 0..4 {
                                let h = self.peek().ok_or(SyntaxError)?;
                                let d = char::from_u32(u32::from(h))
                                    .and_then(|c| c.to_digit(16))
                                    .ok_or(SyntaxError)?;
                                n = n * 16 + u16::try_from(d).map_err(|_| SyntaxError)?;
                                self.pos += 1;
                            }
                            n
                        }
                        _ => return Err(SyntaxError),
                    });
                }
                other => out.push(other),
            }
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.pos;
        while matches!(self.peek(), Some(0x30..=0x39)) {
            self.pos += 1;
        }
        self.pos - start
    }

    /// `-? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?`, read as the nearest double (overflow is an infinity).
    fn number(&mut self) -> Result<V, SyntaxError> {
        let start = self.pos;
        if self.peek() == Some(0x2d) {
            self.pos += 1;
        }
        if self.peek() == Some(0x30) {
            self.pos += 1;
        } else if self.digits() == 0 {
            return Err(SyntaxError);
        }
        if self.peek() == Some(0x2e) {
            self.pos += 1;
            if self.digits() == 0 {
                return Err(SyntaxError);
            }
        }
        if matches!(self.peek(), Some(0x45 | 0x65)) {
            self.pos += 1;
            if matches!(self.peek(), Some(0x2b | 0x2d)) {
                self.pos += 1;
            }
            if self.digits() == 0 {
                return Err(SyntaxError);
            }
        }
        let ascii: String = self.text[start..self.pos]
            .iter()
            .map(|u| char::from(u8::try_from(*u).unwrap_or(b'?')))
            .collect();
        ascii.parse::<f64>().map(V::Num).map_err(|_| SyntaxError)
    }
}

/// `JSON.parse(text)` over code units. Duplicate keys keep the last value, `__proto__` is an own property, a lone
/// surrogate is kept whether written raw or as an escape, and nothing but the four JSON white-space characters may
/// surround a token.
pub fn parse_units(text: &[u16]) -> Result<Parsed, SyntaxError> {
    let mut r = Reader { text, pos: 0 };
    let mut stack: Vec<Frame> = Vec::new();
    let mut too_deep = false;
    let mut root_array = false;
    loop {
        // A value is expected here.
        r.skip_ws();
        let mut value = match r.peek().ok_or(SyntaxError)? {
            0x5b => {
                r.pos += 1;
                if stack.is_empty() {
                    root_array = true;
                }
                stack.push(Frame::Arr(Vec::new()));
                too_deep |= stack.len() > MAX_PARSE_DEPTH;
                r.skip_ws();
                if r.peek() != Some(0x5d) {
                    continue;
                }
                r.pos += 1;
                close(&mut stack, too_deep)
            }
            0x7b => {
                r.pos += 1;
                stack.push(Frame::Obj(Vec::new(), JsStr::default()));
                too_deep |= stack.len() > MAX_PARSE_DEPTH;
                r.skip_ws();
                if r.peek() != Some(0x7d) {
                    key(&mut r, &mut stack)?;
                    continue;
                }
                r.pos += 1;
                close(&mut stack, too_deep)
            }
            0x22 => V::Str(r.string()?),
            0x74 => r.literal("true", V::Bool(true))?,
            0x66 => r.literal("false", V::Bool(false))?,
            0x6e => r.literal("null", V::Null)?,
            _ => r.number()?,
        };
        // A value is complete: hand it to its container, and close every container that ends here.
        loop {
            r.skip_ws();
            match stack.last_mut() {
                None => {
                    if r.pos != text.len() {
                        return Err(SyntaxError);
                    }
                    return Ok(if too_deep {
                        Parsed::TooDeep { array: root_array }
                    } else {
                        Parsed::Value(value)
                    });
                }
                Some(Frame::Arr(items)) => {
                    if !too_deep {
                        items.push(value);
                    }
                    match r.peek() {
                        Some(0x2c) => {
                            r.pos += 1;
                            break;
                        }
                        Some(0x5d) => {
                            r.pos += 1;
                            value = close(&mut stack, too_deep);
                        }
                        _ => return Err(SyntaxError),
                    }
                }
                Some(Frame::Obj(members, pending)) => {
                    if !too_deep {
                        members.push((std::mem::take(pending), value));
                    }
                    match r.peek() {
                        Some(0x2c) => {
                            r.pos += 1;
                            r.skip_ws();
                            key(&mut r, &mut stack)?;
                            break;
                        }
                        Some(0x7d) => {
                            r.pos += 1;
                            value = close(&mut stack, too_deep);
                        }
                        _ => return Err(SyntaxError),
                    }
                }
            }
        }
    }
}

/// Reads `"key" :` into the open object on top of the stack.
fn key(r: &mut Reader<'_>, stack: &mut [Frame]) -> Result<(), SyntaxError> {
    let name = r.string()?;
    r.skip_ws();
    r.eat(b':')?;
    if let Some(Frame::Obj(_, pending)) = stack.last_mut() {
        *pending = name;
    }
    Ok(())
}

/// Pops the container that just ended. Once the document is known to be too deep nothing is nested any more.
fn close(stack: &mut Vec<Frame>, too_deep: bool) -> V {
    match stack.pop() {
        _ if too_deep => V::Null,
        Some(Frame::Arr(items)) => V::Arr(items),
        Some(Frame::Obj(members, _)) => V::Obj(Obj::from_pairs(members)),
        None => V::Null,
    }
}

/// `JSON.parse(text)` for a Rust string; `None` where it throws or the document is deeper than [`MAX_PARSE_DEPTH`].
pub fn parse(text: &str) -> Option<V> {
    let units: Vec<u16> = text.encode_utf16().collect();
    match parse_units(&units) {
        Ok(Parsed::Value(v)) => Some(v),
        _ => None,
    }
}

/// The number a string spells when all of it is one JSON number literal
/// (`/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/`, then `Number(text)`); `None` for any other string.
pub fn number_literal(text: &[u16]) -> Option<f64> {
    let mut r = Reader { text, pos: 0 };
    let n = r.number().ok()?.as_f64()?;
    (r.pos == text.len()).then_some(n)
}
