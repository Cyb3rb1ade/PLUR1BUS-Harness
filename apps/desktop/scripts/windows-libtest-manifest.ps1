# Installed SDK discovery and XML-only manifest preparation. Never edits a PE.
param([Parameter(Mandatory=$true)][string]$InputPath)
$ErrorActionPreference = 'Stop'
$stage = 'input'
$assemblyNamespace = 'urn:schemas-microsoft-com:asm.v1'

function Read-Manifest([string]$path) {
  if (([IO.FileInfo]::new($path)).Length -gt 262144) { throw 'manifest-size' }
  $settings = [Xml.XmlReaderSettings]::new()
  $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver = $null
  $reader = [Xml.XmlReader]::Create($path, $settings)
  try {
    $document = [Xml.XmlDocument]::new()
    $document.PreserveWhitespace = $true
    $document.XmlResolver = $null
    $document.Load($reader)
  } finally { $reader.Dispose() }
  if ($document.DocumentElement.LocalName -cne 'assembly' -or $document.DocumentElement.NamespaceURI -cne $assemblyNamespace) { throw 'manifest-root' }
  return ,$document
}

# Compare namespaced element/attribute/text content independently of XML formatting.
# Permissions, compatibility declarations and every other property are retained.
function Manifest-Model($node, [int]$depth = 0) {
  # The canonical model uses multiple JSON levels per XML level; stay below
  # ConvertTo-Json's depth limit so no property can be silently truncated.
  if ($depth -gt 32) { throw 'manifest-depth' }
  $attributes = @($node.Attributes | Where-Object { $_.NamespaceURI -ne 'http://www.w3.org/2000/xmlns/' } |
    Sort-Object NamespaceURI, LocalName | ForEach-Object { [ordered]@{ ns = $_.NamespaceURI; name = $_.LocalName; value = $_.Value } })
  $children = @(foreach ($child in $node.ChildNodes) {
    if ($child.NodeType -eq [Xml.XmlNodeType]::Element) { Manifest-Model $child ($depth + 1) }
    elseif ($child.NodeType -in @([Xml.XmlNodeType]::Text, [Xml.XmlNodeType]::CDATA) -and -not [string]::IsNullOrWhiteSpace($child.Value)) {
      [ordered]@{ text = $child.Value }
    }
  })
  return [ordered]@{ ns = $node.NamespaceURI; name = $node.LocalName; attributes = $attributes; children = $children }
}

function Manifest-Fingerprint($document) {
  return (Manifest-Model $document.DocumentElement | ConvertTo-Json -Depth 100 -Compress)
}

function Namespace-Manager($document) {
  $manager = [Xml.XmlNamespaceManager]::new($document.NameTable)
  $manager.AddNamespace('a', $assemblyNamespace)
  # XmlNamespaceManager is enumerable; return the manager itself.
  return ,$manager
}

function Common-Controls($document) {
  return @($document.DocumentElement.SelectNodes('a:dependency/a:dependentAssembly/a:assemblyIdentity[@name="Microsoft.Windows.Common-Controls"]', (Namespace-Manager $document)))
}

function Require-Generated-Dependency($document) {
  $root = $document.DocumentElement
  $identities = @(Common-Controls $document)
  if ($identities.Count -ne 1 -or $root.GetAttribute('manifestVersion') -cne '1.0' -or $root.SelectNodes('*').Count -ne 1) { throw 'generated-manifest-shape' }
  if (@($root.Attributes | Where-Object { $_.NamespaceURI -ne 'http://www.w3.org/2000/xmlns/' }).Count -ne 1) { throw 'generated-root-properties' }
  $identity = $identities[0]
  $expected = @{ type = 'win32'; name = 'Microsoft.Windows.Common-Controls'; version = '6.0.0.0'; processorArchitecture = '*'; publicKeyToken = '6595b64144ccf1df'; language = '*' }
  if ($identity.Attributes.Count -ne $expected.Count -or $identity.SelectNodes('*').Count -ne 0) { throw 'generated-identity-properties' }
  foreach ($key in $expected.Keys) {
    if ($identity.GetAttribute($key) -cne $expected[$key]) { throw 'generated-identity-value' }
  }
  $dependent = $identity.ParentNode
  $dependency = $dependent.ParentNode
  if ($dependent.Attributes.Count -ne 0 -or $dependent.SelectNodes('*').Count -ne 1 -or $dependency.Attributes.Count -ne 0 -or $dependency.SelectNodes('*').Count -ne 1) { throw 'generated-extra-properties' }
  return ,$dependency
}

