[CmdletBinding()]
param()

$ErrorActionPreference = "Continue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$backendRoot = Join-Path $projectRoot "backend"
$extensionRoot = Join-Path $projectRoot "extension"
$venvPython = Join-Path $backendRoot ".venv\Scripts\python.exe"
$script:failureCount = 0
$expectedVersion = $null
try {
    $expectedVersion = (Get-Content -LiteralPath (Join-Path $extensionRoot "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
} catch {
    # manifest 完整性会在后续构建文件检查中明确报告。
}

function Write-Check {
    param([string]$Name, [bool]$Success, [string]$Detail)
    if ($Success) {
        Write-Host "[通过] $Name - $Detail" -ForegroundColor Green
    } else {
        Write-Host "[失败] $Name - $Detail" -ForegroundColor Red
        $script:failureCount += 1
    }
}

Write-Host "TikTok 达人助手环境诊断" -ForegroundColor Cyan
Write-Host "项目：$projectRoot"

Write-Check "Python 虚拟环境" (Test-Path -LiteralPath $venvPython) "backend\.venv"
if (Test-Path -LiteralPath $venvPython) {
    & $venvPython -c "import fastapi, uvicorn, pydantic"
    Write-Check "后端依赖" ($LASTEXITCODE -eq 0) "FastAPI / Uvicorn / Pydantic"
}

$nodeModules = Join-Path $extensionRoot "node_modules"
Write-Check "插件依赖" (Test-Path -LiteralPath $nodeModules) "extension\node_modules"

$listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    Write-Check "8765 端口" $true "仅本机地址正在监听"
} else {
    Write-Check "8765 端口" $false "未发现 127.0.0.1:8765 监听，请启动后端"
}

try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -TimeoutSec 3
    $healthOk = $health.status -eq "ok" -and
        $health.service -eq "tiktok-daren-assistant" -and
        $expectedVersion -and
        $health.version -eq $expectedVersion
    $healthDetail = "status=$($health.status), version=$($health.version), 期望=$expectedVersion"
    if ($health.status -eq "ok" -and $health.service -eq "tiktok-daren-assistant" -and $health.version -ne $expectedVersion) {
        $healthDetail += "；当前运行的是旧后端，请在原窗口 Ctrl+C 后重新运行 start_backend.ps1"
    }
    Write-Check "后端 health" $healthOk $healthDetail
} catch {
    Write-Check "后端 health" $false "请求失败：$($_.Exception.Message)"
}

$requiredDistFiles = @("manifest.json", "background.js", "content.js", "page-bridge.js", "sidepanel.html", "dev\ui-preview.html")
foreach ($fileName in $requiredDistFiles) {
    $filePath = Join-Path (Join-Path $extensionRoot "dist") $fileName
    Write-Check "插件构建文件 $fileName" (Test-Path -LiteralPath $filePath) $filePath
}

# Production-only guard: Vitest fetch mocks do not enforce Chrome's Web IDL
# receiver check. Inspect the actual bundle Chrome loads so an unbound native
# fetch (which fails with "Illegal invocation") cannot silently return.
$sidepanelBundlePath = Join-Path $extensionRoot "dist\assets\sidepanel.js"
if (Test-Path -LiteralPath $sidepanelBundlePath) {
    $sidepanelBundle = Get-Content -LiteralPath $sidepanelBundlePath -Raw -Encoding UTF8
    $boundFetchCount = ([regex]::Matches($sidepanelBundle, [regex]::Escape("fetch.bind(globalThis)"))).Count
    $transportOk = $boundFetchCount -ge 2 -and -not $sidepanelBundle.Contains("targetAddressSpace")
    Write-Check `
        "翻译请求生产构建" `
        $transportOk `
        "原生 fetch 绑定=$boundFetchCount，错误地址空间声明=$($sidepanelBundle.Contains('targetAddressSpace'))"
} else {
    Write-Check "翻译请求生产构建" $false "缺少 dist\assets\sidepanel.js"
}

if ($script:failureCount -gt 0) {
    Write-Host "诊断完成：发现 $script:failureCount 项问题。" -ForegroundColor Yellow
    exit 1
}
Write-Host "诊断完成：全部通过。" -ForegroundColor Green
exit 0
