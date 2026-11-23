//! Cloud provider registration and discovery. The host selects configuration and owns credentials.

use crate::{
    catalog::{Catalog, Vendor},
    http::{deadline, Client, Error},
    polly::{self, SignedRequests},
};
use serde::Serialize;
use serde_json::Value;
use std::time::{Duration, Instant};
use url::Url;

#[derive(Default)]
pub struct ProviderConfig<'a> {
    pub enabled: bool,
    pub api_key_ref: Option<&'a str>,
    pub base: Option<Url>,
}

#[derive(Default)]
pub struct Config<'a> {
    pub elevenlabs: ProviderConfig<'a>,
    pub elevenlabs_region: Option<&'a str>,
    pub elevenlabs_stt_model: Option<&'a str>,
    pub xai: ProviderConfig<'a>,
    pub gemini: ProviderConfig<'a>,
    pub polly_enabled: bool,
}

pub trait Credentials {
    /// Resolve the configured reference through the host before the deadline.
    fn resolve(&self, reference: &str, deadline: Instant) -> Result<Option<String>, Error>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    Asr,
    Tts,
    Realtime,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Disabled,
    MissingKey,
    Ready,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct Status {
    pub id: &'static str,
    pub state: State,
    pub capabilities: &'static [Capability],
}

#[derive(Clone, Copy)]
enum Provider {
    ElevenLabs,
    Xai,
    Gemini,
    Polly,
}

impl Provider {
    const ALL: [Self; 4] = [Self::ElevenLabs, Self::Xai, Self::Gemini, Self::Polly];

    fn id(self) -> &'static str {
        match self {
            Self::ElevenLabs => "elevenlabs",
            Self::Xai => "xai",
            Self::Gemini => "gemini",
            Self::Polly => "polly",
        }
    }

    fn capabilities(self) -> &'static [Capability] {
        use Capability::{Asr, Realtime, Tts};
        match self {
            Self::ElevenLabs => &[Asr, Tts],
            Self::Xai | Self::Gemini => &[Realtime],
            Self::Polly => &[Tts],
        }
    }
}

#[derive(Default, Serialize)]
pub struct Discovery {
    pub models: Vec<DiscoveredModel>,
    pub voices: Vec<DiscoveredVoice>,
    pub errors: Vec<DiscoveryError>,
}

#[derive(Serialize)]
pub struct DiscoveredModel {
    pub provider: &'static str,
    pub kind: Capability,
    #[serde(flatten)]
    pub model: Value,
}

#[derive(Serialize)]
pub struct DiscoveredVoice {
    pub provider: &'static str,
    #[serde(flatten)]
    pub voice: Value,
}

#[derive(Serialize)]
pub struct DiscoveryError {
    pub provider: &'static str,
    pub kind: Capability,
    pub code: &'static str,
}

pub struct Registry<'a> {
    config: Config<'a>,
    client: Client<'a>,
    credentials: &'a dyn Credentials,
    polly: Option<&'a dyn SignedRequests>,
}

impl<'a> Registry<'a> {
    pub fn new(
        config: Config<'a>,
        client: Client<'a>,
        credentials: &'a dyn Credentials,
        polly: Option<&'a dyn SignedRequests>,
    ) -> Self {
        Self {
            config,
            client,
            credentials,
            polly,
        }
    }

    fn status_for(&self, provider: Provider) -> Status {
        let state = match self.cloud_config(provider) {
            Some(config) if !config.enabled => State::Disabled,
            Some(config) if config.api_key_ref.is_none_or(str::is_empty) => State::MissingKey,
            None if !self.config.polly_enabled => State::Disabled,
            _ => State::Ready,
        };
        Status {
            id: provider.id(),
            state,
            capabilities: provider.capabilities(),
        }
    }

    pub fn status(&self) -> [Status; 4] {
        Provider::ALL.map(|provider| self.status_for(provider))
    }

    pub fn contains(&self, kind: Capability, id: &str) -> bool {
        self.status().iter().any(|status| {
            status.id == id && status.state == State::Ready && status.capabilities.contains(&kind)
        })
    }

