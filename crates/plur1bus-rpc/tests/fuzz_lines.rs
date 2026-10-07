//! E1: seeded, deterministic fuzz of the client's line protocol and JSON parser. A fake core answers the handshake and
//! then replies to the first call with hostile bytes. Invariant: `Client::call` returns `Ok` or a typed `RpcError`;
//! it never panics and never hangs. Seed and case count: `PLUR1BUS_FUZZ_SEED`, `PLUR1BUS_FUZZ_CASES`.
#![cfg(unix)]
use plur1bus_rpc::client::MAX_LINE;
use plur1bus_rpc::{Client, ConnectOptions, RpcError};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

const TOKEN: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn bytes(&mut self, n: usize) -> Vec<u8> {
        (0..n).map(|_| self.next() as u8).collect()
    }
}

fn env_u64(k: &str, d: u64) -> u64 {
    std::env::var(k)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(d)
}

/// A fake core: answers `core.auth`, then writes `payload(id)` for the first other request. `close` ends the
/// connection afterwards (EOF); otherwise it holds the connection open for `hold`.
fn serve(payload: impl Fn(u64) -> Vec<u8> + Send + 'static, close: bool) -> String {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sock");
    let listener = UnixListener::bind(&path).unwrap();
    std::mem::forget(dir);
    std::thread::spawn(move || {
        let Ok((stream, _)) = listener.accept() else {
            return;
        };
        let mut w = stream.try_clone().unwrap();
        let r = BufReader::new(stream);
        for line in r.lines() {
            let Ok(line) = line else { return };
            let msg: Value = serde_json::from_str(&line).unwrap();
            if msg["method"] == "core.auth" {
                let hello = json!({"contract":"1.4.1","rpc":"1.0.0","instanceId":"i","pid":1});
                let _ = writeln!(
                    w,
                    "{}",
                    json!({"jsonrpc":"2.0","id":msg["id"],"result":hello})
                );
                continue;
            }
            let _ = w.write_all(&payload(msg["id"].as_u64().unwrap()));
            let _ = w.flush();
            if close {
                return;
            }
            std::thread::sleep(Duration::from_secs(5));
            return;
        }
    });
    path.to_string_lossy().into()
}

fn opts() -> ConnectOptions {
    ConnectOptions {
        call_timeout: Duration::from_millis(1500),
        ..ConnectOptions::default()
    }
}

/// Runs one call against hostile bytes. Any `Ok`/`Err(RpcError)` passes; a panic fails the test.
fn probe(payload: Vec<u8>) -> Result<Value, RpcError> {
    // Payloads are written for id 1; the server rewrites the literal `"id":1` to the id of the call actually made.
    let addr = serve(
        move |id| {
            let t = String::from_utf8_lossy(&payload).into_owned();
            if payload.is_ascii() || std::str::from_utf8(&payload).is_ok() {
                t.replace("\"id\":1", &format!("\"id\":{id}")).into_bytes()
            } else {
                payload.clone()
            }
        },
        true,
    );
    let mut c = Client::connect(&addr, TOKEN, opts()).unwrap();
    c.call("m", json!({}))
}

fn nl(mut v: Vec<u8>) -> Vec<u8> {
    v.push(b'\n');
    v
}

fn ok_or_typed(r: &Result<Value, RpcError>) {
    // Exhaustive on purpose: a new RpcError variant must be considered here.
    match r {
        Ok(_)
        | Err(RpcError::Protocol(_))
        | Err(RpcError::Unavailable { .. })
        | Err(RpcError::Call { .. }) => {}
        #[allow(unreachable_patterns)]
        Err(_) => {}
    }
}

fn generate(rng: &mut Rng, id: u64) -> Vec<u8> {
    match rng.below(10) {
        0 => {
            let n = rng.below(300);
            nl(rng.bytes(n))
        } // random bytes, usually invalid UTF-8 / JSON
        1 => {
            // valid JSON cut off inside a multi-byte sequence
            let full = format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":\"h\u{e9}\u{1F600}\"}}");
            let cut = full.len() - 3 - rng.below(3);
            nl(full.as_bytes()[..cut].to_vec())
        }
        2 => {
            // nesting far past serde_json's recursion limit (128)
            let d = 100 + rng.below(50_000);
            let mut v = format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":").into_bytes();
            let (open, close) = if rng.below(2) == 0 { (b'[', b']') } else { (b'{', b'}') };
            for _ in 0..d {
                v.push(open);
                if open == b'{' {
                    v.extend_from_slice(b"\"a\":");
                }
            }
            v.push(b'0');
            v.extend(std::iter::repeat_n(close, d));
            v.push(b'}');
            nl(v)
        }
        3 => nl(format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"id\":{},\"result\":1,\"result\":2}}", rng.below(5)).into_bytes()),
        4 => {
            let big = "9".repeat(1 + rng.below(2000));
            let exp = format!("1e{}", rng.below(999_999));
            let pick = [big.clone(), exp, format!("-{big}"), format!("{big}.{big}")];
            let n = &pick[rng.below(pick.len())];
            let at_id = rng.below(2) == 0;
            nl(if at_id {
                format!("{{\"jsonrpc\":\"2.0\",\"id\":{n},\"result\":1}}")
            } else {
                format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{n}}}")
            }
            .into_bytes())
        }
        5 => nl(format!("[{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":1}},{{\"jsonrpc\":\"2.0\",\"id\":{id},\"error\":{{\"code\":-1,\"message\":\"x\"}}}}]").into_bytes()),
        6 => nl(b"{\"jsonrpc\":\"2.0\",\"result\":1}".to_vec()), // response without id
        7 => nl(format!("{{\"jsonrpc\":\"2.0\",\"id\":{id}}}").into_bytes()),
        8 => {
            // blank lines, a lone CR, then a sane answer: must still resolve
            nl(format!("\n\r\n{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{{}}}}").into_bytes())
        }
        _ => {
            // a valid answer with random fields in error.data
            let junk: String = (0..rng.below(20)).map(|_| char::from(b'a' + rng.below(26) as u8)).collect();
            nl(json!({"jsonrpc":"2.0","id":id,"error":{"code":rng.below(100) as i64 - 50,"message":junk.clone(),"data":{"error":junk,"ids":{"a":1,"b":"c"},"ext":[1]}}}).to_string().into_bytes())
        }
    }
}

