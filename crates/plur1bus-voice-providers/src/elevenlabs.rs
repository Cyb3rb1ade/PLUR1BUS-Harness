//! ElevenLabs buffered synthesis over the cloud HTTP boundary.
use crate::http::{deadline, Client, Error, MAX_BUFFERED_AUDIO_BYTES};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use url::Url;

pub(crate) const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum AudioFormat {
    #[default]
    Pcm16,
    Mp3,
    Opus,
}

impl AudioFormat {
    pub(crate) fn rate_and_parameter(self, rate: Option<u32>) -> Result<(u32, String), Error> {
        let rate = rate.unwrap_or(if self == Self::Opus { 48_000 } else { 24_000 });
        let parameter = match (self, rate) {
            (Self::Pcm16, 8000 | 16000 | 22050 | 24000 | 44100) => format!("pcm_{rate}"),
            (Self::Mp3, 22050) => "mp3_22050_32".into(),
            (Self::Mp3, 24000) => "mp3_24000_48".into(),
            (Self::Mp3, 44100) => "mp3_44100_128".into(),
            (Self::Opus, 48000) => "opus_48000_64".into(),
            _ => return Err(Error::Unsupported),
        };
        Ok((rate, parameter))
    }
}

#[derive(Default)]
pub struct SynthesisOptions<'a> {
    pub format: AudioFormat,
    pub sample_rate: Option<u32>,
    pub voice: &'a str,
    pub model: Option<&'a str>,
    pub language: Option<&'a str>,
    pub voice_settings: Option<&'a Value>,
    pub zero_retention: bool,
}

#[derive(Serialize)]
struct Payload<'a> {
    text: &'a str,
    model_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    voice_settings: Option<&'a Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language_code: Option<&'a str>,
}

pub struct Audio {
    pub bytes: Vec<u8>,
    pub format: AudioFormat,
    pub sample_rate: u32,
    pub model: String,
    pub input_utf16_units: usize,
}

pub fn synthesize(
    client: &Client<'_>,
    base: &Url,
    key: &str,
    text: &str,
    options: &SynthesisOptions<'_>,
    budget: Duration,
) -> Result<Audio, Error> {
    let deadline = deadline(budget);
    if key.trim().is_empty() {
        return Err(Error::Auth);
    }
    let (sample_rate, parameter) = options.format.rate_and_parameter(options.sample_rate)?;
    let model = options.model.unwrap_or("eleven_flash_v2_5");
    let mut endpoint = synthesis_endpoint(base, options.voice, "")?;
    endpoint
        .query_pairs_mut()
        .append_pair("output_format", &parameter);
    if options.zero_retention {
        endpoint
            .query_pairs_mut()
            .append_pair("enable_logging", "false");
    }
    let payload = serde_json::to_vec(&Payload {
        text,
        model_id: model,
        voice_settings: options.voice_settings,
        language_code: options.language.filter(|value| !value.is_empty()),
    })
    .map_err(|_| Error::InvalidRequest)?;
    let bytes = client.bytes_until(
        &endpoint,
        "POST",
        &[
            ("xi-api-key", key),
            ("content-type", "application/json"),
            ("accept", "audio/*"),
        ],
        &payload,
        deadline,
        MAX_BUFFERED_AUDIO_BYTES,
    )?;
    Ok(Audio {
        bytes,
        format: options.format,
        sample_rate,
        model: model.into(),
        input_utf16_units: text.encode_utf16().count(),
    })
}

pub struct AudioChunk<Bytes> {
    pub bytes: Bytes,
    pub format: AudioFormat,
    pub sample_rate: u32,
}

pub struct StreamUsage {
    pub model: String,
    pub input_utf16_units: usize,
}

fn synthesis_endpoint(base: &Url, voice: &str, suffix: &str) -> Result<Url, Error> {
    if voice.is_empty()
        || matches!(voice, "." | "..")
        || base.cannot_be_a_base()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err(Error::InvalidRequest);
    }
    let mut endpoint = base.clone();
    let voice = utf8_percent_encode(voice, URI_COMPONENT);
    endpoint.set_path(&format!(
        "{}/v1/text-to-speech/{voice}{suffix}",
        base.path().trim_end_matches('/')
    ));
    Ok(endpoint)
}

pub(crate) fn streaming_endpoint(base: &Url, voice: &str) -> Result<Url, Error> {
    synthesis_endpoint(base, voice, "/stream-input")
}

/// Deliver each decoded piece immediately. The callback may stop the stream by
/// returning an error. Usage is available after the complete body.
pub fn stream_synthesis(
    client: &Client<'_>,
    base: &Url,
    key: &str,
    text: &str,
    options: &SynthesisOptions<'_>,
    budget: Duration,
    mut on_chunk: impl FnMut(AudioChunk<&[u8]>) -> Result<(), Error>,
) -> Result<StreamUsage, Error> {
    let deadline = deadline(budget);
    if key.trim().is_empty() {
        return Err(Error::Auth);
    }
    let (sample_rate, parameter) = options.format.rate_and_parameter(options.sample_rate)?;
    let model = options.model.unwrap_or("eleven_flash_v2_5");
    let mut endpoint = synthesis_endpoint(base, options.voice, "/stream")?;
    endpoint
        .query_pairs_mut()
        .append_pair("output_format", &parameter);
    if options.zero_retention {
        endpoint
            .query_pairs_mut()
            .append_pair("enable_logging", "false");
    }
    let payload = serde_json::to_vec(&Payload {
        text,
        model_id: model,
        voice_settings: options.voice_settings,
        // The TypeScript streaming HTTP wire has no language_code field.
        language_code: None,
    })
    .map_err(|_| Error::InvalidRequest)?;
    client.with_body(
        &endpoint,
        "POST",
        &[
            ("xi-api-key", key),
            ("content-type", "application/json"),
            ("accept", "audio/*"),
        ],
        &payload,
        deadline,
        |status, reader| {
            if matches!(status, 204 | 205) {
                return Err(Error::BadResponse);
            }
            let mut buffer = [0; 8192];
            loop {
                let count = match client.read_chunk(reader, deadline, &mut buffer) {
                    Err(Error::BadResponse) => return Err(Error::Network),
                    other => other?,
                };
                if count == 0 {
                    return Ok(StreamUsage {
                        model: model.into(),
                        input_utf16_units: text.encode_utf16().count(),
                    });
                }
                on_chunk(AudioChunk {
                    bytes: &buffer[..count],
                    format: options.format,
                    sample_rate,
                })?;
            }
        },
    )
}

