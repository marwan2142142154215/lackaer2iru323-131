# infra — caramembuat server dapat diakses dari internet

Semua file di sini adalah **konfigurasi**, bukan kode yang dijalankan server.
Pilih **satu** dari empat opsi di bawah, jangan dipakai bersamaan.

Rujukan lengkap ada di [`docs/04-eksposur.md`](../docs/04-eksposur.md).

---

## Ringkasan pilihan

| Opsi | File | Upaya | Port terbuka? | Catatan |
|---|---|---|---|---|
| Cloudflare Tunnel | `cloudflared/config.yml` | rendah | tidak | **rekomendasi** - origin IP tidak pernah terlihat |
| Caddy | `caddy/Caddyfile` | rendah–sedang | 443 | TLS otomatis, paling ringkas |
| Nginx | `nginx/fleet.conf` | sedang | 443 | kontrol penuh, untuk yang sudah punya nginx |
| systemd (VPS) | `systemd/fleet-guard.service` | — | — | hanya kalau server pindah ke Linux |

---

## 1. Cloudflare Tunnel (paling aman, paling cepat)

```powershell
winget install --id Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel create fleet-guard
```

Salin `cloudflared/config.yml` ke `C:\Users\<ANDA>\.cloudflared\config.yml`, ganti
`<UUID_TUNNEL_ANDA>`, lalu:

```powershell
cloudflared service install
cloudflared --config C:\Users\<ANDA>\.cloudflared\config.yml service run
```

Di Cloudflare DNS tambahkan CNAME:
`fleet.example.my.id` → `<UUID>.cfargotunnel.com`

Cek:

```powershell
curl.exe https://fleet.example.my.id/healthz
curl.exe https://<IP-PUBLIK-PC>/healthz   # harus GAGAL - inilah yang diinginkan
```

> Kalau perintah kedua berhasil, berarti masih ada port terbuka lain. Tutup dengan
> `infra\windows\firewall.ps1`.

---

## 2. Caddy (kalau tidak mau pakai Cloudflare)

```bash
sudo cp infra/caddy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy otomatis mengambil sertifikat Let's Encrypt. Arahkan DNS A record ke IP
rumah, lalu jalankan skrip DDNS setiap 5 menit.

`flush_interval -1` di Caddyfile itu **wajib** — tanpa itu dashboard (SSE) dan
WebSocket akan menggantung.

---

## 3. Nginx (kalau sudah punya nginx)

```bash
sudo ln -s /etc/nginx/sites-available/fleet /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d fleet.example.my.id
```

Tiga hal yang paling sering salah di nginx:

1. `proxy_buffering off` — kalau lupa, SSE dan WSS tidak jalan.
2. `proxy_set_header X-Real-IP` — kalau lupa, semua permintaan terlihat dari
   `127.0.0.1` sehingga rate limit dan audit tidak berguna.
3. `client_max_body_size 8m` — kalau lupa, foto 2 MB akan ditolak `413`.

---

## 4. systemd (server sudah pindah ke VPS)

```bash
sudo cp infra/systemd/fleet-guard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fleet-guard
```

Secret **tidak** ditulis di unit file. Buat `/etc/fleet-guard/env` dengan izin
`600` berisi variabel dari `.env`, lalu `systemctl restart fleet-guard`.

---

## 5. Auto-start di Windows

```powershell
# sekali jalan, sebagai Administrator
powershell -ExecutionPolicy Bypass -File infra\windows\install-scheduled-task.ps1
```

Membuat dua task:

- `FleetGuardServer` — jalan saat boot sebagai `SYSTEM`, restart otomatis sampai
  999 kali kalau crash, tanpa batas waktu eksekusi (WSS harus hidup berbulan-bulan).
- `FleetGuardBackup` — harian pukul 02:00, retensi 30 hari.

Lalu tutup port yang tidak perlu:

```powershell
powershell -ExecutionPolicy Bypass -File infra\windows\firewall.ps1
```

---

## Checklist sebelum produksi

- [ ] `curl.exe https://<domain>/healthz` → `{"ok":true}`
- [ ] `curl.exe https://<IP-publik>/healthz` → gagal
- [ ] `Sec-WebSocket-Protocol: fleetguard.v1` diterima (lihat log `hub`)
- [ ] Port 8787 tidak terjangkau dari luar
- [ ] `data/keyring.json` sudah disalin ke tempat lain
- [ ] Scheduled task `FleetGuardServer` dan `FleetGuardBackup` aktif
- [ ] `node scripts/selftest.mjs` lulus **dari jaringan publik**, bukan hanya localhost
- [ ] Satu unit uji: matikan PC server → Guard reconnect sendiri tanpa perlu reset