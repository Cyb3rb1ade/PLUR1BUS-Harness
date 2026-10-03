//! Rust-only pairing and native process restart driver. JavaScript never sees credentials.
use plur1bus_desktop::{client::HarnessClient, connections::Origin};
use plur1bus_mock_harness::{MockHarness, MockOptions};
use serde_json::{json, Value};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ChildInput<'a> {
    origin: &'a str,
    installation_id: &'a str,
    device_id: &'a str,
    token: &'a str,
    foreign_origin: &'a str,
}
fn main() {
    const { assert!(cfg!(debug_assertions), "debug-only fixture") };
    let artifacts = PathBuf::from(std::env::args_os().nth(1).expect("artifact directory"));
    std::fs::create_dir_all(&artifacts).unwrap();
    let scratch = tempfile::Builder::new()
        .prefix("wp05-native-session-")
        .tempdir()
        .unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let m = runtime
        .block_on(MockHarness::start(MockOptions {
            test_control: true,
            ..Default::default()
        }))
        .unwrap();
    let client = HarnessClient::new(Origin::parse(&m.origin).unwrap(), None);
    let credential = runtime
        .block_on(client.redeem(&m.control.create_pair_code(), "Native fixture"))
        .unwrap();
    let sensor = runtime
        .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
        .unwrap();
    let foreign = format!("http://{}", sensor.local_addr().unwrap());
    let hits = Arc::new(AtomicUsize::new(0));
    let recorded = hits.clone();
    runtime.spawn(async move {
        let app = axum::Router::new().fallback(axum::routing::any(move || {
            let hits = recorded.clone();
            async move {
                hits.fetch_add(1, Ordering::SeqCst);
                "foreign"
            }
        }));
        axum::serve(sensor, app).await.unwrap();
    });
    let mut reports = Vec::new();
    let mut tickets = Vec::new();
    for phase in ["first", "restart"] {
        m.control.reject_browser_tickets(false);
        let phase_root = scratch.path().join(phase);
        std::fs::create_dir_all(&phase_root).unwrap();
        let result = phase_root.join("result.json");
        let home = phase_root.join("home");
        let config = phase_root.join("config");
        let cache = phase_root.join("cache");
        let data = phase_root.join("data");
        let temp = phase_root.join("tmp");
        for d in [&home, &config, &cache, &data, &temp] {
            std::fs::create_dir_all(d).unwrap();
        }
        let prefs = if phase == "first" {
            json!({"theme":"dark","locale":"de"})
        } else {
            json!({"theme":"light","locale":"en"})
        };
        let settings_dir = config.join("app.plur1bus.desktop");
        std::fs::create_dir_all(&settings_dir).unwrap();
        std::fs::write(
            settings_dir.join("settings.json"),
            serde_json::to_vec(&prefs).unwrap(),
        )
        .unwrap();
        let exe = std::env::current_exe()
            .unwrap()
            .with_file_name(if cfg!(windows) {
                "production_spa.exe"
            } else {
                "production_spa"
            });
        let mut child = Command::new(exe)
            .arg(&result)
            .current_dir(&phase_root)
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("CFFIXED_USER_HOME", &home)
            .env("APPDATA", &config)
            .env("LOCALAPPDATA", &cache)
            .env("XDG_CONFIG_HOME", &config)
            .env("XDG_CACHE_HOME", &cache)
            .env("XDG_DATA_HOME", &data)
            .env("TMPDIR", &temp)
            .env("TEMP", &temp)
            .env("TMP", &temp)
            .env(
                "PLUR1BUS_DESKTOP_CONFIG_DIR",
                config.join("app.plur1bus.desktop"),
            )
            .env("WP05_NATIVE_SCRATCH", &phase_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("native child");
        let input = zeroize::Zeroizing::new(
            serde_json::to_vec(&ChildInput {
                origin: &m.origin,
                installation_id: &m.installation_id,
                device_id: &credential.device_id,
                token: credential.token.expose(),
                foreign_origin: &foreign,
            })
            .unwrap(),
        );
        child.stdin.take().unwrap().write_all(&input).unwrap();
        drop(input);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("owned native child timed out; raw output discarded");
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        };
        let milestone =
            std::fs::read_to_string(result.with_extension("progress")).unwrap_or_default();
        let milestone = if [
            "starting",
            "session-ready",
            "proxy-obtained",
            "secrets-registering",
            "secrets-registered",
            "cookies-checked",
            "benchmark-start",
            "benchmark-done",
            "second-window-opened",
            "negative-checks",
            "other-window-construction-start",
            "other-window-construction-complete",
            "other-window-construction-failed",
            "other-window-wait-start",
            "other-window-wait-channel-closed",
            "other-window-wait-timeout",
            "negative-done",
            "replay",
            "error-page",
            "retire",
            "audit",
        ]
        .contains(&milestone.as_str())
        {
            milestone
        } else {
            "unknown".into()
        };
        if !status.success() {
            std::fs::write(artifacts.join(format!("{phase}.json")),serde_json::to_vec_pretty(&json!({"result":"failed","milestone":milestone,"exitCode":status.code(),"rawChildOutputDiscarded":true})).unwrap()).unwrap();
        }
        assert!(
            status.success(),
            "native child failed at {milestone} with code {:?}; raw output discarded",
            status.code()
        );
        let bytes = std::fs::read(&result).unwrap();
        assert!(
            !bytes
                .windows(credential.token.expose().len())
                .any(|v| v == credential.token.expose().as_bytes()),
            "credential in public report"
        );
        let report: Value = serde_json::from_slice(&bytes).unwrap();
        std::fs::write(
            artifacts.join(format!("{phase}.json")),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
        assert_eq!(report["sessions"].as_array().unwrap().len(), 2);
        for session in report["sessions"].as_array().unwrap() {
            for key in [
                "loggedIn",
                "fragmentGone",
                "cookieStoreEmpty",
                "shellInfo",
                "onlyShellInfo",
                "csrf",
                "sseUnbuffered",
                "sseSurvivesTenSeconds",
                "websocket",
                "selfAsset",
                "inlineCspBlocked",
                "download10MiB",
                "foreignRedirectBlocked",
                "foreignFetchBlocked",
                "foreignImageBlocked",
                "foreignWebsocketBlocked",
            ] {
                assert_eq!(session["browser"][key], true, "native check {key}");
            }
            assert_eq!(session["nativeCookieStoreEmpty"], true);
        }
        assert_eq!(report["retirement"]["actualAclDenied"], true);
        assert_eq!(
            report["negativeControls"]["missingWrongSecretHostOrigin"],
            true
        );
        assert_eq!(
            report["negativeControls"]["otherWebview"]["otherWindow403"],
            true
        );
        assert_eq!(
            report["negativeControls"]["otherWebview"]["otherWindowAclDenied"],
            true
        );
        for key in ["terminalError", "fragmentGone", "controls44", "honestError"] {
            assert_eq!(report["ticketError"][key], true, "ticket error {key}");
        }
        assert_eq!(report["productionBenchmark"]["pairedRequests"], 100);
        assert!(
            report["productionBenchmark"]["p95OverheadMs"]
                .as_f64()
                .unwrap()
                <= 5.0,
            "production p95 exceeds5ms"
        );
        assert_eq!(report["ticketError"]["savedTheme"], prefs["theme"]);
        assert_eq!(report["ticketError"]["savedLocale"], prefs["locale"]);
        assert_eq!(report["secretOnDisk"], false);
        assert_eq!(report["cookieDatabaseFiles"], 0);
        let count = m
            .control
            .recorded_requests()
            .iter()
            .filter(|(p, _)| p == "/api/v1/auth/session-ticket")
            .count();
        tickets.push(count);
        assert_eq!(
            count,
            if phase == "first" { 3 } else { 6 },
            "fresh tickets for reopened windows and full restart"
        );
        std::fs::write(
            artifacts.join(format!("{phase}.json")),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
        reports.push(report);
    }
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "foreign network handler was reached"
    );
    let report = json!({"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"fullProcessRestart":true,"sessionsPerProcess":reports.iter().map(|r|r["sessions"].as_array().unwrap().len()).collect::<Vec<_>>(),"cumulativeFreshTickets":tickets,"foreignHandlerRequests":hits.load(Ordering::SeqCst),"rawChildOutputDiscarded":true,"credentialOrchestration":"Rust MemoryStore and stdin only","cookieDatabaseFiles":0,"secretOnDisk":false});
    std::fs::write(
        artifacts.join("index.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("Native SPA acceptance completed");
}
