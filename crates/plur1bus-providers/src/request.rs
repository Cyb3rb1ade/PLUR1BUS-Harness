use crate::ordered::obj;
use crate::{Json, ProviderError};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;
use url::Url;

type Result<T> = std::result::Result<T, ProviderError>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Wire {
    ChatCompletions,
    AnthropicMessages,
    CodexResponses,
    Gemini,
}

#[derive(Clone, Debug)]
pub struct SignedThinking {
    pub model: String,
    pub blocks: Vec<Json>,
}

#[derive(Clone, Debug)]
pub struct RequestOptions {
    pub include_usage: bool,
    pub max_completion_tokens: bool,
    pub anthropic_max_tokens: u64,
    pub anthropic_cache: Option<Json>,
    pub signed_thinking: BTreeMap<usize, SignedThinking>,
    pub chatgpt_plan: bool,
    pub responses_store: bool,
    pub responses_effort: Option<String>,
    pub responses_summary: Option<String>,
}

impl Default for RequestOptions {
    fn default() -> Self {
        Self {
            include_usage: true,
            max_completion_tokens: false,
            anthropic_max_tokens: 4096,
            anthropic_cache: None,
            signed_thinking: BTreeMap::new(),
            chatgpt_plan: false,
            responses_store: false,
            responses_effort: None,
            responses_summary: None,
        }
    }
}

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

pub(crate) fn safe_integer(n: f64, minimum: f64) -> bool {
    (minimum..=MAX_SAFE_INTEGER).contains(&n) && n.fract() == 0.0
}

pub(crate) fn blank(text: &str) -> bool {
    text.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
        .is_empty()
}

fn tool_name(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

fn invalid(message: impl std::fmt::Display) -> ProviderError {
    ProviderError::invalid(message)
}

fn validate(req: &Json) -> Result<()> {
    if blank(req["model"].text()) {
        return Err(invalid("model is required"));
    }
    let messages = req["messages"].items();
    if messages.is_empty() {
        return Err(invalid("messages must not be empty"));
    }
    for (i, message) in messages.iter().enumerate() {
        let at = format!("messages[{i}]");
        let content = &message["content"];
        match message["role"].text() {
            "system" | "developer" if content.string().is_none() => {
                return Err(invalid(format!("{at}.content must be a string")))
            }
            "user" if content.string().is_none() => {
                if content.items().is_empty() {
                    return Err(invalid(format!(
                        "{at}.content must be a string or a non-empty part list"
                    )));
                }
                if content
                    .items()
                    .iter()
                    .any(|part| !matches!(part["type"].text(), "text" | "image_url"))
                {
                    return Err(invalid(format!("{at} has an unknown content part")));
                }
            }
            "assistant" => {
                if message["toolCalls"].items().is_empty() && matches!(content, Json::Null) {
                    return Err(invalid(format!("{at} needs content or toolCalls")));
                }
                for call in message["toolCalls"].items() {
                    if call["id"].text().is_empty()
                        || !tool_name(call["name"].text())
                        || call["arguments"].string().is_none()
                    {
                        return Err(invalid(format!("{at} has a malformed tool call")));
                    }
                }
            }
            "tool" if message["toolCallId"].text().is_empty() || content.string().is_none() => {
                return Err(invalid(format!("{at} needs toolCallId and string content")))
            }
            "system" | "developer" | "user" | "tool" => {}
            _ => return Err(invalid(format!("{at} has an unknown role"))),
        }
    }
    let mut tools = HashSet::new();
    for tool in req["tools"].items() {
        let name = tool["name"].text();
        if !tool_name(name) {
            return Err(invalid(format!(
                "tool name \"{name}\" is not 1-64 of [a-zA-Z0-9_-]"
            )));
        }
        if !tools.insert(name) {
            return Err(invalid(format!("duplicate tool \"{name}\"")));
        }
    }
    if let Some(choice) = req.get("toolChoice") {
        if tools.is_empty() {
            return Err(invalid("toolChoice needs tools"));
        }
        if choice.as_object().is_some() && !tools.contains(choice["name"].text()) {
            return Err(invalid(format!(
                "toolChoice names undeclared tool \"{}\"",
                choice["name"].text()
            )));
        }
        if choice.as_object().is_none() && !matches!(choice.text(), "auto" | "none" | "required") {
            return Err(invalid(
                "toolChoice must name a tool or use auto, none or required",
            ));
        }
    }
    if let Some(parallel) = req.get("parallelToolCalls") {
        if tools.is_empty() {
            return Err(invalid("parallelToolCalls needs tools"));
        }
        if parallel.boolean().is_none() {
            return Err(invalid("parallelToolCalls must be a boolean"));
        }
    }
    if req
        .get("maxTokens")
        .is_some_and(|v| !v.number().is_some_and(|n| safe_integer(n, 1.0)))
    {
        return Err(invalid("maxTokens must be a positive integer"));
    }
    if req
        .get("temperature")
        .is_some_and(|v| !v.number().is_some_and(|n| (0.0..=2.0).contains(&n)))
    {
        return Err(invalid("temperature must be within 0..2"));
    }
    if req
        .get("topP")
        .is_some_and(|v| !v.number().is_some_and(|n| n > 0.0 && n <= 1.0))
    {
        return Err(invalid("topP must be within (0, 1]"));
    }
    if req.get("stop").is_some_and(|v| {
        !v.array().is_some_and(|items| {
            items.len() <= 4 && items.iter().all(|item| !item.text().is_empty())
        })
    }) {
        return Err(invalid("stop takes up to 4 non-empty strings"));
    }
    if req["responseFormat"]["type"].text() == "json_schema"
        && req["responseFormat"]["name"].text().is_empty()
    {
        return Err(invalid("json_schema response format needs a name"));
    }
    Ok(())
}

fn copy(out: &mut Json, new_key: &str, from: &Json, key: &str) {
    if let Some(value) = from.get(key) {
        out.set(new_key, value.clone());
    }
}

fn sampling(body: &mut Json, req: &Json, fields: &[(&str, &str)]) {
    for (key, from) in fields {
        copy(body, key, req, from);
    }
}

fn reasoning<'a>(
    req: &'a Json,
    wire: &str,
    allowed: &[&str],
) -> Result<Option<(&'a str, &'a Json)>> {
    let Some(value) = req.get("reasoning") else {
        return Ok(None);
    };
    let param = value["vendorParam"].string().unwrap_or("undefined");
    if value
        .get("adaptiveThinking")
        .is_some_and(|v| v.boolean() != Some(true) || param != "output_config.effort")
    {
        return Err(invalid(
            "adaptiveThinking requires Anthropic output_config.effort",
        ));
    }
    if !allowed.contains(&param) {
        return Err(invalid(format!(
            "reasoning parameter {param} is not supported by the {wire} wire"
        )));
    }
    let value = &value["value"];
    let bad = match param {
        "thinking.budget_tokens" | "thinkingConfig.thinkingBudget"
            if !value.number().is_some_and(|n| safe_integer(n, 0.0)) =>
        {
            Some("a non-negative integer")
        }
        "chat_template_kwargs.enable_thinking" if value.boolean().is_none() => Some("a boolean"),
        "thinking.budget_tokens"
        | "thinkingConfig.thinkingBudget"
        | "chat_template_kwargs.enable_thinking" => None,
        _ if !(1..=16).contains(&value.text().len())
            || !value.text().bytes().all(|b| b.is_ascii_lowercase()) =>
        {
            Some("a short lowercase word")
        }
        _ => None,
    };
    if let Some(expectation) = bad {
        return Err(invalid(format!("{param} must be {expectation}")));
    }
    Ok(Some((param, value)))
}

