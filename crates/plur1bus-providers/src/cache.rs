//! Prompt-cache wire markers and affinity. The rendered segments come from the caller.

use crate::ordered::obj;
use crate::request::responses_call_id;
use crate::{Json, Wire};
use icu_normalizer::ComposingNormalizerBorrowed;
use plur1bus_tokens::cache_profiles::CacheAffinity;
pub use plur1bus_tokens::cache_profiles::{CacheProfileTable, CacheRoute};
use ureq::http::{HeaderMap, HeaderName, HeaderValue};

#[derive(Clone, Copy)]
pub struct CacheInput<'a> {
    pub table: &'a CacheProfileTable,
    pub route: &'a CacheRoute,
    pub prompt: &'a Json,
}

fn for_wire(wires: Option<&[String]>, wire: &str) -> bool {
    wires.is_none_or(|wires| wires.iter().any(|candidate| candidate == wire))
}

impl Wire {
    pub fn name(self) -> &'static str {
        match self {
            Self::ChatCompletions => "chat_completions",
            Self::AnthropicMessages => "anthropic_messages",
            Self::CodexResponses => "codex_responses",
            Self::Gemini => "gemini",
        }
    }
}

pub fn emit(wire: Wire, body: &mut Json, headers: &mut HeaderMap, context: CacheInput<'_>) {
    let CacheInput {
        table,
        route,
        prompt,
    } = context;
    if wire == Wire::AnthropicMessages {
        anthropic(body, prompt);
    }
    let model = body["model"].string().unwrap_or(prompt["model"].text());
    let profile = table.find_cache_profile(model, route);
    if route.gateway.as_deref() == Some("openrouter") {
        let gateway = table.openrouter();
        for affinity in &gateway.affinity {
            if for_wire(affinity.wires.as_deref(), wire.name()) {
                apply_affinity(affinity, prompt["session_id"].text(), body, headers);
            }
        }
        if wire == Wire::ChatCompletions
            && profile.row.is_some_and(|row| {
                row.mechanism == "explicit"
                    && gateway
                        .marker_providers
                        .as_ref()
                        .is_some_and(|p| p.contains(&row.provider))
            })
        {
            chat(body, prompt);
        }
        return;
    }
    let Some(row) = profile
        .row
        .filter(|row| route.vendor.as_ref() == Some(&row.provider))
    else {
        return;
    };
    for affinity in &row.affinity {
        if for_wire(affinity.wires.as_deref(), wire.name()) {
            apply_affinity(affinity, prompt["session_id"].text(), body, headers);
        }
    }
    if row.class == "implicit-ttl-tier" {
        let requested = prompt["cache"]["ttl"].text();
        let mut ttls = row
            .ttls
            .iter()
            .filter(|ttl| for_wire(ttl.wires.as_deref(), wire.name()));
        let first = ttls.next();
        let chosen = first
            .filter(|ttl| ttl.ttl == requested)
            .or_else(|| ttls.find(|ttl| ttl.ttl == requested))
            .or(first);
        if let Some(ttl) = chosen {
            match wire {
                Wire::AnthropicMessages if body.get("cache_control").is_none() => body.set(
                    "cache_control",
                    obj!("type": "ephemeral", "ttl": ttl.ttl.as_str()),
                ),
                Wire::ChatCompletions | Wire::CodexResponses
                    if body.get("prompt_cache_options").is_none() =>
                {
                    body.set(
                        "prompt_cache_options",
                        obj!("mode": "implicit", "ttl": ttl.ttl.as_str()),
                    )
                }
                _ => {}
            }
        }
    }
    if wire == Wire::CodexResponses
        && row.provider == "openai"
        && row.class == "explicit-breakpoints"
        && route.platform.as_deref().unwrap_or("first-party") == "first-party"
    {
        responses(body, prompt);
    }
}

fn apply_affinity(affinity: &CacheAffinity, id: &str, body: &mut Json, headers: &mut HeaderMap) {
    let value = if let Some(max) = affinity.max_length {
        String::from_utf16_lossy(&id.encode_utf16().take(max as usize).collect::<Vec<_>>())
    } else {
        id.to_owned()
    };
    if affinity.location == "header" {
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(affinity.field.as_bytes()),
            HeaderValue::from_str(&value),
        ) {
            headers.entry(name).or_insert(value);
        }
        return;
    }
    let mut path = affinity.field.split('.').peekable();
    let mut current = body;
    while let Some(key) = path.next() {
        if current.as_object().is_none() {
            return;
        }
        if path.peek().is_none() {
            if current.get(key).is_none() {
                current.set(key, value);
            }
            return;
        }
        if current.get(key).is_none() {
            current.set(key, Json::object());
        }
        let Some(child) = current.get_mut(key) else {
            return;
        };
        current = child;
    }
}

#[derive(Clone, Copy)]
struct Address(usize, usize);

struct Slot {
    address: Address,
    kind: &'static str,
    identity: Option<String>,
}

