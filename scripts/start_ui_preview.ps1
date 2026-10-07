[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$extensionRoot = Join-Path $projectRoot "extension"
$port = 4174

$listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    Write-Error "UI 预览端口 $port 已被占用，进程 ID：$($listener.OwningProcess)。本脚本不会自动关闭已有程序。"
    exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $extensionRoot "node_modules"))) {
    Write-Error "插件依赖尚未安装。请先运行：.\scripts\setup.ps1"
    exit 1
}

$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
$bundledPnpm = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"
$bundledNodeDirectory = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"

Write-Host "正在启动阶段 1.4 UI 预览：http://127.0.0.1:$port/dev/ui-preview.html" -ForegroundColor Cyan
Write-Host "页面只使用 UI 示例数据，不访问 TikTok、不调用后端。按 Ctrl+C 停止。" -ForegroundColor DarkGray

Push-Location $extensionRoot
try {
    if ($npmCommand) {
        & $npmCommand.Source run dev -- --host 127.0.0.1 --port $port
    } elseif (Test-Path -LiteralPath $bundledPnpm) {
        if (Test-Path -LiteralPath (Join-Path $bundledNodeDirectory "node.exe")) {
            $env:PATH = "$bundledNodeDirectory;$env:PATH"
        }
        & $bundledPnpm exec vite --host 127.0.0.1 --port $port
    } else {
        throw "未找到 npm 或可用的 pnpm。请先检查 Node.js 环境。"
    }
    exit $LASTEXITCODE
} finally {
    Pop-Location
}

