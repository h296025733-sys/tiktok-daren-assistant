[CmdletBinding()]
param(
    [ValidateSet("List", "Generate", "Revoke", "Reset")]
    [string]$Action = "List",
    [ValidateRange(1, 100)]
    [int]$Count = 1,
    [int]$KeyId = 0
)

$ErrorActionPreference = "Stop"
$env:PYTHONUTF8 = "1"
$env:PYTHONUNBUFFERED = "1"
$projectRoot = Split-Path -Parent $PSScriptRoot
$backendRoot = Join-Path $projectRoot "backend"
$python = Join-Path $backendRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    Write-Error "后端环境不存在，请先运行 scripts\setup.ps1"
    exit 1
}

$arguments = @("-m", "scripts.cloud_license_admin")
switch ($Action) {
    "List" { $arguments += "list" }
    "Generate" { $arguments += @("generate", "--count", "$Count") }
    "Revoke" {
        if ($KeyId -lt 1) { throw "Revoke 必须提供正确的 -KeyId" }
        $arguments += @("revoke", "$KeyId")
    }
    "Reset" {
        if ($KeyId -lt 1) { throw "Reset 必须提供正确的 -KeyId" }
        $arguments += @("reset", "$KeyId")
    }
}

Push-Location $backendRoot
try {
    & $python @arguments
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
