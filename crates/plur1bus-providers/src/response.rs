use crate::request::safe_integer;
use crate::sse::{SseEvent, SseParser};
use crate::{ErrorKind, Json, Ports, ProviderError, TimeoutPhase, Wire};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::io::{self, Read};

mod anthropic;
mod codex;
mod gemini;
mod vendor_error;
pub(crate) use vendor_error::http_error;
use vendor_error::vendor_error;

type Result<T> = std::result::Result<T, ProviderError>;

pub(crate) struct Redactor<'a>(Vec<&'a str>);

impl<'a> Redactor<'a> {
    pub(crate) fn new(secrets: impl Iterator<Item = &'a str>) -> Self {
        Self(secrets.filter(|s| s.encode_utf16().count() >= 6).collect())
    }

    fn redact(&self, text: &str) -> String {
        self.0.iter().fold(text.to_owned(), |out, secret| {
            out.replace(secret, "[redacted]")
        })
    }
}

pub struct ToolRepairInput<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub arguments_raw: &'a str,
    pub error: &'a str,
    pub tool: Option<&'a Json>,
}

pub enum ToolRepair {
    Object(Json),
    Raw(String),
}

pub(crate) struct Delivery<'a> {
    pub wire: Wire,
    pub stream: bool,
    pub media: &'a str,
    pub redact: &'a Redactor<'a>,
    pub allow_missing_done: bool,
    pub max_body: usize,
    pub max_event: usize,
    pub max_args: usize,
    pub request: &'a Json,
    pub ports: &'a dyn Ports,
}

impl Delivery<'_> {
    pub(crate) fn run(self, body: &mut dyn Read, emit: &mut dyn FnMut(Value)) -> Result<Value> {
        let mut acc = Accumulator::new(self.wire, self.max_args, self.redact);
        let media = self.media.to_ascii_lowercase();
        let sse = media.starts_with("text/event-stream")
            && !media
                .as_bytes()
                .get("text/event-stream".len())
                .is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_');
        if !(self.stream || self.wire == Wire::ChatCompletions && sse) {
            let result = acc.complete(&parse_json(&read_all(body, self.max_body)?)?)?;
            return self.finalize(result, &mut acc);
        }
        let result = if sse {
            self.events(body, &mut acc, emit)
        } else if json_media(&media) {
            read_all(body, self.max_body)
                .and_then(|bytes| parse_json(&bytes))
                .and_then(|value| {
                    if let Some(error) = vendor_error(self.wire, &value, self.redact) {
                        return Err(error);
                    }
                    Err(ProviderError::protocol(
                        "expected text/event-stream, got a JSON body",
                    ))
                })
        } else {
            let t = prefix(self.media, 80);
            Err(ProviderError::protocol(format!(
                "expected text/event-stream, got \"{}\"",
                self.redact.redact(&t)
            )))
        };
        let result = result.and_then(|value| self.finalize(value, &mut acc));
        if let (true, Ok(value)) = (self.stream, &result) {
            emit(json!({"type": "done", "result": value}));
        }
        result.map_err(|mut error| {
            if error.partial.is_none()
                && error.kind != ErrorKind::Auth
                && (error.kind != ErrorKind::InvalidRequest || error.content_filtered)
            {
                error.partial = Some(Box::new(acc.partial()));
            }
            error
        })
    }

    fn finalize(&self, mut result: Value, acc: &mut Accumulator<'_>) -> Result<Value> {
        if let Some(calls) = result["toolCalls"].as_array_mut() {
            for call in calls {
                repair_call(call, self);
            }
        }
        if self.ports.cancelled() {
            return Err(ProviderError::new(
                ErrorKind::Aborted,
                "call aborted by the caller",
            ));
        }
        if !acc.thinking.is_empty() {
            self.ports.retain_anthropic_thinking(
                self.request["model"].text(),
                std::mem::take(&mut acc.thinking).into_values().collect(),
            );
        }
        Ok(result)
    }

    fn events(
        &self,
        body: &mut dyn Read,
        acc: &mut Accumulator<'_>,
        emit: &mut dyn FnMut(Value),
    ) -> Result<Value> {
        let mut parser = SseParser::new(self.max_event);
        let mut total = 0usize;
        let mut buffer = [0; 8192];
        let mut done = false;
        loop {
            let n = body.read(&mut buffer).map_err(|e| read_error(&e))?;
            total = total.saturating_add(n);
            if total > self.max_body {
                return Err(ProviderError::protocol(format!(
                    "stream exceeds {} bytes",
                    self.max_body
                )));
            }
            let frames = if n == 0 {
                parser.finish()?
            } else {
                parser.push(&buffer[..n])?
            };
            for SseEvent { data, .. } in frames {
                if data == "[DONE]" && self.wire == Wire::ChatCompletions {
                    done = true;
                    break;
                }
                if data.is_empty() || data == "[DONE]" && self.wire == Wire::CodexResponses {
                    continue;
                }
                let frame = Json::parse(&data)
                    .map_err(|_| ProviderError::protocol("SSE data is not valid JSON"))?;
                for event in acc.push(&frame)? {
                    emit(event);
                }
            }
            if n == 0
                || done
                || acc.terminal
                    && matches!(self.wire, Wire::AnthropicMessages | Wire::CodexResponses)
            {
                break;
            }
        }
        match self.wire {
            Wire::ChatCompletions if !(done || self.allow_missing_done && acc.raw.is_some()) => {
                return Err(ProviderError::protocol("stream ended without [DONE]"))
            }
            Wire::AnthropicMessages if !acc.terminal => {
                return Err(ProviderError::protocol("stream ended without message_stop"))
            }
            Wire::CodexResponses if !acc.terminal => {
                return Err(ProviderError::protocol(
                    "stream ended without response.completed",
                ))
            }
            Wire::Gemini if acc.raw.is_none() => {
                return Err(ProviderError::protocol(
                    "stream ended without a finishReason",
                ))
            }
            _ => {}
        }
        if let Some(usage) = &acc.usage {
            emit(json!({"type": "usage", "usage": usage}));
        }
        acc.result()
    }
}

