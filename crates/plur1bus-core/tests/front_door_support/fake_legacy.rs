//! A fake legacy core for the front door's tests: the link protocol of the TypeScript core behind the front door
//! (`--behind-front-door`), in Rust, so `cargo test` needs no Node. It checks the link credential and the caller kind like
//! module-api's `RpcServer` with `frontDoorToken`, re-verifies the client credentials it is given, and echoes every other
//! request with the identity it bound to the link, so the tests can see exactly what the front door forwarded.
//!
//! Started by the front door as `<this test binary> fake-legacy --home <h> --behind-front-door <mode> --lifeline stdin
//! --instance <uuid>` (the tests set `PLUR1BUS_NODE` to this binary and `PLUR1BUS_CORE_JS` to `fake-legacy`).
//! `FAKE_LEGACY_MODE`: `exit:<n>` exits at once with `n`; `bad-ready` prints a ready line naming another pid; `slow-stop`
//! takes 300 ms to stop after `core.shutdown`.
use plur1bus_rpc::server_transport::{Accepted, Listener};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Writer = Arc<Mutex<Box<dyn Write + Send>>>;
type Subs = Mutex<HashMap<u64, (Writer, Option<Vec<String>>)>>;

struct Legacy {
    home: PathBuf,
    instance: String,
    owner: String,
    api: String,
    link: String,
    subs: Subs,
    next: AtomicU64,
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn send(w: &Writer, v: &Value) {
    let mut w = w.lock().unwrap();
    let _ = writeln!(w, "{v}");
    let _ = w.flush();
}

fn error(id: &Value, code: &str, reason: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":reason,"data":{"error":code,"reason":reason}}})
}

/// The status the legacy core reports about itself (its own pid and instance: the front door must replace them).
fn status(l: &Legacy) -> Value {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../packages/rpc-schema/fixtures/methods/core.status.json"
    ))
    .unwrap();
    let mut s = fixture["result"].clone();
    s["pid"] = json!(std::process::id());
    s["instanceId"] = json!(l.instance);
    s["contract"] = json!("9.9.9");
    s["rpc"] = json!(plur1bus_rpc::RPC_VERSION);
    s["process"] = json!({"state":"ready","since":1});
    s
}

/// The fake's main.
pub fn run(args: &[String]) -> ! {
    let mode = std::env::var("FAKE_LEGACY_MODE").unwrap_or_default();
    if let Some(code) = mode.strip_prefix("exit:") {
        std::process::exit(code.parse().unwrap());
    }
    let arg = |name: &str| {
        let i = args.iter().position(|a| a == name).unwrap();
        args[i + 1].clone()
    };
    assert_eq!(arg("--lifeline"), "stdin");
    let home = PathBuf::from(arg("--home"));
    let run = home.join("run");
    let legacy = Arc::new(Legacy {
        instance: arg("--instance"),
        owner: read(&run.join("core.token")),
        api: read(&run.join("api-delegation.token")),
        link: read(&run.join("core-legacy.token")),
        home: home.clone(),
        subs: Mutex::new(HashMap::new()),
        next: AtomicU64::new(1),
    });
    std::fs::write(run.join("core-legacy.mode"), arg("--behind-front-door")).unwrap();
    std::fs::write(
        run.join("core-legacy.pid"),
        format!("{} {}\n", std::process::id(), arg("--instance")),
    )
    .unwrap();
    let address = plur1bus_core::run_files::unit_address(&home, "core-legacy", cfg!(windows));
    if !cfg!(windows) {
        let _ = std::fs::remove_file(&address);
    }
    let listener = Listener::bind(&address).unwrap();
    let pid = if mode == "bad-ready" {
        1
    } else {
        std::process::id()
    };
    let mut out = std::io::stdout();
    writeln!(
        out,
        "{}",
        json!({"ready": true, "address": address, "pid": pid})
    )
    .unwrap();
    out.flush().unwrap();
    // The lifeline: the front door holds stdin; behind a front door there is no grace.
    std::thread::spawn(|| {
        let _ = std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink());
        std::process::exit(0);
    });
    loop {
        if let Ok(Some(conn)) = listener.accept_timeout(Duration::from_millis(50)) {
            let l = legacy.clone();
            let mode = mode.clone();
            std::thread::spawn(move || serve(&l, conn, &mode));
        }
    }
}

/// What the client's credentials prove here (the TypeScript checks, reduced to what the tests use).
fn proved(l: &Legacy, msg: &Value) -> Result<&'static str, &'static str> {
    let p = &msg["params"];
    let token = p["token"].as_str().unwrap_or("");
    if p.get("engine").is_some() {
        let engine = read(&l.home.join("run/engine.token"));
        return if p["engine"]["token"] == json!(engine) && token == engine {
            Ok("engine")
        } else {
            Err("engine-delegation")
        };
    }
    if token == l.owner {
        let delegation = msg.get("api").or_else(|| p.get("api"));
        return match delegation {
            None => Ok("owner"),
            Some(d) if d["token"].as_str() == Some(l.api.as_str()) => Ok("api"),
            Some(_) => Err("api-delegation"),
        };
    }
    if token == "c".repeat(64) {
        Ok("client")
    } else {
        Err("client-token")
    }
}

