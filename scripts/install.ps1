[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [string]$DshRoot,
  [string]$DshHome = $env:DSH_HOME,
  [switch]$Upgrade
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

  $command = Get-Command dsh -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    throw 'The dsh command was not found. Pass -DshRoot for a source checkout.'
  }
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

function Get-DshVersion {
  if ($script:DshCli) {
    $output = & $script:DshNode $script:DshCli '--version'
  } else {
    $output = & $script:DshCommand '--version'
  }
  if ($LASTEXITCODE -ne 0) {
    throw 'Unable to determine the DeepSeek Harness version.'
  }
  return ($output | Out-String).Trim()
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

$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $repository 'preset\deep-performance'
$required = @(
  'preset.yml',
  'agent.cordis.yml',
  'custom-bash.mjs',
  'tool-bootstrap.mjs',
  'compaction-epoch.mjs',
  'instruction-hint.mjs',
  'skill-search.mjs',
  'LICENSE',
  'NOTICE'
)
foreach ($name in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $source $name) -PathType Leaf)) {
    throw "Preset package is incomplete: missing $name"
  }
}

if ((Test-Path -LiteralPath $target) -and -not $Upgrade) {
  throw "Preset already exists at $target. Re-run with -Upgrade to back it up and replace it."
}

Initialize-DshRunner
$nodeVersionText = (& node '--version').Trim().TrimStart('v')
$nodeVersion = [version]$nodeVersionText
$nodeSupported = (
  ($nodeVersion.Major -eq 22 -and $nodeVersion -ge [version]'22.19.0') -or
  $nodeVersion.Major -ge 24
)
if (-not $nodeSupported) {
  throw "Unsupported Node.js version $nodeVersionText. Use Node.js 22.19+ or 24+."
}
$dshVersion = Get-DshVersion
if ($dshVersion -ne '0.1.0-rc.6') {
  throw "Unsupported DeepSeek Harness version $dshVersion. This beta is validated only on 0.1.0-rc.6."
}
Invoke-Dsh @('plugin', '--profile', $Profile, 'add', '@nanmicoder/dsh-agent-teams@0.1.5')
Invoke-Dsh @('plugin', '--profile', $Profile, 'add', $repository)

New-Item -ItemType Directory -Path $presetRoot -Force | Out-Null
$staging = [IO.Path]::GetFullPath((Join-Path $presetRoot ('.deep-performance.stage-' + [guid]::NewGuid().ToString('N'))))
if (-not $staging.StartsWith($presetRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Resolved staging directory escaped the DSH preset directory.'
}
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  Copy-Item -Path (Join-Path $source '*') -Destination $staging -Recurse
  foreach ($name in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $staging $name) -PathType Leaf)) {
      throw "Staged preset is incomplete: missing $name"
    }
  }

  if (Test-Path -LiteralPath $target) {
    $backupRoot = Join-Path $resolvedHome 'preset-backups'
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = Join-Path $backupRoot "deep-performance-$stamp"
    Move-Item -LiteralPath $target -Destination $backup
    Write-Host "Existing preset archived at $backup"
  }
  Move-Item -LiteralPath $staging -Destination $target
} finally {
  if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
  }
}

Write-Host "Panoptic Inquiry installed for profile '$Profile'."
Write-Host "Preset: $target"
Write-Host 'Select preset id deep-performance in the Web UI.'