fn repair_call(call: &mut Value, delivery: &Delivery<'_>) {
    let Some(error) = call["argumentsError"].as_str() else {
        return;
    };
    let name = call["name"].as_str().unwrap_or_default();
    let Some(repair) = delivery.ports.repair_tool_arguments(ToolRepairInput {
        id: call["id"].as_str().unwrap_or_default(),
        name,
        arguments_raw: call["argumentsRaw"].as_str().unwrap_or_default(),
        error,
        tool: delivery.request["tools"]
            .items()
            .iter()
            .find(|tool| tool["name"].text() == name),
    }) else {
        return;
    };
    let (raw, args) = match repair {
        ToolRepair::Object(args) => (args.encode(), args),
        ToolRepair::Raw(raw) => {
            if raw.len() > delivery.max_args {
                return;
            }
            let Ok(args) = Json::parse(&raw) else {
                return;
            };
            (raw, args)
        }
    };
    if raw.len() <= delivery.max_args && args.as_object().is_some() {
        call["argumentsRaw"] = json!(raw);
        call["arguments"] = value(&args);
        call["repaired"] = json!(true);
        if let Some(fields) = call.as_object_mut() {
            fields.remove("argumentsError");
        }
    }
}

fn prefix(value: &str, units: usize) -> String {
    String::from_utf16_lossy(&value.encode_utf16().take(units).collect::<Vec<_>>())
}

fn json_media(media: &str) -> bool {
    let Some(kind) = media.strip_prefix("application/") else {
        return false;
    };
    let suffix = kind
        .split(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, '+' | '_'))
        .next()
        .unwrap_or_default();
    suffix == "json"
        || suffix
            .strip_suffix("+json")
            .is_some_and(|prefix| !prefix.is_empty() && !prefix.contains('+'))
}

