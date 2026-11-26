# Run the wire libraries while the prebuilt test executables are available,
# before unrelated workspace suites can consume the Windows step deadline.
$ErrorActionPreference = 'Stop'
$packages = @(
    'providers', 'channels', 'voice-providers', 'media', 'documents', 'discovery',
    'webtools', 'mcp', 'a2a', 'canon', 'wire-fixtures', 'wire-log'
)
$packageArgs = foreach ($package in $packages) { '-p'; "plur1bus-$package" }
& cargo test --locked --no-fail-fast @packageArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$chrome = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) |
    Where-Object { $_ } |
    ForEach-Object { Join-Path $_ 'Google/Chrome/Application/chrome.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
if (!$chrome) {
    $chrome = (Get-Command chrome.exe -ErrorAction SilentlyContinue).Source
}
if (!$chrome) {
    Write-Host 'Chrome is unavailable on this runner. Native document rendering still requires Windows acceptance.'
    exit 0
}

$env:PLUR1BUS_CHROMIUM_BIN = $chrome
$env:PLUR1BUS_NODE = (Get-Command node.exe).Source
& cargo test --locked -p plur1bus-documents --test native_browser -- --ignored --test-threads=1
exit $LASTEXITCODE
