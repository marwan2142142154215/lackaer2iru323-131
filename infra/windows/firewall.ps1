# Firewall Windows untuk Fleet Guard.
#
# Dijalankan SATU KALI sebagai Administrator:
#   powershell -ExecutionPolicy Bypass -File infra\windows\firewall.ps1
#
# Prinsipnya satu: port 8787 (Node) TIDAK PERNAH boleh dibuka ke luar.
# Yang boleh masuk hanya 443 (dan 80 kalau ada renewal sertifikat di PC ini).

[CmdletBinding()]
param(
    # Port yang diizinkan masuk. Kosongkan kalau PC ini hanya jadi backend
    # Cloudflare Tunnel (tidak perlu port terbuka sama sekali).
    [int[]]$AllowPorts = @(),
    #Subnet yang boleh mengakses. Persempit kalau hanya satu jaringan lokal.
    [string]$RemoteAddress = 'Any'
)

$ErrorActionPreference = 'Stop'

$blockPorts = @(8787, 3000, 5432)

Write-Host '== Menutup port yang tidak boleh masuk =='
foreach ($p in $blockPorts) {
    $existing = Get-NetFirewallRule -DisplayName "FleetGuard BLOCK $p" -ErrorAction SilentlyContinue
    if (-not $existing) {
        New-NetFirewallRule `
            -DisplayName "FleetGuard BLOCK $p" `
            -Direction Inbound `
            -Action Block `
            -Protocol TCP `
            -LocalPort $p `
            -Profile Any | Out-Null
        Write-Host "  [BLOCK] TCP $p"
    }
}

if ($AllowPorts.Count -eq 0) {
    Write-Host ''
    Write-Host 'Tidak ada port yang dibuka (mode Cloudflare Tunnel / hanya Node lokal).'
    Write-Host 'Itu konfigurasi paling aman - tidak ada permukaan serangan langsung.'
}
else {
    Write-Host ''
    Write-Host '== Membuka port yang diizinkan =='
    foreach ($p in $AllowPorts) {
        $name = "FleetGuard ALLOW $p"
        if (-not (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule `
                -DisplayName $name `
                -Direction Inbound `
                -Action Allow `
                -Protocol TCP `
                -LocalPort $p `
                -RemoteAddress $RemoteAddress `
                -Profile Domain, Public | Out-Null
            Write-Host "  [ALLOW] TCP $p  (dari $RemoteAddress)"
        }
    }
}

Write-Host ''
Write-Host 'Aturan Fleet Guard yang aktif:'
Get-NetFirewallRule -DisplayName 'FleetGuard *' |
    Select-Object DisplayName, Direction, Action, Enabled |
    Format-Table -AutoSize