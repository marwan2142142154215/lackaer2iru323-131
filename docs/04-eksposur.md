# 04 — Mengekspos server ke internet

Device di tangan penyewa berada di jaringan seluler yang acak. Jadi server broker
**wajib** bisa dijangkau dari internet — dan hanya lewat WSS/HTTPS dengan
sertifikat yang valid. Tidak ada opsi "HTTP + port forwarding" untuk produksi:
Guard secara sengaja menolak skema selain `wss://`.

Urutan rekomendasi, dari paling mudah sampai palingsomitif.

| Opsi | Upaya | Catatan |
|---|---|---|
| **1. Cloudflare Tunnel** | rendah | tanpa IP publik, TLS otomatis, hide origin |
| **2. Caddy + DDNS di router** | rendah–sedang | TLS otomatis, port 443 diteruskan |
| **3. Nginx + DDNS + port forward** | sedang | kontrol penuh, TLS pakai Let's Encrypt |
| **4. VPS relay** | tinggi | hanya kalau PC lokal tidak boleh keluar online |

---

## 1. Cloudflare Tunnel (rekomendasi)

Yang direkomendasikan: PC lokal tidak pernah membuka port ke internet sama
sekali. Cloudflare yang membuat koneksi keluar, lalu meneruskannya ke
`http://localhost:8787`.

### 1.1 Siapkan domain

Butuh domain sendiri (bukan subdomain gratis yang fiturnya terbatas). Minimal
satu subdomain, misalnya `fleet.example.my.id`.

Di Cloudflare Dashboard: **DNS → Add record → CNAME** untuk
`tunnel` → target UUID tunnel Anda.

### 1.2 Install & jalankan cloudflared di PC

```powershell
winget install --id Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel create fleet-guard
```

### 1.3 Konfigurasi tunnel

Buat `infra/cloudflared/config.yml`:

```yaml
tunnel: <UUID_TUNNEL_ANDA>
credentials-file: C:\Users\<ANDA>\.cloudflared\<UUID>.json

ingress:
  # Semua lalu lintas ke Node lokal. Cloudflare yang terminating TLS.
  - hostname: fleet.example.my.id
    service: http://127.0.0.1:8787
    originRequest:
      # Buffer harus dimatikan supaya media/foto besar tidak timeout.
      noTLSVerify: false
      connectTimeout: 10s
      tcpKeepAlive: 30s
      keepAliveTimeout: 90s

  # Fallback wajib: kalau ada service lain, cloudflared menolak dialing.
  - service: http_status:404
```

Jalankan sebagai service Windows:

```powershell
cloudflared service install
cloudflared --config infra\cloudflared\config.yml service run
```

### 1.4 Header keamanan

Cloudflare memang sudah menambah beberapa header, tapi tambahkan eksplisit di
tunnel atau di aplikasi. `http.js` sudah mengirim header dasar; tambahkan lewat
Cloudflare Rules bila perlu:

