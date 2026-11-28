//! Polly requests. The host provides AWS signing and credentials.
use crate::elevenlabs::AudioFormat;
use crate::http::{
    check_encoding, deadline, decoded_reader, read_bounded, Client, Error, Ports, StreamLimits,
    MAX_BUFFERED_AUDIO_BYTES, MAX_JSON_BYTES,
};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    io::Read,
    net::SocketAddr,
    time::{Duration, Instant},
};
use url::Url;

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
    fn synthesize(
        &self,
        input: &Request<'_>,
        deadline: Instant,
    ) -> Result<Box<dyn Read + '_>, Error>;

    /// Return the decoded DescribeVoices response. The host must keep each read
    /// within the deadline. The library counts JSON bytes before parsing.
    fn describe_voices(
        &self,
        next_token: Option<&str>,
        deadline: Instant,
    ) -> Result<Box<dyn Read + '_>, Error>;
}

pub trait Signer: Ports {
    /// After endpoint authorization, add signature and lease headers for these
    /// exact request bytes. Return only additional headers.
    fn sign(
        &self,
        endpoint: &Url,
        method: &str,
        headers: &[(&str, &str)],
        body: &[u8],
        deadline: Instant,
    ) -> Result<Vec<(String, String)>, Error>;
}

/// The Polly REST-JSON dialogue over the common pinned HTTP client.
pub struct Http<'a> {
    base: Url,
    signer: &'a dyn Signer,
    client: Client<'a>,
}

impl<'a> Http<'a> {
    pub fn new(base: Url, signer: &'a dyn Signer) -> Result<Self, Error> {
        if base.cannot_be_a_base() || base.query().is_some() || base.fragment().is_some() {
            return Err(Error::InvalidRequest);
        }
        Ok(Self {
            base,
            signer,
            client: Client::new(signer),
        })
    }

    pub fn with_loopback_http(mut self) -> Self {
        self.client = self.client.with_loopback_http();
        self
    }

    fn endpoint(&self, path: &str) -> Url {
        let mut endpoint = self.base.clone();
        endpoint.set_path(&format!("{}{path}", self.base.path().trim_end_matches('/')));
        endpoint
    }
}

impl Ports for Http<'_> {
    fn wall_time(&self) -> std::time::SystemTime {
        self.signer.wall_time()
    }

    fn pin(&self, endpoint: &Url, deadline: Instant) -> Option<SocketAddr> {
        self.signer.pin(endpoint, deadline)
    }

    fn cancelled(&self) -> bool {
        self.signer.cancelled()
    }

    fn stream_limits(&self) -> StreamLimits {
        self.signer.stream_limits()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct Speech<'a> {
    engine: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    language_code: Option<&'a str>,
    output_format: &'a str,
    sample_rate: &'a str,
    text: &'a str,
    voice_id: &'a str,
}

impl SignedRequests for Http<'_> {
    fn synthesize(
        &self,
        input: &Request<'_>,
        deadline: Instant,
    ) -> Result<Box<dyn Read + '_>, Error> {
        let body = serde_json::to_vec(&Speech {
            engine: input.engine,
            language_code: input.language,
            output_format: input.output_format,
            sample_rate: &input.sample_rate,
            text: input.text,
            voice_id: input.voice,
        })
        .map_err(|_| Error::InvalidRequest)?;
        self.client.signed_reader_until(
            &self.endpoint("/v1/speech"),
            "POST",
            &[("content-type", "application/json")],
            &body,
            deadline,
            self.signer,
        )
    }

    fn describe_voices(
        &self,
        next_token: Option<&str>,
        deadline: Instant,
    ) -> Result<Box<dyn Read + '_>, Error> {
        const AWS_COMPONENT: &percent_encoding::AsciiSet = &NON_ALPHANUMERIC
            .remove(b'-')
            .remove(b'.')
            .remove(b'_')
            .remove(b'~');
        let mut endpoint = self.endpoint("/v1/voices");
        if let Some(token) = next_token {
            endpoint.set_query(Some(&format!(
                "NextToken={}",
                utf8_percent_encode(token, AWS_COMPONENT)
            )));
        }
        self.client
            .signed_reader_until(&endpoint, "GET", &[], b"", deadline, self.signer)
    }
}

const MAX_ERROR_BYTES: usize = 64 * 1024;

pub(crate) fn response_error(
    response: ureq::http::Response<ureq::Body>,
    signal: &plur1bus_providers::HttpCancellation,
    ports: &dyn Ports,
    deadline: Instant,
) -> Error {
    let status = response.status().as_u16();
    if let Some(code) = response
        .headers()
        .get("x-amzn-errortype")
        .and_then(|value| value.to_str().ok())
    {
        return aws_error(code, status);
    }
    if let Err(error) = check_encoding(response.headers()) {
        return error;
    }
    let mut reader = match decoded_reader(response, signal, ports) {
        Ok(reader) => reader,
        Err(error) => return error,
    };
    let bytes = match read_bounded(&mut reader, ports, deadline, MAX_ERROR_BYTES) {
        Ok(bytes) => bytes,
        Err(error) => return error,
    };
    let data: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let code = ["code", "Code", "__type"]
        .iter()
        .find_map(|key| data[*key].as_str());
    aws_error(code.unwrap_or_default(), status)
}

fn aws_error(code: &str, status: u16) -> Error {
    let code = code.split(':').next().unwrap_or_default();
    let code = code.rsplit('#').next().unwrap_or_default();
    let has = |patterns: &[&str]| patterns.iter().any(|pattern| code.contains(pattern));
    if code.contains("AbortError") {
        Error::Aborted
    } else if matches!(status, 401 | 403)
        || has(&[
            "CredentialsProviderError",
            "ExpiredToken",
            "UnrecognizedClient",
            "InvalidSignature",
            "AccessDenied",
            "SignatureDoesNotMatch",
            "UnauthorizedException",
            "NotAuthorized",
        ])
    {
        Error::Auth
    } else if status == 429 || has(&["Throttl", "TooManyRequests", "LimitExceeded"]) {
        Error::RateLimited
    } else if status >= 500 || has(&["ServiceFailure", "ServiceUnavailable", "InternalFailure"]) {
        Error::Overloaded
    } else if matches!(status, 400 | 404 | 413 | 422)
        || has(&[
            "Validation",
            "InvalidSsml",
            "InvalidSampleRate",
            "TextLengthExceeded",
            "VoiceNotFound",
            "LanguageNotSupported",
            "EngineNotSupported",
            "SsmlMarksNotSupported",
            "InvalidParameter",
        ])
    {
        Error::InvalidRequest
    } else if code.contains("Timeout") {
        Error::Timeout
    } else {
        Error::Network
    }
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
    let (deadline, mut audio_budget) = host.stream_limits().start(budget);
    let mut sentences = crate::sentences::SentenceWindows::new(max_words);
    let check = || super::http::check(host, deadline);
    let mut synthesize = |sentence: String| {
        if audio_budget.exhausted() {
            return Err(Error::StreamLimit);
        }
        let audio = synthesize_until(host, &sentence, options, deadline)
            .map_err(|error| audio_budget.error(error))?;
        audio_budget.charge(audio.bytes.len())?;
        on_audio(audio).map_err(|error| audio_budget.error(error))
    };
    let result = (|| {
        for delta in chunks {
            check()?;
            for sentence in sentences.push(delta, &check)? {
                synthesize(sentence)?;
            }
        }
        for sentence in sentences.finish(&check)? {
            synthesize(sentence)?;
        }
        Ok(())
    })();
    result.map_err(|error| audio_budget.error(error))
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
