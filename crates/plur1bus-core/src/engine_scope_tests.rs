//! [`EngineScope`]: the set of the last valid `config.json`, what it keeps between requests, and what it reads.
use super::*;
use serde_json::json;
use std::fs;
use std::time::{Duration, SystemTime};

struct Home {
    _dir: tempfile::TempDir,
    path: PathBuf,
    scope: EngineScope,
}

fn home() -> Home {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    Home {
        scope: EngineScope::new(path.clone()),
        path,
        _dir: dir,
    }
}

/// A valid configuration whose engine refers to `names` (blocks without default names), padded to `len` bytes when
/// one is given, so that two files with other names have one size.
fn config(names: &[&str], len: Option<usize>) -> String {
    let mut config = plur1bus_config::defaults();
    let mut engine = serde_json::Map::new();
    for (name, block) in names.iter().zip(["merging", "skillMiner", "criticalPush"]) {
        engine.insert(block.to_owned(), json!({ "apiKeyRef": name }));
    }
    config["engine"] = Value::Object(engine);
    let mut text = config.to_string();
    if let Some(len) = len {
        assert!(text.len() <= len, "{} > {len}", text.len());
        text.push_str(&" ".repeat(len - text.len()));
    }
    text
}

/// A time long enough ago for a file to be settled, `seconds` apart from the others.
fn long_ago(seconds: u64) -> SystemTime {
    SystemTime::now() - Duration::from_secs(3600) + Duration::from_secs(seconds)
}

fn stamp(path: &Path, at: SystemTime) {
    File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(at)
        .unwrap();
}

/// Writes `text` into the file that is there (the same inode) and gives it the modification time `at`.
fn write_in_place(path: &Path, text: &str, at: SystemTime) {
    fs::write(path, text).unwrap();
    stamp(path, at);
}

/// Puts a new file with `text` and the modification time `at` in the place of the one that is there (another inode).
fn replace(path: &Path, text: &str, at: SystemTime) {
    let next = path.with_extension("next");
    fs::write(&next, text).unwrap();
    stamp(&next, at);
    fs::rename(&next, path).unwrap();
}

fn names(h: &Home) -> Vec<String> {
    h.scope.names().iter().cloned().collect()
}

