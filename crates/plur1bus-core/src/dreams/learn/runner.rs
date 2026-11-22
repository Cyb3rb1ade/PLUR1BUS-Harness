//! Learning workflow over authenticated sources, a tool-free model and a private ledger.

use std::collections::{BTreeMap, HashSet};

use icu_normalizer::ComposingNormalizerBorrowed;
use serde_json::json;

use super::aggregation::{aggregate, parse_extraction, score, vocabulary, Safety};
use super::review::{self, ReadPort};
use super::store::{LearnStore, Observation, Outcome, Run, Signal};
use super::{
    admits, array, current, equals, readable, select, selection_digest, string, verify_transcript,
    Error, Source, Target, Window,
};
use crate::budget::{Clock, IdSource};
use crate::collab::{CollabError, CollabErrorCode};
use crate::identity::principals::derive_user_principal;
use crate::js::{js_trim, sort_default};
use crate::logs::methods::AbortSignal;
use crate::rbac::{
    audit::{AuditEvent, AuditSink},
    types::{Principal, PrincipalKind},
};
use crate::toolcall::json::{parse, V};

/// Stage of the bounded, tool-free learning model.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// Extract candidate claims from one session.
    Extract,
    /// Test a proposed claim against exact evidence.
    Skeptic,
    /// Rewrite a claim without accessing its raw evidence.
    Wording,
}

impl Stage {
    /// Wire and checkpoint name.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Extract => "extract",
            Self::Skeptic => "skeptic",
            Self::Wording => "wording",
        }
    }

    /// Configured model size group.
    pub const fn model_class(self) -> &'static str {
        match self {
            Self::Extract => "small",
            Self::Skeptic | Self::Wording => "large",
        }
    }
}

/// Privacy of the actual route, determined by the host independently of the model.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// The model runs locally.
    Local,
    /// The model accepts content outside the local trust boundary.
    Remote,
}

/// Budgeted model request. Only these messages can be sent by the adapter.
pub struct ModelRequest<'a> {
    /// Authorized target.
    pub target: &'a Target,
    /// Purpose and model class.
    pub stage: Stage,
    /// Pinned instructions.
    pub instructions: &'static str,
    /// A complete JSON envelope containing untrusted text.
    pub data: &'a str,
    /// Exact completion token ceiling.
    pub max_output_tokens: i64,
    /// Caller cancellation.
    pub abort: &'a AbortSignal,
}

/// Measured model completion.
#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelResult {
    /// Model's structured output.
    pub text: String,
    /// Opaque configured model ID.
    pub model: String,
    /// Reported input token count.
    pub input_tokens: i64,
    /// Reported output token count.
    pub output_tokens: i64,
}

/// Tool-free model adapter.
pub trait Model {
    /// Inspect the current configured route without sending content.
    fn route(&self, target: &Target, stage: Stage) -> Result<Route, Error>;
    /// Call the previously checked route; the adapter must preserve that route.
    fn complete(&mut self, route: Route, request: ModelRequest<'_>) -> Result<ModelResult, Error>;
}

/// Externally resolved candidate card. Reads only.
pub struct Card {
    /// Current scoped card text.
    pub text: String,
    /// Actual memory scope.
    pub scope: String,
    /// Trusted origin, if known.
    pub origin: Option<String>,
}

/// Scoped, read-only memory card lookup.
pub trait Cards {
    /// Inspect one existing card before scoring a claim.
    fn read(&self, target: &Target, id: &str) -> Result<Option<Card>, Error>;
}

/// Host-provided count-only delivery.
pub trait Notice {
    /// Deliver a deduplicated summary for this owner and run.
    fn finished(&mut self, run: &Run, pending: usize, waiting_h3: usize);
}

/// Current learning settings for the authenticated target.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// Whether the target opted in.
    pub enabled: bool,
    /// Maximum admitted session count.
    pub max_sessions: usize,
    /// Maximum tokens over all resumed attempts.
    pub max_tokens: i64,
    /// Owner's focus label for extraction.
    pub focus: String,
    /// Require a local model for all content.
    #[serde(default)]
    pub local_only: bool,
    /// Enable the independent verification and wording stages.
    #[serde(default)]
    pub review: bool,
}

