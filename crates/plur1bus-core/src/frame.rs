//! NDJSON framing and the JSON-RPC error frames of the front door, matching module-api's `framing.ts` and `RpcError`:
//! one UTF-8 JSON value per line, at most [`MAX_LINE`] bytes (4 MiB) before the newline, and the error shape
//! `{ jsonrpc, id, error: { code, message, data: { error, reason?, detail? } } }` with the JSON-RPC codes of
//! `packages/core/src/rpc/errors.ts` (`-32602` for `E_INVALID_PARAMS`, `-32000` for every other harness code unless the
//! error names its own).
use serde_json::{json, Map, Value};
use std::io::{self, BufRead};

/// The longest line accepted, without its newline (`MAX_LINE_BYTES`).
pub const MAX_LINE: usize = 4 * 1024 * 1024;
/// A client whose queued replies exceed this is disconnected (`MAX_PENDING_BYTES`, ADR-012 §3).
pub const MAX_PENDING_BYTES: usize = 16 * 1024 * 1024;

/// One line read from a stream.
#[derive(Debug, PartialEq, Eq)]
pub enum Line {
    /// A complete line, without its newline; never empty.
    Data(Vec<u8>),
    /// More than [`MAX_LINE`] bytes without a newline: the stream is out of sync and must be closed.
    TooLong(usize),
    /// End of the stream (a partial last line is dropped, as `LineDecoder` keeps it unparsed).
    Eof,
}

/// Reads the next non-empty line, at most [`MAX_LINE`] bytes plus its newline.
pub fn read_line(reader: &mut impl BufRead) -> io::Result<Line> {
    loop {
        let mut bytes = Vec::new();
        let n = io::Read::take(&mut *reader, MAX_LINE as u64 + 1).read_until(b'\n', &mut bytes)?;
        if n == 0 {
            return Ok(Line::Eof);
        }
        if bytes.last() == Some(&b'\n') {
            bytes.pop();
            if bytes.is_empty() {
                continue;
            }
            return Ok(Line::Data(bytes));
        }
        if bytes.len() > MAX_LINE {
            return Ok(Line::TooLong(bytes.len()));
        }
        return Ok(Line::Eof);
    }
}

/// `encodeLine`: the value as one line with its newline.
pub fn encode(value: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(value).unwrap_or_else(|_| b"null".to_vec());
    bytes.push(b'\n');
    bytes
}

/// A harness error to send as a JSON-RPC error.
#[derive(Clone, Debug, PartialEq)]
pub struct RpcErr {
    /// `$defs/ErrorCode`.
    pub code: &'static str,
    /// Free text (not contract, ADR-016).
    pub message: String,
    /// `data.reason`.
    pub reason: Option<String>,
    /// `data.detail`.
    pub detail: Option<String>,
    /// The JSON-RPC `code`, when it is not the default of `code`.
    pub jsonrpc: Option<i64>,
}

impl RpcErr {
    /// An error with a code, message and reason.
    pub fn new(code: &'static str, message: impl Into<String>, reason: Option<&str>) -> Self {
        RpcErr {
            code,
            message: message.into(),
            reason: reason.map(str::to_owned),
            detail: None,
            jsonrpc: None,
        }
    }

    /// With `data.detail`.
    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// With a JSON-RPC code of its own (`-32600`, `-32601`, `-32700`).
    pub fn jsonrpc(mut self, code: i64) -> Self {
        self.jsonrpc = Some(code);
        self
    }

    /// `RpcError.toJSON()`.
    pub fn to_json(&self) -> Value {
        let mut data = Map::new();
        data.insert("error".into(), Value::from(self.code));
        if let Some(r) = self.reason.as_deref().filter(|r| !r.is_empty()) {
            data.insert("reason".into(), Value::from(r));
        }
        if let Some(d) = self.detail.as_deref().filter(|d| !d.is_empty()) {
            data.insert("detail".into(), Value::from(d));
        }
        let code = self.jsonrpc.unwrap_or(if self.code == "E_INVALID_PARAMS" {
            -32602
        } else {
            -32000
        });
        json!({ "code": code, "message": self.message, "data": data })
    }

    /// The error frame for request `id` (`null` when the request had none).
    pub fn frame(&self, id: &Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "error": self.to_json() })
    }
}

/// `parse error` (`-32700`).
pub fn parse_error() -> RpcErr {
    RpcErr::new("E_INVALID_PARAMS", "parse error", Some("parse-error")).jsonrpc(-32700)
}

/// `line exceeds 4194304 bytes (<n>)`.
pub fn line_too_long(bytes: usize) -> RpcErr {
    RpcErr::new(
        "E_INVALID_PARAMS",
        format!("line exceeds {MAX_LINE} bytes ({bytes})"),
        Some("line-too-long"),
    )
}

/// The request's `id`, or `null` (`msg?.id ?? null`).
pub fn id_of(msg: &Value) -> Value {
    match msg.get("id") {
        Some(Value::Null) | None => Value::Null,
        Some(id) => id.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn lines_are_split_bounded_and_empty_ones_skipped() {
        let mut r = Cursor::new(b"\n{\"a\":1}\n\n[2]\npartial".to_vec());
        assert_eq!(
            read_line(&mut r).unwrap(),
            Line::Data(b"{\"a\":1}".to_vec())
        );
        assert_eq!(read_line(&mut r).unwrap(), Line::Data(b"[2]".to_vec()));
        assert_eq!(
            read_line(&mut r).unwrap(),
            Line::Eof,
            "a partial last line is not a request"
        );
        let mut exact = vec![b'x'; MAX_LINE];
        exact.push(b'\n');
        assert_eq!(
            read_line(&mut Cursor::new(exact)).unwrap(),
            Line::Data(vec![b'x'; MAX_LINE])
        );
        let over = vec![b'x'; MAX_LINE + 10];
        assert_eq!(
            read_line(&mut Cursor::new(over)).unwrap(),
            Line::TooLong(MAX_LINE + 1)
        );
    }

    #[test]
    fn error_frames_have_module_apis_shape_and_codes() {
        let e = RpcErr::new(
            "E_UNAUTHORIZED",
            "authenticate first",
            Some("auth-required"),
        );
        assert_eq!(
            e.frame(&json!(7)),
            json!({"jsonrpc":"2.0","id":7,"error":{"code":-32000,"message":"authenticate first","data":{"error":"E_UNAUTHORIZED","reason":"auth-required"}}})
        );
        assert_eq!(parse_error().to_json()["code"], -32700);
        assert_eq!(line_too_long(5).to_json()["code"], -32602);
        assert_eq!(line_too_long(5).message, "line exceeds 4194304 bytes (5)");
        assert_eq!(id_of(&json!({"id":null})), Value::Null);
        assert_eq!(id_of(&json!([1])), Value::Null);
    }
}
