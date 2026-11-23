use aho_corasick::{AhoCorasick, MatchKind};
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD},
    Engine as _,
};
use plur1bus_providers::{SseEvent, SseParser};
use serde_json::Value;
use std::fmt::Write as _;
use std::{collections::VecDeque, io::Read};

use super::{http, Authorization, Call, Error, Operation, Policy};

#[derive(Default)]
pub(super) struct Secrets {
    forms: Vec<String>,
    matcher: Option<AhoCorasick>,
}

impl Secrets {
    pub(super) fn insert(&mut self, token: &str) -> Result<(), Error> {
        if token.is_empty() || token.len() > 4096 {
            return Ok(());
        }
        let mut hex = String::new();
        let mut percent = String::new();
        for byte in token.bytes() {
            let _ = write!(hex, "{byte:02x}");
            if byte.is_ascii_alphanumeric() || b"._~-".contains(&byte) {
                percent.push(char::from(byte));
            } else {
                let _ = write!(percent, "%{byte:02X}");
            }
        }
        let extra = [
            token.to_owned(),
            STANDARD.encode(token),
            STANDARD_NO_PAD.encode(token),
            URL_SAFE.encode(token),
            URL_SAFE_NO_PAD.encode(token),
            hex.to_ascii_uppercase(),
            hex,
            percent,
            token.replace('/', "\\/"),
        ];
        let before = self.forms.len();
        for form in extra {
            if !self.forms.contains(&form) {
                self.forms.push(form);
            }
        }
        if self.forms.len() != before {
            self.matcher = Some(
                AhoCorasick::builder()
                    .match_kind(MatchKind::LeftmostLongest)
                    .build(&self.forms)
                    .map_err(|_| Error::RequestFailed)?,
            );
        }
        Ok(())
    }

    pub(super) fn contains(&self, value: &str) -> bool {
        self.matcher.as_ref().is_some_and(|m| m.is_match(value))
    }

    fn text(matcher: &AhoCorasick, value: &str, cap: usize) -> Result<String, Error> {
        const REDACTED: &str = "[REDACTED:secret]";
        let mut result = String::with_capacity(value.len().min(cap));
        let mut last = 0;
        for found in matcher.find_iter(value) {
            if result.len() + found.start() - last + REDACTED.len() > cap {
                return Err(Error::TooLarge);
            }
            result.push_str(&value[last..found.start()]);
            result.push_str(REDACTED);
            last = found.end();
        }
        if result.len() + value.len() - last > cap {
            return Err(Error::TooLarge);
        }
        result.push_str(&value[last..]);
        Ok(result)
    }

