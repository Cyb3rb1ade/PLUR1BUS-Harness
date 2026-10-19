mod snapshot;
use plur1bus_desktop_contract::{
    exec::{self, Command},
    scope,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    process,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Scenario {
    commands: Vec<Case>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    argv: Vec<String>,
    exit: i32,
    stdout: Value,
    #[serde(default)]
    stderr: String,
    #[serde(default)]
    stdin: Option<String>,
}

pub fn run(kind: &str) -> ! {
    let argv: Vec<String> = env::args().skip(1).collect();
    // Help explicitly describes this test binary's synthetic contract. It is read-only,
    // including no argv recording or scenario file access during compatibility probes.
    if kind == "plur1bus" {
        if let Some(help) = synthetic_help(&argv.iter().map(String::as_str).collect::<Vec<_>>()) {
            print!("{help}");
            process::exit(0);
        }
    }
    if let Err(error) = record(&argv) {
        fail("E_RECORD", &error.to_string());
    }
    let args: Vec<&str> = argv.iter().map(String::as_str).collect();
    let classified = if kind == "container" {
        None
    } else {
        Some(exec::classify(&args).unwrap_or_else(|| fail("E_ARGV", "unsupported argv")))
    };
    if let Ok(file) = env::var("PLUR1BUS_FAKE_SCENARIO") {
        let scenario = fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Scenario>(&bytes).ok());
        let Some(scenario) = scenario else {
            fail("E_SCENARIO", "invalid scenario file")
        };
        let Some(case) = scenario.commands.into_iter().find(|c| c.argv == argv) else {
            fail("E_ARGV", "unsupported argv in scenario")
        };
        if let Some(expected) = case.stdin {
            let mut actual = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut actual).unwrap();
            if actual != expected {
                fail("E_STDIN", "unexpected stdin")
            }
        }
        if let Some(raw) = case.stdout.as_str() {
            print!("{raw}");
        } else {
            println!("{}", case.stdout);
        }
        eprint!("{}", case.stderr);
        process::exit(case.exit);
    }
    if kind == "container" {
        fail("E_ARGV", "unsupported container argv")
    }
    let result = match classified {
        Some(Command::DaemonStatus) => {
            let mut value: Value =
                serde_json::from_str(include_str!("../fixtures/daemon-status.json")).unwrap();
            if env::var("PLUR1BUS_CONTAINER").as_deref() == Ok("1") {
                value["supervisor"]["process"]["state"] = json!("running");
                value["children"] = json!([{"kind":"core","process":{"state":"ready"}}]);
                value["activity"] = json!({"activeRuns":0});
            }
            value
        }
        Some(Command::FirstAidCheck) => {
            serde_json::from_str(include_str!("../fixtures/firstaid-check.json")).unwrap()
        }
        Some(Command::UserCreate) if env::var("PLUR1BUS_CONTAINER").as_deref() == Ok("1") => {
            let value = mock_call("/__test/owner", json!({}));
            if value["code"] == "E_EXISTS" {
                fail("E_EXISTS", "owner already exists");
            }
            value
        }
        Some(Command::UserCreate) => {
            json!({"schema":"user.create/1","userId":"mock-owner"})
        }
        Some(Command::BundledPair) => pair(true),
        Some(Command::NativePair) => pair(false),
        Some(Command::DeviceRevoke) => mock_call("/__test/revoke", json!({"device_id":args[2]})),
        Some(Command::StateSnapshot) => {
            fail_if("snapshot");
            snapshot::snapshot(
                std::path::Path::new(&args[3]),
                std::path::Path::new(&args[5]),
            )
            .unwrap_or_else(|e| fail("E_SNAPSHOT", &format!("synthetic snapshot failed: {e}")))
        }
        Some(Command::StateVerify) => {
            fail_if("verify");
            snapshot::verify(std::path::Path::new(&args[3])).unwrap_or_else(|e| {
                fail("E_VERIFY", &format!("synthetic verification failed: {e}"))
            })
        }
        Some(Command::StateRestore) => {
            fail_if("restore");
            snapshot::restore(
                std::path::Path::new(&args[3]),
                std::path::Path::new(&args[5]),
            )
            .unwrap_or_else(|e| fail("E_RESTORE", &format!("synthetic restore failed: {e}")))
        }
        Some(Command::AdminMigrate) => {
            fail_if("migrate");
            json!({"schema":"admin.migrate/1","ok":true})
        }
        Some(Command::AdminSmoke) => {
            fail_if("smoke");
            if env::var("PLUR1BUS_STUB_FAIL_SMOKE").as_deref() == Ok("1") {
                fail("E_SMOKE", "synthetic smoke failure");
            }
            json!({"schema":"admin.smoke/1","ok":true,"steps":[{"name":"mock","ok":true,"ms":0}]})
        }
        _ => fail("E_ARGV", "unsupported argv"),
    };
    println!("{result}");
    process::exit(0);
}

