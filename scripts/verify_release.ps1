[CmdletBinding()]
param(
    [string]$ArchivePath = "",
    [int]$SmokePort = 18766
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Net.Http

function Assert-SmokeDirectory([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolved) -notlike "TDA-final-smoke-*") {
        throw "Unsafe smoke-test directory: $resolved"
    }
    return $resolved
}

function Remove-SmokeDirectory([string]$Path) {
    $resolved = Assert-SmokeDirectory $Path
    if (-not (Test-Path -LiteralPath $resolved)) { return }
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
        try {
            Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
            return
        } catch {
            if ($attempt -eq 19) { throw }
            Start-Sleep -Milliseconds 250
        }
    }
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourceManifestPath = Join-Path $repositoryRoot "extension\manifest.json"
$expectedVersion = [string](
    Get-Content -LiteralPath $sourceManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
).version
if (-not $ArchivePath) {
    $ArchivePath = Join-Path $repositoryRoot "release\TikTokDarenAssistant-v$expectedVersion-win-x64.zip"
}
$archiveFullPath = [IO.Path]::GetFullPath($ArchivePath)
if (-not (Test-Path -LiteralPath $archiveFullPath -PathType Leaf)) {
    throw "Release ZIP is missing: $archiveFullPath"
}

$checksumPath = "$archiveFullPath.sha256.txt"
$actualHash = (Get-FileHash -LiteralPath $archiveFullPath -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedHash = ((Get-Content -LiteralPath $checksumPath -Raw).Trim() -split "\s+")[0].ToLowerInvariant()
if ($actualHash -ne $expectedHash) {
    throw "Release ZIP SHA-256 does not match its sidecar."
}

$archive = [IO.Compression.ZipFile]::OpenRead($archiveFullPath)
try {
    $entries = @($archive.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) })
    $entryNames = @($entries | ForEach-Object { $_.FullName.Replace("\", "/") })
    $forbidden = @($entryNames | Where-Object {
        $_ -match '(^|/)(\.venv|models|node_modules|tests|outputs|logs|data|__pycache__|\.pytest_cache)(/|$)' -or
        $_ -match '\.(py|ts|db|pyc|argosmodel|pdb)$' -or
        $_ -match '(^|/)model\.bin$' -or
        $_ -match '同事安装说明|许可证|README\.txt|release-manifest'
    })
    if ($forbidden.Count -gt 0) {
        throw "Forbidden files entered the release: $($forbidden -join ', ')"
    }
    $rootName = "TDA-v$expectedVersion"
    $manifestEntry = $entries | Where-Object {
        $_.FullName.Replace("\", "/") -eq "$rootName/_payload/app/extension/manifest.json"
    } | Select-Object -First 1
    if (-not $manifestEntry) { throw "Packaged extension manifest is missing." }
    $reader = [IO.StreamReader]::new($manifestEntry.Open(), [Text.Encoding]::UTF8)
    try {
        $manifest = $reader.ReadToEnd() | ConvertFrom-Json
    } finally {
        $reader.Dispose()
    }
    if ($manifest.version -ne $expectedVersion -or -not $manifest.key) {
        throw "Packaged extension version or stable key is incorrect."
    }
    if ($manifest.content_security_policy.extension_pages -notmatch "wasm-unsafe-eval" -or
        @($manifest.host_permissions) -notcontains "https://huggingface.co/*") {
        throw "Packaged extension is missing the browser speech compatibility policy."
    }
    foreach ($browserRuntimeEntry in @(
        "$rootName/_payload/app/extension/assets/transformers.web.js",
        "$rootName/_payload/app/extension/assets/onnx/ort-wasm-simd-threaded.mjs",
        "$rootName/_payload/app/extension/assets/onnx/ort-wasm-simd-threaded.wasm"
    )) {
        if ($entryNames -notcontains $browserRuntimeEntry) {
            throw "Packaged browser speech runtime is incomplete: $browserRuntimeEntry"
        }
    }
    if ([IO.Path]::GetFileNameWithoutExtension($archiveFullPath) -ne
        "TikTokDarenAssistant-v$expectedVersion-win-x64") {
        throw "Release archive name does not match the source version."
    }
    $uncompressedBytes = ($entries | Measure-Object -Property Length -Sum).Sum
} finally {
    $archive.Dispose()
}

if (Get-NetTCPConnection -LocalPort $SmokePort -State Listen -ErrorAction SilentlyContinue) {
    throw "Smoke-test port $SmokePort is already occupied."
}
if ($SmokePort -eq 8765 -or
    (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)) {
    throw "Installer smoke-test port 8765 is already occupied."
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
foreach ($staleDirectory in @(Get-ChildItem -LiteralPath $tempRoot -Directory -Filter "TDA-final-smoke-*" -ErrorAction SilentlyContinue)) {
    $stalePath = Assert-SmokeDirectory $staleDirectory.FullName
    $stalePrefix = $stalePath + [IO.Path]::DirectorySeparatorChar
    $holders = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        try {
            $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith(
                $stalePrefix,
                [StringComparison]::OrdinalIgnoreCase
            )
        } catch { $false }
    })
    if ($holders.Count -eq 0) {
        Remove-SmokeDirectory $stalePath
    }
}
$smokeRoot = Join-Path $tempRoot ("TDA-final-smoke-" + [guid]::NewGuid().ToString("N"))
$smokeFullPath = Assert-SmokeDirectory $smokeRoot

$backendProcess = $null
$backendPath = $null
$installedBackendPath = $null
$httpClient = $null
$originalLocalAppData = $env:LOCALAPPDATA
$originalDiagnosticDelay = $env:TIKTOK_ASSISTANT_DIAGNOSTIC_STARTUP_DELAY
$slowInstallSeconds = 0.0
$zoneMarkerCleared = $false
$quarantineDetected = $false
$policyFallbackInstall = $false
$policyFallbackApi = $false
$backendExecutableFallbackInstall = $false
$aiRuntimeSelfTest = $null
$vcRedistVersion = $null
New-Item -ItemType Directory -Path $smokeFullPath | Out-Null
try {
    Expand-Archive -LiteralPath $archiveFullPath -DestinationPath $smokeFullPath
    $bundleRoot = Join-Path $smokeFullPath $rootName
    $backendPath = Join-Path $bundleRoot "_payload\app\backend\TikTokDarenAssistantBackend.exe"
    if (-not (Test-Path -LiteralPath $backendPath -PathType Leaf)) {
        throw "Frozen backend is missing."
    }
    $vcRedistPath = Join-Path $bundleRoot "_payload\app\prerequisites\vc_redist.x64.exe"
    if (-not (Test-Path -LiteralPath $vcRedistPath -PathType Leaf)) {
        throw "Bundled Microsoft Visual C++ runtime prerequisite is missing."
    }
    $vcSignature = Get-AuthenticodeSignature -LiteralPath $vcRedistPath
    if ($vcSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
        -not $vcSignature.SignerCertificate -or
        $vcSignature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
        throw "Bundled Microsoft Visual C++ runtime prerequisite signature is invalid."
    }
    $vcRedistVersion = (Get-Item -LiteralPath $vcRedistPath).VersionInfo.ProductVersion

    $runtimeSelfTestOutput = @(
        $repositoryWhisperModel = Join-Path $repositoryRoot "backend\models\faster-whisper\base"
        $runModelInference = Test-Path -LiteralPath (Join-Path $repositoryWhisperModel "model.bin") -PathType Leaf
        if ($runModelInference) {
            $env:TIKTOK_ASSISTANT_SELF_TEST_WHISPER_MODEL = $repositoryWhisperModel
        }
        try {
            & $backendPath --self-test-ai-runtime 2>&1 | ForEach-Object { [string]$_ }
        } finally {
            Remove-Item -LiteralPath "Env:TIKTOK_ASSISTANT_SELF_TEST_WHISPER_MODEL" -ErrorAction SilentlyContinue
        }
    )
    $runtimeSelfTestExitCode = $LASTEXITCODE
    if ($runtimeSelfTestExitCode -ne 0) {
        throw "Frozen AI runtime self-test failed: $($runtimeSelfTestOutput -join [Environment]::NewLine)"
    }
    try {
        $aiRuntimeSelfTest = $runtimeSelfTestOutput[-1] | ConvertFrom-Json
    } catch {
        throw "Frozen AI runtime self-test did not return valid JSON."
    }
    if (-not $aiRuntimeSelfTest.ok -or $aiRuntimeSelfTest.python_bits -ne 64 -or
        @($aiRuntimeSelfTest.cpu_compute_types).Count -eq 0) {
        throw "Frozen AI runtime self-test returned an invalid result."
    }
    if ($runModelInference -and -not $aiRuntimeSelfTest.whisper_model_loaded) {
        throw "Frozen AI runtime did not load and execute the available Whisper model."
    }

    $cleanHome = Join-Path $smokeFullPath "clean-home"
    New-Item -ItemType Directory -Path $cleanHome | Out-Null
    $env:TIKTOK_ASSISTANT_HOME = $cleanHome
    $env:TIKTOK_ASSISTANT_DB_PATH = Join-Path $cleanHome "data\assistant.db"
    $env:TIKTOK_ASSISTANT_MODEL_ROOT = Join-Path $cleanHome "models"
    $env:TIKTOK_ASSISTANT_OUTPUT_ROOT = Join-Path $cleanHome "outputs"
    $env:TIKTOK_ASSISTANT_PORT = [string]$SmokePort

    $stdoutLog = Join-Path $smokeFullPath "backend.stdout.log"
    $stderrLog = Join-Path $smokeFullPath "backend.stderr.log"
    $backendProcess = Start-Process `
        -FilePath $backendPath `
        -WorkingDirectory (Split-Path -Parent $backendPath) `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog `
        -PassThru

    $health = $null
    for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
        Start-Sleep -Milliseconds 250
        if ($backendProcess.HasExited) { break }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$SmokePort/health" -TimeoutSec 2
            break
        } catch {}
    }
    if (-not $health -or $health.status -ne "ok" -or $health.version -ne $expectedVersion) {
        $errorLog = Get-Content -LiteralPath $stderrLog -Raw -ErrorAction SilentlyContinue
        throw "Frozen backend health check failed: $errorLog"
    }

    $models = Invoke-RestMethod -Uri "http://127.0.0.1:$SmokePort/api/v1/models" -TimeoutSec 3
    $installedModels = @($models.models | Where-Object { $_.installed })
    if ($models.models.Count -ne 3 -or $installedModels.Count -ne 0) {
        throw "Clean model state is incorrect."
    }

    $httpClient = [Net.Http.HttpClient]::new()
    $requestBody = @{
        media = @{
            video_id = "7654207540028394774"
            media_url = "https://v16.tiktokcdn.com/video.mp4"
            download_video = $false
            extract_audio = $true
        }
    } | ConvertTo-Json -Depth 5
    $content = [Net.Http.StringContent]::new($requestBody, [Text.Encoding]::UTF8, "application/json")
    $response = $httpClient.PostAsync(
        "http://127.0.0.1:$SmokePort/api/v1/transcriptions",
        $content
    ).GetAwaiter().GetResult()
    $responseBody = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
    if ([int]$response.StatusCode -ne 409 -or $responseBody.detail.code -ne "MODEL_REQUIRED") {
        throw "Missing-model transcription did not return 409 MODEL_REQUIRED."
    }
    $downloadFiles = @(Get-ChildItem (Join-Path $cleanHome "outputs") -Recurse -File -ErrorAction SilentlyContinue)
    if ($downloadFiles.Count -gt 0) {
        throw "Missing-model preflight unexpectedly created media output."
    }

    # Exercise the real colleague installer, including a deliberately slow
    # first launch. v0.1.15 killed a valid backend after only a few seconds on
    # machines where endpoint security was still scanning the new files.
    $isolatedLocalAppData = Join-Path $smokeFullPath "isolated-local-app-data"
    New-Item -ItemType Directory -Path $isolatedLocalAppData | Out-Null
    $env:LOCALAPPDATA = $isolatedLocalAppData
    $env:TIKTOK_ASSISTANT_DIAGNOSTIC_STARTUP_DELAY = "8"
    $installerPath = Join-Path $bundleRoot "install.ps1"
    $zoneProbeSource = Join-Path $bundleRoot "_payload\app\VERSION"
    Set-Content -LiteralPath $zoneProbeSource -Stream "Zone.Identifier" `
        -Value "[ZoneTransfer]`r`nZoneId=3" -Encoding ASCII
    if (-not (Get-Item -LiteralPath $zoneProbeSource -Stream "Zone.Identifier" -ErrorAction SilentlyContinue)) {
        throw "Could not create the Mark-of-the-Web release probe."
    }
    $installWatch = [Diagnostics.Stopwatch]::StartNew()
    & $installerPath -NoLaunchGuide -SkipShortcuts
    $installWatch.Stop()
    $slowInstallSeconds = $installWatch.Elapsed.TotalSeconds
    if ($slowInstallSeconds -lt 7.5) {
        throw "Slow-start installer test did not exercise the intended delay."
    }
    $installedBackendPath = Join-Path $isolatedLocalAppData "TikTokDarenAssistant\app\backend\TikTokDarenAssistantBackend.exe"
    $installedHealth = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -TimeoutSec 3
    if ($installedHealth.status -ne "ok" -or $installedHealth.version -ne $expectedVersion) {
        throw "Installed backend health check failed after delayed first launch."
    }
    $zoneProbeInstalled = Join-Path $isolatedLocalAppData "TikTokDarenAssistant\app\VERSION"
    $installedZoneMarker = Get-Item -LiteralPath $zoneProbeInstalled `
        -Stream "Zone.Identifier" -ErrorAction SilentlyContinue
    if ($installedZoneMarker) {
        throw "Installer did not clear Mark-of-the-Web from the installed payload."
    }
    $zoneMarkerCleared = $true
    $installedListener = @(
        Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8765 -State Listen -ErrorAction Stop
    )
    if ($installedListener.Count -ne 1) {
        throw "Installed backend listener ownership is ambiguous."
    }
    $loadedModules = @(
        Get-Process -Id $installedListener[0].OwningProcess -Module -ErrorAction Stop |
            Select-Object -ExpandProperty ModuleName
    )
    if ($loadedModules -contains "ctranslate2.dll") {
        throw "Optional native AI runtime was loaded during base service startup."
    }
    & (Join-Path $isolatedLocalAppData "TikTokDarenAssistant\app\tools\stop.ps1") -Quiet
    Remove-Item -LiteralPath "Env:TIKTOK_ASSISTANT_DIAGNOSTIC_STARTUP_DELAY" -ErrorAction SilentlyContinue

    # Exercise an in-place upgrade under the exact WDAC error reported by the
    # colleague computer. It must continue without a VC++ repair prompt and
    # expose the browser fallback before downloading a native model or media.
    $env:TIKTOK_ASSISTANT_DIAGNOSTIC_AI_POLICY_BLOCK = "1"
    & $installerPath -NoLaunchGuide -SkipShortcuts
    $policyStatusPath = Join-Path $isolatedLocalAppData "TikTokDarenAssistant\data\ai-runtime.json"
    if (-not (Test-Path -LiteralPath $policyStatusPath -PathType Leaf)) {
        throw "Policy-fallback install did not write runtime capability status."
    }
    $policyStatus = Get-Content -LiteralPath $policyStatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($policyStatus.mode -ne "browser" -or
        $policyStatus.reason -ne "APPLICATION_CONTROL_BLOCKED" -or
        -not $policyStatus.browser_fallback) {
        throw "Policy-fallback install recorded an invalid runtime mode."
    }
    $policyHealth = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -TimeoutSec 3
    if ($policyHealth.status -ne "ok" -or $policyHealth.version -ne $expectedVersion) {
        throw "Backend did not remain healthy in policy-fallback mode."
    }
    $policyContent = [Net.Http.StringContent]::new($requestBody, [Text.Encoding]::UTF8, "application/json")
    $policyResponse = $httpClient.PostAsync(
        "http://127.0.0.1:8765/api/v1/transcriptions",
        $policyContent
    ).GetAwaiter().GetResult()
    $policyBody = $policyResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
    if ([int]$policyResponse.StatusCode -ne 503 -or
        $policyBody.detail.code -ne "APPLICATION_CONTROL_BLOCKED" -or
        -not $policyBody.detail.browser_fallback) {
        throw "Policy-blocked transcription did not return the browser fallback contract."
    }
    $policyFallbackInstall = $true
    $policyFallbackApi = $true
    & (Join-Path $isolatedLocalAppData "TikTokDarenAssistant\app\tools\stop.ps1") -Quiet
    Remove-Item -LiteralPath "Env:TIKTOK_ASSISTANT_DIAGNOSTIC_AI_POLICY_BLOCK" -ErrorAction SilentlyContinue

    # Exercise the stricter machine policy from the latest colleague report:
    # Windows refuses to launch the backend EXE itself. Installation must still
    # complete and leave a usable extension for direct Chrome/WASM subtitles.
    $env:TIKTOK_ASSISTANT_DIAGNOSTIC_BACKEND_POLICY_BLOCK = "1"
    & $installerPath -NoLaunchGuide -SkipShortcuts
    $executablePolicyStatus = Get-Content -LiteralPath $policyStatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($executablePolicyStatus.mode -ne "extension-only" -or
        $executablePolicyStatus.reason -ne "APPLICATION_CONTROL_ENFORCED" -or
        -not $executablePolicyStatus.browser_fallback) {
        throw "Backend-executable policy fallback recorded an invalid runtime mode."
    }
    $installedManifestPath = Join-Path $isolatedLocalAppData "TikTokDarenAssistant\app\extension\manifest.json"
    if (-not (Test-Path -LiteralPath $installedManifestPath -PathType Leaf)) {
        throw "Extension-only installation did not install the Chrome extension."
    }
    if (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue) {
        throw "Extension-only installation unexpectedly started a blocked backend."
    }
    $backendExecutableFallbackInstall = $true
    Remove-Item -LiteralPath "Env:TIKTOK_ASSISTANT_DIAGNOSTIC_BACKEND_POLICY_BLOCK" -ErrorAction SilentlyContinue

    # Simulate endpoint security quarantining a payload file. The installer
    # must fail before touching the current installation and identify the file.
    Remove-Item -LiteralPath $zoneProbeSource -Force
    try {
        & $installerPath -NoLaunchGuide -SkipShortcuts
        throw "Installer unexpectedly accepted a quarantined payload file."
    } catch {
        if ($_.Exception.Message -notmatch 'missing or was quarantined:\s+VERSION') {
            throw
        }
        $quarantineDetected = $true
    }

    [pscustomobject]@{
        ZipMiB = [math]::Round((Get-Item -LiteralPath $archiveFullPath).Length / 1MB, 2)
        UncompressedMiB = [math]::Round($uncompressedBytes / 1MB, 2)
        Entries = $entries.Count
        SHA256 = $actualHash
        HealthVersion = $health.version
        Models = ($models.models.id -join ",")
        InstalledModels = $installedModels.Count
        TranscriptionStatus = [int]$response.StatusCode
        ForbiddenEntries = $forbidden.Count
        SlowInstallSeconds = [math]::Round($slowInstallSeconds, 2)
        NativeAiLoadedAtStartup = $false
        ZoneMarkerCleared = $zoneMarkerCleared
        QuarantineDetected = $quarantineDetected
        AiRuntimeSelfTest = $aiRuntimeSelfTest.ok
        AiCpuComputeTypes = (@($aiRuntimeSelfTest.cpu_compute_types) -join ",")
        VcRedistVersion = $vcRedistVersion
        VcRedistSignedByMicrosoft = $true
        WhisperModelInference = [bool]$aiRuntimeSelfTest.whisper_model_loaded
        PolicyFallbackInstall = $policyFallbackInstall
        PolicyFallbackApi = $policyFallbackApi
        BackendExecutableFallbackInstall = $backendExecutableFallbackInstall
    }
} finally {
    if ($httpClient) { $httpClient.Dispose() }
    foreach ($ownedBackendPath in @($backendPath, $installedBackendPath)) {
        if ($ownedBackendPath) {
            $expectedBackendPath = [IO.Path]::GetFullPath($ownedBackendPath)
            $ownedProcesses = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
                try {
                    $_.Path -and [IO.Path]::GetFullPath($_.Path).Equals(
                        $expectedBackendPath,
                        [StringComparison]::OrdinalIgnoreCase
                    )
                } catch { $false }
            })
            foreach ($ownedProcess in $ownedProcesses) {
                Stop-Process -Id $ownedProcess.Id -Force -ErrorAction SilentlyContinue
                try { Wait-Process -Id $ownedProcess.Id -Timeout 5 -ErrorAction SilentlyContinue } catch {}
            }
        }
    }
    foreach ($name in (
        "TIKTOK_ASSISTANT_HOME",
        "TIKTOK_ASSISTANT_DB_PATH",
        "TIKTOK_ASSISTANT_MODEL_ROOT",
        "TIKTOK_ASSISTANT_OUTPUT_ROOT",
        "TIKTOK_ASSISTANT_PORT",
        "TIKTOK_ASSISTANT_DIAGNOSTIC_AI_POLICY_BLOCK",
        "TIKTOK_ASSISTANT_DIAGNOSTIC_BACKEND_POLICY_BLOCK"
    )) {
        Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    }
    $env:LOCALAPPDATA = $originalLocalAppData
    if ($null -eq $originalDiagnosticDelay) {
        Remove-Item -LiteralPath "Env:TIKTOK_ASSISTANT_DIAGNOSTIC_STARTUP_DELAY" -ErrorAction SilentlyContinue
    } else {
        $env:TIKTOK_ASSISTANT_DIAGNOSTIC_STARTUP_DELAY = $originalDiagnosticDelay
    }
    if (Test-Path -LiteralPath $smokeFullPath) {
        Remove-SmokeDirectory $smokeFullPath
    }
}