#[test]
fn before_a_valid_file_was_read_the_set_is_empty() {
    let h = home();
    fs::write(&h.path, "{ not json").unwrap();
    assert!(names(&h).is_empty());
    assert!(!h.scope.allows("models/key"));
    fs::write(&h.path, r#"{"engine":"rust"}"#).unwrap();
    assert!(names(&h).is_empty());
}

#[test]
fn a_file_that_is_not_there_is_the_defaults() {
    let h = home();
    assert!(names(&h).is_empty());
    write_in_place(&h.path, &config(&["models/key"], None), long_ago(0));
    assert_eq!(names(&h), ["models/key"]);
    fs::remove_file(&h.path).unwrap();
    assert!(
        names(&h).is_empty(),
        "no file: the defaults, which name nothing"
    );
    assert_eq!(h.scope.reads(), 1, "a file that is not there is not opened");
}

/// R-20-37: a file that is cut off, no JSON or no configuration changes nothing until a valid one is there; the
/// valid one then holds, with the reference it took out gone.
#[test]
fn an_invalid_file_changes_nothing_until_a_valid_one_is_there() {
    let h = home();
    let both = config(&["models/key", "personal/bank-token"], None);
    fs::write(&h.path, &both).unwrap();
    assert_eq!(names(&h), ["models/key", "personal/bank-token"]);
    for broken in [
        &both[..both.len() / 2],
        "{ not json",
        "",
        r#"{"engine":"rust"}"#,
        r#"{"schemaVersion":1,"engine":{"merging":{"apiKeyRef":7}},"nope":true}"#,
    ] {
        fs::write(&h.path, broken).unwrap();
        assert_eq!(
            names(&h),
            ["models/key", "personal/bank-token"],
            "{broken:?}"
        );
        // And the same from what is kept, once the broken file is old enough not to be opened again.
        stamp(&h.path, long_ago(1));
        let reads = h.scope.reads();
        assert_eq!(names(&h).len(), 2, "{broken:?}");
        assert_eq!(names(&h).len(), 2, "{broken:?}");
        assert!(h.scope.reads() <= reads + 1, "{broken:?}");
    }
    fs::write(&h.path, config(&["models/key"], None)).unwrap();
    assert_eq!(names(&h), ["models/key"]);
    assert!(!h.scope.allows("personal/bank-token"));
}

/// R-20-37 with what is kept: the file is opened once while it stays the file it was.
#[test]
fn a_file_that_did_not_change_is_not_read_again() {
    let h = home();
    write_in_place(&h.path, &config(&["models/key"], None), long_ago(0));
    for _ in 0..50 {
        assert!(h.scope.allows("models/key"));
        assert!(!h.scope.allows("personal/bank-token"));
    }
    assert_eq!(h.scope.reads(), 1);
}

/// What is kept must never go on allowing a reference a valid newer file took out. The three ways a file becomes
/// another one, each with everything else the same: only its modification time, only its inode, only its size.
#[test]
fn a_newer_file_is_read_whatever_else_stayed_the_same() {
    let len = config(&["models/key", "personal/bank-token"], None).len() + 8;
    let with = config(&["models/key", "personal/bank-token"], Some(len));
    let without = config(&["models/key"], Some(len));
    assert_eq!(with.len(), without.len());
    let (then, later) = (long_ago(0), long_ago(1));

    // Written in place, the same size and the same inode: another modification time.
    let h = home();
    write_in_place(&h.path, &with, then);
    assert!(h.scope.allows("personal/bank-token"));
    assert!(h.scope.allows("personal/bank-token"));
    write_in_place(&h.path, &without, later);
    assert!(!h.scope.allows("personal/bank-token"), "the time");
    assert!(h.scope.allows("models/key"));

    // Replaced by a file of the same size and the same modification time: another inode.
    let h = home();
    write_in_place(&h.path, &with, then);
    assert!(h.scope.allows("personal/bank-token"));
    // The first file stays under another name, so that its inode is not given to the next one.
    fs::hard_link(&h.path, h.path.with_extension("kept")).unwrap();
    replace(&h.path, &without, then);
    assert_eq!(
        fs::metadata(&h.path).unwrap().modified().unwrap(),
        fs::metadata(h.path.with_extension("kept"))
            .unwrap()
            .modified()
            .unwrap()
    );
    assert!(!h.scope.allows("personal/bank-token"), "the inode");
    assert!(h.scope.allows("models/key"));

    // Written in place with the same modification time: another size.
    let h = home();
    write_in_place(&h.path, &with, then);
    assert!(h.scope.allows("personal/bank-token"));
    write_in_place(&h.path, &config(&["models/key"], None), then);
    assert!(!h.scope.allows("personal/bank-token"), "the size");
    assert!(h.scope.allows("models/key"));
}

/// A file written a moment ago is read at every request: a second write within the granularity of the file system's
/// clock leaves its size, its time and its inode as they were.
#[test]
fn a_file_written_a_moment_ago_is_read_at_every_request() {
    let len = config(&["models/key", "personal/bank-token"], None).len() + 8;
    let h = home();
    let just_now = SystemTime::now() - Duration::from_millis(200);
    write_in_place(
        &h.path,
        &config(&["models/key", "personal/bank-token"], Some(len)),
        just_now,
    );
    assert!(h.scope.allows("personal/bank-token"));
    write_in_place(&h.path, &config(&["models/key"], Some(len)), just_now);
    assert!(!h.scope.allows("personal/bank-token"));
    assert!(h.scope.allows("models/key"));
    assert!(h.scope.reads() >= 3);
    // A modification time that is ahead of the clock never settles either.
    let ahead = SystemTime::now() + Duration::from_secs(3600);
    write_in_place(&h.path, &config(&["a"], Some(len)), ahead);
    assert!(h.scope.allows("a"));
    write_in_place(&h.path, &config(&["b"], Some(len)), ahead);
    assert!(!h.scope.allows("a"));
    assert!(h.scope.allows("b"));
}

/// A link to a regular file is read (people link their `config.json`), and a change of the file behind it is seen.
#[cfg(unix)]
#[test]
fn a_link_to_a_regular_file_is_read() {
    let h = home();
    let real = h.path.with_extension("real");
    write_in_place(&real, &config(&["models/key"], None), long_ago(0));
    std::os::unix::fs::symlink(&real, &h.path).unwrap();
    assert_eq!(names(&h), ["models/key"]);
    write_in_place(&real, &config(&["other/key"], None), long_ago(1));
    assert_eq!(names(&h), ["other/key"]);
}

/// What is no regular file is no configuration: nothing waits for it, nothing of it is read, and the last valid
/// configuration holds.
#[cfg(unix)]
#[test]
fn a_pipe_a_device_and_a_directory_are_not_read_and_nothing_waits() {
    use std::os::unix::fs::FileTypeExt;
    let started = std::time::Instant::now();
    for kind in ["pipe", "device", "endless", "directory"] {
        let h = home();
        write_in_place(&h.path, &config(&["models/key"], None), long_ago(0));
        assert_eq!(names(&h), ["models/key"]);
        fs::remove_file(&h.path).unwrap();
        match kind {
            // A pipe nobody writes to: an open that waited would wait for ever.
            "pipe" => {
                let made = std::process::Command::new("mkfifo")
                    .arg(&h.path)
                    .status()
                    .unwrap();
                assert!(made.success());
                assert!(fs::metadata(&h.path).unwrap().file_type().is_fifo());
            }
            "device" => std::os::unix::fs::symlink("/dev/null", &h.path).unwrap(),
            // Reports no size and never ends: a read that trusted the size would take all memory.
            "endless" => std::os::unix::fs::symlink("/dev/zero", &h.path).unwrap(),
            _ => fs::create_dir(&h.path).unwrap(),
        }
        for _ in 0..3 {
            assert_eq!(names(&h), ["models/key"], "{kind}");
        }
        // Not read at all: it is judged by what the descriptor is, before a byte is taken from it.
        assert_eq!(
            read_bounded(&h.path).map(|(_, bytes)| bytes.len()),
            Err(Unread::NoConfiguration),
            "{kind}"
        );
        // A regular file in its place is read again.
        if kind == "directory" {
            fs::remove_dir(&h.path).unwrap();
        } else {
            fs::remove_file(&h.path).unwrap();
        }
        fs::write(&h.path, config(&["other/key"], None)).unwrap();
        assert_eq!(names(&h), ["other/key"], "{kind}");
    }
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "{:?}",
        started.elapsed()
    );
}

