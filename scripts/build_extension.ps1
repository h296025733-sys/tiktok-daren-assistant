[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$extensionRoot = Join-Path $projectRoot "extension"

function Invoke-PackageScript {
    param([string]$ScriptName)
    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCommand) {
        & $npmCommand.Source run $ScriptName | Out-Host
        $commandExitCode = $LASTEXITCODE
        return $commandExitCode
    }
    $bundledPnpm = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"
    $bundledNodeDirectory = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
    if (Test-Path -LiteralPath $bundledPnpm) {
        if (Test-Path -LiteralPath (Join-Path $bundledNodeDirectory "node.exe")) {
            $env:PATH = "$bundledNodeDirectory;$env:PATH"
        }
        & $bundledPnpm run $ScriptName | Out-Host
        $commandExitCode = $LASTEXITCODE
        return $commandExitCode
    }
    throw "未找到 npm 或可用的 pnpm。请先运行 setup.ps1 并确认 Node.js 环境。"
}

if (-not (Test-Path -LiteralPath (Join-Path $extensionRoot "node_modules"))) {
    Write-Error "插件依赖尚未安装。请先运行：.\scripts\setup.ps1"
    exit 1
}

Push-Location $extensionRoot
try {
    Write-Host "[1/3] 运行阶段 1.4 插件自动测试" -ForegroundColor Cyan
    $testExit = Invoke-PackageScript -ScriptName "test"
    if ($testExit -ne 0) { throw "插件自动测试失败。" }

    Write-Host "[2/3] 执行 TypeScript 类型检查" -ForegroundColor Cyan
    $typecheckExit = Invoke-PackageScript -ScriptName "typecheck"
    if ($typecheckExit -ne 0) { throw "TypeScript 类型检查失败。" }

    Write-Host "[3/3] 构建 Chrome 插件" -ForegroundColor Cyan
    $buildExit = Invoke-PackageScript -ScriptName "build"
    if ($buildExit -ne 0) { throw "Chrome 插件构建失败。" }
} catch {
    Write-Error $_
    exit 1
} finally {
    Pop-Location
}

Write-Host "构建成功：$extensionRoot\dist" -ForegroundColor Green
