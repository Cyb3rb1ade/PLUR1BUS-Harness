use super::surfaces::{call, emit};
use crate::{output::Out, paths::Layout};
use clap::Subcommand;
use serde_json::{json, Value};
#[derive(Debug, Subcommand)]
pub enum IdentityCmd {
    /// Issue a one-time pairing code; --human is an administrator-only target override
    #[command(about = "[experimental] Issue a one-time pairing code")]
    Link {
        #[arg(long, default_value = "telegram")]
        channel: String,
        #[arg(long)]
        human: Option<String>,
    },
    #[command(about = "[experimental] List my identity links")]
    Links {
        #[arg(long)]
        human: Option<String>,
    },
    #[command(about = "[experimental] Approve a claimed pairing")]
    Approve { id: String },
    #[command(about = "[experimental] Decline a claimed pairing")]
    Decline { id: String },
    #[command(about = "[experimental] Unlink a channel identity")]
    Unlink { id: String },
    #[command(about = "[experimental] Show my principal union")]
    Whoami {
        #[arg(long)]
        human: Option<String>,
    },
}
pub fn request(cmd: &IdentityCmd) -> (&'static str, Value) {
    let own = |id: &Option<String>| id.as_ref().map_or(json!({}), |id| json!({"humanId":id}));
    match cmd {
        IdentityCmd::Link { channel, human } => {
            let mut p = own(human);
            p["channel"] = json!(channel);
            ("identity.link.request", p)
        }
        IdentityCmd::Links { human } => ("identity.link.list", own(human)),
        IdentityCmd::Approve { id } => ("identity.link.approve", json!({"pairingId":id})),
        IdentityCmd::Decline { id } => ("identity.link.decline", json!({"pairingId":id})),
        IdentityCmd::Unlink { id } => ("identity.link.remove", json!({"linkId":id})),
        IdentityCmd::Whoami { human } => ("identity.principals", own(human)),
    }
}
pub fn run(out: &Out, layout: &Layout, cmd: IdentityCmd) {
    let (m, p) = request(&cmd);
    emit(out, m, &call(out, layout, m, p));
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Cmd};
    use clap::Parser;
    #[test]
    fn pair_request_has_no_claimed_role() {
        let cli = Cli::try_parse_from([
            "plur1bus",
            "--json",
            "identity",
            "link",
            "--channel",
            "telegram",
        ])
        .unwrap();
        let Cmd::Identity { sub } = cli.cmd else {
            panic!()
        };
        assert_eq!(
            request(&sub),
            ("identity.link.request", json!({"channel":"telegram"}))
        );
    }
}
