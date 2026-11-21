use super::{
    count, normalized_usage, present, sum_known, Accumulator, Result, Segment, SegmentKind,
};
use crate::ordered::obj;
use crate::{Json, Wire};
use serde_json::Value;

const EVENTS: &[&str] = &[
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
];

impl Accumulator<'_> {
    pub(super) fn anthropic(&mut self, frame: &Json) -> Result<Vec<Value>> {
        if frame.as_object().is_none() {
            return Err(self.malformed("event is not an object"));
        }
        let kind = frame["type"]
            .string()
            .ok_or_else(|| self.malformed("event has no type"))?;
        if !EVENTS.contains(&kind) {
            return Ok(Vec::new());
        }
        if self.terminal {
            return Err(self.malformed(format!("{kind} after message_stop")));
        }
        if kind == "message_start" {
            if self.started {
                return Err(self.malformed("message_start twice"));
            }
            let msg = &frame["message"];
            if msg.as_object().is_none() {
                return Err(self.malformed("message_start has no message"));
            }
            self.started = true;
            self.read_meta(msg, &[("id", "id"), ("model", "model")]);
            self.merge_anthropic_usage(&msg["usage"])?;
            return Ok(Vec::new());
        }
        if !self.started {
            return Err(self.malformed(format!("{kind} before message_start")));
        }
        match kind {
            "message_delta" => {
                let delta = &frame["delta"];
                if present(delta) && delta.as_object().is_none() {
                    return Err(self.malformed("message_delta.delta is not an object"));
                }
                if present(&delta["stop_reason"]) {
                    let raw = delta["stop_reason"].string().ok_or_else(|| {
                        self.malformed("message_delta.stop_reason is not a string")
                    })?;
                    if self.raw.as_deref().is_some_and(|previous| previous != raw) {
                        return Err(self.malformed("conflicting stop_reason"));
                    }
                    self.raw = Some(raw.into());
                }
                self.merge_anthropic_usage(&frame["usage"])?;
            }
            "message_stop" => {
                let raw = self
                    .raw
                    .clone()
                    .ok_or_else(|| self.malformed("message_stop without a stop_reason"))?;
                if let Some((i, _)) = self.segments.iter().find(|(_, state)| state.open) {
                    return Err(
                        self.malformed(format!("block {i} was not closed before message_stop"))
                    );
                }
                self.terminal = true;
                let reason = match raw.as_str() {
                    "end_turn" | "stop_sequence" => "stop",
                    "max_tokens" | "model_context_window_exceeded" => "length",
                    "tool_use" => "tool_calls",
                    "refusal" => "content_filter",
                    _ => "other",
                };
                return Ok(vec![self.stop(&raw, reason)]);
            }
            _ => return self.anth_block(kind, frame),
        }
        Ok(Vec::new())
    }

    fn merge_anthropic_usage(&mut self, value: &Json) -> Result<()> {
        if !present(value) {
            return Ok(());
        }
        if value.as_object().is_none() {
            return Err(self.malformed("usage is not an object"));
        }
        let n = |object, key| count(Wire::AnthropicMessages, object, key);
        let mut written = n(value, "cache_creation_input_tokens")?;
        if written.is_none() {
            let tiers = &value["cache_creation"];
            written = sum_known(&[
                n(tiers, "ephemeral_5m_input_tokens")?,
                n(tiers, "ephemeral_1h_input_tokens")?,
            ]);
        }
        let fields = [
            n(value, "input_tokens")?,
            n(value, "output_tokens")?,
            written,
            n(value, "cache_read_input_tokens")?,
        ];
        for (dest, count) in self.anthropic_usage.iter_mut().zip(fields) {
            if count.is_some() {
                *dest = count;
            }
        }
        let [input, output, written, read] = self.anthropic_usage;
        let input = sum_known(&[input, written, read]);
        self.usage = normalized_usage(&[
            ("inputTokens", input),
            ("outputTokens", output),
            ("totalTokens", input.zip(output).map(|(a, b)| a + b)),
            ("cachedInputTokens", read),
            ("cacheWriteTokens", written),
            ("cacheCreationInputTokens", written),
        ]);
        Ok(())
    }

    fn anth_block(&mut self, kind: &str, frame: &Json) -> Result<Vec<Value>> {
        if self.raw.is_some() && kind != "content_block_stop" {
            let what = if kind == "content_block_start" {
                "content block"
            } else {
                "content"
            };
            return Err(self.malformed(format!(
                "{what} after message_delta carried the stop_reason"
            )));
        }
        let index = self.index(&frame["index"], "content block index")?;
        if kind == "content_block_start" {
            return self.start_anth_block(index, &frame["content_block"]);
        }
        let state = self.segments.get_mut(&index).filter(|s| s.open);
        let Some(state) = state else {
            let event = if kind == "content_block_stop" {
                kind
            } else {
                "delta"
            };
            return Err(self.malformed(format!("{event} for block {index} which is not open")));
        };
        if kind == "content_block_stop" {
            state.open = false;
            return Ok(Vec::new());
        }
        let block = state.kind;
        let delta = &frame["delta"];
        let kind = delta["type"]
            .string()
            .ok_or_else(|| self.malformed("delta has no type"))?;
        let event = match block {
            SegmentKind::Ignored => None,
            SegmentKind::Thinking => {
                let (key, rewritten) = match kind {
                    "signature_delta" => ("signature", false),
                    "thinking_delta" => ("thinking", true),
                    _ => return Ok(Vec::new()),
                };
                let value = delta[key]
                    .string()
                    .ok_or_else(|| self.malformed(format!("{kind}.{key} is not a string")))?;
                if let Some(block) = self.thinking.get_mut(&index) {
                    if let Some(Json::String(text)) = block.get_mut(key) {
                        text.push_str(value);
                    } else {
                        block.set(key, value);
                    }
                }
                if rewritten {
                    self.add_text(value, true)
                } else {
                    None
                }
            }
            SegmentKind::Text if kind == "citations_delta" => None,
            SegmentKind::Text => {
                if kind != "text_delta" {
                    return Err(self.malformed(if kind == "input_json_delta" {
                        "input_json_delta on a text block".to_owned()
                    } else {
                        format!(
                            "unsupported delta type \"{}\" on a text block",
                            super::prefix(kind, 40)
                        )
                    }));
                }
                let text = delta["text"]
                    .string()
                    .ok_or_else(|| self.malformed("text_delta.text is not a string"))?;
                self.add_text(text, false)
            }
            SegmentKind::Tool(i) => {
                if kind != "input_json_delta" {
                    return Err(self.malformed(if kind == "text_delta" {
                        "text_delta on a tool_use block".to_owned()
                    } else {
                        format!(
                            "unsupported delta type \"{}\" on a tool_use block",
                            super::prefix(kind, 40)
                        )
                    }));
                }
                let fragment = delta["partial_json"].string().ok_or_else(|| {
                    self.malformed("input_json_delta.partial_json is not a string")
                })?;
                self.append_arguments(i, fragment, false)?
            }
        };
        Ok(event.into_iter().collect())
    }

    fn start_anth_block(&mut self, index: u32, block: &Json) -> Result<Vec<Value>> {
        if block.as_object().is_none() {
            return Err(self.malformed("content_block is not an object"));
        }
        if self.segments.contains_key(&index) {
            return Err(self.malformed(format!("block {index} already started")));
        }
        let kind = block["type"]
            .string()
            .ok_or_else(|| self.malformed("content_block has no type"))?;
        let (kind, event) = match kind {
            "text" => (
                SegmentKind::Text,
                self.add_text(block["text"].text(), false),
            ),
            "thinking" => {
                let mut held = block.clone();
                held.set("thinking", block["thinking"].text());
                held.set("signature", block["signature"].text());
                self.thinking.insert(index, held);
                (
                    SegmentKind::Thinking,
                    self.add_text(block["thinking"].text(), true),
                )
            }
            "redacted_thinking" => {
                if block["data"].string().is_none() {
                    return Err(self.malformed("redacted thinking has no data"));
                }
                self.thinking.insert(index, block.clone());
                (SegmentKind::Ignored, None)
            }
            "tool_use" => {
                let id = block["id"].text();
                let name = block["name"].text();
                if id.is_empty() {
                    return Err(self.malformed("tool_use block lacks an id"));
                }
                if name.is_empty() {
                    return Err(self.malformed("tool_use block lacks a name"));
                }
                let (i, event) = self.add_tool(id, name)?;
                (SegmentKind::Tool(i), Some(event))
            }
            _ => (SegmentKind::Ignored, None),
        };
        self.segments.insert(index, Segment { kind, open: true });
        Ok(event.into_iter().collect())
    }

    pub(super) fn complete_anthropic(&mut self, body: &Json) -> Result<()> {
        if body.as_object().is_none() {
            return Err(self.malformed("body is not an object"));
        }
        if body["type"].text() != "message" {
            return Err(self.malformed("body is not a message"));
        }
        let content = body["content"]
            .array()
            .ok_or_else(|| self.malformed("content is not an array"))?;
        self.anthropic(&obj!("type": "message_start", "message": body.clone()))?;
        for (i, block) in content.iter().enumerate() {
            if i > 4095 {
                return Err(self.malformed("content block index is not a non-negative integer"));
            }
            let kind = block["type"]
                .string()
                .ok_or_else(|| self.malformed("content block is not an object with a type"))?;
            if kind == "text" && block["text"].string().is_none() {
                return Err(self.malformed("text_delta.text is not a string"));
            }
            if kind == "thinking" && block["thinking"].string().is_none() {
                return Err(self.malformed("thinking_delta.thinking is not a string"));
            }
            self.start_anth_block(i as u32, block)?;
            if let Some(Segment {
                kind: SegmentKind::Tool(tool),
                ..
            }) = self.segments.get(&(i as u32))
            {
                let input = block.get("input").cloned().unwrap_or_else(Json::object);
                if input.as_object().is_none() {
                    return Err(self.malformed("tool_use input is not an object"));
                }
                self.append_arguments(*tool, &input.encode(), true)?;
            }
            self.anth_block("content_block_stop", &obj!("index": i as f64))?;
        }
        self.anthropic(&obj!("type": "message_delta", "delta": obj!("stop_reason": body["stop_reason"].clone())))?;
        self.anthropic(&obj!("type": "message_stop"))?;
        Ok(())
    }
}
