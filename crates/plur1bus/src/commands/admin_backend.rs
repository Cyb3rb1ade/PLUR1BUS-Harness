//! Admin RPC request construction. Every JSON path emits the raw value through Out; no token or caller authority is supplied.
use crate::cli::{AgentCmd, BreakglassCmd, InviteCmd, PairingCmd, RightsCmd, UserCmd};
use crate::output::Out;
use crate::paths::Layout;
use serde_json::{json, Value};

type Request = (&'static str, Value, &'static str);
pub fn agent_request(cmd: &AgentCmd) -> Option<Request> {
    let request = match cmd {
        AgentCmd::Pause { id } => ("agent.pause", json!({"agentId":id}), "agent.pause/1"),
        AgentCmd::Resume { id } => ("agent.resume", json!({"agentId":id}), "agent.resume/1"),
        AgentCmd::Archive { id } => ("agent.archive", json!({"agentId":id}), "agent.archive/1"),
        AgentCmd::Unarchive { id } => (
            "agent.unarchive",
            json!({"agentId":id}),
            "agent.unarchive/1",
        ),
        AgentCmd::Export { id, offer_only } => (
            "agent.export",
            json!({"agentId":id,"offerOnly":offer_only}),
            "agent.export/1",
        ),
        AgentCmd::Delete {
            id,
            confirm_name,
            export_offer,
        } => (
            "agent.delete",
            json!({"agentId":id,"confirmName":confirm_name,"exportOfferId":export_offer}),
            "agent.delete/1",
        ),
        AgentCmd::Rights { sub } => match sub {
            RightsCmd::Get { id } => (
                "agent.rights.get",
                json!({"agentId":id}),
                "agent.rights.get/1",
            ),
            RightsCmd::Set { id, user, right } => (
                "agent.rights.set",
                json!({"agentId":id,"userId":user,"right":if right=="none" { Value::Null } else { json!(right) }}),
                "agent.rights.set/1",
            ),
        },
        _ => return None,
    };
    Some(request)
}
pub fn user_request(cmd: &UserCmd) -> Option<Request> {
    Some(match cmd {
        UserCmd::List => ("user.list", json!({}), "user.list/1"),
        UserCmd::Role { user, role } => (
            "user.role.set",
            json!({"userId":user,"role":role}),
            "user.role.set/1",
        ),
        UserCmd::Invite { sub } => match sub {
            InviteCmd::Create {
                name,
                role,
                channel,
                minutes,
            } => (
                "user.invite.create",
                json!({"displayName":name,"role":role,"channel":channel,"expiresInMinutes":minutes}),
                "user.invite.create/1",
            ),
            InviteCmd::List => ("user.invite.list", json!({}), "user.invite.list/1"),
            InviteCmd::Revoke { id } => (
                "user.invite.revoke",
                json!({"inviteId":id}),
                "user.invite.revoke/1",
            ),
        },
        _ => return None,
    })
}
pub fn run(out: &Out, layout: &Layout, request: Request) {
    let (method, params, schema) = request;
    let value = super::surfaces::call(out, layout, method, params);
    out.ok(schema, &value, || {
        serde_json::to_string_pretty(&value).unwrap_or_default()
    });
}
pub fn breakglass_request(cmd: &BreakglassCmd) -> Request {
    match cmd {
        BreakglassCmd::Request {
            user,
            reason,
            minutes,
        } => (
            "breakglass.request",
            json!({"targetUserId":user,"reason":reason,"windowMinutes":minutes}),
            "breakglass.request/1",
        ),
        BreakglassCmd::List => ("breakglass.list", json!({}), "breakglass.list/1"),
        BreakglassCmd::Revoke { id } => (
            "breakglass.revoke",
            json!({"grantId":id}),
            "breakglass.revoke/1",
        ),
        BreakglassCmd::Notices => ("breakglass.notices", json!({}), "breakglass.notices/1"),
    }
}
pub fn pairing_request(cmd: &PairingCmd) -> Request {
    match cmd {
        PairingCmd::Qr { link } => ("pairing.qr", json!({"link":link}), "pairing.qr/1"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Cmd};
    use clap::Parser;
    #[test]
    fn admin_cli_requests_are_closed_and_never_claim_identity() {
        let inputs: &[&[&str]] = &[
            &["agent", "pause", "alpha"],
            &["agent", "resume", "alpha"],
            &["agent", "archive", "alpha"],
            &["agent", "unarchive", "alpha"],
            &["agent", "export", "alpha", "--offer-only"],
            &[
                "agent",
                "delete",
                "alpha",
                "--confirm-name",
                "Alpha",
                "--export-offer",
                "offer-fixture",
            ],
            &["agent", "rights", "get", "alpha"],
            &["agent", "rights", "set", "alpha", "person-fixture", "none"],
            &["user", "list"],
            &["user", "role", "person-fixture", "member"],
            &[
                "user",
                "invite",
                "create",
                "Alex",
                "--role",
                "viewer",
                "--channel",
                "test",
            ],
            &["user", "invite", "list"],
            &["user", "invite", "revoke", "invite-fixture"],
            &[
                "breakglass",
                "request",
                "person-fixture",
                "--reason",
                "Investigate incident",
                "--minutes",
                "1",
            ],
            &["breakglass", "list"],
            &["breakglass", "revoke", "grant-fixture"],
            &["breakglass", "notices"],
            &["pairing", "qr", "--link", "plur1bus://pair?fixture"],
        ];
        for args in inputs {
            let cli = Cli::try_parse_from(
                ["plur1bus", "--json"]
                    .into_iter()
                    .chain(args.iter().copied()),
            )
            .unwrap();
            assert!(cli.json);
            let r = match cli.cmd {
                Cmd::Agent { sub } => agent_request(&sub).unwrap(),
                Cmd::User { sub } => user_request(&sub).unwrap(),
                Cmd::Breakglass { sub } => breakglass_request(&sub),
                Cmd::Pairing { sub } => pairing_request(&sub),
                _ => panic!("unexpected command"),
            };
            assert_eq!(r.2, format!("{}/1", r.0));
            assert!(r.1.get("caller").is_none());
            assert!(r.1.get("principal").is_none());
        }
    }
    #[test]
    fn delete_requires_both_confirmations_and_roles_are_presets() {
        assert!(Cli::try_parse_from(["plur1bus", "agent", "delete", "alpha"]).is_err());
        assert!(
            Cli::try_parse_from(["plur1bus", "user", "role", "person-fixture", "arbitrary"])
                .is_err()
        );
        assert!(Cli::try_parse_from([
            "plur1bus",
            "agent",
            "rights",
            "set",
            "alpha",
            "person-fixture",
            "write"
        ])
        .is_err());
    }
}
