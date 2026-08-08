PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  require_device_signature INTEGER NOT NULL DEFAULT 0 CHECK (require_device_signature IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  preset TEXT,
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
  max_devices INTEGER NOT NULL DEFAULT 1 CHECK (max_devices BETWEEN 1 AND 100),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE licenses (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
  key_digest TEXT NOT NULL UNIQUE,
  display_hint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
  max_devices INTEGER NOT NULL DEFAULT 1 CHECK (max_devices BETWEEN 1 AND 100),
  activated_at INTEGER,
  expires_at INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE challenges (
  token_hash TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  device_id_hash TEXT NOT NULL,
  device_public_key TEXT,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE license_devices (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  device_id_hash TEXT NOT NULL,
  device_token_hash TEXT NOT NULL UNIQUE,
  device_public_key TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE(license_id, device_id_hash)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES license_devices(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE activations (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES license_devices(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  license_id TEXT,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  request_id TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TRIGGER licenses_set_first_use_expiry
AFTER INSERT ON activations
BEGIN
  UPDATE licenses
  SET activated_at = COALESCE(activated_at, NEW.created_at),
      expires_at = COALESCE(expires_at, NEW.created_at + duration_seconds),
      updated_at = NEW.created_at
  WHERE id = NEW.license_id;
END;

CREATE INDEX idx_plans_project ON plans(project_id);
CREATE INDEX idx_licenses_project_created ON licenses(project_id, created_at DESC);
CREATE INDEX idx_licenses_status ON licenses(status);
CREATE INDEX idx_devices_license_status ON license_devices(license_id, status);
CREATE INDEX idx_sessions_license ON sessions(license_id);
CREATE INDEX idx_challenges_license ON challenges(license_id);
CREATE INDEX idx_challenges_expiry ON challenges(expires_at);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX idx_audit_project_created ON audit_events(project_id, created_at DESC);
