[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [string]$DshRoot,
  [string]$DshHome = $env:DSH_HOME,
  [switch]$RemoveSharedDependencies
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:DshNode = $null
$script:DshCli = $null
$script:DshCommand = $null

function Initialize-DshRunner {
  if ($DshRoot) {
    $resolvedRoot = [IO.Path]::GetFullPath($DshRoot)
    $cli = Join-Path $resolvedRoot 'apps\cli\lib\bin.js'
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
      throw "DeepSeek Harness CLI was not found under $resolvedRoot"
    }
    $node = Get-Command node -ErrorAction Stop
    $script:DshNode = $node.Source
    $script:DshCli = $cli
    return
  }
  $command = Get-Command dsh -ErrorAction Stop
  $script:DshCommand = $command.Source
}

function Invoke-Dsh([string[]]$DshArgs) {
  if ($script:DshCli) {
    & $script:DshNode $script:DshCli @DshArgs
  } else {
    & $script:DshCommand @DshArgs
  }
  if ($LASTEXITCODE -ne 0) {
    throw "dsh failed with exit code ${LASTEXITCODE}: $($DshArgs -join ' ')"
  }
}

if (-not $DshHome) {
  $DshHome = Join-Path $env:USERPROFILE '.dsh'
}
$resolvedHome = [IO.Path]::GetFullPath($DshHome)
$env:DSH_HOME = $resolvedHome
$presetRoot = [IO.Path]::GetFullPath((Join-Path $resolvedHome '.agent-presets'))
$target = [IO.Path]::GetFullPath((Join-Path $presetRoot 'deep-performance'))
if (-not $target.StartsWith($presetRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Resolved preset target escaped the DSH preset directory.'
}

if (Test-Path -LiteralPath $target) {
  $backupRoot = Join-Path $resolvedHome 'preset-backups'
  New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = Join-Path $backupRoot "removed-deep-performance-$stamp"
  Move-Item -LiteralPath $target -Destination $backup
  Write-Host "Preset archived at $backup"
}

Initialize-DshRunner
Invoke-Dsh @('plugin', '--profile', $Profile, 'remove', 'dsh-panoptic-inquiry')
if ($RemoveSharedDependencies) {
  Invoke-Dsh @('plugin', '--profile', $Profile, 'remove', '@nanmicoder/dsh-agent-teams')
}

Write-Warning 'Sessions that reference deep-performance require the archived preset to resume.'
