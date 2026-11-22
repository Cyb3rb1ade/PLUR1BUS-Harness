//! Blocking cloud realtime sessions. The host owns model choice, TLS and pacing.
use crate::elevenlabs::{word_timings, WordTiming};
use crate::http::{deadline, Error, MAX_JSON_BYTES};
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

impl Vendor {
    pub fn id(self) -> &'static str {
        match self {
            Self::Grok => "xai",
            Self::Gemini => "gemini",
            Self::ElevenLabsAsr => "elevenlabs",
        }
    }
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

#[derive(Clone, Copy, Default)]
pub struct Settings<'a> {
    pub language: Option<&'a str>,
    pub timestamps: bool,
    pub zero_retention: bool,
    /// Caller-owned random identifier for deduplicating Gemini usage events.
    pub usage_session_id: Option<&'a str>,
}

pub struct Session<'a> {
    socket: Socket,
    vendor: Vendor,
    input_rate: u32,
    ready: bool,
    muted: bool,
    closed: bool,
    ports: &'a dyn SocketPorts,
    asr_timestamps: bool,
    asr_bytes: usize,
    input_text: TranscriptBuffer,
    output_text: TranscriptBuffer,
    usage: GeminiUsage,
    pending: Vec<String>,
    pending_bytes: usize,
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
        language: Option<String>,
        words: Option<Vec<WordTiming>>,
    },
    ToolCall {
        id: String,
        name: String,
        arguments: Value,
    },
    Usage {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        event_id: Option<String>,
    },
    Error(Error),
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
            Self::Error(_) => "Error",
            Self::Interrupted => "Interrupted",
            Self::TurnDone => "TurnDone",
            Self::Closed => "Closed",
        })
    }
}

impl<'a> Session<'a> {
    pub fn connect(
        base: &Url,
        key: &str,
        options: &Options<'_>,
        ports: &'a dyn SocketPorts,
        wall_time: Duration,
        insecure_loopback: bool,
    ) -> Result<Self, Error> {
        Self::connect_with_settings(
            base,
            key,
            options,
            Settings::default(),
            ports,
            wall_time,
            insecure_loopback,
        )
    }

