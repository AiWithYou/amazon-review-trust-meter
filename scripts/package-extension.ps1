[CmdletBinding()]
param([switch]$Store)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $repoRoot 'manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$version = [string]$manifest.version

if ($version -notmatch '^\d+\.\d+\.\d+$') {
  throw "manifest.json contains an invalid version: $version"
}

$artifactName = "amazon-review-trust-meter-v$version"
if ($Store) { $artifactName += '-chrome-web-store' }
$distDir = Join-Path $repoRoot 'dist'
$zipPath = Join-Path $distDir "$artifactName.zip"
$checksumPath = Join-Path $distDir 'SHA256SUMS.txt'
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$stageRoot = [System.IO.Path]::GetFullPath((Join-Path $tempRoot "amazon-review-trust-meter-package-$([guid]::NewGuid().ToString('N'))"))
$packageRoot = Join-Path $stageRoot $artifactName

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

try {
  New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $distDir -Force | Out-Null

  foreach ($relativePath in $runtimeFiles) {
    $sourcePath = Join-Path $repoRoot $relativePath
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
      throw "Required package file is missing: $relativePath"
    }
    $destinationPath = Join-Path $packageRoot $relativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force | Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $destinationPath
  }

  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }

  if ($Store) {
    Compress-Archive -Path (Join-Path $packageRoot '*') -DestinationPath $zipPath -CompressionLevel Optimal
  } else {
    Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal
  }

  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
  $checksumLines = @()
  if (Test-Path -LiteralPath $checksumPath) {
    $checksumLines = @(Get-Content -LiteralPath $checksumPath | Where-Object { $_ -match "  amazon-review-trust-meter-v$([regex]::Escape($version))(?:-chrome-web-store)?\.zip$" -and $_ -notlike "*  $artifactName.zip" })
  }
  $checksumText = (($checksumLines + "$hash  $artifactName.zip" | Sort-Object) -join "`n") + "`n"
  [System.IO.File]::WriteAllText($checksumPath, $checksumText, [System.Text.UTF8Encoding]::new($false))

  Write-Output "Created: $zipPath"
  Write-Output "SHA256: $hash"
}
finally {
  if (Test-Path -LiteralPath $stageRoot) {
    if (-not $stageRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove an unexpected staging path: $stageRoot"
    }
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
  }
}
