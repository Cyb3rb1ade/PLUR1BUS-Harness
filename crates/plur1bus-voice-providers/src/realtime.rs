//! Blocking cloud realtime sessions. The host owns model choice, TLS and pacing.
use crate::http::{Error, MAX_JSON_BYTES};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use plur1bus_channels::websocket::{self, Limits, Peer, Socket, SocketPorts, VoiceKey};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use url::Url;

#[derive(Clone, Copy)]
pub enum Vendor {
    Grok,
    Gemini,
    ElevenLabsAsr,
}

pub struct Options<'a> {
    pub vendor: Vendor,
    pub model: &'a str,
    pub voice: Option<&'a str>,
    pub instructions: Option<&'a str>,
    pub tools: &'a [Tool<'a>],
    pub input_rate: u32,
}

pub struct Tool<'a> {
    pub name: &'a str,
    pub description: Option<&'a str>,
    pub parameters: Option<&'a Value>,
}

pub struct Session {
    socket: Socket,
    vendor: Vendor,
    input_rate: u32,
    ready: bool,
    muted: bool,
    closed: bool,
}

/// Events are returned synchronously, so the wire layer does not queue an unbounded backlog.
#[derive(PartialEq)]
pub enum Event {
    Ready,
    Audio {
        bytes: Vec<u8>,
        sample_rate: u32,
    },
    Transcript {
        role: &'static str,
        text: String,
        final_: bool,
    },
    ToolCall {
        id: String,
        name: String,
        arguments: Value,
    },
    Usage {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },
    Interrupted,
    TurnDone,
    Closed,
}

impl std::fmt::Debug for Event {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(match self {
            Self::Ready => "Ready",
            Self::Audio { .. } => "Audio",
            Self::Transcript { .. } => "Transcript",
            Self::ToolCall { .. } => "ToolCall",
            Self::Usage { .. } => "Usage",
            Self::Interrupted => "Interrupted",
            Self::TurnDone => "TurnDone",
            Self::Closed => "Closed",
        })
    }
}

impl Session {
    pub fn connect(
        base: &Url,
        key: &str,
        options: &Options<'_>,
        ports: &dyn SocketPorts,
        wall_time: Duration,
        insecure_loopback: bool,
    ) -> Result<Self, Error> {
        if key.trim().is_empty() {
            return Err(Error::Auth);
        }
        if options.model.is_empty()
            || !(8_000..=192_000).contains(&options.input_rate)
            || base.query().is_some()
            || base.fragment().is_some()
        {
            return Err(Error::InvalidRequest);
        }
        let mut endpoint = base.clone();
        let scheme = match base.scheme() {
            "https" | "wss" => "wss",
            "http" | "ws" if insecure_loopback => "ws",
            _ => return Err(Error::InvalidRequest),
        };
        endpoint
            .set_scheme(scheme)
            .map_err(|_| Error::InvalidRequest)?;
        let suffix = match options.vendor {
            Vendor::Grok => "/v1/realtime",
            Vendor::Gemini => {
                "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
            }
            Vendor::ElevenLabsAsr => "/v1/speech-to-text/realtime",
        };
        endpoint.set_path(&format!("{}{suffix}", base.path().trim_end_matches('/')));
        let limits = Limits {
            message_bytes: MAX_JSON_BYTES,
            frame_bytes: MAX_JSON_BYTES,
            handshake: wall_time,
            read: wall_time,
            write: wall_time,
        };
        let socket = match options.vendor {
            Vendor::Grok => {
                endpoint.set_query(Some(&format!("model={}", encode_component(options.model))));
                Socket::connect(
                    &endpoint,
                    &[("authorization", &format!("Bearer {key}"))],
                    ports,
                    limits,
                    insecure_loopback,
                )
            }
            Vendor::Gemini => Socket::connect_with_voice_key(
                &endpoint,
                VoiceKey::Gemini(key),
                ports,
                limits,
                insecure_loopback,
            ),
            Vendor::ElevenLabsAsr => {
                endpoint
                    .query_pairs_mut()
                    .append_pair("model_id", options.model)
                    .append_pair("audio_format", &format!("pcm_{}", options.input_rate))
                    .append_pair("commit_strategy", "manual");
                Socket::connect_with_voice_key(
                    &endpoint,
                    VoiceKey::ElevenLabs(key),
                    ports,
                    limits,
                    insecure_loopback,
                )
            }
        }
        .map_err(socket_error)?;
        let mut session = Self {
            socket,
            vendor: options.vendor,
            input_rate: options.input_rate,
            ready: false,
            muted: false,
            closed: false,
        };
        if let Some(setup) = setup(options) {
            session.send(&setup)?;
        }
        Ok(session)
    }

