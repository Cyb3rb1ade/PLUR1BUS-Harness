use plur1bus_providers::Json;
use url::Url;

use super::{Action, RpcError};
use crate::{card::Features, parts};

pub struct Start {
    pub message_id: String,
    pub task_id: Option<String>,
    pub context_id: Option<String>,
    pub message: parts::Parsed,
    pub blocking: bool,
    pub stream: bool,
    pub push: Option<PushConfig>,
}

pub struct PushAuthentication {
    pub schemes: Vec<String>,
    pub credential: Option<String>,
}

pub struct PushConfig {
    pub url: Url,
    pub id: Option<String>,
    pub token: Option<String>,
    pub authentication: Option<PushAuthentication>,
}

pub enum Command {
    Start(Start),
    Get {
        id: String,
        history_length: Option<usize>,
    },
    Cancel {
        id: String,
    },
    Resubscribe {
        id: String,
    },
    SetPush {
        id: String,
        config: PushConfig,
    },
    GetPush {
        id: String,
        config_id: Option<String>,
    },
    ListPush {
        id: String,
    },
    DeletePush {
        id: String,
        config_id: String,
    },
}

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Method {
    Send,
    Stream,
    Get,
    Cancel,
    Resubscribe,
    SetPush,
    GetPush,
    ListPush,
    DeletePush,
}

impl Method {
    pub(super) fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "message/send" => Self::Send,
            "message/stream" => Self::Stream,
            "tasks/get" => Self::Get,
            "tasks/cancel" => Self::Cancel,
            "tasks/resubscribe" => Self::Resubscribe,
            "tasks/pushNotificationConfig/set" => Self::SetPush,
            "tasks/pushNotificationConfig/get" => Self::GetPush,
            "tasks/pushNotificationConfig/list" => Self::ListPush,
            "tasks/pushNotificationConfig/delete" => Self::DeletePush,
            _ => return None,
        })
    }

    pub(super) const fn action(self) -> Action {
        match self {
            Self::Send | Self::Stream => Action::Send,
            Self::Get | Self::Resubscribe => Action::Read,
            Self::Cancel => Action::Cancel,
            Self::SetPush | Self::GetPush | Self::ListPush | Self::DeletePush => Action::Push,
        }
    }

    pub(super) const fn streams(self) -> bool {
        matches!(self, Self::Stream | Self::Resubscribe)
    }
}

fn safe_id(v: &Json) -> Option<&str> {
    v.string().filter(|s| {
        !s.is_empty() && s.encode_utf16().count() <= 128 && !s.bytes().any(|b| b.is_ascii_control())
    })
}

fn bounded(s: &Json, max: usize) -> Option<String> {
    let raw = s.string()?;
    let mut used = 0;
    let value: String = raw
        .chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= max
        })
        .collect();
    (!value.is_empty()).then_some(value)
}

