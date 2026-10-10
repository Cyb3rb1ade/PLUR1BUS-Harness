//! `plur1bus-attest --probe` | `plur1bus-attest --attest` (request on stdin). See `plur1bus_attest::protocol`.
use std::io::{self, BufRead, Read, Write};

fn main() {
    // The elevated copy the Windows UAC consent path starts: being allowed to start at all is the whole answer.
    if std::env::args().nth(1).as_deref() == Some("--consent-noop") {
        return;
    }
    let platform = plur1bus_attest::platform::native();
    let mode = std::env::args()
        .skip(1)
        .find(|a| a == "--probe" || a == "--attest");
    let line = match mode.as_deref() {
        Some("--probe") => plur1bus_attest::run_probe(platform.as_ref()),
        Some("--attest") => {
            let mut input = String::new();
            // One line, bounded: a peer that never ends its line cannot make the helper read forever (the core kills it at the deadline anyway).
            let _ = io::stdin().lock().take(64 * 1024).read_line(&mut input);
            plur1bus_attest::run_attest(platform.as_ref(), &input)
        }
        _ => {
            eprintln!(
                "usage: plur1bus-attest --probe | --attest   (request: one JSON line on stdin)"
            );
            std::process::exit(2);
        }
    };
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}
