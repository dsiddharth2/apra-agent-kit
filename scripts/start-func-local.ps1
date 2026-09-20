<#
.SYNOPSIS
  Starts the Azure Functions host locally with Azurite for storage emulation.

.DESCRIPTION
  1. Swaps host.config.mjs to the local Azure Functions variant (in-process jobs,
     avoids the Durable extension .NET assembly issue on local Core Tools).
  2. Starts Azurite in the background.
  3. Runs `func start` from the workflow-kit root.
  4. On Ctrl+C / exit, restores the original config and stops Azurite.

.PARAMETER Token
  CLAUDE_CODE_OAUTH_TOKEN value. If omitted, reads from the environment or
  prompts. Set to "mock" to use the scripted fleet mock (NODE_ENV=test).

.PARAMETER Durable
  Use the full Durable Functions backend instead of in-process. Requires a
  compatible func CLI version. If you see System.Memory.Data errors, omit this.

.EXAMPLE
  .\scripts\start-func-local.ps1
  .\scripts\start-func-local.ps1 -Token "your-oauth-token"
  .\scripts\start-func-local.ps1 -Token mock
  .\scripts\start-func-local.ps1 -Durable
#>
param(
    [string]$Token,
    [switch]$Durable
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$configOriginal = Join-Path $root 'host.config.mjs'
$configBackup   = Join-Path $root 'host.config.express-backup.mjs'
$localSettings  = Join-Path $root 'local.settings.json'
$azuriteProc    = $null
$swapped        = $false

function Restore-Config {
    if ($swapped -and (Test-Path $configBackup)) {
        Copy-Item $configBackup $configOriginal -Force
        Remove-Item $configBackup -Force
        Write-Host "`n[func-local] Restored host.config.mjs to express adapter." -ForegroundColor Cyan
    }
    if ($null -ne $azuriteProc -and -not $azuriteProc.HasExited) {
        Stop-Process -Id $azuriteProc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "[func-local] Stopped Azurite." -ForegroundColor Cyan
    }
}

trap { Restore-Config }

# --- Resolve token (check local.settings.json first, then env, then prompt) ---
if (-not $Token) { $Token = $env:CLAUDE_CODE_OAUTH_TOKEN }
if (-not $Token) {
    try {
        $existingSettings = Get-Content $localSettings -Raw | ConvertFrom-Json
        $saved = $existingSettings.Values.CLAUDE_CODE_OAUTH_TOKEN
        if ($saved) { $Token = $saved; Write-Host "[func-local] Using token from local.settings.json." -ForegroundColor DarkGray }
    } catch {}
}
if (-not $Token) {
    $Token = Read-Host 'Enter CLAUDE_CODE_OAUTH_TOKEN (or "mock" for scripted fleet)'
}
if (-not $Token) {
    Write-Error 'CLAUDE_CODE_OAUTH_TOKEN is required. Pass -Token, set the env var, or use "mock".'
    exit 1
}

# --- Update local.settings.json with the token and backend ---
$settings = Get-Content $localSettings -Raw | ConvertFrom-Json
if ($Token -eq 'mock') {
    $settings.Values.CLAUDE_CODE_OAUTH_TOKEN = ''
} else {
    $settings.Values.CLAUDE_CODE_OAUTH_TOKEN = $Token
}
if (-not $Durable) {
    $settings.Values.JOBS_BACKEND = 'in-process'
} else {
    $settings.Values.JOBS_BACKEND = 'durable'
}
$settings | ConvertTo-Json -Depth 10 | Out-File $localSettings -Encoding utf8

# --- Swap config to azure-functions adapter ---
$configSource = if ($Durable) {
    Write-Host "[func-local] Using Durable Functions backend." -ForegroundColor Yellow
    Join-Path $root 'deploy\azure-functions\host.config.mjs'
} else {
    Write-Host "[func-local] Using in-process jobs backend (no Durable extension needed)." -ForegroundColor Yellow
    Join-Path $root 'host.config.local-functions.mjs'
}
Write-Host "[func-local] Swapping host.config.mjs to azure-functions adapter..." -ForegroundColor Yellow
Copy-Item $configOriginal $configBackup -Force
Copy-Item $configSource $configOriginal -Force
$swapped = $true

# --- Kill any leftover Azurite on port 10000 ---
$stale = Get-NetTCPConnection -LocalPort 10000 -ErrorAction SilentlyContinue
if ($stale) {
    $stalePids = $stale | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($spid in $stalePids) {
        Write-Host "[func-local] Killing leftover process on port 10000 (PID $spid)..." -ForegroundColor DarkYellow
        try { Stop-Process -Id $spid -Force -ErrorAction Stop } catch {}
    }
    Start-Sleep -Seconds 2
}

# --- Clean stale task hub data ---
$staleFiles = Get-ChildItem $root -Filter "__azurite_db_*" -ErrorAction SilentlyContinue
$staleBlobs = Join-Path $root "__blobstorage__"
if ($staleFiles -or (Test-Path $staleBlobs)) {
    Write-Host "[func-local] Cleaning stale task hub data..." -ForegroundColor Yellow
    $staleFiles | Remove-Item -Force -ErrorAction SilentlyContinue
    if (Test-Path $staleBlobs) { Remove-Item $staleBlobs -Recurse -Force -ErrorAction SilentlyContinue }
}

# --- Start Azurite ---
Write-Host "[func-local] Starting Azurite..." -ForegroundColor Yellow
$azuriteCmd = (Get-Command azurite -ErrorAction SilentlyContinue).Source
if (-not $azuriteCmd) {
    Write-Error "azurite not found. Install with: npm install -g azurite"
    Restore-Config
    exit 1
}
$azuriteProc = Start-Process powershell.exe -ArgumentList '-NoProfile','-Command',"& '$azuriteCmd' --silent --blobHost 0.0.0.0 --queueHost 0.0.0.0 --tableHost 0.0.0.0" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3
if ($azuriteProc.HasExited) {
    Write-Error "Azurite failed to start (exit code $($azuriteProc.ExitCode)). Is another instance running?"
    Restore-Config
    exit 1
}
Write-Host "[func-local] Azurite running (PID $($azuriteProc.Id))." -ForegroundColor Green

# --- Set mock env if requested ---
$funcEnv = @{}
if ($Token -eq 'mock') {
    $funcEnv['NODE_ENV'] = 'test'
    $funcEnv['FLEET_MOCK_SCRIPT'] = Join-Path $root 'tests\e2e\scripted-llm.json'
    Write-Host "[func-local] Using scripted fleet mock (no LLM calls)." -ForegroundColor Cyan
}

# --- Log file ---
$logsDir = Join-Path $root 'logs'
if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Force $logsDir | Out-Null }
$logFile = Join-Path $logsDir ("func-$(Get-Date -Format 'yyyy-MM-dd_HH-mm-ss').log")
Write-Host "[func-local] Logging to $logFile" -ForegroundColor DarkGray

# --- Run func start ---
Write-Host "[func-local] Starting Azure Functions host..." -ForegroundColor Yellow
Write-Host "[func-local] Press Ctrl+C to stop.`n" -ForegroundColor DarkGray

try {
    Push-Location $root
    foreach ($k in $funcEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $funcEnv[$k], 'Process') }
    func start 2>&1 | Tee-Object -FilePath $logFile -Append
} finally {
    foreach ($k in $funcEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $null, 'Process') }
    Pop-Location
    Restore-Config
    Write-Host "[func-local] Log saved to $logFile" -ForegroundColor Cyan
}
