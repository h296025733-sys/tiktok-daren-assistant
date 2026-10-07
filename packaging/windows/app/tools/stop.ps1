[CmdletBinding()]
param([switch]$Quiet)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

Assert-TdaProductRoot
Stop-TdaBackend
if (-not $Quiet) {
    Write-Host "TikTok Daren Assistant has stopped." -ForegroundColor Green
}
