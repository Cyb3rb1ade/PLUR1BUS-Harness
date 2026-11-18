//! D109 §2 to §9: the decision evaluator (TypeScript: `policy/decide.ts`). Pure: no I/O, no store, no clock of its own, no
//! mutation of its inputs. Grants arrive through [`GrantSource`], time through [`Clock`].
//!
//! Precedence (first match wins): deny-list > never > `tools.deny` > grants > roots > default (approval outside roots).
//!
//! The call, the context and every grant are JSON values, read the way the TypeScript evaluator reads its (unchecked)
//! objects: [`malformed`] refuses a call or context it cannot read before any rule runs, [`valid_grant`] skips a grant it
//! cannot read, and the members neither of them checks are compared with JavaScript's operators ([`super::js_value`]).
use super::capabilities::{
    capability, stricter_class, CapabilityDef, GrantScope, PolicyClass, Risk, BATCH_TARGETS_OVER,
    GRANT_SCOPES, MAX_PROMPTS_PER_TASK_PER_HOUR, ONCE_UNUSED_MS, REVIEW_NUDGE_AGE_MS, RISKS,
    SESSION_IDLE_MS, TASK_MS,
};
use super::effects::{max_effect, Effect};
use super::js_value::{
    greater_than, js_min, plus_then_number, strict_eq, to_number, truthy, TypeError,
};
use crate::js;
use serde_json::{json, Map, Value};

/// The clock of the evaluator (milliseconds since the epoch, a double as in JavaScript).
pub trait Clock {
    /// The current instant.
    fn now(&self) -> f64;
}

/// Where grants come from (`GrantSource`). A grant is the record the store hands back, as JSON.
pub trait GrantSource {
    /// `maxGrantDays?.()`: `None` where the source has no such setting (the evaluator then uses 90).
    fn max_grant_days(&self) -> Option<f64> {
        None
    }
    /// The grants of one person, agent and capability.
    fn list(&self, person: &str, agent: &str, capability: &str) -> Vec<Value>;
    /// A grant a hand-off references (D104); an unknown or foreign id is `None`.
    fn get(&self, id: &str) -> Option<Value>;
}

/// Why a call is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DenyReason {
    /// A floor: never, unknown, unreadable, out of scope.
    PolicyNever,
    /// The credential deny-list.
    DenyList,
    /// The surface or subject may not reach tools at all.
    SurfaceUntrusted,
    /// The person already denied this action in the task.
    RepeatDenied,
    /// Over the prompt cap.
    PromptCap,
}

impl DenyReason {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            DenyReason::PolicyNever => "policy-never",
            DenyReason::DenyList => "deny-list",
            DenyReason::SurfaceUntrusted => "surface-untrusted",
            DenyReason::RepeatDenied => "repeat-denied",
            DenyReason::PromptCap => "prompt-cap",
        }
    }
}

/// How an allowed call was allowed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Via {
    /// The class of the capability.
    Default,
    /// A per-agent move to `allowed`.
    Override,
    /// A grant.
    Grant,
}

impl Via {
    fn as_str(self) -> &'static str {
        match self {
            Via::Default => "default",
            Via::Override => "override",
            Via::Grant => "grant",
        }
    }
}

/// `Decision`.
#[derive(Clone, Debug, PartialEq)]
pub enum Decision {
    /// Run it.
    Allow {
        /// Why.
        via: Via,
        /// The grant that allowed it.
        grant_id: Option<String>,
        /// An `always` grant at the age of a review nudge.
        review_due: bool,
    },
    /// Ask a person (`request` is the `ApprovalRequest` as JSON).
    Ask {
        /// The approval request.
        request: Value,
        /// Headless: the job parks (§9).
        park: bool,
        /// Why it asks.
        why: &'static str,
    },
    /// Refuse it.
    Deny {
        /// Why.
        reason: DenyReason,
        /// The rule that fired.
        rule: &'static str,
    },
}