/// A file larger than a configuration can be is not read at all, and one that only claims to be small is read up
/// to the limit and no further.
#[test]
fn a_file_that_is_too_large_is_not_a_configuration() {
    let h = home();
    write_in_place(&h.path, &config(&["models/key"], None), long_ago(0));
    assert_eq!(names(&h), ["models/key"]);
    // Sparse: the size is there, the bytes are not.
    let file = File::create(&h.path).unwrap();
    file.set_len(MAX_CONFIG_BYTES + 1).unwrap();
    drop(file);
    assert_eq!(names(&h), ["models/key"]);
    assert_eq!(
        read_bounded(&h.path).map(|(_, bytes)| bytes.len()),
        Err(Unread::NoConfiguration)
    );
    // At the limit and no JSON: read, refused, and the set stays.
    let file = File::create(&h.path).unwrap();
    file.set_len(MAX_CONFIG_BYTES).unwrap();
    drop(file);
    assert_eq!(names(&h), ["models/key"]);
    assert_eq!(
        read_bounded(&h.path).map(|(_, bytes)| bytes.len() as u64),
        Ok(MAX_CONFIG_BYTES)
    );
    fs::write(&h.path, config(&["other/key"], None)).unwrap();
    assert_eq!(names(&h), ["other/key"]);
}

/// The bytes of a configuration are judged as `read_config_file` judges the file.
#[test]
fn the_bytes_are_judged_as_the_file_is() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    for text in [
        config(&["models/key"], None),
        "{ not json".to_owned(),
        r#"{"engine":"rust"}"#.to_owned(),
        r#"{"schemaVersion":1}"#.to_owned(),
        r#"{"schemaVersion":1,"__proto__":{}}"#.to_owned(),
    ] {
        fs::write(&path, &text).unwrap();
        let file = crate::config::load::read_config_file(&path);
        let bytes = config_from_bytes(&path, text.as_bytes());
        assert_eq!(file.is_ok(), bytes.is_ok(), "{text}");
        if let (Ok(file), Ok(bytes)) = (&file, &bytes) {
            assert_eq!(file, bytes);
        }
        if let (Err(file), Err(bytes)) = (&file, &bytes) {
            assert_eq!(file.errors(), bytes.errors(), "{text}");
        }
    }
}
