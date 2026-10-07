[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

Assert-TdaProductRoot
$extensionRoot = Join-Path $script:AppRoot "extension"
if (-not (Test-Path -LiteralPath (Join-Path $extensionRoot "manifest.json"))) {
    throw "Extension files are missing. Reinstall the application."
}
try { Set-Clipboard -Value $extensionRoot -ErrorAction Stop } catch {}
Start-Process -FilePath "explorer.exe" -ArgumentList ('"' + $extensionRoot + '"')

$chromeCandidates = @(
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe"),
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe")
)
$chrome = $chromeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if ($chrome) {
    Start-Process -FilePath $chrome -ArgumentList "chrome://extensions/"
}
Write-Host "Extension folder copied to clipboard: $extensionRoot" -ForegroundColor Green
Write-Host "Enable Developer mode, choose Load unpacked, and select this folder."