fn push_config(v: &Json) -> Result<PushConfig, RpcError> {
    let url = v["url"]
        .string()
        .filter(|s| !s.trim_matches(parts::js_space).is_empty())
        .ok_or(RpcError::Params("pushNotificationConfig.url is required"))?;
    let url = Url::parse(url)
        .map_err(|_| RpcError::Params("pushNotificationConfig.url is not a valid URL"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(RpcError::Params(
            "pushNotificationConfig.url must be http(s)",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(RpcError::PushDenied);
    }
    let authentication = if v["authentication"].as_object().is_some() {
        let auth = &v["authentication"];
        let schemes: Vec<_> = auth["schemes"]
            .items()
            .iter()
            .filter_map(Json::string)
            .map(str::to_owned)
            .collect();
        if schemes.is_empty() {
            return Err(RpcError::Params("authentication.schemes is required"));
        }
        Some(PushAuthentication {
            schemes,
            credential: bounded(&auth["credentials"], 2048),
        })
    } else {
        None
    };
    Ok(PushConfig {
        url,
        id: bounded(&v["id"], 128),
        token: bounded(&v["token"], 512),
        authentication,
    })
}

fn optional_id(value: &Json, key: &str, error: &'static str) -> Result<Option<String>, RpcError> {
    value
        .get(key)
        .map(|value| {
            safe_id(value)
                .map(str::to_owned)
                .ok_or(RpcError::Params(error))
        })
        .transpose()
}

fn start(
    v: &Json,
    limits: parts::Limits,
    features: Features,
    stream: bool,
) -> Result<Start, RpcError> {
    let message = &v["message"];
    if message.as_object().is_none() {
        return Err(RpcError::Params("params.message is required"));
    }
    if message["role"].string() != Some("user") {
        return Err(RpcError::Params("message.role must be user"));
    }
    let message_id =
        safe_id(&message["messageId"]).ok_or(RpcError::Params("message.messageId is required"))?;
    let task_id = optional_id(message, "taskId", "message.taskId is invalid")?;
    let context_id = optional_id(message, "contextId", "message.contextId is invalid")?;
    let message = parts::parse(&message["parts"], limits).map_err(RpcError::Part)?;
    let config = &v["configuration"];
    let push = config
        .get("pushNotificationConfig")
        .map(|value| {
            if !features.push_notifications {
                return Err(RpcError::PushNotSupported);
            }
            push_config(value)
        })
        .transpose()?;
    Ok(Start {
        message_id: message_id.to_owned(),
        task_id,
        context_id,
        message,
        blocking: config["blocking"].boolean() == Some(true),
        stream,
        push,
    })
}

pub(super) fn command(
    method: Method,
    params: &Json,
    limits: parts::Limits,
    features: Features,
) -> Result<Command, RpcError> {
    if matches!(method, Method::Send | Method::Stream) {
        return Ok(Command::Start(start(
            params,
            limits,
            features,
            method.streams(),
        )?));
    }
    if method.action() == Action::Push {
        if params.as_object().is_none() {
            return Err(RpcError::Params("params are required"));
        }
        let id = safe_id(&params["taskId"])
            .or_else(|| safe_id(&params["id"]))
            .ok_or(RpcError::Params("task id is required"))?
            .to_owned();
        let config_id = safe_id(&params["pushNotificationConfigId"]).map(str::to_owned);
        return Ok(match method {
            Method::SetPush => Command::SetPush {
                id,
                config: push_config(&params["pushNotificationConfig"])?,
            },
            Method::GetPush => Command::GetPush { id, config_id },
            Method::ListPush => Command::ListPush { id },
            Method::DeletePush => Command::DeletePush {
                id,
                config_id: config_id
                    .ok_or(RpcError::Params("pushNotificationConfigId is required"))?,
            },
            _ => return Err(RpcError::Internal),
        });
    }
    let id = safe_id(&params["id"])
        .ok_or(RpcError::Params("params.id is required"))?
        .to_owned();
    Ok(match method {
        Method::Get => {
            let history_length = params
                .get("historyLength")
                .map(|v| {
                    v.number()
                        .filter(|n| *n >= 0.0 && n.is_finite() && n.fract() == 0.0)
                        .map(|n| n as usize)
                        .ok_or(RpcError::Params(
                            "historyLength must be a non-negative integer",
                        ))
                })
                .transpose()?;
            Command::Get { id, history_length }
        }
        Method::Resubscribe => Command::Resubscribe { id },
        Method::Cancel => Command::Cancel { id },
        _ => return Err(RpcError::Internal),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_targets_refuse_user_information_and_fragments() {
        for url in [
            "https://fixture@callbacks.example.invalid/report",
            "https://callbacks.example.invalid/report#part",
        ] {
            let params = Json::parse(&format!(r#"{{"url":"{url}"}}"#));
            assert!(params
                .is_ok_and(|params| matches!(push_config(&params), Err(RpcError::PushDenied))));
        }
    }
}
