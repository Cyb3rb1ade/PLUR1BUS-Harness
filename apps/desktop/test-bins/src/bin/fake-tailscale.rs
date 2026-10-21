//! Fake `tailscale` CLI for the desktop's Tailscale exec tests (transport choice package T3). It reads its scenario
//! from `fake-tailscale.scenario` next to its own executable, never from the environment: the real exec clears the
//! environment, and a scenario taken from it would be a seam the exec under test could not have.
//!
//! Scenarios: `running`, `needs-login`, `stopped` (a synthetic status document), `exit1` (stderr text, exit 1),
//! `sleep10` (no output for 10 s), `huge` (9 MiB on stdout), `garbage` (not JSON) and `env` (the names of the
//! environment variables and the argv it received, as JSON; names only, never values).
use std::io::Write;
use std::time::Duration;

const RUNNING: &str = r#"{"BackendState":"Running","Self":{"DNSName":"workstation.example.ts.net.","TailscaleIPs":["100.90.0.1"]},"MagicDNSSuffix":"example.ts.net","Peer":{"peer-nas":{"DNSName":"nas.example.ts.net.","HostName":"nas-host","TailscaleIPs":["100.101.102.103"],"Online":true}}}"#;

fn main() {
    let scenario = std::env::current_exe()
        .ok()
        .and_then(|exe| std::fs::read_to_string(exe.with_file_name("fake-tailscale.scenario")).ok())
        .unwrap_or_default();
    let mut out = std::io::stdout().lock();
    match scenario.trim() {
        "running" => {
            let _ = out.write_all(RUNNING.as_bytes());
        }
        "needs-login" => {
            let _ = out.write_all(br#"{"BackendState":"NeedsLogin","Peer":null}"#);
        }
        "stopped" => {
            let _ = out.write_all(br#"{"BackendState":"Stopped"}"#);
        }
        "exit1" => {
            eprintln!("failed to connect to local tailscaled; it doesn't appear to be running");
            std::process::exit(1);
        }
        "sleep10" => {
            std::thread::sleep(Duration::from_secs(10));
            let _ = out.write_all(RUNNING.as_bytes());
        }
        "huge" => {
            let chunk = vec![b' '; 64 * 1024];
            for _ in 0..(9 * 16) {
                if out.write_all(&chunk).is_err() {
                    std::process::exit(3);
                }
            }
            let _ = out.write_all(RUNNING.as_bytes());
        }
        "garbage" => {
            let _ = out.write_all(b"this is not a status document");
        }
        "env" => {
            let mut names: Vec<String> = std::env::vars_os()
                .map(|(k, _)| k.to_string_lossy().into_owned())
                .collect();
            names.sort();
            let argv0 = std::env::args_os()
                .next()
                .map(|a| a.to_string_lossy().into_owned());
            let argv: Vec<String> = std::env::args().skip(1).collect();
            let doc = serde_json::json!({ "env": names, "argv0": argv0, "argv": argv });
            let _ = out.write_all(doc.to_string().as_bytes());
        }
        _ => {
            eprintln!("fake-tailscale: no scenario");
            std::process::exit(2);
        }
    }
    let _ = out.flush();
}