impl Wire {
    /// Build an ordered provider payload. The body can be passed through the cache emitter before encoding.
    pub fn request(self, req: &Json, stream: bool, options: &RequestOptions) -> Result<Json> {
        validate(req)?;
        match self {
            Self::ChatCompletions => chat(req, stream, options),
            Self::AnthropicMessages => anthropic(req, stream, options),
            Self::CodexResponses => responses(req, stream, options),
            Self::Gemini => gemini(req),
        }
    }
}

fn chat_message(message: &Json) -> Json {
    let role = message["role"].text();
    let content = &message["content"];
    if role == "tool" {
        return obj!("role": role, "tool_call_id": message["toolCallId"].clone(), "content": content.clone());
    }
    let content = if role == "user" && content.array().is_some() {
        content
            .items()
            .iter()
            .map(|part| {
                if part["type"].text() == "text" {
                    return obj!("type": "text", "text": part["text"].clone());
                }
                let mut image = obj!("url": part["url"].clone());
                copy(&mut image, "detail", part, "detail");
                obj!("type": "image_url", "image_url": image)
            })
            .collect::<Vec<_>>()
            .into()
    } else {
        content.clone()
    };
    let mut out = obj!("role": role, "content": content);
    let calls = message["toolCalls"].items();
    if role == "assistant" && !calls.is_empty() {
        out.set("tool_calls", calls.iter().map(|c| obj!(
            "id": c["id"].clone(), "type": "function",
            "function": obj!("name": c["name"].clone(), "arguments": c["arguments"].clone())
        )).collect::<Vec<_>>());
    }
    out
}