    pub fn send_audio(&mut self, pcm16: &[u8]) -> Result<(), Error> {
        self.require_ready()?;
        if pcm16.len() > (MAX_JSON_BYTES - 256) / 4 * 3 || !pcm16.len().is_multiple_of(2) {
            return Err(Error::InvalidRequest);
        }
        let encoded = STANDARD.encode(pcm16);
        let message = match self.vendor {
            Vendor::Grok => json!({"type":"input_audio_buffer.append","audio":encoded}),
            Vendor::Gemini => {
                json!({"realtimeInput":{"audio":{"data":encoded,"mimeType":format!("audio/pcm;rate={}", self.input_rate)}}})
            }
            Vendor::ElevenLabsAsr => {
                json!({"message_type":"input_audio_chunk","audio_base_64":encoded,"commit":false,"sample_rate":self.input_rate})
            }
        };
        self.send(&message)
    }

    pub fn send_text(&mut self, text: &str) -> Result<(), Error> {
        self.require_ready()?;
        if text.len() > MAX_JSON_BYTES {
            return Err(Error::InvalidRequest);
        }
        match self.vendor {
            Vendor::Grok => {
                self.send(&json!({"type":"conversation.item.create","item":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}}))?;
                self.send(&json!({"type":"response.create"}))
            }
            Vendor::Gemini => self.send(&json!({"clientContent":{"turns":[{"role":"user","parts":[{"text":text}]}],"turnComplete":true}})),
            Vendor::ElevenLabsAsr => Err(Error::Unsupported),
        }
    }

    /// The host holds the call ID and function name from the decoded tool event.
    pub fn submit_tool_result(
        &mut self,
        call_id: &str,
        name: &str,
        value: &Value,
    ) -> Result<(), Error> {
        self.require_ready()?;
        match self.vendor {
            Vendor::Grok => {
                let output = value
                    .as_str()
                    .map_or_else(|| value.to_string(), str::to_owned);
                self.send(&json!({"type":"conversation.item.create","item":{"type":"function_call_output","call_id":call_id,"output":output}}))
            }
            Vendor::Gemini => {
                let response = if value.is_object() || value.is_array() {
                    value.clone()
                } else {
                    json!({"output":value})
                };
                self.send(&json!({"toolResponse":{"functionResponses":[{"id":call_id,"name":name,"response":response}]}}))
            }
            Vendor::ElevenLabsAsr => Err(Error::Unsupported),
        }
    }

    pub fn interrupt(&mut self) -> Result<(), Error> {
        self.require_ready()?;
        match self.vendor {
            Vendor::Grok => self.send(&json!({"type":"response.cancel"})),
            Vendor::Gemini => {
                self.muted = true;
                Ok(())
            }
            Vendor::ElevenLabsAsr => Err(Error::Unsupported),
        }
    }

    pub fn commit(&mut self) -> Result<(), Error> {
        self.require_ready()?;
        match self.vendor {
            Vendor::ElevenLabsAsr => self.send(&json!({"message_type":"input_audio_chunk","audio_base_64":"","commit":true,"sample_rate":self.input_rate})),
            _ => Err(Error::Unsupported),
        }
    }

    pub fn receive(&mut self, budget: Duration) -> Result<Vec<Event>, Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        let deadline = super::http::deadline(budget);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(Error::Timeout);
            }
            let frame = match self.socket.receive(remaining).map_err(socket_error)? {
                Peer::Text(text) => serde_json::from_str::<Value>(&text),
                Peer::Binary(bytes) => serde_json::from_slice::<Value>(&bytes),
                Peer::Ping | Peer::Pong => continue,
                Peer::Closed(_) => {
                    self.closed = true;
                    return Ok(vec![Event::Closed]);
                }
            };
            let events = match frame {
                Ok(value) if value.is_object() => self.decode(&value),
                _ => Err(Error::UpstreamProtocol),
            };
            return match events {
                Err(error) => {
                    self.closed = true;
                    let _ = self.socket.close(1002, "protocol error");
                    Err(error)
                }
                result => result,
            };
        }
    }

    pub fn close(&mut self) -> Result<(), Error> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        self.socket.close(1000, "done").map_err(socket_error)
    }

    fn require_ready(&self) -> Result<(), Error> {
        if self.closed {
            Err(Error::Closed)
        } else if !self.ready {
            Err(Error::InvalidRequest)
        } else {
            Ok(())
        }
    }

    fn send(&mut self, value: &Value) -> Result<(), Error> {
        self.socket
            .send_text(&value.to_string())
            .map_err(socket_error)
    }

    fn decode(&mut self, value: &Value) -> Result<Vec<Event>, Error> {
        if value.get("error").is_some() || value["type"] == "error" {
            return Err(Error::UpstreamProtocol);
        }
        let mut events = Vec::new();
        match self.vendor {
            Vendor::Grok => match value["type"].as_str() {
                Some("session.created" | "session.updated") => self.note_ready(&mut events),
                Some("response.audio.delta" | "response.output_audio.delta") => {
                    events.push(audio(&value["delta"], 24000)?);
                }
                Some(
                    "response.audio_transcript.done" | "response.output_audio_transcript.done",
                ) => {
                    events.push(transcript("assistant", &value["transcript"], true)?);
                }
                Some("conversation.item.input_audio_transcription.completed") => {
                    events.push(transcript("user", &value["transcript"], true)?);
                }
                Some("input_audio_buffer.speech_started") => events.push(Event::Interrupted),
                Some("response.function_call_arguments.done") => {
                    let arguments = value["arguments"]
                        .as_str()
                        .and_then(|text| serde_json::from_str(text).ok())
                        .unwrap_or_else(|| json!({}));
                    events.push(Event::ToolCall {
                        id: text_string(&value["call_id"]),
                        name: text_string(&value["name"]),
                        arguments,
                    });
                }
                Some("response.done") => {
                    if let Some(tokens) =
                        usage(&value["response"]["usage"], "input_tokens", "output_tokens")
                    {
                        events.push(tokens);
                    }
                    events.push(Event::TurnDone);
                }
                _ => {}
            },
            Vendor::Gemini => {
                if value.get("setupComplete").is_some() {
                    self.note_ready(&mut events);
                }
                if let Some(content) = value.get("serverContent") {
                    if !content.is_object() {
                        return Err(Error::UpstreamProtocol);
                    }
                    if let Some(parts) = content["modelTurn"].get("parts") {
                        for part in parts.as_array().ok_or(Error::UpstreamProtocol)? {
                            if let Some(inline) = part.get("inlineData").filter(|_| !self.muted) {
                                let rate = inline["mimeType"]
                                    .as_str()
                                    .and_then(|mime| mime.split_once("rate="))
                                    .map_or(Ok(24000), |(_, rate)| {
                                        rate.parse::<u32>().map_err(|_| Error::UpstreamProtocol)
                                    })?;
                                events.push(audio(&inline["data"], rate)?);
                            }
                        }
                    }
                    for (field, role) in [
                        ("inputTranscription", "user"),
                        ("outputTranscription", "assistant"),
                    ] {
                        if let Some(delta) = content[field]["text"].as_str() {
                            events.push(Event::Transcript {
                                role,
                                text: delta.into(),
                                final_: false,
                            });
                        }
                    }
                    if content["interrupted"] == true {
                        self.muted = false;
                        events.push(Event::Interrupted);
                    }
                    if content["turnComplete"] == true {
                        self.muted = false;
                        events.push(Event::TurnDone);
                    }
                }
                if let Some(calls) = value["toolCall"].get("functionCalls") {
                    for call in calls.as_array().ok_or(Error::UpstreamProtocol)? {
                        events.push(Event::ToolCall {
                            id: text_string(&call["id"]),
                            name: text_string(&call["name"]),
                            arguments: call.get("args").cloned().unwrap_or_else(|| json!({})),
                        });
                    }
                }
            }
            Vendor::ElevenLabsAsr => match value["message_type"].as_str() {
                Some("session_started") => self.note_ready(&mut events),
                Some("partial_transcript") => {
                    events.push(transcript("user", &value["text"], false)?)
                }
                Some("committed_transcript" | "committed_transcript_with_timestamps") => {
                    events.push(transcript("user", &value["text"], true)?);
                }
                Some(kind) if kind.contains("error") => return Err(Error::UpstreamProtocol),
                _ => {}
            },
        }
        Ok(events)
    }

    fn note_ready(&mut self, events: &mut Vec<Event>) {
        if !self.ready {
            self.ready = true;
            events.push(Event::Ready);
        }
    }
}