impl Decision {
    /// The TypeScript object.
    pub fn json(&self) -> Value {
        match self {
            Decision::Allow {
                via,
                grant_id,
                review_due,
            } => {
                let mut m = Map::new();
                m.insert("kind".into(), json!("allow"));
                m.insert("via".into(), json!(via.as_str()));
                if let Some(g) = grant_id {
                    m.insert("grantId".into(), json!(g));
                }
                if *review_due {
                    m.insert("reviewDue".into(), json!(true));
                }
                Value::Object(m)
            }
            Decision::Ask { request, park, why } => {
                json!({ "kind": "ask", "request": request, "park": park, "why": why })
            }
            Decision::Deny { reason, rule } => {
                json!({ "kind": "deny", "reason": reason.as_str(), "rule": rule })
            }
        }
    }
}

fn deny(reason: DenyReason, rule: &'static str) -> Decision {
    Decision::Deny { reason, rule }
}

/// `canon`: trimmed, case-folded (JavaScript `trim` and `toLowerCase`).
fn canon(s: &str) -> String {
    js::to_lower_case(s.trim_matches(js::is_js_space))
}

/// `globMatch`: `*` matches any run of UTF-16 units (line breaks included); everything else is literal. Linear backtracking
/// over the last `*`, never a regex.
fn glob_match(pattern: &str, name: &str) -> bool {
    let p: Vec<u16> = pattern.encode_utf16().collect();
    let n: Vec<u16> = name.encode_utf16().collect();
    let star_unit = u16::from(b'*');
    let (mut pi, mut ni, mut star, mut mark) = (0usize, 0usize, None::<usize>, 0usize);
    while ni < n.len() {
        if pi < p.len() && p[pi] == star_unit {
            star = Some(pi);
            pi += 1;
            mark = ni;
        } else if pi < p.len() && p[pi] == n[ni] {
            pi += 1;
            ni += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == star_unit {
        pi += 1;
    }
    pi == p.len()
}

/// `matchesDeny`: `None` for a list it cannot read (RULING: that denies everything), else whether an entry matches.
fn matches_deny(list: &Value, tool: &str, capability: &str) -> Option<bool> {
    let entries = list.as_array()?;
    let names = [canon(tool), capability.to_owned()];
    let mut hit = false;
    for entry in entries {
        let pattern = canon(entry.as_str()?);
        if pattern.is_empty() {
            return None;
        }
        if names.iter().any(|n| glob_match(&pattern, n)) {
            hit = true;
        }
    }
    Some(hit)
}

const SUBJECT_KINDS: [&str; 7] = [
    "agent",
    "subagent",
    "acp-agent",
    "mcp-client",
    "acp-editor",
    "a2a-peer",
    "remote-harness",
];
const FLAG_KEYS: [&str; 8] = [
    "privileged",
    "irreversible",
    "batch",
    "shellAllowlisted",
    "sandboxed",
    "secretSlotDeclared",
    "publishPublic",
    "systemTree",
];

fn is_obj(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_)))
}
fn str_list(v: Option<&Value>) -> bool {
    v.and_then(Value::as_array)
        .is_some_and(|a| a.iter().all(Value::is_string))
}
fn non_empty(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| !s.is_empty())
}
fn is_true(v: Option<&Value>) -> bool {
    v == Some(&Value::Bool(true))
}
fn strs(v: Option<&Value>) -> Vec<&str> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// `malformed`. RULING (TypeScript): a call or context the evaluator cannot read is refused before any rule runs.
pub fn malformed(call: &Value, ctx: &Value) -> Option<&'static str> {
    let f = call.get("flags");
    let flags_ok = is_obj(Some(call))
        && is_obj(f)
        && f.and_then(|f| f.get("outsideRoots"))
            .is_some_and(Value::is_boolean)
        && f.and_then(|f| f.get("denyListHit"))
            .is_some_and(Value::is_boolean);
    if !flags_ok {
        return Some("invalid-call");
    }
    let f = f.unwrap_or(&Value::Null);
    if FLAG_KEYS
        .iter()
        .any(|k| f.get(*k).is_some_and(|v| !v.is_boolean()))
    {
        return Some("invalid-call");
    }
    if !call.get("tool").is_some_and(Value::is_string)
        || !call.get("actionHash").is_some_and(Value::is_string)
    {
        return Some("invalid-call");
    }
    if call.get("targets").is_some() && !str_list(call.get("targets")) {
        return Some("invalid-call");
    }
    if let Some(a) = call.get("access") {
        if a != "read" && a != "write" {
            return Some("invalid-call");
        }
    }
    let principal = ctx.get("principal");
    let subject = ctx.get("subject");
    if !is_obj(Some(ctx))
        || !is_obj(principal)
        || !non_empty(principal.and_then(|p| p.get("person")))
        || !is_obj(subject)
        || !non_empty(subject.and_then(|s| s.get("agentId")))
        || !subject
            .and_then(|s| s.get("kind"))
            .and_then(Value::as_str)
            .is_some_and(|k| SUBJECT_KINDS.contains(&k))
    {
        return Some("invalid-context");
    }
    if let Some(h) = ctx.get("headless") {
        if !is_obj(Some(h)) || !non_empty(h.get("jobId")) {
            return Some("invalid-context");
        }
    }
    for key in ["tokenScopes", "deniedActionHashes"] {
        if ctx.get(key).is_some() && !str_list(ctx.get(key)) {
            return Some("invalid-context");
        }
    }
    if let Some(h) = ctx.get("handoff") {
        if !is_obj(Some(h))
            || !str_list(h.get("scope"))
            || !str_list(h.get("approvalsHeld"))
            || !non_empty(h.get("taskId"))
        {
            return Some("invalid-context");
        }
    }
    None
}

