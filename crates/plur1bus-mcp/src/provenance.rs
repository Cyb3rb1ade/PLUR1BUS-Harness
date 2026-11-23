use plur1bus_providers::provenance::{Origin, Provenance, Transformation, Trust};
use serde_json::{json, Value};

pub(crate) fn origin(
    server: &str,
    principal: &str,
    trust: Trust,
    redacted: bool,
    truncated: bool,
) -> Provenance {
    let mut transformed_by = Vec::new();
    if truncated {
        transformed_by.push(Transformation::Truncate);
    }
    if redacted {
        transformed_by.push(Transformation::Redact);
    }
    Provenance {
        origin: Origin {
            system: format!("mcp:{server}"),
            agent: None,
            principal: principal.to_owned(),
            trust,
        },
        hops: 1,
        transformed_by,
    }
}

pub(crate) fn tool_result(
    mut raw: Value,
    server: &str,
    tool: &str,
    principal: &str,
    trust: Trust,
    redacted: bool,
    limit: usize,
) -> Value {
    let mut budget = Budget {
        remaining: limit,
        truncated: false,
    };
    let is_error = raw["isError"] == true;
    let mut content = match raw.get_mut("content").map(Value::take) {
        Some(Value::Array(blocks)) => blocks,
        _ => Vec::new(),
    };
    for block in &mut content {
        budget.block(block);
    }
    let structured = raw
        .as_object_mut()
        .and_then(|object| object.remove("structuredContent"));
    let structured = structured
        .filter(|value| serde_json::to_vec(value).is_ok_and(|bytes| budget.spend(bytes.len())));
    let mut result = json!({
        "content": content,
        "isError": is_error,
        "provenance": origin(server, principal, trust, redacted, budget.truncated),
        "server": server,
        "tool": tool,
    });
    if let Some(value) = structured {
        result["structuredContent"] = value;
    }
    result
}

struct Budget {
    remaining: usize,
    truncated: bool,
}

impl Budget {
    fn spend(&mut self, bytes: usize) -> bool {
        if bytes > self.remaining {
            self.truncated = true;
            return false;
        }
        self.remaining -= bytes;
        true
    }

    fn text(&mut self, value: &mut Value) {
        let Some(text) = value.as_str() else {
            return;
        };
        if text.len() > self.remaining {
            *value = Value::String(text[..text.floor_char_boundary(self.remaining)].to_owned());
            self.remaining = 0;
            self.truncated = true;
        } else {
            self.remaining -= text.len();
        }
    }

    fn block(&mut self, block: &mut Value) {
        match block["type"].as_str() {
            Some("text") => {
                if let Some(text) = block.get_mut("text") {
                    self.text(text);
                }
            }
            Some("resource") => {
                if let Some(resource) = block.get_mut("resource") {
                    if let Some(text) = resource.get_mut("text").filter(|text| text.is_string()) {
                        self.text(text);
                    } else if resource["blob"]
                        .as_str()
                        .is_some_and(|blob| !self.spend(blob.len()))
                    {
                        *block = json!({"type":"text","text":"[omitted: resource blob over the size cap]"});
                    }
                }
            }
            Some(kind @ ("image" | "audio"))
                if block["data"]
                    .as_str()
                    .is_some_and(|data| !self.spend(data.len())) =>
            {
                *block = json!({"type":"text","text":format!("[omitted: {kind} block over the size cap]")});
            }
            _ => {}
        }
    }
}