/// Dependencies which do not accept arguments from model output except bounded read checks.
pub struct Ports<'a> {
    /// Private learning ledger.
    pub store: &'a LearnStore,
    /// Live scoped transcripts and principal.
    pub source: &'a dyn Source,
    /// Tool-free provider.
    pub model: &'a mut dyn Model,
    /// Bounded project reader, when available.
    pub read: Option<&'a mut dyn ReadPort>,
    /// Private memory lookup, when available.
    pub cards: Option<&'a dyn Cards>,
    /// Count-only delivery when configured.
    pub notice: Option<&'a mut dyn Notice>,
    /// Trusted clock.
    pub clock: &'a dyn Clock,
    /// Unique owner-attempt IDs.
    pub ids: &'a dyn IdSource,
    /// Metadata-only authorization audit.
    pub audit: &'a mut dyn AuditSink,
}

/// One explicitly authorized host invocation.
pub struct Request<'a> {
    /// Trusted target binding.
    pub target: &'a Target,
    /// The person authorizing the operation.
    pub who: &'a Principal,
    /// Window derived by trusted configuration.
    pub window: Window,
    /// Strict configuration for this target.
    pub config: &'a Config,
    /// Cancellation owned by the host.
    pub abort: &'a AbortSignal,
}

const MAX_OUTPUT: i64 = 4096;

impl Stage {
    fn instructions(self) -> &'static str {
        match self {
            Self::Extract => include_str!("prompts/extract.md"),
            Self::Skeptic => include_str!("prompts/skeptic.md"),
            Self::Wording => include_str!("prompts/wording.md"),
        }
    }
}

fn failed(error: CollabError) -> Error {
    let reason = error.reason;
    match reason.as_deref() {
        Some("budget") => Error::Budget,
        Some("provider-failed") => Error::ProviderFailed,
        _ if error.code == CollabErrorCode::Unauthorized => Error::Rights,
        _ => Error::Source,
    }
}

fn protect(
    request: &Request<'_>,
    source: &dyn Source,
    clock: &dyn Clock,
    store: &LearnStore,
    run: &Run,
    transcripts: &[V],
) -> Result<(), Error> {
    if request.abort.is_aborted() {
        return Err(Error::Interrupted);
    }
    if store.invalidated(&run.id).map_err(failed)? {
        return Err(Error::Rights);
    }
    let now = clock.now();
    let live = current(source, request.target, request.who, now)?;
    if !super::super::can_run_jobs(&live, now) {
        return Err(Error::Rights);
    }
    for transcript in transcripts {
        let session = transcript.get("session").ok_or(Error::Rights)?;
        if !readable(source, request.target, request.who, &live, session, now)? {
            return Err(Error::Rights);
        }
    }
    Ok(())
}

pub(super) fn load_evidence(
    target: &Target,
    who: &Principal,
    source: &dyn Source,
    clock: &dyn Clock,
    finding: &V,
    selected: &[V],
) -> Result<Vec<V>, Error> {
    let mut groups = BTreeMap::<String, Vec<_>>::new();
    for reference in array(finding, "evidence")? {
        groups
            .entry(string(reference, "sessionId")?)
            .or_default()
            .push(reference.clone());
    }
    let mut transcripts = Vec::new();
    let live = current(source, target, who, clock.now())?;
    let owner = derive_user_principal(&target.owner).map_err(|_| Error::Rights)?;
    for (id, refs) in groups {
        let present = selected
            .iter()
            .find(|t| t.get("session").is_some_and(|s| equals(s, "id", &id)));
        let metadata = if let Some(t) = present {
            t.get("session").cloned().ok_or(Error::Rights)?
        } else {
            source.session(&id)?.ok_or(Error::Rights)?
        };
        if !admits(target, &owner, &metadata)
            || !refs.iter().all(|r| {
                ["agentId", "owner"].iter().all(|key| {
                    r.get(key)
                        .zip(metadata.get(key))
                        .is_some_and(|(a, b)| a.deep_equal(b))
                })
            })
            || !readable(source, target, who, &live, &metadata, clock.now())?
        {
            return Err(Error::Rights);
        }
        let data = if let Some(present) = present {
            present.clone()
        } else {
            source.evidence(&metadata, &refs)?
        };
        verify_transcript(&data, &metadata, &id)?;
        transcripts.push(data);
    }
    review::evidence_view(finding, &transcripts)?;
    Ok(transcripts)
}

