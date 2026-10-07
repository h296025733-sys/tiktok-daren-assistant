[CmdletBinding()]
param(
    [string]$PublicHost = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$backendRoot = Join-Path $projectRoot "backend"
$venvPython = Join-Path $backendRoot ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Error "后端环境不存在，请先运行 scripts\setup.ps1"
    exit 1
}

$occupied = Get-NetTCPConnection -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue
if ($occupied) {
    Write-Error "授权端口 8766 已被占用，请先确认正在运行的程序。"
    exit 1
}

$env:PYTHONUTF8 = "1"
$env:PYTHONUNBUFFERED = "1"
if ($PublicHost) { $env:TDA_LICENSE_PUBLIC_HOST = $PublicHost }
Push-Location $backendRoot
try {
    & $venvPython -m uvicorn app.license_main:app --host 127.0.0.1 --port 8766
    exit $LASTEXITCODE
} finally {
    Pop-Location
}

