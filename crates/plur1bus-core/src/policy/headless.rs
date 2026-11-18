//! D109 §9 (D5): headless and unattended runs (TypeScript: `policy/headless.ts`). A job runs under its owner's principal and
//! may use only standing grants created for that job ([`super::decide::decide`] already filters grants that way). When no
//! such grant covers an approval-class call, the owner's ruling for D5 is that the call is refused at once, as a `never`:
//! nothing is asked, nothing parks, nothing waits. Silence is never approval.
use super::decide::{Decision, DenyReason};
use serde_json::Value;

/// The rule a refused headless ask carries.
pub const HEADLESS_RULE: &str = "headless:no-job-grant";

/// `headlessGate(decision, ctx)`: an ask on a headless run (or one that would park) becomes a refusal.
pub fn headless_gate(decision: Decision, ctx: &Value) -> Decision {
    match decision {
        Decision::Ask { park, .. } if ctx.get("headless").is_some() || park => Decision::Deny {
            reason: DenyReason::PolicyNever,
            rule: HEADLESS_RULE,
        },
        other => other,
    }
}
