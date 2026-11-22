//! JSON the way the ACP server sees it: what `JSON.parse` reads off a line and what `JSON.stringify` writes back.
//!
//! The ACP line is a boundary to a foreign process, so this reader is built for hostile input and not for convenience:
//!
//! - it is **iterative** (an explicit stack), so a line of a million `[` neither overflows the stack nor is refused where
//!   `JSON.parse` accepts it; the memory it takes is bounded by the line, which the framing bounds;
//! - [`V`] drops iteratively for the same reason;
//! - the grammar is JSON's and nothing else (`+1`, `.5`, `01`, `NaN`, trailing commas, comments and raw control characters in a
//!   string are all refused, as `JSON.parse` refuses them); a number is a double and reads as `Number(text)` does (`1e400` is
//!   `Infinity`, `-0` is `-0`);
//! - a repeated key keeps its first position and its last value, as in JavaScript; a key such as `__proto__` is a plain member;
//! - a lone surrogate escape (`"\ud800"`) cannot live in a Rust `String` and reads as U+FFFD (known divergence K8-D2).
//!
//! Output follows `JSON.stringify`: members in JavaScript's enumeration order (array-index keys first, ascending, then the others
//! as inserted), numbers as `String(number)` (a non-finite number is `null`), strings as `JSON.stringify` escapes them.
use crate::js::array_index;
use crate::metrics::registry::js_number_to_string;
use std::collections::HashMap;
use std::io::{self, Write};

/// A parsed or built JSON value.
pub enum V {
    /// `null`.
    Null,
    /// `true` or `false`.
    Bool(bool),
    /// A number (a double, as in JavaScript).
    Num(f64),
    /// A string.
    Str(String),
    /// An array.
    Arr(Vec<V>),
    /// An object, members in insertion order.
    Obj(Vec<(String, V)>),
}

impl Drop for V {
    fn drop(&mut self) {
        let mut stack: Vec<V> = match self {
            V::Arr(a) if !a.is_empty() => std::mem::take(a),
            V::Obj(m) if !m.is_empty() => std::mem::take(m).into_iter().map(|(_, v)| v).collect(),
            _ => return,
        };
        while let Some(mut v) = stack.pop() {
            match &mut v {
                V::Arr(a) => stack.append(a),
                V::Obj(m) => stack.extend(std::mem::take(m).into_iter().map(|(_, v)| v)),
                _ => {}
            }
        }
    }
}

impl std::fmt::Debug for V {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            V::Null => f.write_str("Null"),
            V::Bool(b) => f.debug_tuple("Bool").field(b).finish(),
            V::Num(n) => f.debug_tuple("Num").field(n).finish(),
            V::Str(s) => f.debug_tuple("Str").field(s).finish(),
            V::Arr(a) => f.debug_struct("Arr").field("len", &a.len()).finish(),
            V::Obj(m) => f.debug_struct("Obj").field("len", &m.len()).finish(),
        }
    }
}

impl PartialEq for V {
    fn eq(&self, other: &Self) -> bool {
        let mut pairs = vec![(self, other)];
        while let Some((left, right)) = pairs.pop() {
            match (left, right) {
                (V::Null, V::Null) => {}
                (V::Bool(a), V::Bool(b)) if a == b => {}
                (V::Num(a), V::Num(b)) if a == b => {}
                (V::Str(a), V::Str(b)) if a == b => {}
                (V::Arr(a), V::Arr(b)) if a.len() == b.len() => pairs.extend(a.iter().zip(b)),
                (V::Obj(a), V::Obj(b)) if a.len() == b.len() => {
                    for ((ak, av), (bk, bv)) in a.iter().zip(b) {
                        if ak != bk {
                            return false;
                        }
                        pairs.push((av, bv));
                    }
                }
                _ => return false,
            }
        }
        true
    }
}

