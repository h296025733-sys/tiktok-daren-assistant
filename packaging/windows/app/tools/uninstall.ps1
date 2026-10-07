[CmdletBinding()]
param([switch]$RemoveUserData)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

Assert-TdaProductRoot
Stop-TdaBackend

$startupLink = Join-Path ([Environment]::GetFolderPath("Startup")) "TikTokDarenAssistant.lnk"
if (Test-Path -LiteralPath $startupLink) {
    Remove-Item -LiteralPath $startupLink -Force
}
$programGroup = Join-Path ([Environment]::GetFolderPath("Programs")) "TikTok Daren Assistant"
if (Test-Path -LiteralPath $programGroup) {
    Remove-Item -LiteralPath $programGroup -Recurse -Force
}

$cleanupScript = Join-Path $env:TEMP ("tda-cleanup-" + [guid]::NewGuid().ToString("N") + ".ps1")
$removeDataLiteral = if ($RemoveUserData) { '$true' } else { '$false' }
$cleanupTemplate = @'
Set-StrictMode -Version Latest
$ErrorActionPreference = "SilentlyContinue"
Start-Sleep -Seconds 2
$target = Join-Path $env:LOCALAPPDATA "TikTokDarenAssistant"
$expected = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "TikTokDarenAssistant")).TrimEnd([IO.Path]::DirectorySeparatorChar)
$actual = [IO.Path]::GetFullPath($target).TrimEnd([IO.Path]::DirectorySeparatorChar)
if (-not $actual.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { exit 2 }
$removeUserData = __REMOVE_DATA__
if ($removeUserData) {
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
} else {
    foreach ($name in ("app", "cache", "logs", "outputs", "run")) {
        $child = Join-Path $target $name
        if (Test-Path -LiteralPath $child) { Remove-Item -LiteralPath $child -Recurse -Force }
    }
}
Remove-Item -LiteralPath $PSCommandPath -Force
'@
$cleanupContent = $cleanupTemplate.Replace("__REMOVE_DATA__", $removeDataLiteral)
[IO.File]::WriteAllText($cleanupScript, $cleanupContent, [Text.UTF8Encoding]::new($true))

Start-Process `
    -FilePath (Join-Path $PSHOME "powershell.exe") `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", ('"' + $cleanupScript + '"')) `
    -WindowStyle Hidden

if ($RemoveUserData) {
    Write-Host "Uninstall scheduled. App, models, data, cache and logs will be removed." -ForegroundColor Yellow
} else {
    Write-Host "Uninstall scheduled. Models and data will be preserved in: $script:ProductRoot" -ForegroundColor Green
}
Write-Host "Remove the unpacked extension manually from chrome://extensions/."
