//! Windows access checks and pipe I/O for the RPC endpoints (ruling S11): the current user's SID, the server of a
//! pipe, a pipe's DACL, the user-and-SYSTEM security descriptor, and overlapped pipe I/O with real deadlines.
//! The platform-neutral parts (the DACL entry, the "writable by others" rule, the SDDL) are in [`crate::acl`].
pub use crate::acl::{
    run_dir_sddl, run_writable_by_others, user_and_system_sddl, writable_by_others, DaclEntry,
};
use std::ffi::c_void;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    LocalFree, BOOL, ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_OPERATION_ABORTED, ERROR_PIPE_BUSY,
    ERROR_PIPE_NOT_CONNECTED, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    GetNamedSecurityInfoW, GetSecurityInfo, SetNamedSecurityInfoW, SetSecurityInfo,
    SDDL_REVISION_1, SE_FILE_OBJECT, SE_KERNEL_OBJECT,
};
use windows_sys::Win32::Security::{
    AclSizeInformation, GetAce, GetAclInformation, GetSecurityDescriptorControl,
    GetSecurityDescriptorDacl, GetTokenInformation, TokenUser, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL,
    ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    ReadFile, WriteFile, FILE_FLAG_OVERLAPPED, SECURITY_IDENTIFICATION,
};
use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
use windows_sys::Win32::System::SystemServices::{ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE};
use windows_sys::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, OpenProcessToken, WaitForSingleObject, INFINITE,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

/// Memory from `LocalAlloc` (SID strings, security descriptors), freed on drop.
struct Local(*mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the pointer came from an API documented to allocate it with LocalAlloc, and is freed once.
            unsafe { LocalFree(self.0) };
        }
    }
}
// SAFETY: the memory is plain data owned by this value alone.
unsafe impl Send for Local {}
unsafe impl Sync for Local {}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn sid_to_string(sid: PSID) -> io::Result<String> {
    let mut s: *mut u16 = std::ptr::null_mut();
    // SAFETY: `sid` points to a valid SID; on success `s` is a NUL-terminated string we free through `Local`.
    if unsafe { ConvertSidToStringSidW(sid, &mut s) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _free = Local(s.cast());
    // SAFETY: `s` is NUL-terminated; we read up to (not including) the NUL.
    let len = (0..).take_while(|&i| unsafe { *s.add(i) } != 0).count();
    // SAFETY: `len` u16s starting at `s` were just read above.
    Ok(String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(s, len)
    }))
}

/// The SID of the user this process runs as (`OpenProcessToken` + `GetTokenInformation(TokenUser)` +
/// `ConvertSidToStringSidW`), e.g. `S-1-5-21-…-1001`.
pub fn user_sid() -> io::Result<String> {
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: the pseudo-handle of this process; `token` receives a new handle we own.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `token` is a valid handle we own from here on.
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut len = 0u32;
    // SAFETY: a size query (null buffer, zero length); it fails with ERROR_INSUFFICIENT_BUFFER and sets `len`.
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            std::ptr::null_mut(),
            0,
            &mut len,
        )
    };
    if len == 0 {
        return Err(io::Error::last_os_error());
    }
    // u64 elements keep the buffer aligned for TOKEN_USER.
    let mut buf = vec![0u64; (len as usize).div_ceil(8)];
    // SAFETY: `buf` holds at least `len` bytes.
    let ok = unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buf.as_mut_ptr().cast(),
            len,
            &mut len,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the call filled `buf` with a TOKEN_USER whose SID points into `buf`, which outlives this use.
    let user = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
    sid_to_string(user.User.Sid)
}

/// The pid the OS names as the server of the pipe `h` is a client of (`GetNamedPipeServerProcessId`); `None` when it
/// cannot tell.
// A HANDLE is an opaque kernel handle that the OS validates on every call; nothing here dereferences it.
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub fn pipe_server_pid(h: HANDLE) -> Option<u32> {
    let mut pid: u32 = 0;
    // SAFETY: `h` is an open pipe client handle owned by the caller; `pid` is a live local.
    let ok = unsafe { GetNamedPipeServerProcessId(h, &mut pid) };
    (ok != 0 && pid != 0).then_some(pid)
}

/// A self-relative security descriptor built from SDDL, freed on drop.
pub struct SecurityDescriptor(Local);

