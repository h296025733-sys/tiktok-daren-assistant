[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$manager = Join-Path $PSScriptRoot "manage_licenses.ps1"

while ($true) {
    Clear-Host
    Write-Host "TikTok 达人助手 - 设备授权主控" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "1. 查看 10 个密钥的绑定状态"
    Write-Host "2. 生成新的设备密钥"
    Write-Host "3. 解绑设备（原密钥可以重新绑定）"
    Write-Host "4. 停用密钥"
    Write-Host "0. 退出"
    Write-Host ""
    $choice = Read-Host "请输入序号"
    try {
        switch ($choice) {
            "1" {
                & $manager -Action List
            }
            "2" {
                $count = [int](Read-Host "生成几个新密钥")
                & $manager -Action Generate -Count $count
            }
            "3" {
                $keyId = [int](Read-Host "输入要解绑的授权编号")
                & $manager -Action Reset -KeyId $keyId
            }
            "4" {
                $keyId = [int](Read-Host "输入要停用的授权编号")
                & $manager -Action Revoke -KeyId $keyId
            }
            "0" { return }
            default { Write-Host "序号不正确。" -ForegroundColor Yellow }
        }
    } catch {
        Write-Host "操作失败：$($_.Exception.Message)" -ForegroundColor Red
    }
    Write-Host ""
    Read-Host "按回车继续" | Out-Null
}
