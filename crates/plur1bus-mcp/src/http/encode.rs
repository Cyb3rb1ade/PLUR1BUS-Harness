use serde::{ser::SerializeMap, Serialize, Serializer};
use serde_json::{Map, Value};

const VERSION: &str = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";
const INFO: &str = "io.modelcontextprotocol/clientInfo";
const META_LAST: [&str; 4] = [VERSION, CAPABILITIES, INFO, "progressToken"];
const INITIALIZE_FIRST: [&str; 3] = ["protocolVersion", "capabilities", "clientInfo"];
const PARAM_FIRST: [&str; 8] = [
    "name",
    "arguments",
    "uri",
    "cursor",
    "notifications",
    "inputResponses",
    "requestState",
    "taskId",
];

pub(crate) fn message(message: &impl Serialize) -> serde_json::Result<Vec<u8>> {
    let value = serde_json::to_value(message)?;
    if value.get("id").is_none() || value.get("method").is_none() {
        return serde_json::to_vec(message);
    }
    let Some(params) = value.get("params").and_then(Value::as_object) else {
        return serde_json::to_vec(message);
    };
    let meta = params.get("_meta").and_then(Value::as_object);
    let first: &[&str] = if value["method"] == "initialize" {
        &INITIALIZE_FIRST
    } else if meta
        .and_then(|meta| meta.get(VERSION))
        .and_then(Value::as_str)
        == Some("2026-07-28")
    {
        &PARAM_FIRST
    } else {
        return serde_json::to_vec(message);
    };
    serde_json::to_vec(&Request {
        jsonrpc: &value["jsonrpc"],
        id: &value["id"],
        method: &value["method"],
        params: Params {
            params,
            meta,
            first,
        },
    })
}

#[derive(Serialize)]
struct Request<'a> {
    jsonrpc: &'a Value,
    id: &'a Value,
    method: &'a Value,
    params: Params<'a>,
}

struct Params<'a> {
    params: &'a Map<String, Value>,
    meta: Option<&'a Map<String, Value>>,
    first: &'a [&'a str],
}

impl Serialize for Params<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.params.len()))?;
        for &key in self.first {
            if let Some(value) = self.params.get(key) {
                map.serialize_entry(key, value)?;
            }
        }
        for (key, value) in self.params {
            if !self.first.contains(&key.as_str()) && (key != "_meta" || self.meta.is_none()) {
                map.serialize_entry(key, value)?;
            }
        }
        if let Some(meta) = self.meta {
            map.serialize_entry("_meta", &Meta(meta))?;
        }
        map.end()
    }
}

struct Meta<'a>(&'a Map<String, Value>);

impl Serialize for Meta<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in self.0 {
            if !META_LAST.contains(&key.as_str()) {
                map.serialize_entry(key, value)?;
            }
        }
        for key in META_LAST {
            if let Some(value) = self.0.get(key) {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}