fn finite_number(v: Option<&Value>) -> bool {
    v.and_then(Value::as_f64).is_some_and(f64::is_finite)
}

/// `validGrant`: a grant record the evaluator can read; any other one is skipped.
pub fn valid_grant(g: &Value) -> bool {
    let s = |k: &str| non_empty(g.get(k));
    let optional_time = |k: &str| g.get(k).is_none() || finite_number(g.get(k));
    let m = g.get("match");
    let match_ok = match m.and_then(|m| m.get("kind")).and_then(Value::as_str) {
        Some("action" | "capability") => true,
        Some("path") => {
            let m = m.unwrap_or(&Value::Null);
            non_empty(m.get("path"))
                && matches!(
                    m.get("access").and_then(Value::as_str),
                    Some("read" | "write")
                )
                && m.get("recursive").is_some_and(Value::is_boolean)
        }
        _ => false,
    };
    g.is_object()
        && s("id")
        && s("capability")
        && s("person")
        && s("agent")
        && g.get("scope")
            .and_then(Value::as_str)
            .and_then(GrantScope::parse)
            .is_some()
        && finite_number(g.get("createdAt"))
        && optional_time("lastUsedAt")
        && optional_time("expiresAt")
        && g.get("surface")
            .and_then(Value::as_f64)
            .is_some_and(|n| n == 0.0 || n == 1.0 || n == 2.0 || n == 3.0)
        && is_obj(m)
        && match_ok
}

/// The flags of a call that the helpers read (`CallFlags`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Flags {
    /// A target lies outside every root.
    pub outside_roots: bool,
    /// `privileged`.
    pub privileged: bool,
    /// `irreversible`.
    pub irreversible: bool,
    /// `batch` (or more than 20 targets, where the caller counts them).
    pub batch: bool,
    /// `publishPublic`.
    pub publish_public: bool,
    /// `systemTree`.
    pub system_tree: bool,
}

impl Flags {
    /// The flags of a `CallFlags` object as the helpers below read them in TypeScript: five by truthiness (`flags.systemTree`
    /// with `1`, `"x"`, `{}` or `[]` is set; `0`, `""`, `null` and an absent member are not), `batch` only when it is `true`
    /// itself. [`decide`] refuses a call whose flags are not booleans, so the difference shows only where a caller hands the
    /// helpers flags from somewhere else (a stored approval request).
    pub fn of(f: &Value) -> Flags {
        let set = |k: &str| truthy(f.get(k));
        Flags {
            outside_roots: set("outsideRoots"),
            privileged: set("privileged"),
            irreversible: set("irreversible"),
            batch: is_true(f.get("batch")),
            publish_public: set("publishPublic"),
            system_tree: set("systemTree"),
        }
    }
}

/// `maxScopeFor`: the highest scope a grant for this call may have.
pub fn max_scope_for(def: &CapabilityDef, flags: Flags) -> GrantScope {
    let mut max = def.ceiling.unwrap_or(GrantScope::Once);
    let mut cap = |s: GrantScope| {
        if s < max {
            max = s;
        }
    };
    if flags.batch {
        cap(GrantScope::Once);
    }
    if flags.system_tree {
        cap(GrantScope::Task);
    }
    if flags.publish_public {
        cap(GrantScope::Once);
    }
    max
}

