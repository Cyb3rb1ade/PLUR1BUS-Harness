//! `plur1bus user ls|add|pair|link|unlink` (M3, ADR-007, D24): humans, the channel identities linked to them, and the
//! pairing flow. Every action is an `identity.*` RPC (owner only: the CLI caller); the code of `pair start` is printed
//! once, here, and exists nowhere else but as a salted hash in the core's store.
use crate::cli::{PairCmd, UserCmd};
use crate::commands::memory_ops::{connect_core, require_supports};
use crate::identity::caller;
use crate::output::Out;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::time::Duration;

fn handle(channel: &str, account: &str, user_id: &str, display_name: &Option<String>) -> Value {
    let mut h = json!({ "channel": channel, "accountId": account, "userId": user_id });
    if let Some(n) = display_name {
        h["displayName"] = json!(n);
    }
    h
}

/// The `(method, params, schema id)` of a command: pure, so its shape is unit-tested without a core.
pub fn request(cmd: &UserCmd) -> (&'static str, Value, &'static str) {
    let c = serde_json::to_value(caller()).unwrap_or(Value::Null);
    match cmd {
        UserCmd::Ls { all } => (
            "identity.list",
            json!({ "caller": c, "includeRevoked": all }),
            "user.ls/1",
        ),
        UserCmd::Add { name } => (
            "identity.human.create",
            json!({ "caller": c, "displayName": name }),
            "user.add/1",
        ),
        UserCmd::Link {
            human,
            channel,
            account,
            user_id,
            display_name,
        } => (
            "identity.link",
            json!({ "caller": c, "humanId": human, "identity": handle(channel, account, user_id, display_name) }),
            "user.link/1",
        ),
        UserCmd::Unlink { link } => (
            "identity.unlink",
            json!({ "caller": c, "linkId": link }),
            "user.unlink/1",
        ),
        UserCmd::Pair { sub } => match sub {
            PairCmd::Start { human, channel } => (
                "identity.pair.start",
                json!({ "caller": c, "humanId": human, "channel": channel }),
                "user.pair.start/1",
            ),
            PairCmd::Claim {
                code,
                channel,
                account,
                user_id,
                display_name,
            } => (
                "identity.pair.claim",
                json!({ "caller": c, "code": code, "identity": handle(channel, account, user_id, display_name) }),
                "user.pair.claim/1",
            ),
            PairCmd::Confirm { pairing, reject } => (
                "identity.pair.confirm",
                json!({ "caller": c, "pairingId": pairing, "approve": !reject }),
                "user.pair.confirm/1",
            ),
        },
    }
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn link_line(l: &Value) -> String {
    let revoked = if l.get("revokedAt").is_some_and(|r| !r.is_null()) {
        "  [revoked]"
    } else {
        ""
    };
    let name = l
        .get("displayName")
        .and_then(Value::as_str)
        .map(|n| format!(" \"{n}\""))
        .unwrap_or_default();
    format!(
        "  {}  {}:{}/{}{}  ({}){}",
        s(l, "id"),
        s(l, "channel"),
        s(l, "accountId"),
        s(l, "userId"),
        name,
        s(l, "proofMethod"),
        revoked
    )
}

fn render_list(v: &Value) -> String {
    let mut out = String::new();
    let humans = v
        .get("humans")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if humans.is_empty() {
        out.push_str("no humans yet; create one with `plur1bus user add <name>`\n");
    }
    for h in &humans {
        out.push_str(&format!("{}  {}\n", s(h, "id"), s(h, "displayName")));
        let ids = h
            .get("identities")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if ids.is_empty() {
            out.push_str("  (no linked identities)\n");
        }
        for l in &ids {
            out.push_str(&link_line(l));
            out.push('\n');
        }
    }
    let pairings = v
        .get("pairings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !pairings.is_empty() {
        out.push_str("\nwaiting pairings:\n");
        for p in &pairings {
            let by = p
                .get("claimedBy")
                .map(|c| {
                    format!(
                        " claimed by {}:{}/{}",
                        s(c, "channel"),
                        s(c, "accountId"),
                        s(c, "userId")
                    )
                })
                .unwrap_or_default();
            out.push_str(&format!(
                "  {}  {}  {} for human {}{}\n",
                s(p, "id"),
                s(p, "channel"),
                s(p, "state"),
                s(p, "humanId"),
                by
            ));
        }
    }
    out.trim_end().to_string()
}

fn render(schema: &str, v: &Value) -> String {
    match schema {
        "user.ls/1" => render_list(v),
        "user.add/1" => format!("created {}  {}", s(v, "id"), s(v, "displayName")),
        "user.link/1" => format!("linked{}", link_line(v)),
        "user.unlink/1" => format!("unlinked{}", link_line(v)),
        "user.pair.start/1" => format!(
            "pairing code for {}: {}\n(shown once; send it from the {} identity to link; valid until {})\nconfirm with: plur1bus user pair confirm {}",
            s(v, "channel"),
            s(v, "code"),
            s(v, "channel"),
            v.get("expiresAt").and_then(Value::as_i64).unwrap_or(0),
            s(v, "pairingId")
        ),
        "user.pair.claim/1" => format!(
            "claimed; waiting for the owner: plur1bus user pair confirm {}",
            s(v, "pairingId")
        ),
        _ => match v.get("link") {
            Some(l) => format!("{}\n{}", s(v, "state"), link_line(l)),
            None => s(v, "state").to_string(),
        },
    }
}

pub fn run(out: &Out, layout: &Layout, cmd: UserCmd) {
    let (method, params, schema) = request(&cmd);
    let mut client = connect_core(out, layout, "identity", Duration::from_secs(15));
    require_supports(out, &client, method);
    match client.call(method, params) {
        Ok(v) => out.ok(schema, &v, || render(schema, &v)),
        Err(e) => out.from_rpc_error(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_carry_the_cli_caller_and_a_schema_id() {
        let (m, p, id) = request(&UserCmd::Add {
            name: "Alex".into(),
        });
        assert_eq!((m, id), ("identity.human.create", "user.add/1"));
        assert_eq!(p["caller"]["channel"], "cli");
        assert_eq!(p["displayName"], "Alex");

        let (m, p, id) = request(&UserCmd::Pair {
            sub: PairCmd::Confirm {
                pairing: "p1".into(),
                reject: true,
            },
        });
        assert_eq!((m, id), ("identity.pair.confirm", "user.pair.confirm/1"));
        assert_eq!(p["approve"], false);

        let (m, p, _) = request(&UserCmd::Link {
            human: "h".into(),
            channel: "telegram".into(),
            account: "bot".into(),
            user_id: "42".into(),
            display_name: None,
        });
        assert_eq!(m, "identity.link");
        assert!(p["identity"].get("displayName").is_none());
    }

    #[test]
    fn the_code_appears_only_in_pair_start_output() {
        let start =
            json!({ "pairingId": "p1", "code": "K7M2QX9D", "channel": "telegram", "expiresAt": 1 });
        assert!(render("user.pair.start/1", &start).contains("K7M2QX9D"));
        let list = json!({ "humans": [], "pairings": [{ "id": "p1", "humanId": "h", "channel": "telegram", "state": "pending", "createdAt": 0, "expiresAt": 1 }] });
        assert!(!render("user.ls/1", &list).contains("K7M2QX9D"));
    }
}