fn chat(req: &Json, stream: bool, options: &RequestOptions) -> Result<Json> {
    let directive = reasoning(
        req,
        "chat_completions",
        &[
            "reasoning_effort",
            "reasoning.effort",
            "chat_template_kwargs.enable_thinking",
        ],
    )?;
    let mut body = obj!("model": req["model"].clone(), "messages": req["messages"].items().iter().map(chat_message).collect::<Vec<_>>());
    if !req["tools"].items().is_empty() {
        body.set(
            "tools",
            req["tools"]
                .items()
                .iter()
                .map(|tool| {
                    let mut function = obj!("name": tool["name"].clone());
                    sampling(
                        &mut function,
                        tool,
                        &[
                            ("description", "description"),
                            ("parameters", "parameters"),
                            ("strict", "strict"),
                        ],
                    );
                    obj!("type": "function", "function": function)
                })
                .collect::<Vec<_>>(),
        );
    }
    if let Some(choice) = req.get("toolChoice") {
        body.set(
            "tool_choice",
            if choice.string().is_some() {
                choice.clone()
            } else {
                obj!("type": "function", "function": obj!("name": choice["name"].clone()))
            },
        );
    }
    sampling(
        &mut body,
        req,
        &[
            ("parallel_tool_calls", "parallelToolCalls"),
            (
                if options.max_completion_tokens {
                    "max_completion_tokens"
                } else {
                    "max_tokens"
                },
                "maxTokens",
            ),
            ("temperature", "temperature"),
            ("top_p", "topP"),
            ("stop", "stop"),
        ],
    );
    if let Some(format) = req.get("responseFormat") {
        let kind = format["type"].text();
        let mut wrapper = obj!("type": kind);
        if kind == "json_schema" {
            let mut schema =
                obj!("name": format["name"].clone(), "schema": format["schema"].clone());
            copy(&mut schema, "strict", format, "strict");
            wrapper.set("json_schema", schema);
        }
        body.set("response_format", wrapper);
    }
    if let Some((param, value)) = directive {
        match param {
            "reasoning_effort" => body.set("reasoning_effort", value.clone()),
            "reasoning.effort" => body.set("reasoning", obj!("effort": value.clone())),
            _ => body.set(
                "chat_template_kwargs",
                obj!("enable_thinking": value.clone()),
            ),
        }
    }
    body.set("stream", stream);
    if stream && options.include_usage {
        body.set("stream_options", obj!("include_usage": true));
    }
    Ok(body)
}