/// `riskOf`.
pub fn risk_of(def: &CapabilityDef, flags: Flags) -> Risk {
    let mut r = def.base_risk as usize;
    if flags.outside_roots && def.intrinsic_effect.rank() >= Effect::LocalWrite.rank() {
        r += 1;
    }
    if flags.irreversible {
        r += 1;
    }
    if flags.privileged {
        r += 1;
    }
    if flags.publish_public || flags.system_tree {
        r = 3;
    }
    RISKS[r.min(3)]
}

/// `requiredSurface`: the surface needed to decide (or to have created a grant) at `scope` for this call.
pub fn required_surface(def: &CapabilityDef, scope: GrantScope, flags: Flags) -> u8 {
    let mut s = def
        .min_surface
        .unwrap_or(1)
        .max(risk_of(def, flags).surface());
    if scope == GrantScope::Always
        && flags.outside_roots
        && matches!(def.id, "fs.write" | "shell.exec")
    {
        s = 3;
    }
    if scope == GrantScope::Always && matches!(def.id, "net.publish" | "remote.control") {
        s = 3;
    }
    if flags.publish_public || flags.system_tree {
        s = 3;
    }
    s
}

/// `surfaceMayDecide`: may a decision made on `surface` be accepted for this request (§5)? T0 never.
pub fn surface_may_decide(
    capability_id: &str,
    risk: Risk,
    flags: Flags,
    surface: u8,
    scope: GrantScope,
) -> bool {
    let Some(def) = capability(capability_id) else {
        return false;
    };
    if surface == 0 {
        return false;
    }
    if surface == 1
        && !(risk == Risk::Low && matches!(def.id, "fs.read" | "fs.write" | "clipboard.read"))
    {
        return false;
    }
    surface >= required_surface(def, scope, flags) && scope <= max_scope_for(def, flags)
}

/// `grantExpiry(g, maxGrantDays)`: the instant a grant ends, read with JavaScript's arithmetic (a lifetime base that is not
/// a number concatenates, as `+` does, and is read back as a number; an absent one makes the sum `NaN`). `Err` where the
/// TypeScript function throws: a time member that has no primitive form.
pub fn grant_expiry(g: &Value, max_grant_days: f64) -> Result<f64, TypeError> {
    let created = g.get("createdAt");
    // `a ?? b`: `null` and an absent member fall through to the creation time.
    let base_or_created = |k: &str| match g.get(k) {
        None | Some(Value::Null) => created,
        present => present,
    };
    let scope = g
        .get("scope")
        .and_then(Value::as_str)
        .and_then(GrantScope::parse);
    let bound = match scope {
        Some(GrantScope::Once) => plus_then_number(created, ONCE_UNUSED_MS)?,
        Some(GrantScope::Task) => plus_then_number(created, TASK_MS)?,
        Some(GrantScope::Session) => {
            plus_then_number(base_or_created("lastUsedAt"), SESSION_IDLE_MS)?
        }
        _ => {
            let key = if g.get("capability").and_then(Value::as_str) == Some("memory.jobs.run") {
                "lastJobTurnAt"
            } else {
                "lastUsedAt"
            };
            plus_then_number(
                base_or_created(key),
                max_grant_days * 24.0 * 60.0 * 60_000.0,
            )?
        }
    };
    Ok(match g.get("expiresAt") {
        None => bound,
        present => js_min(bound, to_number(present)?),
    })
}

/// `grantReviewDue`: an `always` grant gets a review nudge at 90 days of age (Q13). `Err` where the TypeScript function
/// throws (a creation time that has no primitive form); a grant of another scope is never read that far.
pub fn grant_review_due(g: &Value, now: f64) -> Result<bool, TypeError> {
    if g.get("scope").and_then(Value::as_str) != Some("always") {
        return Ok(false);
    }
    Ok(now - to_number(g.get("createdAt"))? >= REVIEW_NUDGE_AGE_MS)
}

