//! Deterministic caption selection and bounded local/cloud provider ports.

use super::{
    admission::{unchanged, Operation, Policy, Route},
    Caller, Error, Kind, Scope,
};
use crate::{
    budget::calls::{ActualCallUsage, CallBudget, CallDecision, CallRequest},
    js::{is_js_space, to_lower_case, utf16_len},
    policy::decide::Decision,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use plur1bus_config::privacy_ack::{privacy_acknowledgment_error, PrivacyChoice, PrivacyFunction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;

/// Prompt used on the fixed vision caption route.
pub const PROMPT: &str =
    "Describe this image in one short factual sentence for search. No preamble.";
/// Maximum admitted source size.
pub const MAX_SOURCE_BYTES: usize = 64 * 1024 * 1024;
/// Maximum encoded frame or image size.
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// User-configured source precedence.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Order {
    /// Use generation prompt, user text, then auto captions.
    PromptThenUserThenAuto,
    /// Only user-supplied captions.
    UserOnly,
    /// Skip all captioning.
    Off,
}

/// Caption provenance.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    /// Prompt or edit instructions.
    Prompt,
    /// User-provided alt text.
    User,
    /// Automatic caption.
    Auto,
}

/// Normalized caption and provenance.
#[derive(Debug, Serialize)]
pub struct Caption {
    /// Bounded normalized text.
    pub text: String,
    /// Source selected by the precedence rule.
    pub source: Origin,
}

/// A bounded literal source or an opaque identifier in a trusted media store.
#[derive(Clone, Copy)]
pub enum Source<'a> {
    /// Already authorized media bytes.
    Bytes(&'a [u8]),
    /// A store key that trusted ports resolve within the authenticated scope.
    Stored(&'a str),
}

/// Media and metadata being captioned.
pub struct Request<'a> {
    /// Modality.
    pub kind: Kind,
    /// Media content type.
    pub mime: &'a str,
    /// Scoped input.
    pub source: Source<'a>,
    /// Optional stored generation prompt.
    pub prompt: Option<&'a str>,
    /// Optional manual caption.
    pub user_caption: Option<&'a str>,
}

/// Caption policy and per-call limits.
pub struct Settings {
    /// Source precedence.
    pub order: Order,
    /// Maximum display length in UTF-16 units.
    pub max_chars: usize,
    /// Desired video samples, clamped to 3–5.
    pub frames: usize,
}

/// Encoded image.
pub struct Frame {
    /// Timestamp in milliseconds for a video frame.
    pub ts_ms: u64,
    /// Encoded image bytes.
    pub bytes: Vec<u8>,
    /// Image content type.
    pub mime: String,
}

/// Input and codec ports. Stored identifiers are resolved and confined by the host.
pub trait Input {
    /// Bounded read for a single image.
    fn read(&self, scope: &Scope, source: Source<'_>, max_bytes: usize) -> Result<Vec<u8>, Error>;
    /// Bounded extraction, in stable source order.
    fn frames(
        &self,
        scope: &Scope,
        source: Source<'_>,
        count: usize,
        max_bytes: usize,
    ) -> Result<Vec<Frame>, Error>;
    /// Whether cancellation won.
    fn cancelled(&self) -> bool;
}

/// Fixed request passed to the authorized vision provider.
pub struct ImageCall<'a> {
    /// Bound route.
    pub route: &'a Route,
    /// Source frame.
    pub frame: &'a Frame,
    /// Maximum output tokens.
    pub max_output_tokens: i64,
}
impl ImageCall<'_> {
    /// Project the fixed wire request at the provider boundary.
    pub fn wire(&self) -> Value {
        let data = STANDARD.encode(&self.frame.bytes);
        json!({"model":self.route.model,"maxTokens":self.max_output_tokens,"messages":[{
            "role":"user","content":[
                {"type":"text","text":PROMPT},
                {"type":"image_url","url":format!("data:{};base64,{data}",self.frame.mime),"detail":"low"},
            ]
        }]})
    }
}

/// Provider response with exact bound identity and optional measured usage.
pub struct Reply {
    /// Caption text.
    pub text: String,
    /// Identity of the provider that replied.
    pub provider: String,
    /// Identity of the model that replied.
    pub model: String,
    /// Measured prompt tokens.
    pub input_tokens: Option<i64>,
    /// Measured response tokens.
    pub output_tokens: Option<i64>,
}

