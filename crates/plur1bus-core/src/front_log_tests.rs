//! The front door's log on a real home: its lines, the level of config.json, following a changed configuration, and
//! what happens to lines the log cannot take or has just written.
#![allow(clippy::unwrap_used)]
use super::*;
use crate::logs::sink::default_acquire_lock;
use std::sync::atomic::AtomicUsize;

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

/// The complete lines of the log; a last line still being written (no newline yet) is not one.
fn lines(files: &RunFiles) -> Vec<Value> {
    let text = std::fs::read_to_string(files.home.join("logs/core.log")).unwrap_or_default();
    let whole = text.rfind('\n').map_or("", |end| &text[..end]);
    whole
        .lines()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{l:?}: {e}")))
        .collect()
}

fn text(record: &Value) -> String {
    record["msg"].as_str().unwrap().to_owned()
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
    // An invalid file keeps what runs, and the next valid one is followed again.
    std::fs::write(&home.files.config, "{ not json").unwrap();
    std::thread::sleep(Duration::from_millis(80));
    let before = messages(&home.files).len();
    log.write("warn", "still filtered", &Value::Null);
    log.write("error", "still written", &Value::Null);
    log.flush();
    assert_eq!(messages(&home.files).len(), before + 1);
    write_config(&home.files, "warn");
    until("warn passes again", || {
        log.write("warn", "passes again", &Value::Null);
        log.flush();
        messages(&home.files).iter().any(|m| m == "passes again")
    });
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
    // A log directory that cannot be one: the lines go nowhere, and nothing waits for them.
    let blocked = home(None);
    std::fs::write(blocked.files.home.join("logs"), "a file").unwrap();
    let log = FrontLog::open(&blocked.files, unfollowed()).unwrap();
    let started = Instant::now();
    for _ in 0..3000 {
        log.write("warn", "nowhere", &Value::Null);
    }
    log.flush();
    log.close();
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(
        std::fs::read(blocked.files.home.join("logs")).unwrap(),
        b"a file"
    );
}

#[test]
fn a_line_the_log_cannot_take_in_time_is_dropped_and_counted_and_no_caller_waits() {
    let home = home(None);
    // The role's lock is "held by another writer" while `busy` is set: the log's thread waits inside its write.
    let busy = Arc::new(AtomicBool::new(false));
    let refused = Arc::new(AtomicUsize::new(0));
    let hooks = SinkHooks {
        acquire_lock: {
            let (busy, refused) = (Arc::clone(&busy), Arc::clone(&refused));
            Arc::new(move |path: &Path| {
                if busy.load(Ordering::SeqCst) {
                    refused.fetch_add(1, Ordering::SeqCst);
                    return Ok(None);
                }
                default_acquire_lock(path)
            })
        },
        ..SinkHooks::default()
    };
    let seams = Seams {
        queue: 4,
        lock_wait: Duration::from_secs(30),
        hooks: Some(hooks),
    };
    let log = FrontLog::open_with(&home.files, unfollowed(), seams).unwrap();
    log.write("warn", "before", &Value::Null);
    log.flush();
    busy.store(true, Ordering::SeqCst);
    log.write("warn", "in the blocked write", &Value::Null);
    until("the log's thread waits for the lock", || {
        refused.load(Ordering::SeqCst) > 0
    });
    let started = Instant::now();
    for n in 0..50 {
        log.write("warn", &format!("line {n}"), &Value::Null);
    }
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "fifty lines took {:?} with the log blocked",
        started.elapsed()
    );
    busy.store(false, Ordering::SeqCst);
    log.flush();
    let l = lines(&home.files);
    let numbered: Vec<String> = l
        .iter()
        .map(text)
        .filter(|m| m.starts_with("line "))
        .collect();
    assert_eq!(
        numbered,
        ["line 0", "line 1", "line 2", "line 3"],
        "the queue's four, in order"
    );
    let reports: Vec<&Value> = l
        .iter()
        .filter(|r| text(r) == "front door log lines dropped")
        .collect();
    assert_eq!(reports.len(), 1, "{l:?}");
    assert_eq!(reports[0]["dropped"], 46);
    assert_eq!(reports[0]["level"], "warn");
    assert_eq!(reports[0]["src"], "front-door");
    assert_eq!(
        l.iter().map(text).collect::<Vec<_>>()[..3],
        [
            "before",
            "in the blocked write",
            "front door log lines dropped"
        ],
        "the count is written before the next line"
    );
    log.close();
}

#[test]
fn a_repeated_warning_is_written_once_a_second_with_the_number_of_its_repetitions() {
    let home = home(None);
    let log = FrontLog::open(&home.files, unfollowed()).unwrap();
    for _ in 0..200 {
        log.write("warn", "connection limit reached", &Value::Null);
    }
    // Another connection's line is another line; an info line is never counted away.
    log.write("warn", "client not reading", &json!({"connectionId": 7}));
    log.write("warn", "client not reading", &json!({"connectionId": 8}));
    for _ in 0..5 {
        log.write("info", "adopted", &json!({"connectionId": 7}));
    }
    log.flush();
    let l = lines(&home.files);
    let written = l
        .iter()
        .filter(|r| text(r) == "connection limit reached")
        .count() as u64;
    let reports: Vec<&Value> = l
        .iter()
        .filter(|r| text(r) == "front door log line repeated")
        .collect();
    let repeated: u64 = reports
        .iter()
        .map(|r| r["repeated"].as_u64().unwrap())
        .sum();
    assert_eq!(written + repeated, 200, "{l:?}");
    // One line and one count per started second; 200 queued lines take well under two.
    assert!(
        (1..=2).contains(&written) && (1..=2).contains(&reports.len()),
        "{l:?}"
    );
    for r in &reports {
        assert_eq!(r["line"], "connection limit reached");
        assert_eq!(r["level"], "warn");
        assert_eq!(r["src"], "front-door");
    }
    assert_eq!(
        l.iter().filter(|r| text(r) == "client not reading").count(),
        2
    );
    assert_eq!(l.iter().filter(|r| text(r) == "adopted").count(), 5);
    // The count of a line that stops coming is written when the log sits idle, not only with the next line.
    log.write("error", "accept failed", &Value::Null);
    log.write("error", "accept failed", &Value::Null);
    until("the idle log writes its count", || {
        lines(&home.files)
            .iter()
            .any(|r| text(r) == "front door log line repeated" && r["line"] == "accept failed")
    });
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

#[test]
fn a_configuration_without_a_usable_level_keeps_the_level_in_force() {
    let home = home(Some("error"));
    let writer = open_writer(&home.files.home, &home.files.config, &Seams::default()).unwrap();
    writer
        .write_legacy(Level::Warn, "filtered at error", &Map::new())
        .unwrap();
    apply(&writer, &json!({"core": {"logLevel": "loud"}}));
    writer
        .write_legacy(Level::Warn, "still filtered", &Map::new())
        .unwrap();
    writer
        .write_legacy(Level::Error, "written", &Map::new())
        .unwrap();
    writer.flush(true).unwrap();
    assert_eq!(messages(&home.files), ["written"]);
    writer.close().unwrap();
}