fn refreshed(finding: &V, sources: &[V]) -> Result<V, Error> {
    let mut fresh = Vec::new();
    for t in sources {
        let session = t.get("session").ok_or(Error::Rights)?;
        let id = string(session, "id")?;
        let refs = array(finding, "evidence")?
            .iter()
            .filter(|r| equals(r, "sessionId", &id))
            .map(|r| {
                Ok(V::obj([
                    ("source", V::s(&string(r, "source")?)),
                    ("id", V::s(&string(r, "sourceId")?)),
                ]))
            })
            .collect::<Result<Vec<_>, Error>>()?;
        let extraction = V::Arr(vec![V::obj([
            ("kind", V::s(&string(finding, "kind")?)),
            ("change", V::s(&string(finding, "change")?)),
            ("text", V::s(&string(finding, "text")?)),
            ("contentKey", V::s("trust-refresh")),
            ("evidence", V::Arr(refs)),
        ])])
        .stringify();
        let raw = parse_extraction(&extraction, t)?;
        if let Some(raw) = raw.first() {
            fresh.extend(array(raw, "evidence")?.iter().cloned());
        }
    }
    if fresh.len() != array(finding, "evidence")?.len() {
        return Err(Error::Rights);
    }
    let mut f = finding.as_obj().cloned().ok_or(Error::InvalidOutput)?;
    f.set("evidence", V::Arr(fresh));
    Ok(V::Obj(f))
}

fn measured(result: &ModelResult) -> Result<i64, Error> {
    if result.model.is_empty()
        || result.model.len() > 256
        || result.model.chars().any(char::is_control)
        || result.text.len() > super::BYTES
        || result.input_tokens < 0
        || !(0..=MAX_OUTPUT).contains(&result.output_tokens)
    {
        return Err(Error::ProviderFailed);
    }
    result
        .input_tokens
        .checked_add(result.output_tokens)
        .filter(|n| *n <= super::SAFE_INTEGER)
        .ok_or(Error::ProviderFailed)
}

struct Call<'a> {
    stage: Stage,
    key: &'a str,
    data: V,
}

fn complete(
    request: &Request<'_>,
    ports: &mut Ports<'_>,
    run: &mut Run,
    attempt: &str,
    selection: &[V],
    call: Call<'_>,
) -> Result<ModelResult, Error> {
    protect(
        request,
        ports.source,
        ports.clock,
        ports.store,
        run,
        selection,
    )?;
    let key = format!("{}:{}", call.stage.as_str(), call.key);
    if let Some(cached) = ports.store.payload(&run.id, &key).map_err(failed)? {
        let result =
            serde_json::from_str(&cached.stringify()).map_err(|_| Error::ProviderFailed)?;
        measured(&result)?;
        return Ok(result);
    }
    let route = ports.model.route(request.target, call.stage)?;
    if request.config.local_only && route == Route::Remote {
        return Err(Error::LocalOnly);
    }
    let instructions = call.stage.instructions();
    let data = V::obj([("type", V::s("UNTRUSTED_DATA")), ("data", call.data)]).stringify();
    let reserve = i64::try_from(instructions.len() + data.len())
        .map_err(|_| Error::Budget)?
        .checked_add(MAX_OUTPUT)
        .ok_or(Error::Budget)?;
    if reserve > request.config.max_tokens.saturating_sub(run.tokens) {
        return Err(Error::Budget);
    }
    ports
        .audit
        .append(&AuditEvent {
            at: ports.clock.now(),
            user: request.who.user_id.clone(),
            host: String::new(),
            action: "learning.model".into(),
            target: request.target.agent_id.clone(),
            detail: vec![
                ("runId".into(), json!(run.id)),
                ("stage".into(), json!(call.stage.as_str())),
            ],
        })
        .map_err(|_| Error::Rights)?;
    let hold = ports
        .store
        .reserve_model(run, attempt, &key, reserve, request.config.max_tokens)
        .map_err(failed)?;
    protect(
        request,
        ports.source,
        ports.clock,
        ports.store,
        run,
        selection,
    )?;
    let result = ports.model.complete(
        route,
        ModelRequest {
            target: request.target,
            stage: call.stage,
            instructions,
            data: &data,
            max_output_tokens: MAX_OUTPUT,
            abort: request.abort,
        },
    )?;
    protect(
        request,
        ports.source,
        ports.clock,
        ports.store,
        run,
        selection,
    )?;
    let usage = measured(&result)?;
    let encoded = serde_json::to_string(&result)
        .ok()
        .and_then(|text| parse(&text))
        .ok_or(Error::ProviderFailed)?;
    ports
        .store
        .settle_model(run, attempt, hold, usage, &encoded)
        .map_err(failed)?;
    Ok(result)
}