fn serve(l: &Arc<Legacy>, conn: Accepted, mode: &str) {
    let Accepted {
        reader,
        writer,
        closer,
        ..
    } = conn;
    let writer: Writer = Arc::new(Mutex::new(writer));
    let mut reader = BufReader::new(reader);
    let mut caller: Option<&'static str> = None;
    let conn_id = l.next.fetch_add(1, Ordering::Relaxed);
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            send(
                &writer,
                &json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error","data":{"error":"E_INVALID_PARAMS","reason":"parse-error"}}}),
            );
            continue;
        };
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let method = msg["method"].as_str().unwrap_or("").to_owned();
        if method == "core.auth" {
            if msg["params"]["frontDoor"]["token"].as_str() != Some(l.link.as_str()) {
                send(&writer, &error(&id, "E_UNAUTHORIZED", "front-door-link"));
                break;
            }
            let who = match proved(l, &msg) {
                Ok(who) => who,
                Err(reason) => {
                    send(&writer, &error(&id, "E_UNAUTHORIZED", reason));
                    break;
                }
            };
            if msg["params"]["frontDoor"]["caller"].as_str() != Some(who) {
                send(&writer, &error(&id, "E_UNAUTHORIZED", "front-door-link"));
                break;
            }
            caller = Some(who);
            let mut features = vec!["events.harness"];
            if who == "engine" {
                features.push("engine");
            }
            let mut hello = json!({"contract":"9.9.9","rpc":plur1bus_rpc::RPC_VERSION,"instanceId":l.instance,
                "pid":std::process::id(),"capabilities":plur1bus_rpc::capabilities("core", &features)});
            if who == "api" {
                let d = msg.get("api").unwrap_or(&msg["params"]["api"]);
                hello["apiPrincipal"] = d.get("principal").cloned().unwrap_or(Value::Null);
            }
            send(&writer, &json!({"jsonrpc":"2.0","id":id,"result":hello}));
            continue;
        }
        let Some(who) = caller else {
            send(&writer, &error(&id, "E_UNAUTHORIZED", "auth-required"));
            continue;
        };
        match method.as_str() {
            "core.status" => send(
                &writer,
                &json!({"jsonrpc":"2.0","id":id,"result":status(l)}),
            ),
            "core.adopt" => {
                let expected = read(&l.home.join("run/supervisor.token"));
                let given = msg["params"]["nonce"].as_str().unwrap_or("").to_lowercase();
                if expected.len() == 64 && given == expected.to_lowercase() {
                    send(
                        &writer,
                        &json!({"jsonrpc":"2.0","id":id,"result":{"status":status(l)}}),
                    );
                } else {
                    send(&writer, &error(&id, "E_UNAUTHORIZED", "adopt-nonce"));
                }
            }
            "core.shutdown" => {
                send(
                    &writer,
                    &json!({"jsonrpc":"2.0","id":id,"result":{"accepted":true}}),
                );
                let slow = mode == "slow-stop";
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(if slow { 300 } else { 50 }));
                    std::process::exit(0);
                });
            }
            "events.subscribe" => {
                let sid = l.next.fetch_add(1, Ordering::Relaxed);
                let names = msg["params"]["names"].as_array().map(|n| {
                    n.iter()
                        .filter_map(|x| x.as_str().map(str::to_owned))
                        .collect()
                });
                l.subs
                    .lock()
                    .unwrap()
                    .insert(conn_id * 1000 + sid, (writer.clone(), names));
                send(
                    &writer,
                    &json!({"jsonrpc":"2.0","id":id,"result":{"subscriptionId":format!("sub-{sid}")}}),
                );
            }
            "agent.list" => {
                send(
                    &writer,
                    &json!({"jsonrpc":"2.0","id":id,"result":{"agents":[]}}),
                );
                for (w, names) in l.subs.lock().unwrap().values() {
                    for (name, params) in [
                        (
                            "agent.activity",
                            json!({"agentId":"bernd","activity":{"state":"idle","since":1}}),
                        ),
                        (
                            "core.state",
                            json!({"process":{"state":"degraded","since":1}}),
                        ),
                    ] {
                        if names
                            .as_ref()
                            .is_none_or(|n: &Vec<String>| n.iter().any(|x| x == name))
                        {
                            send(w, &json!({"jsonrpc":"2.0","method":name,"params":params}));
                        }
                    }
                }
            }
            "fake.flood" => {
                let big = "x".repeat(1024 * 1024);
                for _ in 0..40 {
                    send(
                        &writer,
                        &json!({"jsonrpc":"2.0","method":"agent.activity","params":{"blob":big}}),
                    );
                }
                send(
                    &writer,
                    &json!({"jsonrpc":"2.0","id":id,"result":{"flooded":true}}),
                );
            }
            _ => send(
                &writer,
                &json!({"jsonrpc":"2.0","id":id,"result":{"echo":msg,"line":line.trim_end_matches('\n'),"caller":who}}),
            ),
        }
    }
    closer();
}
