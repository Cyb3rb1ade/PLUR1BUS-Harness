# Public loader metadata in an isolated child. No resolved export is invoked.
param([Parameter(Mandatory=$true)][string]$InputPath)
$ErrorActionPreference = 'Stop'
$stage = 'compile'
try {
  $request = Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NativeSpikeLoader {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  public static extern IntPtr LoadLibraryExW(string name, IntPtr file, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  public static extern IntPtr GetModuleHandleW(string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  public static extern uint GetModuleFileNameW(IntPtr module, StringBuilder path, int size);
  [DllImport("psapi.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  public static extern uint GetMappedFileNameW(IntPtr process, IntPtr address, StringBuilder path, int size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  public static extern uint QueryDosDeviceW(string name, StringBuilder path, int size);
  [DllImport("kernel32.dll", CharSet=CharSet.Ansi, ExactSpelling=true, SetLastError=true)]
  public static extern IntPtr GetProcAddress(IntPtr module, string name);
  [DllImport("kernel32.dll", EntryPoint="GetProcAddress", ExactSpelling=true, SetLastError=true)]
  public static extern IntPtr GetProcAddressOrdinal(IntPtr module, IntPtr ordinal);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  public static extern bool SetDllDirectoryW(string path);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool IsWow64Process2(IntPtr process, out ushort machine, out ushort nativeMachine);
  [DllImport("kernel32.dll")]
  public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")]
  public static extern bool FreeLibrary(IntPtr module);
  [DllImport("kernel32.dll")]
  public static extern uint SetErrorMode(uint mode);
  public static string PathOf(IntPtr module) {
    if (module == IntPtr.Zero) return null;
    var path = new StringBuilder(32768);
    return GetModuleFileNameW(module, path, path.Capacity) == 0 ? null : path.ToString();
  }
  public static string ImagePathOf(IntPtr module) {
    var path = new StringBuilder(32768);
    // Resource handles tag the mapped address in the low two bits.
    var address = new IntPtr(module.ToInt64() & ~3L);
    if (GetMappedFileNameW(GetCurrentProcess(), address, path, path.Capacity) == 0) return null;
    var nativePath = path.ToString();
    for (char drive = 'A'; drive <= 'Z'; drive++) {
      var device = new StringBuilder(32768);
      var driveName = drive.ToString() + ":";
      if (QueryDosDeviceW(driveName, device, device.Capacity) == 0) continue;
      var prefix = device.ToString();
      if (nativePath.StartsWith(prefix + "\\", StringComparison.OrdinalIgnoreCase))
        return driveName + nativePath.Substring(prefix.Length);
    }
    return null;
  }
}
'@
  $stage = 'architecture'
  [UInt16]$processMachine = 0
  [UInt16]$nativeMachine = 0
  if (-not [NativeSpikeLoader]::IsWow64Process2([NativeSpikeLoader]::GetCurrentProcess(), [ref]$processMachine, [ref]$nativeMachine)) {
    throw 'machine-query-failed'
  }
  $machine = if ($processMachine -eq 0) { $nativeMachine } else { $processMachine }
  $result = [ordered]@{ schema = 1; machine = [int]$machine; targetMachine = [int]$request.machine;
    architectureMatches = ($machine -eq $request.machine); resolver = 'LoadLibraryExW+GetProcAddress; failed loads use image-resource metadata mapping';
    searchContext = 'Separate PowerShell process; target executable directory via SetDllDirectoryW; previously loaded modules recorded'; modules = @() }
  if ($result.architectureMatches) {
    # Suppress modal loader-error UI in this disposable helper process only.
    [void][NativeSpikeLoader]::SetErrorMode(3)
    $stage = 'search'
    if (-not [NativeSpikeLoader]::SetDllDirectoryW($request.executableDirectory)) { throw 'dll-directory-failed' }
    $stage = 'modules'
    foreach ($item in $request.modules) {
      if ($item.dll -notmatch '^[a-zA-Z0-9_.-]+\.dll$' -or $item.dll.Contains('..')) { throw 'invalid-module-name' }
      $apiSet = $item.dll -match '^(api|ext)-ms-'
      $candidate = Join-Path $request.executableDirectory $item.dll
      # API sets are virtual contracts. Always ask Windows; never test physical existence.
      $lookup = if (-not $apiSet -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $candidate } else { $item.dll }
      $previous = [NativeSpikeLoader]::PathOf([NativeSpikeLoader]::GetModuleHandleW($item.dll))
      $module = [NativeSpikeLoader]::LoadLibraryExW($lookup, [IntPtr]::Zero, 0)
      $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      $executableMapping = $module -ne [IntPtr]::Zero
      $entry = [ordered]@{ dll = $item.dll; apiSet = [bool]$apiSet; lookup = $lookup;
        previouslyLoadedPath = $previous; resolvedPath = $null; loadError = $null; mappingError = $null;
        executableMapping = [bool]$executableMapping; fileVersion = $null; symbols = @() }
      if (-not $executableMapping) {
        $entry.loadError = $errorCode
        # The public image-resource mode skips imports/initialization. Its actual
        # mapped path lets the Node parser inspect failing transitive imports.
        $module = [NativeSpikeLoader]::LoadLibraryExW($lookup, [IntPtr]::Zero, 0x20)
        if ($module -eq [IntPtr]::Zero) { $entry.mappingError = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
      }
      if ($module -ne [IntPtr]::Zero) {
        try {
          $entry.resolvedPath = if ($executableMapping) { [NativeSpikeLoader]::PathOf($module) } else { [NativeSpikeLoader]::ImagePathOf($module) }
          if ($entry.resolvedPath) {
            $entry.fileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($entry.resolvedPath).FileVersion
          }
          foreach ($symbol in $item.symbols) {
            $named = $null -ne $symbol.name
            $address = [IntPtr]::Zero
            $symbolError = $null
            if ($executableMapping) {
              $address = if ($named) { [NativeSpikeLoader]::GetProcAddress($module, [string]$symbol.name) }
                else { [NativeSpikeLoader]::GetProcAddressOrdinal($module, [IntPtr][int]$symbol.ordinal) }
              $symbolError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            }
            $entry.symbols += [ordered]@{ name = if ($named) { $symbol.name } else { $null };
              ordinal = if ($named) { $null } else { [int]$symbol.ordinal };
              found = if ($executableMapping) { $address -ne [IntPtr]::Zero } else { $null };
              error = if ($executableMapping -and $address -eq [IntPtr]::Zero) { $symbolError } else { $null } }
          }
        } finally { [void][NativeSpikeLoader]::FreeLibrary($module) }
      }
      $result.modules += $entry
    }
    [void][NativeSpikeLoader]::SetDllDirectoryW($null)
  }
  [Console]::Out.Write(($result | ConvertTo-Json -Depth 12 -Compress))
  exit 0
} catch {
  # No environment or arbitrary exception text is exported.
  [Console]::Out.Write((@{schema=1; error='helper-failed'; stage=$stage; hresult=$_.Exception.HResult} | ConvertTo-Json -Compress))
  exit 2
}
