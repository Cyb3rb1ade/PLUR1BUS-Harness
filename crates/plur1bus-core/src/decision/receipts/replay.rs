//! Replay (D133 section 3.3, rulings 2 to 5, R-K-21, R-K-22): stored receipts are decided again through the decision client
//! and compared with what was stored. No model call and no network happens here: the client holds the backends the host gave
//! it. The live path's rules apply first, through ports; a port that is missing or fails refuses the replay. The report
//! holds receipt ids, classes and counters, never text, and the same receipts give the same bytes.
use super::format::{is_identifier, Receipt, ReceiptError, ReceiptUseCase};
use super::rights;
use super::store::ReceiptStore;
use crate::decision::client::DecisionClient;
use crate::decision::types::{BackendName, DecisionContext, DecisionInput, DecisionValue, Failure};
use crate::rbac::types::Principal;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// `plur1bus.decisionreplay/1`.
pub const REPORT_SCHEMA: &str = "plur1bus.decisionreplay/1";
/// Most receipts one replay takes.
pub const MAX_CASES: usize = 5000;

/// A port answered with a failure or not at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortFault;

/// Whether a set of cases is the one a change was developed on or the one it is judged on (ruling 4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaseKind {
    /// Cases a change was developed on.
    Development,
    /// Cases for the closing comparison.
    Final,
}

/// The receipts of one replay.
#[derive(Clone, Debug)]
pub struct CaseSet {
    /// Development or final.
    pub kind: CaseKind,
    /// The receipt ids.
    pub receipt_ids: Vec<String>,
}

/// The rules of the live path a replay checks first (ruling 2). Every answer is `Err` when the port cannot say, and the
/// replay then refuses.
pub trait ReplayGate {
    /// `decision.triage: jev` is set (the opt-in of ruling 2).
    fn jev_opted_in(&self) -> Result<bool, PortFault>;
    /// "Only local models" is on.
    fn local_only(&self) -> Result<bool, PortFault>;
    /// The egress policy admits a call to this backend.
    fn egress_allows(&self, backend: BackendName) -> Result<bool, PortFault>;
    /// The budget admits this many calls to this backend (the D125 limits).
    fn budget_allows(&self, backend: BackendName, calls: usize) -> Result<bool, PortFault>;
}

/// The text of a case, read with the rights of the session store. The receipt names session and message; the port returns
/// what the decision was asked. It is used to ask the candidate and is never copied into the report.
pub trait CaseSource {
    /// The decision input of this receipt.
    fn input(&self, receipt: &Receipt) -> Result<DecisionInput, PortFault>;
}

/// The two ports; either missing refuses the replay.
pub struct ReplayPorts<'a> {
    /// The live-path rules.
    pub gate: Option<&'a dyn ReplayGate>,
    /// The case text.
    pub source: Option<&'a dyn CaseSource>,
}

/// What is tried: a decision client over the changed prompt, table, backend or top K.
pub struct Candidate<'a> {
    /// A name for the report, an identifier.
    pub label: &'a str,
    /// The backend the client is expected to use.
    pub backend: BackendName,
    /// The prompt version of the candidate, an identifier.
    pub prompt_version: &'a str,
    /// The client.
    pub client: &'a DecisionClient,
}

/// The candidate as the report names it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateInfo {
    /// The label.
    pub label: String,
    /// The backend.
    pub backend: String,
    /// The prompt version.
    pub prompt_version: String,
}

/// A case that could not be compared; it stays in the report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedCase {
    /// The receipt.
    pub receipt_id: String,
    /// `missing`, `source`, `unsupported` or the class of the decision failure.
    pub class: String,
}