    /// Run independent discoveries in TypeScript registry order. Each call has
    /// its own budget including credential resolution, pagination and reads.
    pub fn discover(&self, budget: Duration) -> Discovery {
        let mut result = Discovery::default();
        for kind in [Capability::Tts, Capability::Asr, Capability::Realtime] {
            for provider in Provider::ALL {
                let status = self.status_for(provider);
                if status.state != State::Ready || !status.capabilities.contains(&kind) {
                    continue;
                }
                let id = status.id;
                let error = |error: Error| DiscoveryError {
                    provider: id,
                    kind,
                    code: error.code(),
                };
                match self.models(provider, kind, budget) {
                    Ok(models) => {
                        result
                            .models
                            .extend(models.into_iter().map(|model| DiscoveredModel {
                                provider: id,
                                kind,
                                model,
                            }))
                    }
                    Err(failure) => result.errors.push(error(failure)),
                }
                if kind == Capability::Tts {
                    match self.voices(provider, budget) {
                        Ok(voices) => {
                            result
                                .voices
                                .extend(voices.into_iter().map(|voice| DiscoveredVoice {
                                    provider: id,
                                    voice,
                                }))
                        }
                        Err(failure) => result.errors.push(error(failure)),
                    }
                }
            }
        }
        result
    }

    fn cloud_config(&self, provider: Provider) -> Option<&ProviderConfig<'_>> {
        match provider {
            Provider::ElevenLabs => Some(&self.config.elevenlabs),
            Provider::Xai => Some(&self.config.xai),
            Provider::Gemini => Some(&self.config.gemini),
            Provider::Polly => None,
        }
    }

    fn models(
        &self,
        provider: Provider,
        kind: Capability,
        budget: Duration,
    ) -> Result<Vec<Value>, Error> {
        if matches!(provider, Provider::Polly) {
            return polly::list_models(self.polly.ok_or(Error::Unsupported)?, budget);
        }
        self.with_catalog(provider, budget, |catalog, key, deadline| match kind {
            Capability::Asr => {
                catalog.elevenlabs_asr_models_until(key, self.config.elevenlabs_stt_model, deadline)
            }
            _ => catalog.models_until(key, deadline),
        })
    }

    fn voices(&self, provider: Provider, budget: Duration) -> Result<Vec<Value>, Error> {
        if matches!(provider, Provider::Polly) {
            return polly::list_voices(self.polly.ok_or(Error::Unsupported)?, budget);
        }
        self.with_catalog(provider, budget, |catalog, key, deadline| {
            catalog.elevenlabs_voices_until(key, deadline)
        })
    }

    fn with_catalog(
        &self,
        provider: Provider,
        budget: Duration,
        read: impl FnOnce(Catalog<'_>, &str, Instant) -> Result<Vec<Value>, Error>,
    ) -> Result<Vec<Value>, Error> {
        let deadline = deadline(budget);
        let config = self.cloud_config(provider).ok_or(Error::Unsupported)?;
        let reference = config
            .api_key_ref
            .filter(|reference| !reference.is_empty())
            .ok_or(Error::Auth)?;
        self.client.check(deadline)?;
        let resolved = self.credentials.resolve(reference, deadline);
        self.client.check(deadline)?;
        let key = resolved
            .map_err(|_| Error::Auth)?
            .filter(|value| !value.is_empty() && !value.bytes().any(|byte| byte.is_ascii_control()))
            .ok_or(Error::Auth)?;
        let (vendor, default_base) = match provider {
            Provider::ElevenLabs => (
                Vendor::ElevenLabs,
                elevenlabs_base(self.config.elevenlabs_region),
            ),
            Provider::Xai => (Vendor::Xai, "https://api.x.ai"),
            Provider::Gemini => (Vendor::Gemini, "https://generativelanguage.googleapis.com"),
            Provider::Polly => return Err(Error::Unsupported),
        };
        let base = config
            .base
            .clone()
            .map_or_else(|| Url::parse(default_base), Ok)
            .map_err(|_| Error::InvalidRequest)?;
        let catalog = Catalog::new(self.client, base, vendor)?;
        read(catalog, &key, deadline)
    }
}

fn elevenlabs_base(region: Option<&str>) -> &'static str {
    match region {
        Some("us") => "https://api.us.elevenlabs.io",
        Some("eu") => "https://api.eu.residency.elevenlabs.io",
        Some("in") => "https://api.in.residency.elevenlabs.io",
        Some("sg") => "https://api.sg.residency.elevenlabs.io",
        _ => "https://api.elevenlabs.io",
    }
}
