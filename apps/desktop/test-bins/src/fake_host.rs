//! Deterministic helper fixture. Output contains variable names only, never values.
use std::io::{BufRead, Write};
fn main() {
    let mut stdout = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else {
            return;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            return;
        };
        match v["method"].as_str() {
            Some("hello") => {
                writeln!(stdout, "{{\"version\":\"1\",\"capabilities\":[]}}").unwrap();
            }
            Some("os.permissions.status") => {
                writeln!(stdout, "{{\"grants\":[]}}").unwrap();
                stdout.flush().unwrap();
                return;
            }
            Some("environment") => {
                serde_json::to_writer(
                    &mut stdout,
                    &std::env::vars().map(|(k, _)| k).collect::<Vec<_>>(),
                )
                .unwrap();
                writeln!(stdout).unwrap();
            }
            _ => return,
        };
        stdout.flush().unwrap();
    }
}
