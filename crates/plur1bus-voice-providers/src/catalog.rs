//! Cloud provider catalog calls over the shared bounded JSON transport.
use crate::http::{deadline, Client, Error};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use url::Url;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Vendor {
    ElevenLabs,
    Gemini,
    Xai,
}

pub struct Catalog<'a> {
    client: Client<'a>,
    base: Url,
    vendor: Vendor,
}

impl<'a> Catalog<'a> {
    pub fn new(client: Client<'a>, base: Url, vendor: Vendor) -> Result<Self, Error> {
        if base.query().is_some() || base.fragment().is_some() || base.cannot_be_a_base() {
            return Err(Error::InvalidRequest);
        }
        Ok(Self {
            client,
            base,
            vendor,
        })
    }

    fn endpoint(&self, path: &str) -> Url {
        let mut url = self.base.clone();
        let path = format!("{}{}", self.base.path().trim_end_matches('/'), path);
        url.set_path(&path);
        url
    }

    fn fetch(&self, url: &Url, key: &str, deadline: Instant) -> Result<Value, Error> {
        if key.trim().is_empty() {
            return Err(Error::Auth);
        }
        let bearer;
        let header = match self.vendor {
            Vendor::ElevenLabs => ("xi-api-key", key),
            Vendor::Gemini => ("x-goog-api-key", key),
            Vendor::Xai => {
                bearer = format!("Bearer {key}");
                ("authorization", bearer.as_str())
            }
        };
        self.client.json_until(url, "GET", &[header], b"", deadline)
    }

    pub fn list_models(&self, key: &str, budget: Duration) -> Result<Vec<Value>, Error> {
        self.models_until(key, deadline(budget))
    }

    pub(crate) fn models_until(&self, key: &str, deadline: Instant) -> Result<Vec<Value>, Error> {
        match self.vendor {
            Vendor::ElevenLabs => self.elevenlabs_models(key, deadline, "tts"),
            Vendor::Xai => {
                let page = self.fetch(&self.endpoint("/v1/models"), key, deadline)?;
                Ok(page["data"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|row| {
                        let id = row["id"].as_str()?;
                        let folded = id.to_ascii_lowercase();
                        let voice = ["voice", "realtime", "live"]
                            .iter()
                            .any(|word| folded.contains(word));
                        let caps: &[&str] = if voice { &["realtime"] } else { &[] };
                        Some(json!({"id":id,"name":id,"capabilities":caps}))
                    })
                    .collect())
            }
            Vendor::Gemini => {
                let mut endpoint = self.endpoint("/v1beta/models");
                let mut token: Option<String> = None;
                let mut out = Vec::new();
                for _ in 0..10 {
                    endpoint.set_query(None);
                    endpoint.query_pairs_mut().append_pair("pageSize", "100");
                    if let Some(next) = token.take() {
                        endpoint.query_pairs_mut().append_pair("pageToken", &next);
                    }
                    let page = self.fetch(&endpoint, key, deadline)?;
                    for row in page["models"].as_array().into_iter().flatten() {
                        let Some(id) = row["name"].as_str() else {
                            continue;
                        };
                        let mut caps = Vec::new();
                        if row["supportedGenerationMethods"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|method| method == "bidiGenerateContent")
                        {
                            caps.push("realtime");
                            let folded = id.to_ascii_lowercase();
                            if folded.contains("native-audio") || folded.contains("live") {
                                caps.push("native-audio");
                            }
                        }
                        out.push(json!({"id":id,"name":display_name(&row["displayName"], id),"capabilities":caps}));
                    }
                    token = next_token(&page["nextPageToken"]);
                    if token.is_none() {
                        break;
                    }
                }
                Ok(out)
            }
        }
    }

    fn elevenlabs_models(
        &self,
        key: &str,
        deadline: Instant,
        capability: &str,
    ) -> Result<Vec<Value>, Error> {
        let page = self.fetch(&self.endpoint("/v1/models"), key, deadline)?;
        let rows = page.as_array().ok_or(Error::BadResponse)?;
        Ok(rows
            .iter()
            .filter_map(|row| {
                let id = row["model_id"].as_str()?;
                let caps = [
                    (row["can_do_text_to_speech"] == true, "tts"),
                    (row["can_do_voice_conversion"] == true, "voice-conversion"),
                    (id.starts_with("scribe"), "asr"),
                ];
                let caps: Vec<_> = caps
                    .into_iter()
                    .filter_map(|(yes, cap)| yes.then_some(cap))
                    .collect();
                if !caps.contains(&capability) {
                    return None;
                }
                let mut value =
                    json!({"id":id,"name": display_name(&row["name"], id), "capabilities": caps});
                let languages: Vec<_> = row["languages"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|item| item["language_id"].as_str())
                    .collect();
                if !languages.is_empty() {
                    value["languages"] = json!(languages);
                }
                Some(value)
            })
            .collect())
    }

