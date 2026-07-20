[CmdletBinding()]
param(
  [string]$ZipPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $repoRoot 'manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$version = [string]$manifest.version
$artifactName = "amazon-review-trust-meter-v$version"

if (-not $ZipPath) {
  $ZipPath = Join-Path $repoRoot "dist\$artifactName.zip"
}
$resolvedZipPath = (Resolve-Path -LiteralPath $ZipPath).Path

$runtimeFiles = @(
  'manifest.json',
  'scoring-base.js',
  'scoring-features.js',
  'scoring.js',
  'content.js',
  'styles.css',
  'README.md',
  'LICENSE'
)
$expectedEntries = @($runtimeFiles | ForEach-Object { "$artifactName/$($_.Replace('\', '/'))" })
$strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)

function Get-NormalizedTextBytes {
  param(
    [Parameter(Mandatory)]
    [byte[]]$Bytes
  )

  $text = $strictUtf8.GetString($Bytes)
  $normalizedText = $text.Replace("`r`n", "`n").Replace("`r", "`n")
  return $strictUtf8.GetBytes($normalizedText)
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($resolvedZipPath)
try {
  $actualEntries = @($archive.Entries | ForEach-Object { $_.FullName })
  $entryDiff = @(Compare-Object -ReferenceObject ($expectedEntries | Sort-Object) -DifferenceObject ($actualEntries | Sort-Object))
  if ($entryDiff.Count -ne 0) {
    $entryDiff | Format-Table | Out-String | Write-Output
    throw 'ZIP entries do not match the expected package contents.'
  }

  foreach ($relativePath in $runtimeFiles) {
    $entryName = "$artifactName/$($relativePath.Replace('\', '/'))"
    $entry = $archive.GetEntry($entryName)
    if ($null -eq $entry) {
      throw "ZIP entry is missing: $entryName"
    }

    $stream = $entry.Open()
    $memory = [System.IO.MemoryStream]::new()
    try {
      $stream.CopyTo($memory)
      $packagedBytes = $memory.ToArray()
    }
    finally {
      $memory.Dispose()
      $stream.Dispose()
    }

    $sourceBytes = [System.IO.File]::ReadAllBytes((Join-Path $repoRoot $relativePath))
    # Git may rewrite text line endings during a Windows checkout. Compare the
    # UTF-8 contents after newline normalization while still rejecting invalid
    # UTF-8, BOM changes, missing files, extra files, and other content changes.
    $sourceHash = [System.Convert]::ToHexString(
      [System.Security.Cryptography.SHA256]::HashData((Get-NormalizedTextBytes -Bytes $sourceBytes))
    )
    $packagedHash = [System.Convert]::ToHexString(
      [System.Security.Cryptography.SHA256]::HashData((Get-NormalizedTextBytes -Bytes $packagedBytes))
    )
    if ($sourceHash -ne $packagedHash) {
      throw "Packaged file does not match the source: $relativePath"
    }

    if ($relativePath -eq 'manifest.json') {
      $packagedManifest = [System.Text.Encoding]::UTF8.GetString($packagedBytes) | ConvertFrom-Json
      if ([string]$packagedManifest.version -ne $version) {
        throw "Packaged manifest version does not match source manifest: $($packagedManifest.version)"
      }
    }
  }
}
finally {
  $archive.Dispose()
}

$actualZipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedZipPath).Hash.ToLowerInvariant()
$checksumPath = Join-Path $repoRoot 'dist\SHA256SUMS.txt'
$checksumLine = (Get-Content -Raw -LiteralPath $checksumPath).Trim()
$expectedChecksumLine = "$actualZipHash  $artifactName.zip"
if ($checksumLine -ne $expectedChecksumLine) {
  throw 'SHA256SUMS.txt does not match the ZIP.'
}

$zipInfo = Get-Item -LiteralPath $resolvedZipPath
[pscustomobject]@{
  Zip = $zipInfo.FullName
  Bytes = $zipInfo.Length
  Entries = $expectedEntries.Count
  Version = $version
  SHA256 = $actualZipHash
} | Format-List
