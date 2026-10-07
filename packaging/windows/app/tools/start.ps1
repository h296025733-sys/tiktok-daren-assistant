[CmdletBinding()]
param(
    [switch]$Quiet,
    [ValidateRange(10, 180)]
    [int]$StartupTimeoutSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

function Write-Status([string]$Message, [ConsoleColor]$Color = [ConsoleColor]::Gray) {
    if (-not $Quiet) { Write-Host $Message -ForegroundColor $Color }
}

function Get-LogTail([string]$Path, [int]$LineCount = 30) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "" }
    return ((Get-Content -LiteralPath $Path -Tail $LineCount -ErrorAction SilentlyContinue) -join [Environment]::NewLine).Trim()
}

Assert-TdaProductRoot
if (-not (Test-Path -LiteralPath $script:BackendPath -PathType Leaf)) {
    throw "Backend executable is missing. Reinstall the application."
}
if (-not (Test-Path -LiteralPath $script:ManifestPath -PathType Leaf)) {
    throw "Extension manifest is missing. Reinstall the application."
}

$expectedVersion = Get-TdaExpectedVersion
$health = Get-TdaHealth
$listenerIds = @(Get-TdaListenerProcessIds)
if ($health -and $health.status -eq "ok" -and
    $health.service -eq "tiktok-daren-assistant" -and
    $health.version -eq $expectedVersion -and
    $listenerIds.Count -eq 1 -and
    (Test-TdaBackendProcess ([int]$listenerIds[0]))) {
    Write-Status "TikTok Daren Assistant is already running." Green
    return
}

if ($listenerIds.Count -gt 0) {
    $unknownIds = @($listenerIds | Where-Object { -not (Test-TdaBackendProcess ([int]$_)) })
    if ($unknownIds.Count -gt 0) {
        throw "Port 8765 is occupied by another program (PID: $($unknownIds -join ', '))."
    }
    Stop-TdaBackend
}

foreach ($directory in ("data", "models", "outputs", "logs", "run", "cache")) {
    New-Item -ItemType Directory -Path (Join-Path $script:ProductRoot $directory) -Force | Out-Null
}

$env:TIKTOK_ASSISTANT_HOME = $script:ProductRoot
$env:TIKTOK_ASSISTANT_DB_PATH = Join-Path $script:ProductRoot "data\tiktok_assistant.db"
$env:TIKTOK_ASSISTANT_MODEL_ROOT = Join-Path $script:ProductRoot "models"
$env:TIKTOK_ASSISTANT_OUTPUT_ROOT = Join-Path $script:ProductRoot "outputs"
$env:TIKTOK_ASSISTANT_HOST = "127.0.0.1"
$env:TIKTOK_ASSISTANT_PORT = "8765"
$env:PYTHONUTF8 = "1"
$env:PYTHONUNBUFFERED = "1"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stdoutLog = Join-Path $script:ProductRoot "logs\backend-$stamp.stdout.log"
$stderrLog = Join-Path $script:ProductRoot "logs\backend-$stamp.stderr.log"
$process = Start-Process `
    -FilePath $script:BackendPath `
    -WorkingDirectory (Split-Path -Parent $script:BackendPath) `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru
Set-Content -LiteralPath $script:PidFile -Value ([string]$process.Id) -Encoding ASCII

$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) { break }
    $health = Get-TdaHealth
    if ($health -and $health.status -eq "ok" -and
        $health.service -eq "tiktok-daren-assistant" -and
        $health.version -eq $expectedVersion) {
        Write-Status "TikTok Daren Assistant started on 127.0.0.1:8765." Green
        return
    }
}

$process.Refresh()
$exitedBeforeHealth = $process.HasExited
$failureSummary = if ($exitedBeforeHealth) {
    "Backend process exited before health check succeeded (exit code: $($process.ExitCode))."
} else {
    "Backend did not become ready within $StartupTimeoutSeconds seconds."
}
if (-not $exitedBeforeHealth -and (Test-TdaBackendProcess $process.Id)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}
if (Test-Path -LiteralPath $script:PidFile) {
    Remove-Item -LiteralPath $script:PidFile -Force
}
$stderrTail = Get-LogTail $stderrLog
$stdoutTail = Get-LogTail $stdoutLog
$details = @($failureSummary, "Error log: $stderrLog")
if ($stderrTail) {
    $details += "--- stderr (last lines) ---"
    $details += $stderrTail
} elseif ($stdoutTail) {
    $details += "--- stdout (last lines) ---"
    $details += $stdoutTail
} else {
    $details += "No backend log was produced. Windows security software may have blocked or quarantined a runtime file."
}
throw ($details -join [Environment]::NewLine)