impl SecurityDescriptor {
    pub fn from_sddl(sddl: &str) -> io::Result<Self> {
        let text = wide(sddl);
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: `text` is NUL-terminated; on success `sd` is LocalAlloc'd memory we own through `Local`.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text.as_ptr(),
                SDDL_REVISION_1,
                &mut sd,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(Local(sd)))
    }

    /// `D:P(A;;GA;;;<user SID>)(A;;GA;;;SY)`.
    pub fn user_and_system() -> io::Result<Self> {
        Self::from_sddl(&user_and_system_sddl(&user_sid()?))
    }

    /// For `CreateNamedPipeW`/`CreateFileW`: valid while `self` lives.
    pub fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0 .0,
            bInheritHandle: 0,
        }
    }

    fn dacl(&self) -> io::Result<*mut ACL> {
        let (mut present, mut defaulted): (BOOL, BOOL) = (0, 0);
        let mut dacl: *mut ACL = std::ptr::null_mut();
        // SAFETY: a valid descriptor; the DACL pointer points into it and lives as long as `self`.
        let ok = unsafe {
            GetSecurityDescriptorDacl(self.0 .0, &mut present, &mut dacl, &mut defaulted)
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        if present == 0 || dacl.is_null() {
            return Err(io::Error::other("the security descriptor has no DACL"));
        }
        Ok(dacl)
    }
}

/// Replaces the DACL of the open file `h` with full control for the user and SYSTEM only, protected from inheritance
/// (the Windows side of `0600`, ruling S3). The handle needs `WRITE_DAC`.
// A HANDLE is an opaque kernel handle that the OS validates on every call; nothing here dereferences it.
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub fn restrict_to_user(h: HANDLE) -> io::Result<()> {
    let sd = SecurityDescriptor::user_and_system()?;
    let dacl = sd.dacl()?;
    // SAFETY: `h` is an open file handle of the caller's; `dacl` lives in `sd` for the whole call.
    let r = unsafe {
        SetSecurityInfo(
            h,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            dacl,
            std::ptr::null(),
        )
    };
    if r != 0 {
        return Err(io::Error::from_raw_os_error(r as i32));
    }
    Ok(())
}

/// A path as a NUL-terminated UTF-16 string, unpaired surrogates included (no lossy conversion).
fn wide_path(path: &std::path::Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

/// Replaces the DACL of the file or directory at `path` with the one `sddl` describes, protected from inheritance
/// (`SetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION)`).
/// For a directory the call also propagates the new inheritable ACEs to the children already in it (those whose own
/// DACL is not protected). Used for `run/` at supervisor start (HB5) with [`run_dir_sddl`]. Fails on a volume without
/// ACLs (FAT, some network shares: `ERROR_NOT_SUPPORTED`) and when the caller may not write the DACL.
pub fn set_path_dacl(path: &std::path::Path, sddl: &str) -> io::Result<()> {
    let sd = SecurityDescriptor::from_sddl(sddl)?;
    let dacl = sd.dacl()?;
    let text = wide_path(path);
    // SAFETY: `text` is NUL-terminated; `dacl` points into `sd`, which lives for the whole call; owner, group and SACL
    // are not set (null) and not named in the security information flags.
    let r = unsafe {
        SetNamedSecurityInfoW(
            text.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            dacl,
            std::ptr::null(),
        )
    };
    if r != 0 {
        return Err(io::Error::from_raw_os_error(r as i32));
    }
    Ok(())
}

/// A file's DACL with what [`file_dacl_report`] leaves out: whether the descriptor is `SE_DACL_PROTECTED`, and each
/// ACE's flags (`OBJECT_INHERIT_ACE`, `CONTAINER_INHERIT_ACE`, `INHERITED_ACE`, … in [`crate::acl`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDacl {
    pub protected: bool,
    pub aces: Vec<(DaclEntry, u8)>,
}

