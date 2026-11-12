//! Process death at actual file publication boundaries, without production fault hooks.
use super::*;
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    time::Duration,
};

#[test]
#[allow(
    clippy::print_stdout,
    reason = "static synchronization token for the isolated crash-test child"
)]
fn cap_child_fixture() {
    let Some(root) = std::env::var_os("PLUR1BUS_N1_CAP_CRASH_FIXTURE") else {
        return;
    };
    let dir = TrustedDirectory::open(std::path::Path::new(&root)).unwrap();
    let phase = std::env::var("PLUR1BUS_N1_CAP_CRASH_PHASE").unwrap();
    let check = || {
        let archived = std::fs::read_dir(dir.path().join("archives")).is_ok_and(|mut entries| {
            entries.any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".gz")
            })
        });
        let staged = std::fs::read_dir(dir.path()).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".native-neo-cap-")
        });
        let replaced = std::fs::read_to_string(dir.path().join("turn-journal.jsonl"))
            .unwrap()
            .lines()
            .count()
            == 500;
        if match phase.as_str() {
            "archive" => archived,
            "stage" => staged,
            "replace" => replaced,
            _ => false,
        } {
            println!("N1_CAP_BOUNDARY");
            std::io::stdout().flush().unwrap();
            let mut byte = [0];
            let _ = std::io::stdin().read(&mut byte);
        }
        Ok(())
    };
    compact(&dir, "turn-journal.jsonl", 500, &Cancel::never(), &check).unwrap();
}

#[test]
fn sigkill_at_three_publication_boundaries_preserves_exact_history() {
    use std::os::unix::process::ExitStatusExt;
    for phase in ["archive", "stage", "replace"] {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let dir = TrustedDirectory::open(temp.path()).unwrap();
        let original = journal(&dir, 700);
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "neo::append_cap::tests::crash::cap_child_fixture",
                "--nocapture",
            ])
            .env("PLUR1BUS_N1_CAP_CRASH_FIXTURE", temp.path())
            .env("PLUR1BUS_N1_CAP_CRASH_PHASE", phase)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if line.unwrap().contains("N1_CAP_BOUNDARY") {
                    let _ = tx.send(());
                    break;
                }
            }
        });
        let ready = rx.recv_timeout(Duration::from_secs(15));
        let killed = child.kill();
        let status = child.wait().unwrap();
        reader.join().unwrap();
        ready.unwrap();
        killed.unwrap();
        assert_eq!(status.signal(), Some(9), "{phase}");
        compact(
            &dir,
            "turn-journal.jsonl",
            500,
            &Cancel::never(),
            &|| Ok(()),
        )
        .unwrap();
        let archives: Vec<_> = std::fs::read_dir(temp.path().join("archives"))
            .unwrap()
            .map(Result::unwrap)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".gz"))
            .collect();
        assert_eq!(archives.len(), 1, "{phase}");
        let gzip = std::fs::read(archives[0].path()).unwrap();
        let mut all = Vec::new();
        flate2::read::MultiGzDecoder::new(gzip.as_slice())
            .read_to_end(&mut all)
            .unwrap();
        all.extend(std::fs::read(temp.path().join("turn-journal.jsonl")).unwrap());
        assert_eq!(all, original, "{phase}");
    }
}
