-- ===========================================================================
-- FLEET GUARD - skema SQLite (PC lokal / default)
-- Catatan:
--   * Kolom yang berisi lokasi/payload/foto disimpan TERENKSI (AES-256-GCM),
--     format "v1:<iv>:<ct>:<tag>" base64url. Akses lewat repositori.
--   * auth_secret_enc = token device (agar bisa HMAC challenge-response),
--     auth_secret_hash = HMAC(token) untuk lookup cepat + deteksi duplikat.
--   * Timestamp = TEXT ISO-8601 UTC.
-- ===========================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ---------------------------------------------------------------- devices --
CREATE TABLE IF NOT EXISTS devices (
  device_id            TEXT PRIMARY KEY,             -- HP-001-TOKO-A (diberi saat onboarding)
  nama_device          TEXT NOT NULL UNIQUE,         -- "HP-001 TOKO A" (dipakai bot)
  nama_norm            TEXT NOT NULL,                -- normalisasi untuk fuzzy match
  status_sewa          TEXT NOT NULL DEFAULT 'tersedia'
                        CHECK (status_sewa IN ('tersedia','disewa','hilang','maintenance')),
  nama_penyewa         TEXT,

  policy_state         TEXT NOT NULL DEFAULT 'unlocked'
                        CHECK (policy_state IN ('unlocked','locked','kiosk','factory')),
  is_locked            INTEGER NOT NULL DEFAULT 0,
  geofence_armed       INTEGER NOT NULL DEFAULT 0,
  radius_meter         INTEGER NOT NULL DEFAULT 150,

  -- lokasi terakhir (terenkripsi)
  last_location_lat    TEXT,
  last_location_lng    TEXT,
  last_location_acc    REAL,
  last_location_time   TEXT,
  last_location_source TEXT,

  battery_level        INTEGER,
  battery_temp         REAL,
  charging             INTEGER,
  network_type         TEXT,
  signal_dbm           INTEGER,
  storage_free_mb      INTEGER,
  ram_free_mb          INTEGER,

  is_online            INTEGER NOT NULL DEFAULT 0,
  last_seen_at         TEXT,
  last_boot_at         TEXT,
  app_version          TEXT,
  android_version      TEXT,
  api_level            INTEGER,
  model                TEXT,
  manufacturer         TEXT,
  serial_number        TEXT,
  android_id           TEXT,
  imei                 TEXT,

  -- autentikasi
  auth_secret_hash     TEXT NOT NULL UNIQUE,
  auth_secret_enc      TEXT NOT NULL,
  pair_code_hash       TEXT UNIQUE,                   -- kode pairing 8 char (sekali pakai)
  token_issued_at      TEXT,
  revoked_at           TEXT,

  -- faktur rental
  batch_id             TEXT,
  enrolled_at          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_norm      ON devices (nama_norm);
CREATE INDEX IF NOT EXISTS idx_devices_status    ON devices (status_sewa);
CREATE INDEX IF NOT EXISTS idx_devices_online    ON devices (is_online, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_devices_batch     ON devices (batch_id);

-- -------------------------------------------------------- location_history --
CREATE TABLE IF NOT EXISTS location_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     TEXT NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
  lat           TEXT NOT NULL,                       -- terenkripsi
  lng           TEXT NOT NULL,                       -- terenkripsi
  accuracy      REAL,
  speed         REAL,
  altitude      REAL,
  battery       INTEGER,
  source        TEXT,                                -- gps/network/fused/manual
  geofence_dist REAL,                                -- meter dari titik acuan
  geofence_breach INTEGER NOT NULL DEFAULT 0,
  ts            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loc_dev_ts ON location_history (device_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_loc_ts     ON location_history (ts);

-- ------------------------------------------------------------- command_log --
CREATE TABLE IF NOT EXISTS command_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     TEXT NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
  command_type  TEXT NOT NULL,
  payload_enc   TEXT,
  issued_by     TEXT NOT NULL,                       -- bot:<username> | staff:<user> | system
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sent','acked','failed','expired','cancelled')),
  attempt       INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 2,
  result_enc    TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL,
  sent_at       TEXT,
  completed_at  TEXT,
  expires_at    TEXT,
  queue_pos     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cmd_dev_status ON command_log (device_id, status, id);
CREATE INDEX IF NOT EXISTS idx_cmd_created     ON command_log (created_at DESC);

-- ------------------------------------------------------------ admin_users --
CREATE TABLE IF NOT EXISTS admin_users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  username           TEXT NOT NULL UNIQUE,
  password_hash      TEXT NOT NULL,
  role               TEXT NOT NULL DEFAULT 'staff'
                       CHECK (role IN ('superadmin','staff')),
  telegram_chat_id   TEXT UNIQUE,
  telegram_username  TEXT,
  is_active          INTEGER NOT NULL DEFAULT 1,
  failed_logins      INTEGER NOT NULL DEFAULT 0,
  locked_until       TEXT,
  last_login_at      TEXT,
  last_login_ip      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- ----------------------------------------------------------------- sessions --
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  admin_id     INTEGER NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions (expires_at);

-- ---------------------------------------------------------------- audit_log --
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,
  actor_kind TEXT NOT NULL DEFAULT 'telegram',      -- telegram | dashboard | system
  action     TEXT NOT NULL,
  target     TEXT,
  detail_enc TEXT,
  ip         TEXT,
  ok         INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_log (actor, created_at DESC);

-- -------------------------------------------------------------------- media --
CREATE TABLE IF NOT EXISTS media (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
  command_id  INTEGER REFERENCES command_log (id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,                          -- front | rear
  file        TEXT NOT NULL,                          -- path relatif di MEDIA_DIR
  bytes       INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  lat         TEXT,
  lng         TEXT,
  ts          TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_device ON media (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_cmd    ON media (command_id);

-- ------------------------------------------------------- enrollment batches --
CREATE TABLE IF NOT EXISTS enrollment_batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_name    TEXT NOT NULL,
  note          TEXT,
  method        TEXT NOT NULL DEFAULT 'qr',          -- qr | nfc | zte | kme
  qr_payload    TEXT,
  qr_file       TEXT,
  ndef_file     TEXT,
  amapi_token   TEXT,
  policy_name   TEXT,
  count_devices INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batches_name ON enrollment_batches (batch_name);

CREATE TABLE IF NOT EXISTS device_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  TEXT NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
  event      TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'info',           -- info | warn | critical
  detail_enc TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_dev ON device_events (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_sev ON device_events (severity, created_at DESC);
