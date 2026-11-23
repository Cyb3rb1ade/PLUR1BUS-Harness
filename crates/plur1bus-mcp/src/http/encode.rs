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

pub(crate) fn message(
    message: &impl Serialize,
    include_progress: bool,
    legacy_stdio: bool,
) -> serde_json::Result<Vec<u8>> {
    let value = serde_json::to_value(message)?;
    let Some(method) = value.get("method") else {
        return serde_json::to_vec(message);
    };
    let id = value.get("id");
    let params = value.get("params").and_then(Value::as_object);
    let meta = params
        .and_then(|params| params.get("_meta"))
        .and_then(Value::as_object);
    let modern = meta
        .and_then(|meta| meta.get(VERSION))
        .and_then(Value::as_str)
        == Some("2026-07-28");
    let strip_progress =
        !include_progress && meta.is_some_and(|meta| meta.contains_key("progressToken"));
    let first: &[&str] = if *method == "initialize" {
        &INITIALIZE_FIRST
    } else if legacy_stdio || modern || strip_progress {
        &PARAM_FIRST
    } else {
        return serde_json::to_vec(message);
    };
    let params = params.map(|params| Params {
        params,
        meta,
        first,
        include_progress,
    });
    if legacy_stdio && !modern {
        return serde_json::to_vec(&LegacyStdio {
            method,
            params,
            jsonrpc: &value["jsonrpc"],
            id,
        });
    }
    serde_json::to_vec(&Request {
        jsonrpc: &value["jsonrpc"],
        id,
        method,
        params,
    })
}

#[derive(Serialize)]
struct Request<'a> {
    jsonrpc: &'a Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<&'a Value>,
    method: &'a Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Params<'a>>,
}

#[derive(Serialize)]
struct LegacyStdio<'a> {
    method: &'a Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Params<'a>>,
    jsonrpc: &'a Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<&'a Value>,
}

struct Params<'a> {
    params: &'a Map<String, Value>,
    meta: Option<&'a Map<String, Value>>,
    first: &'a [&'a str],
    include_progress: bool,
}

impl Serialize for Params<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let omit_meta = !self.include_progress
            && self
                .meta
                .is_some_and(|meta| meta.len() == 1 && meta.contains_key("progressToken"));
        let mut map = serializer.serialize_map(Some(self.params.len() - usize::from(omit_meta)))?;
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
        if let Some(meta) = self.meta.filter(|_| !omit_meta) {
            map.serialize_entry("_meta", &Meta(meta, self.include_progress))?;
        }
        map.end()
    }
}

struct Meta<'a>(&'a Map<String, Value>, bool);

impl Serialize for Meta<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let length = self.0.len() - usize::from(!self.1 && self.0.contains_key("progressToken"));
        let mut map = serializer.serialize_map(Some(length))?;
        for (key, value) in self.0 {
            if !META_LAST.contains(&key.as_str()) {
                map.serialize_entry(key, value)?;
            }
        }
        for key in META_LAST {
            if key == "progressToken" && !self.1 {
                continue;
            }
            if let Some(value) = self.0.get(key) {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}
