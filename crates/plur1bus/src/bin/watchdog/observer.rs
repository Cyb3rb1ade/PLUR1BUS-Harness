//! Test-only independent observer transport; never changes watchdog measurement decisions.
//! The SDK-built companion is owned by the diagnostic harness, outside the supervised group.

use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const MAGIC: u64 = 820_2026;
const PID_LIMIT: usize = 128;
const WAIT_MS: i32 = 1500;

#[link(name = "sandbox")]
unsafe extern "C" {
    fn sandbox_check(pid: libc::pid_t, operation: *const libc::c_char, filter: i32, ...) -> i32;
}

fn errno() -> i32 {
    io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

pub(super) fn monotonic() -> u64 {
    let mut now: libc::timespec = unsafe { std::mem::zeroed() };
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut now) } != 0 {
        return 0;
    }
    (now.tv_sec as u64)
        .saturating_mul(1_000_000_000)
        .saturating_add(now.tv_nsec as u64)
}

/// All requests/replies are eight native-endian u64s, one atomic pipe write, no strings.
pub(super) struct Observer {
    child: Child,
    pids: Vec<libc::pid_t>,
    dropped: usize,
    failed: bool,
    control: libc::pid_t,
    send_returned: isize,
    send_errno: i32,
    send_begin: u64,
    send_end: u64,
}

