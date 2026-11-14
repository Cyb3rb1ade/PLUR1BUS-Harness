//! `rbac/audit.ts`: the audit event of the RBAC modules, its sink and the line writer. The line shape is the five-key one
//! the CLI writes to `logs/audit.log`: `{ at, actor: { user, host }, action, target, detail }`, one JSON line, append-only,
//! private to the user.
//!
//! [`audit_line`] gives the bytes `JSON.stringify` gives in TypeScript (ruling R7): the five members in that order, the
//! detail redacted by the D111 redactor first, its members in the order JavaScript lists them (integer-like keys first,
//! in numeric order, then the others as the producer wrote them), numbers and strings printed the JavaScript way. An object
//! nested inside the detail has no recorded member order here (`serde_json` sorts): its integer-like keys come first, the
//! others in code-unit order. The hash chain over these lines is P4-21 and stays a seam.
use crate::js::{array_index, json_stringify};
use crate::logs::redact::{create_redactor, TextRedactor};
use crate::metrics::registry::js_number_to_string;
use plur1bus_log_schema::redact::{RedactOptions, Redactor};
use serde_json::{json, Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

/// `AuditEvent`. `detail` keeps the order its producer wrote the members in: the line is written in that order.
#[derive(Clone, Debug, PartialEq)]
pub struct AuditEvent {
    /// Epoch milliseconds.
    pub at: i64,
    /// `actor.user`.
    pub user: String,
    /// `actor.host`.
    pub host: String,
    /// The action name.
    pub action: String,
    /// What it was done to.
    pub target: String,
    /// Further members.
    pub detail: Vec<(String, Value)>,
}

impl AuditEvent {
    /// `{ at, actor: { user, host }, action, target, detail }` as a value (member order is not kept: see `line`).
    pub fn to_json(&self) -> Value {
        json!({ "at": self.at, "actor": { "user": self.user, "host": self.host }, "action": self.action, "target": self.target,
            "detail": Value::Object(self.detail.iter().cloned().collect()) })
    }
}

/// `AuditSink`: `append` fails when the event could not be recorded; callers that must not act unrecorded rely on it.
pub trait AuditSink {
    /// Records one event.
    fn append(&mut self, event: &AuditEvent) -> Result<(), String>;
}

impl<F: FnMut(&AuditEvent) -> Result<(), String>> AuditSink for F {
    fn append(&mut self, event: &AuditEvent) -> Result<(), String> {
        self(event)
    }
}

/// The members of an object in the order JavaScript lists own keys: array indices ascending, then the rest in the order
/// given (`rest` is already in the order wanted).
fn js_key_order<'a>(keys: impl Iterator<Item = &'a str>) -> Vec<&'a str> {
    let (mut indices, mut rest): (Vec<(usize, &str)>, Vec<&str>) = (Vec::new(), Vec::new());
    for key in keys {
        match array_index(key) {
            Some(i) => indices.push((i, key)),
            None => rest.push(key),
        }
    }
    indices.sort_by_key(|(i, _)| *i);
    indices.into_iter().map(|(_, k)| k).chain(rest).collect()
}

/// `JSON.stringify(value)` for a JSON value: no white space, JavaScript's number and string forms.
pub fn js_json(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => out.push_str(&i.to_string()),
            (_, Some(u)) => out.push_str(&u.to_string()),
            _ => out.push_str(&js_number_to_string(n.as_f64().unwrap_or(0.0))),
        },
        Value::String(s) => out.push_str(&json_stringify(s)),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                js_json(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => js_object(js_key_order(map.keys().map(String::as_str)), map, out),
    }
}

fn js_object(order: Vec<&str>, map: &Map<String, Value>, out: &mut String) {
    out.push('{');
    let mut first = true;
    for key in order {
        let Some(value) = map.get(key) else { continue };
        if !first {
            out.push(',');
        }
        first = false;
        out.push_str(&json_stringify(key));
        out.push(':');
        js_json(value, out);
    }
    out.push('}');
}

