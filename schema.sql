-- I-ITSM relational schema (SQLite dialect; Postgres needs only type tweaks).
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id               TEXT PRIMARY KEY,
  role             TEXT NOT NULL CHECK (role IN ('EMPLOYEE', 'TECHNICIAN', 'ADMIN')),
  name             TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash    TEXT NOT NULL,            -- salt:scrypt-hash, never plain text
  department       TEXT,                     -- employees only
  experience_years INTEGER,                  -- technicians only
  max_active       INTEGER CHECK (max_active IS NULL OR max_active >= 1),  -- technicians only
  available        INTEGER NOT NULL DEFAULT 1,  -- technicians: accepting new work
  active           INTEGER NOT NULL DEFAULT 1   -- 0 = deactivated: history kept, access removed
);

CREATE TABLE IF NOT EXISTS technician_skills (
  technician_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  skill         TEXT NOT NULL,
  PRIMARY KEY (technician_id, skill)
);

CREATE TABLE IF NOT EXISTS it_services (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  criticality INTEGER NOT NULL CHECK (criticality BETWEEN 1 AND 4),
  user_base   INTEGER NOT NULL CHECK (user_base > 0),
  active      INTEGER NOT NULL DEFAULT 1    -- 0 = retired: kept on old incidents, not offered for new ones
);

CREATE TABLE IF NOT EXISTS categories (
  name TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS category_keywords (
  category TEXT NOT NULL REFERENCES categories (name) ON DELETE CASCADE,
  keyword  TEXT NOT NULL,
  PRIMARY KEY (category, keyword)
);

CREATE TABLE IF NOT EXISTS sla_policies (
  priority           TEXT PRIMARY KEY CHECK (priority IN ('P1', 'P2', 'P3', 'P4')),
  response_minutes   INTEGER NOT NULL CHECK (response_minutes > 0),
  resolution_minutes INTEGER NOT NULL,
  warning_threshold  REAL NOT NULL DEFAULT 0.8,
  CHECK (resolution_minutes >= response_minutes)
);

CREATE TABLE IF NOT EXISTS incidents (
  id                  TEXT PRIMARY KEY,
  reporter_id         TEXT NOT NULL REFERENCES users (id),
  title               TEXT NOT NULL,
  description         TEXT NOT NULL,
  service_id          TEXT NOT NULL REFERENCES it_services (id),
  impact              INTEGER NOT NULL CHECK (impact BETWEEN 1 AND 4),
  urgency             INTEGER NOT NULL CHECK (urgency BETWEEN 1 AND 4),
  affected_users      INTEGER NOT NULL CHECK (affected_users >= 1),
  created_at          TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('NEW', 'CLASSIFIED', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS',
                                                      'PENDING_INFO', 'RESOLVED', 'VERIFIED', 'CLOSED')),
  category            TEXT,                 -- a name, not a foreign key: an incident keeps its category if it is later removed
  priority            TEXT CHECK (priority IS NULL OR priority IN ('P1', 'P2', 'P3', 'P4')),
  priority_score      INTEGER NOT NULL DEFAULT 0,
  assignee_id         TEXT REFERENCES users (id),
  response_by         TEXT,
  resolve_by          TEXT,
  acknowledged_at     TEXT,
  resolved_at         TEXT,
  closed_at           TEXT,
  resolution          TEXT,
  feedback_rating     INTEGER CHECK (feedback_rating BETWEEN 1 AND 5),
  feedback_comment    TEXT,
  escalation_level    INTEGER NOT NULL DEFAULT 0,
  response_breached   INTEGER NOT NULL DEFAULT 0,
  resolution_breached INTEGER NOT NULL DEFAULT 0,
  warned              INTEGER NOT NULL DEFAULT 0,   -- resolution-deadline warning already sent
  response_warned     INTEGER NOT NULL DEFAULT 0    -- response-deadline warning already sent
);
-- The running application reads from its in-memory identity map, so these indexes are for
-- anyone querying the file directly (reports, a future SQL-backed read path), not for the app today.
CREATE INDEX IF NOT EXISTS idx_incidents_status   ON incidents (status);
CREATE INDEX IF NOT EXISTS idx_incidents_assignee ON incidents (assignee_id);
CREATE INDEX IF NOT EXISTS idx_incidents_created  ON incidents (created_at);

CREATE TABLE IF NOT EXISTS incident_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
  author_id   TEXT NOT NULL REFERENCES users (id),
  kind        TEXT NOT NULL CHECK (kind IN ('INVESTIGATION', 'INFO_REQUEST', 'INFO_RESPONSE', 'COMMENT')),
  text        TEXT NOT NULL,
  at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS incident_links (
  incident_id TEXT NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
  related_id  TEXT NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
  PRIMARY KEY (incident_id, related_id)
);

-- Append-only; deliberately no FK so the history survives even if an incident row is purged.
CREATE TABLE IF NOT EXISTS audit_log (
  id             TEXT PRIMARY KEY,
  at             TEXT NOT NULL,
  actor          TEXT NOT NULL,
  action         TEXT NOT NULL,
  incident_id    TEXT NOT NULL,
  previous_state TEXT,
  new_state      TEXT,
  description    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_incident ON audit_log (incident_id);

CREATE TABLE IF NOT EXISTS sla_violations (
  id          TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents (id),
  kind        TEXT NOT NULL CHECK (kind IN ('RESPONSE', 'RESOLUTION')),
  deadline    TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  priority    TEXT NOT NULL CHECK (priority IN ('P1', 'P2', 'P3', 'P4'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  at          TEXT NOT NULL,
  read        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id);

-- Every email the system sent or simulated, with what became of it.
CREATE TABLE IF NOT EXISTS email_outbox (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  recipient   TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  at          TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('SIMULATED', 'QUEUED', 'SENT', 'FAILED')),
  detail      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