fn parse_json(body: &[u8]) -> Result<Json> {
    let decoded = String::from_utf8_lossy(body);
    Json::parse(decoded.strip_prefix('\u{feff}').unwrap_or(&decoded))
        .map_err(|_| ProviderError::protocol("response body is not valid JSON"))
}

fn read_all(body: &mut dyn Read, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    body.take((limit as u64).saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| read_error(&e))?;
    if bytes.len() > limit {
        return Err(ProviderError::protocol(format!(
            "response body exceeds {limit} bytes"
        )));
    }
    Ok(bytes)
}

pub(crate) fn read_error(error: &io::Error) -> ProviderError {
    if error.kind() == io::ErrorKind::ConnectionAborted {
        return ProviderError::new(ErrorKind::Aborted, "call aborted by the caller");
    }
    if let Some(ureq::Error::Timeout(phase)) = error
        .get_ref()
        .and_then(|e| e.downcast_ref::<ureq::Error>())
    {
        return crate::transport::timeout(if *phase == ureq::Timeout::Global {
            TimeoutPhase::Total
        } else {
            TimeoutPhase::Idle
        });
    }
    if error.kind() == io::ErrorKind::TimedOut {
        return crate::transport::timeout(TimeoutPhase::Idle);
    }
    ProviderError::new(
        ErrorKind::Network,
        "network failure: provider response interrupted",
    )
}

fn value(json: &Json) -> Value {
    serde_json::from_str(&json.encode()).unwrap_or(Value::Null)
}

fn present(json: &Json) -> bool {
    !matches!(json, Json::Null)
}

#[derive(Default)]
struct ToolCall {
    id: Option<String>,
    name: Option<String>,
    args: String,
    argument_units: usize,
}

impl ToolCall {
    fn append_arguments(&mut self, fragment: &str, limit: usize) -> bool {
        let total = self.argument_units + fragment.encode_utf16().count();
        if total > limit {
            return false;
        }
        self.args.push_str(fragment);
        self.argument_units = total;
        true
    }

    fn snapshot(&self, index: u32, event: bool) -> Value {
        let mut out = if event {
            json!({"type": "tool_call_start", "index": index})
        } else {
            json!({"index": index, "argumentsRaw": self.args})
        };
        if let Some(id) = &self.id {
            out["id"] = json!(id);
        }
        if let Some(name) = &self.name {
            out["name"] = json!(name);
        }
        out
    }

    fn result(&self, id: &str, name: &str, default_empty: bool) -> Value {
        let raw = if default_empty && self.args.is_empty() {
            "{}"
        } else {
            &self.args
        };
        let mut out = json!({"id": id, "name": name, "argumentsRaw": raw});
        match Json::parse(raw) {
            Ok(json) if json.as_object().is_some() => out["arguments"] = value(&json),
            Ok(_) => out["argumentsError"] = json!("arguments must be a JSON object"),
            Err(error) => {
                let detail = tool_json_error(raw, &error);
                out["argumentsError"] = json!(format!("arguments are not valid JSON: {detail}"));
            }
        }
        out
    }
}

