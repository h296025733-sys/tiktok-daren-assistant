[CmdletBinding()]
param(
    [switch]$SkipValidation,
    [switch]$KeepWork
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$backendRoot = Join-Path $repositoryRoot "backend"
$extensionRoot = Join-Path $repositoryRoot "extension"
$packagingRoot = Join-Path $repositoryRoot "packaging"
$releaseRoot = Join-Path $repositoryRoot "release"
$python = Join-Path $backendRoot ".venv\Scripts\python.exe"
$spec = Join-Path $packagingRoot "backend.spec"
$windowsTemplate = Join-Path $packagingRoot "windows"

function Normalize-Path([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Assert-ReleaseChild([string]$Path) {
    $root = Normalize-Path $releaseRoot
    $candidate = Normalize-Path $Path
    $prefix = $root + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside release/: $candidate"
    }
}

function Remove-ReleaseDirectory([string]$Path) {
    Assert-ReleaseChild $Path
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

function Invoke-Checked([string]$Label, [scriptblock]$Command) {
    Write-Host $Label -ForegroundColor Cyan
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

function Assert-MicrosoftVcRedist([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or
        (Get-Item -LiteralPath $Path).Length -lt 10MB) {
        throw "Microsoft Visual C++ Redistributable is missing or incomplete."
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
        -not $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
        throw "Microsoft Visual C++ Redistributable signature validation failed."
    }
}

if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -notmatch "AMD64|x86") {
    throw "This release target requires 64-bit Windows."
}
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "Build Python is missing. Run scripts\setup.ps1 first."
}

$manifestPath = Join-Path $extensionRoot "manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$manifest.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') {
    throw "Unsupported extension version: $version"
}
$mainSource = Get-Content -LiteralPath (Join-Path $backendRoot "app\main.py") -Raw -Encoding UTF8
$versionMatch = [regex]::Match($mainSource, 'VERSION\s*=\s*"([^"]+)"')
if (-not $versionMatch.Success -or $versionMatch.Groups[1].Value -ne $version) {
    throw "Backend and extension versions do not match."
}
$packageJson = Get-Content -LiteralPath (Join-Path $extensionRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$packageJson.version -ne $version) {
    throw "Extension package.json and manifest versions do not match."
}

& $python -m PyInstaller --version *> $null
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller is missing. Run: backend\.venv\Scripts\python.exe -m pip install -r packaging\requirements-build.txt"
}

if (-not $SkipValidation) {
    Invoke-Checked "[1/4] Extension tests, type check and production build" {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "build_extension.ps1")
    }
    Invoke-Checked "[2/4] Backend tests" {
        & $python -m pytest (Join-Path $backendRoot "tests") -q
    }
}

$distExtension = Join-Path $extensionRoot "dist"
$requiredExtensionFiles = @(
    "manifest.json",
    "background.js",
    "content.js",
    "page-bridge.js",
    "sidepanel.html",
    "assets\sidepanel.js",
    "assets\sidepanel.css",
    "assets\transformers.web.js",
    "assets\onnx\ort-wasm-simd-threaded.mjs",
    "assets\onnx\ort-wasm-simd-threaded.wasm"
)
foreach ($relativePath in $requiredExtensionFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $distExtension $relativePath) -PathType Leaf)) {
        throw "Extension build is incomplete: $relativePath"
    }
}
$distManifest = Get-Content -LiteralPath (Join-Path $distExtension "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$distManifest.version -ne $version) {
    throw "Extension dist is stale (dist=$($distManifest.version), source=$version). Run the extension build first."
}

