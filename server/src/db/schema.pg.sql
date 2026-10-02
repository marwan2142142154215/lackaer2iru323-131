-- ===========================================================================
-- FLEET GUARD - skema PostgreSQL (untuk migrasi ke VPS)
-- Dipakai otomatis bila DATABASE_URL diawali postgres:// / postgresql://
-- Perbedaan dari SQLite:
--   * SERIAL/BIGSERIAL untuk auto-increment
--   * TIMESTAMPTZ untuk kolom waktu (tetap dikirim sebagai string ISO-8601)
--   * device_id VARCHAR sebagai PK teks (tidak diubah -> nol migrasi data)
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS devices (
  device_id            VARCHAR(64) PRIMARY KEY,
  nama_device          VARCHAR(160) NOT NULL UNIQUE,
  nama_norm            VARCHAR(160) NOT NULL,
  status_sewa          VARCHAR(16) NOT NULL DEFAULT 'tersedia'
                        CHECK (status_sewa IN ('tersedia','disewa','hilang','maintenance')),
  nama_penyewa         VARCHAR(160),
  policy_state         VARCHAR(16) NOT NULL DEFAULT 'unlocked'
                        CHECK (policy_state IN ('unlocked','locked','kiosk','factory')),
  is_locked            BOOLEAN NOT NULL DEFAULT FALSE,
  geofence_armed       BOOLEAN NOT NULL DEFAULT FALSE,
  radius_meter         INTEGER NOT NULL DEFAULT 150,
  last_location_lat    TEXT,
  last_location_lng    TEXT,
  last_location_acc    DOUBLE PRECISION,
  last_location_time   TIMESTAMPTZ,
  last_location_source VARCHAR(24),
  battery_level        SMALLINT,
  battery_temp         DOUBLE PRECISION,
  charging             BOOLEAN,
  network_type         VARCHAR(24),
  signal_dbm           SMALLINT,
  storage_free_mb      INTEGER,
  ram_free_mb          INTEGER,
  is_online            BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at         TIMESTAMPTZ,
  last_boot_at         TIMESTAMPTZ,
  app_version          VARCHAR(32),
  android_version      VARCHAR(32),
  api_level            SMALLINT,
  model                VARCHAR(96),
  manufacturer         VARCHAR(96),
  serial_number        VARCHAR(96),
  android_id           VARCHAR(96),
  imei                 VARCHAR(32),
  auth_secret_hash     TEXT NOT NULL UNIQUE,
  auth_secret_enc      TEXT NOT NULL,
  pair_code_hash       TEXT UNIQUE,
  token_issued_at      TIMESTAMPTZ,
  revoked_at           TIMESTAMPTZ,
  batch_id             BIGINT,
  enrolled_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_norm   ON devices (nama_norm);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices (status_sewa);
CREATE INDEX IF NOT EXISTS idx_devices_online ON devices (is_online, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_devices_batch  ON devices (batch_id);

CREATE TABLE IF NOT EXISTS location_history (
  id             BIGSERIAL PRIMARY KEY,
  device_id      VARCHAR(64) NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
  lat            TEXT NOT NULL,
  lng            TEXT NOT NULL,
  accuracy       DOUBLE PRECISION,
  speed          DOUBLE PRECISION,
  altitude       DOUBLE PRECISION,
  battery        SMALLINT,
  source         VARCHAR(24),
  geofence_dist  DOUBLE PRECISION,
  geofence_breach BOOLEAN NOT NULL DEFAULT FALSE,
  ts             TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loc_dev_ts ON location_history (device_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_loc_ts     ON location_history (ts);

CREATE TABLE IF NOT EXISTS command_log (
  id           BIGSERIAL PRIMARY KEY,
  device_id    VARCHAR(64) NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
  command_type VARCHAR(48) NOT NULL,
  payload_enc  TEXT,
  issued_by    VARCHAR(96) NOT NULL,
  status       VARCHAR(16) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','sent','acked','failed','expired','cancelled')),
  attempt      SMALLINT NOT NULL DEFAULT 0,
  max_attempts SMALLINT NOT NULL DEFAULT 2,
  result_enc   TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL,
  sent_at      TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  queue_pos    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cmd_dev_status ON command_log (device_id, status, id);
CREATE INDEX IF NOT EXISTS idx_cmd_created     ON command_log (created_at DESC);

CREATE TABLE IF NOT EXISTS admin_users (
  id                BIGSERIAL PRIMARY KEY,
  username          VARCHAR(64) NOT NULL UNIQUE,
  password_hash     TEXT NOT NULL,
  role              VARCHAR(16) NOT NULL DEFAULT 'staff'
                      CHECK (role IN ('superadmin','staff')),
  telegram_chat_id  VARCHAR(32) UNIQUE,
  telegram_username VARCHAR(64),
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  failed_logins     SMALLINT NOT NULL DEFAULT 0,
  locked_until      TIMESTAMPTZ,
  last_login_at     TIMESTAMPTZ,
  last_login_ip     INET,
  created_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id   BIGINT NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  ip         INET,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor       VARCHAR(96) NOT NULL,
  actor_kind  VARCHAR(16) NOT NULL DEFAULT 'telegram',
  action      VARCHAR(64) NOT NULL,
  target      VARCHAR(160),
  detail_enc  TEXT,
  ip          INET,
  ok          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_log (actor, created_at DESC);

CREATE TABLE IF NOT EXISTS media (
  id         BIGSERIAL PRIMARY KEY,
  device_id  VARCHAR(64) NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
  command_id BIGINT REFERENCES command_log (id) ON DELETE SET NULL,
  kind       VARCHAR(16) NOT NULL,
  file       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  lat        TEXT,
  lng        TEXT,
  ts         TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_device ON media (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_cmd    ON media (command_id);

CREATE TABLE IF NOT EXISTS enrollment_batches (
  id            BIGSERIAL PRIMARY KEY,
  batch_name    VARCHAR(120) NOT NULL,
  note          TEXT,
  method        VARCHAR(8) NOT NULL DEFAULT 'qr',
  qr_payload    TEXT,
  qr_file       TEXT,
  ndef_file     TEXT,
  amapi_token   TEXT,
  policy_name   TEXT,
  count_devices INTEGER NOT NULL DEFAULT 0,
  created_by    VARCHAR(96),
  created_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batches_name ON enrollment_batches (batch_name);

CREATE TABLE IF NOT EXISTS device_events (
  id         BIGSERIAL PRIMARY KEY,
  device_id  VARCHAR(64) NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
  event      VARCHAR(64) NOT NULL,
  severity   VARCHAR(8) NOT NULL DEFAULT 'info',
  detail_enc TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_dev ON device_events (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_sev ON device_events (severity, created_at DESC);

-- ------------------------------------------------------------ app_settings --
-- Lihat schema.sqlite.sql untuk penjelasan. value selalu berisi hash scrypt
-- untuk rahasia, bukan password mentah.
CREATE TABLE IF NOT EXISTS app_settings (
  key        VARCHAR(64) PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
