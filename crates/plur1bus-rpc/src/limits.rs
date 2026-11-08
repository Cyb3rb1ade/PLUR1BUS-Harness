//! The process's open-file limit (P4-10 security review M2). A server that holds descriptors per client raises its soft
//! `RLIMIT_NOFILE` at start, as Node does for every process (`node::PlatformInit`): launchd starts processes with a soft
//! limit of 256, which a Rust server would otherwise keep, so the TypeScript core never had that ceiling and the Rust
//! front door did.

/// Raises the soft open-file limit as far as the hard limit allows, with Node's search: straight to the hard limit when
/// it is finite, else the largest value up to 2^20 the kernel accepts (macOS caps it at `kern.maxfilesperproc`). Returns
/// the soft limit in force afterwards, or `None` when it cannot be read.
#[cfg(unix)]
pub fn raise_open_files() -> Option<u64> {
    let mut current = read()?;
    if current.rlim_cur != current.rlim_max {
        let (mut min, mut max): (libc::rlim_t, libc::rlim_t) =
            if current.rlim_max == libc::RLIM_INFINITY {
                (current.rlim_cur, 1 << 20)
            } else {
                (current.rlim_max, current.rlim_max)
            };
        while min < max {
            let next = libc::rlimit {
                rlim_cur: min + (max - min) / 2,
                rlim_max: current.rlim_max,
            };
            // SAFETY: `next` is a live, initialised rlimit that the call only reads.
            if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &next) } == 0 {
                min = next.rlim_cur;
            } else {
                max = next.rlim_cur;
            }
            if min + 1 >= max {
                break;
            }
        }
        current = read()?;
    }
    #[allow(clippy::useless_conversion)]
    // `rlim_t` is `u64` on the supported targets, narrower elsewhere
    u64::try_from(current.rlim_cur).ok()
}

#[cfg(unix)]
fn read() -> Option<libc::rlimit> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `limit` is a live, writable rlimit for the duration of the call.
    (unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } == 0).then_some(limit)
}

/// Windows has no per-process descriptor limit of this kind (handles are bounded by memory): nothing to raise.
#[cfg(not(unix))]
pub fn raise_open_files() -> Option<u64> {
    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    #[allow(clippy::useless_conversion)] // `rlim_t` is `u64` here
    fn the_soft_limit_is_raised_towards_the_hard_one() {
        let before = read().unwrap();
        let low = libc::rlimit {
            rlim_cur: before.rlim_max.min(256),
            rlim_max: before.rlim_max,
        };
        // SAFETY: `low` is a live, initialised rlimit that the call only reads.
        assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &low) }, 0);
        let raised = raise_open_files().unwrap();
        let after = read().unwrap();
        assert_eq!(
            u64::try_from(after.rlim_cur).ok(),
            Some(raised),
            "the limit in force"
        );
        assert_eq!(
            after.rlim_max, before.rlim_max,
            "the hard limit is left alone"
        );
        if before.rlim_max == libc::RLIM_INFINITY || before.rlim_max > 256 {
            assert!(raised > 256, "raised from the launchd default ({raised})");
        }
        if before.rlim_max != libc::RLIM_INFINITY {
            assert_eq!(
                after.rlim_cur, before.rlim_max,
                "a finite hard limit is taken whole"
            );
        }
        assert_eq!(
            raise_open_files(),
            Some(raised),
            "raising again changes nothing"
        );
    }
}