fn review_finding(
    request: &Request<'_>,
    ports: &mut Ports<'_>,
    run: &mut Run,
    attempt: &str,
    selected: &[V],
    next: &V,
) -> Result<V, Error> {
    let sources = load_evidence(
        request.target,
        request.who,
        ports.source,
        ports.clock,
        next,
        selected,
    )?;
    let mut finding = refreshed(next, &sources)?;
    let authority = || {
        protect(
            request,
            ports.source,
            ports.clock,
            ports.store,
            run,
            &sources,
        )
    };
    authority()?;
    let info = match ports.read.as_mut() {
        Some(port) => review::verify(
            request.target,
            &finding,
            Some(&mut **port),
            request.abort,
            authority,
        )?,
        None => review::verify(request.target, &finding, None, request.abort, authority)?,
    };
    let memory = string(&finding, "memoryId").ok();
    let card = match (ports.cards, memory.as_deref()) {
        (Some(port), Some(id)) => port.read(request.target, id)?,
        _ => None,
    };
    protect(
        request,
        ports.source,
        ports.clock,
        ports.store,
        run,
        &sources,
    )?;
    let scope = if request.target.scope == "project" {
        "workspace"
    } else {
        "agent-private"
    };
    let verified = if memory.is_some() {
        card.as_ref().is_some_and(|c| c.scope == scope)
    } else {
        equals(&finding, "change", "add")
    };
    let claim = string(&finding, "text")?;
    let canonical = ComposingNormalizerBorrowed::new_nfkc();
    let agrees = card.as_ref().is_some_and(|c| {
        verified
            && js_trim(canonical.normalize(&c.text).as_ref())
                == js_trim(canonical.normalize(&claim).as_ref())
    });
    let person_authored =
        memory.is_some() && card.as_ref().and_then(|c| c.origin.as_deref()) != Some("capture");
    let V::Obj(mut object) = finding else {
        return Err(Error::InvalidOutput);
    };
    object.set("verify", V::s(info));
    object.set("agreement", V::s(if agrees { "agrees" } else { "unknown" }));
    let safety = || Safety {
        person_authored,
        sensitive: false,
        target_verified: verified,
    };
    finding = score(&V::Obj(object), safety())?;
    let id = string(&finding, "id")?;
    if let Some(data) = review::skeptic_data(&finding, &sources)? {
        let result = complete(
            request,
            ports,
            run,
            attempt,
            &sources,
            Call {
                stage: Stage::Skeptic,
                key: &id,
                data,
            },
        )?;
        finding = review::apply_skeptic(&finding, &result.text, &result.model)?;
    }
    let result = complete(
        request,
        ports,
        run,
        attempt,
        &sources,
        Call {
            stage: Stage::Wording,
            key: &id,
            data: review::wording_data(&finding)?,
        },
    )?;
    score(
        &review::apply_wording(&finding, &result.text, &result.model)?,
        safety(),
    )
}