/// No model or connection is supplied by the library. The application owns effect adapters.
pub trait Provider {
    /// Evaluate the current D109 decision for this exact context and route.
    fn decide_cloud(&self, who: &Caller<'_>, call: &ImageCall<'_>) -> Decision;
    /// Atomically revalidate D109 and consume any required once-grant, prior to send.
    fn claim_cloud(&self, who: &Caller<'_>, call: &ImageCall<'_>, decision: &Decision) -> bool;
    /// Dispatch to the approved cloud provider binding.
    fn cloud_image(&self, call: &ImageCall<'_>) -> Result<Reply, Error>;
    /// Run the pinned offline image captioner.
    fn local_image(&self, call: &ImageCall<'_>) -> Result<String, Error>;
    /// Run offline ASR, without a cloud transcription fallback.
    fn local_transcript(
        &self,
        scope: &Scope,
        source: Source<'_>,
        chars: usize,
    ) -> Result<String, Error>;
}

/// One persistent token reservation.
pub trait TokenHold {
    /// Journal the actual usage, or a conservative estimate after an uncertain send.
    fn settle(self: Box<Self>, usage: &ActualCallUsage) -> Result<(), Error>;
    /// Release a known unused reservation.
    fn release(self: Box<Self>) -> Result<(), Error>;
}

/// Token budget port.
pub trait TokenBudget {
    /// Hold the input estimate and maximum token allowance.
    fn reserve(&self, call: &CallRequest<'_>) -> Result<Box<dyn TokenHold + '_>, Error>;
}

/// Current services needed by the assembly, with separate route, byte and provider boundaries.
pub struct Ports<'a> {
    /// Trusted effective route selector.
    pub policy: &'a dyn Policy,
    /// Limited scoped bytes and cancellation.
    pub input: &'a dyn Input,
    /// Local caption and authorized cloud ports.
    pub provider: &'a dyn Provider,
    /// Required for cloud captioning.
    pub budget: Option<&'a dyn TokenBudget>,
}

const ESTIMATED_INPUT: i64 = 1_500;
const MAX_OUTPUT: i64 = 120;
const MAX_CAPTION_BYTES: usize = 64 * 1024;
const MAX_CHARS: usize = 10_000;
const ACTION: &str = "media.write";
const FUNCTION: PrivacyFunction = PrivacyFunction::Caption;

/// Preferred provider when embedding stays local.
pub fn select_provider(
    id: Option<&str>,
    pinned: bool,
    embedding_local: bool,
    ack: Option<&Value>,
) -> Result<Option<String>, Error> {
    match id {
        Some("off") => Ok(None),
        Some("local") => Ok(Some("local".into())),
        None => Ok((pinned || embedding_local).then(|| "local".into())),
        Some(id) => {
            if let Some(failure) = privacy_acknowledgment_error(&PrivacyChoice {
                function: FUNCTION,
                provider: id,
                local: false,
                pinned,
                endpoint: None,
                ack,
            }) {
                return Err(Error::new(failure.code, failure.reason));
            }
            Ok(Some(id.into()))
        }
    }
}

fn collapse(raw: &str) -> String {
    raw.split(is_js_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Collapse JS whitespace and truncate to a word boundary.
pub fn normalize(raw: &str, max_chars: usize) -> String {
    let text = collapse(raw);
    if utf16_len(&text) <= max_chars {
        return text;
    }
    if max_chars == 0 {
        return String::new();
    }
    let room = max_chars - 1;
    let mut size = 0;
    let mut cut = text.len();
    let mut next = ' ';
    for (offset, c) in text.char_indices() {
        size += c.len_utf16();
        if size > room {
            cut = offset;
            next = c;
            break;
        }
    }
    let prefix = &text[..cut];
    let mut output = prefix;
    if next != ' ' {
        if let Some(space) = prefix.rfind(' ').filter(|&space| space > 0) {
            output = &prefix[..space];
        }
    }
    let output = output
        .trim_end_matches(is_js_space)
        .trim_end_matches([',', ';', ':', '-', '–'])
        .trim_end_matches(is_js_space);
    format!("{output}…")
}

/// Merge frame captions in timestamp order and deduplicate case-insensitively.
pub fn merge(mut frames: Vec<(u64, String)>, limit: usize) -> String {
    frames.sort_by_key(|(time, _)| *time);
    let mut seen = BTreeSet::new();
    let output = frames
        .into_iter()
        .filter_map(|(_, raw)| {
            let text = collapse(&raw);
            let text = text.trim_end_matches(['.', ';']);
            (!text.is_empty() && seen.insert(to_lower_case(text))).then(|| text.to_owned())
        })
        .collect::<Vec<_>>()
        .join("; ");
    normalize(&output, limit)
}

fn caption(text: Option<&str>, origin: Origin, max: usize) -> Option<Caption> {
    let raw = text?;
    let text = normalize(raw, max);
    (!text.is_empty()).then_some(Caption {
        text,
        source: origin,
    })
}

/// Resolve a caption under the effective media policy.
pub fn resolve(
    caller: &Caller<'_>,
    request: &Request<'_>,
    settings: &Settings,
    ports: &Ports<'_>,
) -> Result<Option<Caption>, Error> {
    caller.authorize(ACTION)?;
    if !(1..=MAX_CHARS).contains(&settings.max_chars)
        || [request.prompt, request.user_caption]
            .into_iter()
            .flatten()
            .any(|text| text.len() > MAX_CAPTION_BYTES)
    {
        return Err(Error::new("E_INVALID_PARAMS", "media-caption-bound"));
    }
    if settings.order == Order::Off {
        return Ok(None);
    }
    let prompt = if settings.order == Order::PromptThenUserThenAuto {
        caption(request.prompt, Origin::Prompt, settings.max_chars)
    } else {
        None
    };
    let manual = prompt.or_else(|| caption(request.user_caption, Origin::User, settings.max_chars));
    if manual.is_some() || settings.order == Order::UserOnly {
        return Ok(manual);
    }
    let op = Operation::Caption(request.kind);
    let Some(route) = ports.policy.route(op, caller.scope) else {
        return Ok(None);
    };
    route.check(FUNCTION)?;
    let render = Render {
        caller,
        ports,
        route: &route,
        op,
    };
    render.live()?;
    check_source(request.source)?;
    let result = match request.kind {
        Kind::Image => {
            if !image_mime(request.mime) {
                return Err(unsupported("caption-image-mime"));
            }
            let bytes = ports
                .input
                .read(caller.scope, request.source, MAX_FRAME_BYTES)?;
            render.image(&Frame {
                ts_ms: 0,
                bytes,
                mime: request.mime.into(),
            })?
        }
        Kind::Video => render.video(request.source, settings)?,
        Kind::Audio => {
            ports
                .provider
                .local_transcript(caller.scope, request.source, settings.max_chars)?
        }
    };
    render.live()?;
    check_text(&result)?;
    Ok(caption(Some(&result), Origin::Auto, settings.max_chars))
}

struct Render<'a> {
    caller: &'a Caller<'a>,
    ports: &'a Ports<'a>,
    route: &'a Route,
    op: Operation,
}
impl Render<'_> {
    fn live(&self) -> Result<(), Error> {
        if self.ports.input.cancelled() {
            return Err(unavailable("caption-aborted"));
        }
        unchanged(
            self.caller,
            self.ports.policy,
            self.op,
            ACTION,
            FUNCTION,
            self.route,
        )
    }

    fn video(&self, source: Source<'_>, settings: &Settings) -> Result<String, Error> {
        let want = settings.frames.clamp(3, 5);
        let limit = want * 4;
        let frames = self
            .ports
            .input
            .frames(self.caller.scope, source, limit, MAX_SOURCE_BYTES)?;
        let total = frames
            .iter()
            .map(|frame| frame.bytes.len())
            .fold(0_usize, usize::saturating_add);
        if frames.is_empty() || frames.len() > limit || total > MAX_SOURCE_BYTES {
            return Err(unsupported("caption-frame-limit"));
        }
        for frame in &frames {
            check_frame(frame)?;
        }
        let picked = frames.len().min(want);
        let mut parts = Vec::with_capacity(picked);
        for i in 0..picked {
            let index = if frames.len() <= want {
                i
            } else {
                let step = want - 1;
                (i * (frames.len() - 1) + step / 2) / step
            };
            let frame = &frames[index];
            parts.push((frame.ts_ms, self.image(frame)?));
        }
        Ok(merge(parts, settings.max_chars))
    }

    fn image(&self, frame: &Frame) -> Result<String, Error> {
        self.live()?;
        check_frame(frame)?;
        let call = ImageCall {
            route: self.route,
            frame,
            max_output_tokens: MAX_OUTPUT,
        };
        let text = if self.route.local {
            self.ports.provider.local_image(&call)?
        } else {
            self.cloud(&call)?
        };
        self.live()?;
        check_text(&text)?;
        Ok(text)
    }

    fn cloud(&self, call: &ImageCall<'_>) -> Result<String, Error> {
        let provider = self.ports.provider;
        let decision = provider.decide_cloud(self.caller, call);
        if !matches!(decision, Decision::Allow { .. }) {
            return Err(denied());
        }
        self.live()?;
        let budget = self.ports.budget.ok_or_else(|| unavailable("budget"))?;
        let hold = budget.reserve(&CallRequest {
            principal: &self.caller.who.user_id,
            agent: &self.caller.scope.agent_id,
            project: "media-caption",
            model: &self.route.model,
            provider: Some(&self.route.provider),
            estimated_input_tokens: ESTIMATED_INPUT,
            max_output_tokens: call.max_output_tokens,
            ..Default::default()
        })?;
        let allowed = self.live().and_then(|()| {
            if provider.claim_cloud(self.caller, call, &decision) {
                self.live()
            } else {
                Err(denied())
            }
        });
        if let Err(error) = allowed {
            hold.release()?;
            return Err(error);
        }
        let reply = provider.cloud_image(call);
        let usage = charge(call, reply.as_ref().ok());
        hold.settle(&usage)?;
        let reply = reply?;
        if reply.provider != self.route.provider || reply.model != self.route.model {
            return Err(unavailable("caption-provider-mismatch"));
        }
        Ok(reply.text)
    }
}

fn charge(call: &ImageCall<'_>, reply: Option<&Reply>) -> ActualCallUsage {
    let tokens = |n: Option<i64>, estimate| {
        n.filter(|n| (0..=crate::budget::MAX_SAFE).contains(n))
            .unwrap_or(estimate)
    };
    ActualCallUsage {
        input_tokens: tokens(reply.and_then(|r| r.input_tokens), ESTIMATED_INPUT),
        // Once dispatched, cancellation cannot establish how many tokens the provider generated.
        output_tokens: tokens(reply.and_then(|r| r.output_tokens), call.max_output_tokens),
        ..Default::default()
    }
}

impl TokenBudget for CallBudget {
    fn reserve(&self, call: &CallRequest<'_>) -> Result<Box<dyn TokenHold + '_>, Error> {
        let error = unavailable("budget");
        let CallDecision::Allow(allowance) = self.check_before_call(call).map_err(|_| error)?
        else {
            return Err(error);
        };
        Ok(Box::new(CallHold {
            budget: self,
            id: allowance.reservation_id,
        }))
    }
}
struct CallHold<'a> {
    budget: &'a CallBudget,
    id: String,
}
impl TokenHold for CallHold<'_> {
    fn settle(self: Box<Self>, usage: &ActualCallUsage) -> Result<(), Error> {
        self.budget
            .settle(&self.id, usage)
            .map(|_| ())
            .map_err(|_| unavailable("budget-settle"))
    }
    fn release(self: Box<Self>) -> Result<(), Error> {
        self.budget
            .release_unused(&self.id)
            .map_err(|_| unavailable("budget-release"))
    }
}

fn check_source(source: Source<'_>) -> Result<(), Error> {
    match source {
        Source::Bytes(bytes) if !bytes.is_empty() && bytes.len() <= MAX_SOURCE_BYTES => Ok(()),
        Source::Stored(id)
            if !id.is_empty()
                && id.len() <= 256
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')) =>
        {
            Ok(())
        }
        _ => Err(unsupported("caption-source")),
    }
}
fn check_frame(frame: &Frame) -> Result<(), Error> {
    if frame.bytes.is_empty() || frame.bytes.len() > MAX_FRAME_BYTES || !image_mime(&frame.mime) {
        return Err(unsupported("caption-frame"));
    }
    Ok(())
}
fn check_text(text: &str) -> Result<(), Error> {
    if text.len() > MAX_CAPTION_BYTES {
        return Err(unavailable("caption-output-limit"));
    }
    Ok(())
}
fn image_mime(mime: &str) -> bool {
    matches!(
        mime,
        "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/avif"
    )
}

fn unsupported(reason: &'static str) -> Error {
    Error::new("E_MEDIA_UNSUPPORTED_KIND", reason)
}
fn unavailable(reason: &'static str) -> Error {
    Error::new("E_MEDIA_UNAVAILABLE", reason)
}
fn denied() -> Error {
    Error::new("E_DENIED", "caption-policy-denied")
}

#[cfg(test)]
#[path = "caption_vectors.rs"]
mod vectors;