impl Observer {
    /// Starts only with the existing two trace gates and the explicit harness companion path.
    pub(super) fn start(trace: bool, report_fd: bool) -> Result<Option<Self>, String> {
        if !trace || std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() != Ok("1") {
            return Ok(None);
        }
        let Some(path) = std::env::var_os("PLUR1BUS_TEST_WATCHDOG_OBSERVER") else {
            return Ok(None);
        };
        let mut command = Command::new(path);
        command.stdin(Stdio::piped()).stdout(Stdio::piped());
        // These operations run before exec; no allocation or diagnostic formatting here.
        unsafe {
            command.pre_exec(move || {
                if report_fd {
                    libc::close(3);
                }
                if libc::setpgid(0, 0) != 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command
            .spawn()
            .map_err(|_| "watchdog observer unavailable")?;
        let mut observer = Self {
            child,
            pids: Vec::with_capacity(PID_LIMIT),
            dropped: 0,
            failed: false,
            control: 0,
            send_returned: 0,
            send_errno: 0,
            send_begin: 0,
            send_end: 0,
        };
        let fd = observer.input();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err("watchdog observer pipe unavailable".into());
        }
        let ready = observer
            .reply(0)
            .ok_or("watchdog observer handshake unavailable")?;
        let control =
            i32::try_from(ready[3]).map_err(|_| "watchdog observer identity unavailable")?;
        if ready[2] != observer.child.id() as u64 || control <= 0 || ready[4] != 0 {
            return Err("watchdog observer control unavailable".into());
        }
        observer.control = control;
        observer.local(unsafe { libc::getpid() }, 1);
        observer.local(control, 3);
        Ok(Some(observer))
    }

    fn input(&self) -> i32 {
        self.child
            .stdin
            .as_ref()
            .expect("owned observer input")
            .as_raw_fd()
    }

    /// Called only in the forked target: it must not retain either observer channel.
    pub(super) unsafe fn close_in_target(&self) {
        unsafe {
            libc::close(self.input());
            libc::close(
                self.child
                    .stdout
                    .as_ref()
                    .expect("owned observer output")
                    .as_raw_fd(),
            );
        }
    }

    fn send(&mut self, kind: u64, pid: libc::pid_t, sample: u64, role: u64) -> bool {
        let packet = [MAGIC, kind, pid as u64, sample, role, monotonic(), 0, 0];
        self.send_begin = packet[5];
        let returned = unsafe { libc::write(self.input(), packet.as_ptr().cast(), 64) };
        let error = errno();
        self.send_end = monotonic();
        self.send_returned = returned;
        self.send_errno = error;
        if returned != 64 {
            self.failed = true;
            self.dropped = self.dropped.saturating_add(1);
        }
        // No printing, retry, blocking, allocation or errno-dependent enforcement in a sample.
        returned == 64
    }

    /// First numeric sighting only; the companion retains identity and repeats all at the barrier.
    pub(super) fn observe(&mut self, pid: libc::pid_t, sample: u64, role: u64) {
        if pid <= 0 || self.pids.contains(&pid) {
            return;
        }
        if self.pids.len() == PID_LIMIT {
            self.dropped = self.dropped.saturating_add(1);
            self.failed = true;
            return;
        }
        self.pids.push(pid);
        self.send(1, pid, sample, role);
    }

    fn reply(&mut self, kind: u64) -> Option<[u64; 8]> {
        let deadline = Instant::now() + Duration::from_millis(WAIT_MS as u64);
        let fd = self.child.stdout.as_ref()?.as_raw_fd();
        let mut packet = [0u64; 8];
        let mut have = 0;
        while have < 64 {
            let left = deadline.checked_duration_since(Instant::now())?;
            let mut poll = libc::pollfd {
                fd,
                events: libc::POLLIN,
                revents: 0,
            };
            let returned =
                unsafe { libc::poll(&mut poll, 1, left.as_millis().min(WAIT_MS as u128) as i32) };
            let error = errno();
            if returned < 0 && error == libc::EINTR {
                continue;
            }
            if returned <= 0 {
                return None;
            }
            let returned = unsafe {
                libc::read(
                    fd,
                    packet.as_mut_ptr().cast::<u8>().add(have).cast(),
                    64 - have,
                )
            };
            let error = errno();
            if returned < 0 && error == libc::EINTR {
                continue;
            }
            if returned <= 0 {
                return None;
            }
            have += returned as usize;
        }
        (packet[0] == MAGIC && packet[1] == kind).then_some(packet)
    }

    /// Numeric final decision is recorded without influencing the original exit/status choice.
    pub(super) fn decision(
        &mut self,
        sample: u64,
        pid: libc::pid_t,
        code: i32,
        returned: i32,
        error: i32,
        elapsed: u64,
    ) {
        let packet = [
            MAGIC,
            6,
            sample,
            pid as u64,
            code as u64,
            returned as u64,
            error as u64,
            elapsed,
        ];
        let sent = unsafe { libc::write(self.input(), packet.as_ptr().cast(), 64) };
        let send_error = errno();
        if sent != 64 {
            self.failed = true;
            self.dropped = self.dropped.saturating_add(1);
            self.send_returned = sent;
            self.send_errno = send_error;
        }
    }

    /// Outside the timed scan, preserve its outcome and collect before the original group kill.
    pub(super) fn checkpoint(&mut self, phase: u64, group: libc::pid_t, sample: u64) {
        let begin = monotonic();
        self.local(unsafe { libc::getpid() }, 1);
        self.local(self.control, 3);
        self.send_local(
            5,
            group,
            i32::from(!self.failed),
            self.dropped.min(i32::MAX as usize) as i32,
            begin,
            monotonic(),
        );
        let sent = self.send(2, group, sample, phase);
        let reply = if sent { self.reply(2) } else { None };
        self.failed |= reply.is_none_or(|packet| packet[4] != 0);
        eprintln!(
            "sandbox watchdog independent: {{\"operation\":\"barrier\",\"phase\":{phase},\"pid\":{group},\"sample\":{sample},\"beginNs\":{begin},\"endNs\":{},\"complete\":{},\"dropped\":{},\"sendReturned\":{},\"sendErrno\":{},\"sendBeginNs\":{},\"sendEndNs\":{}}}",
            monotonic(),
            i32::from(!self.failed),
            self.dropped,
            self.send_returned,
            self.send_errno,
            self.send_begin,
            self.send_end
        );
    }

    fn local(&mut self, pid: libc::pid_t, role: u64) {
        let begin = monotonic();
        let sandbox = unsafe { sandbox_check(libc::getpid(), std::ptr::null(), 0) };
        let sandbox_errno = errno();
        self.send_local(
            1,
            unsafe { libc::getpid() },
            sandbox,
            sandbox_errno,
            begin,
            monotonic(),
        );
        eprintln!(
            "sandbox watchdog independent: {{\"operation\":\"self-sandbox\",\"pid\":{},\"role\":{role},\"returned\":{sandbox},\"errno\":{sandbox_errno},\"beginNs\":{begin},\"endNs\":{}}}",
            unsafe { libc::getpid() },
            monotonic()
        );
        let mut bsd: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let mut short: libc::proc_bsdshortinfo = unsafe { std::mem::zeroed() };
        let mut path = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        for (flavor, buffer, size) in [
            (
                libc::PROC_PIDTBSDINFO,
                (&mut bsd as *mut libc::proc_bsdinfo).cast(),
                std::mem::size_of_val(&bsd),
            ),
            (
                libc::PROC_PIDT_SHORTBSDINFO,
                (&mut short as *mut libc::proc_bsdshortinfo).cast(),
                std::mem::size_of_val(&short),
            ),
        ] {
            let begin = monotonic();
            let returned = unsafe { libc::proc_pidinfo(pid, flavor, 0, buffer, size as i32) };
            let error = errno();
            let operation = if flavor == libc::PROC_PIDTBSDINFO {
                2
            } else {
                3
            };
            self.send_local(operation, pid, returned, error, begin, monotonic());
            eprintln!(
                "sandbox watchdog independent: {{\"operation\":\"local-proc-info\",\"pid\":{pid},\"role\":{role},\"flavor\":{flavor},\"returned\":{returned},\"expected\":{size},\"errno\":{error},\"beginNs\":{begin},\"endNs\":{}}}",
                monotonic()
            );
        }
        let begin = monotonic();
        let returned =
            unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
        let error = errno();
        self.send_local(4, pid, returned, error, begin, monotonic());
        eprintln!(
            "sandbox watchdog independent: {{\"operation\":\"local-proc-path\",\"pid\":{pid},\"role\":{role},\"returned\":{returned},\"errno\":{error},\"beginNs\":{begin},\"endNs\":{}}}",
            monotonic()
        );
    }

    fn send_local(
        &mut self,
        operation: u64,
        pid: libc::pid_t,
        returned: i32,
        error: i32,
        begin: u64,
        end: u64,
    ) {
        let packet = [
            MAGIC,
            4,
            operation,
            pid as u64,
            returned as u64,
            error as u64,
            begin,
            end,
        ];
        let sent = unsafe { libc::write(self.input(), packet.as_ptr().cast(), 64) };
        let send_error = errno();
        if sent != 64 {
            self.send_returned = sent;
            self.send_errno = send_error;
            self.send_begin = begin;
            self.send_end = monotonic();
            self.failed = true;
            self.dropped = self.dropped.saturating_add(1);
        }
    }

    /// After enforcement, stop and reap only this diagnostic's separate observer group.
    pub(super) fn finish(&mut self) {
        let sent = self.send(3, 0, 0, 0);
        if sent {
            let _ = self.reply(3);
        }
        self.reap();
    }

    fn reap(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            unsafe {
                libc::kill(-(self.child.id() as i32), libc::SIGKILL);
            }
        }
        let _ = self.child.wait();
    }
}

impl Drop for Observer {
    fn drop(&mut self) {
        self.reap();
    }
}
