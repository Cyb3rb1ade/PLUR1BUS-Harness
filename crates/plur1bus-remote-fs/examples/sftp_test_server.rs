//! Test utility only: a loopback SSH/SFTP server rooted at a fixture, stopped by stdin EOF. Never shipped as a service.
#[path = "../tests/support/mod.rs"]
mod support;
use serde::Deserialize;
use std::io::{BufRead, Read, Write};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    root: std::path::PathBuf,
    authorized_public_key: String,
    #[serde(default)]
    read_delay_ms: u64,
}

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let result =
        std::panic::catch_unwind(|| {
            let mut line = Vec::new();
            std::io::stdin()
                .lock()
                .take(16 * 1024 + 1)
                .read_until(b'\n', &mut line)
                .map_err(|_| ())?;
            if line.len() > 16 * 1024 || line.last() != Some(&b'\n') {
                return Err(());
            }
            let config: Config = serde_json::from_slice(&line).map_err(|_| ())?;
            if config.read_delay_ms > 10_000 {
                return Err(());
            }
            let public = russh::keys::PublicKey::from_openssh(&config.authorized_public_key)
                .map_err(|_| ())?;
            let (sender, receiver) = tokio::sync::oneshot::channel();
            std::thread::spawn(move || {
                let mut byte = [0];
                let _ = std::io::stdin().read(&mut byte);
                let _ = sender.send(());
            });
            tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|_| ())?
            .block_on(async {
                let fixture = support::start(
                    config.root, public, std::time::Duration::from_millis(config.read_delay_ms),
                ).await;
                let ready = serde_json::json!({
                    "ip": fixture.ip, "port": fixture.port, "hostKeySha256": fixture.fingerprint,
                });
                writeln!(std::io::stdout(), "{ready}").map_err(|_| ())?;
                std::io::stdout().flush().map_err(|_| ())?;
                let _ = receiver.await;
                drop(fixture);
                Ok::<(), ()>(())
            })
        });
    std::process::exit(if matches!(result, Ok(Ok(()))) { 0 } else { 2 });
}