/// `ABS`: `/`, a drive letter with a separator, or `\\`.
fn absolute_spelling(p: &str) -> bool {
    let b = p.as_bytes();
    p.starts_with('/')
        || p.starts_with("\\\\")
        || (b.len() >= 3
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && (b[2] == b'\\' || b[2] == b'/'))
}

fn segments(p: &str) -> Option<(bool, Vec<&str>)> {
    if p.is_empty() || p.contains('\0') || !absolute_spelling(p) {
        return None;
    }
    let posix = p.starts_with('/');
    let segs: Vec<&str> = if posix {
        p.split('/').filter(|s| !s.is_empty()).collect()
    } else {
        p.split(['\\', '/']).filter(|s| !s.is_empty()).collect()
    };
    (!segs.iter().any(|s| *s == "." || *s == "..")).then_some((posix, segs))
}

/// `pathCovered`: exact-form, case-sensitive coverage on already canonical paths; ambiguity resolves toward "not covered".
/// POSIX and Windows spellings never cover each other.
pub fn path_covered(grant_path: &str, recursive: bool, target: &str) -> bool {
    let (Some((gp, g)), Some((tp, t))) = (segments(grant_path), segments(target)) else {
        return false;
    };
    if gp != tp || g.is_empty() || g.len() > t.len() || g.iter().zip(&t).any(|(a, b)| a != b) {
        return false;
    }
    recursive || t.len() == g.len() + 1
}

/// The parsed parts of a call `decide` reads after [`malformed`] passed.
struct CallView<'a> {
    call: &'a Value,
    flags: &'a Value,
    f: Flags,
    targets: Vec<&'a str>,
}

impl CallView<'_> {
    fn flag(&self, k: &str) -> bool {
        is_true(self.flags.get(k))
    }
    fn batch(&self) -> bool {
        self.f.batch || self.targets.len() > BATCH_TARGETS_OVER
    }
    fn batched(&self) -> Flags {
        Flags {
            batch: self.batch(),
            ..self.f
        }
    }
}