fn tool_json_error(raw: &str, error: &serde_json::Error) -> String {
    let detail = error.to_string();
    let before_suffix = detail.split(" at line ").next().unwrap_or_default();
    let trimmed = raw.trim_end_matches([' ', '\r', '\n', '\t']);
    let message = match before_suffix {
        "EOF while parsing an object" | "key must be a string" if trimmed.ends_with('{') => {
            "Expected property name or '}' in JSON"
        }
        "EOF while parsing an object" if trimmed.ends_with(',') => {
            "Expected double-quoted property name in JSON"
        }
        "EOF while parsing an object" | "expected `,` or `}`" => {
            "Expected ',' or '}' after property value in JSON"
        }
        "expected `:`" => "Expected ':' after property name in JSON",
        "EOF while parsing a string" => "Unterminated string in JSON",
        _ if error.is_eof() => return "Unexpected end of JSON input".into(),
        _ => return detail,
    };
    let offset = if error.is_eof() {
        raw.len()
    } else {
        let line_start = raw
            .split_inclusive('\n')
            .take(error.line().saturating_sub(1))
            .map(str::len)
            .sum::<usize>();
        line_start
            .saturating_add(error.column().saturating_sub(1))
            .min(raw.len())
    };
    let prefix = &raw[..raw.floor_char_boundary(offset)];
    let position = prefix.encode_utf16().count();
    let line = prefix.bytes().filter(|&b| b == b'\n').count() + 1;
    let column = prefix
        .rsplit('\n')
        .next()
        .unwrap_or_default()
        .encode_utf16()
        .count()
        + 1;
    format!("{message} at position {position} (line {line} column {column})")
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum SegmentKind {
    Text,
    Thinking,
    Tool(u32),
    Ignored,
}

struct Segment {
    kind: SegmentKind,
    open: bool,
}

struct Accumulator<'a> {
    wire: Wire,
    max_args: usize,
    redact: &'a Redactor<'a>,
    meta: Map<String, Value>,
    calls: BTreeMap<u32, ToolCall>,
    text: String,
    reasoning: String,
    refusal: String,
    raw: Option<String>,
    finish: &'static str,
    usage: Option<Value>,
    terminal: bool,
    started: bool,
    segments: indexmap::IndexMap<u32, Segment>,
    thinking: BTreeMap<u32, Json>,
    anthropic_usage: [Option<u64>; 4],
    refused: bool,
}

impl<'a> Accumulator<'a> {
    fn new(wire: Wire, max_args: usize, redact: &'a Redactor<'a>) -> Self {
        Self {
            wire,
            max_args,
            redact,
            meta: Map::new(),
            calls: BTreeMap::new(),
            text: String::new(),
            reasoning: String::new(),
            refusal: String::new(),
            raw: None,
            finish: "other",
            usage: None,
            terminal: false,
            started: false,
            segments: indexmap::IndexMap::new(),
            thinking: BTreeMap::new(),
            anthropic_usage: [None; 4],
            refused: false,
        }
    }

    fn malformed(&self, message: impl std::fmt::Display) -> ProviderError {
        malformed(self.wire, message)
    }

    fn partial(&self) -> Value {
        let mut p = json!({"text": self.text, "toolCalls": self.calls.iter().map(|(&index, call)| call.snapshot(index, false)).collect::<Vec<_>>()});
        if !self.reasoning.is_empty() {
            p["reasoning"] = json!(self.reasoning);
        }
        if let Some(usage) = &self.usage {
            p["usage"] = usage.clone();
        }
        p
    }

    fn result(&self) -> Result<Value> {
        let raw = self.raw.as_ref().ok_or_else(|| {
            self.malformed(match self.wire {
                Wire::ChatCompletions => "stream ended without a finish_reason",
                Wire::AnthropicMessages => "stream ended without message_stop",
                Wire::CodexResponses => "stream ended without response.completed",
                Wire::Gemini => "response ended without a finishReason",
            })
        })?;
        let mut seen = HashSet::new();
        let mut tool_calls = Vec::new();
        for (index, call) in &self.calls {
            let (Some(id), Some(name)) = (&call.id, &call.name) else {
                return Err(self.malformed(format!("tool call {index} lacks an id or a name")));
            };
            if !seen.insert(id) {
                return Err(self.malformed("duplicate tool call id"));
            }
            tool_calls.push(call.result(
                id,
                name,
                matches!(self.wire, Wire::AnthropicMessages | Wire::CodexResponses),
            ));
        }
        let mut out = json!({"text": self.text, "toolCalls": tool_calls, "finishReason": self.finish, "rawFinishReason": raw, "meta": self.meta});
        if !self.reasoning.is_empty() {
            out["reasoning"] = json!(self.reasoning);
        }
        if !self.refusal.is_empty() {
            out["refusal"] = json!(self.refusal);
        }
        if let Some(usage) = &self.usage {
            out["usage"] = usage.clone();
        }
        Ok(out)
    }