    pub fn connect_with_settings(
        base: &Url,
        key: &str,
        options: &Options<'_>,
        settings: Settings<'_>,
        ports: &'a dyn SocketPorts,
        wall_time: Duration,
        insecure_loopback: bool,
    ) -> Result<Self, Error> {
        let deadline = deadline(wall_time);
        if ports.cancelled() {
            return Err(Error::Aborted);
        }
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
            handshake: deadline.saturating_duration_since(Instant::now()),
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
                {
                    let mut query = endpoint.query_pairs_mut();
                    query
                        .append_pair("model_id", options.model)
                        .append_pair("audio_format", &format!("pcm_{}", options.input_rate));
                    if let Some(language) = settings.language.filter(|lang| !lang.is_empty()) {
                        query.append_pair("language_code", language);
                    }
                    query.append_pair("commit_strategy", "manual");
                    if settings.timestamps {
                        query.append_pair("include_timestamps", "true");
                    }
                    if settings.zero_retention {
                        query.append_pair("enable_logging", "false");
                    }
                }
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
            ports,
            asr_timestamps: settings.timestamps,
            asr_bytes: 0,
            input_text: TranscriptBuffer::default(),
            output_text: TranscriptBuffer::default(),
            usage: GeminiUsage {
                session_id: settings.usage_session_id.map(str::to_owned),
                ..Default::default()
            },
            pending: Vec::new(),
            pending_bytes: 0,
        };
        if let Some(setup) = setup(options) {
            session
                .socket
                .send_text_until(&setup.to_string(), deadline)
                .map_err(socket_error)?;
        }
        Ok(session)
    }

    pub fn send_audio(&mut self, pcm16: &[u8]) -> Result<(), Error> {
        self.require_open()?;
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
        self.send(&message)?;
        if matches!(self.vendor, Vendor::ElevenLabsAsr) {
            self.asr_bytes = self.asr_bytes.saturating_add(pcm16.len());
        }
        Ok(())
    }

    /// Report accepted audio duration for the host's ASR usage sink.
    pub fn asr_seconds(&self) -> Option<f64> {
        matches!(self.vendor, Vendor::ElevenLabsAsr)
            .then(|| self.asr_bytes as f64 / (2. * f64::from(self.input_rate)))
    }

    pub fn send_text(&mut self, text: &str) -> Result<(), Error> {
        self.require_open()?;
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
        self.require_open()?;
        match self.vendor {
            Vendor::Grok => {
                let output = value
                    .as_str()
                    .map_or_else(|| value.to_string(), str::to_owned);
                self.send(&json!({"type":"conversation.item.create","item":{"type":"function_call_output","call_id":call_id,"output":output}}))?;
                self.send(&json!({"type":"response.create"}))
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
        self.require_open()?;
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
        self.require_open()?;
        match self.vendor {
            Vendor::ElevenLabsAsr => self.send(&json!({"message_type":"input_audio_chunk","audio_base_64":"","commit":true,"sample_rate":self.input_rate})),
            _ => Err(Error::Unsupported),
        }
    }

    pub fn receive(&mut self, budget: Duration) -> Result<Vec<Event>, Error> {
        self.require_open()?;
        let deadline = deadline(budget);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(Error::Timeout);
            }
            let reply = self.socket.receive_until(deadline).map_err(socket_error);
            if self.ports.cancelled() {
                self.closed = true;
                let _ = self.socket.close_until(1000, "aborted", deadline);
                return Err(Error::Aborted);
            }
            let frame = match reply? {
                Peer::Text(text) => serde_json::from_str::<Value>(&text),
                Peer::Binary(bytes) => serde_json::from_slice::<Value>(&bytes),
                Peer::Ping | Peer::Pong => continue,
                Peer::Closed(code) => {
                    self.closed = true;
                    let mut events = Vec::new();
                    if let Some(error) = close_error(code) {
                        events.push(Event::Error(error));
                    }
                    events.push(Event::Closed);
                    return Ok(events);
                }
            };
            let events = match frame {
                Ok(value) if value.is_object() => self.decode(&value, deadline),
                _ => Err(Error::UpstreamProtocol),
            };
            return match events {
                Err(error) => {
                    self.closed = true;
                    let _ = self.socket.close_until(1002, "protocol error", deadline);
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

    fn require_open(&self) -> Result<(), Error> {
        if self.closed {
            Err(Error::Closed)
        } else if self.ports.cancelled() {
            Err(Error::Aborted)
        } else {
            Ok(())
        }
    }

    fn send(&mut self, value: &Value) -> Result<(), Error> {
        let frame = value.to_string();
        if frame.len() > MAX_JSON_BYTES {
            return Err(Error::InvalidRequest);
        }
        if self.ready {
            self.socket.send_text(&frame).map_err(socket_error)
        } else {
            const PENDING_BYTES: usize = 4 * 1024 * 1024;
            if self.pending_bytes + frame.len() > PENDING_BYTES {
                return Err(Error::Overloaded);
            }
            self.pending_bytes += frame.len();
            self.pending.push(frame);
            Ok(())
        }
    }

    fn decode(&mut self, value: &Value, deadline: Instant) -> Result<Vec<Event>, Error> {
        let mut events = Vec::new();
        match self.vendor {
            Vendor::Grok => match value["type"].as_str() {
                Some("session.created" | "session.updated") => {
                    self.note_ready(&mut events, deadline)?
                }
                Some("response.audio.delta" | "response.output_audio.delta") => {
                    events.push(audio(&value["delta"], 24000)?);
                }
                Some(
                    "response.audio_transcript.delta" | "response.output_audio_transcript.delta",
                ) => {
                    let delta = value["delta"].as_str().unwrap_or_default();
                    events.push(self.output_text.push("assistant", delta)?);
                }
                Some(
                    "response.audio_transcript.done" | "response.output_audio_transcript.done",
                ) => {
                    let text = self.output_text.take();
                    let complete = value["transcript"].as_str().map_or(text, str::to_owned);
                    events.push(transcript("assistant", complete, true));
                }
                Some("conversation.item.input_audio_transcription.completed") => {
                    events.push(transcript("user", text_string(&value["transcript"]), true));
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
                    let response = &value["response"];
                    if let Some(tokens) =
                        tokens(&response["usage"], "input_tokens", "output_tokens")
                    {
                        let id = response["id"]
                            .as_str()
                            .filter(|id| !id.is_empty())
                            .map(|id| format!("{}:{id}", self.vendor.id()));
                        events.push(tokens.event(id));
                    }
                    events.push(Event::TurnDone);
                }
                Some("error") => events.push(Event::Error(reported_error(value))),
                _ => {}
            },
            Vendor::Gemini => {
                if value.get("setupComplete").is_some() {
                    self.note_ready(&mut events, deadline)?;
                }
                if let Some(usage) = value.get("usageMetadata").filter(|usage| !usage.is_null()) {
                    let tokens = tokens(usage, "promptTokenCount", "responseTokenCount")
                        .ok_or(Error::UpstreamProtocol)?;
                    self.usage.observe(tokens, &mut events);
                }
                if let Some(content) = value
                    .get("serverContent")
                    .filter(|content| !content.is_null())
                {
                    self.gemini_content(content, &mut events)?;
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
                Some("session_started") => self.note_ready(&mut events, deadline)?,
                Some("partial_transcript") => {
                    events.push(transcript("user", text_string(&value["text"]), false))
                }
                Some("committed_transcript") if !self.asr_timestamps => {
                    events.push(transcript("user", text_string(&value["text"]), true));
                }
                Some("committed_transcript_with_timestamps") => events.push(Event::Transcript {
                    role: "user",
                    text: text_string(&value["text"]),
                    final_: true,
                    language: value["language_code"].as_str().map(str::to_owned),
                    words: word_timings(&value["words"]),
                }),
                Some(kind)
                    if [
                        "error",
                        "exceeded",
                        "limit",
                        "quota",
                        "throttl",
                        "overflow",
                        "invalid",
                        "exhausted",
                        "unaccepted",
                    ]
                    .iter()
                    .any(|token| kind.contains(token)) =>
                {
                    events.push(Event::Error(frame_error(value)));
                }
                _ => {}
            },
        }
        if matches!(self.vendor, Vendor::Gemini) && value.get("error").is_some() {
            events.push(Event::Error(reported_error(value)));
        }
        Ok(events)
    }

    fn gemini_content(&mut self, content: &Value, events: &mut Vec<Event>) -> Result<(), Error> {
        if !content.is_object() {
            return Err(Error::UpstreamProtocol);
        }
        if let Some(parts) = content["modelTurn"].get("parts") {
            let parts = parts.as_array().ok_or(Error::UpstreamProtocol)?;
            if !parts.is_empty() {
                self.usage.late_turn = None;
            }
            for part in parts {
                let inline = &part["inlineData"];
                if inline["data"].is_string() && !self.muted {
                    let rate = inline["mimeType"]
                        .as_str()
                        .and_then(|mime| mime.split_once("rate="))
                        .and_then(|(_, tail)| {
                            let digits = tail.split(|c: char| !c.is_ascii_digit()).next()?;
                            (!digits.is_empty()).then_some(digits)
                        })
                        .map_or(Ok(24000), |digits| {
                            digits.parse::<u32>().map_err(|_| Error::UpstreamProtocol)
                        })?;
                    events.push(audio(&inline["data"], rate)?);
                }
            }
        }
        for (field, role, buffer) in [
            ("inputTranscription", "user", &mut self.input_text),
            ("outputTranscription", "assistant", &mut self.output_text),
        ] {
            if content.get(field).is_some() {
                self.usage.late_turn = None;
                if let Some(delta) = content[field]["text"].as_str() {
                    events.push(buffer.push(role, delta)?);
                }
            }
        }
        if content["interrupted"] == true {
            self.muted = false;
            events.push(Event::Interrupted);
        }
        if content["turnComplete"] == true {
            self.muted = false;
            for (role, text) in [
                ("user", self.input_text.take()),
                ("assistant", self.output_text.take()),
            ] {
                if !text.is_empty() {
                    events.push(transcript(role, text, true));
                }
            }
            events.push(Event::TurnDone);
            self.usage.complete(events);
        }
        Ok(())
    }

    fn note_ready(&mut self, events: &mut Vec<Event>, deadline: Instant) -> Result<(), Error> {
        if !self.ready {
            for message in self.pending.drain(..) {
                self.socket
                    .send_text_until(&message, deadline)
                    .map_err(socket_error)?;
            }
            self.pending_bytes = 0;
            self.ready = true;
            events.push(Event::Ready);
        }
        Ok(())
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

#[derive(Default)]
struct TranscriptBuffer {
    text: String,
    units: usize,
}

impl TranscriptBuffer {
    fn push(&mut self, role: &'static str, delta: &str) -> Result<Event, Error> {
        self.units += delta.encode_utf16().count();
        if self.units > 1024 * 1024 {
            return Err(Error::UpstreamProtocol);
        }
        self.text.push_str(delta);
        Ok(transcript(role, self.text.clone(), false))
    }

    fn take(&mut self) -> String {
        self.units = 0;
        std::mem::take(&mut self.text)
    }
}

fn transcript(role: &'static str, text: String, final_: bool) -> Event {
    Event::Transcript {
        role,
        text,
        final_,
        language: None,
        words: None,
    }
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

struct TokenCounts {
    input: Option<u64>,
    output: Option<u64>,
}

impl TokenCounts {
    fn event(self, event_id: Option<String>) -> Event {
        Event::Usage {
            input_tokens: self.input,
            output_tokens: self.output,
            event_id,
        }
    }
}

fn tokens(value: &Value, input: &str, output: &str) -> Option<TokenCounts> {
    value.as_object()?;
    let count = |key: &str| {
        value[key]
            .as_f64()
            .filter(|n| *n >= 0. && n.fract() == 0. && *n <= 9_007_199_254_740_991.)
            .map(|n| n as u64)
    };
    Some(TokenCounts {
        input: count(input),
        output: count(output),
    })
}

#[derive(Default)]
struct GeminiUsage {
    session_id: Option<String>,
    pending: Option<TokenCounts>,
    turn: u64,
    late_turn: Option<u64>,
}

impl GeminiUsage {
    fn observe(&mut self, tokens: TokenCounts, events: &mut Vec<Event>) {
        if let Some(turn) = self.late_turn.take() {
            events.push(tokens.event(self.event_id(turn)));
        } else {
            self.pending = Some(tokens);
        }
    }

    fn complete(&mut self, events: &mut Vec<Event>) {
        if let Some(tokens) = self.pending.take() {
            events.push(tokens.event(self.event_id(self.turn)));
        } else {
            self.late_turn = Some(self.turn);
        }
        self.turn = self.turn.saturating_add(1);
    }

    fn event_id(&self, turn: u64) -> Option<String> {
        self.session_id
            .as_ref()
            .map(|id| format!("gemini:{id}:{turn}"))
    }
}

fn reported_error(frame: &Value) -> Error {
    let detail = frame
        .get("error")
        .filter(|error| error.is_object())
        .unwrap_or(frame);
    frame_error(detail)
}

fn close_error(code: Option<u16>) -> Option<Error> {
    match code {
        None | Some(1000 | 1001 | 1005) => None,
        Some(1008) => Some(Error::Auth),
        Some(1002 | 1003 | 1007 | 1009) => Some(Error::UpstreamProtocol),
        Some(_) => Some(Error::Network),
    }
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
