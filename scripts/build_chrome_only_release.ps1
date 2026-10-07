[CmdletBinding()]
param(
    [switch]$SkipValidation,
    [string]$LicenseApiBase = "https://tda-device-license.linglily135.workers.dev"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$extensionRoot = Join-Path $repositoryRoot "extension"
$distRoot = Join-Path $extensionRoot "dist"
$releaseRoot = Join-Path $repositoryRoot "release"
$manifestPath = Join-Path $extensionRoot "manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$manifest.version
$bundleName = "TikTokDarenAssistant-v$version-chrome-only"
$stagingRoot = Join-Path $releaseRoot "chrome-only-staging"
$bundleRoot = Join-Path $stagingRoot "TDA-Chrome-v$version"
$archivePath = Join-Path $releaseRoot "$bundleName.zip"
$checksumPath = "$archivePath.sha256.txt"

$licenseUri = $null
if (-not [Uri]::TryCreate($LicenseApiBase, [UriKind]::Absolute, [ref]$licenseUri) -or
    $licenseUri.Scheme -ne "https") {
    throw "LicenseApiBase must be a valid HTTPS address."
}
$env:TDA_LICENSE_ENFORCED = "1"
$env:TDA_LICENSE_API_BASE = $LicenseApiBase.TrimEnd("/")

function Assert-ReleaseChild([string]$Path) {
    $root = [IO.Path]::GetFullPath($releaseRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $candidate = [IO.Path]::GetFullPath($Path)
    if (-not $candidate.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside release/: $candidate"
    }
}

function Remove-ReleasePath([string]$Path) {
    Assert-ReleaseChild $Path
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
}

if (-not $SkipValidation) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "build_extension.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Chrome extension validation failed." }
}

# The regular validation build above stays hybrid for regression coverage. The
# distributable is then rebuilt with an explicit compile-time flag. This is not
# a runtime preference: unreachable localhost/native-model branches are removed
# by the bundler before files are copied into the archive.
$previousChromeOnlyBuild = [Environment]::GetEnvironmentVariable("TDA_CHROME_ONLY_BUILD", "Process")
[Environment]::SetEnvironmentVariable("TDA_CHROME_ONLY_BUILD", "1", "Process")
Push-Location $extensionRoot
try {
    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCommand) {
        & $npmCommand.Source run build | Out-Host
    } else {
        $bundledPnpm = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"
        $bundledNodeDirectory = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
        if (-not (Test-Path -LiteralPath $bundledPnpm -PathType Leaf)) {
            throw "No npm or bundled pnpm is available for the Chrome-only build."
        }
        if (Test-Path -LiteralPath (Join-Path $bundledNodeDirectory "node.exe") -PathType Leaf) {
            $env:PATH = "$bundledNodeDirectory;$env:PATH"
        }
        & $bundledPnpm run build | Out-Host
    }
    if ($LASTEXITCODE -ne 0) { throw "Chrome-only compile failed." }
} finally {
    Pop-Location
    [Environment]::SetEnvironmentVariable("TDA_CHROME_ONLY_BUILD", $previousChromeOnlyBuild, "Process")
}

if (-not (Test-Path -LiteralPath (Join-Path $distRoot "manifest.json") -PathType Leaf)) {
    throw "Extension dist is missing. Run scripts\build_extension.ps1 first."
}
$distManifest = Get-Content -LiteralPath (Join-Path $distRoot "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$distManifest.version -ne $version) {
    throw "Extension dist is stale (dist=$($distManifest.version), source=$version)."
}
if (($distManifest.host_permissions -join " ") -match 'localhost|127\.0\.0\.1' -or
    [string]$distManifest.content_security_policy.extension_pages -match 'localhost|127\.0\.0\.1') {
    throw "Chrome-only manifest still grants access to a local backend."
}
$licenseOrigin = $licenseUri.GetLeftPart([UriPartial]::Authority)
if ($distManifest.host_permissions -notcontains "$licenseOrigin/*" -or
    [string]$distManifest.content_security_policy.extension_pages -notmatch [regex]::Escape($licenseOrigin)) {
    throw "Chrome-only manifest is missing the fixed license service origin."
}

New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
Remove-ReleasePath $stagingRoot
if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
if (Test-Path -LiteralPath $checksumPath) { Remove-Item -LiteralPath $checksumPath -Force }
New-Item -ItemType Directory -Path (Join-Path $bundleRoot "assets") -Force | Out-Null

foreach ($name in @("CHROME_ONLY_BUILD", "manifest.json", "background.js", "content.js", "page-bridge.js", "sidepanel.html")) {
    Copy-Item -LiteralPath (Join-Path $distRoot $name) -Destination (Join-Path $bundleRoot $name)
}
$distAssets = Join-Path $distRoot "assets"
Get-ChildItem -LiteralPath $distAssets -File -Recurse | Where-Object {
    $_.BaseName -notlike "ui-preview*" -and $_.Extension -in @(".js", ".css", ".mjs", ".wasm")
} | ForEach-Object {
    $relative = $_.FullName.Substring($distAssets.Length + 1)
    $destination = Join-Path (Join-Path $bundleRoot "assets") $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $destination
}

$files = @(Get-ChildItem -LiteralPath $bundleRoot -File -Recurse -Force)
$forbiddenExtensions = @(".exe", ".dll", ".pyd", ".msi", ".ps1", ".bat", ".cmd", ".com", ".scr")
$forbidden = @($files | Where-Object { $forbiddenExtensions -contains $_.Extension.ToLowerInvariant() })
if ($forbidden.Count) {
    throw "Chrome-only package contains a Windows executable or script: $($forbidden[0].FullName)"
}
foreach ($required in @(
    "CHROME_ONLY_BUILD",
    "manifest.json",
    "background.js",
    "content.js",
    "page-bridge.js",
    "sidepanel.html",
    "assets\sidepanel.js",
    "assets\sidepanel.css",
    "assets\transformers.web.js",
    "assets\onnx\ort-wasm-simd-threaded.wasm"
)) {
    if (-not (Test-Path -LiteralPath (Join-Path $bundleRoot $required) -PathType Leaf)) {
        throw "Chrome-only package is missing $required"
    }
}

$marker = "TDA_CHROME_ONLY_ACTIVE"
$backgroundText = Get-Content -LiteralPath (Join-Path $bundleRoot "background.js") -Raw -Encoding UTF8
$sidepanelText = Get-Content -LiteralPath (Join-Path $bundleRoot "assets\sidepanel.js") -Raw -Encoding UTF8
if (-not $backgroundText.Contains($marker) -or -not $sidepanelText.Contains($marker)) {
    throw "Chrome-only compile marker is absent from executable bundles. Refusing to publish a hybrid archive."
}
if (-not $backgroundText.Contains($licenseOrigin)) {
    throw "The fixed license service address is absent from the background bundle."
}
foreach ($scriptText in @($backgroundText, $sidepanelText)) {
    if (-not $scriptText.Contains("TDA_CHROME_ONLY_LOOPBACK_BLOCKED")) {
        throw "The Chrome-only loopback firewall is absent from an executable bundle."
    }
}

Compress-Archive -LiteralPath $bundleRoot -DestinationPath $archivePath -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath $checksumPath -Value "$hash  $([IO.Path]::GetFileName($archivePath))" -Encoding ASCII
Remove-ReleasePath $stagingRoot

$sizeMiB = [math]::Round((Get-Item -LiteralPath $archivePath).Length / 1MB, 2)
Write-Host "Chrome-only release ready: $archivePath ($sizeMiB MiB)" -ForegroundColor Green
Write-Host "SHA-256: $hash"