    fn read_meta(&mut self, from: &Json, keys: &[(&str, &str)]) {
        for (name, wire) in keys {
            if let Some(string) = from[wire].string() {
                if self.wire == Wire::ChatCompletions || !self.meta.contains_key(*name) {
                    self.meta.insert((*name).into(), json!(string));
                }
            }
        }
    }

    fn stop(&mut self, raw: &str, reason: &'static str) -> Value {
        self.raw = Some(raw.into());
        self.finish = reason;
        json!({"type": "finish", "finishReason": reason, "rawFinishReason": raw})
    }

    fn push(&mut self, frame: &Json) -> Result<Vec<Value>> {
        if let Some(error) = vendor_error(self.wire, frame, self.redact) {
            return Err(error);
        }
        match self.wire {
            Wire::ChatCompletions => self.chat(frame),
            Wire::AnthropicMessages => self.anthropic(frame),
            Wire::CodexResponses => self.codex(frame),
            Wire::Gemini => self.gemini(frame),
        }
    }

    fn complete(&mut self, document: &Json) -> Result<Value> {
        if let Some(error) = vendor_error(self.wire, document, self.redact) {
            return Err(error);
        }
        match self.wire {
            Wire::ChatCompletions => self.complete_chat(document)?,
            Wire::AnthropicMessages => self.complete_anthropic(document)?,
            Wire::CodexResponses => self.complete_codex(document)?,
            Wire::Gemini => {
                self.gemini(document)?;
            }
        }
        self.result()
    }

    fn add_tool(&mut self, id: &str, name: &str) -> Result<(u32, Value)> {
        if self
            .calls
            .values()
            .any(|call| call.id.as_deref() == Some(id))
        {
            return Err(self.malformed("duplicate tool call id"));
        }
        let index = self.calls.len() as u32;
        if index > 1023 {
            return Err(self.malformed("too many tool calls"));
        }
        let call = ToolCall {
            id: Some(id.into()),
            name: Some(name.into()),
            ..ToolCall::default()
        };
        let event = call.snapshot(index, true);
        self.calls.insert(index, call);
        Ok((index, event))
    }

    fn add_text(&mut self, text: &str, thinking: bool) -> Option<Value> {
        if text.is_empty() {
            return None;
        }
        let (kind, field) = if thinking {
            ("reasoning_delta", &mut self.reasoning)
        } else {
            ("text_delta", &mut self.text)
        };
        field.push_str(text);
        Some(json!({"type": kind, "text": text}))
    }

    fn append_arguments(
        &mut self,
        index: u32,
        fragment: &str,
        full: bool,
    ) -> Result<Option<Value>> {
        let wire = self.wire;
        let call = self
            .calls
            .get_mut(&index)
            .ok_or_else(|| malformed(wire, "tool call state is missing"))?;
        if fragment.is_empty() {
            return Ok(None);
        }
        if full && !call.args.is_empty() {
            if call.args == fragment {
                return Ok(None);
            }
            return Err(malformed(
                wire,
                "function_call arguments.done disagrees with the streamed deltas",
            ));
        }
        if !call.append_arguments(fragment, self.max_args) {
            return Err(malformed(
                wire,
                format!("tool call arguments exceed {} bytes", self.max_args),
            ));
        }
        Ok(Some(tool_delta(index, fragment)))
    }

    fn index(&self, raw: &Json, what: &str) -> Result<u32> {
        raw.number()
            .filter(|&n| safe_integer(n, 0.0) && n <= 4095.0)
            .map(|v| v as u32)
            .ok_or_else(|| self.malformed(format!("{what} is not a non-negative integer")))
    }