pub use crate::tts_socket::TtsSocket;

#[derive(Default)]
pub struct TranscriptionOptions<'a> {
    pub model: Option<&'a str>,
    pub language: Option<&'a str>,
    pub timestamps: bool,
    pub zero_retention: bool,
}

#[derive(PartialEq)]
pub struct Transcript {
    pub text: String,
    pub language: Option<String>,
    pub words: Option<Vec<WordTiming>>,
    pub model: String,
    pub audio_seconds: f64,
}

#[derive(PartialEq)]
pub struct WordTiming {
    pub text: String,
    pub start_ms: f64,
    pub end_ms: f64,
}

#[derive(Clone, Copy)]
pub struct Pcm16<'a> {
    pub bytes: &'a [u8],
    pub sample_rate: u32,
}

/// The host supplies the multipart boundary from its random source.
pub fn transcribe(
    client: &Client<'_>,
    base: &Url,
    key: &str,
    audio: Pcm16<'_>,
    options: &TranscriptionOptions<'_>,
    boundary: &str,
    budget: Duration,
) -> Result<Transcript, Error> {
    let deadline = deadline(budget);
    if key.trim().is_empty() {
        return Err(Error::Auth);
    }
    let Pcm16 {
        bytes: pcm16,
        sample_rate,
    } = audio;
    if !(8_000..=192_000).contains(&sample_rate)
        || pcm16.len() > MAX_BUFFERED_AUDIO_BYTES
        || !pcm16.len().is_multiple_of(2)
        || boundary.is_empty()
        || boundary.len() > 70
        || !boundary
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        || base.cannot_be_a_base()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err(Error::InvalidRequest);
    }
    let model = options.model.unwrap_or("scribe_v2");
    let mut fields = vec![("model_id", model)];
    if let Some(language) = options.language.filter(|value| !value.is_empty()) {
        fields.push(("language_code", language));
    }
    if options.timestamps {
        fields.push(("timestamps_granularity", "word"));
    }
    let separator = format!("--{boundary}");
    if pcm16
        .windows(separator.len())
        .any(|window| window == separator.as_bytes())
        || fields
            .iter()
            .any(|(_, field)| field.contains(&separator) || field.len() > 1024)
    {
        return Err(Error::InvalidRequest);
    }
    let mut body = Vec::new();
    for (name, value) in fields {
        let value = value
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .replace('\n', "\r\n");
        body.extend_from_slice(
            format!(
                "{separator}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(format!("{separator}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n").as_bytes());
    let pcm_bytes = pcm16.len() as u32;
    for segment in [
        b"RIFF".as_slice(),
        &(36 + pcm_bytes).to_le_bytes(),
        b"WAVEfmt ",
        &16_u32.to_le_bytes(),
        &1_u16.to_le_bytes(),
        &1_u16.to_le_bytes(),
        &sample_rate.to_le_bytes(),
        &(sample_rate * 2).to_le_bytes(),
        &2_u16.to_le_bytes(),
        &16_u16.to_le_bytes(),
        b"data",
        &pcm_bytes.to_le_bytes(),
        pcm16,
    ] {
        body.extend_from_slice(segment);
    }
    body.extend_from_slice(format!("\r\n{separator}--\r\n").as_bytes());
    let mut endpoint = base.clone();
    endpoint.set_path(&format!(
        "{}/v1/speech-to-text",
        base.path().trim_end_matches('/')
    ));
    if options.zero_retention {
        endpoint
            .query_pairs_mut()
            .append_pair("enable_logging", "false");
    }
    let content_type = format!("multipart/form-data; boundary={boundary}");
    let result = client.json_until(
        &endpoint,
        "POST",
        &[("xi-api-key", key), ("content-type", &content_type)],
        &body,
        deadline,
    )?;
    let words = if options.timestamps {
        word_timings(&result["words"])
    } else {
        None
    };
    Ok(Transcript {
        text: result["text"].as_str().ok_or(Error::BadResponse)?.into(),
        language: result["language_code"].as_str().map(str::to_owned),
        words,
        model: model.into(),
        audio_seconds: f64::from(pcm_bytes) / (f64::from(sample_rate) * 2.),
    })
}

pub(crate) fn word_timings(value: &Value) -> Option<Vec<WordTiming>> {
    Some(
        value
            .as_array()?
            .iter()
            .filter_map(|word| {
                if word.get("type").is_some_and(|kind| kind != "word") {
                    return None;
                }
                Some(WordTiming {
                    text: word["text"].as_str()?.into(),
                    start_ms: milliseconds(&word["start"]),
                    end_ms: milliseconds(&word["end"]),
                })
            })
            .collect(),
    )
}

fn milliseconds(value: &Value) -> f64 {
    let seconds = value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
        .filter(|value| *value >= 0. && value.is_finite())
        .unwrap_or(0.);
    (seconds * 1000.).round()
}
