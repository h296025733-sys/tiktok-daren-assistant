[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$backendRoot = Join-Path $projectRoot "backend"
$venvPython = Join-Path $backendRoot ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Error "后端虚拟环境不存在。请先运行：.\scripts\setup.ps1"
    exit 1
}

$occupied = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
if ($occupied) {
    $processIds = ($occupied | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
    Write-Error "端口 8765 已被占用（进程 ID：$processIds）。脚本不会自动关闭已有程序，请先确认并手动处理。"
    exit 1
}

$env:PYTHONUTF8 = "1"
$env:PYTHONUNBUFFERED = "1"
Write-Host "本地服务启动中：http://127.0.0.1:8765" -ForegroundColor Green
Write-Host "按 Ctrl+C 可停止服务。"

Push-Location $backendRoot
try {
    & $venvPython -m uvicorn app.main:app --host 127.0.0.1 --port 8765
    exit $LASTEXITCODE
} finally {
    Pop-Location
}