    fn chat(&mut self, frame: &Json) -> Result<Vec<Value>> {
        if frame.as_object().is_none() {
            return Err(self.malformed("chunk is not an object"));
        }
        self.read_meta(
            frame,
            &[
                ("id", "id"),
                ("model", "model"),
                ("systemFingerprint", "system_fingerprint"),
            ],
        );
        let mut events = Vec::new();
        if frame["choices"].array().is_none() && frame["usage"].as_object().is_none() {
            return Err(self.malformed("chunk has neither choices nor usage"));
        }
        for choice in frame["choices"].items() {
            if choice.as_object().is_none() {
                return Err(self.malformed("choice is not an object"));
            }
            if present(&choice["index"]) && choice["index"].number() != Some(0.0) {
                return Err(self.malformed("unexpected choice index"));
            }
            let delta = &choice["delta"];
            if present(delta) {
                if delta.as_object().is_none() {
                    return Err(self.malformed("delta is not an object"));
                }
                self.chat_delta(delta, &mut events)?;
            }
            if present(&choice["finish_reason"]) {
                let raw = choice["finish_reason"]
                    .string()
                    .ok_or_else(|| self.malformed("finish_reason is not a string"))?;
                match &self.raw {
                    Some(last) if last != raw => {
                        return Err(self.malformed("conflicting finish_reason"))
                    }
                    None => events.push(self.stop(raw, chat_stop(raw))),
                    _ => {}
                }
            }
        }
        if present(&frame["usage"]) {
            if let Some(usage) = usage(self.wire, &frame["usage"])? {
                self.usage = Some(usage);
            }
        }
        Ok(events)
    }

    fn chat_delta(&mut self, delta: &Json, events: &mut Vec<Value>) -> Result<()> {
        let reasoning = delta
            .get("reasoning_content")
            .filter(|v| present(v))
            .unwrap_or(&delta["reasoning"]);
        let fields = [
            (&delta["role"], "role"),
            (&delta["content"], "content"),
            (&delta["refusal"], "refusal"),
            (reasoning, "reasoning_content"),
        ];
        for (value, field) in fields {
            if present(value) && value.string().is_none() {
                return Err(self.malformed(format!("delta.{field} is not a string")));
            }
        }
        let calls = &delta["tool_calls"];
        if self.raw.is_some()
            && (!delta["content"].text().is_empty()
                || !delta["refusal"].text().is_empty()
                || !reasoning.text().is_empty()
                || !calls.items().is_empty())
        {
            return Err(self.malformed("content after finish_reason"));
        }
        for (kind, text, target) in [
            ("text_delta", delta["content"].text(), &mut self.text),
            ("reasoning_delta", reasoning.text(), &mut self.reasoning),
        ] {
            if !text.is_empty() {
                target.push_str(text);
                events.push(json!({"type": kind, "text": text}));
            }
        }
        self.refusal.push_str(delta["refusal"].text());
        if present(calls) && calls.array().is_none() {
            return Err(self.malformed("delta.tool_calls is not an array"));
        }
        for call in calls.items() {
            if call.as_object().is_none() {
                return Err(self.malformed("tool call delta is not an object"));
            }
            let index = call["index"]
                .number()
                .filter(|&n| safe_integer(n, 0.0) && n <= 1023.0)
                .ok_or_else(|| self.malformed("tool call delta lacks a valid index"))?
                as u32;
            let is_new = !self.calls.contains_key(&index);
            let wire = self.wire;
            let state = self.calls.entry(index).or_default();
            let id = &call["id"];
            if present(id) {
                if id.text().is_empty() {
                    return Err(malformed(wire, "tool call id is not a non-empty string"));
                }
                if state.id.as_deref().is_some_and(|old| old != id.text()) {
                    return Err(malformed(wire, format!("tool call {index} changed its id")));
                }
                state.id = Some(id.text().into());
            }
            let function = &call["function"];
            if present(function) && function.as_object().is_none() {
                return Err(malformed(wire, "tool call function is not an object"));
            }
            let name = &function["name"];
            if present(name) {
                if name.string().is_none() {
                    return Err(malformed(wire, "tool call name is not a string"));
                }
                if !name.text().is_empty() {
                    if state.name.as_deref().is_some_and(|old| old != name.text()) {
                        return Err(malformed(
                            wire,
                            format!("tool call {index} changed its name"),
                        ));
                    }
                    state.name = Some(name.text().into());
                }
            }
            let args = &function["arguments"];
            if present(args) && args.string().is_none() {
                return Err(malformed(wire, "tool call arguments are not a string"));
            }
            let args = args.text();
            if !state.append_arguments(args, self.max_args) {
                return Err(malformed(
                    wire,
                    format!("tool call {index} arguments exceed {} bytes", self.max_args),
                ));
            }
            if is_new {
                events.push(state.snapshot(index, true));
            }
            if !args.is_empty() {
                events.push(tool_delta(index, args));
            }
        }
        Ok(())
    }