impl Clone for V {
    fn clone(&self) -> V {
        enum Task<'a> {
            Copy(&'a V),
            Array(usize),
            Object(&'a [(String, V)]),
        }
        let mut pending = vec![Task::Copy(self)];
        let mut copies = Vec::new();
        while let Some(task) = pending.pop() {
            let copy = match task {
                Task::Copy(V::Null) => V::Null,
                Task::Copy(V::Bool(b)) => V::Bool(*b),
                Task::Copy(V::Num(n)) => V::Num(*n),
                Task::Copy(V::Str(s)) => V::Str(s.clone()),
                Task::Copy(V::Arr(elements)) => {
                    pending.push(Task::Array(elements.len()));
                    pending.extend(elements.iter().rev().map(Task::Copy));
                    continue;
                }
                Task::Copy(V::Obj(members)) => {
                    pending.push(Task::Object(members));
                    pending.extend(members.iter().rev().map(|(_, v)| Task::Copy(v)));
                    continue;
                }
                Task::Array(len) => V::Arr(copies.split_off(copies.len() - len)),
                Task::Object(members) => {
                    let children = copies.drain(copies.len() - members.len()..);
                    V::Obj(
                        members
                            .iter()
                            .map(|(k, _)| k.clone())
                            .zip(children)
                            .collect(),
                    )
                }
            };
            copies.push(copy);
        }
        copies.pop().expect("one root value")
    }
}

impl V {
    /// A string value.
    pub fn s(v: &str) -> V {
        V::Str(v.to_owned())
    }

    /// A number value.
    pub fn n(v: f64) -> V {
        V::Num(v)
    }

    /// An object from members in the given order (a repeated key keeps its first place and its last value).
    pub fn obj<const N: usize>(members: [(&str, V); N]) -> V {
        let mut out = V::Obj(Vec::with_capacity(N));
        for (k, v) in members {
            out.set(k, v);
        }
        out
    }

    /// `o[key] = value` on an object (no effect on anything else).
    pub fn set(&mut self, key: &str, value: V) {
        if let V::Obj(m) = self {
            match m.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => slot.1 = value,
                None => m.push((key.to_owned(), value)),
            }
        }
    }