/// `redactAuditDetail(detail)` as the text it is written as: the detail through the redactor (a value under a secret-keyed
/// member and a credential shape inside a string never reach disk), its members in JavaScript's order.
pub fn redacted_detail(detail: &[(String, Value)], redactor: &dyn TextRedactor) -> String {
    let map: Map<String, Value> = detail.iter().cloned().collect();
    let redacted = match redactor.value(&Value::Object(map)) {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    let mut written: Vec<&str> = Vec::new();
    for (key, _) in detail {
        if !written.contains(&key.as_str()) {
            written.push(key);
        }
    }
    // A member the redactor added (none today) follows the producer's.
    for key in redacted.keys() {
        if !written.contains(&key.as_str()) {
            written.push(key);
        }
    }
    let mut out = String::new();
    js_object(js_key_order(written.into_iter()), &redacted, &mut out);
    out
}

/// The audit line without its newline: `{"at":..,"actor":{"user":..,"host":..},"action":..,"target":..,"detail":{..}}`.
pub fn audit_line(
    at: i64,
    user: &str,
    host: &str,
    action: &str,
    target: &str,
    detail: &[(String, Value)],
    redactor: &dyn TextRedactor,
) -> String {
    format!(
        "{{\"at\":{at},\"actor\":{{\"user\":{},\"host\":{}}},\"action\":{},\"target\":{},\"detail\":{}}}",
        json_stringify(user),
        json_stringify(host),
        json_stringify(action),
        json_stringify(target),
        redacted_detail(detail, redactor)
    )
}

/// The redactor of the audit detail: the D111 rules without any option, as `createRedactor()`.
pub fn detail_redactor() -> Result<Redactor, String> {
    create_redactor(RedactOptions::default())
        .map_err(|e| format!("audit redaction unavailable: {e}"))
}

/// The host's `securePath` port for one file.
pub type SecurePath = Box<dyn Fn(&Path)>;

/// `createJsonlAuditSink(path, { securePath })`: appends one line per event to `path`. The file is 0600 on POSIX whether
/// it existed or not; `secure_path` is the host's port for the rest (the Windows DACL). One write per line on an
/// append-only handle, then `fsync`: a crash never leaves half a line in the middle.
pub struct JsonlAuditSink {
    path: PathBuf,
    secure_path: Option<SecurePath>,
    redactor: Redactor,
}

impl JsonlAuditSink {
    /// A sink for `path`. Fails when the redaction data cannot be read: nothing may be written then.
    pub fn new(path: PathBuf, secure_path: Option<SecurePath>) -> Result<JsonlAuditSink, String> {
        Ok(JsonlAuditSink {
            path,
            secure_path,
            redactor: detail_redactor()?,
        })
    }
}

impl AuditSink for JsonlAuditSink {
    fn append(&mut self, e: &AuditEvent) -> Result<(), String> {
        let line = format!(
            "{}\n",
            audit_line(
                e.at,
                &e.user,
                &e.host,
                &e.action,
                &e.target,
                &e.detail,
                &self.redactor
            )
        );
        let io = |e: std::io::Error| e.to_string();
        if let Some(parent) = self.path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(io)?;
        }
        let mut open = std::fs::OpenOptions::new();
        open.append(true).create(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
        let mut file = open.open(&self.path).map_err(io)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // An existing file may be looser.
            std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))
                .map_err(io)?;
        }
        if let Some(secure) = &self.secure_path {
            secure(&self.path);
        }
        file.write_all(line.as_bytes()).map_err(io)?;
        file.sync_all().map_err(io)
    }
}

/// Test support: the member order of an audit detail, which a `serde_json::Value` does not keep. A replay tags every
/// event it collects with the order its producer wrote ([`order::tag`]) and every recorded event with the order of the
/// recorded text ([`order::tagged`]); comparing the two compares values and order at once.
#[cfg(test)]
pub(crate) mod order {
    use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
    use serde_json::{json, Value};

    /// A JSON document reduced to its shape: the members of every object in document order.
    #[derive(Clone, Debug, PartialEq)]
    pub enum Doc {
        /// A string, number, boolean or `null`.
        Leaf,
        /// An array.
        List(Vec<Doc>),
        /// An object, members in document order.
        Object(Vec<(String, Doc)>),
    }

    impl<'de> Deserialize<'de> for Doc {
        fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Doc, D::Error> {
            struct V;
            impl<'de> Visitor<'de> for V {
                type Value = Doc;
                fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                    f.write_str("any JSON value")
                }
                fn visit_bool<E>(self, _: bool) -> Result<Doc, E> {
                    Ok(Doc::Leaf)
                }
                fn visit_i64<E>(self, _: i64) -> Result<Doc, E> {
                    Ok(Doc::Leaf)
                }
                fn visit_u64<E>(self, _: u64) -> Result<Doc, E> {
                    Ok(Doc::Leaf)
                }
                fn visit_f64<E>(self, _: f64) -> Result<Doc, E> {
                    Ok(Doc::Leaf)
                }
                fn visit_str<E>(self, _: &str) -> Result<Doc, E> {
                    Ok(Doc::Leaf)
                }
                fn visit_unit<E>(self) -> Result<Doc, E> {
                    Ok(Doc::Leaf)
                }
                fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Doc, A::Error> {
                    let mut out = Vec::new();
                    while let Some(item) = seq.next_element()? {
                        out.push(item);
                    }
                    Ok(Doc::List(out))
                }
                fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Doc, A::Error> {
                    let mut out = Vec::new();
                    while let Some(key) = map.next_key::<String>()? {
                        out.push((key, map.next_value()?));
                    }
                    Ok(Doc::Object(out))
                }
            }
            d.deserialize_any(V)
        }
    }

    impl Doc {
        /// The member `key` of an object.
        pub fn get(&self, key: &str) -> Option<&Doc> {
            match self {
                Doc::Object(members) => members.iter().find(|(k, _)| k == key).map(|(_, v)| v),
                _ => None,
            }
        }
        /// The member at `path`.
        pub fn at(&self, path: &[&str]) -> Option<&Doc> {
            path.iter().try_fold(self, |doc, key| doc.get(key))
        }
        /// The keys of an object, in document order.
        pub fn keys(&self) -> Vec<String> {
            match self {
                Doc::Object(members) => members.iter().map(|(k, _)| k.clone()).collect(),
                _ => Vec::new(),
            }
        }
    }

    /// The shape of a JSON text.
    pub fn parse(text: &str) -> Doc {
        serde_json::from_str(text).unwrap()
    }

    /// `event` with the order of `detail` as its producer wrote it.
    pub fn tag(mut event: Value, detail: &[(String, Value)]) -> Value {
        event["$order"] = json!(detail.iter().map(|(k, _)| k).collect::<Vec<_>>());
        event
    }

    /// The recorded `events` (the array at `path` of the recorded `text`), each with the order of its detail in that text.
    pub fn tagged(text: &str, path: &[&str], events: Option<&Value>) -> Value {
        let doc = parse(text);
        let shapes = match doc.at(path) {
            Some(Doc::List(items)) => items.clone(),
            _ => Vec::new(),
        };
        let events = events
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(shapes.len(), events.len(), "events at {path:?}");
        Value::Array(
            events
                .into_iter()
                .zip(shapes)
                .map(|(mut event, shape)| {
                    event["$order"] = json!(shape.get("detail").map(Doc::keys).unwrap_or_default());
                    event
                })
                .collect(),
        )
    }
}
