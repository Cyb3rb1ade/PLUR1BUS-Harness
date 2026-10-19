//! S0 interoperability probe. Reads public fixture metadata only; the external
//! OpenSSH agent owns the RSA private key and performs every private operation.
#[cfg(all(feature = "ssh", unix))]
#[path = "../src/direct_key_policy.rs"]
mod direct_key_policy;

#[cfg(all(feature = "ssh", unix))]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use std::sync::Arc;
    use std::time::Duration;

    use russh::keys::{agent::client::AgentClient, HashAlg, PublicKey, PublicKeyOrCertificate};
    use russh::{client, ChannelMsg, Disconnect};

    struct Pinned(PublicKey);
    impl client::Handler for Pinned {
        type Error = russh::Error;
        async fn check_server_key(
            &mut self,
            offered: &PublicKeyOrCertificate,
        ) -> Result<bool, Self::Error> {
            Ok(
                matches!(offered, PublicKeyOrCertificate::PublicKey { key, .. } if key.key_data() == self.0.key_data()),
            )
        }
    }

    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 5 {
        return Err(
            "expected port, user, host public key, identity public key, isolated agent socket"
                .into(),
        );
    }
    let port: u16 = args[0].parse()?;
    if port < 1024 {
        return Err("fixture must use an unprivileged port".into());
    }
    let host = PublicKey::from_openssh(&std::fs::read_to_string(&args[2])?)?;
    let identity = PublicKey::from_openssh(&std::fs::read_to_string(&args[3])?)?;
    if !matches!(identity.algorithm(), russh::keys::Algorithm::Rsa { .. }) {
        return Err("fixture identity must be RSA".into());
    }
    assert_eq!(
        direct_key_policy::validate(&identity.algorithm())
            .unwrap_err()
            .reason(),
        "rsa-direct-unsupported"
    );

    tokio::time::timeout(Duration::from_secs(30), async {
        let mut agent = AgentClient::connect_uds(&args[4]).await?;
        let identities = agent.request_identities().await?;
        if identities.len() != 1 || identities[0].public_key().key_data() != identity.key_data() {
            return Err("isolated agent must hold exactly the expected public identity".into());
        }
        for hash in [HashAlg::Sha256, HashAlg::Sha512] {
            let config = Arc::new(client::Config {
                nodelay: true,
                inactivity_timeout: Some(Duration::from_secs(10)),
                ..Default::default()
            });
            let mut connection =
                client::connect(config, ("127.0.0.1", port), Pinned(host.clone())).await?;
            let result = connection
                .authenticate_publickey_with(&args[1], identity.clone(), Some(hash), &mut agent)
                .await?;
            if !result.success() {
                return Err("OpenSSH rejected the RSA agent signature".into());
            }
            // A real, post-authentication command, fixed by the research probe.
            let mut channel = connection.channel_open_session().await?;
            channel.exec(true, "printf rsa-agent-ok").await?;
            let (mut output, mut exit) = (Vec::new(), None);
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } if output.len() + data.len() <= 1024 => {
                        output.extend_from_slice(&data);
                    }
                    ChannelMsg::Data { .. } => return Err("oversized fixture output".into()),
                    ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            if output != b"rsa-agent-ok" || exit != Some(0) {
                return Err("authenticated OpenSSH exec failed".into());
            }
            connection
                .disconnect(Disconnect::ByApplication, "fixture done", "")
                .await?;
            println!("RSA agent login and authenticated exec: {hash:?} PASS");
        }
        Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
    })
    .await??;
    Ok(())
}

#[cfg(not(all(feature = "ssh", unix)))]
fn main() {
    eprintln!("The OpenSSH Unix-socket S0 probe requires Unix and the ssh feature");
    std::process::exit(2);
}
