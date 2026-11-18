use super::{count, normalized_usage, prefix, present, sum_known, Accumulator, Result};
use crate::{ErrorKind, Json, ProviderError};
use serde_json::Value;

impl Accumulator<'_> {
    pub(super) fn gemini(&mut self, frame: &Json) -> Result<Vec<Value>> {
        if frame.as_object().is_none() {
            return Err(self.malformed("chunk is not an object"));
        }
        self.read_meta(frame, &[("id", "responseId"), ("model", "modelVersion")]);
        let feedback = &frame["promptFeedback"];
        if present(feedback) {
            if feedback.as_object().is_none() {
                return Err(self.malformed("promptFeedback is not an object"));
            }
            if present(&feedback["blockReason"]) {
                let reason = feedback["blockReason"]
                    .string()
                    .ok_or_else(|| self.malformed("promptFeedback.blockReason is not a string"))?;
                if reason != "BLOCK_REASON_UNSPECIFIED" {
                    return Err(self.gemini_block(
                        false,
                        reason,
                        feedback["blockReasonMessage"].text(),
                    ));
                }
            }
        }
        let mut events = Vec::new();
        let candidates = &frame["candidates"];
        if present(candidates) {
            let candidates = candidates
                .array()
                .ok_or_else(|| self.malformed("candidates is not an array"))?;
            if candidates.len() > 1 {
                return Err(self.malformed("more than one candidate"));
            }
            if let Some(candidate) = candidates.first() {
                self.gemini_candidate(candidate, &mut events)?;
            }
        } else if frame.get("usageMetadata").is_none() && frame.get("promptFeedback").is_none() {
            return Err(self.malformed("chunk has no candidates, promptFeedback or usageMetadata"));
        }
        let reported = &frame["usageMetadata"];
        if present(reported) {
            if reported.as_object().is_none() {
                return Err(self.malformed("usageMetadata is not an object"));
            }
            let n = |key| count(self.wire, reported, key);
            let input = sum_known(&[n("promptTokenCount")?, n("toolUsePromptTokenCount")?]);
            let thoughts = n("thoughtsTokenCount")?;
            let output = sum_known(&[n("candidatesTokenCount")?, thoughts]);
            if let Some(u) = normalized_usage(&[
                ("inputTokens", input),
                ("outputTokens", output),
                (
                    "totalTokens",
                    n("totalTokenCount")?.or(input.zip(output).map(|(a, b)| a + b)),
                ),
                ("cachedInputTokens", n("cachedContentTokenCount")?),
                ("reasoningTokens", thoughts),
            ]) {
                self.usage = Some(u);
            }
        }
        Ok(events)
    }

    fn gemini_candidate(&mut self, candidate: &Json, events: &mut Vec<Value>) -> Result<()> {
        if candidate.as_object().is_none() {
            return Err(self.malformed("candidate is not an object"));
        }
        if candidate
            .get("index")
            .is_some_and(|i| i.number() != Some(0.0))
        {
            return Err(self.malformed("unexpected candidate index"));
        }
        let content = &candidate["content"];
        if present(content) {
            if content.as_object().is_none() {
                return Err(self.malformed("candidate.content is not an object"));
            }
            let parts = &content["parts"];
            if present(parts) && parts.array().is_none() {
                return Err(self.malformed("content.parts is not an array"));
            }
            for part in parts.items() {
                self.gemini_part(part, events)?;
            }
        }
        let raw = &candidate["finishReason"];
        if !present(raw) || raw.text() == "FINISH_REASON_UNSPECIFIED" {
            return Ok(());
        }
        let raw = raw
            .string()
            .ok_or_else(|| self.malformed("finishReason is not a string"))?;
        if let Some(prev) = &self.raw {
            if prev != raw {
                return Err(self.malformed("conflicting finishReason"));
            }
            return Ok(());
        }
        match raw {
            "SAFETY"
            | "RECITATION"
            | "BLOCKLIST"
            | "PROHIBITED_CONTENT"
            | "SPII"
            | "IMAGE_SAFETY"
            | "IMAGE_PROHIBITED_CONTENT"
            | "IMAGE_RECITATION" => {
                return Err(self.gemini_block(true, raw, candidate["finishMessage"].text()))
            }
            "MALFORMED_FUNCTION_CALL" | "UNEXPECTED_TOOL_CALL" | "TOO_MANY_TOOL_CALLS" => {
                let mut error =
                    self.malformed(format!("the model made an unusable tool call ({raw})"));
                error.retryable = raw != "TOO_MANY_TOOL_CALLS";
                return Err(error);
            }
            _ => {}
        }
        let reason = match raw {
            "STOP" if self.calls.is_empty() => "stop",
            "STOP" => "tool_calls",
            "MAX_TOKENS" => "length",
            _ => "other",
        };
        events.push(self.stop(raw, reason));
        Ok(())
    }

    fn gemini_part(&mut self, part: &Json, events: &mut Vec<Value>) -> Result<()> {
        let map = part
            .as_object()
            .ok_or_else(|| self.malformed("part is not an object"))?;
        for key in ["text", "thoughtSignature"] {
            if part.get(key).is_some_and(|v| v.string().is_none()) {
                return Err(self.malformed(format!("part.{key} is not a string")));
            }
        }
        if part.get("thought").is_some_and(|v| v.boolean().is_none()) {
            return Err(self.malformed("part.thought is not a boolean"));
        }
        if let Some(key) = map.keys().find(|k| {
            !["text", "thought", "functionCall", "thoughtSignature"].contains(&k.as_str())
        }) {
            return Err(self.malformed(format!("unsupported part kind \"{}\"", prefix(key, 40))));
        }
        if self.raw.is_some()
            && (!part["text"].text().is_empty() || part.get("functionCall").is_some())
        {
            return Err(self.malformed("content after finishReason"));
        }
        events.extend(self.add_text(part["text"].text(), part["thought"].boolean() == Some(true)));
        if let Some(call) = part.get("functionCall") {
            let name = call["name"].text();
            if name.is_empty() {
                return Err(self.malformed("functionCall lacks a name"));
            }
            let args = &call["args"];
            let raw = if !present(args) {
                "{}".to_owned()
            } else {
                if args.as_object().is_none() {
                    return Err(self.malformed("functionCall.args is not an object"));
                }
                args.encode()
            };
            let mut id = format!("call_{}", self.calls.len());
            if let Some(signature) = part["thoughtSignature"].string() {
                id.push('~');
                id.push_str(signature);
            }
            let (index, event) = self.add_tool(&id, name)?;
            events.push(event);
            events.extend(self.append_arguments(index, &raw, true)?);
        }
        Ok(())
    }

    fn gemini_block(&self, candidate: bool, reason: &str, detail: &str) -> ProviderError {
        let source = if candidate { "response" } else { "prompt" };
        let reason = prefix(&self.redact.redact(reason), 100);
        let mut message = format!("{source} blocked by Gemini ({reason})");
        if !detail.is_empty() {
            message.push_str(&format!(": {}", prefix(&self.redact.redact(detail), 500)));
        }
        let mut error = ProviderError::new(ErrorKind::InvalidRequest, message);
        error.code = Some(reason);
        error.content_filtered = true;
        if candidate {
            error.partial = Some(Box::new(self.partial()));
        }
        error
    }
}
