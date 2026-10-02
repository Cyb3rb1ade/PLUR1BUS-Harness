//! Fixed, provisional desktop protocol names and CLI invocation shapes.
pub mod scope {
    pub const UI_SESSION: &str = "ui.session";
    pub const EVENTS_READ: &str = "events.read";
    pub const BRIDGE_SERVE: &str = "bridge.serve";
    pub const APPROVALS_DECIDE: &str = "approvals.decide";
    pub const ALL: [&str; 4] = [UI_SESSION, EVENTS_READ, BRIDGE_SERVE, APPROVALS_DECIDE];
    pub const BUNDLED: [&str; 3] = [UI_SESSION, EVENTS_READ, BRIDGE_SERVE];
    pub const NATIVE: [&str; 2] = [UI_SESSION, EVENTS_READ];
}
pub mod capability {
    pub const SESSION_TICKET: &str = "desktop.sessionTicket";
    pub const HOST_BRIDGE: &str = "host.bridge";
    pub const KEY_UNLOCK: &str = "host.keyUnlock";
    pub const SYNTHETIC_APPROVAL_FS_READ: &str = "fs.read";
}
pub mod route {
    pub const META: &str = "/api/v1/meta";
    pub const DEVICE_REDEEM: &str = "/api/v1/devices/redeem";
    pub const SESSION_TICKET: &str = "/api/v1/auth/session-ticket";
    pub const TICKET_REDEEM: &str = "/api/v1/auth/ticket/redeem";
    pub const WHOAMI: &str = "/api/v1/auth/whoami";
    pub const EVENTS: &str = "/events";
    pub const BRIDGE: &str = "/ws";
    pub const APPROVALS: &str = "/api/v1/approvals";
    pub const APPROVAL_DECISION: &str = "/api/v1/approvals/{id}/decision";
}
pub mod exec {
    use super::{capability, scope};
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Command {
        DaemonStatus,
        FirstAidCheck,
        UserCreate,
        BundledPair,
        NativePair,
        DeviceRevoke,
        StateSnapshot,
        StateVerify,
        StateRestore,
        AdminMigrate,
        AdminSmoke,
    }
    pub const DAEMON_STATUS: [&str; 3] = ["daemon", "status", "--json"];
    pub const FIRST_AID_CHECK: [&str; 3] = ["1staid", "check", "--json"];
    pub const USER_CREATE: [&str; 4] = ["user", "create", "--owner", "--json"];
    pub const ADMIN_SMOKE: [&str; 3] = ["admin", "smoke", "--json"];
    pub fn bundled_pair(name: &str) -> Vec<String> {
        vec![
            "device".into(),
            "pair".into(),
            "--json".into(),
            "--kind".into(),
            "desktop".into(),
            "--name".into(),
            name.into(),
            "--scope".into(),
            scope::BUNDLED.join(","),
            "--grant".into(),
            capability::KEY_UNLOCK.into(),
        ]
    }
    pub fn native_pair(name: &str) -> Vec<&str> {
        vec![
            "device", "pair", "--json", "--kind", "desktop", "--name", name,
        ]
    }
    pub fn device_revoke(id: &str) -> Vec<&str> {
        vec!["device", "revoke", id, "--json"]
    }
    pub fn state_snapshot<'a>(src: &'a str, dst: &'a str) -> Vec<&'a str> {
        vec!["state", "snapshot", "--src", src, "--dst", dst, "--json"]
    }
    pub fn state_verify(dir: &str) -> Vec<&str> {
        vec!["state", "verify", "--dir", dir, "--json"]
    }
    pub fn state_restore<'a>(src: &'a str, dst: &'a str) -> Vec<&'a str> {
        vec!["state", "restore", "--src", src, "--dst", dst, "--json"]
    }
    pub fn admin_migrate<'a>(from: &'a str, to: &'a str) -> Vec<&'a str> {
        vec![
            "admin", "migrate", "--from", from, "--to", to, "--yes", "--json",
        ]
    }
    pub fn classify(argv: &[&str]) -> Option<Command> {
        match argv {
            x if x == DAEMON_STATUS => Some(Command::DaemonStatus),
            x if x == FIRST_AID_CHECK => Some(Command::FirstAidCheck),
            x if x == USER_CREATE => Some(Command::UserCreate),
            x if x == ADMIN_SMOKE => Some(Command::AdminSmoke),
            ["device", "pair", "--json", "--kind", "desktop", "--name", name, "--scope", scopes, "--grant", grant]
                if !name.is_empty()
                    && *scopes == scope::BUNDLED.join(",")
                    && *grant == capability::KEY_UNLOCK =>
            {
                Some(Command::BundledPair)
            }
            ["device", "pair", "--json", "--kind", "desktop", "--name", name]
                if !name.is_empty() =>
            {
                Some(Command::NativePair)
            }
            ["device", "revoke", id, "--json"] if !id.is_empty() => Some(Command::DeviceRevoke),
            ["state", "snapshot", "--src", src, "--dst", dst, "--json"]
                if !src.is_empty() && !dst.is_empty() =>
            {
                Some(Command::StateSnapshot)
            }
            ["state", "verify", "--dir", dir, "--json"] if !dir.is_empty() => {
                Some(Command::StateVerify)
            }
            ["state", "restore", "--src", src, "--dst", dst, "--json"]
                if !src.is_empty() && !dst.is_empty() =>
            {
                Some(Command::StateRestore)
            }
            ["admin", "migrate", "--from", from, "--to", to, "--yes", "--json"]
                if !from.is_empty() && !to.is_empty() =>
            {
                Some(Command::AdminMigrate)
            }
            _ => None,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::exec::{self, Command};
    #[test]
    fn every_builder_matches_classifier() {
        let bundled = exec::bundled_pair("desk");
        assert_eq!(
            bundled,
            [
                "device",
                "pair",
                "--json",
                "--kind",
                "desktop",
                "--name",
                "desk",
                "--scope",
                "ui.session,events.read,bridge.serve",
                "--grant",
                "host.keyUnlock"
            ]
        );
        assert_eq!(
            exec::native_pair("desk"),
            ["device", "pair", "--json", "--kind", "desktop", "--name", "desk"]
        );
        assert_eq!(
            exec::state_snapshot("a", "b"),
            ["state", "snapshot", "--src", "a", "--dst", "b", "--json"]
        );
        let bundled_refs: Vec<&str> = bundled.iter().map(String::as_str).collect();
        assert_eq!(exec::classify(&bundled_refs), Some(Command::BundledPair));
        for (argv, expected) in [
            (exec::native_pair("desk"), Command::NativePair),
            (exec::device_revoke("d1"), Command::DeviceRevoke),
            (exec::state_snapshot("a", "b"), Command::StateSnapshot),
            (exec::state_verify("a"), Command::StateVerify),
            (exec::state_restore("a", "b"), Command::StateRestore),
            (exec::admin_migrate("a", "b"), Command::AdminMigrate),
        ] {
            assert_eq!(exec::classify(&argv), Some(expected));
        }
        assert_eq!(
            exec::classify(&[
                "device",
                "pair",
                "--json",
                "--kind",
                "desktop",
                "--name",
                "d",
                "--scope",
                "bridge.serve",
                "--grant",
                "host.keyUnlock"
            ]),
            None
        );
    }
}