fn pair(bundled: bool) -> Value {
    let scopes = if bundled {
        scope::BUNDLED.as_slice()
    } else {
        scope::NATIVE.as_slice()
    };
    mock_call(
        "/__test/pair",
        json!({"scopes":scopes,"grant_key_unlock":bundled}),
    )
}
fn mock_call(path: &str, body: Value) -> Value {
    let origin =
        env::var("PLUR1BUS_FAKE_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:18700".into());
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap();
    let response = client.post(format!("{origin}{path}")).json(&body).send();
    match response.and_then(|r| r.error_for_status()) {
        Ok(r) => r
            .json()
            .unwrap_or_else(|_| fail("E_MOCK", "invalid mock response")),
        Err(_) => fail("E_MOCK", "mock server unavailable"),
    }
}
fn fail_if(step: &str) {
    if env::var("PLUR1BUS_STUB_FAIL_STEP").as_deref() == Ok(step) {
        fail("E_INJECTED", "synthetic failure");
    }
    // Cold snapshot workers have network=none. Only running-harness controls may call the mock.
    if (env::var_os("PLUR1BUS_FAKE_ORIGIN").is_some()
        || (env::var("PLUR1BUS_CONTAINER").as_deref() == Ok("1")
            && matches!(step, "smoke" | "migrate")))
        && mock_call("/__test/failure", json!({"step":step}))["fail"] == true
    {
        fail("E_INJECTED", "upgrade gate failure")
    }
}

fn record(argv: &[String]) -> std::io::Result<()> {
    let path = if let Ok(path) = env::var("PLUR1BUS_FAKE_RECORD") {
        PathBuf::from(path)
    } else if let Ok(root) = env::var("PLUR1BUS_HOME") {
        PathBuf::from(root).join("mock-argv.jsonl")
    } else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    writeln!(
        OpenOptions::new().create(true).append(true).open(path)?,
        "{}",
        json!(argv)
    )
}
fn fail(code: &str, reason: &str) -> ! {
    println!(
        "{}",
        json!({"schema":"error/1","code":code,"reason":reason})
    );
    process::exit(2)
}

/// Exact, test-only clap-shaped help for the documented synthetic desktop protocol.
pub fn synthetic_help(argv: &[&str]) -> Option<&'static str> {
    match argv {
        ["--help"]=>Some("Synthetic desktop test CLI\n\nCommands:\n  state  Cold state helpers\n  admin  Administration\n\nOptions:\n  --json  JSON output\n"),
        ["state","--help"]=>Some("Synthetic state helpers\n\nCommands:\n  snapshot  Snapshot\n  verify  Verify\n  restore  Restore\n\nOptions:\n  --json  JSON output\n"),
        ["admin","--help"]=>Some("Synthetic administration\n\nCommands:\n  migrate  Migrate\n  smoke  Smoke\n\nOptions:\n  --json  JSON output\n"),
        ["state","snapshot"|"restore","--help"]=>Some("Options:\n  --src <PATH>  Source\n  --dst <PATH>  Destination\n  --json  JSON output\n"),
        ["state","verify","--help"]=>Some("Options:\n  --dir <PATH>  Snapshot directory\n  --json  JSON output\n"),
        ["admin","migrate","--help"]=>Some("Options:\n  --from <VERSION>  From\n  --to <VERSION>  To\n  --yes  Confirm\n  --json  JSON output\n"),
        ["admin","smoke","--help"]=>Some("Options:\n  --json  JSON output\n"),
        _=>None,
    }
}
