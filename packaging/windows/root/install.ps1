[CmdletBinding()]
param(
    [switch]$NoLaunchGuide,
    [switch]$SkipShortcuts
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$packageRoot = Split-Path -Parent $PSCommandPath
$packageAppRoot = Join-Path $packageRoot "_payload\app"
$integrityManifestPath = Join-Path $packageRoot "_payload\integrity.sha256.json"
$productRoot = Join-Path $env:LOCALAPPDATA "TikTokDarenAssistant"
$installedAppRoot = Join-Path $productRoot "app"
$stagingAppRoot = Join-Path $productRoot ("stage-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$backupAppRoot = Join-Path $productRoot "app.previous"
$backendRelativePath = "backend\TikTokDarenAssistantBackend.exe"
$sourceBackend = Join-Path $packageAppRoot $backendRelativePath
$sourceManifest = Join-Path $packageAppRoot "extension\manifest.json"
$isUpgrade = Test-Path -LiteralPath (Join-Path $installedAppRoot "extension\manifest.json") -PathType Leaf

function Normalize-Path([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Assert-ManagedChild([string]$Path) {
    $root = Normalize-Path $productRoot
    $candidate = Normalize-Path $Path
    $prefix = $root + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the product directory: $candidate"
    }
}

function Remove-ManagedDirectory([string]$Path) {
    Assert-ManagedChild $Path
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

function Assert-AppIntegrity([string]$AppRoot, [string]$ManifestPath) {
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
        throw "The release integrity manifest is missing. Download the package again."
    }
    $integrity = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $records = @($integrity.files)
    if (-not $integrity.version -or $records.Count -lt 10) {
        throw "The release integrity manifest is invalid. Download the package again."
    }
    $normalizedRoot = Normalize-Path $AppRoot
    $rootPrefix = $normalizedRoot + [IO.Path]::DirectorySeparatorChar
    foreach ($record in $records) {
        $relativePath = [string]$record.path
        if (-not $relativePath -or [IO.Path]::IsPathRooted($relativePath)) {
            throw "Unsafe path in the release integrity manifest: $relativePath"
        }
        $candidate = Normalize-Path (Join-Path $normalizedRoot $relativePath.Replace("/", "\"))
        if (-not $candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Unsafe path in the release integrity manifest: $relativePath"
        }
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "A required application file is missing or was quarantined: $relativePath"
        }
        $file = Get-Item -LiteralPath $candidate
        if ($file.Length -ne [long]$record.size) {
            throw "A required application file has the wrong size: $relativePath"
        }
        $actualHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash
        if (-not $actualHash.Equals([string]$record.sha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw "A required application file failed integrity verification: $relativePath"
        }
    }
    return [string]$integrity.version
}

function Test-ProcessPath([int]$ProcessId, [string]$ExpectedPath) {
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        return (Normalize-Path $process.Path) -eq (Normalize-Path $ExpectedPath)
    } catch {
        return $false
    }
}

function Test-LegacyAssistantBackend([int]$ProcessId) {
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        if ([IO.Path]::GetFileName($process.Path) -eq "TikTokDarenAssistantBackend.exe") {
            return $true
        }
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        $commandLine = [string]$processInfo.CommandLine
        return (
            $commandLine -match '(?i)-m\s+uvicorn\s+app\.main:app' -and
            $commandLine -match '(?i)--host\s+127\.0\.0\.1' -and
            $commandLine -match '(?i)--port\s+8765'
        )
    } catch {
        return $false
    }
}

function Test-AssistantHealth {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -TimeoutSec 2
        return $health.status -eq "ok" -and $health.service -eq "tiktok-daren-assistant"
    } catch {
        return $false
    }
}

function Invoke-AiRuntimeSelfTest([string]$BackendPath) {
    if ($env:TIKTOK_ASSISTANT_DIAGNOSTIC_BACKEND_POLICY_BLOCK -eq "1") {
        return [pscustomobject]@{
            Success = $false
            ExitCode = -1
            Detail = "Diagnostic: Windows application control policy blocked the backend executable."
            InvocationFailed = $true
        }
    }
    try {
        $output = @(& $BackendPath --self-test-ai-runtime 2>&1 | ForEach-Object { [string]$_ })
        $exitCode = $LASTEXITCODE
        return [pscustomobject]@{
            Success = $exitCode -eq 0
            ExitCode = $exitCode
            Detail = ($output -join [Environment]::NewLine).Trim()
            InvocationFailed = $false
        }
    } catch {
        return [pscustomobject]@{
            Success = $false
            ExitCode = -1
            Detail = ("{0}: {1}" -f $_.FullyQualifiedErrorId, $_.Exception.Message)
            InvocationFailed = $true
        }
    }
}

function Test-ApplicationControlBlock([string]$Detail) {
    return $Detail -match (
        '(?i)application control policy|' +
        'windows defender application control|' +
        'smart app control|' +
        'APPLICATION_CONTROL_BLOCKED'
    )
}

function Test-ApplicationControlEnforced {
    if ($env:TIKTOK_ASSISTANT_DIAGNOSTIC_BACKEND_POLICY_BLOCK -eq "1") {
        return $true
    }
    try {
        $policy = Get-ItemProperty `
            -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy" `
            -Name "VerifiedAndReputablePolicyState" `
            -ErrorAction Stop
        if ([int]$policy.VerifiedAndReputablePolicyState -eq 1) {
            return $true
        }
    } catch {}
    try {
        $deviceGuard = Get-CimInstance `
            -Namespace "root\Microsoft\Windows\DeviceGuard" `
            -ClassName "Win32_DeviceGuard" `
            -ErrorAction Stop
        if ([int]$deviceGuard.UsermodeCodeIntegrityPolicyEnforcementStatus -eq 2) {
            return $true
        }
    } catch {}
    try {
        $appLockerXml = [xml](Get-AppLockerPolicy -Effective -Xml -ErrorAction Stop)
        $enforcedExeRules = @($appLockerXml.AppLockerPolicy.RuleCollection | Where-Object {
            $_.Type -eq "Exe" -and $_.EnforcementMode -eq "Enabled"
        })
        if ($enforcedExeRules.Count -gt 0) {
            return $true
        }
    } catch {}
    return $false
}

function Set-AiRuntimeMode([string]$Mode, [string]$Reason, [int]$ExitCode) {
    $statusPath = Join-Path $productRoot "data\ai-runtime.json"
    $status = [ordered]@{
        mode = $Mode
        native_available = $Mode -eq "native"
        browser_fallback = $Mode -ne "native"
        reason = $Reason
        self_test_exit_code = $ExitCode
        updated_at = [DateTimeOffset]::UtcNow.ToString("o")
    }
    $status | ConvertTo-Json -Depth 3 |
        Set-Content -LiteralPath $statusPath -Encoding UTF8
}

function Assert-MicrosoftVcRedist([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Microsoft Visual C++ runtime repair package is missing. Download the package again."
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
        -not $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
        throw "Microsoft Visual C++ runtime repair package is not signed by Microsoft."
    }
}

function Ensure-AiRuntime([string]$AppRoot) {
    $backendPath = Join-Path $AppRoot $backendRelativePath
    if (Test-ApplicationControlEnforced) {
        Set-AiRuntimeMode "extension-only" "APPLICATION_CONTROL_ENFORCED" -1
        Write-Warning (
            "Windows user-mode application control is enforced. The optional unsigned backend will not be started. " +
            "Installation will continue in extension-only mode; subtitles will run inside Chrome."
        )
        return $false
    }
    $initial = Invoke-AiRuntimeSelfTest $backendPath
    if ($initial.InvocationFailed) {
        Set-AiRuntimeMode "extension-only" "BACKEND_EXECUTION_BLOCKED" $initial.ExitCode
        Write-Warning (
            "Windows application control blocked the optional local backend executable. " +
            "Installation will continue in extension-only mode; subtitles will run inside Chrome."
        )
        return $false
    }
    if ($initial.Success) {
        Set-AiRuntimeMode "native" "" 0
        Write-Host "Local speech runtime compatibility check passed." -ForegroundColor Green
        return $true
    }

    if (Test-ApplicationControlBlock $initial.Detail) {
        Set-AiRuntimeMode "browser" "APPLICATION_CONTROL_BLOCKED" $initial.ExitCode
        Write-Warning (
            "Windows application control policy blocks the optional native AI runtime. " +
            "Installation will continue; subtitles will automatically use Chrome's browser-compatible mode."
        )
        return $true
    }

    $vcRedist = Join-Path $AppRoot "prerequisites\vc_redist.x64.exe"
    Assert-MicrosoftVcRedist $vcRedist
    Write-Host "Installing the required Microsoft Visual C++ x64 runtime..." -ForegroundColor Yellow
    Write-Host "Windows may ask for administrator approval once." -ForegroundColor Yellow
    try {
        $repair = Start-Process `
            -FilePath $vcRedist `
            -ArgumentList "/install", "/quiet", "/norestart" `
            -Verb RunAs `
            -Wait `
            -PassThru
    } catch {
        throw "Microsoft Visual C++ runtime installation was cancelled or blocked. $($_.Exception.Message)"
    }
    if ($repair.ExitCode -notin @(0, 1638, 3010)) {
        throw "Microsoft Visual C++ runtime installation failed (exit code: $($repair.ExitCode))."
    }

    $retested = Invoke-AiRuntimeSelfTest $backendPath
    if (-not $retested.Success) {
        $reason = if (Test-ApplicationControlBlock $retested.Detail) {
            "APPLICATION_CONTROL_BLOCKED"
        } else {
            "NATIVE_RUNTIME_UNAVAILABLE"
        }
        Set-AiRuntimeMode "browser" $reason $retested.ExitCode
        Write-Warning (
            "The optional native AI runtime is unavailable after automatic repair. " +
            "Installation will continue; subtitles will automatically use Chrome's browser-compatible mode. " +
            "Diagnostic: $($retested.Detail)"
        )
        return $true
    }
    Set-AiRuntimeMode "native" "" 0
    Write-Host "Microsoft Visual C++ runtime repair completed." -ForegroundColor Green
    return $true
}

function Stop-ExistingInstalledBackend {
    $expectedBackend = Join-Path $installedAppRoot $backendRelativePath
    $candidateIds = @()
    $pidFile = Join-Path $productRoot "run\backend.pid"
    if (Test-Path -LiteralPath $pidFile) {
        $parsedPid = 0
        $rawPid = (Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
        if ([int]::TryParse($rawPid, [ref]$parsedPid)) {
            $candidateIds += $parsedPid
        }
    }
    $listeners = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)
    $listenerIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    $candidateIds += $listenerIds
    $assistantHealth = $listenerIds.Count -gt 0 -and (Test-AssistantHealth)
    foreach ($processId in @($candidateIds | Select-Object -Unique)) {
        $isInstalledBackend = Test-ProcessPath ([int]$processId) $expectedBackend
        $isRecognizedLegacyBackend = (
            $assistantHealth -and
            $listenerIds -contains $processId -and
            (Test-LegacyAssistantBackend ([int]$processId))
        )
        if ($isInstalledBackend -or $isRecognizedLegacyBackend) {
            Stop-Process -Id ([int]$processId) -Force -ErrorAction Stop
            try { Wait-Process -Id ([int]$processId) -Timeout 5 -ErrorAction SilentlyContinue } catch {}
        }
    }
    if (Test-Path -LiteralPath $pidFile) {
        Remove-Item -LiteralPath $pidFile -Force
    }
}

function New-Shortcut(
    [string]$ShortcutPath,
    [string]$TargetPath,
    [string]$Arguments,
    [string]$WorkingDirectory
) {
    $parent = Split-Path -Parent $ShortcutPath
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    $shortcut.TargetPath = $TargetPath
    $shortcut.Arguments = $Arguments
    $shortcut.WorkingDirectory = $WorkingDirectory
    $shortcut.IconLocation = "$TargetPath,0"
    $shortcut.Save()
}

function Find-Chrome {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe")
    )
    return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

if (-not (Test-Path -LiteralPath $sourceBackend -PathType Leaf)) {
    throw "The release payload is incomplete: backend executable is missing."
}
if (-not (Test-Path -LiteralPath $sourceManifest -PathType Leaf)) {
    throw "The release payload is incomplete: extension manifest is missing."
}

$manifest = Get-Content -LiteralPath $sourceManifest -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $manifest.version) {
    throw "The extension manifest does not contain a version."
}
$integrityVersion = Assert-AppIntegrity $packageAppRoot $integrityManifestPath
if ($integrityVersion -ne [string]$manifest.version) {
    throw "The release payload versions do not match. Download the package again."
}

Write-Host "Installing TikTok Daren Assistant $($manifest.version) for the current Windows user..." -ForegroundColor Cyan
New-Item -ItemType Directory -Path $productRoot -Force | Out-Null
foreach ($directory in ("data", "models", "outputs", "logs", "run", "cache")) {
    New-Item -ItemType Directory -Path (Join-Path $productRoot $directory) -Force | Out-Null
}

Stop-ExistingInstalledBackend
Remove-ManagedDirectory $stagingAppRoot
Copy-Item -LiteralPath $packageAppRoot -Destination $stagingAppRoot -Recurse -Force
# Files extracted from a ZIP received through a browser or chat program may
# inherit Mark-of-the-Web. Clear it inside our private staging directory before
# starting the bundled executable and native DLLs.
Get-ChildItem -LiteralPath $stagingAppRoot -Recurse -File -Force |
    Unblock-File -ErrorAction SilentlyContinue
Assert-AppIntegrity $stagingAppRoot $integrityManifestPath | Out-Null

$installed = $false
$backendAvailable = $false
try {
    Remove-ManagedDirectory $backupAppRoot
    if (Test-Path -LiteralPath $installedAppRoot) {
        Move-Item -LiteralPath $installedAppRoot -Destination $backupAppRoot
    }
    Move-Item -LiteralPath $stagingAppRoot -Destination $installedAppRoot

    $backendAvailable = Ensure-AiRuntime $installedAppRoot
    if ($backendAvailable) {
        $startScript = Join-Path $installedAppRoot "tools\start.ps1"
        & $startScript -Quiet
    }
    $installed = $true
} finally {
    if (-not $installed) {
        Stop-ExistingInstalledBackend
        Remove-ManagedDirectory $installedAppRoot
        if (Test-Path -LiteralPath $backupAppRoot) {
            Move-Item -LiteralPath $backupAppRoot -Destination $installedAppRoot
            try { & (Join-Path $installedAppRoot "tools\start.ps1") -Quiet } catch {}
        }
    }
    Remove-ManagedDirectory $stagingAppRoot
}

Remove-ManagedDirectory $backupAppRoot

if (-not $SkipShortcuts) {
    $powershellPath = Join-Path $PSHOME "powershell.exe"
    $startupDirectory = [Environment]::GetFolderPath("Startup")
    $startupLink = Join-Path $startupDirectory "TikTokDarenAssistant.lnk"
    $startScriptPath = Join-Path $installedAppRoot "tools\start.ps1"
    if ($backendAvailable) {
        New-Shortcut `
            $startupLink `
            $powershellPath `
            ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $startScriptPath + '" -Quiet') `
            $installedAppRoot
    } elseif (Test-Path -LiteralPath $startupLink) {
        Remove-Item -LiteralPath $startupLink -Force
    }

    $programsDirectory = [Environment]::GetFolderPath("Programs")
    $programGroup = Join-Path $programsDirectory "TikTok Daren Assistant"
    New-Shortcut (Join-Path $programGroup "Start TikTok Daren Assistant.lnk") `
        (Join-Path $installedAppRoot "Start.cmd") "" $installedAppRoot
    New-Shortcut (Join-Path $programGroup "Open Extension Setup.lnk") `
        (Join-Path $installedAppRoot "Open-Extension-Setup.cmd") "" $installedAppRoot
    New-Shortcut (Join-Path $programGroup "Uninstall TikTok Daren Assistant.lnk") `
        (Join-Path $installedAppRoot "Uninstall.cmd") "" $installedAppRoot
}

$extensionRoot = Join-Path $installedAppRoot "extension"

if ($backendAvailable) {
    Write-Host "Installation complete. Local service health check passed." -ForegroundColor Green
} else {
    Write-Host "Installation complete in Chrome-only compatibility mode." -ForegroundColor Green
}
if ($isUpgrade) {
    Write-Host "Update complete. Click Reload for TikTok Daren Assistant on chrome://extensions/." -ForegroundColor Yellow
} else {
    try { Set-Clipboard -Value $extensionRoot -ErrorAction Stop } catch {}
    Write-Host "Extension folder (also copied to clipboard): $extensionRoot"
    Write-Host "Enable Developer mode, choose Load unpacked, and select this folder." -ForegroundColor Yellow
}

if (-not $NoLaunchGuide) {
    if (-not $isUpgrade) {
        Start-Process -FilePath "explorer.exe" -ArgumentList ('"' + $extensionRoot + '"')
    }
    $chrome = Find-Chrome
    if ($chrome) {
        Start-Process -FilePath $chrome -ArgumentList "chrome://extensions/"
    }
}