fn encode_component(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, crate::elevenlabs::URI_COMPONENT).to_string()
}

fn audio(encoded: &Value, sample_rate: u32) -> Result<Event, Error> {
    if !(8_000..=192_000).contains(&sample_rate) {
        return Err(Error::UpstreamProtocol);
    }
    let bytes = STANDARD
        .decode(encoded.as_str().ok_or(Error::UpstreamProtocol)?)
        .map_err(|_| Error::UpstreamProtocol)?;
    Ok(Event::Audio { bytes, sample_rate })
}

fn transcript(role: &'static str, text: &Value, final_: bool) -> Result<Event, Error> {
    Ok(Event::Transcript {
        role,
        text: text.as_str().ok_or(Error::UpstreamProtocol)?.into(),
        final_,
    })
}

fn setup(options: &Options<'_>) -> Option<Value> {
    match options.vendor {
        Vendor::Grok => {
            let mut settings = json!({"input_audio_format":"pcm16","output_audio_format":"pcm16"});
            if let Some(instructions) = options.instructions.filter(|value| !value.is_empty()) {
                settings["instructions"] = json!(instructions);
            }
            if let Some(voice) = options.voice.filter(|value| !value.is_empty()) {
                settings["voice"] = json!(voice);
            }
            if !options.tools.is_empty() {
                settings["tools"] = json!(options
                    .tools
                    .iter()
                    .map(|tool| tool_definition(tool, true))
                    .collect::<Vec<_>>());
            }
            Some(json!({"type":"session.update","session":settings}))
        }
        Vendor::Gemini => {
            let model = if options.model.starts_with("models/") {
                options.model.to_owned()
            } else {
                format!("models/{}", options.model)
            };
            let mut setup = json!({
                "model":model, "generationConfig":{"responseModalities":["AUDIO"]},
                "inputAudioTranscription":{}, "outputAudioTranscription":{}
            });
            if let Some(voice) = options.voice.filter(|value| !value.is_empty()) {
                setup["generationConfig"]["speechConfig"] =
                    json!({"voiceConfig":{"prebuiltVoiceConfig":{"voiceName":voice}}});
            }
            if let Some(instructions) = options.instructions.filter(|value| !value.is_empty()) {
                setup["systemInstruction"] = json!({"parts":[{"text":instructions}]});
            }
            if !options.tools.is_empty() {
                setup["tools"] = json!([{"functionDeclarations":options.tools.iter().map(|tool| tool_definition(tool, false)).collect::<Vec<_>>()}]);
            }
            Some(json!({"setup":setup}))
        }
        Vendor::ElevenLabsAsr => None,
    }
}