    fn complete_chat(&mut self, document: &Json) -> Result<()> {
        if document.as_object().is_none() {
            return Err(self.malformed("body is not an object"));
        }
        let choice = document["choices"]
            .items()
            .first()
            .ok_or_else(|| self.malformed("choices is missing or empty"))?;
        let message = &choice["message"];
        if message.as_object().is_none() {
            return Err(self.malformed("choices[0].message is missing"));
        }
        let stop = choice["finish_reason"]
            .string()
            .ok_or_else(|| self.malformed("finish_reason is missing"))?;
        let reasoning = message
            .get("reasoning_content")
            .filter(|v| present(v))
            .unwrap_or(&message["reasoning"]);
        for (name, field) in [
            ("content", &message["content"]),
            ("refusal", &message["refusal"]),
            ("reasoning_content", reasoning),
        ] {
            if present(field) && field.string().is_none() {
                return Err(self.malformed(format!("message.{name} is not a string")));
            }
        }
        self.text = message["content"].text().into();
        self.reasoning = reasoning.text().into();
        self.refusal = message["refusal"].text().into();
        self.stop(stop, chat_stop(stop));
        self.read_meta(
            document,
            &[
                ("id", "id"),
                ("model", "model"),
                ("systemFingerprint", "system_fingerprint"),
            ],
        );
        if present(&document["usage"]) {
            self.usage = usage(self.wire, &document["usage"])?;
        }
        let calls = &message["tool_calls"];
        if present(calls) && calls.array().is_none() {
            return Err(self.malformed("message.tool_calls is not an array"));
        }
        for (index, call) in calls.items().iter().enumerate() {
            if call.as_object().is_none() || call["function"].as_object().is_none() {
                return Err(self.malformed("tool call is malformed"));
            }
            let id = call["id"].text();
            let name = call["function"]["name"].text();
            let Some(args) = call["function"]["arguments"].string() else {
                return Err(self.malformed("tool call lacks id, name or string arguments"));
            };
            if id.is_empty() || name.is_empty() {
                return Err(self.malformed("tool call lacks id, name or string arguments"));
            }
            self.calls.insert(
                index as u32,
                ToolCall {
                    id: Some(id.into()),
                    name: Some(name.into()),
                    args: args.into(),
                    argument_units: args.encode_utf16().count(),
                },
            );
        }
        Ok(())
    }
}

fn tool_delta(index: u32, args: &str) -> Value {
    json!({"type": "tool_call_delta", "index": index, "argumentsDelta": args})
}

fn malformed(wire: Wire, message: impl std::fmt::Display) -> ProviderError {
    let name = match wire {
        Wire::ChatCompletions => "chat_completions",
        Wire::AnthropicMessages => "Anthropic",
        Wire::CodexResponses => "Responses",
        Wire::Gemini => "Gemini",
    };
    ProviderError::protocol(format!("malformed {name} response: {message}"))
}

fn chat_stop(raw: &str) -> &'static str {
    match raw {
        "stop" => "stop",
        "length" => "length",
        "tool_calls" | "function_call" => "tool_calls",
        "content_filter" => "content_filter",
        _ => "other",
    }
}

fn count(wire: Wire, from: &Json, key: &str) -> Result<Option<u64>> {
    if !present(&from[key]) {
        return Ok(None);
    }
    let usage = if wire == Wire::Gemini {
        "usageMetadata"
    } else {
        "usage"
    };
    let n = from[key]
        .number()
        .filter(|&n| safe_integer(n, 0.0))
        .ok_or_else(|| {
            malformed(
                wire,
                format!("{usage}.{key} must be a non-negative integer"),
            )
        })?;
    Ok(Some(n as u64))
}