/// The comparison. Receipt ids, classes and counters only.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayReport {
    /// `plur1bus.decisionreplay/1`.
    pub schema: String,
    /// The kind of the set.
    pub set: CaseKind,
    /// The candidate.
    pub candidate: CandidateInfo,
    /// The receipt ids asked for, sorted, each once.
    pub receipt_ids: Vec<String>,
    /// Both chose the same candidate and no fallback decided.
    pub agreements: u64,
    /// The choices differ, or exactly one side abstained.
    pub disagreements: u64,
    /// Both abstained.
    pub both_abstained: u64,
    /// Cases whose stored decision came from a fallback: reported apart, never a hit of the selector (ruling 3).
    pub fallback_cases: u64,
    /// Cases whose stored decision was an abstention.
    pub baseline_abstentions: u64,
    /// Cases the candidate abstained in.
    pub candidate_abstentions: u64,
    /// Cases that could not be compared. They are kept (ruling 4).
    pub failed: Vec<FailedCase>,
    /// Sum of the stored durations.
    pub baseline_ms: u64,
    /// Sum of the candidate's durations.
    pub candidate_ms: u64,
    /// Stored tokens sent.
    pub baseline_tokens_in: u64,
    /// Stored tokens received.
    pub baseline_tokens_out: u64,
    /// Tools offered in the replayed tool-offer receipts that have an outcome.
    pub offer_offered: u64,
    /// Tools reloaded in them.
    pub offer_reloaded: u64,
    /// `offer_reloaded * 1000 / offer_offered`; none when nothing was offered.
    pub offer_miss_per_mille: Option<u64>,
    /// SHA-256 of this report's canonical JSON with this member empty.
    pub report_hash: String,
}