    /// `o[key]` of an object (own members only); `None` for a missing member or a value that is not an object.
    pub fn get(&self, key: &str) -> Option<&V> {
        match self {
            V::Obj(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// `key in o` for an object (an own member, even when its value is `null`).
    pub fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// `typeof v === "object" && v !== null && !Array.isArray(v)`.
    pub fn is_obj(&self) -> bool {
        matches!(self, V::Obj(_))
    }

    /// The string, when this is one.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            V::Str(s) => Some(s),
            _ => None,
        }
    }

    /// The elements, when this is an array.
    pub fn as_arr(&self) -> Option<&[V]> {
        match self {
            V::Arr(a) => Some(a),
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

    /// `JSON.stringify(v)`; `None` where it would throw here (nesting beyond what this writer follows).
    pub fn stringify(&self) -> Option<String> {
        self.stringify_bounded(usize::MAX)
    }

    /// Encode a complete JSON value within a UTF-8 byte limit, with no partial frame returned.
    pub(super) fn stringify_bounded(&self, max: usize) -> Option<String> {
        let mut out = JsonBytes {
            bytes: Vec::new(),
            max,
        };
        self.write_json(&mut out).ok()?;
        String::from_utf8(out.bytes).ok()
    }

    fn write_json(&self, out: &mut JsonBytes) -> io::Result<()> {
        enum Container<'a> {
            Array(std::iter::Enumerate<std::slice::Iter<'a, V>>),
            Object(std::iter::Enumerate<Box<dyn Iterator<Item = &'a (String, V)> + 'a>>),
        }
        let mut stack = Vec::new();
        let mut value = self;
        'value: loop {
            if stack.len() > MAX_WRITE_DEPTH {
                return Err(io::Error::other("JSON depth limit"));
            }
            match value {
                V::Null => out.write_all(b"null")?,
                V::Bool(b) => out.write_all(if *b { b"true" } else { b"false" })?,
                V::Num(n) if n.is_finite() => out.write_all(js_number_to_string(*n).as_bytes())?,
                V::Num(_) => out.write_all(b"null")?,
                V::Str(s) => serde_json::to_writer(&mut *out, s)?,
                V::Arr(a) => {
                    out.write_all(b"[")?;
                    stack.push(Container::Array(a.iter().enumerate()));
                }
                V::Obj(m) => {
                    if m.len() > out.remaining() / 4 {
                        return Err(io::Error::other("JSON byte limit"));
                    }
                    out.write_all(b"{")?;
                    let mut indexed: Vec<_> = m
                        .iter()
                        .filter_map(|e| array_index(&e.0).map(|i| (i, e)))
                        .collect();
                    indexed.sort_by_key(|(i, _)| *i);
                    let ordered: Box<dyn Iterator<Item = &_>> = Box::new(
                        indexed
                            .into_iter()
                            .map(|(_, e)| e)
                            .chain(m.iter().filter(|e| array_index(&e.0).is_none())),
                    );
                    stack.push(Container::Object(ordered.enumerate()));
                }
            }
            while let Some(frame) = stack.last_mut() {
                match frame {
                    Container::Array(elements) => {
                        if let Some((index, child)) = elements.next() {
                            if index > 0 {
                                out.write_all(b",")?;
                            }
                            value = child;
                            continue 'value;
                        }
                        out.write_all(b"]")?;
                    }
                    Container::Object(members) => {
                        if let Some((index, (key, child))) = members.next() {
                            if index > 0 {
                                out.write_all(b",")?;
                            }
                            serde_json::to_writer(&mut *out, key)?;
                            out.write_all(b":")?;
                            value = child;
                            continue 'value;
                        }
                        out.write_all(b"}")?;
                    }
                }
                stack.pop();
            }
            return Ok(());
        }
    }
}

struct JsonBytes {
    bytes: Vec<u8>,
    max: usize,
}

impl JsonBytes {
    fn remaining(&self) -> usize {
        self.max - self.bytes.len()
    }
}

impl Write for JsonBytes {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.remaining() {
            return Err(io::Error::other("JSON byte limit"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// How deep [`V::stringify`] follows before it gives up, where `JSON.stringify` would run out of stack (a `RangeError`, which
/// every caller treats like any other failure to serialise).
const MAX_WRITE_DEPTH: usize = 2000;

enum Frame {
    Arr(Vec<V>),
    Obj(Vec<(String, V)>, Option<String>),
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl Reader<'_> {
    fn ws(&mut self) {
        while matches!(self.b.get(self.i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn eat(&mut self, c: u8) -> bool {
        if self.b.get(self.i) == Some(&c) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn hex4(&mut self) -> Option<u32> {
        let s = self.b.get(self.i..self.i + 4)?;
        let mut v = 0u32;
        for c in s {
            v = v * 16 + (*c as char).to_digit(16)?;
        }
        self.i += 4;
        Some(v)
    }

    /// A string; the opening quote is at `i`.
    fn string(&mut self) -> Option<String> {
        if !self.eat(b'"') {
            return None;
        }
        let mut out = String::new();
        loop {
            let start = self.i;
            while let Some(c) = self.b.get(self.i) {
                if *c == b'"' || *c == b'\\' || *c < 0x20 {
                    break;
                }
                self.i += 1;
            }
            out.push_str(std::str::from_utf8(&self.b[start..self.i]).ok()?);
            match *self.b.get(self.i)? {
                b'"' => {
                    self.i += 1;
                    return Some(out);
                }
                b'\\' => {
                    self.i += 1;
                    let e = *self.b.get(self.i)?;
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            if (0xd800..0xdc00).contains(&hi)
                                && self.b.get(self.i) == Some(&b'\\')
                                && self.b.get(self.i + 1) == Some(&b'u')
                            {
                                let save = self.i;
                                self.i += 2;
                                match self.hex4() {
                                    Some(lo) if (0xdc00..0xe000).contains(&lo) => {
                                        let c = 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00);
                                        out.push(char::from_u32(c).unwrap_or('\u{fffd}'));
                                    }
                                    _ => {
                                        // The high half stands alone; the next escape is read again on its own.
                                        self.i = save;
                                        out.push('\u{fffd}');
                                    }
                                }
                            } else {
                                out.push(char::from_u32(hi).unwrap_or('\u{fffd}'));
                            }
                        }
                        _ => return None,
                    }
                }
                _ => return None, // a raw control character
            }
        }
    }

    fn number(&mut self) -> Option<f64> {
        let start = self.i;
        self.eat(b'-');
        match self.b.get(self.i)? {
            b'0' => self.i += 1,
            b'1'..=b'9' => {
                while self.b.get(self.i).is_some_and(u8::is_ascii_digit) {
                    self.i += 1;
                }
            }
            _ => return None,
        }
        if self.eat(b'.') {
            let d = self.i;
            while self.b.get(self.i).is_some_and(u8::is_ascii_digit) {
                self.i += 1;
            }
            if self.i == d {
                return None;
            }
        }
        if matches!(self.b.get(self.i), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.b.get(self.i), Some(b'+' | b'-')) {
                self.i += 1;
            }
            let d = self.i;
            while self.b.get(self.i).is_some_and(u8::is_ascii_digit) {
                self.i += 1;
            }
            if self.i == d {
                return None;
            }
        }
        std::str::from_utf8(&self.b[start..self.i])
            .ok()?
            .parse::<f64>()
            .ok()
    }

    fn literal(&mut self, word: &[u8]) -> bool {
        if self.b.get(self.i..self.i + word.len()) == Some(word) {
            self.i += word.len();
            true
        } else {
            false
        }
    }
}

/// An object's members with a repeated key folded the JavaScript way (first place, last value), in linear time.
fn fold_members(raw: Vec<(String, V)>) -> Vec<(String, V)> {
    if raw.len() < 2 {
        return raw;
    }
    let mut at: HashMap<String, usize> = HashMap::with_capacity(raw.len());
    let mut out: Vec<(String, V)> = Vec::with_capacity(raw.len());
    for (k, v) in raw {
        match at.get(&k) {
            Some(i) => out[*i].1 = v,
            None => {
                at.insert(k.clone(), out.len());
                out.push((k, v));
            }
        }
    }
    out
}

/// `JSON.parse(text)`, or `None` where it throws.
pub fn parse(text: &str) -> Option<V> {
    let mut r = Reader {
        b: text.as_bytes(),
        i: 0,
    };
    let mut stack: Vec<Frame> = Vec::new();
    'value: loop {
        r.ws();
        let mut v = match *r.b.get(r.i)? {
            b'{' => {
                r.i += 1;
                r.ws();
                if r.eat(b'}') {
                    V::Obj(Vec::new())
                } else {
                    let key = r.string()?;
                    r.ws();
                    if !r.eat(b':') {
                        return None;
                    }
                    stack.push(Frame::Obj(Vec::new(), Some(key)));
                    continue 'value;
                }
            }
            b'[' => {
                r.i += 1;
                r.ws();
                if r.eat(b']') {
                    V::Arr(Vec::new())
                } else {
                    stack.push(Frame::Arr(Vec::new()));
                    continue 'value;
                }
            }
            b'"' => V::Str(r.string()?),
            b't' if r.literal(b"true") => V::Bool(true),
            b'f' if r.literal(b"false") => V::Bool(false),
            b'n' if r.literal(b"null") => V::Null,
            b'-' | b'0'..=b'9' => V::Num(r.number()?),
            _ => return None,
        };
        // A value is complete: hand it to its container, closing containers as far as their closing bracket follows.
        loop {
            match stack.last_mut() {
                None => {
                    r.ws();
                    return (r.i == r.b.len()).then_some(v);
                }
                Some(Frame::Arr(items)) => {
                    items.push(v);
                    r.ws();
                    if r.eat(b',') {
                        continue 'value;
                    }
                    if !r.eat(b']') {
                        return None;
                    }
                    let Some(Frame::Arr(done)) = stack.pop() else {
                        return None;
                    };
                    v = V::Arr(done);
                }
                Some(Frame::Obj(members, key)) => {
                    members.push((key.take()?, v));
                    r.ws();
                    if r.eat(b',') {
                        r.ws();
                        let next = r.string()?;
                        r.ws();
                        if !r.eat(b':') {
                            return None;
                        }
                        *key = Some(next);
                        continue 'value;
                    }
                    if !r.eat(b'}') {
                        return None;
                    }
                    let Some(Frame::Obj(done, _)) = stack.pop() else {
                        return None;
                    };
                    v = V::Obj(fold_members(done));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_like_json_parse() {
        for ok in [
            "{}",
            "[]",
            " [1, 2 ,3]\n",
            "{\"a\":{\"b\":[null,true,false,-0,1e2,0.5E-1]}}",
            "\"\\u00e9\\ud83d\\ude00\"",
        ] {
            assert!(parse(ok).is_some(), "{ok}");
        }
        for bad in [
            "",
            "{",
            "[1,]",
            "{\"a\":1,}",
            "+1",
            ".5",
            "01",
            "1.",
            "1e",
            "NaN",
            "'a'",
            "{a:1}",
            "[1] x",
            "\"a\nb\"",
            "\"\\x\"",
            "\u{feff}{}",
            "[1 2]",
            "{\"a\" 1}",
            "tru",
            "nul",
            "-",
            "--1",
            "\"\\u12\"",
            "{\"a\":1 \"b\":2}",
        ] {
            assert!(parse(bad).is_none(), "{bad:?}");
        }
        assert_eq!(parse("1e400").and_then(|v| v.as_f64()), Some(f64::INFINITY));
        assert_eq!(
            parse("{\"a\":1,\"b\":2,\"a\":3}")
                .unwrap()
                .stringify()
                .unwrap(),
            r#"{"a":3,"b":2}"#
        );
        assert_eq!(parse("\"\\ud800\"").unwrap(), V::s("\u{fffd}"));
        assert_eq!(parse("\"\\ud800\\u0041\"").unwrap(), V::s("\u{fffd}A"));
    }

    #[test]
    fn deep_nesting_neither_overflows_nor_is_refused() {
        let n = 600_000;
        let text = format!("{}{}", "[".repeat(n), "]".repeat(n));
        let v = parse(&text).unwrap();
        assert_eq!(
            v.stringify(),
            None,
            "the writer gives up long before the stack does"
        );
        drop(v);
        assert!(parse(&"[".repeat(n)).is_none());
    }

    #[test]
    fn nested_roundtrip_at_the_output_boundary() {
        let prefix = r#"{"value":["#.repeat(MAX_WRITE_DEPTH / 2);
        let suffix = "]}".repeat(MAX_WRITE_DEPTH / 2);
        let text = format!("{prefix}true{suffix}");
        let value = parse(&text).unwrap();
        let copy = value.clone();
        assert_eq!(value, copy);
        assert_ne!(copy, parse(&format!("{prefix}false{suffix}")).unwrap());
        assert_eq!(
            copy.stringify_bounded(text.len()).as_deref(),
            Some(text.as_str())
        );
        assert_eq!(copy.stringify_bounded(text.len() - 1), None);
    }

    #[test]
    fn stringify_follows_javascript() {
        let v =
            parse(r#"{"b":1,"2":true,"a":[null,"x\u0001"],"1":-0.5,"01":2e21,"z":-0,"w":1e400}"#)
                .unwrap();
        assert_eq!(
            v.stringify().unwrap(),
            r#"{"1":-0.5,"2":true,"b":1,"a":[null,"x\u0001"],"01":2e+21,"z":0,"w":null}"#
        );
    }

    #[test]
    fn many_members_fold_in_linear_time() {
        let mut text = String::from("{");
        for i in 0..100_000 {
            text.push_str(&format!("\"k{}\":1,", i % 50_000));
        }
        text.push_str("\"x\":0}");
        let v = parse(&text).unwrap();
        assert!(matches!(&v, V::Obj(m) if m.len() == 50_001));
    }
}
