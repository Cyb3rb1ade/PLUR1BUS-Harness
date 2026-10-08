// Windows cannot reap an orphaned subtree with taskkill once its parent has exited. Launch the server suspended,
// assign it to a kill-on-close Job Object, then resume it. The job handle is not inherited by the server.
// PowerShell is an OS-provided native interop host, not a shell used to interpret the configured command.
import { join } from "node:path";

/** Microsoft CRT argv quoting, including embedded quotes and trailing backslashes. */
export function windowsArg(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}
const source = `
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class McpJob {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string reserved; public string desktop; public string title;
    public int x,y,xSize,ySize,xCount,yCount,fill,flags; public short show,reserved2;
    public IntPtr reservedPtr,stdin,stdout,stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESSINFO { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASICLIMIT {
    public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active;
    public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IOCOUNTERS { public ulong reads,writes,other,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDEDLIMIT {
    public BASICLIMIT basic; public IOCOUNTERS io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref EXTENDEDLIMIT limit,uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr sourceHandle,IntPtr targetProcess,out IntPtr targetHandle,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO startup,out PROCESSINFO process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int Run(string command) {
    IntPtr job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) return 125;
    PROCESSINFO child=new PROCESSINFO();
    IntPtr stdin=IntPtr.Zero,stdout=IntPtr.Zero,stderr=IntPtr.Zero;
    try {
      EXTENDEDLIMIT limits=new EXTENDEDLIMIT(); limits.basic.flags=0x2000;
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXTENDEDLIMIT)))) return 125;
      IntPtr self=GetCurrentProcess();
      // Ensure the PowerShell host's standard handles are inheritable by the suspended child.
      if(!DuplicateHandle(self,GetStdHandle(-10),self,out stdin,0,true,2)
        || !DuplicateHandle(self,GetStdHandle(-11),self,out stdout,0,true,2)
        || !DuplicateHandle(self,GetStdHandle(-12),self,out stderr,0,true,2)) return 125;
      STARTUPINFO si=new STARTUPINFO(); si.cb=Marshal.SizeOf(typeof(STARTUPINFO)); si.flags=0x100;
      si.stdin=stdin; si.stdout=stdout; si.stderr=stderr;
      if(!CreateProcess(null,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,4,IntPtr.Zero,null,ref si,out child)) return 125;
      if(!AssignProcessToJobObject(job,child.process)) { TerminateProcess(child.process,125); return 125; }
      if(ResumeThread(child.thread)==0xFFFFFFFF) { TerminateProcess(child.process,125); return 125; }
      WaitForSingleObject(child.process,0xFFFFFFFF); uint code; GetExitCodeProcess(child.process,out code); return (int)code;
    } finally {
      // Closing the last job handle kills every remaining descendant, including after a graceful server exit.
      CloseHandle(job); if(stdin!=IntPtr.Zero) CloseHandle(stdin); if(stdout!=IntPtr.Zero) CloseHandle(stdout); if(stderr!=IntPtr.Zero) CloseHandle(stderr);
      if(child.thread!=IntPtr.Zero) CloseHandle(child.thread); if(child.process!=IntPtr.Zero) CloseHandle(child.process);
    }
  }
}
`;
export function windowsJobCommand(command: string, args: string[], host: NodeJS.ProcessEnv): { command: string; args: string[] } {
  if (/\.(cmd|bat|ps1)$/i.test(command)) throw new Error("MCP stdio requires a native executable on Windows");
  const systemRoot = host.SYSTEMROOT ?? host.SystemRoot ?? "C:\\Windows";
  const native = command.includes("\\") || command.includes("/") || /\.exe$/i.test(command) ? command : command + ".exe";
  const payload = Buffer.from([native, ...args].map(windowsArg).join(" "), "utf8").toString("base64");
  const script = `$ErrorActionPreference='Stop'; try { Add-Type -TypeDefinition @'\n${source}\n'@; $command=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')); exit [McpJob]::Run($command) } catch { [Console]::Error.WriteLine('MCP Windows job launch failed'); exit 125 }`;
  return { command: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] };
}
