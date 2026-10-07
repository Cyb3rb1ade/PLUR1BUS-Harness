//! Bounded profile reads shared by production Windows cleanup and deterministic tests.
use std::{
    fs::File,
    io::{self, Read},
    path::Path,
    time::{Duration, Instant},
};

pub(crate) const MAX_BYTES: u64 = 64 * 1024 * 1024;
// A late browser exit must not consume the deletion reservation of the 10-second total budget.
pub(crate) const MAX_TIME: Duration = Duration::from_secs(5);
pub(crate) const DELETE_RESERVE: Duration = Duration::from_secs(1);

pub(crate) fn deadline(now: Instant, total: Instant) -> Instant {
    (now + MAX_TIME).min(total.checked_sub(DELETE_RESERVE).unwrap_or(now))
}

pub(crate) fn check_deadline(limit: Option<Instant>, now: &impl Fn() -> Instant) -> io::Result<()> {
    if limit.is_some_and(|limit| now() >= limit) {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "SPA audit deadline",
        ));
    }
    Ok(())
}

pub(crate) fn read_file_bounded(
    path: &Path,
    limit: Option<Instant>,
    remaining: &mut u64,
    now: &impl Fn() -> Instant,
) -> io::Result<()> {
    check_deadline(limit, now)?;
    let mut file = File::open(path)?;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        check_deadline(limit, now)?;
        let capacity = remaining.saturating_add(1).min(buffer.len() as u64) as usize;
        let read = file.read(&mut buffer[..capacity])?;
        if read == 0 {
            return Ok(());
        }
        *remaining = remaining
            .checked_sub(read as u64)
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "SPA audit byte budget"))?;
    }
}

pub(crate) fn audit_profile_readability(
    root: &Path,
    limit: Instant,
    mut remaining: u64,
    now: &impl Fn() -> Instant,
    metadata: impl Fn(&Path) -> io::Result<std::fs::Metadata>,
    special: impl Fn(&Path) -> io::Result<bool>,
) -> io::Result<(u64, u64)> {
    let initial_bytes = remaining;
    let mut files_read = 0;
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        check_deadline(Some(limit), now)?;
        for entry in std::fs::read_dir(dir)? {
            check_deadline(Some(limit), now)?;
            let path = entry?.path();
            let info = metadata(&path)?;
            if info.is_dir() {
                pending.push(path);
            } else if info.is_file() {
                if !special(&path)? {
                    read_file_bounded(&path, Some(limit), &mut remaining, now)?;
                    files_read += 1;
                }
            } else {
                return Err(io::Error::other("unsupported SPA profile entry"));
            }
        }
    }
    Ok((files_read, initial_bytes - remaining))
}

