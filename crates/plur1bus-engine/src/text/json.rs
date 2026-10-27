//! Tolerant JSON and JSONL reader and writer (`RE-04/T0`, `RE-D17`).
//!
//! Node `JSON.stringify` emits unpaired UTF-16 surrogates produced by `.slice(0, n)` cuts inside
//! surrogate pairs as `\ud800`..`\udfff` escapes. Standard RFC 8259 parsers such as `serde_json`
//! reject lone surrogate escapes; this module parses them into [`JsString`] and re-emits them
//! byte-identically.

use std::fmt;

use crate::text::js::JsString;

/// A JSON value whose strings and object keys are stored as UTF-16 [`JsString`] values so that
/// lone surrogates survive a read-modify-write cycle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TolerantJsonValue {
    /// JSON `null`.
    Null,
    /// JSON boolean (`true` or `false`).
    Bool(bool),
    /// JSON number stored in its canonical lexical form.
    Number(String),
    /// JSON string stored as UTF-16 code units (supporting lone surrogates).
    String(JsString),
    /// JSON array.
    Array(Vec<TolerantJsonValue>),
    /// JSON object preserving insertion order of properties.
    Object(Vec<(JsString, TolerantJsonValue)>),
}

/// Error returned when parsing tolerant JSON fails.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TolerantJsonError {
    /// Byte offset in the input where parsing failed.
    pub offset: usize,
    /// Human-readable description of the syntax error.
    pub message: String,
}

impl fmt::Display for TolerantJsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "tolerant JSON parse error at byte {}: {}",
            self.offset, self.message
        )
    }
}

impl std::error::Error for TolerantJsonError {}

struct Parser<'a> {
    input: &'a str,
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    const fn new(input: &'a str) -> Self {
        Self {
            input,
            bytes: input.as_bytes(),
            pos: 0,
        }
    }

    fn err<T>(&self, message: impl Into<String>) -> Result<T, TolerantJsonError> {
        Err(TolerantJsonError {
            offset: self.pos,
            message: message.into(),
        })
    }

    fn skip_ws(&mut self) {
        while let Some(&b) = self.bytes.get(self.pos) {
            if matches!(b, b' ' | b'\t' | b'\n' | b'\r') {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn parse_value(&mut self) -> Result<TolerantJsonValue, TolerantJsonError> {
        self.skip_ws();
        let Some(b) = self.peek() else {
            return self.err("unexpected end of JSON input");
        };
        match b {
            b'n' => self.parse_null(),
            b't' => self.parse_true(),
            b'f' => self.parse_false(),
            b'"' => self.parse_string().map(TolerantJsonValue::String),
            b'[' => self.parse_array(),
            b'{' => self.parse_object(),
            b'-' | b'0'..=b'9' => self.parse_number(),
            _ => self.err(format!("unexpected byte 0x{b:02x}")),
        }
    }

    fn parse_null(&mut self) -> Result<TolerantJsonValue, TolerantJsonError> {
        if self.bytes.get(self.pos..self.pos + 4) == Some(b"null") {
            self.pos += 4;
            Ok(TolerantJsonValue::Null)
        } else {
            self.err("expected 'null'")
        }
    }

    fn parse_true(&mut self) -> Result<TolerantJsonValue, TolerantJsonError> {
        if self.bytes.get(self.pos..self.pos + 4) == Some(b"true") {
            self.pos += 4;
            Ok(TolerantJsonValue::Bool(true))
        } else {
            self.err("expected 'true'")
        }
    }

    fn parse_false(&mut self) -> Result<TolerantJsonValue, TolerantJsonError> {
        if self.bytes.get(self.pos..self.pos + 5) == Some(b"false") {
            self.pos += 5;
            Ok(TolerantJsonValue::Bool(false))
        } else {
            self.err("expected 'false'")
        }
    }

    fn parse_number(&mut self) -> Result<TolerantJsonValue, TolerantJsonError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => {
                self.pos += 1;
            }
            Some(b'1'..=b'9') => {
                self.pos += 1;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.pos += 1;
                }
            }
            _ => return self.err("invalid number literal"),
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return self.err("expected digit after decimal point");
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return self.err("expected digit in exponent");
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        let slice = self
            .input
            .get(start..self.pos)
            .ok_or_else(|| TolerantJsonError {
                offset: start,
                message: "invalid UTF-8 boundary in number".to_owned(),
            })?;
        Ok(TolerantJsonValue::Number(slice.to_owned()))
    }

    fn parse_hex4(&mut self) -> Result<u16, TolerantJsonError> {
        let Some(hex_bytes) = self.bytes.get(self.pos..self.pos + 4) else {
            return self.err("incomplete \\uXXXX escape");
        };
        let mut val: u16 = 0;
        for &b in hex_bytes {
            let digit = match b {
                b'0'..=b'9' => u16::from(b - b'0'),
                b'a'..=b'f' => u16::from(b - b'a' + 10),
                b'A'..=b'F' => u16::from(b - b'A' + 10),
                _ => return self.err("invalid hex digit in \\uXXXX escape"),
            };
            val = (val << 4) | digit;
        }
        self.pos += 4;
        Ok(val)
    }

    fn parse_string(&mut self) -> Result<JsString, TolerantJsonError> {
        if self.peek() != Some(b'"') {
            return self.err("expected '\"' at start of string");
        }
        self.pos += 1;
        let mut units: Vec<u16> = Vec::new();

        while let Some(b) = self.peek() {
            match b {
                b'"' => {
                    self.pos += 1;
                    return Ok(JsString::from_utf16_units(units));
                }
                b'\\' => {
                    self.pos += 1;
                    let Some(esc) = self.peek() else {
                        return self.err("unterminated escape sequence in string");
                    };
                    self.pos += 1;
                    match esc {
                        b'"' => units.push(u16::from(b'"')),
                        b'\\' => units.push(u16::from(b'\\')),
                        b'/' => units.push(u16::from(b'/')),
                        b'b' => units.push(0x0008),
                        b'f' => units.push(0x000C),
                        b'n' => units.push(0x000A),
                        b'r' => units.push(0x000D),
                        b't' => units.push(0x0009),
                        b'u' => {
                            let code_unit = self.parse_hex4()?;
                            units.push(code_unit);
                        }
                        _ => return self.err(format!("invalid JSON escape: \\{}", esc as char)),
                    }
                }
                0x00..=0x1F => {
                    return self.err("unescaped control character in JSON string");
                }
                _ => {
                    let tail = self
                        .input
                        .get(self.pos..)
                        .ok_or_else(|| TolerantJsonError {
                            offset: self.pos,
                            message: "invalid UTF-8 boundary in string".to_owned(),
                        })?;
                    let Some(ch) = tail.chars().next() else {
                        return self.err("unexpected end of string");
                    };
                    let mut buf = [0u16; 2];
                    let encoded = ch.encode_utf16(&mut buf);
                    units.extend_from_slice(encoded);
                    self.pos += ch.len_utf8();
                }
            }
        }

        self.err("unterminated JSON string")
    }

    fn parse_array(&mut self) -> Result<TolerantJsonValue, TolerantJsonError> {
        self.pos += 1; // '['
        self.skip_ws();
        let mut items = Vec::new();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(TolerantJsonValue::Array(items));
        }
        loop {
            let item = self.parse_value()?;
            items.push(item);
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b']') => {
                    self.pos += 1;
                    return Ok(TolerantJsonValue::Array(items));
                }
                _ => return self.err("expected ',' or ']' in array"),
            }
        }
    }

    fn parse_object(&mut self) -> Result<TolerantJsonValue, TolerantJsonError> {
        self.pos += 1; // '{'
        self.skip_ws();
        let mut entries = Vec::new();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(TolerantJsonValue::Object(entries));
        }
        loop {
            self.skip_ws();
            let key = self.parse_string()?;
            self.skip_ws();
            if self.peek() != Some(b':') {
                return self.err("expected ':' after object key");
            }
            self.pos += 1;
            let val = self.parse_value()?;
            entries.push((key, val));
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(TolerantJsonValue::Object(entries));
                }
                _ => return self.err("expected ',' or '}' in object"),
            }
        }
    }
}

