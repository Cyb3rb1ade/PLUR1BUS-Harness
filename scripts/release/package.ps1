# Arguments: VERSION TARGET BINARY CORE.tar.gz OUT.zip
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'package.mjs') @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
