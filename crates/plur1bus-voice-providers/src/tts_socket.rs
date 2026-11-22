//! The text-input synthesis dialogue over the shared WebSocket transport.
use crate::{
    elevenlabs::{
        streaming_endpoint, AudioChunk, AudioFormat, StreamUsage, SynthesisOptions, VoiceSettings,
    },
    http::{deadline, Error, MAX_JSON_BYTES},
    realtime::socket_error,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use plur1bus_channels::websocket::{Limits, Peer, Socket, SocketPorts, VoiceKey};
use serde::Serialize;
use serde_json::Value;
use std::time::{Duration, Instant};
use url::Url;

#[derive(Serialize)]
struct Init<'a> {
    text: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    voice_settings: Option<VoiceSettings<'a>>,
    generation_config: Generation,
}

#[derive(Serialize)]
struct Generation {
    chunk_length_schedule: [u16; 4],
}

#[derive(Serialize)]
struct Text<'a> {
    text: &'a str,
}

/// A host supplies text and drains available audio in its own duplex loop.
/// There is no unbounded text or audio queue inside the adapter.
pub struct TtsSocket<'a> {
    socket: Option<Socket>,
    ports: &'a dyn SocketPorts,
    format: AudioFormat,
    sample_rate: u32,
    deadline: Instant,
    usage: StreamUsage,
    input_finished: bool,
    output_finished: bool,
}

impl<'a> TtsSocket<'a> {
    pub fn connect(
        base: &Url,
        key: &str,
        options: &SynthesisOptions<'_>,
        ports: &'a dyn SocketPorts,
        budget: Duration,
        insecure_loopback: bool,
    ) -> Result<Self, Error> {
        let deadline = deadline(budget);
        if key.trim().is_empty() {
            return Err(Error::Auth);
        }
        if ports.cancelled() {
            return Err(Error::Aborted);
        }
        let (sample_rate, parameter) = options.format.rate_and_parameter(options.sample_rate)?;
        let model = options.model.unwrap_or("eleven_flash_v2_5");
        let mut endpoint = streaming_endpoint(base, options.voice)?;
        let scheme = match endpoint.scheme() {
            "https" | "wss" => "wss",
            "http" | "ws" => "ws",
            _ => return Err(Error::InvalidRequest),
        };
        endpoint
            .set_scheme(scheme)
            .map_err(|_| Error::InvalidRequest)?;
        {
            let mut query = endpoint.query_pairs_mut();
            if !model.is_empty() {
                query.append_pair("model_id", model);
            }
            query.append_pair("output_format", &parameter);
            if let Some(language) = options.language.filter(|value| !value.is_empty()) {
                query.append_pair("language_code", language);
            }
            if options.zero_retention {
                query.append_pair("enable_logging", "false");
            }
        }
        let limits = Limits {
            handshake: deadline.saturating_duration_since(Instant::now()),
            message_bytes: MAX_JSON_BYTES,
            frame_bytes: MAX_JSON_BYTES,
            ..Limits::default()
        };
        if limits.handshake.is_zero() {
            return Err(Error::Timeout);
        }
        let socket = Socket::connect_with_voice_key(
            &endpoint,
            VoiceKey::ElevenLabs(key),
            ports,
            limits,
            insecure_loopback,
        )
        .map_err(socket_error)?;
        let mut this = Self {
            socket: Some(socket),
            ports,
            format: options.format,
            sample_rate,
            deadline,
            usage: StreamUsage {
                model: model.into(),
                input_utf16_units: 0,
            },
            input_finished: false,
            output_finished: false,
        };
        let init = serde_json::to_string(&Init {
            text: " ",
            voice_settings: options.voice_settings,
            generation_config: Generation {
                chunk_length_schedule: [120, 160, 250, 290],
            },
        })
        .map_err(|_| Error::InvalidRequest)?;
        this.send(&init)?;
        Ok(this)
    }

