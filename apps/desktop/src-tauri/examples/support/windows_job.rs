//! Test-only process-tree ownership. The launcher stays outside the job.
use std::{
    ffi::c_void,
    mem::{size_of, zeroed},
    path::Path,
    ptr::{null, null_mut},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE, INVALID_HANDLE_VALUE,
        WAIT_OBJECT_0,
    },
    System::{
        Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE},
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
            JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation,
            QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_BASIC_PROCESS_ID_LIST,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{
            CreateProcessW, GetCurrentProcess, GetExitCodeProcess, ResumeThread, TerminateProcess,
            WaitForSingleObject, CREATE_SUSPENDED, INFINITE, PROCESS_INFORMATION,
            STARTF_USESTDHANDLES, STARTUPINFOW,
        },
    },
};

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn owned(handle: HANDLE, reason: &'static str) -> Result<Handle, &'static str> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        Err(reason)
    } else {
        Ok(Handle(handle))
    }
}
fn inherit_standard(which: u32) -> Result<Handle, &'static str> {
    let mut duplicate = null_mut();
    let process = unsafe { GetCurrentProcess() };
    if unsafe {
        DuplicateHandle(
            process,
            GetStdHandle(which),
            process,
            &mut duplicate,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err("FIXTURE_JOB_STDIO_FAILED");
    }
    owned(duplicate, "FIXTURE_JOB_STDIO_FAILED")
}

