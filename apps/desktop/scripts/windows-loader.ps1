# Public loader metadata in an isolated child. No resolved export is invoked.
param([Parameter(Mandatory=$true)][string]$InputPath, [string]$ProgressPath)
$ErrorActionPreference = 'Stop'
$stage = 'entry'
$progressWriter = $null
$progressStream = $null
$script:serializerReady = $false
$script:clock = [Diagnostics.Stopwatch]::StartNew()
# These callers pass fixed public phase literals only. No cmdlet/module autoload
# or JSON serializer may run before the first durable script-entry checkpoint.
function Write-LiteralPhase([string]$phase) {
  if ($null -eq $progressWriter) { return }
  $progressWriter.WriteLine('{"schema":1,"type":"phase","phase":"' + $phase + '","ms":' + $script:clock.ElapsedMilliseconds + '}')
  $progressWriter.Flush()
  $progressStream.Flush($true)
}
function Write-ProgressRecord($record) {
  if ($null -eq $progressWriter) { return }
  $record.schema = 1
  $record.ms = $script:clock.ElapsedMilliseconds
  if (-not $script:serializerReady) { Write-LiteralPhase 'serialization-begin' }
  $json = $record | ConvertTo-Json -Depth 6 -Compress
  if (-not $script:serializerReady) {
    Write-LiteralPhase 'serialization-end'
    $script:serializerReady = $true
    $record.ms = $script:clock.ElapsedMilliseconds
    $json = $record | ConvertTo-Json -Depth 6 -Compress
  }
  $progressWriter.WriteLine($json)
  $progressWriter.Flush()
  $progressStream.Flush($true)
}
function Write-Phase([string]$phase, [string]$dll = '', $symbol = $null) {
  $record = @{ type = 'phase'; phase = $phase }
  if ($dll) { $record.dll = $dll }
  if ($null -ne $symbol) {
    if ($null -ne $symbol.name) { $record.name = [string]$symbol.name }
    else { $record.ordinal = [int]$symbol.ordinal }
  }
  Write-ProgressRecord $record
}
try {
  if ($ProgressPath) {
    # Every complete line is durably flushed before entering another boundary.
    # No environment, exception message, pointer or arbitrary request field is logged.
    $progressStream = [IO.FileStream]::new($ProgressPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $progressWriter = [IO.StreamWriter]::new($progressStream, [Text.UTF8Encoding]::new($false))
  }
  Write-LiteralPhase 'script-entry'
  $stage = 'input'

  Write-LiteralPhase 'input-read-begin'
  $requestJson = [IO.File]::ReadAllText($InputPath)
  Write-LiteralPhase 'input-read-end'
  # Isolate installed system-module loading from the JSON cmdlet body. This
  # bypasses module-path discovery, not a failure or an import-error check.
  Write-LiteralPhase 'utility-module-begin'
  $utilityManifest = $PSHOME + '\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1'
  Microsoft.PowerShell.Core\Import-Module -Name $utilityManifest -NoClobber -ErrorAction Stop
  Write-LiteralPhase 'utility-module-end'
  Write-LiteralPhase 'input-parse-begin'
  $request = $requestJson | ConvertFrom-Json
  Write-LiteralPhase 'input-parsed'
  # These paths come only from the Node caller's permitted-root decision, after
  # loader observations have already been persisted. Each optional read is local.
  if ($request.operation -eq 'file-versions') {
    $versions = @()
    foreach ($path in $request.paths) {
      $version = [ordered]@{ path = $path; fileVersion = $null; status = 'version-metadata-unavailable' }
      try {
        $version.fileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileVersion
        $version.status = 'read'
      } catch { # Optional version failure must never discard loader observations.
      }
      $versions += $version
    }
    [Console]::Out.Write((@{ schema = 1; versions = $versions } | ConvertTo-Json -Depth 4 -Compress))
    exit 0
  }
  $stage = 'compile'
  Write-Phase 'compile-begin'
  # Emit interop entirely in memory: no CodeDom/csc process or temporary DLL.
  $assemblyName = [Reflection.AssemblyName]::new('NativeSpikeLoaderAssembly')
  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $moduleBuilder = $assembly.DefineDynamicModule('NativeSpikeLoaderModule')
  $typeBuilder = $moduleBuilder.DefineType('NativeSpikeLoader', [Reflection.TypeAttributes]'Public, Abstract, Sealed')
  function Define-NativeMethod([string]$name, [string]$dll, [string]$entry, [Type]$result, [Type[]]$parameters, [Runtime.InteropServices.CharSet]$charset, [bool]$lastError) {
    $method = $typeBuilder.DefinePInvokeMethod($name, $dll, $entry,
      [Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [Reflection.CallingConventions]::Standard,
      $result, $parameters, [Runtime.InteropServices.CallingConvention]::Winapi, $charset)
    $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
    $attribute = [Runtime.InteropServices.DllImportAttribute]
    $fields = [Reflection.FieldInfo[]]@($attribute.GetField('SetLastError'), $attribute.GetField('ExactSpelling'), $attribute.GetField('CharSet'), $attribute.GetField('EntryPoint'))
    $values = [object[]]@($lastError, $true, $charset, $entry)
    $constructor = $attribute.GetConstructor([Type[]]@([string]))
    $method.SetCustomAttribute([Reflection.Emit.CustomAttributeBuilder]::new($constructor, [object[]]@($dll), $fields, $values))
  }
  $unicode = [Runtime.InteropServices.CharSet]::Unicode
  $ansi = [Runtime.InteropServices.CharSet]::Ansi
  Define-NativeMethod 'LoadLibraryExW' 'kernel32.dll' 'LoadLibraryExW' ([IntPtr]) @([string],[IntPtr],[uint32]) $unicode $true
  Define-NativeMethod 'GetModuleHandleW' 'kernel32.dll' 'GetModuleHandleW' ([IntPtr]) @([string]) $unicode $true
  Define-NativeMethod 'GetModuleFileNameW' 'kernel32.dll' 'GetModuleFileNameW' ([uint32]) @([IntPtr],[Text.StringBuilder],[int]) $unicode $true
  Define-NativeMethod 'GetMappedFileNameW' 'psapi.dll' 'GetMappedFileNameW' ([uint32]) @([IntPtr],[IntPtr],[Text.StringBuilder],[int]) $unicode $true
  Define-NativeMethod 'QueryDosDeviceW' 'kernel32.dll' 'QueryDosDeviceW' ([uint32]) @([string],[Text.StringBuilder],[int]) $unicode $true
  Define-NativeMethod 'GetProcAddress' 'kernel32.dll' 'GetProcAddress' ([IntPtr]) @([IntPtr],[string]) $ansi $true
  Define-NativeMethod 'GetProcAddressOrdinal' 'kernel32.dll' 'GetProcAddress' ([IntPtr]) @([IntPtr],[IntPtr]) $ansi $true
  Define-NativeMethod 'SetDllDirectoryW' 'kernel32.dll' 'SetDllDirectoryW' ([bool]) @([string]) $unicode $true
  Define-NativeMethod 'IsWow64Process2' 'kernel32.dll' 'IsWow64Process2' ([bool]) @([IntPtr], [uint16].MakeByRefType(), [uint16].MakeByRefType()) $unicode $true
  Define-NativeMethod 'GetCurrentProcess' 'kernel32.dll' 'GetCurrentProcess' ([IntPtr]) @() $unicode $false
  Define-NativeMethod 'FreeLibrary' 'kernel32.dll' 'FreeLibrary' ([bool]) @([IntPtr]) $unicode $false
  Define-NativeMethod 'SetErrorMode' 'kernel32.dll' 'SetErrorMode' ([uint32]) @([uint32]) $unicode $false
  $native = $typeBuilder.CreateType()
  function Get-NativePath([IntPtr]$handle) {
    if ($handle -eq [IntPtr]::Zero) { return $null }
    $path = [Text.StringBuilder]::new(32768)
    if ($native::GetModuleFileNameW($handle, $path, $path.Capacity) -eq 0) { return $null }
    return $path.ToString()
  }
  function Get-NativeImagePath([IntPtr]$handle) {
    $path = [Text.StringBuilder]::new(32768)
    $address = [IntPtr]($handle.ToInt64() -band -4L)
    if ($native::GetMappedFileNameW($native::GetCurrentProcess(), $address, $path, $path.Capacity) -eq 0) { return $null }
    $nativePath = $path.ToString()
    for ($letter = 65; $letter -le 90; $letter++) {
      $device = [Text.StringBuilder]::new(32768)
      $drive = ([char]$letter).ToString() + ':'
      if ($native::QueryDosDeviceW($drive, $device, $device.Capacity) -eq 0) { continue }
      $prefix = $device.ToString()
      if ($nativePath.StartsWith($prefix + '\', [StringComparison]::OrdinalIgnoreCase)) {
        return $drive + $nativePath.Substring($prefix.Length)
      }
    }
    return $null
  }
  Write-Phase 'compile-end'
  $stage = 'architecture'
  Write-Phase 'architecture-begin'
  [UInt16]$processMachine = 0
  [UInt16]$nativeMachine = 0
  if (-not $native::IsWow64Process2($native::GetCurrentProcess(), [ref]$processMachine, [ref]$nativeMachine)) {
    throw 'machine-query-failed'
  }
  $machine = if ($processMachine -eq 0) { $nativeMachine } else { $processMachine }
  Write-ProgressRecord @{ type = 'phase'; phase = 'architecture-end'; machine = [int]$machine }
  $result = [ordered]@{ schema = 1; machine = [int]$machine; targetMachine = [int]$request.machine;
    architectureMatches = ($machine -eq $request.machine); resolver = 'LoadLibraryExW+GetProcAddress; failed loads use image-resource metadata mapping';
    searchContext = 'Separate PowerShell process; target executable directory via SetDllDirectoryW; previously loaded modules recorded'; modules = @() }
  if ($result.architectureMatches) {
    $stage = 'search'
    Write-Phase 'search-begin'
    # Suppress modal loader-error UI in this disposable helper process only.
    [void]$native::SetErrorMode(3)
    if (-not $native::SetDllDirectoryW($request.executableDirectory)) { throw 'dll-directory-failed' }
    Write-Phase 'search-end'
    $stage = 'modules'
    # Join-Path/Test-Path need the installed Management module. Keep discovery
    # separate from their bodies, using only PSHOME and fixed public checkpoints.
    Write-LiteralPhase 'management-module-begin'
    $managementManifest = $PSHOME + '\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1'
    Microsoft.PowerShell.Core\Import-Module -Name $managementManifest -NoClobber -ErrorAction Stop
    Write-LiteralPhase 'management-module-end'
    foreach ($item in $request.modules) {
      if ($item.dll -notmatch '^[a-zA-Z0-9_.-]+\.dll$' -or $item.dll.Contains('..')) { throw 'invalid-module-name' }
      Write-Phase 'module-begin' $item.dll
      Write-Phase 'candidate-begin' $item.dll
      $apiSet = $item.dll -match '^(api|ext)-ms-'
      $candidate = Join-Path $request.executableDirectory $item.dll
      Write-Phase 'candidate-end' $item.dll
      # API sets are virtual contracts. Always ask Windows; never test physical existence.
      $lookup = $item.dll
      if (-not $apiSet) {
        Write-Phase 'existence-begin' $item.dll
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $lookup = $candidate }
        Write-Phase 'existence-end' $item.dll
      }
      Write-Phase 'previous-begin' $item.dll
      $previous = Get-NativePath ($native::GetModuleHandleW($item.dll))
      Write-Phase 'previous-end' $item.dll
      Write-Phase 'load-begin' $item.dll
      $module = $native::LoadLibraryExW($lookup, [IntPtr]::Zero, 0)
      $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      Write-Phase 'load-end' $item.dll
      $executableMapping = $module -ne [IntPtr]::Zero
      $entry = [ordered]@{ dll = $item.dll; apiSet = [bool]$apiSet; lookup = $lookup;
        previouslyLoadedPath = $previous; resolvedPath = $null; loadError = $null; mappingError = $null;
        executableMapping = [bool]$executableMapping; fileVersion = $null; symbols = @() }
      if (-not $executableMapping) { $entry.loadError = $errorCode }
      Write-ProgressRecord @{ type = 'module'; dll = $entry.dll; lookup = $entry.lookup; resolvedPath = $entry.resolvedPath;
        previouslyLoadedPath = $entry.previouslyLoadedPath; executableMapping = $entry.executableMapping;
        loadError = $entry.loadError; mappingError = $entry.mappingError }
      if (-not $executableMapping) {
        # The public image-resource mode skips imports/initialization. Its actual
        # mapped path lets the Node parser inspect failing transitive imports.
        Write-Phase 'map-begin' $item.dll
        $module = $native::LoadLibraryExW($lookup, [IntPtr]::Zero, 0x20)
        if ($module -eq [IntPtr]::Zero) { $entry.mappingError = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
        Write-Phase 'map-end' $item.dll
        Write-ProgressRecord @{ type = 'module'; dll = $entry.dll; lookup = $entry.lookup; resolvedPath = $entry.resolvedPath;
          previouslyLoadedPath = $entry.previouslyLoadedPath; executableMapping = $entry.executableMapping;
          loadError = $entry.loadError; mappingError = $entry.mappingError }
      }
      if ($module -ne [IntPtr]::Zero) {
        try {
          Write-Phase 'path-begin' $item.dll
          $entry.resolvedPath = if ($executableMapping) { Get-NativePath $module } else { Get-NativeImagePath $module }
          Write-Phase 'path-end' $item.dll
          Write-ProgressRecord @{ type = 'module'; dll = $entry.dll; lookup = $entry.lookup; resolvedPath = $entry.resolvedPath;
            previouslyLoadedPath = $entry.previouslyLoadedPath; executableMapping = $entry.executableMapping;
            loadError = $entry.loadError; mappingError = $entry.mappingError }
          foreach ($symbol in $item.symbols) {
            Write-Phase 'symbol-begin' $item.dll $symbol
            $named = $null -ne $symbol.name
            $address = [IntPtr]::Zero
            $symbolError = $null
            if ($executableMapping) {
              $address = if ($named) { $native::GetProcAddress($module, [string]$symbol.name) }
                else { $native::GetProcAddressOrdinal($module, [IntPtr][int]$symbol.ordinal) }
              $symbolError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            }
            $fact = [ordered]@{ name = if ($named) { $symbol.name } else { $null };
              ordinal = if ($named) { $null } else { [int]$symbol.ordinal };
              found = if ($executableMapping) { $address -ne [IntPtr]::Zero } else { $null };
              error = if ($executableMapping -and $address -eq [IntPtr]::Zero) { $symbolError } else { $null } }
            $entry.symbols += $fact
            Write-ProgressRecord @{ type = 'symbol'; dll = $item.dll; name = $fact.name; ordinal = $fact.ordinal; found = $fact.found; error = $fact.error }
            Write-Phase 'symbol-end' $item.dll $symbol
          }
          Write-Phase 'cleanup-begin' $item.dll
        } finally { [void]$native::FreeLibrary($module) }
        Write-Phase 'cleanup-end' $item.dll
      }
      else {
        Write-ProgressRecord @{ type = 'module'; dll = $entry.dll; lookup = $entry.lookup; resolvedPath = $entry.resolvedPath;
          previouslyLoadedPath = $entry.previouslyLoadedPath; executableMapping = $entry.executableMapping;
          loadError = $entry.loadError; mappingError = $entry.mappingError }
      }
      Write-Phase 'module-end' $item.dll
      $result.modules += $entry
    }
    [void]$native::SetDllDirectoryW($null)
  }
  Write-Phase 'complete'
  [Console]::Out.Write(($result | ConvertTo-Json -Depth 12 -Compress))
  exit 0
} catch {
  # No environment or arbitrary exception text is exported.
  [Console]::Out.Write((@{schema=1; error='helper-failed'; stage=$stage; hresult=$_.Exception.HResult} | ConvertTo-Json -Compress))
  exit 2
}
finally {
  if ($null -ne $progressWriter) { $progressWriter.Dispose() }
  elseif ($null -ne $progressStream) { $progressStream.Dispose() }
}