    fn operate<T>(
        &mut self,
        operation: impl FnOnce(&mut Socket, Instant) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let result = if self.ports.cancelled() {
            Err(Error::Aborted)
        } else if Instant::now() >= self.deadline {
            Err(Error::Timeout)
        } else {
            self.socket
                .as_mut()
                .ok_or(Error::Closed)
                .and_then(|socket| operation(socket, self.deadline))
        };
        let result = if self.ports.cancelled() {
            Err(Error::Aborted)
        } else if Instant::now() >= self.deadline {
            Err(Error::Timeout)
        } else {
            result
        };
        if result.is_err() {
            self.socket = None;
        }
        result
    }

    fn send(&mut self, message: &str) -> Result<(), Error> {
        self.operate(|socket, deadline| {
            socket
                .send_text_until(message, deadline)
                .map_err(socket_error)
        })
    }

    pub fn send_text(&mut self, text: &str) -> Result<(), Error> {
        if self.input_finished || self.output_finished {
            return Err(Error::Closed);
        }
        if text.is_empty() {
            return Ok(());
        }
        if text.len() > MAX_JSON_BYTES {
            return Err(Error::InvalidRequest);
        }
        let units = text.encode_utf16().count();
        let padded;
        let outgoing = if text.ends_with(' ') {
            text
        } else {
            padded = format!("{text} ");
            &padded
        };
        let encoded =
            serde_json::to_string(&Text { text: outgoing }).map_err(|_| Error::InvalidRequest)?;
        self.send(&encoded)?;
        self.usage.input_utf16_units = self.usage.input_utf16_units.saturating_add(units);
        Ok(())
    }

    pub fn finish_input(&mut self) -> Result<(), Error> {
        if self.input_finished {
            return Ok(());
        }
        self.send(r#"{"text":" ","flush":true}"#)?;
        self.send(r#"{"text":""}"#)?;
        self.input_finished = true;
        Ok(())
    }

    pub fn next_audio(&mut self) -> Result<Option<AudioChunk<Vec<u8>>>, Error> {
        if self.output_finished {
            return Ok(None);
        }
        loop {
            let (audio, final_frame) = self.operate(|socket, deadline| {
                match socket.receive_until(deadline).map_err(socket_error)? {
                    Peer::Text(text) => decode(&text),
                    Peer::Ping | Peer::Pong => Ok((None, false)),
                    Peer::Binary(_) => Err(Error::UpstreamProtocol),
                    Peer::Closed(Some(1008)) => Err(Error::Auth),
                    Peer::Closed(Some(1002 | 1003 | 1007 | 1009)) => Err(Error::UpstreamProtocol),
                    Peer::Closed(_) => Err(Error::Network),
                }
            })?;
            if final_frame {
                if !self.input_finished {
                    self.socket = None;
                    return Err(Error::UpstreamProtocol);
                }
                self.output_finished = true;
                if let Some(mut socket) = self.socket.take() {
                    let _ = socket.close_until(1000, "done", self.deadline);
                }
            }
            if let Some(bytes) = audio {
                return Ok(Some(AudioChunk {
                    bytes,
                    format: self.format,
                    sample_rate: self.sample_rate,
                }));
            }
            if final_frame {
                return Ok(None);
            }
        }
    }

    pub fn usage(&self) -> Option<&StreamUsage> {
        self.output_finished.then_some(&self.usage)
    }
}

fn decode(text: &str) -> Result<(Option<Vec<u8>>, bool), Error> {
    let frame: Value = serde_json::from_str(text).map_err(|_| Error::UpstreamProtocol)?;
    if !frame.is_object() {
        return Err(Error::UpstreamProtocol);
    }
    if frame.get("error").is_some() || frame["message_type"] == "error" {
        return Err(crate::realtime::frame_error(&frame));
    }
    let audio = frame["audio"]
        .as_str()
        .filter(|text| !text.is_empty())
        .map(|text| STANDARD.decode(text).map_err(|_| Error::UpstreamProtocol))
        .transpose()?;
    Ok((audio, frame["isFinal"] == true))
}