fn observations(transcripts: &[V], findings: &[V]) -> Result<Vec<Observation>, Error> {
    let mut result = Vec::new();
    for t in transcripts {
        let id = string(t.get("session").ok_or(Error::Source)?, "id")?;
        let mut times = BTreeMap::new();
        for (list, kind, key, stamp) in [
            ("messages", "message", "id", "createdAt"),
            ("events", "event", "seq", "at"),
        ] {
            for row in array(t, list)? {
                let stamp = row
                    .get(stamp)
                    .and_then(V::as_f64)
                    .filter(|n| n.fract() == 0.0 && (0.0..=super::SAFE_INTEGER as f64).contains(n))
                    .ok_or(Error::Source)? as i64;
                let row_id = row.get(key).ok_or(Error::Source)?.to_js_string().lossy();
                times.insert((kind.to_owned(), row_id), stamp);
            }
        }
        let at = *times.values().max().ok_or(Error::Source)?;
        let mut signals = Vec::new();
        for finding in findings {
            let finding_id = string(finding, "id")?;
            for reference in array(finding, "evidence")?
                .iter()
                .filter(|r| equals(r, "sessionId", &id))
            {
                let key = (string(reference, "source")?, string(reference, "sourceId")?);
                if let Some(at) = times.get(&key) {
                    signals.push(Signal {
                        finding_id: finding_id.clone(),
                        at: *at,
                    });
                }
            }
        }
        result.push(Observation {
            session_id: id,
            at,
            signals,
        });
    }
    Ok(result)
}

fn run_active(
    request: &Request<'_>,
    ports: &mut Ports<'_>,
    run: &mut Run,
    attempt: &str,
) -> Result<Run, Error> {
    if !request.config.enabled {
        return Err(Error::Disabled);
    }
    if ports
        .store
        .breaker_open(request.target, ports.clock.now())
        .map_err(failed)?
    {
        return Err(Error::BreakerOpen);
    }
    protect(request, ports.source, ports.clock, ports.store, run, &[])?;
    if request.target.scope == "installation" {
        let selected = super::installation::collect(
            ports.source,
            request.target,
            request.who,
            request.window,
            &run.id,
            request.config.max_sessions,
            ports.clock.now(),
        )?;
        if !run.digest.is_empty() && run.digest != selected.digest {
            return Err(Error::Rights);
        }
        run.session_ids = selected.session_ids;
        run.digest = selected.digest;
        run.truncated = Some(selected.truncated);
        run.omitted_sessions = Some(selected.omitted_sessions);
        ports.store.save(run).map_err(failed)?;
        protect(request, ports.source, ports.clock, ports.store, run, &[])?;
        return ports
            .store
            .publish(run, &selected.findings, ports.clock.now(), &[])
            .map_err(failed);
    }
    let selection = select(
        ports.source,
        request.target,
        request.who,
        request.window,
        request.config.max_sessions,
        ports.clock.now(),
    )?;
    let chosen = selection.transcripts;
    let digest = selection_digest(&chosen)?;
    if !run.digest.is_empty() && run.digest != digest {
        return Err(Error::Rights);
    }
    run.session_ids = chosen
        .iter()
        .map(|t| string(t.get("session").ok_or(Error::Source)?, "id"))
        .collect::<Result<_, _>>()?;
    run.digest = digest;
    run.truncated = Some(selection.omitted_sessions > 0);
    run.omitted_sessions = Some(selection.omitted_sessions);
    ports.store.save(run).map_err(failed)?;
    if chosen.is_empty() {
        return Err(Error::NoSessions);
    }

    let prior = ports
        .store
        .target_findings(request.target, 100, 0)
        .map_err(failed)?
        .into_iter()
        .filter(|f| {
            !equals(f, "status", "withdrawn")
                && !equals(f, "text", "")
                && load_evidence(
                    request.target,
                    request.who,
                    ports.source,
                    ports.clock,
                    f,
                    &chosen,
                )
                .is_ok()
        })
        .collect::<Vec<_>>();
    let current_seed = vocabulary(&prior)?;
    let seed = if let Some(saved) = ports.store.payload(&run.id, "vocabulary").map_err(failed)? {
        let entries = saved.as_arr().ok_or(Error::Source)?;
        if entries
            .iter()
            .any(|entry| !current_seed.iter().any(|row| row.deep_equal(entry)))
        {
            return Err(Error::Rights);
        }
        entries.to_vec()
    } else {
        ports
            .store
            .checkpoint(&run.id, "vocabulary", &V::Arr(current_seed.clone()))
            .map_err(failed)?;
        current_seed
    };
    let mut raw = Vec::new();
    let mut models = HashSet::new();
    for transcript in &chosen {
        let id = string(transcript.get("session").ok_or(Error::Source)?, "id")?;
        let vocab = seed
            .iter()
            .cloned()
            .chain(vocabulary(&raw)?)
            .take(100)
            .collect();
        let data = V::obj([
            ("focus", V::s(&request.config.focus)),
            ("vocabulary", V::Arr(vocab)),
            ("messages", V::Arr(array(transcript, "messages")?.to_vec())),
            ("events", V::Arr(array(transcript, "events")?.to_vec())),
        ]);
        let response = complete(
            request,
            ports,
            run,
            attempt,
            &chosen,
            Call {
                stage: Stage::Extract,
                key: &id,
                data,
            },
        )?;
        raw.extend(parse_extraction(&response.text, transcript)?);
        models.insert(response.model);
    }
    let mut models = models.into_iter().collect::<Vec<_>>();
    sort_default(&mut models);
    let findings = aggregate(&raw, request.target, &run.id, chosen.len())?;
    let mut reviewed = Vec::new();
    for next in &findings {
        let Some(next) = ports.store.prepare_candidate(next).map_err(failed)? else {
            continue;
        };
        let _checked = load_evidence(
            request.target,
            request.who,
            ports.source,
            ports.clock,
            &next,
            &chosen,
        )?;
        let V::Obj(mut ready) = next else {
            return Err(Error::InvalidOutput);
        };
        ready.set("models", V::strs(&models));
        ready.set("modelClasses", V::strs(&["small"]));
        let finding = V::Obj(ready);
        reviewed.push(if request.config.review {
            review_finding(request, ports, run, attempt, &chosen, &finding)?
        } else {
            finding
        });
    }
    let live = select(
        ports.source,
        request.target,
        request.who,
        request.window,
        request.config.max_sessions,
        ports.clock.now(),
    )?;
    if selection_digest(&live.transcripts)? != run.digest {
        return Err(Error::Rights);
    }
    protect(
        request,
        ports.source,
        ports.clock,
        ports.store,
        run,
        &chosen,
    )?;
    ports
        .store
        .publish(
            run,
            &reviewed,
            ports.clock.now(),
            &observations(&chosen, &findings)?,
        )
        .map_err(failed)
}