try {
  $request = [IO.File]::ReadAllText($InputPath) | ConvertFrom-Json
  $stage = [string]$request.operation
  switch ($request.operation) {
    'discover' {
      if ($request.architecture -notin @('x64', 'arm64')) { throw 'unsupported-architecture' }
      $kit = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots').KitsRoot10
      if (-not $kit -or -not [IO.Directory]::Exists($kit)) { throw 'sdk-root-unavailable' }
      $versions = @(Get-ChildItem -LiteralPath (Join-Path $kit 'bin') -Directory | Where-Object { $_.Name -match '^10\.\d+\.\d+\.\d+$' } | Sort-Object { [version]$_.Name } -Descending)
      $tool = $null
      foreach ($version in $versions) {
        $candidate = Join-Path $version.FullName ($request.architecture + '\mt.exe')
        if ([IO.File]::Exists($candidate)) { $tool = $candidate; break }
      }
      if (-not $tool) { throw 'matching-sdk-tool-unavailable' }
      $result = @{ schema = 1; status = 'ready'; path = $tool; sdkRoot = $kit; fileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($tool).FileVersion }
    }
    'prepare' {
      $generated = Read-Manifest $request.generated
      $dependency = Require-Generated-Dependency $generated
      if ($request.original) {
        $original = Read-Manifest $request.original
        $existing = @(Common-Controls $original)
        if ($existing.Count -gt 0) {
          $reason = if (@($existing | Where-Object { $_.GetAttribute('version') -eq '6.0.0.0' }).Count -gt 0) { 'original-already-selects-common-controls-v6' } else { 'existing-common-controls-dependency' }
          $result = @{ schema = 1; status = 'no-experiment'; reason = $reason }
          break
        }
        $before = Manifest-Fingerprint $original
        [void]$original.DocumentElement.AppendChild($original.ImportNode($dependency, $true))
        $writerSettings = [Xml.XmlWriterSettings]::new()
        $writerSettings.Encoding = [Text.UTF8Encoding]::new($false)
        $writer = [Xml.XmlWriter]::Create($request.merged, $writerSettings)
        try { $original.Save($writer) } finally { $writer.Dispose() }
        $roundtrip = Read-Manifest $request.merged
        $added = @(Common-Controls $roundtrip)
        if ($added.Count -ne 1) { throw 'merged-dependency-ambiguous' }
        [void]$roundtrip.DocumentElement.RemoveChild($added[0].ParentNode.ParentNode)
        if ((Manifest-Fingerprint $roundtrip) -cne $before) { throw 'original-properties-changed' }
      } else {
        # Only the exact generated dependency-only manifest may start an absent manifest.
        [IO.File]::Copy($request.generated, $request.merged, $false)
      }
      $result = @{ schema = 1; status = 'prepared'; originalPropertiesPreserved = $true; dependency = 'Microsoft.Windows.Common-Controls/6.0.0.0' }
    }
    'verify' {
      $expected = Read-Manifest $request.expected
      $actual = Read-Manifest $request.actual
      if ((Manifest-Fingerprint $expected) -cne (Manifest-Fingerprint $actual)) { throw 'embedded-manifest-properties-changed' }
      $result = @{ schema = 1; status = 'equivalent' }
    }
    default { throw 'unsupported-operation' }
  }
  [Console]::Out.Write(($result | ConvertTo-Json -Depth 8 -Compress))
  exit 0
} catch {
  # Arbitrary exception strings, environment values and profile data are never emitted.
  [Console]::Out.Write((@{ schema = 1; status = 'failed'; stage = $stage; hresult = $_.Exception.HResult } | ConvertTo-Json -Compress))
  exit 2
}