pub(crate) fn responses_call_id(id: &str) -> String {
    if id.encode_utf16().count() <= 64 {
        return id.to_owned();
    }
    let mut out = String::from("call_h_");
    for byte in &Sha256::digest(id.as_bytes())[..16] {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn valid_base64(raw: &str) -> bool {
    let data = raw.trim_end_matches('=');
    !data.is_empty()
        && raw.len() - data.len() <= 2
        && data
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/'))
}

fn image_data(url: &str) -> Option<(&str, &str)> {
    let (prefix, data) = url.split_once(',')?;
    let media = prefix.strip_prefix("data:")?.strip_suffix(";base64")?;
    valid_base64(data).then_some((media, data))
}

fn http_image(url: &str) -> bool {
    Url::parse(url).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}

fn common_image_data(url: &str) -> Option<(&str, &str)> {
    let (media, data) = image_data(url)?;
    matches!(
        media,
        "image/jpeg" | "image/png" | "image/gif" | "image/webp"
    )
    .then_some((media, data))
}

fn responses_part(part: &Json, at: &str) -> Result<Json> {
    if part["type"].text() == "text" {
        return Ok(obj!("type": "input_text", "text": part["text"].clone()));
    }
    let url = part["url"].text();
    if !http_image(url) && common_image_data(url).is_none() {
        return Err(invalid(format!("{at} has an image that is neither an http(s) URL nor a base64 data URL of jpeg, png, gif or webp")));
    }
    let mut out = obj!("type": "input_image", "image_url": url);
    copy(&mut out, "detail", part, "detail");
    Ok(out)
}

fn responses(req: &Json, stream: bool, options: &RequestOptions) -> Result<Json> {
    if req.get("stop").is_some() {
        return Err(invalid(
            "stop sequences are not supported by the Responses API",
        ));
    }
    let own = &req["providerOptions"]["responses"];
    let directive = reasoning(req, "Responses", &["reasoning.effort"])?;
    let allowed = ["minimal", "low", "medium", "high"];
    if directive.is_some_and(|(_, v)| {
        !allowed.contains(&v.text()) && !["none", "xhigh"].contains(&v.text())
    }) {
        return Err(invalid(
            "reasoning.effort must be none, minimal, low, medium, high or xhigh",
        ));
    }
    let configured = own["reasoningEffort"].string().or_else(|| {
        if directive.is_none() {
            options.responses_effort.as_deref()
        } else {
            None
        }
    });
    if configured.is_some_and(|value| !allowed.contains(&value)) {
        return Err(invalid(
            "reasoningEffort must be minimal, low, medium or high",
        ));
    }
    let effort = own["reasoningEffort"]
        .string()
        .or_else(|| directive.map(|(_, v)| v.text()))
        .or(options.responses_effort.as_deref());
    let summary = own["reasoningSummary"]
        .string()
        .or(options.responses_summary.as_deref());
    if summary.is_some_and(|value| !["auto", "concise", "detailed"].contains(&value)) {
        return Err(invalid(
            "reasoningSummary must be auto, concise or detailed",
        ));
    }
    if options.chatgpt_plan {
        for name in ["maxTokens", "temperature", "topP"] {
            if req.get(name).is_some() {
                return Err(invalid(format!(
                    "{name} is not accepted by the chatgpt_plan profile"
                )));
            }
        }
        if own["store"].boolean() == Some(true) {
            return Err(invalid(
                "store:true is not accepted by the chatgpt_plan profile (it is stateless)",
            ));
        }
    }
    let mut input = Vec::new();
    let mut instructions = Vec::new();
    let mut open = indexmap::IndexSet::new();
    for (index, message) in req["messages"].items().iter().enumerate() {
        let content = &message["content"];
        let role = message["role"].text();
        let at = format!("messages[{index}]");
        match role {
            "system" | "developer" if !blank(content.text()) => instructions.push(content.text()),
            "system" | "developer" => {}
            "user" => {
                let parts = if let Some(text) = content.string() {
                    vec![obj!("type": "input_text", "text": text)]
                } else {
                    content
                        .items()
                        .iter()
                        .map(|part| responses_part(part, &at))
                        .collect::<Result<Vec<_>>>()?
                };
                input.push(obj!("type": "message", "role": role, "content": parts));
            }
            "assistant" => {
                if !blank(content.text()) {
                    input.push(obj!("type": "message", "role": role, "content": vec![obj!("type": "output_text", "text": content.text())]));
                } else if message["toolCalls"].items().is_empty() {
                    return Err(invalid(format!(
                        "{at} is empty: an assistant message needs text or tool calls"
                    )));
                }
                for call in message["toolCalls"].items() {
                    let id = responses_call_id(call["id"].text());
                    open.insert(id.clone());
                    input.push(obj!("type": "function_call", "call_id": id, "name": call["name"].clone(), "arguments": call["arguments"].clone()));
                }
            }
            "tool" => {
                let id = responses_call_id(message["toolCallId"].text());
                if !open.shift_remove(&id) {
                    return Err(invalid(format!(
                        "tool result for {id} does not answer an earlier tool call"
                    )));
                }
                input.push(
                    obj!("type": "function_call_output", "call_id": id, "output": content.clone()),
                );
            }
            _ => {}
        }
    }
    if input.is_empty() {
        return Err(invalid("the request needs at least one non-system message"));
    }
    if options.chatgpt_plan && instructions.is_empty() {
        return Err(invalid(
            "the chatgpt_plan profile requires instructions (a system or developer message)",
        ));
    }
    if let Some(id) = open.first() {
        return Err(invalid(format!("tool call {id} has no tool result")));
    }

    let mut body = obj!("model": req["model"].clone());
    if !instructions.is_empty() {
        body.set("instructions", instructions.join("\n\n"));
    }
    body.set("input", input);
    if !req["tools"].items().is_empty() {
        body.set(
            "tools",
            req["tools"]
                .items()
                .iter()
                .map(|tool| {
                    let mut out = obj!("type": "function", "name": tool["name"].clone());
                    copy(&mut out, "description", tool, "description");
                    out.set(
                        "parameters",
                        tool.get("parameters").cloned().unwrap_or_else(
                            || obj!("type": "object", "properties": Json::object()),
                        ),
                    );
                    out.set("strict", tool["strict"].boolean().unwrap_or(false));
                    out
                })
                .collect::<Vec<_>>(),
        );
    }
    if let Some(choice) = req.get("toolChoice") {
        body.set(
            "tool_choice",
            if choice.string().is_some() {
                choice.clone()
            } else {
                obj!("type": "function", "name": choice["name"].clone())
            },
        );
    }
    sampling(
        &mut body,
        req,
        &[
            ("parallel_tool_calls", "parallelToolCalls"),
            ("max_output_tokens", "maxTokens"),
            ("temperature", "temperature"),
            ("top_p", "topP"),
        ],
    );
    if effort.is_some() || summary.is_some() {
        let mut out = Json::object();
        if let Some(effort) = effort {
            out.set("effort", effort);
        }
        if let Some(summary) = summary {
            out.set("summary", summary);
        }
        body.set("reasoning", out);
    }
    if let Some(format) = req
        .get("responseFormat")
        .filter(|format| format["type"].text() != "text")
    {
        let kind = format["type"].text();
        let mut out = obj!("type": kind);
        if kind == "json_schema" {
            sampling(
                &mut out,
                format,
                &[("name", "name"), ("schema", "schema"), ("strict", "strict")],
            );
        }
        body.set("text", obj!("format": out));
    }
    body.set(
        "store",
        !options.chatgpt_plan && own["store"].boolean().unwrap_or(options.responses_store),
    );
    body.set("stream", options.chatgpt_plan || stream);
    Ok(body)
}

fn tool_arguments(call: &Json, parse_error: String, not_object: String) -> Result<Json> {
    let value = Json::parse(call["arguments"].text()).map_err(|_| invalid(parse_error))?;
    if value.as_object().is_none() {
        return Err(invalid(not_object));
    }
    Ok(value)
}

#[derive(Default)]
struct ToolIds<'a> {
    taken: HashMap<String, &'a str>,
}

impl<'a> ToolIds<'a> {
    fn wire(&mut self, id: &'a str) -> Result<String> {
        let safe: String = id
            .encode_utf16()
            .map(|c| match u8::try_from(c) {
                Ok(c) if c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_') => char::from(c),
                _ => '_',
            })
            .collect();
        if self
            .taken
            .insert(safe.clone(), id)
            .is_some_and(|owner| owner != id)
        {
            return Err(invalid(
                "two tool call ids collide once rewritten to the Anthropic id alphabet",
            ));
        }
        Ok(safe)
    }
}

fn anthropic_user(content: &Json, at: &str) -> Result<Vec<Json>> {
    let mut out = Vec::new();
    if let Some(text) = content.string() {
        if !blank(text) {
            out.push(obj!("type": "text", "text": text));
        }
    } else {
        for part in content.items() {
            if part["type"].text() == "text" {
                if !blank(part["text"].text()) {
                    out.push(obj!("type": "text", "text": part["text"].clone()));
                }
                continue;
            }
            let url = part["url"].text();
            let image = if let Some((media, data)) = common_image_data(url) {
                obj!("type": "base64", "media_type": media, "data": data)
            } else if http_image(url) {
                obj!("type": "url", "url": url)
            } else {
                return Err(invalid(format!("{at} has an image that is neither an http(s) URL nor a base64 data URL of jpeg, png, gif or webp")));
            };
            out.push(obj!("type": "image", "source": image));
        }
    }
    if out.is_empty() {
        return Err(invalid(format!(
            "{at} is empty (the Messages API refuses blank text)"
        )));
    }
    Ok(out)
}

fn anthropic_assistant<'a>(
    message: &'a Json,
    model: &str,
    signed: Option<&SignedThinking>,
    ids: &mut ToolIds<'a>,
    at: &str,
) -> Result<Vec<Json>> {
    let mut out = Vec::new();
    if let Some(signed) = signed {
        if signed.model != model && !signed.blocks.is_empty() {
            return Err(invalid(
                "original signed thinking blocks belong to a different model",
            ));
        }
        out.clone_from(&signed.blocks);
    }
    if !blank(message["content"].text()) {
        out.push(obj!("type": "text", "text": message["content"].clone()));
    }
    for call in message["toolCalls"].items() {
        let id = ids.wire(call["id"].text())?;
        let input = tool_arguments(
            call,
            format!("{at} has tool call arguments that are not valid JSON"),
            format!("{at} has tool call arguments that are not a JSON object"),
        )?;
        out.push(obj!("type": "tool_use", "id": id, "name": call["name"].clone(), "input": input));
    }
    if out.is_empty() {
        return Err(invalid(format!(
            "{at} is empty: an assistant message needs text or tool calls"
        )));
    }
    Ok(out)
}