/// Read, extract, review and publish a shadow-only learning run.
pub fn run(request: &Request<'_>, ports: &mut Ports<'_>) -> Result<Run, CollabError> {
    if request.who.kind != Some(PrincipalKind::Person)
        || request.who.user_id != request.target.owner
        || !super::super::can_run_jobs(request.who, ports.clock.now())
    {
        return Err(CollabError::with_reason(
            CollabErrorCode::Unauthorized,
            "learning target unavailable",
            "rights-changed",
        ));
    }
    let previous = ports
        .store
        .begin(request.target, request.window, ports.clock.now())?;
    if previous.outcome == Some(Outcome::Completed) {
        protect(
            request,
            ports.source,
            ports.clock,
            ports.store,
            &previous,
            &[],
        )
        .map_err(|_| {
            CollabError::new(CollabErrorCode::Unauthorized, "learning target unavailable")
        })?;
        return Ok(previous);
    }
    let token = ports.ids.next_id();
    let mut run = ports.store.claim_attempt(&previous.id, &token)?;
    let outcome = run_active(request, ports, &mut run, &token);
    let result = match outcome {
        Ok(done) => Ok(done),
        Err(reason) => {
            let reason = if request.abort.is_aborted() {
                Error::Interrupted
            } else {
                reason
            };
            let status = match reason {
                Error::Cap => Outcome::Deferred,
                Error::InvalidOutput | Error::ProviderFailed | Error::Source => Outcome::Failed,
                _ => Outcome::Skipped,
            };
            ports
                .store
                .finish(&run, status, Some(reason.as_str()), ports.clock.now())
        }
    };
    ports.store.release_attempt(&run.id, &token)?;
    let done = result?;
    ports.store.compact()?;
    if let Some(notice) = ports.notice.as_mut() {
        let listed = if done.outcome == Some(Outcome::Completed) {
            ports.store.findings(&done.id)?
        } else {
            Vec::new()
        };
        notice.finished(
            &done,
            listed
                .iter()
                .filter(|f| equals(f, "status", "pending"))
                .count(),
            listed
                .iter()
                .filter(|f| equals(f, "status", "waiting-h3"))
                .count(),
        );
    }
    Ok(done)
}

#[cfg(test)]
#[path = "runner_vectors.rs"]
mod vectors;
