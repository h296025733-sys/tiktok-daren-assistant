[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$backendRoot = Join-Path $projectRoot "backend"
$extensionRoot = Join-Path $projectRoot "extension"
$venvPython = Join-Path $backendRoot ".venv\Scripts\python.exe"

function Resolve-PythonExecutable {
    $systemPython = Get-Command python -ErrorAction SilentlyContinue
    if ($systemPython) {
        $versionText = & $systemPython.Source --version 2>&1
        if ($LASTEXITCODE -eq 0 -and "$versionText" -match "Python 3\.(1[1-9]|[2-9][0-9])") {
            return $systemPython.Source
        }
    }

    $bundledPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
    if (Test-Path -LiteralPath $bundledPython) {
        return $bundledPython
    }
    throw "未找到兼容的 Python 3.11+。请先安装 Python，或在 PATH 中提供 python 命令。"
}

function Invoke-NodePackageManager {
    param([string[]]$Arguments)
    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCommand) {
        & $npmCommand.Source @Arguments | Out-Host
        $commandExitCode = $LASTEXITCODE
        return $commandExitCode
    }
    $bundledPnpm = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"
    $bundledNodeDirectory = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
    if (Test-Path -LiteralPath $bundledPnpm) {
        if (Test-Path -LiteralPath (Join-Path $bundledNodeDirectory "node.exe")) {
            $env:PATH = "$bundledNodeDirectory;$env:PATH"
        }
        & $bundledPnpm @Arguments | Out-Host
        $commandExitCode = $LASTEXITCODE
        return $commandExitCode
    }
    throw "未找到 npm 或可用的 pnpm。请先安装 Node.js（含 npm）。"
}

Write-Host "[1/4] 检查 Python 运行时" -ForegroundColor Cyan
$pythonExecutable = Resolve-PythonExecutable
Write-Host "使用：$pythonExecutable"

if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Host "[2/4] 创建 backend\.venv" -ForegroundColor Cyan
    & $pythonExecutable -m venv (Join-Path $backendRoot ".venv")
    if ($LASTEXITCODE -ne 0) { throw "创建 Python 虚拟环境失败。" }
} else {
    Write-Host "[2/4] backend\.venv 已存在，继续使用" -ForegroundColor DarkGray
}

Write-Host "[3/4] 安装 Python 项目依赖" -ForegroundColor Cyan
& $venvPython -m pip install --disable-pip-version-check -r (Join-Path $backendRoot "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Python 依赖安装失败。" }

Write-Host "[4/4] 安装插件项目依赖（模型将在首次需要时再下载）" -ForegroundColor Cyan
Push-Location $extensionRoot
try {
    $packageExit = Invoke-NodePackageManager -Arguments @("install")
    if ($packageExit -ne 0) { throw "插件依赖安装失败。" }
} finally {
    Pop-Location
}

Write-Host "安装完成。未安装任何系统级软件。" -ForegroundColor Green
