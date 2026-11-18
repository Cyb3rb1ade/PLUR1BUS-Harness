use super::{
    count, normalized_usage, prefix, present, vendor_error, Accumulator, Result, Segment,
    SegmentKind,
};
use crate::ordered::obj;
use crate::{ErrorKind, Json, ProviderError};
use serde_json::Value;

const EVENTS: &[&str] = &[
    "response.created",
    "response.output_item.added",
    "response.output_item.done",
    "response.output_text.delta",
    "response.refusal.delta",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.reasoning_summary_text.delta",
    "response.reasoning_text.delta",
    "response.completed",
    "response.incomplete",
    "response.failed",
];

impl Accumulator<'_> {
    pub(super) fn codex(&mut self, event: &Json) -> Result<Vec<Value>> {
        if event.as_object().is_none() {
            return Err(self.malformed("event is not an object"));
        }
        let kind = event["type"]
            .string()
            .ok_or_else(|| self.malformed("event has no type"))?;
        if kind == "error" {
            return Err(ProviderError::new(
                ErrorKind::Unknown,
                "provider stream error",
            ));
        }
        if !EVENTS.contains(&kind) {
            return Ok(Vec::new());
        }
        if self.terminal {
            return Err(self.malformed(format!("{kind} after the terminal event")));
        }
        if kind == "response.created" {
            if self.started {
                return Err(self.malformed("response.created twice"));
            }
            self.read_responses(kind, &event["response"])?;
            self.started = true;
            return Ok(Vec::new());
        }
        if !self.started {
            return Err(self.malformed(format!("{kind} before response.created")));
        }
        match kind {
            "response.completed" | "response.incomplete" | "response.failed" => {
                let response = &event["response"];
                self.read_responses(kind, response)?;
                if kind == "response.failed" {
                    return Err(
                        vendor_error(self.wire, response, self.redact).unwrap_or_else(|| {
                            ProviderError::new(ErrorKind::Unknown, "provider stream error")
                        }),
                    );
                }
                if let Some((i, _)) = self.segments.iter().find(|(_, item)| item.open) {
                    return Err(
                        self.malformed(format!("item {i} is still open at {kind} (not closed)"))
                    );
                }
                self.read_codex_usage(&response["usage"])?;
                let (raw, finish) = if kind == "response.completed" {
                    (
                        "completed",
                        if !self.calls.is_empty() {
                            "tool_calls"
                        } else if self.refused {
                            "content_filter"
                        } else {
                            "stop"
                        },
                    )
                } else {
                    let raw = response["incomplete_details"]["reason"]
                        .string()
                        .unwrap_or("incomplete");
                    (
                        raw,
                        match raw {
                            "max_output_tokens" => "length",
                            "content_filter" => "content_filter",
                            _ => "other",
                        },
                    )
                };
                self.terminal = true;
                Ok(vec![self.stop(raw, finish)])
            }
            "response.output_item.added" => self.start_codex(event),
            _ => self.codex_item(kind, event),
        }
    }

    fn read_responses(&mut self, kind: &str, reply: &Json) -> Result<()> {
        if reply.as_object().is_none() {
            return Err(self.malformed(format!("{kind} has no response")));
        }
        self.read_meta(reply, &[("id", "id"), ("model", "model")]);
        Ok(())
    }

    fn read_codex_usage(&mut self, from: &Json) -> Result<()> {
        if !present(from) {
            return Ok(());
        }
        if from.as_object().is_none() {
            return Err(self.malformed("usage is not an object"));
        }
        let n = |obj, key| count(self.wire, obj, key);
        let input = n(from, "input_tokens")?;
        let output = n(from, "output_tokens")?;
        let details = &from["input_tokens_details"];
        self.usage = normalized_usage(&[
            ("inputTokens", input),
            ("outputTokens", output),
            (
                "totalTokens",
                n(from, "total_tokens")?.or(input.zip(output).map(|(a, b)| a + b)),
            ),
            ("cachedInputTokens", n(details, "cached_tokens")?),
            ("cacheWriteTokens", n(details, "cache_write_tokens")?),
            (
                "reasoningTokens",
                n(&from["output_tokens_details"], "reasoning_tokens")?,
            ),
        ]);
        Ok(())
    }

    fn start_codex(&mut self, event: &Json) -> Result<Vec<Value>> {
        let index = self.index(&event["output_index"], "output_index")?;
        let item = &event["item"];
        if item.as_object().is_none() {
            return Err(self.malformed("item is not an object"));
        }
        if self.segments.contains_key(&index) {
            return Err(self.malformed(format!("item {index} already added")));
        }
        let kind = item["type"]
            .string()
            .ok_or_else(|| self.malformed("item has no type"))?;
        let mut events = Vec::new();
        let kind = match kind {
            "message" => SegmentKind::Text,
            "reasoning" => SegmentKind::Thinking,
            "function_call" => {
                let id = item["call_id"].text();
                let name = item["name"].text();
                if id.is_empty() {
                    return Err(self.malformed("function_call item lacks a call_id"));
                }
                if name.is_empty() {
                    return Err(self.malformed("function_call item lacks a name"));
                }
                let (i, started) = self.add_tool(id, name)?;
                events.push(started);
                events.extend(self.append_arguments(i, item["arguments"].text(), true)?);
                SegmentKind::Tool(i)
            }
            _ => SegmentKind::Ignored,
        };
        self.segments.insert(index, Segment { kind, open: true });
        Ok(events)
    }

    fn codex_item(&mut self, kind: &str, event: &Json) -> Result<Vec<Value>> {
        let index = self.index(&event["output_index"], "output_index")?;
        let item = self.segments.get_mut(&index).filter(|s| s.open);
        let Some(item) = item else {
            let what = if kind.starts_with("response.reasoning") {
                "reasoning delta"
            } else {
                kind.strip_prefix("response.").unwrap_or(kind)
            };
            return Err(self.malformed(format!("{what} for item {index} which is not open")));
        };
        let shape = item.kind;
        let event = match kind {
            "response.output_item.done" => {
                item.open = false;
                if let SegmentKind::Tool(i) = shape {
                    self.append_arguments(i, event["item"]["arguments"].text(), true)?
                } else {
                    None
                }
            }
            "response.output_text.delta" | "response.refusal.delta" => {
                let delta = event["delta"]
                    .string()
                    .ok_or_else(|| self.malformed("delta is not a string"))?;
                if matches!(shape, SegmentKind::Tool(_)) {
                    return Err(self.malformed("text on a function_call item"));
                }
                if shape == SegmentKind::Text {
                    if kind == "response.refusal.delta" && !delta.is_empty() {
                        self.refused = true;
                    }
                    self.add_text(delta, false)
                } else {
                    None
                }
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                let delta = event["delta"]
                    .string()
                    .ok_or_else(|| self.malformed("delta is not a string"))?;
                self.add_text(delta, true)
            }
            _ => {
                let done = kind == "response.function_call_arguments.done";
                let field = if done { "arguments" } else { "delta" };
                let delta = event[field]
                    .string()
                    .ok_or_else(|| self.malformed(format!("{field} is not a string")))?;
                let SegmentKind::Tool(i) = shape else {
                    return Err(self.malformed("arguments on a message or reasoning item"));
                };
                self.append_arguments(i, delta, done)?
            }
        };
        Ok(event.into_iter().collect())
    }

    pub(super) fn complete_codex(&mut self, body: &Json) -> Result<()> {
        if body.as_object().is_none() {
            return Err(self.malformed("body is not an object"));
        }
        let status = body["status"].string();
        if status == Some("failed") {
            return Err(
                vendor_error(self.wire, body, self.redact).unwrap_or_else(|| {
                    ProviderError::new(ErrorKind::Unknown, "provider stream error")
                }),
            );
        }
        if !matches!(status, Some("completed" | "incomplete")) {
            let status =
                status.map_or_else(|| "(none)".into(), |str| format!("\"{}\"", prefix(str, 40)));
            return Err(self.malformed(format!("status {status} is not a final status")));
        }
        let output = body["output"]
            .array()
            .ok_or_else(|| self.malformed("output is not an array"))?;
        self.read_responses("response.created", body)?;
        self.started = true;
        for (index, item) in output.iter().enumerate() {
            let kind = item["type"]
                .string()
                .ok_or_else(|| self.malformed("output item is not an object with a type"))?;
            let index = index as f64;
            self.start_codex(&obj!("output_index": index, "item": item.clone()))?;
            match kind {
                "function_call"
                    if item.get("arguments").is_some() && item["arguments"].string().is_none() =>
                {
                    return Err(self.malformed("delta is not a string"))
                }
                "message" => {
                    for part in item["content"].items() {
                        let (kind, key) = match part["type"].text() {
                            "output_text" => ("response.output_text.delta", "text"),
                            "refusal" => ("response.refusal.delta", "refusal"),
                            _ => continue,
                        };
                        self.codex_item(
                            kind,
                            &obj!("output_index": index, "delta": part[key].clone()),
                        )?;
                    }
                }
                "reasoning" => {
                    for part in item["summary"]
                        .items()
                        .iter()
                        .filter(|p| p["type"].text() == "summary_text")
                    {
                        self.codex_item(
                            "response.reasoning_summary_text.delta",
                            &obj!("output_index": index, "delta": part["text"].clone()),
                        )?;
                    }
                }
                _ => {}
            }
            self.codex_item("response.output_item.done", &obj!("output_index": index))?;
        }
        let kind = if status == Some("completed") {
            "response.completed"
        } else {
            "response.incomplete"
        };
        self.codex(&obj!("type": kind, "response": body.clone()))?;
        Ok(())
    }
}