fn slot(address: Address, kind: &'static str, id: Option<&str>) -> Slot {
    Slot {
        address,
        kind,
        identity: id.map(str::to_owned),
    }
}

fn text_slot(address: Address, text: Option<&str>) -> Slot {
    let normalized = text.map(|s| {
        ComposingNormalizerBorrowed::new_nfc()
            .normalize(s)
            .replace("\r\n", "\n")
            .replace('\r', "\n")
    });
    Slot {
        address,
        kind: "text",
        identity: normalized,
    }
}

fn align(prompt: &Json, slots: &[Slot], wire_id: impl Fn(&str) -> String) -> Vec<Option<Address>> {
    let mut cursor = 0;
    prompt["segments"]
        .items()
        .iter()
        .map(|segment| {
            if segment["zone"].text() != "conversation" {
                return None;
            }
            let (kind, identity) = match segment["kind"].text() {
                "tool_use" => ("tool_use", segment["id"].string().map(&wire_id)),
                "tool_result" => ("tool_result", segment["id"].string().map(&wire_id)),
                _ => ("text", segment["text"].string().map(str::to_owned)),
            };
            let relative = slots[cursor..].iter().position(|slot| {
                slot.kind == kind
                    && slot.identity == identity
                    && (kind != "text" || identity.is_some())
            })?;
            let at = cursor + relative;
            cursor = at + 1;
            Some(slots[at].address)
        })
        .collect()
}

fn indices(value: &Json) -> Vec<usize> {
    value
        .items()
        .iter()
        .enumerate()
        .filter_map(|(index, segment)| stable(segment).then_some(index))
        .collect()
}

fn stable(segment: &Json) -> bool {
    matches!(segment["zone"].text(), "system" | "memory")
}

fn tool_id(id: &str) -> String {
    id.encode_utf16()
        .map(|c| match u8::try_from(c) {
            Ok(c) if c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-') => c as char,
            _ => '_',
        })
        .collect()
}

fn listed_mut<'a>(body: &'a mut Json, key: &str, index: usize) -> Option<&'a mut Json> {
    body.get_mut(key)?.array_mut()?.get_mut(index)
}

fn last_mut<'a>(body: &'a mut Json, key: &str) -> Option<&'a mut Json> {
    body.get_mut(key)?.array_mut()?.last_mut()
}

fn segments(prompt: &Json) -> impl Iterator<Item = (usize, &Json, &str)> {
    prompt["breakpoints"].items().iter().filter_map(|point| {
        let index = point["segment"]
            .number()
            .filter(|&n| crate::request::safe_integer(n, 0.0))? as usize;
        Some((
            index,
            prompt["segments"].items().get(index)?,
            point["ttl"].text(),
        ))
    })
}

fn marker(ttl: &str) -> Json {
    let mut marker = obj!("type": "ephemeral");
    if ttl == "1h" {
        marker.set("ttl", ttl);
    }
    marker
}

fn anthropic(body: &mut Json, prompt: &Json) {
    for key in ["tools", "system"] {
        if let Some(items) = body.get_mut(key).and_then(Json::array_mut) {
            for item in items {
                item.remove("cache_control");
            }
        }
    }
    if let Some(messages) = body.get_mut("messages").and_then(Json::array_mut) {
        for message in messages {
            if let Some(blocks) = message.get_mut("content").and_then(Json::array_mut) {
                for block in blocks {
                    block.remove("cache_control");
                }
            }
        }
    }
    let mut slots = Vec::new();
    for (i, message) in body["messages"].items().iter().enumerate() {
        for (j, part) in message["content"].items().iter().enumerate() {
            let address = Address(i, j);
            slots.push(match part["type"].text() {
                "tool_use" => slot(address, "tool_use", part["id"].string()),
                "tool_result" => slot(address, "tool_result", part["tool_use_id"].string()),
                "text" => text_slot(address, part["text"].string()),
                _ => text_slot(address, None),
            });
        }
    }
    let stable_segments = indices(&prompt["segments"]);
    let positioned = align(prompt, &slots, tool_id);
    for (at, segment, ttl) in segments(prompt) {
        let block = match segment["zone"].text() {
            "tools" => last_mut(body, "tools"),
            "system" | "memory" => stable_segments
                .iter()
                .position(|&i| i == at)
                .and_then(|i| listed_mut(body, "system", i)),
            "conversation" => positioned[at].and_then(|Address(i, j)| {
                listed_mut(body, "messages", i).and_then(|msg| listed_mut(msg, "content", j))
            }),
            _ => None,
        };
        if let Some(block) = block {
            block.set("cache_control", marker(ttl));
        }
    }
}

fn concat_parts(parts: &[Json], kinds: &[&str]) -> String {
    parts
        .iter()
        .filter(|p| kinds.contains(&p["type"].text()))
        .map(|p| p["text"].text())
        .collect()
}

