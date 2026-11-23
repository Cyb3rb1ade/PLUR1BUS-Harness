//! Provider request, checkpoint and response handling for media jobs.

use std::{
    str::FromStr,
    time::{Duration, Instant, SystemTime},
};

use serde_json::Value;

use crate::{
    http::{Auth, Failure, Method},
    jobs::{Checkpoint, Error, Progress, Result},
};

mod image;
mod ordered;
mod payload;
mod schema;
mod video;

pub use image::{ImageAdapter, ImageOutput, ImageRequest};
pub use video::{
    Download, ReferenceVideo, SanitizedVideo, VideoAdapter, VideoOutput, VideoProfile, VideoRequest,
};

type Call<T> = std::result::Result<T, Failure>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Provider {
    OpenAi,
    OpenRouter,
    Google,
    Xai,
    Together,
    DrawThings,
    Replicate,
    Fal,
}

impl Provider {
    pub const fn id(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::OpenRouter => "openrouter",
            Self::Google => "google",
            Self::Xai => "xai",
            Self::Together => "together",
            Self::DrawThings => "draw-things",
            Self::Replicate => "replicate",
            Self::Fal => "fal",
        }
    }

    pub const fn auth(self) -> Auth {
        match self {
            Self::Google => Auth::Google,
            Self::DrawThings => Auth::None,
            Self::Fal => Auth::Fal,
            _ => Auth::Bearer,
        }
    }

    pub const fn default_url(self) -> &'static str {
        match self {
            Self::OpenAi => "https://api.openai.com/v1",
            Self::OpenRouter => "https://openrouter.ai/api/v1",
            Self::Google => "https://generativelanguage.googleapis.com/v1beta",
            Self::Xai => "https://api.x.ai/v1",
            Self::Together => "https://api.together.ai/v1",
            Self::DrawThings => "http://127.0.0.1:7860",
            Self::Replicate => "https://api.replicate.com/v1",
            Self::Fal => "https://queue.fal.run",
        }
    }

    pub const fn can_edit(self) -> bool {
        !matches!(self, Self::Together | Self::Xai)
    }

    pub const fn can_mask(self) -> bool {
        matches!(self, Self::OpenAi | Self::Replicate | Self::Fal)
    }

    fn queued(self) -> bool {
        matches!(self, Self::Replicate | Self::Fal)
    }

    fn cancel(self, model: &str, id: &str) -> Option<(Method, String)> {
        match self {
            Self::Replicate => Some((Method::Post, format!("predictions/{id}/cancel"))),
            Self::Fal => Some((Method::Put, format!("{model}/requests/{id}/cancel"))),
            _ => None,
        }
    }
}

impl FromStr for Provider {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        [
            Self::OpenAi,
            Self::OpenRouter,
            Self::Google,
            Self::Xai,
            Self::Together,
            Self::DrawThings,
            Self::Replicate,
            Self::Fal,
        ]
        .into_iter()
        .find(|provider| provider.id() == value)
        .ok_or(Error::UnsupportedParameter)
    }
}

pub trait Observer {
    fn progress(&mut self, event: Progress) -> Result<()>;
    fn checkpoint(&mut self, event: Checkpoint) -> Result<()>;
    /// A uniform boundary suffix for OpenAI multipart must come from the host.
    fn multipart_boundary(&mut self) -> Result<String> {
        Err(Error::BackendUnavailable)
    }
}

#[derive(Clone, Copy)]
pub struct Run<'a> {
    pub deadline: Instant,
    pub resume: Option<&'a Checkpoint>,
}

fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_model(model: &str) -> bool {
    !model.contains(['?', '#', '\\'])
        && model
            .split('/')
            .all(|part| !matches!(part, "" | "." | ".."))
}

fn uri_component(text: &str) -> String {
    use std::fmt::Write as _;
    let mut result = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            result.push(char::from(byte));
        } else {
            let _ = write!(result, "%{byte:02X}");
        }
    }
    result
}

fn duration_ms(start: SystemTime, end: SystemTime) -> u64 {
    end.duration_since(start)
        .unwrap_or(Duration::ZERO)
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn moderation(value: &Value) -> bool {
    let rejected = |value: &Value| value == false;
    value["promptFeedback"]["blockReason"]
        .as_str()
        .is_some_and(|reason| !reason.is_empty())
        || value["candidates"].as_array().is_some_and(|candidates| {
            candidates.iter().any(|candidate| {
                candidate["finishReason"].as_str().is_some_and(|reason| {
                    matches!(
                        reason,
                        "SAFETY"
                            | "IMAGE_SAFETY"
                            | "PROHIBITED_CONTENT"
                            | "BLOCKLIST"
                            | "IMAGE_PROHIBITED_CONTENT"
                    )
                })
            })
        })
        || value["choices"].as_array().is_some_and(|choices| {
            choices
                .iter()
                .any(|choice| choice["finish_reason"] == "content_filter")
        })
        || rejected(&value["respect_moderation"])
        || value["data"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|row| rejected(&row["respect_moderation"])))
        || value["has_nsfw_concepts"]
            .as_array()
            .is_some_and(|values| values.iter().any(|value| value == true))
}