/// `decide(call, ctx, deps)`.
pub fn decide(call: &Value, ctx: &Value, grants: &dyn GrantSource, clock: &dyn Clock) -> Decision {
    if let Some(bad) = malformed(call, ctx) {
        return deny(DenyReason::PolicyNever, bad);
    }
    let cap_id = call
        .get("capability")
        .and_then(Value::as_str)
        .map(canon)
        .unwrap_or_default();
    let Some(def) = capability(&cap_id) else {
        // RULING (TypeScript): an unknown capability id is never, not approval.
        return deny(DenyReason::PolicyNever, "unknown-capability");
    };
    let flags = call.get("flags").unwrap_or(&Value::Null);
    let v = CallView {
        call,
        flags,
        f: Flags::of(flags),
        targets: strs(call.get("targets")),
    };
    let tool = call.get("tool").and_then(Value::as_str).unwrap_or("");
    let subject_kind = ctx["subject"]["kind"].as_str().unwrap_or("");
    let person = ctx["principal"]["person"].as_str().unwrap_or("");

    // (1) the credential deny-list
    if v.flag("denyListHit") {
        return deny(DenyReason::DenyList, "deny-list");
    }
    // (2) never capabilities, and an undeclared secret slot
    if def.inside == PolicyClass::Never {
        return deny(DenyReason::PolicyNever, "never");
    }
    if def.id == "secrets.use" && !v.flag("secretSlotDeclared") {
        return deny(DenyReason::PolicyNever, "never:secret-slot");
    }
    // (3) tools.deny
    if let Some(list) = ctx.get("toolsDeny") {
        match matches_deny(list, tool, def.id) {
            None => return deny(DenyReason::PolicyNever, "tools.deny:invalid"),
            Some(true) => return deny(DenyReason::PolicyNever, "tools.deny"),
            Some(false) => {}
        }
    }
    // Subject limits narrow only. RULING (TypeScript): an A2A peer reaches no tool through this evaluator at all.
    if subject_kind == "a2a-peer" {
        return deny(DenyReason::SurfaceUntrusted, "a2a-peer");
    }
    if ctx.get("tokenScopes").is_some()
        && !strs(ctx.get("tokenScopes"))
            .iter()
            .any(|c| canon(c) == def.id)
    {
        return deny(DenyReason::PolicyNever, "token-scope");
    }
    let handoff = ctx.get("handoff");
    if subject_kind == "subagent"
        && !handoff.is_some_and(|h| strs(h.get("scope")).iter().any(|c| canon(c) == def.id))
    {
        return deny(DenyReason::PolicyNever, "handoff-scope");
    }

    // RULING (TypeScript): an effect string outside the vocabulary is the strictest one (money), never harmless.
    let effect = match call.get("effect") {
        None => def.intrinsic_effect,
        Some(e) => match e.as_str().and_then(Effect::parse) {
            Some(e) => max_effect(e, def.intrinsic_effect),
            None => Effect::Money,
        },
    };
    let batch = v.batch();
    let taint = ctx.get("taint");
    let tainted = is_true(taint.and_then(|t| t.get("tainted")));
    let taint_suspends = tainted
        && is_true(taint.and_then(|t| t.get("readPrivate")))
        && (def.taint_sensitive || matches!(effect, Effect::External | Effect::NetworkA2a));

    // (5/6) class from roots and defaults, then the person's per-agent move, then the floors no override lowers.
    let mut cls = if v.f.outside_roots {
        def.outside
    } else {
        def.inside
    };
    if def.id == "shell.exec" && v.flag("shellAllowlisted") && !v.f.outside_roots && !v.f.privileged
    {
        cls = PolicyClass::Allowed;
    }
    let mut via = Via::Default;
    if let Some(ov) = override_for(ctx.get("overrides"), def.id) {
        if def.lowerable {
            if ov == PolicyClass::Approval {
                cls = stricter_class(cls, PolicyClass::Approval);
            } else if cls == PolicyClass::Approval && !v.f.outside_roots {
                // RULING (Q12): roots are a hard limit; a per-agent "allowed" never lifts the approval outside them.
                cls = PolicyClass::Allowed;
                via = Via::Override;
            }
        }
    }
    let floored = v.f.privileged
        || v.f.irreversible
        || batch
        || matches!(
            effect,
            Effect::Money | Effect::External | Effect::NetworkA2a | Effect::LocalDestructive
        )
        || (v.f.outside_roots && effect.rank() >= Effect::LocalWrite.rank());
    if floored {
        cls = stricter_class(cls, PolicyClass::Approval);
    }

    if cls == PolicyClass::Allowed {
        // An override is a standing permission; the taint rule suspends it like any standing grant (§8).
        if via == Via::Override && taint_suspends {
            return ask(def, &v, ctx, effect, true, "taint-suspended");
        }
        return Decision::Allow {
            via,
            grant_id: None,
            review_due: false,
        };
    }

    // (4) grants
    let now = clock.now();
    if now.is_finite() {
        let max_days = grants.max_grant_days().unwrap_or(90.0);
        for g in candidate_grants(ctx, grants, def.id, person, subject_kind) {
            if valid_grant(&g)
                && grant_applies(
                    &g,
                    def,
                    &v,
                    ctx,
                    effect,
                    batch,
                    taint_suspends,
                    now,
                    max_days,
                )
            {
                return Decision::Allow {
                    via: Via::Grant,
                    grant_id: g.get("id").and_then(Value::as_str).map(str::to_owned),
                    // `valid_grant` has seen a finite `createdAt`, so the conversion cannot fail here.
                    review_due: grant_review_due(&g, now).unwrap_or(false),
                };
            }
        }
    }

    let action_hash = call.get("actionHash").and_then(Value::as_str).unwrap_or("");
    if strs(ctx.get("deniedActionHashes")).contains(&action_hash) {
        return deny(DenyReason::RepeatDenied, "fatigue:repeat-denied");
    }
    let prompts = match ctx.get("promptsThisHour") {
        None | Some(Value::Null) => Some(0.0),
        Some(p) => p.as_f64(),
    };
    // RULING (TypeScript): over the cap is refused, not queued.
    if !prompts.is_some_and(|p| p < MAX_PROMPTS_PER_TASK_PER_HOUR) {
        return deny(DenyReason::PromptCap, "fatigue:prompt-cap");
    }
    let why = if taint_suspends {
        "taint-suspended"
    } else if cls == PolicyClass::Approval {
        "approval-class"
    } else {
        "approval"
    };
    ask(def, &v, ctx, effect, taint_suspends, why)
}