fn mark_content(
    message: &mut Json,
    key: &str,
    part_type: &str,
    marker_key: &str,
    mark: Json,
    accepts_string: bool,
) -> bool {
    if accepts_string && message[key].string().is_some() {
        let part = obj!("type": part_type, "text": message[key].clone());
        message.set(key, vec![part]);
    }
    let Some(last) = message
        .get_mut(key)
        .and_then(Json::array_mut)
        .and_then(|parts| {
            parts
                .iter_mut()
                .rev()
                .find(|part| part["type"].text() == part_type)
        })
    else {
        return false;
    };
    last.set(marker_key, mark);
    true
}

fn chat(body: &mut Json, prompt: &Json) {
    let stable_segments = indices(&prompt["segments"]);
    let mut system = Vec::new();
    let mut slots = Vec::new();
    for (i, message) in body["messages"].items().iter().enumerate() {
        let address = Address(i, 0);
        match message["role"].text() {
            "system" | "developer" => system.push(i),
            "tool" => slots.push(slot(
                address,
                "tool_result",
                message["tool_call_id"].string(),
            )),
            role => {
                let content = &message["content"];
                let text = content
                    .string()
                    .map(str::to_owned)
                    .unwrap_or_else(|| concat_parts(content.items(), &["text"]));
                if !text.is_empty() {
                    slots.push(text_slot(address, Some(&text)));
                }
                if role == "assistant" {
                    for call in message["tool_calls"].items() {
                        slots.push(slot(address, "tool_use", call["id"].string()));
                    }
                }
            }
        }
    }
    let positioned = align(prompt, &slots, str::to_owned);
    for (at, segment, ttl) in segments(prompt) {
        if segment["zone"].text() == "tools" {
            if let Some(tool) = last_mut(body, "tools") {
                tool.set("cache_control", marker(ttl));
            }
            continue;
        }
        let message = match segment["zone"].text() {
            "system" | "memory" => stable_segments
                .iter()
                .position(|&i| i == at)
                .and_then(|i| system.get(i))
                .copied(),
            "conversation" => positioned[at].map(|Address(i, _)| i),
            _ => None,
        };
        if let Some(message) = message
            .and_then(|i| listed_mut(body, "messages", i))
            .filter(|msg| msg["role"].text() != "assistant")
        {
            mark_content(
                message,
                "content",
                "text",
                "cache_control",
                marker(ttl),
                true,
            );
        }
    }
}

fn responses(body: &mut Json, prompt: &Json) {
    let mark = || obj!("mode": "explicit");
    let stable = indices(&prompt["segments"]);
    let marks: std::collections::HashSet<_> = segments(prompt)
        .filter(|(_, s, _)| self::stable(s))
        .map(|(i, _, _)| i)
        .collect();
    let mut landed = 0;
    if !marks.is_empty()
        && body["instructions"].string().is_some_and(|text| {
            text == stable
                .iter()
                .map(|&i| prompt["segments"].items()[i]["text"].text())
                .collect::<Vec<_>>()
                .join("\n\n")
        })
    {
        if let Some(input) = body.get_mut("input").and_then(Json::array_mut) {
            let parts = stable.iter().map(|&i| {
                let mut part = obj!("type": "input_text", "text": prompt["segments"].items()[i]["text"].clone());
                if marks.contains(&i) { part.set("prompt_cache_breakpoint", mark()); }
                part
            }).collect::<Vec<_>>();
            input.insert(
                0,
                obj!("type": "message", "role": "developer", "content": parts),
            );
            body.remove("instructions");
            landed += marks.len();
        }
    }
    let mut slots = Vec::new();
    for (i, item) in body["input"].items().iter().enumerate() {
        let address = Address(i, 0);
        match item["type"].text() {
            "function_call" => slots.push(slot(address, "tool_use", item["call_id"].string())),
            "function_call_output" => {
                slots.push(slot(address, "tool_result", item["call_id"].string()))
            }
            "message" if !matches!(item["role"].text(), "system" | "developer") => {
                slots.push(text_slot(
                    address,
                    Some(&concat_parts(
                        item["content"].items(),
                        &["input_text", "output_text"],
                    )),
                ));
            }
            _ => {}
        }
    }
    let positioned = align(prompt, &slots, responses_call_id);
    for (at, segment, _) in segments(prompt).filter(|(_, s, _)| s["zone"].text() == "conversation")
    {
        let Some(item) = positioned[at].and_then(|Address(i, _)| listed_mut(body, "input", i))
        else {
            continue;
        };
        if segment["kind"].text() == "tool_result" && item["output"].string().is_some() {
            landed += usize::from(mark_content(
                item,
                "output",
                "input_text",
                "prompt_cache_breakpoint",
                mark(),
                true,
            ));
        } else if segment["kind"].text() != "tool_use" && item["role"].text() == "user" {
            landed += usize::from(mark_content(
                item,
                "content",
                "input_text",
                "prompt_cache_breakpoint",
                mark(),
                false,
            ));
        }
    }
    if landed > 0 || prompt["breakpoints"].items().is_empty() {
        body.set("prompt_cache_options", mark());
    }
}