impl ReplayReport {
    fn compute_hash(&self) -> String {
        let mut blank = self.clone();
        blank.report_hash = String::new();
        let text = serde_json::to_string(&blank).unwrap_or_default();
        Sha256::digest(text.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// Whether the hash is the one of the content (a report that was edited does not verify).
    pub fn verifies(&self) -> bool {
        self.schema == REPORT_SCHEMA && self.report_hash == self.compute_hash()
    }

    /// The report as the canonical JSON that is hashed and compared.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

fn cloud_capable(b: BackendName) -> bool {
    matches!(b, BackendName::Role | BackendName::Jev)
}

/// Ruling 2 and R-K-21, before any case runs.
fn admit(gate: &dyn ReplayGate, b: BackendName, calls: usize) -> Result<bool, ReceiptError> {
    let fault = |what| move |_: PortFault| ReceiptError::Port(what);
    let local_only = gate.local_only().map_err(fault("localOnly"))?;
    if cloud_capable(b) && local_only {
        return Err(ReceiptError::Refused("local-only"));
    }
    if b == BackendName::Jev && !gate.jev_opted_in().map_err(fault("jevOptIn"))? {
        return Err(ReceiptError::Refused("jev-opt-in"));
    }
    if cloud_capable(b) && !gate.egress_allows(b).map_err(fault("egress"))? {
        return Err(ReceiptError::Refused("egress"));
    }
    if !gate.budget_allows(b, calls).map_err(fault("budget"))? {
        return Err(ReceiptError::Refused("budget"));
    }
    Ok(local_only)
}

fn choice_of(v: &DecisionValue) -> Option<String> {
    match v {
        DecisionValue::Choice { id, .. } => Some(id.clone()),
        DecisionValue::Triage(t) => Some(super::format::shape_name(t.shape()).to_owned()),
        _ => None,
    }
}

fn millis(x: f64) -> u64 {
    if x.is_finite() && x > 0.0 {
        x.round() as u64
    } else {
        0
    }
}

/// `decision.replay`: owner and admin, persons only (ruling 11).
pub fn replay(
    store: &ReceiptStore,
    who: &Principal,
    ports: &ReplayPorts<'_>,
    set: &CaseSet,
    candidate: &Candidate<'_>,
) -> Result<ReplayReport, ReceiptError> {
    if !rights::can_replay(who) {
        return Err(ReceiptError::Denied);
    }
    let (Some(gate), Some(source)) = (ports.gate, ports.source) else {
        return Err(ReceiptError::Port("replay ports"));
    };
    if !is_identifier(candidate.label) || !is_identifier(candidate.prompt_version) {
        return Err(ReceiptError::Invalid("candidate"));
    }
    let mut ids = set.receipt_ids.clone();
    ids.sort();
    ids.dedup();
    if ids.is_empty() || ids.len() > MAX_CASES || !ids.iter().all(|i| is_identifier(i)) {
        return Err(ReceiptError::Invalid("receiptIds"));
    }
    let local_only = admit(gate, candidate.backend, ids.len())?;
    let mut report = ReplayReport {
        schema: REPORT_SCHEMA.to_owned(),
        set: set.kind,
        candidate: CandidateInfo {
            label: candidate.label.to_owned(),
            backend: candidate.backend.as_str().to_owned(),
            prompt_version: candidate.prompt_version.to_owned(),
        },
        receipt_ids: ids.clone(),
        agreements: 0,
        disagreements: 0,
        both_abstained: 0,
        fallback_cases: 0,
        baseline_abstentions: 0,
        candidate_abstentions: 0,
        failed: Vec::new(),
        baseline_ms: 0,
        candidate_ms: 0,
        baseline_tokens_in: 0,
        baseline_tokens_out: 0,
        offer_offered: 0,
        offer_reloaded: 0,
        offer_miss_per_mille: None,
        report_hash: String::new(),
    };
    for id in &ids {
        let Some(r) = store.get(id)? else {
            report.failed.push(FailedCase {
                receipt_id: id.clone(),
                class: "missing".into(),
            });
            continue;
        };
        report.baseline_ms += r.duration_ms;
        report.baseline_tokens_in += r.tokens_in;
        report.baseline_tokens_out += r.tokens_out;
        if r.result.choice.is_none() {
            report.baseline_abstentions += 1;
        }
        if let (ReceiptUseCase::Tools, Some(o)) = (r.use_case, &r.outcome) {
            report.offer_offered += r.candidates.len() as u64;
            report.offer_reloaded += o.reloaded.len() as u64;
        }
        let Ok(input) = source.input(&r) else {
            report.failed.push(FailedCase {
                receipt_id: id.clone(),
                class: "source".into(),
            });
            continue;
        };
        let mut ctx = DecisionContext::new(&r.agent);
        ctx.session_id = Some(r.session_id.clone());
        ctx.turn_id = Some(r.turn_id.clone());
        ctx.force_local = local_only;
        ctx.cloud_eligible = cloud_capable(candidate.backend);
        let result = if r.use_case == ReceiptUseCase::Triage {
            candidate.client.triage(&input.state, &ctx)
        } else {
            candidate.client.choice(&input, &ctx)
        };
        let (now, elapsed) = match &result {
            Ok(ok) => (Some(choice_of(&ok.value)), ok.elapsed_ms),
            Err(e) if e.reason == Failure::LowConfidence => (None, e.elapsed_ms),
            Err(e) => {
                report.candidate_ms += millis(e.elapsed_ms);
                report.failed.push(FailedCase {
                    receipt_id: id.clone(),
                    class: e.reason.as_str().to_owned(),
                });
                continue;
            }
        };
        report.candidate_ms += millis(elapsed);
        let now = now.flatten();
        if now.is_none() {
            report.candidate_abstentions += 1;
        }
        if r.fallback.is_some() {
            report.fallback_cases += 1;
            continue;
        }
        match (&r.result.choice, &now) {
            (Some(a), Some(b)) if a == b => report.agreements += 1,
            (None, None) => report.both_abstained += 1,
            _ => report.disagreements += 1,
        }
    }
    report.offer_miss_per_mille = (report.offer_offered > 0)
        .then(|| report.offer_reloaded.saturating_mul(1000) / report.offer_offered);
    report.report_hash = report.compute_hash();
    Ok(report)
}
