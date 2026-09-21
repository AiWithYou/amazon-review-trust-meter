[CmdletBinding()]
param(
  [string]$ZipPath,
  [switch]$Store
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $repoRoot 'manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$version = [string]$manifest.version
$artifactName = "amazon-review-trust-meter-v$version"
if ($Store) { $artifactName += '-chrome-web-store' }
$entryPrefix = if ($Store) { '' } else { "$artifactName/" }

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
  'store-assets/icon-128-v2.png',
  'README.md',
  'PRIVACY.md',
  'docs/ALGORITHM.md',
  'docs/AUDIT-2026-09-21.md',
  'LICENSE'
)
$expectedEntries = @($runtimeFiles | ForEach-Object { "$entryPrefix$($_.Replace('\', '/'))" })
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
    $entryName = "$entryPrefix$($relativePath.Replace('\', '/'))"
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
    if (-not $relativePath.EndsWith('.png')) {
      $sourceBytes = Get-NormalizedTextBytes -Bytes $sourceBytes
      $packagedBytes = Get-NormalizedTextBytes -Bytes $packagedBytes
    }
    $sourceHash = [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($sourceBytes))
    $packagedHash = [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($packagedBytes))
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
$checksumLines = @(Get-Content -LiteralPath $checksumPath | Where-Object { $_ -like "*  $artifactName.zip" })
$expectedChecksumLine = "$actualZipHash  $artifactName.zip"
if ($checksumLines.Count -ne 1 -or $checksumLines[0] -ne $expectedChecksumLine) {
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
