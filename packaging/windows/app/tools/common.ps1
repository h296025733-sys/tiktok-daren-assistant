Set-StrictMode -Version Latest

$script:AppRoot = Split-Path -Parent $PSScriptRoot
$script:ProductRoot = Split-Path -Parent $script:AppRoot
$script:BackendPath = Join-Path $script:AppRoot "backend\TikTokDarenAssistantBackend.exe"
$script:ManifestPath = Join-Path $script:AppRoot "extension\manifest.json"
$script:PidFile = Join-Path $script:ProductRoot "run\backend.pid"

function Normalize-TdaPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Get-TdaExpectedVersion {
    $manifest = Get-Content -LiteralPath $script:ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    return [string]$manifest.version
}

function Get-TdaHealth {
    try {
        return Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -TimeoutSec 2
    } catch {
        return $null
    }
}

function Get-TdaListenerProcessIds {
    $listeners = @(Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)
    return @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
}

function Test-TdaBackendProcess([int]$ProcessId) {
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        return (Normalize-TdaPath $process.Path) -eq (Normalize-TdaPath $script:BackendPath)
    } catch {
        return $false
    }
}

function Stop-TdaBackend {
    $candidateIds = @()
    if (Test-Path -LiteralPath $script:PidFile) {
        $parsedPid = 0
        $rawPid = (Get-Content -LiteralPath $script:PidFile -Raw -ErrorAction SilentlyContinue).Trim()
        if ([int]::TryParse($rawPid, [ref]$parsedPid)) {
            $candidateIds += $parsedPid
        }
    }
    $candidateIds += Get-TdaListenerProcessIds

    foreach ($processId in @($candidateIds | Select-Object -Unique)) {
        if (Test-TdaBackendProcess ([int]$processId)) {
            Stop-Process -Id ([int]$processId) -Force -ErrorAction Stop
            try { Wait-Process -Id ([int]$processId) -Timeout 5 -ErrorAction SilentlyContinue } catch {}
        }
    }
    if (Test-Path -LiteralPath $script:PidFile) {
        Remove-Item -LiteralPath $script:PidFile -Force
    }
}

function Assert-TdaProductRoot {
    $expected = Normalize-TdaPath (Join-Path $env:LOCALAPPDATA "TikTokDarenAssistant")
    $actual = Normalize-TdaPath $script:ProductRoot
    if (-not $actual.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unexpected product path. Refusing to continue: $actual"
    }
}
