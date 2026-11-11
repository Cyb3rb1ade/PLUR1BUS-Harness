//! The core's single-instance lock on `state/core.lock` (ADR-012 §5), for the Rust front door (Phase 4, P4-10).
//!
//! The TypeScript core holds the same file with `node:sqlite` (`PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE`,
//! module-api's `acquireExclusiveLock`). That is an `fcntl` (POSIX) / `LockFileEx` (Windows) lock on SQLite's locking
//! range at `0x40000000`, which the kernel drops when the process dies, `SIGKILL` included. [`CoreLock`] takes an
//! exclusive lock on the same 512 bytes with the primitive the audit chain uses, so a Rust front door and a TypeScript
//! core on one home exclude each other in both directions: whichever is second gets nothing (a TypeScript core then
//! fails with `E_LOCKED reason=core-lock-held`, exit 3).
//!
//! Unlike the TypeScript lock, no `holder` row is written: that table is for a human reading the file, and writing it
//! would need a second SQLite connection to the file, whose close would drop this process's `fcntl` locks (POSIX locks
//! belong to the process, not the descriptor). `run/core.pid` names the holder instead.
//!
//! Keep the returned [`CoreLock`] alive for the life of the process and never open `state/core.lock` again in it: on
//! POSIX, closing *any* descriptor of the file releases the lock.
use crate::create_private;
use std::fs::{self, File};
use std::io;
use std::path::Path;

/// A held core lock; dropping it releases the lock.
#[derive(Debug)]
pub struct CoreLock {
    _file: File,
}

impl CoreLock {
    /// Takes the lock on `path` (created `0600` if missing, its directory `0700`), without waiting: `Ok(None)` when
    /// another process holds it, an error when the file cannot be opened or locked for another reason.
    pub fn try_acquire(path: &Path) -> io::Result<Option<CoreLock>> {
        if let Some(dir) = path.parent() {
            create_private_dir(dir)?;
        }
        if path
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink() || !m.is_file())
        {
            return Err(io::Error::other("core lock is not a regular file"));
        }
        let file = create_private(path, false)?;
        Ok(crate::chain::try_lock(&file)?.then_some(CoreLock { _file: file }))
    }
}

fn create_private_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        match fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
        {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists && dir.is_dir() => Ok(()),
            Err(e) => Err(e),
        }
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)
    }
}

#[cfg(test)]
mod tests {
    use super::CoreLock;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::path::Path;
    use std::process::{Command, Stdio};

    const CHILD: &str = "PLUR1BUS_CORE_LOCK_TEST_CHILD";

    /// A second process (this test binary re-run as the child) cannot take a held lock and gets it once the holder dies.
    #[test]
    fn a_second_process_is_refused_until_the_holder_exits() {
        if let Some(path) = std::env::var_os(CHILD) {
            let held = CoreLock::try_acquire(Path::new(&path)).unwrap();
            let verdict = if held.is_some() { "held" } else { "refused" };
            let mut out = std::io::stdout();
            writeln!(out, "\nlock-verdict:{verdict}").unwrap();
            out.flush().unwrap();
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).unwrap();
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state/core.lock");
        let child = |path: &Path| {
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "lock::tests::a_second_process_is_refused_until_the_holder_exits",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env(CHILD, path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap()
        };
        // libtest prints its own text around the child's output; the verdict line is marked.
        let first_line = |c: &mut std::process::Child| {
            let mut reader = BufReader::new(c.stdout.as_mut().unwrap());
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 {
                    return String::new();
                }
                if let Some(verdict) = line.trim().strip_prefix("lock-verdict:") {
                    return verdict.to_owned();
                }
            }
        };
        let mine = CoreLock::try_acquire(&path).unwrap().expect("free lock");
        let mut other = child(&path);
        assert_eq!(first_line(&mut other), "refused");
        drop(other.stdin.take());
        other.wait().unwrap();
        drop(mine);
        let mut holder = child(&path);
        assert_eq!(first_line(&mut holder), "held");
        assert!(
            CoreLock::try_acquire(&path).unwrap().is_none(),
            "held by the child"
        );
        holder.kill().unwrap();
        holder.wait().unwrap();
        assert!(
            CoreLock::try_acquire(&path).unwrap().is_some(),
            "the kernel released the killed holder's lock"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&path), 0o600);
            assert_eq!(mode(path.parent().unwrap()), 0o700);
        }
    }

    /// Interop with the TypeScript core's lock (`node:sqlite`, `locking_mode=EXCLUSIVE`, `BEGIN EXCLUSIVE`): each refuses the
    /// other, in both directions, on the same file.
    #[test]
    fn the_typescript_core_lock_and_this_one_exclude_each_other() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.lock");
        let node = std::env::var_os("PLUR1BUS_NODE").unwrap_or_else(|| "node".into());
        // The body of module-api's acquireExclusiveLock (packages/module-api/src/lock.ts), printing its outcome.
        let script = r#"
            const { DatabaseSync } = await import("node:sqlite");
            const db = new DatabaseSync(process.argv[1]);
            try {
              db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE;");
              db.exec("CREATE TABLE IF NOT EXISTS holder(pid INTEGER NOT NULL, instance TEXT NOT NULL, at INTEGER NOT NULL)");
              db.exec("BEGIN EXCLUSIVE");
              console.log("held");
            } catch (e) { console.log(e.errcode === 5 ? "busy" : "error " + e.message); process.exit(0); }
            process.stdin.resume(); process.stdin.on("end", () => process.exit(0));
        "#;
        let spawn = || {
            Command::new(&node)
                .args(["--no-warnings", "--input-type=module", "-e", script])
                .arg(&path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap_or_else(|e| {
                    panic!("node is required for the lock interop test ({e}); set PLUR1BUS_NODE")
                })
        };
        let read_line = |c: &mut std::process::Child| {
            let mut line = String::new();
            BufReader::new(c.stdout.as_mut().unwrap())
                .read_line(&mut line)
                .unwrap();
            line.trim().to_owned()
        };
        let mine = CoreLock::try_acquire(&path).unwrap().expect("free lock");
        let mut ts = spawn();
        assert_eq!(
            read_line(&mut ts),
            "busy",
            "the TypeScript core is refused while Rust holds the lock"
        );
        ts.wait().unwrap();
        drop(mine);
        let mut ts = spawn();
        assert_eq!(read_line(&mut ts), "held");
        assert!(
            CoreLock::try_acquire(&path).unwrap().is_none(),
            "Rust is refused while the TypeScript core holds it"
        );
        drop(ts.stdin.take());
        let mut rest = String::new();
        ts.stdout.take().unwrap().read_to_string(&mut rest).unwrap();
        ts.wait().unwrap();
        assert!(CoreLock::try_acquire(&path).unwrap().is_some());
    }
}