    pub fn list_elevenlabs_asr_models(
        &self,
        key: &str,
        default_model: Option<&str>,
        budget: Duration,
    ) -> Result<Vec<Value>, Error> {
        self.elevenlabs_asr_models_until(key, default_model, deadline(budget))
    }

    pub(crate) fn elevenlabs_asr_models_until(
        &self,
        key: &str,
        default_model: Option<&str>,
        deadline: Instant,
    ) -> Result<Vec<Value>, Error> {
        if self.vendor != Vendor::ElevenLabs {
            return Err(Error::InvalidRequest);
        }
        let mut models = self.elevenlabs_models(key, deadline, "asr")?;
        if models.is_empty() {
            let model = default_model.unwrap_or("scribe_v2");
            models.push(json!({"id":model,"name":model,"capabilities":["asr"]}));
        }
        Ok(models)
    }

    /// Accept the host's explicit, configured or previously discovered choice
    /// first. The host owns the lifetime of the discovery cache.
    pub fn realtime_model(
        &self,
        key: &str,
        desired: Option<&str>,
        budget: Duration,
    ) -> Result<String, Error> {
        if self.vendor == Vendor::ElevenLabs {
            return Err(Error::Unsupported);
        }
        if let Some(model) = desired.filter(|id| !id.is_empty()) {
            return Ok(model.into());
        }
        let models = match self.list_models(key, budget) {
            Ok(models) => models,
            Err(error)
                if self.vendor == Vendor::Gemini
                    && !matches!(error, Error::Auth | Error::Aborted) =>
            {
                Vec::new()
            }
            Err(error) => return Err(error),
        };
        let with_capability = |cap: &str| {
            models.iter().find_map(|model| {
                let caps = model["capabilities"].as_array()?;
                caps.iter()
                    .any(|capability| capability == cap)
                    .then(|| model["id"].as_str())
                    .flatten()
            })
        };
        if self.vendor == Vendor::Gemini {
            return Ok(with_capability("native-audio")
                .or_else(|| with_capability("realtime"))
                .unwrap_or("models/gemini-3.8-live")
                .into());
        }
        with_capability("realtime")
            .map(str::to_owned)
            .ok_or(Error::InvalidRequest)
    }

    pub fn list_elevenlabs_voices(&self, key: &str, budget: Duration) -> Result<Vec<Value>, Error> {
        self.elevenlabs_voices_until(key, deadline(budget))
    }

    pub(crate) fn elevenlabs_voices_until(
        &self,
        key: &str,
        deadline: Instant,
    ) -> Result<Vec<Value>, Error> {
        if self.vendor != Vendor::ElevenLabs {
            return Err(Error::InvalidRequest);
        }
        let mut endpoint = self.endpoint("/v2/voices");
        let mut token: Option<String> = None;
        let mut out = Vec::new();
        for _ in 0..20 {
            endpoint.set_query(None);
            endpoint.query_pairs_mut().append_pair("page_size", "100");
            if let Some(next) = token.take() {
                endpoint
                    .query_pairs_mut()
                    .append_pair("next_page_token", &next);
            }
            let page = self.fetch(&endpoint, key, deadline)?;
            for row in page["voices"].as_array().into_iter().flatten() {
                let Some(id) = row["voice_id"].as_str() else {
                    continue;
                };
                let mut voice = json!({"id":id,"name": display_name(&row["name"], id)});
                let mut languages = Vec::new();
                let mut seen = std::collections::HashSet::new();
                let verified = row["verified_languages"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|item| item["language"].as_str());
                for language in verified.chain(row["labels"]["language"].as_str()) {
                    if seen.insert(language) {
                        languages.push(language);
                    }
                }
                if !languages.is_empty() {
                    voice["languages"] = json!(languages);
                }
                if let Some(gender) = row["labels"]["gender"].as_str() {
                    voice["gender"] = json!(gender);
                }
                if let Some(preview) = row["preview_url"].as_str() {
                    voice["previewUrl"] = json!(preview);
                }
                out.push(voice);
            }
            if page["has_more"] != true {
                break;
            }
            token = next_token(&page["next_page_token"]);
            if token.is_none() {
                break;
            }
        }
        Ok(out)
    }
}

fn next_token(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
}

fn display_name<'a>(value: &'a Value, default: &'a str) -> &'a str {
    value.as_str().unwrap_or(default)
}