fn anthropic_pairing(turns: &[(&str, Vec<Json>)]) -> Result<()> {
    for (index, (role, blocks)) in turns.iter().enumerate() {
        let (mine, mine_key, theirs, their_key, neighbor) = if *role == "assistant" {
            (
                "tool_use",
                "id",
                "tool_result",
                "tool_use_id",
                turns.get(index + 1),
            )
        } else {
            (
                "tool_result",
                "tool_use_id",
                "tool_use",
                "id",
                index.checked_sub(1).and_then(|i| turns.get(i)),
            )
        };
        for block in blocks.iter().filter(|b| b["type"].text() == mine) {
            let id = block[mine_key].text();
            if !neighbor.is_some_and(|(_, other)| {
                other
                    .iter()
                    .any(|b| b["type"].text() == theirs && b[their_key].text() == id)
            }) {
                let message = if *role == "assistant" {
                    format!("tool call {id} has no tool result right after it")
                } else {
                    format!("tool result for {id} does not answer a tool call of the assistant message right before it")
                };
                return Err(invalid(message));
            }
        }
    }
    Ok(())
}

fn anthropic_choice(req: &Json) -> Option<Json> {
    let mut choice = match req.get("toolChoice").map(Json::text) {
        Some("auto") => Some(obj!("type": "auto")),
        Some("required") => Some(obj!("type": "any")),
        Some("none") => return Some(obj!("type": "none")),
        Some(_) => Some(obj!("type": "tool", "name": req["toolChoice"]["name"].clone())),
        None => None,
    };
    if req["parallelToolCalls"].boolean() == Some(false) {
        choice
            .get_or_insert_with(|| obj!("type": "auto"))
            .set("disable_parallel_tool_use", true);
    }
    choice
}

