use plur1bus_providers::Json;

use super::Error;
use crate::events::object;

#[derive(Clone, Copy)]
pub struct Message<'a> {
    pub id: &'a str,
    pub context: Option<&'a str>,
    pub task: Option<&'a str>,
    pub text: &'a str,
    pub delegation: bool,
}

#[derive(Clone, Copy)]
pub struct PushRequest<'a> {
    pub task: &'a str,
    pub id: Option<&'a str>,
    pub url: &'a str,
}

#[derive(Clone, Copy)]
pub enum Operation<'a> {
    Send(Message<'a>),
    SendStream(Message<'a>),
    Get {
        task: &'a str,
        history: Option<u32>,
    },
    List {
        context: Option<&'a str>,
        page_size: Option<u16>,
        page_token: Option<&'a str>,
    },
    Subscribe {
        task: &'a str,
    },
    Cancel {
        task: &'a str,
    },
    SetPush(PushRequest<'a>),
    GetPush {
        task: &'a str,
        config: &'a str,
    },
    ListPush {
        task: &'a str,
    },
    DeletePush {
        task: &'a str,
        config: &'a str,
    },
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= 128
        && !value.bytes().any(|b| b.is_ascii_control())
}

fn id_field(out: &mut Json, key: &'static str, id: &str) -> Result<(), Error> {
    if !safe_id(id) {
        return Err(Error::InvalidRequest);
    }
    out.set(key, id);
    Ok(())
}

fn plain_message(input: Message<'_>) -> Result<Json, Error> {
    let mut message = Json::object();
    id_field(&mut message, "messageId", input.id)?;
    if let Some(context) = input.context {
        id_field(&mut message, "contextId", context)?;
    }
    if let Some(task) = input.task {
        id_field(&mut message, "taskId", task)?;
    }
    message.set("role", "ROLE_USER");
    message.set("parts", vec![object([("text", input.text.into())])]);
    let mut configuration = Json::object();
    if input.delegation {
        configuration.set("acceptedOutputModes", vec![Json::from("text/plain")]);
        configuration.set("historyLength", 0.0);
    }
    Ok(object([
        ("message", message),
        ("configuration", configuration),
    ]))
}

impl<'a> Operation<'a> {
    pub const fn method(self) -> &'static str {
        match self {
            Self::Send(_) => "SendMessage",
            Self::SendStream(_) => "SendStreamingMessage",
            Self::Get { .. } => "GetTask",
            Self::List { .. } => "ListTasks",
            Self::Subscribe { .. } => "SubscribeToTask",
            Self::Cancel { .. } => "CancelTask",
            Self::SetPush(_) => "CreateTaskPushNotificationConfig",
            Self::GetPush { .. } => "GetTaskPushNotificationConfig",
            Self::ListPush { .. } => "ListTaskPushNotificationConfigs",
            Self::DeletePush { .. } => "DeleteTaskPushNotificationConfig",
        }
    }

    pub(super) const fn streams(self) -> bool {
        matches!(self, Self::SendStream(_) | Self::Subscribe { .. })
    }

    pub(super) const fn task(self) -> Option<&'a str> {
        match self {
            Self::Send(message) | Self::SendStream(message) => message.task,
            Self::Get { task, .. }
            | Self::Subscribe { task }
            | Self::Cancel { task }
            | Self::GetPush { task, .. }
            | Self::ListPush { task }
            | Self::DeletePush { task, .. } => Some(task),
            Self::SetPush(config) => Some(config.task),
            Self::List { .. } => None,
        }
    }

    pub(super) const fn context(self) -> Option<&'a str> {
        match self {
            Self::Send(message) | Self::SendStream(message) => message.context,
            Self::List { context, .. } => context,
            _ => None,
        }
    }

    pub fn body(self, id: &str) -> Result<String, Error> {
        if !safe_id(id) {
            return Err(Error::InvalidRequest);
        }
        let mut params = Json::object();
        match self {
            Self::Send(message) | Self::SendStream(message) => params = plain_message(message)?,
            Self::Get { task, history } => {
                id_field(&mut params, "id", task)?;
                if let Some(history) = history {
                    params.set("historyLength", f64::from(history));
                }
            }
            Self::List {
                context,
                page_size,
                page_token,
            } => {
                if let Some(context) = context {
                    id_field(&mut params, "contextId", context)?;
                }
                if let Some(size) = page_size {
                    params.set("pageSize", f64::from(size));
                }
                if let Some(token) = page_token {
                    if token.len() > 4096 {
                        return Err(Error::InvalidRequest);
                    }
                    params.set("pageToken", token);
                }
            }
            Self::Subscribe { task } | Self::Cancel { task } => id_field(&mut params, "id", task)?,
            Self::SetPush(config) => {
                if let Some(id) = config.id {
                    id_field(&mut params, "id", id)?;
                }
                id_field(&mut params, "taskId", config.task)?;
                let endpoint =
                    crate::peer_card::peer_url(config.url).ok_or(Error::InvalidRequest)?;
                params.set("url", endpoint.as_str());
            }
            Self::GetPush { task, config } | Self::DeletePush { task, config } => {
                id_field(&mut params, "taskId", task)?;
                id_field(&mut params, "id", config)?;
            }
            Self::ListPush { task } => id_field(&mut params, "taskId", task)?,
        }
        let mut rpc = object([("jsonrpc", "2.0".into())]);
        let delegation = matches!(
            self,
            Self::Send(Message {
                delegation: true,
                ..
            })
        );
        if delegation {
            rpc.set("id", id);
        }
        rpc.set("method", self.method());
        rpc.set("params", params);
        if !delegation {
            rpc.set("id", id);
        }
        Ok(rpc.encode())
    }
}
