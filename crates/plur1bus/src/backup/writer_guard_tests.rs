use super::*;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Instant;

const CHILD_TEST: &str = "backup::writer_guard::tests::writer_child";

#[test]
fn writer_child() {
    let Ok(home) = std::env::var("PLUR1BUS_TEST_WRITER_HOME") else {
        return;
    };
    let mode = std::env::var("PLUR1BUS_TEST_WRITER_MODE").unwrap();
    let ready = std::env::var("PLUR1BUS_TEST_WRITER_READY").unwrap();
    let layout = Layout::new(home.into());
    let mut core = None;
    let mut process = None;
    let mut all = None;
    let result = match mode.as_str() {
        "core" => {
            core_lock(&layout.state().join("core.lock"), true).map(|guard| core = Some(guard))
        }
        "supervisor" => {
            process_lock(&layout.supervisor_lock(), true).map(|guard| process = Some(guard))
        }
        "engine" => process_lock(&layout.run().join("engine.process.lock"), true)
            .map(|guard| process = Some(guard)),
        "all" => WriterGuard::acquire(&layout).map(|guard| all = Some(guard)),
        _ => panic!("unknown child mode"),
    };
    let outcome = result.as_ref().map_or_else(|e| e.reason, |()| "held");
    fs::write(ready, outcome).unwrap();
    if result.is_ok() {
        let _ = std::io::stdin().read(&mut [0]);
    }
    drop((core, process, all));
}

struct Writer(Child);
impl Writer {
    fn start(layout: &Layout, mode: &str, ready: &Path) -> (Self, String) {
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", CHILD_TEST, "--nocapture"])
            .env("PLUR1BUS_TEST_WRITER_HOME", &layout.home)
            .env("PLUR1BUS_TEST_WRITER_MODE", mode)
            .env("PLUR1BUS_TEST_WRITER_READY", ready)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let writer = Self(child);
        let start = Instant::now();
        loop {
            if let Ok(text) = fs::read_to_string(ready) {
                if !text.is_empty() {
                    return (writer, text);
                }
            }
            assert!(
                start.elapsed() < Duration::from_secs(15),
                "writer child did not become ready"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Writer {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn layout(root: &Path) -> Layout {
    let layout = Layout::new(root.join("home"));
    private_directory(&layout.state()).unwrap();
    private_directory(&layout.run()).unwrap();
    layout
}

fn tree(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
    let mut entries = BTreeMap::new();
    for e in fs::read_dir(root).unwrap() {
        let e = e.unwrap();
        if e.file_type().unwrap().is_dir() {
            entries.insert(e.path(), None);
            entries.extend(tree(&e.path()));
        } else {
            entries.insert(e.path(), Some(fs::read(e.path()).unwrap()));
        }
    }
    entries
}

#[test]
fn already_active_cross_process_writers_refuse_without_changing_lock_bytes() {
    for mode in ["core", "supervisor", "engine"] {
        let root = tempfile::tempdir().unwrap();
        let layout = layout(root.path());
        if mode == "core" {
            let db = Connection::open(layout.state().join("core.lock")).unwrap();
            db.execute_batch("CREATE TABLE holder(pid INTEGER, instance TEXT, at INTEGER); INSERT INTO holder VALUES (1, 'existing', 42);").unwrap();
        } else {
            let path = if mode == "engine" {
                layout.run().join("engine.process.lock")
            } else {
                layout.supervisor_lock()
            };
            fs::write(path, b"existing lock metadata").unwrap();
        }
        let before = tree(&layout.home);
        let (writer, result) = Writer::start(&layout, mode, &root.path().join("ready"));
        assert_eq!(result, "held", "{mode}");
        assert_eq!(
            WriterGuard::acquire(&layout).err().unwrap().reason,
            "core-running",
            "{mode}"
        );
        // Windows disallows reading the byte range while the other process holds it.
        // Compare after releasing it, preserving the same byte/directory assertion.
        drop(writer);
        assert_eq!(tree(&layout.home), before, "{mode}");
    }
}

#[test]
fn held_restore_fence_excludes_later_core_supervisor_and_engine_start() {
    let root = tempfile::tempdir().unwrap();
    let layout = layout(root.path());
    let guard = WriterGuard::acquire(&layout).unwrap();
    for mode in ["core", "supervisor", "engine", "all"] {
        let (_writer, result) =
            Writer::start(&layout, mode, &root.path().join(format!("ready-{mode}")));
        assert_eq!(result, "core-running", "{mode}");
    }
    drop(guard);
    let (_writer, result) = Writer::start(&layout, "all", &root.path().join("ready-released"));
    assert_eq!(result, "held");
}

#[test]
fn killed_restore_process_releases_all_fences_without_nonce_reaping() {
    let root = tempfile::tempdir().unwrap();
    let layout = layout(root.path());
    fs::write(
        layout.run().join("engine.lock"),
        b"nonce must stay unchanged",
    )
    .unwrap();
    let (writer, result) = Writer::start(&layout, "all", &root.path().join("ready"));
    assert_eq!(result, "held");
    drop(writer); // real process kill; no Rust Drop in that child
    let _guard = WriterGuard::acquire(&layout).unwrap();
    assert_eq!(
        fs::read(layout.run().join("engine.lock")).unwrap(),
        b"nonce must stay unchanged"
    );
}

#[cfg(unix)]
#[test]
fn symlink_lock_is_refused_without_touching_its_target() {
    let root = tempfile::tempdir().unwrap();
    let layout = layout(root.path());
    let other = root.path().join("other");
    fs::write(&other, b"untouched").unwrap();
    std::os::unix::fs::symlink(&other, layout.state().join("core.lock")).unwrap();
    assert_eq!(WriterGuard::acquire(&layout).err().unwrap().reason, "io");
    assert_eq!(fs::read(other).unwrap(), b"untouched");
    assert_eq!(fs::read_dir(layout.run()).unwrap().count(), 0);
}