fn anthropic(req: &Json, stream: bool, options: &RequestOptions) -> Result<Json> {
    if req["temperature"].number().is_some_and(|n| n > 1.0) {
        return Err(invalid(
            "temperature must be within 0..1 for the Messages API",
        ));
    }
    if let Some(format) = req
        .get("responseFormat")
        .filter(|f| f["type"].text() != "text")
    {
        return Err(invalid(format!(
            "responseFormat \"{}\" is not supported by the Messages API",
            format["type"].text()
        )));
    }
    let directive = reasoning(
        req,
        "Anthropic Messages",
        &["thinking.budget_tokens", "output_config.effort"],
    )?;
    let mut thinking_budget = 0.0;
    let mut effort = None;
    if let Some((param, value)) = directive {
        if param == "output_config.effort" {
            if !["low", "medium", "high", "xhigh", "max"].contains(&value.text()) {
                return Err(invalid(
                    "output_config.effort must be low, medium, high, xhigh or max",
                ));
            }
            effort = Some(value);
        } else {
            thinking_budget = value.number().unwrap_or_default();
            if thinking_budget > 0.0 {
                if thinking_budget < 1024.0 {
                    return Err(invalid("thinking.budget_tokens must be 0 or at least 1024"));
                }
                if req["temperature"].number().is_some_and(|v| v != 1.0) {
                    return Err(invalid("temperature cannot be set with extended thinking"));
                }
                if req
                    .get("toolChoice")
                    .is_some_and(|v| !matches!(v.text(), "auto" | "none"))
                {
                    return Err(invalid(
                        "a forced tool choice cannot be combined with extended thinking",
                    ));
                }
            }
        }
    }
    let mut system = Vec::new();
    let mut turns: Vec<(&str, Vec<Json>)> = Vec::new();
    let mut ids = ToolIds::default();
    for (index, message) in req["messages"].items().iter().enumerate() {
        let role = message["role"].text();
        let content = &message["content"];
        let at = format!("messages[{index}]");
        let (role, blocks) = match role {
            "system" | "developer" => {
                if !blank(content.text()) {
                    system.push(obj!("type": "text", "text": content.clone()));
                }
                continue;
            }
            "user" => ("user", anthropic_user(content, &at)?),
            "assistant" => (
                "assistant",
                anthropic_assistant(
                    message,
                    req["model"].text(),
                    options.signed_thinking.get(&index),
                    &mut ids,
                    &at,
                )?,
            ),
            _ => {
                let mut out = obj!("type": "tool_result", "tool_use_id": ids.wire(message["toolCallId"].text())?);
                if !content.text().is_empty() {
                    out.set("content", content.clone());
                }
                ("user", vec![out])
            }
        };
        if let Some((last_role, last)) =
            turns.last_mut().filter(|(last_role, _)| *last_role == role)
        {
            debug_assert_eq!(*last_role, role);
            last.extend(blocks);
        } else {
            turns.push((role, blocks));
        }
    }
    if turns.first().is_none_or(|(role, _)| *role != "user") {
        return Err(invalid(
            "the first non-system message must be a user message",
        ));
    }
    for (_, blocks) in turns.iter_mut().filter(|(role, _)| *role == "user") {
        blocks.sort_by_key(|block| block["type"].text() != "tool_result");
    }
    anthropic_pairing(&turns)?;
    let mut tools: Vec<_> = req["tools"]
        .items()
        .iter()
        .map(|tool| {
            let mut out = obj!("name": tool["name"].clone());
            copy(&mut out, "description", tool, "description");
            out.set(
                "input_schema",
                tool.get("parameters")
                    .cloned()
                    .unwrap_or_else(|| obj!("type": "object")),
            );
            copy(&mut out, "strict", tool, "strict");
            out
        })
        .collect();
    if let Some(cache) = req["providerOptions"]["anthropic"]
        .get("cache")
        .or(options.anthropic_cache.as_ref())
    {
        let mut mark = obj!("type": "ephemeral");
        if cache["ttl"].text() == "1h" {
            mark.set("ttl", "1h");
        }
        for (key, last) in [
            ("tools", tools.last_mut()),
            ("system", system.last_mut()),
            (
                "messages",
                turns.last_mut().and_then(|(_, blocks)| blocks.last_mut()),
            ),
        ] {
            if let Some(last) = last.filter(|_| cache[key].boolean() == Some(true)) {
                last.set("cache_control", mark.clone());
            }
        }
    }
    let adaptive = req["reasoning"]["adaptiveThinking"].boolean() == Some(true);
    if adaptive && (req.get("temperature").is_some() || req.get("topP").is_some()) {
        return Err(invalid(
            "sampling controls cannot be combined with adaptive thinking",
        ));
    }
    if adaptive || thinking_budget > 0.0 {
        if let Some((_, blocks)) = turns
            .len()
            .checked_sub(2)
            .and_then(|i| turns.get(i))
            .filter(|(role, blocks)| {
                *role == "assistant" && blocks.iter().any(|b| b["type"].text() == "tool_use")
            })
        {
            let mut has = false;
            for block in blocks {
                match block["type"].text() {
                    "thinking" => {
                        if block["signature"].text().is_empty() {
                            return Err(invalid("extended-thinking tool continuation requires the original signed thinking blocks for this model"));
                        }
                        has = true;
                    }
                    "redacted_thinking" => has = true,
                    _ => {}
                }
            }
            if !has && thinking_budget > 0.0 {
                return Err(invalid("extended-thinking tool continuation requires the original signed thinking blocks for this model"));
            }
        }
    }
    let answer = req["maxTokens"]
        .number()
        .unwrap_or(options.anthropic_max_tokens as f64);
    let limit = if thinking_budget > 0.0 && answer <= thinking_budget {
        answer + thinking_budget
    } else {
        answer
    };
    if !safe_integer(limit, 1.0) {
        return Err(invalid(
            "max_tokens including thinking must be a positive safe integer",
        ));
    }
    let mut body = obj!("model": req["model"].clone(), "max_tokens": limit);
    if !system.is_empty() {
        body.set("system", system);
    }
    body.set(
        "messages",
        turns
            .into_iter()
            .map(|(role, blocks)| obj!("role": role, "content": blocks))
            .collect::<Vec<_>>(),
    );
    if !tools.is_empty() {
        body.set("tools", tools);
    }
    if let Some(choice) = anthropic_choice(req) {
        body.set("tool_choice", choice);
    }
    if let Some(effort) = effort {
        body.set("output_config", obj!("effort": effort.clone()));
    }
    if adaptive {
        body.set("thinking", obj!("type": "adaptive"));
    } else if thinking_budget > 0.0 {
        body.set(
            "thinking",
            obj!("type": "enabled", "budget_tokens": thinking_budget),
        );
    }
    sampling(
        &mut body,
        req,
        &[
            ("temperature", "temperature"),
            ("top_p", "topP"),
            ("stop_sequences", "stop"),
        ],
    );
    body.set("stream", stream);
    Ok(body)
}

