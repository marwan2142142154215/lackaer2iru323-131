# Daftarkan Fleet Guard sebagai Scheduled Task supaya hidup otomatis saat PC dinyalakan.
#
# Dijalankan SATU KALI sebagai Administrator:
#   powershell -ExecutionPolicy Bypass -File infra\windows\install-scheduled-task.ps1
#
# Menghapus:
#   Unregister-ScheduledTask -TaskName "FleetGuardServer" -Confirm:$false
#   Unregister-ScheduledTask -TaskName "FleetGuardBackup" -Confirm:$false

[CmdletBinding()]
param(
    [string]$ServerDir = (Resolve-Path "$PSScriptRoot\..\..\server").Path,
    [string]$NodeExe  = 'C:\Program Files\nodejs\node.exe',
    [int]$BackupHour  = 2
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ServerDir)) {
    throw "Folder server tidak ditemukan: $ServerDir"
}
if (-not (Test-Path $NodeExe)) {
    throw "node.exe tidak ditemukan di $NodeExe. Set -NodeExe sesuai instalasi Anda."
}

Write-Host "Server : $ServerDir"
Write-Host "Node   : $NodeExe"

# --------------------------------------------------------------- server ----
$serverAction = New-ScheduledTaskAction `
    -Execute $NodeExe `
    -Argument 'src/index.js' `
    -WorkingDirectory $ServerDir

$serverTrigger = New-ScheduledTaskTrigger -AtStartup

# Setting yang penting:
#  - RestartCount  : Node bisa crash kalau DB sedang lock; harus hidup lagi.
#  - DontStopIfGoingOnBatteries : PC toko sering tanpa UPS.
#  - ExecutionTimeLimit 0 : JANGAN dibatasi, WSS harus hidup berminggu-minggu.
$serverSettings = New-ScheduledTaskSettingsSet `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -DontStopOnIdleEnd `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName 'FleetGuardServer' `
    -Action $serverAction `
    -Trigger $serverTrigger `
    -Settings $serverSettings `
    -User 'SYSTEM' `
    -RunLevel Highest `
    -Description 'Fleet Guard broker server (Node.js). Menyimpan WSS device + bot Telegram.' `
    -Force | Out-Null

Write-Host "[OK] Task 'FleetGuardServer' terdaftar (SYSTEM, auto-restart)."

# --------------------------------------------------------------- backup ----
$backupAction = New-ScheduledTaskAction `
    -Execute $NodeExe `
    -Argument 'scripts/backup.mjs --prune 30' `
    -WorkingDirectory $ServerDir

$backupTrigger = New-ScheduledTaskTrigger -Daily -At "$BackupHour`:00"

Register-ScheduledTask `
    -TaskName 'FleetGuardBackup' `
    -Action $backupAction `
    -Trigger $backupTrigger `
    -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries) `
    -User 'SYSTEM' `
    -RunLevel Highest `
    -Description 'Fleet Guard backup harian (database + keyring + media terenkripsi).' `
    -Force | Out-Null

Write-Host "[OK] Task 'FleetGuardBackup' terdaftar (harian pukul $BackupHour:00)."

# -------------------------------------------------------------- verify -----
Write-Host ''
Write-Host 'Verifikasi:'
Get-ScheduledTask -TaskName 'FleetGuard*' |
    Select-Object TaskName, State |
    Format-Table -AutoSize

Write-Host ''
Write-Host 'Mulai sekarang tanpa restart PC:'
Write-Host '  Start-ScheduledTask -TaskName FleetGuardServer'
Write-Host ''
Write-Host 'Cek log:'
Write-Host '  Get-Content "$ServerDir\logs\$(Get-Date -Format yyyy-MM-dd).log" -Tail 20'