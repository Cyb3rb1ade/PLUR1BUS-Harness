//! One fullscreen terminal lease. Drop must restore even after partial initialization or an unwind.
use crossterm::{
    cursor::{Hide, Show},
    event::{DisableBracketedPaste, EnableBracketedPaste},
    style::ResetColor,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use std::io;

pub(super) struct TerminalGuard;
impl TerminalGuard {
    /// Acquire raw input, alternate screen and bracketed paste for this frontend thread only.
    pub fn enter() -> io::Result<Self> {
        let guard = Self;
        enable_raw_mode()?;
        crossterm::execute!(
            io::stdout(),
            EnterAlternateScreen,
            EnableBracketedPaste,
            Hide
        )?;
        Ok(guard)
    }
}
impl Drop for TerminalGuard {
    fn drop(&mut self) {
        // Cleanup also runs if initialization returned early. Closed terminals are best-effort; Drop never panics.
        let _ = crossterm::execute!(
            io::stdout(),
            DisableBracketedPaste,
            LeaveAlternateScreen,
            Show,
            ResetColor
        );
        let _ = disable_raw_mode();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        fs::File,
        io::{Read, Write},
        os::fd::{AsRawFd, FromRawFd},
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };

    struct Process(Child);
    impl Drop for Process {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[derive(Debug, PartialEq, Eq)]
    struct Attributes {
        input: libc::tcflag_t,
        output: libc::tcflag_t,
        control: libc::tcflag_t,
        local: libc::tcflag_t,
        chars: Vec<libc::cc_t>,
        input_speed: libc::speed_t,
        output_speed: libc::speed_t,
    }

    fn attributes(file: &File) -> Attributes {
        // Darwin sets PENDIN when ICANON returns. A normal queue query processes it without flushing input.
        // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/tty.c (FIONREAD / ttnread).
        let mut pending: libc::c_int = 0;
        // SAFETY: a live owned PTY descriptor and a valid writable integer for the documented ioctl result.
        assert_eq!(
            unsafe { libc::ioctl(file.as_raw_fd(), libc::FIONREAD, &mut pending) },
            0
        );
        let mut state = std::mem::MaybeUninit::<libc::termios>::uninit();
        // SAFETY: file owns a live PTY descriptor; tcgetattr initializes state on success.
        assert_eq!(
            unsafe { libc::tcgetattr(file.as_raw_fd(), state.as_mut_ptr()) },
            0
        );
        // SAFETY: the successful tcgetattr above initialized the complete termios value.
        let state = unsafe { state.assume_init() };
        Attributes {
            input: state.c_iflag,
            output: state.c_oflag,
            control: state.c_cflag,
            local: state.c_lflag,
            chars: state.c_cc.to_vec(),
            input_speed: state.c_ispeed,
            output_speed: state.c_ospeed,
        }
    }

    #[test]
    fn raw_mode_and_alternate_screen_are_restored_after_unwind_and_normal_exit() {
        const CHILD: &str = "PLUR1BUS_TUI_GUARD_CHILD";
        const NAME:&str="commands::code::tui::terminal::tests::raw_mode_and_alternate_screen_are_restored_after_unwind_and_normal_exit";
        if let Ok(mode) = std::env::var(CHILD) {
            {
                let _guard = TerminalGuard::enter().expect("terminal lease");
                io::stdout().write_all(b"TUI-GUARD-READY").expect("ready");
                io::stdout().flush().expect("flush");
                io::stdin().read_exact(&mut [0u8; 1]).expect("parent gate");
                if mode == "panic" {
                    panic!("intentional isolated terminal guard fixture");
                }
            }
            return;
        }
        for mode in ["normal", "panic"] {
            let (mut master, mut slave) = (-1, -1);
            let mut size = libc::winsize {
                ws_row: 24,
                ws_col: 100,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            // SAFETY: valid writable descriptor pointers, null optional name/termios and a live winsize pointer.
            assert_eq!(
                unsafe {
                    libc::openpty(
                        &mut master,
                        &mut slave,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        // libc accepts const on Linux and mutable on macOS.
                        &raw mut size,
                    )
                },
                0
            );
            for fd in [master, slave] {
                // SAFETY: openpty returned owned descriptors; prevent inheritance into unrelated test children.
                assert_ne!(
                    unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) },
                    -1
                );
            }
            // SAFETY: each distinct descriptor returned by successful openpty is transferred exactly once.
            let (mut master, slave) =
                unsafe { (File::from_raw_fd(master), File::from_raw_fd(slave)) };
            // SAFETY: master is an owned live descriptor; nonblocking reads make the process deadline enforceable.
            let old = unsafe { libc::fcntl(master.as_raw_fd(), libc::F_GETFL) };
            assert_ne!(old, -1);
            // SAFETY: preserve existing descriptor flags while adding nonblocking mode.
            assert_ne!(
                unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFL, old | libc::O_NONBLOCK) },
                -1
            );
            let before = attributes(&slave);
            let mut process = Process(
                Command::new(std::env::current_exe().expect("test executable"))
                    .args(["--exact", NAME, "--nocapture"])
                    .env(CHILD, mode)
                    .env("TERM", "xterm-256color")
                    .stdin(Stdio::from(slave.try_clone().expect("stdin")))
                    .stdout(Stdio::from(slave.try_clone().expect("stdout")))
                    .stderr(Stdio::from(slave.try_clone().expect("stderr")))
                    .spawn()
                    .expect("isolated guard child"),
            );
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut transcript = Vec::new();
            let mut released = false;
            let status = loop {
                let mut chunk = [0; 8192];
                match master.read(&mut chunk) {
                    Ok(count) => {
                        if transcript.len() < 1024 * 1024 {
                            transcript.extend_from_slice(&chunk[..count]);
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                    Err(e) if e.raw_os_error() == Some(libc::EIO) => {}
                    Err(e) => panic!("PTY read: {e}"),
                }
                if !released
                    && transcript
                        .windows(b"TUI-GUARD-READY".len())
                        .any(|w| w == b"TUI-GUARD-READY")
                {
                    assert_eq!(
                        attributes(&slave).local & (libc::ICANON | libc::ECHO),
                        0,
                        "raw mode was entered"
                    );
                    master.write_all(b"g").expect("release child");
                    released = true;
                }
                if let Some(status) = process.0.try_wait().expect("child status") {
                    break status;
                }
                assert!(Instant::now() < deadline, "guard child timed out");
                std::thread::sleep(Duration::from_millis(5));
            };
            let mut remaining = [0; 8192];
            while let Ok(count) = master.read(&mut remaining) {
                if count == 0 {
                    break;
                }
                if transcript.len() < 1024 * 1024 {
                    transcript.extend_from_slice(&remaining[..count]);
                }
            }
            assert!(released, "child reached raw-mode gate");
            assert_eq!(status.success(), mode == "normal");
            assert_eq!(
                attributes(&slave),
                before,
                "original termios restored after {mode}"
            );
            let shown = String::from_utf8_lossy(&transcript);
            for sequence in ["\x1b[?1049l", "\x1b[?2004l", "\x1b[?25h"] {
                assert!(
                    shown.contains(sequence),
                    "missing terminal restoration after {mode}: {shown}"
                );
            }
        }
    }
}