fn normalized_usage(fields: &[(&str, Option<u64>)]) -> Option<Value> {
    let map: Map<_, _> = fields
        .iter()
        .filter_map(|&(key, count)| count.map(|n| (key.to_owned(), json!(n))))
        .collect();
    (!map.is_empty()).then_some(Value::Object(map))
}

fn sum_known(values: &[Option<u64>]) -> Option<u64> {
    values
        .iter()
        .any(Option::is_some)
        .then(|| values.iter().flatten().sum())
}

fn usage(wire: Wire, from: &Json) -> Result<Option<Value>> {
    if from.as_object().is_none() {
        return Err(malformed(wire, "usage is not an object"));
    }
    let mut out = Map::new();
    let p = &from["prompt_tokens_details"];
    let c = &from["completion_tokens_details"];
    let n = |part, key| count(wire, part, key);
    let hit = n(from, "prompt_cache_hit_tokens")?;
    let miss = n(from, "prompt_cache_miss_tokens")?;
    let in_count = n(from, "prompt_tokens")?
        .or(n(from, "prompt_eval_count")?)
        .or(hit.zip(miss).map(|(a, b)| a + b));
    let out_count = n(from, "completion_tokens")?.or(n(from, "eval_count")?);
    for (key, count) in [
        ("inputTokens", in_count),
        ("outputTokens", out_count),
        (
            "totalTokens",
            n(from, "total_tokens")?.or(in_count.zip(out_count).map(|(a, b)| a + b)),
        ),
        (
            "cachedInputTokens",
            n(p, "cached_tokens")?.or(hit).or(n(from, "cached_tokens")?),
        ),
        (
            "cacheWriteTokens",
            n(p, "cache_write_tokens")?.or(n(from, "cache_creation_input_tokens")?),
        ),
        ("reasoningTokens", n(c, "reasoning_tokens")?),
    ] {
        if let Some(count) = count {
            out.insert(key.into(), json!(count));
        }
    }
    Ok((!out.is_empty()).then_some(Value::Object(out)))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    const FRAGMENTS: usize = 128 * 1024;

    fn many_fragments(mut append: impl FnMut()) {
        let start = Instant::now();
        for _ in 0..FRAGMENTS / 1024 {
            for _ in 0..1024 {
                append();
            }
            assert!(
                start.elapsed() < Duration::from_secs(2),
                "tool argument accumulation exceeded two seconds"
            );
        }
    }

    #[test]
    fn tool_argument_units_are_checked_before_appending() {
        let mut call = ToolCall::default();
        assert!(call.append_arguments("😀", 3));
        assert!(call.append_arguments("x", 3));
        assert!(!call.append_arguments("y", 3));
        assert_eq!(call.args, "😀x");
    }

    #[test]
    fn event_tool_arguments_scale_with_the_new_fragment() {
        let redact = Redactor::new(std::iter::empty());
        let mut state = Accumulator::new(Wire::CodexResponses, FRAGMENTS, &redact);
        let (index, _) = state.add_tool("fixture", "inspect").unwrap();
        many_fragments(|| {
            state.append_arguments(index, "x", false).unwrap();
        });
        assert_eq!(state.calls[&index].args, "x".repeat(FRAGMENTS));
    }

    #[test]
    fn chat_tool_arguments_scale_with_the_new_fragment() {
        let redact = Redactor::new(std::iter::empty());
        let mut state = Accumulator::new(Wire::ChatCompletions, FRAGMENTS, &redact);
        let delta =
            Json::parse(r#"{"tool_calls":[{"index":0,"function":{"arguments":"x"}}]}"#).unwrap();
        let mut events = Vec::new();
        many_fragments(|| {
            state.chat_delta(&delta, &mut events).unwrap();
            events.clear();
        });
        assert_eq!(state.calls[&0].args, "x".repeat(FRAGMENTS));
    }
}
