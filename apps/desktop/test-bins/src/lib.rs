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
            serde_json::from_str(include_str!("../fixtures/daemon-status.json")).unwrap()
        }
        Some(Command::FirstAidCheck) => {
            serde_json::from_str(include_str!("../fixtures/firstaid-check.json")).unwrap()
        }
        Some(Command::UserCreate) => {
            json!({"schema":"user.create/1","userId":"mock-owner"})
        }
        Some(Command::BundledPair) => pair(true),
        Some(Command::NativePair) => pair(false),
        Some(Command::DeviceRevoke) => mock_call("/__test/revoke", json!({"device_id":args[2]})),
        Some(Command::StateSnapshot) => {
            fail_if("snapshot");
            json!({"schema":"state.snapshot/1","from":"mock","createdAt":"2026-01-01T00:00:00Z","fileCount":1,"bytes":1,"manifestSha256":"mock"})
        }
        Some(Command::StateVerify) => {
            fail_if("verify");
            json!({"schema":"state.verify/1","ok":true,"mismatches":[]})
        }
        Some(Command::StateRestore) => {
            fail_if("restore");
            json!({"schema":"state.restore/1","ok":true})
        }
        Some(Command::AdminMigrate) => {
            fail_if("migrate");
            json!({"schema":"admin.migrate/1","ok":true})
        }
        Some(Command::AdminSmoke) => {
            fail_if("smoke");
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
    if mock_call("/__test/failure", json!({"step":step}))["fail"] == true {
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