pub(crate) fn gemini_model(model: &str) -> Result<&str> {
    let bare = model.strip_prefix("models/").unwrap_or(model);
    if !(1..=128).contains(&bare.len())
        || !bare.as_bytes()[0].is_ascii_alphanumeric()
        || !bare
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
    {
        return Err(invalid(
            "model name has characters Gemini model ids do not use",
        ));
    }
    Ok(bare)
}

pub(crate) fn gemini_signature(sig: &str) -> bool {
    (1..=65536).contains(&sig.len())
        && sig
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'=' | b'_' | b'-'))
}

fn gemini_part(part: &Json) -> Result<Json> {
    if part["type"].text() == "text" {
        return Ok(obj!("text": part["text"].clone()));
    }
    let normalized = part["url"].text();
    let (prefix, data) = normalized.split_once(',').unwrap_or_default();
    let prefix = prefix.to_ascii_lowercase();
    let media = prefix
        .strip_prefix("data:")
        .and_then(|v| v.strip_suffix(";base64"))
        .unwrap_or_default();
    let image = media.strip_prefix("image/").is_some_and(|v| {
        (1..=60).contains(&v.len())
            && v.bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'+' | b'-'))
    });
    if !(image || media == "application/pdf") || !valid_base64(data) {
        return Err(invalid(
            "image parts must be base64 data: URLs (image/* or application/pdf)",
        ));
    }
    Ok(obj!("inlineData": obj!("mimeType": media, "data": data)))
}