#[test]
fn hostile_response_lines_never_panic_and_always_answer_typed() {
    let seed = env_u64("PLUR1BUS_FUZZ_SEED", 0xE1_F0_22);
    let cases = env_u64("PLUR1BUS_FUZZ_CASES", 150);
    eprintln!("fuzz seed={seed} cases={cases}");
    let mut rng = Rng(seed);
    for i in 0..cases {
        // Generated for id 1; `probe` rewrites it to the real call id.
        let payload = generate(&mut rng, 1);
        let r = probe(payload.clone());
        ok_or_typed(&r);
        if let Err(RpcError::Unavailable { reason, .. }) = &r {
            assert!(!reason.is_empty(), "case {i} seed {seed}");
        }
    }
}

#[test]
fn bad_shapes_resolve_to_the_expected_error_class() {
    let id = 1;
    // truncated UTF-8 / not JSON: complete line -> Protocol, and the client stays usable
    assert!(matches!(
        probe(nl(vec![b'{', 0xe2, 0x82])),
        Err(RpcError::Protocol(_))
    ));
    // nesting past the parser's limit -> Protocol (no stack overflow)
    let deep = format!("{}0{}", "[".repeat(200_000), "]".repeat(200_000));
    let line = format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{deep}}}");
    assert!(matches!(
        probe(nl(line.into_bytes())),
        Err(RpcError::Protocol(_))
    ));
    // duplicate keys: last one wins, still a typed outcome
    let dup = format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":1,\"result\":2}}");
    assert_eq!(probe(nl(dup.into_bytes())).unwrap(), json!(2));
    // a huge number as result is a value, not a crash
    let huge = format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{}}}",
        "9".repeat(5000)
    );
    ok_or_typed(&probe(nl(huge.into_bytes())));
    // a response without id is a notification: skipped, then EOF -> Unavailable(closed)
    match probe(nl(b"{\"jsonrpc\":\"2.0\",\"result\":1}".to_vec())) {
        Err(RpcError::Unavailable { reason, .. }) => assert_eq!(reason, "closed"),
        other => panic!("{other:?}"),
    }
    // a batch response is not an object with an id: the client sent no batch, so it is skipped the same way
    match probe(nl(format!(
        "[{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":1}}]"
    )
    .into_bytes()))
    {
        Err(RpcError::Unavailable { reason, .. }) => assert_eq!(reason, "closed"),
        other => panic!("{other:?}"),
    }
    // EOF in the middle of a line
    assert!(matches!(
        probe(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"res".to_vec()),
        Err(RpcError::Unavailable { .. })
    ));
}

fn line_of(len: usize) -> Vec<u8> {
    let prefix = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"s\":\"";
    let suffix = "\"}}";
    let mut l = prefix.as_bytes().to_vec();
    l.extend(std::iter::repeat_n(b'x', len - prefix.len() - suffix.len()));
    l.extend_from_slice(suffix.as_bytes());
    nl(l)
}

#[test]
fn the_4_mib_limit_is_exact() {
    assert_eq!(MAX_LINE, 4 * 1024 * 1024);
    assert!(probe(line_of(MAX_LINE)).is_ok());
    match probe(line_of(MAX_LINE + 1)) {
        Err(RpcError::Protocol(m)) => assert_eq!(m, "line too long"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn an_endless_line_is_not_buffered_beyond_the_limit() {
    let written = Arc::new(AtomicUsize::new(0));
    let w = written.clone();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let t = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut out = stream.try_clone().unwrap();
        for line in BufReader::new(stream).lines() {
            let msg: Value = serde_json::from_str(&line.unwrap()).unwrap();
            if msg["method"] == "core.auth" {
                let hello = json!({"contract":"1.4.1","rpc":"1.0.0","instanceId":"i","pid":1});
                writeln!(
                    out,
                    "{}",
                    json!({"jsonrpc":"2.0","id":msg["id"],"result":hello})
                )
                .unwrap();
                continue;
            }
            // 64 MiB without a newline; once the client stops reading, the write times out.
            let _ = out.set_write_timeout(Some(Duration::from_millis(300)));
            let chunk = vec![b'a'; 64 * 1024];
            for _ in 0..1024 {
                match out.write(&chunk) {
                    Ok(n) => {
                        w.fetch_add(n, Ordering::SeqCst);
                    }
                    Err(_) => break,
                }
            }
            return;
        }
    });
    let mut c = Client::connect(path.to_str().unwrap(), TOKEN, opts()).unwrap();
    assert!(matches!(c.call("m", json!({})), Err(RpcError::Protocol(m)) if m == "line too long"));
    assert!(c.is_poisoned());
    t.join().unwrap();
    // The client consumed MAX_LINE + 1 (+ one BufReader fill); the rest is socket buffer, far below the 64 MiB offered.
    let n = written.load(Ordering::SeqCst);
    assert!(
        n < MAX_LINE + 16 * 1024 * 1024,
        "server wrote {n} bytes before the client stopped reading"
    );
    // and a poisoned client refuses further calls without touching the stream
    assert!(
        matches!(c.call("m", json!({})), Err(RpcError::Unavailable { reason, .. }) if reason == "poisoned")
    );
}
