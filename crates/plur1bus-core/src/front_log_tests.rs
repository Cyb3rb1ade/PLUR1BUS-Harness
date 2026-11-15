//! The front door's log on a real home: its lines, the level of config.json, and following a changed configuration.
#![allow(clippy::unwrap_used)]
use super::*;
use std::time::Instant;

struct Home {
    _dir: tempfile::TempDir,
    files: RunFiles,
}

fn home(level: Option<&str>) -> Home {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let files = RunFiles::new(dir.path());
    if let Some(level) = level {
        write_config(&files, level);
    }
    Home { _dir: dir, files }
}

fn write_config(files: &RunFiles, level: &str) {
    let mut config = plur1bus_config::defaults();
    config["core"]["logLevel"] = json!(level);
    std::fs::write(&files.config, config.to_string()).unwrap();
}

fn unfollowed() -> Follow {
    Follow {
        supervised: false,
        file_poll: Some(Duration::from_millis(20)),
    }
}

fn lines(files: &RunFiles) -> Vec<Value> {
    std::fs::read_to_string(files.home.join("logs/core.log"))
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn messages(files: &RunFiles) -> Vec<String> {
    lines(files)
        .iter()
        .map(|l| l["msg"].as_str().unwrap().to_owned())
        .collect()
}

fn until(what: &str, pred: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !pred() {
        assert!(Instant::now() < deadline, "not in time: {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn a_line_is_a_legacy_line_of_the_core_role_marked_as_the_front_doors() {
    let home = home(None);
    let log = FrontLog::open(&home.files, unfollowed()).unwrap();
    log.write(
        "info",
        "core ready",
        &json!({"instanceId": "i-1", "supervised": false, "src": "a caller's own"}),
    );
    log.write("warn", "adoption refused", &Value::Null);
    log.write("loud", "no such level", &Value::Null);
    log.flush();
    let l = lines(&home.files);
    assert_eq!(l.len(), 2, "{l:?}");
    assert_eq!(l[0]["role"], "core");
    assert_eq!(l[0]["level"], "info");
    assert_eq!(l[0]["src"], "front-door");
    assert_eq!(l[0]["instanceId"], "i-1");
    assert_eq!(l[0]["supervised"], false);
    assert_eq!(l[0]["msg"], "core ready");
    assert!(l[0]["at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(
        (&l[1]["level"], &l[1]["src"]),
        (&json!("warn"), &json!("front-door"))
    );
    // The catalogue's process events are the legacy core's until the cut.
    assert!(l.iter().all(|r| r.get("event").is_none()));
    log.close();
    log.close();
    log.write("warn", "after the close", &Value::Null);
    assert_eq!(lines(&home.files).len(), 2);
}

#[test]
fn the_level_is_config_jsons_at_the_start() {
    let home = home(Some("warn"));
    let log = FrontLog::open(&home.files, unfollowed()).unwrap();
    log.write("info", "core ready", &Value::Null);
    log.write("warn", "orphan grace expired, stopping", &Value::Null);
    log.flush();
    assert_eq!(messages(&home.files), ["orphan grace expired, stopping"]);
}

#[test]
fn a_changed_configuration_is_followed_and_writes_no_level_record_of_its_own() {
    let home = home(Some("warn"));
    let log = FrontLog::open(&home.files, unfollowed()).unwrap();
    // The source has opened and applied the file once this holds.
    until("following", || {
        log.followed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    });
    write_config(&home.files, "debug");
    until("debug passes", || {
        log.write("debug", "probe", &Value::Null);
        log.flush();
        messages(&home.files).iter().any(|m| m == "probe")
    });
    write_config(&home.files, "error");
    until("warn passes no more", || {
        let before = messages(&home.files).len();
        log.write("warn", "filtered", &Value::Null);
        log.flush();
        messages(&home.files).len() == before
    });
    // An invalid file keeps what runs.
    std::fs::write(&home.files.config, "{ not json").unwrap();
    std::thread::sleep(Duration::from_millis(80));
    let before = messages(&home.files).len();
    log.write("warn", "still filtered", &Value::Null);
    log.write("error", "still written", &Value::Null);
    log.flush();
    assert_eq!(messages(&home.files).len(), before + 1);
    assert!(lines(&home.files).iter().all(|r| r.get("event").is_none()));
    log.close();
}

#[test]
fn an_unusable_configuration_or_log_directory_never_stops_the_caller() {
    // An invalid config.json: the defaults (info), and the source never opens.
    let broken = home(None);
    std::fs::write(&broken.files.config, "{ not json").unwrap();
    let log = FrontLog::open(&broken.files, unfollowed()).unwrap();
    log.write("debug", "below the default", &Value::Null);
    log.write("info", "at the default", &Value::Null);
    log.flush();
    assert_eq!(messages(&broken.files), ["at the default"]);
    drop(log);
    // A log directory that cannot be one: no log, and nothing to close.
    let blocked = home(None);
    std::fs::write(blocked.files.home.join("logs"), "a file").unwrap();
    assert!(FrontLog::open(&blocked.files, unfollowed()).is_none());
}

#[test]
fn a_line_the_log_cannot_take_in_time_is_dropped_and_counted_and_no_caller_waits() {
    let home = home(None);
    let log = FrontLog::open_with(&home.files, unfollowed(), 4).unwrap();
    log.write("warn", "before", &Value::Null);
    log.flush();
    // Another writer of the role holds its lock, as a rotating legacy core does: the log's thread waits inside its
    // next write, the queue fills, and the callers go on.
    let held = plur1bus_audit::lock::CoreLock::try_acquire(
        &home.files.home.join("logs/core.log.writer-lock"),
    )
    .unwrap()
    .unwrap();
    let started = Instant::now();
    for n in 0..50 {
        log.write("warn", &format!("line {n}"), &Value::Null);
    }
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "fifty lines took {:?} with the log blocked",
        started.elapsed()
    );
    drop(held);
    log.write("warn", "after", &Value::Null);
    log.flush();
    let l = lines(&home.files);
    let text = |r: &Value| r["msg"].as_str().unwrap().to_owned();
    let written = l.iter().filter(|r| text(r).starts_with("line ")).count() as u64;
    let dropped: u64 = l
        .iter()
        .filter(|r| text(r) == "front door log lines dropped")
        .map(|r| {
            assert_eq!(
                (&r["level"], &r["src"]),
                (&json!("warn"), &json!("front-door"))
            );
            r["dropped"].as_u64().unwrap()
        })
        .sum();
    // One line in the blocked write at most, four in the queue; "after" may be among the dropped.
    assert!((4..=5).contains(&written), "{written} written: {l:?}");
    let after = l.iter().filter(|r| text(r) == "after").count() as u64;
    assert_eq!(written + after + dropped, 51, "{l:?}");
    // What was written kept its order.
    let numbers: Vec<u64> = l
        .iter()
        .filter_map(|r| text(r).strip_prefix("line ").map(|n| n.parse().unwrap()))
        .collect();
    assert!(numbers.windows(2).all(|w| w[0] < w[1]), "{numbers:?}");
    log.close();
}

#[test]
fn settings_take_only_usable_values() {
    let s = settings(
        &json!({"core": {"logLevel": "debug"}, "logs": {"maxBytes": 2_097_152, "keep": 7}}),
    );
    assert_eq!(s.level, Some(Level::Debug));
    assert_eq!(s.rotation, Some((2_097_152.0, 7)));
    for bad in [
        json!({"core": {"logLevel": "loud"}, "logs": {"maxBytes": 0, "keep": 7}}),
        json!({"core": {"logLevel": 3}, "logs": {"maxBytes": 1024, "keep": 0}}),
        json!({"logs": {"maxBytes": 1024}}),
        json!(null),
    ] {
        let s = settings(&bad);
        assert_eq!(s.level, None, "{bad}");
        assert_eq!(s.rotation, None, "{bad}");
    }
}