fn gemini(req: &Json) -> Result<Json> {
    if req["parallelToolCalls"].boolean() == Some(false) {
        return Err(invalid(
            "parallelToolCalls:false cannot be honoured by Gemini",
        ));
    }
    let mut system = Vec::new();
    let mut contents = Vec::new();
    let mut responses = Vec::new();
    let mut names = HashMap::new();
    fn flush(contents: &mut Vec<Json>, responses: &mut Vec<Json>) {
        if !responses.is_empty() {
            contents.push(obj!("role": "user", "parts": std::mem::take(responses)));
        }
    }
    for (index, message) in req["messages"].items().iter().enumerate() {
        let content = &message["content"];
        match message["role"].text() {
            "system" | "developer" => {
                if !blank(content.text()) {
                    system.push(obj!("text": content.clone()));
                }
            }
            "user" => {
                flush(&mut contents, &mut responses);
                let parts = if let Some(text) = content.string() {
                    vec![obj!("text": text)]
                } else {
                    content
                        .items()
                        .iter()
                        .map(gemini_part)
                        .collect::<Result<Vec<_>>>()?
                };
                contents.push(obj!("role": "user", "parts": parts));
            }
            "assistant" => {
                flush(&mut contents, &mut responses);
                let mut parts = Vec::new();
                if !content.text().is_empty() {
                    parts.push(obj!("text": content.clone()));
                }
                for call in message["toolCalls"].items() {
                    let id = call["id"].text();
                    let name = call["name"].text();
                    let thought = id.split_once('~').map(|(_, sig)| sig);
                    if thought.is_some_and(|sig| !gemini_signature(sig)) {
                        return Err(invalid(
                            "a tool call id carries a malformed thought signature",
                        ));
                    }
                    if names.insert(id, name).is_some() {
                        return Err(invalid(format!("messages[{index}] repeats tool call id")));
                    }
                    let args = tool_arguments(
                        call,
                        format!("tool call \"{name}\" has arguments that are not JSON"),
                        format!("tool call \"{name}\" arguments must be a JSON object"),
                    )?;
                    let mut out = obj!("functionCall": obj!("name": name, "args": args));
                    if let Some(thought) = thought {
                        out.set("thoughtSignature", thought);
                    }
                    parts.push(out);
                }
                if parts.is_empty() {
                    return Err(invalid(format!(
                        "messages[{index}] is an empty assistant message"
                    )));
                }
                contents.push(obj!("role": "model", "parts": parts));
            }
            _ => {
                let id = message["toolCallId"].text();
                let Some(name) = names.get(id) else {
                    let short =
                        String::from_utf16_lossy(&id.encode_utf16().take(40).collect::<Vec<_>>());
                    return Err(invalid(format!("messages[{index}] answers tool call \"{short}\" that no earlier assistant message made")));
                };
                let output = Json::parse(content.text())
                    .ok()
                    .filter(|v| v.as_object().is_some())
                    .unwrap_or_else(|| obj!("result": content.clone()));
                responses.push(obj!("functionResponse": obj!("name": *name, "response": output)));
            }
        }
    }
    flush(&mut contents, &mut responses);
    if contents.is_empty() {
        return Err(invalid("a request needs at least one non-system message"));
    }
    let mut body = Json::object();
    if !system.is_empty() {
        body.set("systemInstruction", obj!("parts": system));
    }
    body.set("contents", contents);
    if !req["tools"].items().is_empty() {
        let declarations = req["tools"]
            .items()
            .iter()
            .enumerate()
            .map(|(index, tool)| {
                let name = tool["name"].text();
                let mut out = obj!("name": name);
                copy(&mut out, "description", tool, "description");
                if let Some(parameters) = tool.get("parameters") {
                    out.set(
                        "parametersJsonSchema",
                        crate::gemini_schema::convert(
                            parameters,
                            &format!("tools[{index}] \"{name}\""),
                        )?,
                    );
                }
                Ok(out)
            })
            .collect::<Result<Vec<_>>>()?;
        body.set("tools", vec![obj!("functionDeclarations": declarations)]);
    }
    if let Some(choice) = req.get("toolChoice") {
        let mut config =
            obj!("mode": match choice.text() { "auto" => "AUTO", "none" => "NONE", _ => "ANY" });
        if choice.as_object().is_some() {
            config.set("allowedFunctionNames", vec![choice["name"].clone()]);
        }
        body.set("toolConfig", obj!("functionCallingConfig": config));
    }
    let mut generation = Json::object();
    sampling(
        &mut generation,
        req,
        &[
            ("maxOutputTokens", "maxTokens"),
            ("temperature", "temperature"),
            ("topP", "topP"),
            ("stopSequences", "stop"),
        ],
    );
    if let Some((param, value)) = reasoning(
        req,
        "Gemini",
        &[
            "thinkingConfig.thinkingBudget",
            "thinkingConfig.thinkingLevel",
        ],
    )? {
        let mut config = Json::object();
        config.set(
            param.split_once('.').map_or(param, |(_, key)| key),
            value.clone(),
        );
        generation.set("thinkingConfig", config);
    }
    if let Some(format) = req
        .get("responseFormat")
        .filter(|f| f["type"].text() != "text")
    {
        generation.set("responseMimeType", "application/json");
        if format["type"].text() == "json_schema" {
            generation.set("responseJsonSchema", format["schema"].clone());
        }
    }
    if generation.as_object().is_some_and(|v| !v.is_empty()) {
        body.set("generationConfig", generation);
    }
    Ok(body)
}