/// Parses a JSON document or JSONL line that may contain lone UTF-16 surrogate escapes
/// (`\ud800`..`\udfff`) in strings.
///
/// # Errors
///
/// Returns [`TolerantJsonError`] if the input is not syntactically valid JSON.
pub fn parse_json(input: &str) -> Result<TolerantJsonValue, TolerantJsonError> {
    let mut parser = Parser::new(input);
    let value = parser.parse_value()?;
    parser.skip_ws();
    if parser.pos != parser.bytes.len() {
        return parser.err("trailing characters after JSON value");
    }
    Ok(value)
}

/// Parses a standalone JSON string literal (including its surrounding quotes) that may contain
/// lone UTF-16 surrogate escapes into a [`JsString`].
///
/// # Errors
///
/// Returns [`TolerantJsonError`] if the input is not a valid JSON string literal.
pub fn parse_json_str(input: &str) -> Result<JsString, TolerantJsonError> {
    let mut parser = Parser::new(input);
    parser.skip_ws();
    let s = parser.parse_string()?;
    parser.skip_ws();
    if parser.pos != parser.bytes.len() {
        return parser.err("trailing characters after JSON string");
    }
    Ok(s)
}

fn write_value_into(value: &TolerantJsonValue, out: &mut String) {
    match value {
        TolerantJsonValue::Null => out.push_str("null"),
        TolerantJsonValue::Bool(true) => out.push_str("true"),
        TolerantJsonValue::Bool(false) => out.push_str("false"),
        TolerantJsonValue::Number(num) => out.push_str(num),
        TolerantJsonValue::String(s) => out.push_str(&s.to_json()),
        TolerantJsonValue::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value_into(item, out);
            }
            out.push(']');
        }
        TolerantJsonValue::Object(entries) => {
            out.push('{');
            for (i, (k, v)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&k.to_json());
                out.push(':');
                write_value_into(v, out);
            }
            out.push('}');
        }
    }
}

/// Serializes a [`TolerantJsonValue`] to compact JSON matching `JSON.stringify`, emitting any
/// lone UTF-16 surrogates as `\ud800`..`\udfff` escapes.
#[must_use]
pub fn write_json(value: &TolerantJsonValue) -> String {
    let mut out = String::new();
    write_value_into(value, &mut out);
    out
}

/// Serializes a [`JsString`] as a JSON string literal matching `JSON.stringify`.
#[must_use]
pub fn write_json_str(value: &JsString) -> String {
    value.to_json()
}
