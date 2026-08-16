[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [string]$DshRoot,
  [string]$WebUrl
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

Push-Location $repository
try {
  & node --test 'test/*.test.mjs'
  if ($LASTEXITCODE -ne 0) { throw 'Unit tests failed.' }
  & node 'scripts/check.mjs'
  if ($LASTEXITCODE -ne 0) { throw 'Repository checks failed.' }
  & npm pack --dry-run
  if ($LASTEXITCODE -ne 0) { throw 'Package content check failed.' }
} finally {
  Pop-Location
}

if ($DshRoot) {
  $resolvedRoot = [IO.Path]::GetFullPath($DshRoot)
  $cli = Join-Path $resolvedRoot 'apps\cli\lib\bin.js'
  if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    throw "DeepSeek Harness CLI was not found under $resolvedRoot"
  }
  & node $cli '--profile' $Profile '--dump-config' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'DSH config dump failed.' }
}

if ($WebUrl) {
  $response = Invoke-WebRequest -Uri $WebUrl -UseBasicParsing -TimeoutSec 15
  if ($response.StatusCode -ne 200) {
    throw "Web smoke check returned HTTP $($response.StatusCode)."
  }
}

Write-Host 'Verification passed. No live model request was sent.'