```
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

### 1.5 Verifikasi

```powershell
curl.exe https://fleet.example.my.id/healthz
#thsia harus: {"ok":true,...}
```

---

## 2. Caddy + DDNS (kalau mau server sendiri, tanpa Cloudflare)

Caddy mengambil sertifikat Let's Encrypt otomatis begitu DNS mengarah ke IP
rumah.

```bash
# /etc/caddy/Caddyfile
fleet.example.my.id {
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1        # wajib untuk SSE / WebSocket
        transport http {
            read_timeout 0
            write_timeout 0
        }
    }

    header {
        X-Content-Type-Options nosniff
        -Server
    }

    log {
        output file /var/log/caddy/fleet.log
    }
}
```

> `flush_interval -1` **wajib**. Tanpa itu, respons streaming (SSE dashboard)
> dan WebSocket akan tertahan di buffer.

### DDNS

Cloudflare:

```bash
# token API dengan izin Zone/DNS/Edit
CLOUDFLARE_TOKEN=... 
DOMAIN=example.my.id
RECORD=fleet.example.my.id
IP=$(curl -s https://api.ipify.org)

curl -X PUT "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CLOUDFLARE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"A\",\"name\":\"$RECORD\",\"content\":\"$IP\",\"ttl\":60}"
```

Jalankan tiap 5 menit lewat cron:

```
*/5 * * * * /usr/local/bin/update-ddns.sh >> /var/log/ddns.log 2>&1
```

Alternatif tanpa skrip: pakai **ddclient**, atau fitur Dynamic DNS bawaan
router.

### Firewall

Hanya 443 dan 80 (untuk renewal) yang boleh masuk:

```bash
sudo ufw allow 443/tcp
sudo ufw allow 80/tcp
sudo ufw deny 8787/tcp      # Node hanya boleh dari localhost
sudo ufw enable
```

---

## 3. Nginx + DDNS + Let's Encrypt

Kalau butuh kontrol granular atau sudah punya setup nginx.

```nginx
# /etc/nginx/sites-available/fleet
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

upstream fleet_guard {
    server 127.0.0.1:8787;
    keepalive 32;
}

server {
    listen 80;
    server_name fleet.example.my.id;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name fleet.example.my.id;

    ssl_certificate     /etc/letsencrypt/live/fleet.example.my.id/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/fleet.example.my.id/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    # Batas ukuran: Guard mengirim frame WSS sampai 6 MB, media lewat HTTP
    # sekitar 2 MB.
    client_max_body_size 8m;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff always;

    location / {
        proxy_pass http://fleet_guard;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeout panjang: WSS device harus tetap hidup.
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/fleet /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d fleet.example.my.id
```

**Wajib:** `proxy_set_header X-Real-IP` dan `X-Forwarded-For`. Bot memakai IP
untuk rate limit dan audit; tanpa itu semua permintaan terlihat berasal dari
`127.0.0.1`. Pastikan juga `TRUST_PROXY=true` (sudah jadi default di `config.js`).

---

## 4. VPS relay (kalau PC lokal tidak boleh online 24 jam)

Arsitektur: Guard → WSS ke VPS (relay tipis) → WSS ke PC lokal → bot.

Kapan dipakai: PC toko sering mati listrik, atau kebijakan kantor melarang
instalasi software persisten di PC tersebut.

Tips: buat relay **setipis mungkin** - hanya meneruskan frame, tanpa
mengakhiri WSS di tengah. Kalau relay harus mengakhiri TLS, minimal batasi
 dengan mTLS untuk sisi server.

Kalau PC lokal mati, Guard tetap menjalankan policy secara lokal (Device
Owner tidak butuh server untuk tetap mengunci), tetapi **perintah baru dan
lokasi baru tidak bisa diterima** sampai server hidup lagi. Ini batas yang
jujur perlu disampaikan ke pemilik bisnis: pelacakan butuh koneksi ke server.

---

## 5. Hardening server (wajib sebelum produksi)

### 5.1 `.env`

```env
NODE_ENV=production
PUBLIC_BASE_URL=https://fleet.example.my.id
TRUST_PROXY=true
```

- `TELEGRAM_BOT_TOKEN`: rotasi kalau pernah bocor.
- `DATA_KEY` / `PEPPER`: biarkan kosong supaya di-generate dari
  `data/keyring.json`, lalu backup file itu. Kalau diisi manual, harus base64
  dari tepat 32 byte.
- `HTTP_PORT`: biarkan `8787` di localhost, jangan expose langsung.

### 5.2 Pairing endpoint

`POST /api/enroll/pair` adalah endpoint publik yang mengekspos kode pairing ke
dunia. Perlindungannya:

| Proteksi | Nilai |
|---|---|
| rate limit per IP | 20 percobaan / 60 detik (`pairLimiter` di `http.js`) |
| kode | 8 karakter, sekali pakai, disimpan sebagai hash |
| audit | semua percobaan (berhasil & gagal) masuk `audit_log` dengan `actor_kind='device'` |

Kalau ini jadi titik lemah, tambahkan **IP allowlist** untuk IP kantor atau
reader NFC:

```nginx
location /api/enroll/pair {
    allow 203.0.113.10;    # IP kantor
    deny all;
    proxy_pass http://fleet_guard;
}
```

### 5.3 Firewall Windows

```powershell
New-NetFirewallRule -DisplayName "FleetGuard WSS 443" -Direction Inbound `
  -Protocol TCP -LocalPort 443 -Action Allow -Profile Domain,Public
# 8787 TIDAK pernah dibuka ke luar
```

### 5.4 Auto-start saat boot

```powershell
# Jalankan sekali sebagai Administrator
$action = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" `
  -Argument "src\index.js" -WorkingDirectory "C:\path\to\fleet-guard\server"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "FleetGuardServer" -Action $action -Trigger $trigger `
  -Settings $settings -User "SYSTEM" -RunLevel Highest
```

Detail di [`infra/windows-start-server.ps1`](../infra/windows-start-server.ps1).

### 5.5 Backup otomatis

```powershell
$task = New-ScheduledTaskTrigger -Daily -At 2am
Register-ScheduledTask -TaskName "FleetGuardBackup" `
  -Action (New-ScheduledTaskAction -Execute "node" -Argument "scripts\backup.mjs --prune 30" `
           -WorkingDirectory "C:\path\to\fleet-guard\server") -Trigger $task
```

Backup **harus** disalin juga ke tempat lain. Backup di PC yang sama tidak
melindungi dari pencurian atau ransomware.

---

## 6. Certificate pinning di sisi Guard

Setelah sertifikat stabil, isi `pin-set` di
`android/app/src/main/res/xml/network_security_config.xml`:

```xml
<pin-set expiration="2027-06-30">
    <pin digest="SHA-256">BASE64_SHA256_DARI_SERTIFIKAT_ANDA=</pin>
    <pin digest="SHA-256">BASE64_SHA256_DARI_INTERMEDIATE_ANDA=</pin>
</pin-set>
```

Kalau sertifikat Cloudflare diganti, Guard akan berhenti terhubung sampai pin
diperbarui. Karena itu **selalu sertakan sertifikat intermediate** dan
perpanjang `expiration` sebelum habis.

> Jangan pin sertifikat edge Cloudflare, karena bisa berganti sewaktu-waktu
> tanpa pemberitahuan. Kalau pinning terasa terlalu rapuh, andalkan saja CA
> publik yang valid - Android sudah menolak CA yang tidak sah.

---

## 7. Daftar periksa sebelum produksi

- [ ] `https://fleet.example.my.id/healthz` → `{"ok":true}`
- [ ] `curl -I https://...` menunjukkan `Strict-Transport-Security`
- [ ] Port 8787 tidak terjangkau dari luar
- [ ] IP asli tidak terlihat (kalau pakai Tunnel: `https://<IP>/healthz` harus gagal)
- [ ] Token bot sudah dirotasi (kalau pernah bocor)
- [ ] `data/keyring.json` sudah dibackup ke tempat lain
- [ ] Scheduled task auto-start + backup terpasang
- [ ] `node scripts/selftest.mjs` lulus dari jaringan publik (bukan hanya localhost)
- [ ] Satu device uji: matikan PC server → Guard harus reconnect otomatis tanpa reset
- [ ] Satu device uji: `/status` dari Telegram benar-benar diterima