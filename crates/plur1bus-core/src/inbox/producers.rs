//! `inbox/producers.ts`: what the source modules already announce (approval events, failed jobs, media index events, identity
//! audit lines, channel warnings, break-glass notices, old always-grants) as inbox notices. Pure functions over an
//! [`InboxPort`]; the sources only gain a callback, never a behaviour change. Metadata only; the dedupe key makes every repeat
//! a no-op.
use super::migrate::breakglass_draft;
use super::service::{InboxNotice, InboxPort, InboxTarget, SettleTarget};
use super::{InboxRef, Params};
use crate::js::is_js_space;
use crate::rbac::break_glass::BreakGlassNotice;
use serde_json::{json, Value};

/// The store's limit for one string param.
const PARAM_MAX: usize = 200;
/// `DEFAULTS.reviewNudgeAgeMs`: ninety days.
const REVIEW_NUDGE_AGE_MS: i64 = 90 * 86_400_000;

fn is_class(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// `looksLikeToken` (`rpc/channel-surface.ts`): `TOKEN_PREFIX`, `TELEGRAM_TOKEN` or `DOTTED_TOKEN`.
pub fn looks_like_token(v: &str) -> bool {
    const PREFIXES: [&str; 15] = [
        "xapp-",
        "sk-",
        "sk_",
        "pk_",
        "rk_",
        "ghp_",
        "gho_",
        "ghs_",
        "github_pat_",
        "glpat-",
        "AIza",
        "ya29.",
        "eyJ",
        "syt_",
        "mfa.",
    ];
    let b = v.as_bytes();
    let xox = b.len() >= 5
        && b.starts_with(b"xox")
        && matches!(b[3], b'a' | b'b' | b'p' | b'r' | b's')
        && b[4] == b'-';
    let akia = b.len() >= 12
        && b.starts_with(b"AKIA")
        && b[4..12]
            .iter()
            .all(|c| c.is_ascii_digit() || c.is_ascii_uppercase());
    if xox || akia || PREFIXES.iter().any(|p| v.starts_with(p)) {
        return true;
    }
    if let Some((left, right)) = v.split_once(':') {
        if left.len() >= 6
            && left.bytes().all(|c| c.is_ascii_digit())
            && right.len() >= 20
            && right.chars().all(is_class)
        {
            return true;
        }
    }
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3
        && parts[0].len() >= 20
        && parts[1].len() >= 4
        && parts[2].len() >= 20
        && parts.iter().all(|p| p.chars().all(is_class))
}

/// `s.slice(0, n)` in UTF-16 units; a cut inside a surrogate pair drops the first half (K3-D4).
fn head_units(s: &str, n: usize) -> String {
    let u: Vec<u16> = s.encode_utf16().collect();
    if u.len() <= n {
        return s.to_owned();
    }
    let mut end = n;
    if end > 0 && (0xD800..0xDC00).contains(&u[end - 1]) {
        end -= 1;
    }
    String::from_utf16_lossy(&u[..end])
}

/// `/[0-9]{6,}:[A-Za-z0-9_-]{20,}/g` replaced by `[redacted]`: a bot token glued to a path segment.
fn mask_glued_bot_tokens(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i].is_ascii_digit() {
            let mut j = i;
            while j < c.len() && c[j].is_ascii_digit() {
                j += 1;
            }
            if j - i >= 6 && j < c.len() && c[j] == ':' {
                let mut k = j + 1;
                while k < c.len() && is_class(c[k]) {
                    k += 1;
                }
                if k - (j + 1) >= 20 {
                    out.push_str("[redacted]");
                    i = k;
                    continue;
                }
            }
            out.extend(&c[i..j]);
            i = j;
            continue;
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

/// A producer string as a param: token-shaped words masked (also inside URLs and `key=value` pairs), whitespace folded, clipped
/// to what the store accepts (a long text must not cost the whole notification).
pub fn param(v: &str) -> String {
    // `v.replace(/\s+/g, " ").trim()`
    let mut folded = String::new();
    let mut in_space = false;
    for ch in v.chars() {
        if is_js_space(ch) {
            if !in_space {
                folded.push(' ');
            }
            in_space = true;
        } else {
            folded.push(ch);
            in_space = false;
        }
    }
    let folded = folded.trim_matches(' ');
    // `.replace(/[^\s/=&?#@]+/g, seg => ...)`: every piece between separators is checked.
    let sep = |c: char| is_js_space(c) || matches!(c, '/' | '=' | '&' | '?' | '#' | '@');
    let mut masked = String::new();
    let mut seg = String::new();
    let flush = |seg: &mut String, out: &mut String| {
        if seg.is_empty() {
            return;
        }
        let rest = seg.trim_start_matches(['(', '"', '\'', '`']);
        let prefix = &seg[..seg.len() - rest.len()];
        let core = rest.trim_end_matches([')', '"', '\'', '`', ',', '.', ';', ':']);
        let suffix = &rest[core.len()..];
        if !core.is_empty() && looks_like_token(core) {
            out.push_str(prefix);
            out.push_str("[redacted]");
            out.push_str(suffix);
        } else {
            out.push_str(seg);
        }
        seg.clear();
    };
    for ch in folded.chars() {
        if sep(ch) {
            flush(&mut seg, &mut masked);
            masked.push(ch);
        } else {
            seg.push(ch);
        }
    }
    flush(&mut seg, &mut masked);
    let masked = mask_glued_bot_tokens(&masked);
    if masked.encode_utf16().count() > PARAM_MAX {
        format!("{}…", head_units(&masked, PARAM_MAX - 1))
    } else {
        masked
    }
}

/// `str`: a non-empty string, else nothing.
fn str_of(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty())
}

/// `rec`: an object, else an empty one (reading a member of anything else gives `undefined`).
fn member<'a>(v: &'a Value, key: &str) -> &'a Value {
    v.as_object()
        .and_then(|o| o.get(key))
        .unwrap_or(&Value::Null)
}

