//! The process's open-file limit (P4-10 security review M2). A server that holds descriptors per client raises its soft
//! `RLIMIT_NOFILE` at start, as Node does for every process (`node::PlatformInit`): launchd starts processes with a soft
//! limit of 256, which a Rust server would otherwise keep, so the TypeScript core never had that ceiling and the Rust
//! front door did.

/// Raises the soft open-file limit as far as the hard limit allows, as Node does: to a finite hard limit; to the highest
/// value the kernel accepts, up to 2^20, when it is unlimited. A process can never use more than the kernel's per-process
/// cap (macOS `kern.maxfilesperproc`), so the target stops there; when the kernel refuses the target (macOS refuses a
/// soft limit above that cap even below a finite hard limit) the highest accepted value between the current soft limit
/// and the target is searched. Every path tries `setrlimit` at least once when the soft limit is below the target.
/// Returns how many descriptors the process can hold afterwards: the soft limit in force, or the per-process cap where a
/// soft limit above it was left in place (task review I6); `None` when the limit cannot be read.
#[cfg(unix)]
pub fn raise_open_files() -> Option<u64> {
    let current = read()?;
    let wanted: libc::rlim_t = if current.rlim_max == libc::RLIM_INFINITY {
        1 << 20
    } else {
        current.rlim_max
    };
    let target = per_process_cap().map_or(wanted, |cap| wanted.min(cap));
    if current.rlim_cur < target && !set_soft(target, current.rlim_max) {
        // `lo` is accepted (in force), `hi` refused.
        let (mut lo, mut hi) = (current.rlim_cur, target);
        while lo + 1 < hi {
            let mid = lo + (hi - lo) / 2;
            if set_soft(mid, current.rlim_max) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
    }
    let soft = read()?.rlim_cur;
    let usable = per_process_cap().map_or(soft, |cap| soft.min(cap));
    #[allow(clippy::useless_conversion)]
    // `rlim_t` is `u64` on the supported targets, narrower elsewhere
    u64::try_from(usable).ok()
}

#[cfg(unix)]
fn set_soft(soft: libc::rlim_t, hard: libc::rlim_t) -> bool {
    let limit = libc::rlimit {
        rlim_cur: soft,
        rlim_max: hard,
    };
    // SAFETY: `limit` is a live, initialised rlimit that the call only reads.
    unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) == 0 }
}

/// The most descriptors one process may hold, where the kernel caps it below the hard limit (macOS).
#[cfg(target_os = "macos")]
fn per_process_cap() -> Option<libc::rlim_t> {
    let mut value: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    // SAFETY: the name is a NUL-terminated C string; `value` and `size` are live and writable, `size` is `value`'s size,
    // and no new value is passed.
    let status = unsafe {
        libc::sysctlbyname(
            c"kern.maxfilesperproc".as_ptr(),
            std::ptr::from_mut(&mut value).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if status != 0 {
        return None;
    }
    libc::rlim_t::try_from(value).ok().filter(|&cap| cap > 0)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn per_process_cap() -> Option<libc::rlim_t> {
    None
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

// Tested in `tests/limits.rs`, each case in a child process of its own: a test here would change the limit of the whole
// test process while other tests run (fix round 1b F6).
