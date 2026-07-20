[CmdletBinding()]
param()

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
  'README.md',
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
    Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $packageRoot $relativePath)
  }

  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }

  Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal

  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
  $checksumText = "$hash  $artifactName.zip`n"
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