/// `overrideFor`: the stricter of duplicate spellings wins.
fn override_for(o: Option<&Value>, id: &str) -> Option<PolicyClass> {
    // `Object.entries` of anything but a plain object yields index keys or nothing, which never name a capability.
    let map = o?.as_object()?;
    let mut out = None;
    for (k, v) in map {
        if canon(k) != id {
            continue;
        }
        match v.as_str() {
            Some("approval") => return Some(PolicyClass::Approval),
            Some("allowed") => out = Some(PolicyClass::Allowed),
            _ => {}
        }
    }
    out
}

fn ask(
    def: &CapabilityDef,
    v: &CallView<'_>,
    ctx: &Value,
    effect: Effect,
    taint_suspended: bool,
    why: &'static str,
) -> Decision {
    let max = max_scope_for(def, v.batched());
    let options: Vec<Value> = GRANT_SCOPES
        .iter()
        .filter(|s| **s <= max)
        .map(|s| json!({ "scope": s.as_str(), "requiredSurface": required_surface(def, *s, v.f) }))
        .collect();
    let required = options
        .first()
        .map(|o| o["requiredSurface"].clone())
        .unwrap_or(json!(3));
    let mut flags = v.flags.as_object().cloned().unwrap_or_default();
    if v.batch() {
        flags.insert("batch".into(), json!(true));
    }
    let mut request = Map::new();
    request.insert("capability".into(), json!(def.id));
    request.insert(
        "tool".into(),
        v.call.get("tool").cloned().unwrap_or(Value::Null),
    );
    request.insert("effect".into(), json!(effect.as_str()));
    request.insert("flags".into(), Value::Object(flags));
    request.insert("risk".into(), json!(risk_of(def, v.f).as_str()));
    request.insert(
        "reversible".into(),
        json!(!v.f.irreversible && !matches!(effect, Effect::LocalDestructive | Effect::Money)),
    );
    request.insert(
        "actionHash".into(),
        v.call.get("actionHash").cloned().unwrap_or(Value::Null),
    );
    request.insert("grantOptions".into(), Value::Array(options));
    request.insert("requiredSurface".into(), required);
    request.insert(
        "tainted".into(),
        json!(is_true(ctx.get("taint").and_then(|t| t.get("tainted")))),
    );
    request.insert("taintSuspended".into(), json!(taint_suspended));
    if let Some(s) = ctx.get("surface") {
        request.insert("originSurface".into(), s.clone());
    }
    Decision::Ask {
        request: Value::Object(request),
        park: ctx.get("headless").is_some(),
        why,
    }
}

