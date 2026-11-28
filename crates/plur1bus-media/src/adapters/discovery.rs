use std::{
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};

use serde::Serialize;
use serde_json::Value;

use crate::{
    http::{Client, Failure, Reason},
    jobs::{Error, Result},
};

#[derive(Clone, Serialize)]
pub struct ImageModel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub edit: bool,
}

fn parse_image_models(input: &Value) -> Vec<ImageModel> {
    let has_image = |value: &Value| {
        value
            .as_array()
            .is_some_and(|kinds| kinds.iter().any(|kind| kind == "image"))
    };
    input["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = entry["id"].as_str()?;
            let arch = &entry["architecture"];
            has_image(&arch["output_modalities"]).then(|| ImageModel {
                id: id.into(),
                name: entry["name"].as_str().map(str::to_owned),
                edit: has_image(&arch["input_modalities"]),
            })
        })
        .collect()
}

struct Cached {
    fetched: SystemTime,
    models: Vec<ImageModel>,
    retry_after: Option<SystemTime>,
}

pub struct ImageCatalog {
    ttl: Duration,
    backoff: Duration,
    cache: Mutex<Option<Cached>>,
}

impl Default for ImageCatalog {
    fn default() -> Self {
        Self {
            ttl: Duration::from_secs(3600),
            backoff: Duration::from_secs(30),
            cache: Mutex::new(None),
        }
    }
}

impl ImageCatalog {
    pub fn new(ttl: Duration, backoff: Duration) -> Result<Self> {
        if ttl.is_zero() {
            return Err(Error::UnsupportedParameter);
        }
        Ok(Self {
            ttl,
            backoff,
            cache: Mutex::new(None),
        })
    }

    pub fn invalidate(&self) -> Result<()> {
        *self.cache.lock().map_err(|_| Error::BackendUnavailable)? = None;
        Ok(())
    }

    pub fn update(
        &self,
        clock: impl Fn() -> SystemTime,
        fallback: impl FnOnce() -> bool,
        fetch: impl FnOnce() -> std::result::Result<Value, Failure>,
    ) -> std::result::Result<Vec<ImageModel>, Failure> {
        let now = clock();
        {
            let cache = self.cache.lock().map_err(|_| Error::BackendUnavailable)?;
            if let Some(cache) = cache.as_ref().filter(|cache| {
                now.duration_since(cache.fetched).unwrap_or(Duration::ZERO) < self.ttl
                    || cache.retry_after.is_some_and(|retry| now < retry)
            }) {
                return Ok(cache.models.clone());
            }
        }
        let fetched = fetch();
        let mut cache = self.cache.lock().map_err(|_| Error::BackendUnavailable)?;
        match fetched {
            Ok(value) => {
                let models = parse_image_models(&value);
                *cache = Some(Cached {
                    fetched: clock(),
                    models: models.clone(),
                    retry_after: None,
                });
                Ok(models)
            }
            Err(error) => {
                if let Some(cache) = cache.as_mut().filter(|_| fallback()) {
                    cache.retry_after = now.checked_add(self.backoff);
                    Ok(cache.models.clone())
                } else {
                    Err(error)
                }
            }
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum DrawThingsState {
    Running,
    ApiOff { reason: Reason },
    NotInstalled { reason: Reason },
}

pub fn probe_draw_things(client: &Client<'_>, deadline: Instant) -> DrawThingsState {
    let deadline = deadline.min(Instant::now() + Duration::from_millis(1500));
    if client.probe_origin(deadline).is_ok() {
        DrawThingsState::Running
    } else if client.local_installation() == Some(false) {
        DrawThingsState::NotInstalled {
            reason: Reason::DrawThingsNotInstalled,
        }
    } else {
        DrawThingsState::ApiOff {
            reason: Reason::DrawThingsApiOff,
        }
    }
}