New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
$prerequisiteCache = Join-Path $releaseRoot "prerequisite-cache"
New-Item -ItemType Directory -Path $prerequisiteCache -Force | Out-Null
$vcRedistCachePath = Join-Path $prerequisiteCache "vc_redist.x64.exe"
$downloadVcRedist = $true
if (Test-Path -LiteralPath $vcRedistCachePath -PathType Leaf) {
    try {
        Assert-MicrosoftVcRedist $vcRedistCachePath
        $downloadVcRedist = $false
    } catch {
        Remove-Item -LiteralPath $vcRedistCachePath -Force
    }
}
if ($downloadVcRedist) {
    Write-Host "Downloading signed Microsoft Visual C++ runtime prerequisite..." -ForegroundColor Cyan
    Invoke-WebRequest `
        -Uri "https://aka.ms/vc14/vc_redist.x64.exe" `
        -OutFile $vcRedistCachePath `
        -UseBasicParsing
    Assert-MicrosoftVcRedist $vcRedistCachePath
}
$pyInstallerDist = Join-Path $releaseRoot "pyinstaller-dist"
$pyInstallerWork = Join-Path $releaseRoot "pyinstaller-work"
$stagingRoot = Join-Path $releaseRoot "staging"
$bundleName = "TikTokDarenAssistant-v$version-win-x64"
# Keep the directory inside the ZIP intentionally short. Explorer and Windows
# PowerShell 5.1 can still hit legacy MAX_PATH behavior when a received archive
# is extracted below a long chat/download directory.
$bundleRootName = "TDA-v$version"
$bundleRoot = Join-Path $stagingRoot $bundleRootName
$archivePath = Join-Path $releaseRoot "$bundleName.zip"
$checksumPath = "$archivePath.sha256.txt"

Remove-ReleaseDirectory $pyInstallerDist
Remove-ReleaseDirectory $pyInstallerWork
Remove-ReleaseDirectory $stagingRoot
if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
if (Test-Path -LiteralPath $checksumPath) { Remove-Item -LiteralPath $checksumPath -Force }

Invoke-Checked "[3/4] Build self-contained Windows backend" {
    & $python -m PyInstaller `
        --noconfirm `
        --clean `
        --distpath $pyInstallerDist `
        --workpath $pyInstallerWork `
        $spec
}

$builtBackend = Join-Path $pyInstallerDist "TikTokDarenAssistantBackend"
if (-not (Test-Path -LiteralPath (Join-Path $builtBackend "TikTokDarenAssistantBackend.exe"))) {
    throw "PyInstaller backend output is missing."
}

# PyInstaller hooks may copy deeply nested third-party license trees into
# *.dist-info. They are not read at runtime and can push colleague installs
# over legacy MAX_PATH limits. Distribution metadata itself remains intact.
$runtimeLicenseDirectories = @(
    Get-ChildItem -LiteralPath (Join-Path $builtBackend "_internal") -Directory -Recurse -Filter "licenses" |
        Where-Object { $_.Parent.Name -like "*.dist-info" }
)
foreach ($licenseDirectory in $runtimeLicenseDirectories) {
    Remove-ReleaseDirectory $licenseDirectory.FullName
}

New-Item -ItemType Directory -Path $bundleRoot -Force | Out-Null
Copy-Item -Path (Join-Path $windowsTemplate "root\*") -Destination $bundleRoot -Recurse -Force
$payloadApp = Join-Path $bundleRoot "_payload\app"
New-Item -ItemType Directory -Path $payloadApp -Force | Out-Null
Copy-Item -Path (Join-Path $windowsTemplate "app\*") -Destination $payloadApp -Recurse -Force
Copy-Item -LiteralPath $builtBackend -Destination (Join-Path $payloadApp "backend") -Recurse -Force
Set-Content -LiteralPath (Join-Path $payloadApp "VERSION") -Value $version -Encoding ASCII
$payloadPrerequisites = Join-Path $payloadApp "prerequisites"
New-Item -ItemType Directory -Path $payloadPrerequisites -Force | Out-Null
Copy-Item -LiteralPath $vcRedistCachePath -Destination (Join-Path $payloadPrerequisites "vc_redist.x64.exe")

