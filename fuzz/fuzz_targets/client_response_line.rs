//! Feeds arbitrary bytes to `plur1bus_rpc::Client` as the core's reply to one call (Unix only). Invariant: `call`
//! returns `Ok` or a typed `RpcError`; no panic, no hang (the read timeout bounds it), memory bounded by `MAX_LINE`.
//! Manual use only, see docs/fuzzing.md.
#![no_main]
use libfuzzer_sys::fuzz_target;
use plur1bus_rpc::{Client, ConnectOptions};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const TOKEN: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
static PAYLOAD: Mutex<Vec<u8>> = Mutex::new(Vec::new());
static ADDR: OnceLock<String> = OnceLock::new();

fn addr() -> &'static str {
    ADDR.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sock");
        let listener = UnixListener::bind(&path).unwrap();
        std::mem::forget(dir);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let mut w = stream.try_clone().unwrap();
                std::thread::spawn(move || {
                    for line in BufReader::new(stream).lines() {
                        let Ok(line) = line else { return };
                        let Ok(msg) = serde_json::from_str::<Value>(&line) else { return };
                        if msg["method"] == "core.auth" {
                            let hello = json!({"contract":"1.4.1","rpc":"1.0.0","instanceId":"i","pid":1});
                            let _ = writeln!(w, "{}", json!({"jsonrpc":"2.0","id":msg["id"],"result":hello}));
                        } else {
                            let _ = w.write_all(&PAYLOAD.lock().unwrap().clone());
                            return; // EOF ends a call that is still waiting
                        }
                    }
                });
            }
        });
        path.to_string_lossy().into()
    })
}

fuzz_target!(|data: &[u8]| {
    *PAYLOAD.lock().unwrap() = data.to_vec();
    let opts = ConnectOptions { call_timeout: Duration::from_secs(2), ..ConnectOptions::default() };
    if let Ok(mut c) = Client::connect(addr(), TOKEN, opts) {
        let _ = c.call("m", json!({}));
    }
});