fn notice(
    target: InboxTarget,
    kind: &str,
    severity: &str,
    title_key: &str,
    params: Params,
    reference: InboxRef,
    dedupe_key: String,
) -> InboxNotice {
    InboxNotice {
        target,
        kind: kind.into(),
        severity: severity.into(),
        title_key: title_key.into(),
        params: Some(params),
        reference: Some(reference),
        dedupe_key,
    }
}

fn route(route: &str, object_id: Option<&str>) -> InboxRef {
    InboxRef {
        route: Some(route.into()),
        object_id: object_id.map(str::to_owned),
    }
}

fn p(k: &str, v: String) -> (String, Value) {
    (k.into(), Value::String(v))
}

/// `approval.requested` -> an entry for the approving person; `approval.resolved` closes it (whatever the outcome).
pub fn approval_to_inbox(port: &mut dyn InboxPort, name: &str, payload: &Value) {
    if name != "approval.requested" && name != "approval.resolved" {
        return;
    }
    let a = member(payload, "approval");
    let (Some(id), Some(person)) = (str_of(member(a, "id")), str_of(member(a, "principal"))) else {
        return;
    };
    if name == "approval.resolved" {
        return port.settle(
            &SettleTarget::User(person.into()),
            &format!("approval:{id}"),
        );
    }
    let capability = str_of(member(a, "capability")).unwrap_or("unknown");
    port.publish(
        &notice(
            InboxTarget::User(person.into()),
            "approval",
            "warning",
            "inbox.approval.requested",
            vec![p("capability", param(capability))],
            route("/approvals", Some(id)),
            format!("approval:{id}"),
        ),
        None,
    );
}

/// A failed system job run: its id, the job and the reason, when there is one.
pub struct JobRun<'a> {
    /// The run id.
    pub run_id: &'a str,
    /// The job name.
    pub job: &'a str,
    /// Why it failed (empty is none).
    pub reason: Option<&'a str>,
}

/// A system job run recorded as failed -> owners and admins (job-failed). One entry per run.
pub fn job_failed_to_inbox(port: &mut dyn InboxPort, run: &JobRun<'_>) {
    let mut params = vec![p("job", param(run.job))];
    if let Some(r) = run.reason.filter(|r| !r.is_empty()) {
        params.push(p("reason", param(r)));
    }
    port.publish(
        &notice(
            InboxTarget::Admins,
            "job-failed",
            "warning",
            "inbox.jobFailed",
            params,
            route("/recurring", Some(run.run_id)),
            format!("job-failed:{}", run.run_id),
        ),
        None,
    );
}

/// `media.index.failed` (one per media object) and a finished backfill (one per index fingerprint). Owners and admins.
pub fn media_to_inbox(port: &mut dyn InboxPort, name: &str, payload: &Value) {
    if name == "media.index.failed" {
        let Some(media_id) = str_of(member(payload, "mediaId")) else {
            return;
        };
        port.publish(
            &notice(
                InboxTarget::Admins,
                "media-index",
                "warning",
                "inbox.mediaIndex.failed",
                vec![p(
                    "stage",
                    param(str_of(member(payload, "stage")).unwrap_or("index")),
                )],
                route("/library", Some(media_id)),
                format!("media-index:failed:{media_id}"),
            ),
            None,
        );
    } else if name == "media.index.status"
        && member(member(payload, "backfill"), "state") == &Value::String("done".into())
    {
        let fp = str_of(member(payload, "fingerprint")).unwrap_or("current");
        port.publish(
            &notice(
                InboxTarget::Admins,
                "media-index",
                "info",
                "inbox.mediaIndex.done",
                Vec::new(),
                route("/library", None),
                format!("media-index:done:{fp}"),
            ),
            None,
        );
    }
}