pub(crate) fn post_exit_audit(
    read: impl FnOnce() -> io::Result<super::windows_spa_profile::SecretScanOutcome>,
    cookie: impl FnOnce() -> io::Result<super::windows_spa_profile::ProfileCleanupEvidence>,
) -> super::windows_spa_profile::ProfileCleanupEvidence {
    // Cookie evidence is mandatory and cheap: acquire it before the secret
    // reader can consume the shared deadline. Neither phase retries.
    let mut evidence = super::windows_spa_profile::ProfileCleanupEvidence::default();
    let started = Instant::now();
    match cookie() {
        Ok(audit) => {
            evidence.read_only_complete = true;
            evidence.cookie_rows = audit.cookie_rows;
            evidence.cookie_database_files = audit.cookie_database_files;
            evidence.cookie_sidecar_files = audit.cookie_sidecar_files;
        }
        Err(error) => {
            evidence.cookie_timed_out = error.kind() == io::ErrorKind::TimedOut;
            evidence.audit_timed_out = evidence.cookie_timed_out;
        }
    }
    evidence.cookie_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let started = Instant::now();
    match read() {
        Ok(scan) => {
            evidence.secret_detected = scan.secret_detected;
            evidence.secret_scan_complete = scan.complete;
            evidence.files_read = scan.files_read;
            evidence.bytes_read = scan.bytes_read;
            evidence.scan_timed_out = scan.timed_out;
        }
        Err(error) => evidence.scan_timed_out = error.kind() == io::ErrorKind::TimedOut,
    }
    evidence.scan_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    evidence.audit_timed_out |= evidence.scan_timed_out;
    evidence
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_read_enforces_bytes_and_accepts_exact_budget() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file");
        std::fs::write(&path, [0u8; 100]).unwrap();
        assert_eq!(
            read_file_bounded(&path, None, &mut 99, &Instant::now)
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
        read_file_bounded(&path, None, &mut 100, &Instant::now).unwrap();
    }
    #[test]
    fn clock_is_checked_between_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file");
        std::fs::write(&path, vec![0u8; 128 * 1024]).unwrap();
        let start = Instant::now();
        let calls = std::cell::Cell::new(0);
        let now = || {
            let call = calls.get();
            calls.set(call + 1);
            if call >= 2 {
                start + Duration::from_secs(2)
            } else {
                start
            }
        };
        let mut remaining = MAX_BYTES;
        let error = read_file_bounded(
            &path,
            Some(start + Duration::from_secs(1)),
            &mut remaining,
            &now,
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert_eq!(calls.get(), 3);
    }
    #[test]
    fn unreadable_file_is_not_a_success() {
        let dir = tempfile::tempdir().unwrap();
        let mut remaining = MAX_BYTES;
        let error = read_file_bounded(
            &dir.path().join("absent"),
            None,
            &mut remaining,
            &Instant::now,
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }
    #[test]
    fn tree_audit_shares_byte_budget_between_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a"), [0u8; 60]).unwrap();
        std::fs::write(dir.path().join("b"), [0u8; 60]).unwrap();
        let error = audit_profile_readability(
            dir.path(),
            Instant::now() + MAX_TIME,
            100,
            &Instant::now,
            |p| std::fs::symlink_metadata(p),
            |_| Ok(false),
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }
    #[test]
    fn tree_audit_checks_clock_between_entries_and_propagates_unreadable_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a"), b"data").unwrap();
        let start = Instant::now();
        let calls = std::cell::Cell::new(0);
        let now = || {
            let n = calls.get();
            calls.set(n + 1);
            start + Duration::from_secs(n)
        };
        assert_eq!(
            audit_profile_readability(
                dir.path(),
                start + Duration::from_secs(1),
                MAX_BYTES,
                &now,
                |p| std::fs::symlink_metadata(p),
                |_| Ok(false)
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(
            audit_profile_readability(
                dir.path(),
                start + MAX_TIME,
                MAX_BYTES,
                &Instant::now,
                |p| std::fs::symlink_metadata(p),
                |p| {
                    std::fs::remove_file(p)?;
                    Ok(false)
                }
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::NotFound
        );
    }

    #[test]
    fn tree_deadline_is_checked_before_opening_the_second_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a"), b"a").unwrap();
        std::fs::write(dir.path().join("b"), b"b").unwrap();
        let start = Instant::now();
        let calls = std::cell::Cell::new(0);
        let inspected = std::cell::Cell::new(0);
        let now = || {
            let n = calls.get();
            calls.set(n + 1);
            if n >= 5 {
                start + MAX_TIME
            } else {
                start
            }
        };
        let error = audit_profile_readability(
            dir.path(),
            start + MAX_TIME,
            MAX_BYTES,
            &now,
            |p| {
                inspected.set(inspected.get() + 1);
                std::fs::symlink_metadata(p)
            },
            |_| Ok(false),
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert_eq!(inspected.get(), 1, "second file must not be opened");
    }

    #[tokio::test]
    async fn real_read_timeout_keeps_reason_and_still_deletes() {
        for byte_timeout in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("profile");
            std::fs::create_dir(&path).unwrap();
            std::fs::write(path.join("file"), b"data").unwrap();
            let start = Instant::now();
            let result = crate::windows_spa_profile::finish_owned_cleanup_async_with_mode(
                start,
                start + Duration::from_secs(10),
                || Some(true),
                || async {
                    post_exit_audit(
                        || {
                            let limit = if byte_timeout {
                                start + MAX_TIME
                            } else {
                                start
                            };
                            audit_profile_readability(
                                &path,
                                limit,
                                if byte_timeout { 1 } else { MAX_BYTES },
                                &Instant::now,
                                |p| std::fs::symlink_metadata(p),
                                |_| Ok(false),
                            )?;
                            Ok(crate::windows_spa_profile::SecretScanOutcome {
                                complete: true,
                                secret_detected: false,
                                ..Default::default()
                            })
                        },
                        || {
                            Ok(crate::windows_spa_profile::ProfileCleanupEvidence {
                                cookie_database_files: 1,
                                ..Default::default()
                            })
                        },
                    )
                },
                || std::fs::remove_dir_all(&path).is_ok(),
                true,
            )
            .await;
            assert!(!path.exists());
            assert!(result.removed);
            assert_eq!(result.reason_code(), "SPA_PROFILE_CLEANUP_TIMEOUT");
            assert_eq!(crate::windows_spa_profile::cleanup_exit_code(&result), 0);
        }
    }

    #[test]
    fn incomplete_scan_keeps_positive_evidence_and_actual_read_counters() {
        let evidence = post_exit_audit(
            || {
                Ok(crate::windows_spa_profile::SecretScanOutcome {
                    complete: false,
                    secret_detected: true,
                    timed_out: true,
                    files_read: 3,
                    bytes_read: 8192,
                })
            },
            || {
                Ok(crate::windows_spa_profile::ProfileCleanupEvidence {
                    cookie_rows: 2,
                    cookie_database_files: 1,
                    ..Default::default()
                })
            },
        );
        assert!(evidence.secret_detected && evidence.scan_timed_out && evidence.audit_timed_out);
        assert_eq!(evidence.cookie_rows, 2);
        assert_eq!((evidence.files_read, evidence.bytes_read), (3, 8192));
        assert!(!evidence.secret_scan_complete);
        assert!(!evidence.accepted());
    }

    #[test]
    fn slow_scan_cannot_starve_cookie_inspection() {
        let cookie_completed = std::cell::Cell::new(false);
        let start = Instant::now();
        let clock = std::cell::Cell::new(start);
        let evidence = post_exit_audit(
            || {
                assert!(cookie_completed.get(), "cookie phase must finish first");
                clock.set(start + Duration::from_secs(6));
                check_deadline(Some(start + MAX_TIME), &|| clock.get())?;
                unreachable!()
            },
            || {
                check_deadline(Some(start + MAX_TIME), &|| clock.get())?;
                cookie_completed.set(true);
                Ok(crate::windows_spa_profile::ProfileCleanupEvidence {
                    cookie_database_files: 1,
                    ..Default::default()
                })
            },
        );
        assert!(evidence.read_only_complete);
        assert_eq!(evidence.cookie_database_files, 1);
        assert!(!evidence.cookie_timed_out);
        assert!(evidence.scan_timed_out);
        assert!(!evidence.secret_scan_complete);
    }

    #[test]
    fn audit_budget_reserves_deletion_even_after_late_exit() {
        let start = Instant::now();
        let total = start + Duration::from_secs(10);
        assert_eq!(deadline(start, total), start + Duration::from_secs(5));
        assert_eq!(
            deadline(start + Duration::from_secs(8), total),
            start + Duration::from_secs(9)
        );
        assert!(deadline(start + Duration::from_secs(10), total) < total);
    }
}