/// [`file_dacl_report`] plus the descriptor's protection and every ACE's flags (`GetNamedSecurityInfoW`,
/// `GetSecurityDescriptorControl`).
pub fn file_dacl_detail(path: &std::path::Path) -> io::Result<FileDacl> {
    let text = wide_path(path);
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: as in `file_dacl_report`.
    let r = unsafe {
        GetNamedSecurityInfoW(
            text.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut sd,
        )
    };
    if r != 0 {
        return Err(io::Error::from_raw_os_error(r as i32));
    }
    let _free = Local(sd);
    let (mut control, mut revision) = (0u16, 0u32);
    // SAFETY: `sd` is the valid descriptor returned above; both outputs are live locals.
    if unsafe { GetSecurityDescriptorControl(sd, &mut control, &mut revision) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(FileDacl {
        protected: control & crate::acl::SE_DACL_PROTECTED != 0,
        aces: aces_from(dacl)?,
    })
}

/// The DACL of the pipe at `address`, read through a client handle (`GetSecurityInfo`). Opening the pipe takes one
/// server instance for a moment; the server sees a connection that closes without a request. A NULL DACL (everyone
/// may do anything) is reported as one `GENERIC_ALL` entry for Everyone (`S-1-1-0`).
pub fn pipe_dacl_report(address: &str) -> io::Result<Vec<DaclEntry>> {
    let start = Instant::now();
    let pipe = loop {
        // GENERIC_READ includes READ_CONTROL, which GetSecurityInfo needs, and nothing that could write.
        match std::fs::OpenOptions::new()
            .read(true)
            .security_qos_flags(SECURITY_IDENTIFICATION)
            .open(address)
        {
            Ok(f) => break f,
            Err(e)
                if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32)
                    && start.elapsed() < Duration::from_secs(2) =>
            {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(e) => return Err(e),
        }
    };
    dacl_of(pipe.as_raw_handle())
}

fn dacl_of(h: HANDLE) -> io::Result<Vec<DaclEntry>> {
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: `h` is an open handle with READ_CONTROL; `sd` is LocalAlloc'd and freed through `Local`; `dacl` points
    // into it.
    let r = unsafe {
        GetSecurityInfo(
            h,
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut sd,
        )
    };
    if r != 0 {
        return Err(io::Error::from_raw_os_error(r as i32));
    }
    let _free = Local(sd);
    dacl_entries_from(dacl)
}

/// The DACL of the file or directory at `path` (`GetNamedSecurityInfoW`, `SE_FILE_OBJECT`) — used for `run/` and its
/// token/pid files (ruling S11/H3-R17), as opposed to [`dacl_of`], which reads an already-open kernel object such as
/// a pipe. A NULL DACL (everyone may do anything) is reported as one `GENERIC_ALL` entry for Everyone (`S-1-1-0`).
pub fn file_dacl_report(path: &std::path::Path) -> io::Result<Vec<DaclEntry>> {
    let text = wide(&path.to_string_lossy());
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: `text` is NUL-terminated; on success `sd` is LocalAlloc'd memory we own through `Local`; `dacl` points
    // into it.
    let r = unsafe {
        GetNamedSecurityInfoW(
            text.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut sd,
        )
    };
    if r != 0 {
        return Err(io::Error::from_raw_os_error(r as i32));
    }
    let _free = Local(sd);
    dacl_entries_from(dacl)
}

/// Walks a DACL's ACEs into platform-neutral [`DaclEntry`] values, shared by [`dacl_of`] (an open kernel object) and
/// [`file_dacl_report`] (a path).
fn dacl_entries_from(dacl: *mut ACL) -> io::Result<Vec<DaclEntry>> {
    Ok(aces_from(dacl)?.into_iter().map(|(e, _)| e).collect())
}

/// Each allowed or denied ACE of `dacl` with its flags (`ACE_HEADER.AceFlags`); a NULL DACL as one flagless
/// `GENERIC_ALL` entry for Everyone.
fn aces_from(dacl: *mut ACL) -> io::Result<Vec<(DaclEntry, u8)>> {
    if dacl.is_null() {
        return Ok(vec![(
            DaclEntry {
                sid: "S-1-1-0".into(),
                mask: crate::acl::GENERIC_ALL,
                allow: true,
            },
            0,
        )]);
    }
    let mut info = ACL_SIZE_INFORMATION {
        AceCount: 0,
        AclBytesInUse: 0,
        AclBytesFree: 0,
    };
    // SAFETY: `dacl` is a valid ACL; `info` is a live local of the size passed.
    let ok = unsafe {
        GetAclInformation(
            dacl,
            (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
            std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut entries = Vec::new();
    for i in 0..info.AceCount {
        let mut ace: *mut c_void = std::ptr::null_mut();
        // SAFETY: `i` < AceCount; `ace` points into the ACL.
        if unsafe { GetAce(dacl, i, &mut ace) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: every ACE starts with an ACE_HEADER.
        let header = unsafe { &*(ace as *const ACE_HEADER) };
        let kind = u32::from(header.AceType);
        if kind != ACCESS_ALLOWED_ACE_TYPE && kind != ACCESS_DENIED_ACE_TYPE {
            continue; // object and callback ACEs do not occur on pipes or on run/'s files
        }
        // SAFETY: allowed and denied ACEs share the ACCESS_ALLOWED_ACE layout; the SID starts at `SidStart`.
        let a = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
        let sid = (&a.SidStart as *const u32).cast_mut().cast::<c_void>();
        entries.push((
            DaclEntry {
                sid: sid_to_string(sid)?,
                mask: a.Mask,
                allow: kind == ACCESS_ALLOWED_ACE_TYPE,
            },
            header.AceFlags,
        ));
    }
    Ok(entries)
}

/// A manual-reset event for one kind of overlapped operation.
fn new_event() -> io::Result<OwnedHandle> {
    // SAFETY: default security, manual reset, not signalled, unnamed.
    let h = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if h.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a new handle we own.
    Ok(unsafe { OwnedHandle::from_raw_handle(h) })
}

/// Starts one overlapped operation on `h` (`start` gets the `OVERLAPPED` to pass) and waits for it on `event` for at
/// most `timeout_ms` (`INFINITE`: no deadline). On a timeout the operation is cancelled with `CancelIoEx` and awaited,
/// so the `OVERLAPPED` never outlives the call; one that completed anyway still counts. Returns the bytes moved.
// A HANDLE is an opaque kernel handle that the OS validates on every call; nothing here dereferences it.
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub fn overlapped_op(
    h: HANDLE,
    event: HANDLE,
    timeout_ms: u32,
    start: impl FnOnce(*mut OVERLAPPED) -> BOOL,
) -> io::Result<u32> {
    // SAFETY: an all-zero OVERLAPPED is its documented initial state.
    let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
    ov.hEvent = event;
    let mut n: u32 = 0;
    if start(&mut ov) == 0 {
        let e = io::Error::last_os_error();
        if e.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
            return Err(e);
        }
        // SAFETY: `event` is a valid event handle.
        let waited = unsafe { WaitForSingleObject(event, timeout_ms) };
        if waited != WAIT_OBJECT_0 {
            let wait_failed = io::Error::last_os_error();
            // SAFETY: cancels exactly this operation, then waits for it to finish, so `ov` is not used afterwards.
            let completed = unsafe {
                CancelIoEx(h, &ov);
                GetOverlappedResult(h, &ov, &mut n, 1) != 0
            };
            if completed {
                return Ok(n);
            }
            let result = io::Error::last_os_error();
            return Err(after_cancel(waited == WAIT_TIMEOUT, wait_failed, result));
        }
    }
    // SAFETY: the operation has completed (synchronously, or the event is signalled).
    if unsafe { GetOverlappedResult(h, &ov, &mut n, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(n)
}

/// The error of an operation that was cancelled after its wait ended without it. Only a cancellation that took
/// (`ERROR_OPERATION_ABORTED`) means the deadline decided: a timed-out wait is then `TimedOut`, a failed wait its own
/// error. Anything else (e.g. `ERROR_BROKEN_PIPE`: the server closed meanwhile) is how the operation really ended.
fn after_cancel(timed_out: bool, wait_failed: io::Error, result: io::Error) -> io::Error {
    if result.raw_os_error() != Some(ERROR_OPERATION_ABORTED as i32) {
        return result;
    }
    if timed_out {
        io::Error::new(io::ErrorKind::TimedOut, "pipe deadline passed")
    } else {
        wait_failed
    }
}

/// An operation cancelled from another thread ([`OverlappedPipe::cancel_io`]) ends the stream: report it as
/// `ConnectionAborted`, never as a kind a `Read` loop would retry.
fn aborted_is_not_interrupted(e: io::Error) -> io::Error {
    if e.raw_os_error() == Some(ERROR_OPERATION_ABORTED as i32) {
        return io::Error::new(io::ErrorKind::ConnectionAborted, "pipe operation cancelled");
    }
    e
}

/// A pipe handle opened with `FILE_FLAG_OVERLAPPED`, read and written through [`overlapped_op`] so every operation
/// has a deadline and can be cancelled from another thread. One read and one write may run at the same time (each
/// has its own event); `&self` methods let an `Arc` share it between a reader, a writer and a closer.
pub struct OverlappedPipe {
    handle: OwnedHandle,
    read_event: OwnedHandle,
    write_event: OwnedHandle,
    /// The deadline of each read and write in ms; `INFINITE` for none.
    timeout_ms: AtomicU32,
}

impl OverlappedPipe {
    /// Takes a handle that was opened or created with `FILE_FLAG_OVERLAPPED`.
    pub fn new(handle: OwnedHandle) -> io::Result<Self> {
        Ok(Self {
            handle,
            read_event: new_event()?,
            write_event: new_event()?,
            timeout_ms: AtomicU32::new(INFINITE),
        })
    }

    /// Opens the client end of the pipe at `address`, retrying while every server instance is busy
    /// (`ERROR_PIPE_BUSY`) until `connect_timeout`. The open carries `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`
    /// (the default would be `SecurityImpersonation`): a squatter serving the name can identify this client but never
    /// act as it, not even before the server-pid check has run.
    pub fn connect(address: &str, connect_timeout: Duration) -> io::Result<Self> {
        let start = Instant::now();
        loop {
            match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(FILE_FLAG_OVERLAPPED)
                .security_qos_flags(SECURITY_IDENTIFICATION)
                .open(address)
            {
                Ok(f) => return Self::new(OwnedHandle::from(f)),
                Err(e)
                    if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32)
                        && start.elapsed() < connect_timeout =>
                {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(e) => return Err(e),
            }
        }
    }

    pub fn handle(&self) -> HANDLE {
        self.handle.as_raw_handle()
    }

    /// The deadline of every later read and write; `None` waits without one. A zero duration counts as 1 ms.
    pub fn set_timeout(&self, d: Option<Duration>) {
        let ms = d.map_or(INFINITE, |d| {
            d.as_millis().clamp(1, u128::from(INFINITE - 1)) as u32
        });
        self.timeout_ms.store(ms, Ordering::SeqCst);
    }

    /// Reads what is available (at least one byte, or 0 at the end of the stream: the other end closed or
    /// disconnected). A passed deadline is `ErrorKind::TimedOut`; a read cancelled by [`OverlappedPipe::cancel_io`]
    /// is `ErrorKind::ConnectionAborted`.
    pub fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let len = buf.len().min(u32::MAX as usize) as u32;
        let h = self.handle();
        let r = overlapped_op(
            h,
            self.read_event.as_raw_handle(),
            self.timeout_ms.load(Ordering::SeqCst),
            // SAFETY: `buf` outlives the operation (overlapped_op waits for it to finish).
            |ov| unsafe { ReadFile(h, buf.as_mut_ptr(), len, std::ptr::null_mut(), ov) },
        );
        match r {
            Ok(n) => Ok(n as usize),
            Err(e)
                if e.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32)
                    || e.raw_os_error() == Some(ERROR_PIPE_NOT_CONNECTED as i32) =>
            {
                Ok(0)
            }
            Err(e) => Err(aborted_is_not_interrupted(e)),
        }
    }

    /// Writes some of `buf`, under the same deadline as reads.
    pub fn write(&self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let len = buf.len().min(u32::MAX as usize) as u32;
        let h = self.handle();
        overlapped_op(
            h,
            self.write_event.as_raw_handle(),
            self.timeout_ms.load(Ordering::SeqCst),
            // SAFETY: `buf` outlives the operation (overlapped_op waits for it to finish).
            |ov| unsafe { WriteFile(h, buf.as_ptr(), len, std::ptr::null_mut(), ov) },
        )
        .map(|n| n as usize)
        .map_err(aborted_is_not_interrupted)
    }

    /// Cancels every operation pending on the handle, from any thread (`CancelIoEx(h, NULL)`).
    pub fn cancel_io(&self) {
        // SAFETY: the handle stays open for the call; a null OVERLAPPED means all of its operations.
        unsafe { CancelIoEx(self.handle(), std::ptr::null()) };
    }
}
