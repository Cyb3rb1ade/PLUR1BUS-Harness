# PLUR1BUS one-line installer for Windows (spec §6.5, HB19). Windows PowerShell 5.1 or PowerShell 7.
#
#   & ([scriptblock]::Create((irm https://<release host>/install.ps1))) [setup flags]
#
# Reads the release feed ({channel}.json), takes native.binary[<target>], downloads the binary, verifies its SHA-256
# BEFORE anything runs, installs it to %LOCALAPPDATA%\PLUR1BUS\bin\plur1bus.exe and runs `plur1bus setup <flags>`.
# setup then verifies the Node runtime and the core payload against the hashes baked into the binary. A checksum
# mismatch, an unknown target or a feed without that target exit 1 with nothing installed. Needs no administrator
# rights and writes nothing outside the user's profile.
#
# Known limit (HB19, ADR-012): the feed's minisign signature is not checked here; the feed comes over HTTPS, and
# `plur1bus update --check` verifies the signature.
#
# Environment:
#   PLUR1BUS_CHANNEL        release channel (default: stable)
#   PLUR1BUS_INSTALL_FEED   feed URL; `{channel}` is replaced (default: https://updates.plur1bus.app/{channel}.json).
#                           https:// or file:// only.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# Every refusal throws; the top level prints the message, cleans up and exits 1 (never `exit` inside try/finally).
function Fail([string]$message) {
  throw [System.InvalidOperationException]::new($message)
}

# win-x64 | win-arm64, or $null outside the release matrix. PROCESSOR_ARCHITEW6432 is the real architecture when this
# shell runs under emulation (a 32-bit or x64 PowerShell on ARM64).
function Get-Target {
  $arch = $env:PROCESSOR_ARCHITEW6432
  if ([string]::IsNullOrEmpty($arch)) { $arch = $env:PROCESSOR_ARCHITECTURE }
  switch ($arch) {
    'AMD64' { return 'win-x64' }
    'ARM64' { return 'win-arm64' }
    default { return $null }
  }
}

# SHA-256 of <file>, lower-case hex, straight from .NET. Not Get-FileHash: in Windows PowerShell 5.1 that is a script
# function of the Microsoft.PowerShell.Utility module, and when 5.1 starts from pwsh 7 it inherits pwsh's PSModulePath,
# cannot load that module and reports "The term 'Get-FileHash' is not recognized".
function Get-Sha256([string]$file) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($file)
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

# Copies <uri> to <file>: https:// through Invoke-WebRequest, file:// from the local path.
function Get-Resource([string]$uri, [string]$file) {
  $u = [Uri]::new($uri)
  if ($u.Scheme -eq 'file') {
    # A local release (tests, air-gapped installs): LocalPath decodes the URL (%7E in an 8.3 name such as RUNNER~1).
    [System.IO.File]::Copy($u.LocalPath, $file, $true)
  } elseif ($u.Scheme -eq 'https') {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $u -OutFile $file -UseBasicParsing -MaximumRedirection 5
  } else {
    Fail "refusing to download over anything but https: $uri"
  }
}

$created = New-Object System.Collections.ArrayList
$tmp = $null
$feedFile = $null
$dest = $null
$ok = $false
try {
  $channel = $env:PLUR1BUS_CHANNEL
  if ([string]::IsNullOrEmpty($channel)) { $channel = 'stable' }
  if ($channel -notmatch '^[a-z0-9-]+$') { Fail "invalid channel: $channel" }
  $feedUrl = $env:PLUR1BUS_INSTALL_FEED
  if ([string]::IsNullOrEmpty($feedUrl)) { $feedUrl = 'https://updates.plur1bus.app/{channel}.json' }
  $feedUrl = $feedUrl.Replace('{channel}', $channel)

  $target = Get-Target
  if ($null -eq $target) {
    Fail "unsupported target windows/$($env:PROCESSOR_ARCHITECTURE): release builds exist for win-x64 and win-arm64"
  }

  if ([string]::IsNullOrEmpty($env:LOCALAPPDATA)) { Fail 'LOCALAPPDATA is not set' }
  $binDir = Join-Path $env:LOCALAPPDATA 'PLUR1BUS\bin'
  $dest = Join-Path $binDir 'plur1bus.exe'
  foreach ($d in @((Join-Path $env:LOCALAPPDATA 'PLUR1BUS'), $binDir)) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d | Out-Null; [void]$created.Add($d) }
  }
  $tmp = Join-Path $binDir "plur1bus.exe.tmp-$PID"
  $feedFile = Join-Path $binDir "plur1bus-feed.tmp-$PID"

  try { Get-Resource $feedUrl $feedFile } catch { Fail "could not read the release feed ${feedUrl}: $($_.Exception.Message)" }
  try { $feed = Get-Content -LiteralPath $feedFile -Raw | ConvertFrom-Json } catch { Fail "the release feed is not valid JSON: $($_.Exception.Message)" }

  $asset = $null
  if ($feed.PSObject.Properties['native'] -and $feed.native.PSObject.Properties['binary'] -and $feed.native.binary.PSObject.Properties[$target]) {
    $asset = $feed.native.binary.$target
  }
  if ($null -eq $asset -or -not $asset.PSObject.Properties['url'] -or -not $asset.PSObject.Properties['sha256']) {
    Fail "the release feed has no binary for $target"
  }
  $url = [string]$asset.url
  $want = ([string]$asset.sha256).ToLowerInvariant()
  if ($want -notmatch '^[0-9a-f]{64}$') { Fail "the release feed has no valid sha256 for $target" }

  [Console]::Error.WriteLine("plur1bus install: downloading $url ($target)")
  try { Get-Resource $url $tmp } catch { Fail "could not download ${url}: $($_.Exception.Message)" }
  $got = Get-Sha256 $tmp
  if ($got -ne $want) { Fail "checksum mismatch for ${url}: expected $want, got $got (nothing installed)" }

  Move-Item -LiteralPath $tmp -Destination $dest -Force
  $ok = $true
  [Console]::Error.WriteLine("plur1bus install: installed $dest (sha256 $got)")
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($null -eq $userPath -or ($userPath -split ';') -notcontains $binDir) {
    [Console]::Error.WriteLine("plur1bus install: add $binDir to your PATH")
  }
} catch {
  [Console]::Error.WriteLine("plur1bus install: $($_.Exception.Message)")
} finally {
  foreach ($f in @($tmp, $feedFile)) {
    if ($f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
  }
  if (-not $ok) {
    for ($i = $created.Count - 1; $i -ge 0; $i--) { Remove-Item -LiteralPath $created[$i] -Force -ErrorAction SilentlyContinue }
  }
}
if (-not $ok) { exit 1 }

& $dest setup @args
exit $LASTEXITCODE
