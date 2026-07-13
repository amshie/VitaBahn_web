// VitaBahn investor system — canonical database schema (single source of truth).
//
// Portable Postgres DDL. Runs unchanged on PGlite (local/tests) and Neon /
// Vercel Postgres (production). Each statement is standalone and terminated by a
// single ';' — db.js splits on statement boundaries so the same DDL also works on
// Neon's single-statement HTTP driver.
//
// Access levels (0–5), enforced server-side per authenticated user:
//   0 = founders / admins / counsel        (NEVER assigned to an investor account)
//   1 = public / first contact
//   2 = verified interested
//   3 = qualified under NDA
//   4 = verified lead / anchor              (named approval required)
//   5 = signing / closing                   (named approval required)

export const SCHEMA_SQL = `
-- Founder / admin console operators (Level 0). Separate trust realm from investors.
CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Investor accounts: profile, enforced access grant, and console-managed fields.
CREATE TABLE IF NOT EXISTS investors (
  id             SERIAL PRIMARY KEY,
  email          TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL DEFAULT '',
  org            TEXT NOT NULL DEFAULT '',
  role           TEXT NOT NULL DEFAULT '',
  country        TEXT NOT NULL DEFAULT '',
  investor_type  TEXT NOT NULL DEFAULT '',
  password_hash  TEXT,
  -- Enforced disclosure grant. 1..5 for investors; 0 is reserved for admins and
  -- must never be assigned here (guarded in the data layer).
  access_level   INT  NOT NULL DEFAULT 1,
  nda_signed     BOOLEAN NOT NULL DEFAULT false,
  nda_signed_at  TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ,                 -- NULL = no expiry
  revoked        BOOLEAN NOT NULL DEFAULT false,
  revoked_at     TIMESTAMPTZ,
  -- Named approval, required before granting level 4 or 5.
  approved_by    TEXT,
  approved_level INT,
  approved_at    TIMESTAMPTZ,
  -- Console pipeline / CRM fields.
  commit_amount  BIGINT NOT NULL DEFAULT 0,
  commit_status  TEXT   NOT NULL DEFAULT 'none',   -- none | soft | committed
  instrument     TEXT   NOT NULL DEFAULT '—',
  notes          TEXT   NOT NULL DEFAULT '',
  follow_up_at   DATE,
  meeting_booked BOOLEAN NOT NULL DEFAULT false,
  ticket         TEXT   NOT NULL DEFAULT '',
  interest       TEXT   NOT NULL DEFAULT '',
  timeline       TEXT   NOT NULL DEFAULT '',
  request_id     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS investors_email_idx ON investors (email);

-- Raw investor-access gateway submissions (arrive before any account exists).
CREATE TABLE IF NOT EXISTS access_requests (
  id                    SERIAL PRIMARY KEY,
  request_id            TEXT UNIQUE NOT NULL,
  full_name             TEXT NOT NULL DEFAULT '',
  email                 TEXT NOT NULL DEFAULT '',
  organisation          TEXT NOT NULL DEFAULT '',
  role                  TEXT NOT NULL DEFAULT '',
  country               TEXT NOT NULL DEFAULT '',
  linkedin              TEXT NOT NULL DEFAULT '',
  investor_type         TEXT NOT NULL DEFAULT '',
  ticket_range          TEXT NOT NULL DEFAULT '',
  role_in_round         TEXT NOT NULL DEFAULT '',
  interest_area         TEXT NOT NULL DEFAULT '',
  timeline              TEXT NOT NULL DEFAULT '',
  meeting_type          TEXT NOT NULL DEFAULT '',
  message               TEXT NOT NULL DEFAULT '',
  referral              TEXT NOT NULL DEFAULT '',
  internal_routing_hint TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'pending',  -- pending | reviewed | approved | declined
  source                TEXT NOT NULL DEFAULT '',
  ip                    TEXT NOT NULL DEFAULT '',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS access_requests_created_idx ON access_requests (created_at DESC);

-- Data-room documents. Bytes are stored in the row and streamed ONLY through the
-- authorised /api/room/document route — there is no public object URL to leak.
CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  -- Minimum access_level required to view (1..5). Authoritative for enforcement.
  min_level    INT  NOT NULL DEFAULT 3,
  -- Coarse label mirrored from min_level for the console (1 = Open, 2 = NDA/restricted).
  tier         INT  NOT NULL DEFAULT 1,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size         BIGINT NOT NULL DEFAULT 0,
  -- Human display label for the room table (e.g. "22 pages", "6 tabs", "live"). Optional.
  pages        TEXT NOT NULL DEFAULT '',
  bytes        BYTEA,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Last content/metadata change; drives the room's "Updated" column + "Recently updated".
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Marks the document investors download to sign for the NDA gate (at most one).
  is_nda_template BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS documents_level_idx ON documents (min_level);

-- Additive migrations for databases created before these columns existed. Each is
-- idempotent, so ensureSchema() can run them on every cold start without harm.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS pages TEXT NOT NULL DEFAULT '';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_nda_template BOOLEAN NOT NULL DEFAULT false;

-- Single-use, time-limited set-password invitations. Only a HASH of the token is
-- stored, so a database leak never exposes a usable link.
CREATE TABLE IF NOT EXISTS invites (
  id          SERIAL PRIMARY KEY,
  investor_id INT NOT NULL,
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invites_token_idx ON invites (token_hash);
CREATE INDEX IF NOT EXISTS invites_investor_idx ON invites (investor_id);

-- Investor-submitted signed NDAs (per-investor, private — NOT part of the shared
-- documents catalogue). The founder reviews and accepts one, which flips
-- investors.nda_signed. Bytes are served only to the founder via the admin route.
CREATE TABLE IF NOT EXISTS nda_submissions (
  id           SERIAL PRIMARY KEY,
  investor_id  INT NOT NULL,
  filename     TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT 'application/pdf',
  size         BIGINT NOT NULL DEFAULT 0,
  bytes        BYTEA,
  status       TEXT NOT NULL DEFAULT 'submitted',   -- submitted | accepted | rejected | superseded
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at  TIMESTAMPTZ,
  reviewed_by  TEXT
);

CREATE INDEX IF NOT EXISTS nda_submissions_investor_idx ON nda_submissions (investor_id, submitted_at DESC);

-- Append-only audit log: every login (success + failure), logout, document access
-- (granted + denied), request submission and admin action.
CREATE TABLE IF NOT EXISTS access_logs (
  id          SERIAL PRIMARY KEY,
  actor_type  TEXT NOT NULL,                 -- investor | admin | anon
  actor_id    INT,                           -- investors.id / admins.id, or NULL
  email       TEXT,                          -- attempted / resolved email
  event       TEXT NOT NULL,                 -- login_success | login_failed | logout | document_view | document_denied | request_submitted | admin_action | session_invalid
  document_id TEXT,
  detail      TEXT NOT NULL DEFAULT '',
  ip          TEXT NOT NULL DEFAULT '',
  user_agent  TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS access_logs_actor_idx ON access_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS access_logs_created_idx ON access_logs (created_at DESC);
`;

// Split the DDL into standalone statements (Neon's HTTP driver runs one at a time).
// Line comments are stripped FIRST because they can contain ';' — the DDL has no
// '--' or ';' inside any string literal, so this is a safe, simple tokenisation.
export function schemaStatements() {
  return SCHEMA_SQL
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}