pub struct Job(Handle);
impl Job {
    pub fn create() -> Result<Self, &'static str> {
        let job = Self(owned(
            unsafe { CreateJobObjectW(null(), null()) },
            "FIXTURE_JOB_CREATE_FAILED",
        )?);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.0 .0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err("FIXTURE_JOB_LIMIT_FAILED");
        }
        Ok(job)
    }
    pub fn launch(&self, executable: &Path, args: &[String]) -> Result<Process, &'static str> {
        let exe = executable
            .to_str()
            .ok_or("FIXTURE_JOB_EXECUTABLE_INVALID")?;
        let application: Vec<u16> = exe.encode_utf16().chain([0]).collect();
        let mut command: Vec<u16> = super::command_line(exe, args)
            .encode_utf16()
            .chain([0])
            .collect();
        let input = inherit_standard(STD_INPUT_HANDLE)?;
        let output = inherit_standard(STD_OUTPUT_HANDLE)?;
        let errors = inherit_standard(STD_ERROR_HANDLE)?;
        let mut startup: STARTUPINFOW = unsafe { zeroed() };
        startup.cb = size_of::<STARTUPINFOW>() as u32;
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = input.0;
        startup.hStdOutput = output.0;
        startup.hStdError = errors.0;
        let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
        // Do not resume before assignment: even early WebView children inherit this job.
        if unsafe {
            CreateProcessW(
                application.as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_SUSPENDED,
                null(),
                null(),
                &startup,
                &mut process,
            )
        } == 0
        {
            return Err("FIXTURE_JOB_SPAWN_FAILED");
        }
        let child = Process(Handle(process.hProcess));
        let thread = Handle(process.hThread);
        if unsafe { AssignProcessToJobObject(self.0 .0, child.0 .0) } == 0 {
            unsafe {
                TerminateProcess(child.0 .0, 2);
                WaitForSingleObject(child.0 .0, INFINITE);
            }
            return Err("FIXTURE_JOB_ASSIGN_FAILED");
        }
        if unsafe { ResumeThread(thread.0) } == u32::MAX {
            self.terminate()?;
            return Err("FIXTURE_JOB_RESUME_FAILED");
        }
        Ok(child)
    }
    pub fn active(&self) -> Result<u32, &'static str> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        if unsafe {
            QueryInformationJobObject(
                self.0 .0,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut c_void,
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            )
        } == 0
        {
            return Err("FIXTURE_JOB_ACCOUNTING_FAILED");
        }
        Ok(info.ActiveProcesses)
    }
    pub fn drain(&self, budget: Duration) -> Result<bool, &'static str> {
        let deadline = Instant::now() + budget;
        loop {
            if self.active()? == 0 {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            std::thread::sleep(
                Duration::from_millis(20).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
    }
    pub fn terminate(&self) -> Result<(), &'static str> {
        if unsafe { TerminateJobObject(self.0 .0, 2) } == 0 {
            Err("FIXTURE_JOB_TERMINATE_FAILED")
        } else {
            Ok(())
        }
    }
    pub fn remaining(&self) -> Result<String, &'static str> {
        // Aligned storage for the variable-size PID list; diagnostics never enumerate paths/command lines.
        let mut storage = vec![0usize; 1026];
        let list = storage.as_mut_ptr() as *mut JOBOBJECT_BASIC_PROCESS_ID_LIST;
        if unsafe {
            QueryInformationJobObject(
                self.0 .0,
                JobObjectBasicProcessIdList,
                list.cast(),
                (storage.len() * size_of::<usize>()) as u32,
                null_mut(),
            )
        } == 0
        {
            return Err("FIXTURE_JOB_PROCESS_LIST_FAILED");
        }
        let count = unsafe { (*list).NumberOfProcessIdsInList as usize };
        if count > 1024 {
            return Err("FIXTURE_JOB_PROCESS_LIST_FAILED");
        }
        let ids = unsafe {
            std::slice::from_raw_parts(
                std::ptr::addr_of!((*list).ProcessIdList).cast::<usize>(),
                count,
            )
        };
        let snapshot = owned(
            unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) },
            "FIXTURE_JOB_PROCESS_SNAPSHOT_FAILED",
        )?;
        let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut rows = std::collections::BTreeMap::new();
        let mut found = unsafe { Process32FirstW(snapshot.0, &mut entry) };
        while found != 0 {
            if ids.contains(&(entry.th32ProcessID as usize)) {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let image = super::image_name(&String::from_utf16_lossy(&entry.szExeFile[..len]));
                rows.insert(
                    entry.th32ProcessID,
                    format!(
                        "{image}:{}:{}",
                        entry.th32ProcessID, entry.th32ParentProcessID
                    ),
                );
            }
            found = unsafe { Process32NextW(snapshot.0, &mut entry) };
        }
        Ok(ids
            .iter()
            .map(|&id| {
                rows.remove(&(id as u32))
                    .unwrap_or_else(|| format!("unavailable:{id}:0"))
            })
            .collect::<Vec<_>>()
            .join(","))
    }
}
pub struct Process(Handle);
impl Process {
    #[cfg(test)]
    pub fn exited_within(&self, budget: Duration) -> bool {
        unsafe {
            WaitForSingleObject(self.0 .0, budget.as_millis().min(u32::MAX as u128) as u32)
                == WAIT_OBJECT_0
        }
    }
    pub fn wait(self) -> Result<u32, &'static str> {
        if unsafe { WaitForSingleObject(self.0 .0, INFINITE) } != WAIT_OBJECT_0 {
            return Err("FIXTURE_JOB_PRIMARY_WAIT_FAILED");
        }
        let mut code = 0;
        if unsafe { GetExitCodeProcess(self.0 .0, &mut code) } == 0 {
            return Err("FIXTURE_JOB_PRIMARY_EXIT_FAILED");
        }
        Ok(code)
    }
}

pub fn run(executable: &Path, args: &[String]) -> Result<u32, &'static str> {
    let job = Job::create()?;
    let outcome = (|| {
        let code = job.launch(executable, args)?.wait()?;
        if code != 0 {
            return Ok(code);
        }
        // The primary's guarded confirmed Quit completed and the host exited.
        // Close-hides/minimizes never reach this point.
        if job.drain(Duration::from_secs(10))? {
            return Ok(0);
        }
        let remaining = job.remaining().unwrap_or_else(|reason| reason.to_owned());
        eprintln!("FIXTURE_JOB_DRAIN_TIMEOUT remaining={remaining}");
        Ok(2)
    })();
    if job.active()? != 0 {
        job.terminate()?;
        // Termination is a separate bounded disposal check, never a successful drain.
        if !job.drain(Duration::from_secs(10))? {
            return Err("FIXTURE_JOB_TERMINATION_UNCONFIRMED");
        }
    }
    eprintln!("FIXTURE_JOB_SAFE_TO_DELETE active=0");
    outcome
}