$payloadExtension = Join-Path $payloadApp "extension"
New-Item -ItemType Directory -Path (Join-Path $payloadExtension "assets") -Force | Out-Null
foreach ($relativePath in @("manifest.json", "background.js", "content.js", "page-bridge.js", "sidepanel.html")) {
    Copy-Item -LiteralPath (Join-Path $distExtension $relativePath) -Destination (Join-Path $payloadExtension $relativePath)
}
$distAssets = Join-Path $distExtension "assets"
Get-ChildItem -LiteralPath $distAssets -File -Recurse |
    Where-Object {
        $_.Extension -in @(".js", ".css", ".mjs", ".wasm") -and
        $_.BaseName -notlike "ui-preview*"
    } |
    ForEach-Object {
        $relativeAsset = $_.FullName.Substring($distAssets.Length + 1)
        $destination = Join-Path (Join-Path $payloadExtension "assets") $relativeAsset
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $destination
    }

# Ship an internal file manifest so the installer can distinguish a genuine
# backend failure from a DLL/EXE that was removed or modified by transfer or
# endpoint-security software.
$integrityRecords = @(
    Get-ChildItem -LiteralPath $payloadApp -Recurse -File -Force |
        Sort-Object FullName |
        ForEach-Object {
            [pscustomobject]@{
                path = $_.FullName.Substring($payloadApp.Length + 1).Replace("\", "/")
                size = $_.Length
                sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
)
$integrityManifest = [pscustomobject]@{
    version = $version
    files = $integrityRecords
}
$integrityManifestPath = Join-Path $bundleRoot "_payload\integrity.sha256.json"
$integrityManifest | ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath $integrityManifestPath -Encoding UTF8

$forbiddenSegments = @(
    ".venv", "models", "node_modules", "tests", "outputs", "logs", "data",
    "__pycache__", ".pytest_cache"
)
$forbiddenExtensions = @(".db", ".pyc", ".pdb", ".argosmodel")
$releaseFiles = @(Get-ChildItem -LiteralPath $bundleRoot -Recurse -File -Force)
$longestReleasePath = @(
    $releaseFiles | ForEach-Object { $_.FullName.Substring($bundleRoot.Length + 1).Length }
    ) | Measure-Object -Maximum | Select-Object -ExpandProperty Maximum
if ($longestReleasePath -gt 120) {
    throw "Release contains a runtime path longer than 120 characters."
}
foreach ($file in $releaseFiles) {
    $relative = $file.FullName.Substring($bundleRoot.Length + 1)
    $segments = $relative -split '[\\/]'
    if ($segments | Where-Object { $forbiddenSegments -contains $_.ToLowerInvariant() }) {
        throw "Forbidden runtime/development directory entered release: $relative"
    }
    if ($forbiddenExtensions -contains $file.Extension.ToLowerInvariant() -or $file.Name -eq "model.bin") {
        throw "Forbidden data/model file entered release: $relative"
    }
    if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Release must not contain reparse points: $relative"
    }
}

$uncompressedBytes = ($releaseFiles | Measure-Object -Property Length -Sum).Sum
if ($uncompressedBytes -gt 700MB) {
    throw "Model-free release unexpectedly exceeds 700 MiB."
}

Invoke-Checked "[4/4] Create lightweight colleague ZIP" {
    Compress-Archive -LiteralPath $bundleRoot -DestinationPath $archivePath -CompressionLevel Optimal
}
$archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath $checksumPath -Value "$archiveHash  $([IO.Path]::GetFileName($archivePath))" -Encoding ASCII

if (-not $KeepWork) {
    Remove-ReleaseDirectory $pyInstallerDist
    Remove-ReleaseDirectory $pyInstallerWork
    Remove-ReleaseDirectory $stagingRoot
}

$archiveMiB = [math]::Round((Get-Item -LiteralPath $archivePath).Length / 1MB, 1)
Write-Host "Release ready: $archivePath ($archiveMiB MiB)" -ForegroundColor Green
Write-Host "SHA-256: $archiveHash"