fn candidate_grants(
    ctx: &Value,
    grants: &dyn GrantSource,
    capability: &str,
    person: &str,
    subject_kind: &str,
) -> Vec<Value> {
    let agent = ctx["subject"]["agentId"].as_str().unwrap_or("");
    let mut out = grants.list(person, agent, capability);
    if let (true, Some(h)) = (subject_kind == "subagent", ctx.get("handoff")) {
        for id in strs(h.get("approvalsHeld")) {
            // A forged or foreign id resolves to nothing, or to a grant the checks below refuse.
            if let Some(g) = grants.get(id) {
                if is_true(g.get("delegable"))
                    && strict_eq(g.get("taskId"), h.get("taskId"))
                    && strict_eq(g.get("person"), ctx["principal"].get("person"))
                {
                    out.push(g);
                }
            }
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn grant_applies(
    g: &Value,
    def: &CapabilityDef,
    v: &CallView<'_>,
    ctx: &Value,
    effect: Effect,
    batch: bool,
    taint_suspends: bool,
    now: f64,
    max_grant_days: f64,
) -> bool {
    let gs = |k: &str| g.get(k).and_then(Value::as_str);
    // Anything but an explicit false or an absent revocation marker counts as revoked.
    if g.get("revoked").is_some_and(|r| r != &Value::Bool(false))
        || gs("capability").map(canon).as_deref() != Some(def.id)
        || !strict_eq(g.get("person"), ctx["principal"].get("person"))
    {
        return false;
    }
    let Some(scope) = gs("scope").and_then(GrantScope::parse) else {
        return false;
    };
    let headless = ctx.get("headless");
    if let Some(h) = headless {
        let job = h.get("jobId").and_then(Value::as_str).unwrap_or("");
        let catalogue = def.id == "memory.jobs.run"
            && gs("jobId") == Some("engine:*")
            && job.starts_with("engine:");
        if (!catalogue && !strict_eq(g.get("jobId"), h.get("jobId"))) || scope != GrantScope::Always
        {
            return false;
        }
    } else if g.get("jobId").is_some() {
        return false;
    }
    let subject = &ctx["subject"];
    let own_agent = strict_eq(g.get("agent"), subject.get("agentId"));
    let handoff = ctx.get("handoff");
    let held = subject.get("kind").and_then(Value::as_str) == Some("subagent")
        && handoff
            .is_some_and(|h| gs("id").is_some_and(|id| strs(h.get("approvalsHeld")).contains(&id)));
    if !own_agent && !held {
        return false;
    }
    if scope > max_scope_for(def, Flags { batch, ..v.f }) {
        return false;
    }
    let created = g
        .get("createdAt")
        .and_then(Value::as_f64)
        .unwrap_or(f64::NAN);
    // K2-D8: `validGrant` does not look at `lastJobTurnAt`, and the three comparisons below convert it. Where the conversion
    // throws in TypeScript (the whole `decide` call throws with it), this port skips the grant as it skips an invalid one: a
    // record that cannot be read grants nothing, and it does not take the decision down with it.
    let Ok(expiry) = grant_expiry(g, max_grant_days) else {
        return false;
    };
    // A grant from the future is not valid yet (fail closed).
    if created > now || now >= expiry {
        return false;
    }
    // A use in the future would stretch the idle or 90-day expiry.
    if greater_than(g.get("lastUsedAt"), now).unwrap_or(true) {
        return false;
    }
    let owner_job = def.id == "memory.jobs.run"
        && gs("origin") == Some("auto-agent-owner")
        && gs("jobId") == Some("engine:*");
    let surface = g.get("surface").and_then(Value::as_f64).unwrap_or(0.0);
    if !owner_job && surface < f64::from(required_surface(def, scope, v.f)) {
        return false;
    }
    if greater_than(g.get("lastJobTurnAt"), now).unwrap_or(true) {
        return false;
    }
    if taint_suspends && scope != GrantScope::Once {
        return false;
    }
    if g.get("projectId").is_some() && !strict_eq(g.get("projectId"), ctx.get("projectId")) {
        return false;
    }
    let kind = g["match"]["kind"].as_str().unwrap_or("");
    match scope {
        GrantScope::Once => {
            return g.get("consumedAt").is_none()
                && g.get("actionHash").is_some()
                && strict_eq(g.get("actionHash"), v.call.get("actionHash"))
                && kind == "action";
        }
        GrantScope::Task => {
            let want = if own_agent {
                ctx.get("taskId")
            } else {
                handoff.and_then(|h| h.get("taskId"))
            };
            if g.get("taskId").is_none() || !strict_eq(g.get("taskId"), want) {
                return false;
            }
        }
        GrantScope::Session => {
            if g.get("sessionId").is_none() || !strict_eq(g.get("sessionId"), ctx.get("sessionId"))
            {
                return false;
            }
        }
        GrantScope::Always => {}
    }
    if kind == "action" {
        return false; // an action-bound grant is `once` by construction
    }
    if batch || v.f.privileged || effect == Effect::Money {
        return false;
    }
    // Q17: the roots bind `shell.exec` only through the OS sandbox, so a standing grant of either kind never stands in for
    // it: without a sandbox it applies only when the person knowingly accepted "not sandboxed".
    if def.id == "shell.exec" && !v.flag("sandboxed") && !is_true(g.get("acknowledgedUnsandboxed"))
    {
        return false;
    }
    if kind == "capability" {
        return !v.f.outside_roots;
    }
    let m = &g["match"];
    let access = v.call.get("access").and_then(Value::as_str);
    if v.targets.is_empty() || access.is_none() {
        return false;
    }
    if m["access"] == "read" && access == Some("write") {
        return false;
    }
    let (path, recursive) = (
        m["path"].as_str().unwrap_or(""),
        is_true(m.get("recursive")),
    );
    v.targets.iter().all(|t| path_covered(path, recursive, t))
}