fn text_string(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

fn tool_definition(tool: &Tool<'_>, grok: bool) -> Value {
    let mut definition = json!({"name":tool.name});
    if grok {
        definition["type"] = json!("function");
        definition["parameters"] = tool
            .parameters
            .cloned()
            .unwrap_or_else(|| json!({"type":"object","properties":{}}));
    } else if let Some(parameters) = tool.parameters {
        definition["parameters"] = parameters.clone();
    }
    if let Some(description) = tool.description {
        definition["description"] = json!(description);
    }
    definition
}

fn usage(value: &Value, input: &str, output: &str) -> Option<Event> {
    value.as_object()?;
    let count = |key: &str| {
        value[key]
            .as_u64()
            .filter(|count| *count <= 9_007_199_254_740_991)
    };
    Some(Event::Usage {
        input_tokens: count(input),
        output_tokens: count(output),
    })
}

pub(crate) fn socket_error(error: websocket::Error) -> Error {
    match error {
        websocket::Error::Denied => Error::InvalidRequest,
        websocket::Error::Timeout => Error::Timeout,
        websocket::Error::Capacity | websocket::Error::Protocol => Error::UpstreamProtocol,
        websocket::Error::Network => Error::Network,
        websocket::Error::Closed => Error::Closed,
    }
}

/// Match provider error categories without carrying response text into diagnostics.
pub(crate) fn frame_error(frame: &Value) -> Error {
    let fields: Vec<String> = ["error", "type", "message_type", "code", "message"]
        .into_iter()
        .filter_map(|key| frame[key].as_str().map(str::to_ascii_lowercase))
        .collect();
    let matches = |tokens: &[&str]| {
        fields
            .iter()
            .any(|field| tokens.iter().any(|token| field.contains(token)))
    };
    if matches(&[
        "unauthor",
        "auth",
        "invalid_api_key",
        "api key",
        "permission",
        "forbidden",
    ]) {
        Error::Auth
    } else if matches(&["rate", "quota", "too_many", "resource_exhausted", "limit"]) {
        Error::RateLimited
    } else if matches(&[
        "invalid",
        "input_error",
        "bad_request",
        "not_found",
        "unsupported",
    ]) {
        Error::InvalidRequest
    } else {
        Error::BadResponse
    }
}