/// Identity audit lines: a claimed pairing waits for its person's confirmation; any decision closes it.
pub fn pairing_to_inbox(port: &mut dyn InboxPort, action: &str, target: &str, detail: &Value) {
    if action == "identity.pair.claim"
        && member(detail, "result") == &Value::String("awaiting-confirmation".into())
    {
        let Some(human_id) = str_of(member(detail, "humanId")) else {
            return;
        };
        port.publish(
            &notice(
                InboxTarget::User(human_id.into()),
                "pairing",
                "warning",
                "inbox.pairing.requested",
                vec![p(
                    "channel",
                    param(str_of(member(detail, "channel")).unwrap_or("unknown")),
                )],
                route("/settings", Some(target)),
                format!("pairing:{target}"),
            ),
            None,
        );
    } else if action == "identity.pair.confirm" || action == "identity.pair.revoke" {
        port.settle(&SettleTarget::All, &format!("pairing:{target}"));
    }
}

/// The switchboard's `channel.misconfigured` warning -> owners and admins; fixed channels re-notify only after the entry aged out.
pub fn channel_to_inbox(port: &mut dyn InboxPort, message: &str, fields: &Value) {
    if message != "channel.misconfigured" {
        return;
    }
    let Some(channel) = str_of(member(fields, "channel")) else {
        return;
    };
    port.publish(
        &notice(
            InboxTarget::Admins,
            "channel",
            "warning",
            "inbox.channel.misconfigured",
            vec![p("channel", param(channel))],
            route("/switchboard", Some(channel)),
            format!("channel:misconfigured:{channel}"),
        ),
        None,
    );
}

/// The durable notice stays authoritative in `admin_notices` (fail closed); this is the inbox copy.
pub fn breakglass_to_inbox(port: &mut dyn InboxPort, n: &BreakGlassNotice) {
    let d = breakglass_draft(n);
    port.publish(
        &InboxNotice {
            target: InboxTarget::User(d.user_id),
            kind: d.kind,
            severity: d.severity,
            title_key: d.title_key,
            params: d.params,
            reference: d.reference,
            dedupe_key: d.dedupe_key,
        },
        None,
    );
}

/// An always-grant as the producer reads it.
pub struct GrantInfo<'a> {
    /// The grant id.
    pub id: &'a str,
    /// The person.
    pub person: &'a str,
    /// The agent.
    pub agent: &'a str,
    /// The capability.
    pub capability: &'a str,
    /// `always`, `session`, ...
    pub scope: &'a str,
    /// When it was granted.
    pub created_at: i64,
}

/// Always-grants older than 90 days: one system inbox item for that person, never audience all. A second run is a no-op.
pub fn always_grants_to_inbox(port: &mut dyn InboxPort, grants: &[GrantInfo<'_>], now: i64) {
    for g in grants {
        if g.scope != "always" || now - g.created_at < REVIEW_NUDGE_AGE_MS || g.person.is_empty() {
            continue;
        }
        port.publish(
            &notice(
                InboxTarget::User(g.person.into()),
                "system",
                "info",
                "inbox.grant.alwaysReview",
                vec![
                    p("capability", param(g.capability)),
                    p("agent", param(g.agent)),
                ],
                route("/grants", Some(g.id)),
                format!("grant-always:{}", g.id),
            ),
            None,
        );
    }
}

/// `{ userId | audience, kind, severity, titleKey, params, ref, dedupeKey }` as a JSON value (what a recorded port call holds).
pub fn notice_json(n: &InboxNotice) -> Value {
    let mut o = serde_json::Map::new();
    match &n.target {
        InboxTarget::User(u) => o.insert("userId".into(), json!(u)),
        InboxTarget::Admins => o.insert("audience".into(), json!("admins")),
    };
    o.insert("kind".into(), json!(n.kind));
    o.insert("severity".into(), json!(n.severity));
    o.insert("titleKey".into(), json!(n.title_key));
    if let Some(p) = &n.params {
        o.insert("params".into(), Value::Object(p.iter().cloned().collect()));
    }
    if let Some(r) = &n.reference {
        let mut m = serde_json::Map::new();
        if let Some(v) = &r.route {
            m.insert("route".into(), json!(v));
        }
        if let Some(v) = &r.object_id {
            m.insert("objectId".into(), json!(v));
        }
        o.insert("ref".into(), Value::Object(m));
    }
    o.insert("dedupeKey".into(), json!(n.dedupe_key));
    Value::Object(o)
}
