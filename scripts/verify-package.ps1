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
  'README.md'
)
$expectedEntries = @($runtimeFiles | ForEach-Object { "$artifactName/$($_.Replace('\', '/'))" })

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