    pub(super) fn redact(&self, value: &mut Value, remaining: &mut usize) -> Result<(), Error> {
        let Some(matcher) = &self.matcher else {
            return Ok(());
        };
        match value {
            Value::String(value) => {
                if matcher.is_match(&*value) {
                    *value = Self::text(matcher, value, *remaining)?;
                }
                *remaining = remaining.checked_sub(value.len()).ok_or(Error::TooLarge)?;
            }
            Value::Array(items) => {
                for item in items {
                    self.redact(item, remaining)?;
                }
            }
            Value::Object(fields) => {
                // Secret-bearing property names are not part of the peer protocol.
                fields.retain(|key, _| !matcher.is_match(key));
                for (key, item) in fields {
                    *remaining = remaining.checked_sub(key.len()).ok_or(Error::TooLarge)?;
                    self.redact(item, remaining)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
}

pub(super) fn rpc_result(raw: &[u8], id: &str) -> Result<Value, Error> {
    let mut rpc: Value = serde_json::from_slice(raw).map_err(|_| Error::RequestFailed)?;
    let fields = rpc.as_object_mut().ok_or(Error::RequestFailed)?;
    if fields.get("jsonrpc").is_none_or(|v| v != "2.0") || fields.get("id").is_none_or(|v| v != id)
    {
        return Err(Error::RequestFailed);
    }
    match (fields.remove("result"), fields.remove("error")) {
        (Some(result), None) => Ok(result),
        (None, Some(error)) => {
            let code = error["code"]
                .as_i64()
                .and_then(|n| i32::try_from(n).ok())
                .ok_or(Error::RequestFailed)?;
            Err(Error::Remote(code))
        }
        _ => Err(Error::RequestFailed),
    }
}

fn safe_peer_id(v: &Value) -> Option<&str> {
    let id = v.as_str()?;
    (!id.is_empty()
        && id.encode_utf16().count() <= 128
        && !id.bytes().any(|b| b.is_ascii_control()))
    .then_some(id)
}

fn compatible(v: &Value, expected: Option<&str>) -> bool {
    expected.is_none_or(|id| v == id)
}

fn state(v: &Value) -> Option<bool> {
    match v.as_str()? {
        "TASK_STATE_SUBMITTED" | "TASK_STATE_WORKING" => Some(false),
        "TASK_STATE_INPUT_REQUIRED"
        | "TASK_STATE_AUTH_REQUIRED"
        | "TASK_STATE_COMPLETED"
        | "TASK_STATE_FAILED"
        | "TASK_STATE_CANCELED"
        | "TASK_STATE_REJECTED" => Some(true),
        _ => None,
    }
}

fn valid_task(task: &Value, id: Option<&str>, context: Option<&str>) -> bool {
    safe_peer_id(&task["id"]).is_some()
        && compatible(&task["id"], id)
        && compatible(&task["contextId"], context)
        && state(&task["status"]["state"]).is_some()
}

fn valid_message(message: &Value, task: Option<&str>, context: Option<&str>) -> bool {
    message["role"] == "ROLE_AGENT"
        && message["parts"].is_array()
        && compatible(&message["taskId"], task)
        && compatible(&message["contextId"], context)
}

fn valid_push(config: &Value, task: Option<&str>, id: Option<&str>) -> bool {
    safe_peer_id(&config["id"]).is_some()
        && compatible(&config["id"], id)
        && safe_peer_id(&config["taskId"]).is_some()
        && compatible(&config["taskId"], task)
        && config["url"]
            .as_str()
            .and_then(crate::peer_card::peer_url)
            .is_some()
}

pub(super) fn operation_result(raw: Value, operation: Operation<'_>) -> Result<Value, Error> {
    let task = operation.task();
    let context = operation.context();
    let valid = match operation {
        Operation::Send(_) => match (raw.get("task"), raw.get("message")) {
            (Some(value), None) => valid_task(value, task, context),
            (None, Some(value)) => valid_message(value, task, context),
            _ => false,
        },
        Operation::Get { .. } | Operation::Cancel { .. } => valid_task(&raw, task, None),
        Operation::List { .. } => raw["tasks"]
            .as_array()
            .is_some_and(|tasks| tasks.iter().all(|t| valid_task(t, None, context))),
        Operation::SetPush(config) => valid_push(&raw, task, config.id),
        Operation::GetPush { config, .. } => valid_push(&raw, task, Some(config)),
        Operation::ListPush { .. } => raw["configs"]
            .as_array()
            .is_some_and(|configs| configs.iter().all(|cfg| valid_push(cfg, task, None))),
        Operation::DeletePush { .. } => {
            raw.is_null() || raw.as_object().is_some_and(|o| o.is_empty())
        }
        Operation::SendStream(_) | Operation::Subscribe { .. } => false,
    };
    if valid {
        Ok(raw)
    } else {
        Err(Error::RequestFailed)
    }
}

pub struct Stream<'a> {
    wire: Option<Wire>,
    policy: &'a dyn Policy,
    call: Call<'a>,
    id: String,
    task_id: Option<String>,
    context_id: Option<String>,
    secrets: Secrets,
    parser: SseParser,
    events: VecDeque<SseEvent>,
    read: usize,
    cap: usize,
    output_remaining: usize,
}

pub(super) struct Wire {
    pub body: ureq::Body,
    pub grant: Box<dyn Authorization>,
}

impl<'a> Stream<'a> {
    pub(super) fn new(
        wire: Wire,
        policy: &'a dyn Policy,
        call: Call<'a>,
        operation: Operation<'_>,
        id: &str,
        secrets: Secrets,
        cap: usize,
    ) -> Self {
        Self {
            wire: Some(wire),
            policy,
            call,
            id: id.into(),
            task_id: operation.task().map(str::to_owned),
            context_id: operation.context().map(str::to_owned),
            secrets,
            parser: SseParser::new(cap),
            events: VecDeque::new(),
            read: 0,
            cap,
            output_remaining: cap,
        }
    }

    fn current(&self) -> Result<(), Error> {
        http::check(self.call.window)?;
        if !self.policy.current(self.call.peer, self.call.execution) {
            return Err(Error::Revoked);
        }
        Ok(())
    }

    fn bind(&mut self, task_id: &Value, context_id: &Value) -> Result<(), Error> {
        let id = safe_peer_id(task_id).ok_or(Error::RequestFailed)?;
        if !compatible(task_id, self.task_id.as_deref())
            || !compatible(context_id, self.context_id.as_deref())
        {
            return Err(Error::RequestFailed);
        }
        if self.task_id.is_none() {
            self.task_id = Some(id.to_owned());
        }
        if self.context_id.is_none() {
            self.context_id = safe_peer_id(context_id).map(str::to_owned);
        }
        Ok(())
    }

    fn parse(&mut self, event: &SseEvent) -> Result<(Value, bool), Error> {
        if event.event.as_deref() == Some("error") {
            return Err(Error::RequestFailed);
        }
        let mut result = rpc_result(event.data.as_bytes(), &self.id)?;
        let keys = ["task", "message", "artifactUpdate", "statusUpdate"];
        let mut payload = keys.into_iter().filter(|key| result.get(key).is_some());
        let kind = payload.next().ok_or(Error::RequestFailed)?;
        if payload.next().is_some() {
            return Err(Error::RequestFailed);
        }
        let event = &result[kind];
        let terminal = match kind {
            "task" => {
                self.bind(&event["id"], &event["contextId"])?;
                state(&event["status"]["state"]).ok_or(Error::RequestFailed)?
            }
            "statusUpdate" => {
                self.bind(&event["taskId"], &event["contextId"])?;
                state(&event["status"]["state"]).ok_or(Error::RequestFailed)?
            }
            "artifactUpdate" => {
                self.bind(&event["taskId"], &event["contextId"])?;
                if safe_peer_id(&event["artifact"]["artifactId"]).is_none()
                    || !event["artifact"]["parts"].is_array()
                {
                    return Err(Error::RequestFailed);
                }
                false
            }
            "message" => {
                if !valid_message(event, self.task_id.as_deref(), self.context_id.as_deref()) {
                    return Err(Error::RequestFailed);
                }
                true
            }
            _ => return Err(Error::RequestFailed),
        };
        self.secrets
            .redact(&mut result, &mut self.output_remaining)?;
        Ok((result, terminal))
    }

    pub fn next_event(&mut self) -> Result<Option<Value>, Error> {
        if self.wire.is_none() {
            return Ok(None);
        }
        let result = self.next_open();
        if !matches!(&result, Ok((_, false))) {
            if let Some(mut wire) = self.wire.take() {
                if result.is_ok() {
                    wire.grant.settle(self.read);
                }
            }
            self.events.clear();
        }
        result.map(|(event, _)| Some(event))
    }

    fn next_open(&mut self) -> Result<(Value, bool), Error> {
        loop {
            self.current()?;
            if let Some(event) = self.events.pop_front() {
                return self.parse(&event);
            }
            let wire = self.wire.as_mut().ok_or(Error::RequestFailed)?;
            let mut buffer = [0; 8192];
            let take = (self.cap - self.read + 1).min(buffer.len());
            let read = wire.body.as_reader().read(&mut buffer[..take]);
            self.current()?;
            let bytes = read.map_err(|_| Error::RequestFailed)?;
            if bytes == 0 {
                self.events = self
                    .parser
                    .finish()
                    .map_err(|_| Error::RequestFailed)?
                    .into();
                let event = self.events.pop_front().ok_or(Error::RequestFailed)?;
                return self.parse(&event);
            }
            if bytes > self.cap - self.read {
                return Err(Error::TooLarge);
            }
            self.read += bytes;
            self.events.extend(
                self.parser
                    .push(&buffer[..bytes])
                    .map_err(|_| Error::RequestFailed)?,
            );
        }
    }
}
