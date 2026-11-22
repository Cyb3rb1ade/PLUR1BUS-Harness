//! Polly request parameters. The signed AWS transport and credential chain belong to the host.
use crate::elevenlabs::AudioFormat;
use crate::http::{deadline, read_bounded, Error, Ports, MAX_BUFFERED_AUDIO_BYTES, MAX_JSON_BYTES};
use serde_json::{json, Value};
use std::{
    io::Read,
    time::{Duration, Instant},
};

pub struct Request<'a> {
    pub text: &'a str,
    pub voice: &'a str,
    pub engine: &'a str,
    pub output_format: &'static str,
    pub sample_rate: String,
    pub language: Option<&'a str>,
}

pub trait SignedRequests: Ports {
    /// Authorize the configured AWS endpoint, sign the request, and complete
    /// every read from the returned response before the same deadline.
    fn synthesize(&self, input: &Request<'_>, deadline: Instant) -> Result<Box<dyn Read>, Error>;

    /// Return the decoded DescribeVoices response. The host must keep each read
    /// within the deadline. The library counts JSON bytes before parsing.
    fn describe_voices(
        &self,
        next_token: Option<&str>,
        deadline: Instant,
    ) -> Result<Box<dyn Read>, Error>;
}

#[derive(Default)]
pub struct Options<'a> {
    pub voice: &'a str,
    pub model: Option<&'a str>,
    pub format: AudioFormat,
    pub sample_rate: Option<u32>,
    pub language: Option<&'a str>,
}

pub fn synthesize(
    host: &dyn SignedRequests,
    text: &str,
    options: &Options<'_>,
    budget: Duration,
) -> Result<super::elevenlabs::Audio, Error> {
    synthesize_until(host, text, options, deadline(budget))
}

fn synthesize_until(
    host: &dyn SignedRequests,
    text: &str,
    options: &Options<'_>,
    deadline: Instant,
) -> Result<super::elevenlabs::Audio, Error> {
    let chars = text.encode_utf16().take(3001).count();
    if chars > 3000 || options.voice.is_empty() {
        return Err(Error::InvalidRequest);
    }
    let sample_rate = options.sample_rate.unwrap_or(16_000);
    let output_format = match (options.format, sample_rate) {
        (AudioFormat::Pcm16, 8_000 | 16_000) => "pcm",
        (AudioFormat::Mp3, 8_000 | 16_000 | 22_050 | 24_000 | 44_100 | 48_000) => "mp3",
        _ => return Err(Error::Unsupported),
    };
    super::http::check(host, deadline)?;
    let model = options.model.unwrap_or("neural");
    let mut response = host.synthesize(
        &Request {
            text,
            voice: options.voice,
            engine: model,
            output_format,
            sample_rate: sample_rate.to_string(),
            language: options.language.filter(|lang| !lang.is_empty()),
        },
        deadline,
    )?;
    let bytes = read_bounded(&mut response, host, deadline, MAX_BUFFERED_AUDIO_BYTES)?;
    Ok(super::elevenlabs::Audio {
        bytes,
        format: options.format,
        sample_rate,
        model: model.into(),
        input_utf16_units: chars,
    })
}

/// Convert a series of text deltas into complete signed requests in order.
pub fn synthesize_stream<'a>(
    host: &dyn SignedRequests,
    chunks: impl IntoIterator<Item = &'a str>,
    options: &Options<'_>,
    max_words: Option<usize>,
    budget: Duration,
    mut on_audio: impl FnMut(super::elevenlabs::Audio) -> Result<(), Error>,
) -> Result<(), Error> {
    let deadline = deadline(budget);
    let mut sentences = crate::sentences::SentenceWindows::new(max_words);
    for delta in chunks {
        super::http::check(host, deadline)?;
        for sentence in sentences.push(delta)? {
            on_audio(synthesize_until(host, &sentence, options, deadline)?)?;
        }
    }
    for sentence in sentences.finish() {
        on_audio(synthesize_until(host, &sentence, options, deadline)?)?;
    }
    Ok(())
}

pub fn list_voices(host: &dyn SignedRequests, budget: Duration) -> Result<Vec<Value>, Error> {
    let deadline = deadline(budget);
    let mut result = Vec::new();
    let mut token = None;
    for _ in 0..20 {
        super::http::check(host, deadline)?;
        let mut response = host.describe_voices(token.as_deref(), deadline)?;
        let bytes = read_bounded(&mut response, host, deadline, MAX_JSON_BYTES)?;
        let page: Value = serde_json::from_slice(&bytes).map_err(|_| Error::BadResponse)?;
        if !page.is_object() {
            return Err(Error::BadResponse);
        }
        for row in page["Voices"].as_array().into_iter().flatten() {
            let Some(id) = row["Id"].as_str().filter(|id| !id.is_empty()) else {
                continue;
            };
            let name = row["Name"].as_str().unwrap_or(id);
            let mut voice = json!({"id":id,"name":name});
            let languages: Vec<&str> = row["LanguageCode"]
                .as_str()
                .into_iter()
                .chain(
                    row["AdditionalLanguageCodes"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str),
                )
                .filter(|language| !language.is_empty())
                .collect();
            if !languages.is_empty() {
                voice["languages"] = json!(languages);
            }
            if let Some(gender) = row["Gender"].as_str().filter(|gender| !gender.is_empty()) {
                voice["gender"] = json!(gender);
            }
            if let Some(engines) = row["SupportedEngines"]
                .as_array()
                .filter(|engines| !engines.is_empty())
            {
                voice["engines"] = json!(engines);
            }
            result.push(voice);
        }
        token = page["NextToken"]
            .as_str()
            .filter(|token| !token.is_empty())
            .map(str::to_owned);
        if token.is_none() {
            break;
        }
    }
    Ok(result)
}

/// Polly publishes engines through the voice catalog, not a separate API.
pub fn list_models(host: &dyn SignedRequests, budget: Duration) -> Result<Vec<Value>, Error> {
    let voices = list_voices(host, budget)?;
    let engines: std::collections::BTreeSet<_> = voices
        .iter()
        .flat_map(|voice| voice["engines"].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
        .collect();
    Ok(engines
        .into_iter()
        .map(|id| json!({"id": id, "name": id, "capabilities": ["tts"]}))
        .collect())
}
