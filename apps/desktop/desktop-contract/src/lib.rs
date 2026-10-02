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

/// Provisional M3 trust protocol. No server-selected KDF parameters are accepted.
pub mod trust {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use hmac::{Hmac, Mac};
    use serde::{Deserialize, Serialize};
    pub const PAIR_PROOF: &str = "/api/v1/devices/pair-proof";
    pub const CA: &str = "/api/v1/devices/ca";
    pub const TRUST: &str = "/api/v1/devices/trust";
    pub const ACK: &str = "/api/v1/devices/trust/ack";
    pub const EVENT: &str = "devices.trust.next";
    pub const MAX_BODY: usize = 65536;
    pub const MAX_CA: usize = 16384;
    pub const CODE_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    pub const MEMORY_KIB: u32 = 65536;
    pub const ITERATIONS: u32 = 3;
    pub const LANES: u32 = 1;
    #[derive(Clone, Serialize, Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    pub struct ProofRequest {
        pub client_nonce: String,
    }
    #[derive(Clone, Serialize, Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    pub struct Proof {
        pub salt: String,
        pub server_nonce: String,
        pub proof: String,
        pub ca_pin: Option<String>,
    }
    #[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    pub struct Trust {
        pub cert_pin: Option<String>,
        pub ca_pin: Option<String>,
        pub next_cert_pin: Option<String>,
        pub next_ca_pin: Option<String>,
    }
    #[derive(Clone, Serialize, Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    pub struct Ack {
        pub next_cert_pin: Option<String>,
        pub next_ca_pin: Option<String>,
    }
    pub fn decode(value: &str, len: usize) -> Result<Vec<u8>, &'static str> {
        let bytes = URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| "invalid encoding")?;
        if bytes.len() != len || URL_SAFE_NO_PAD.encode(&bytes) != value {
            return Err("invalid length");
        }
        Ok(bytes)
    }
    pub fn valid_code(code: &str) -> bool {
        code.len() == 9
            && code.as_bytes()[4] == b'-'
            && code
                .bytes()
                .enumerate()
                .all(|(i, b)| i == 4 || CODE_ALPHABET.contains(&b))
    }
    pub fn key(code: &str, salt: &str) -> Result<zeroize::Zeroizing<[u8; 32]>, &'static str> {
        if !valid_code(code) {
            return Err("invalid code");
        }
        let salt = decode(salt, 16)?;
        let params = argon2::Params::new(MEMORY_KIB, ITERATIONS, LANES, Some(32))
            .map_err(|_| "parameters")?;
        let mut key = zeroize::Zeroizing::new([0; 32]);
        argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params)
            .hash_password_into(code.as_bytes(), &salt, &mut *key)
            .map_err(|_| "derivation")?;
        Ok(key)
    }
    // Literal owner's expression. All fields use canonical UTF-8; optional CA occurs after fp.
    pub fn mac(
        key: &[u8],
        fp: &str,
        ca: Option<&str>,
        origin: &str,
        client: &str,
        server: &str,
    ) -> Hmac<sha2::Sha256> {
        let mut h =
            Hmac::<sha2::Sha256>::new_from_slice(key).expect("HMAC accepts every key length");
        for field in [
            "plur1bus-pair-v1",
            fp,
            ca.unwrap_or(""),
            origin,
            client,
            server,
        ] {
            h.update(field.as_bytes())
        }
        h
    }
    pub fn sign(
        key: &[u8],
        fp: &str,
        ca: Option<&str>,
        origin: &str,
        client: &str,
        server: &str,
    ) -> String {
        URL_SAFE_NO_PAD.encode(
            mac(key, fp, ca, origin, client, server)
                .finalize()
                .into_bytes(),
        )
    }
    pub fn verify(
        key: &[u8],
        fp: &str,
        origin: &str,
        client: &str,
        proof: &Proof,
    ) -> Result<(), &'static str> {
        decode(client, 32)?;
        decode(&proof.server_nonce, 32)?;
        mac(
            key,
            fp,
            proof.ca_pin.as_deref(),
            origin,
            client,
            &proof.server_nonce,
        )
        .verify_slice(&decode(&proof.proof, 32)?)
        .map_err(|_| "proof mismatch")
    }
}

#[cfg(test)]
mod proof_tests {
    use super::trust;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    #[test]
    fn canonical_proof_matches_independently_framed_hmac_and_binds_every_field() {
        use hmac::{Hmac, Mac};
        // Runtime-generated material: tests never commit codes or secret keys.
        let key: [u8; 32] = std::array::from_fn(|i| i as u8);
        let fp = format!("sha256:{}", URL_SAFE_NO_PAD.encode([1; 32]));
        let ca = format!("sha256:{}", URL_SAFE_NO_PAD.encode([2; 32]));
        let nonce = URL_SAFE_NO_PAD.encode([3; 32]);
        let server = URL_SAFE_NO_PAD.encode([4; 32]);
        let origin = "https://harness.test";
        let input = format!("plur1bus-pair-v1{fp}{ca}{origin}{nonce}{server}");
        let mut independent = Hmac::<sha2::Sha256>::new_from_slice(&key).unwrap();
        independent.update(input.as_bytes());
        let proof = trust::Proof {
            salt: URL_SAFE_NO_PAD.encode([5; 16]),
            server_nonce: server.clone(),
            proof: URL_SAFE_NO_PAD.encode(independent.finalize().into_bytes()),
            ca_pin: Some(ca),
        };
        assert!(
            proof.proof == "p0ag5cxrdYGhfUK9sAeqbtcG_eX5-Z6d-6n9n8VyXOw",
            "canonical public proof vector mismatch"
        );
        assert!(trust::verify(&key, &fp, origin, &nonce, &proof).is_ok());
        assert!(trust::verify(&key, &fp, "https://other.harness.test", &nonce, &proof).is_err());
        assert!(trust::verify(
            &key,
            &format!("sha256:{}", URL_SAFE_NO_PAD.encode([6; 32])),
            origin,
            &nonce,
            &proof
        )
        .is_err());
        assert!(
            trust::sign(&key, &fp, proof.ca_pin.as_deref(), origin, &nonce, &server) == proof.proof
        );
    }
}
