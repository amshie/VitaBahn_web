// Data-access layer. All SQL lives here so authorisation-relevant queries are in
// one auditable place. Every function is parameterised; the only dynamic SQL is
// the column-allowlisted updateInvestor / updateDocument builders below.

import crypto from 'node:crypto';
import { query, ensureSchema } from './db.js';

// Set-password / reset links are short-lived (a common phishing-resistant default).
// Overridable via INVITE_TTL_SEC; the email states the real lifetime.
export const INVITE_TTL_SEC = Number(process.env.INVITE_TTL_SEC || 3 * 3600); // 3 hours
const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

// ---- mappers: coerce driver types to plain JSON-friendly values ----
const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const day = (v) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

function mapInvestor(r) {
  if (!r) return null;
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    org: r.org,
    role: r.role,
    country: r.country,
    investorType: r.investor_type,
    hasPassword: Boolean(r.password_hash),
    passwordChangedAt: iso(r.password_changed_at),
    accessLevel: Number(r.access_level),
    ndaSigned: r.nda_signed,
    ndaSignedAt: iso(r.nda_signed_at),
    expiresAt: iso(r.expires_at),
    revoked: r.revoked,
    revokedAt: iso(r.revoked_at),
    approvedBy: r.approved_by || null,
    approvedLevel: r.approved_level == null ? null : Number(r.approved_level),
    commitAmount: Number(r.commit_amount || 0),
    commitStatus: r.commit_status,
    instrument: r.instrument,
    notes: r.notes,
    followUpAt: day(r.follow_up_at),
    meetingBooked: r.meeting_booked,
    ticket: r.ticket,
    interest: r.interest,
    timeline: r.timeline,
    requestId: r.request_id,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    // Computed by Postgres (authoritative), present on auth queries only:
    isExpired: r.is_expired === true || r.is_expired === 't',
  };
}

function mapDoc(r) {
  if (!r) return null;
  return {
    id: r.id,
    title: r.title,
    minLevel: Number(r.min_level),
    tier: Number(r.tier),
    contentType: r.content_type,
    size: Number(r.size || 0),
    pages: r.pages || '',
    isNdaTemplate: r.is_nda_template === true || r.is_nda_template === 't',
    addedAt: iso(r.added_at),
    updatedAt: iso(r.updated_at),
  };
}

function mapLog(r) {
  return {
    id: r.id,
    actorType: r.actor_type,
    actorId: r.actor_id,
    email: r.email,
    event: r.event,
    documentId: r.document_id,
    detail: r.detail,
    ip: r.ip,
    userAgent: r.user_agent,
    createdAt: iso(r.created_at),
  };
}

// ---------------------------------------------------------------- admins
export async function getAdminByEmail(email) {
  const { rows } = await query('SELECT * FROM admins WHERE email = $1', [String(email || '').toLowerCase()]);
  return rows[0] || null; // includes password_hash — for login only
}

export async function createAdmin({ email, name = '', passwordHash }) {
  const { rows } = await query(
    'INSERT INTO admins (email, name, password_hash, password_changed_at) VALUES ($1,$2,$3, now()) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, password_changed_at = now() RETURNING id',
    [String(email).toLowerCase(), name, passwordHash]
  );
  return rows[0].id;
}

export async function getAdminById(id) {
  const { rows } = await query('SELECT id, email, name, created_at, password_changed_at FROM admins WHERE id = $1', [id]);
  return rows[0] ? { id: rows[0].id, email: rows[0].email, name: rows[0].name, passwordChangedAt: iso(rows[0].password_changed_at) } : null;
}

export async function countAdmins() {
  const { rows } = await query('SELECT count(*)::int AS n FROM admins');
  return rows[0].n;
}

export async function listAdmins() {
  const { rows } = await query('SELECT id, email, name, created_at FROM admins ORDER BY created_at ASC');
  return rows.map((r) => ({ id: r.id, email: r.email, name: r.name, createdAt: iso(r.created_at) }));
}

export async function deleteAdmin(id) {
  await query('DELETE FROM admins WHERE id = $1', [id]);
}

// Row counts for the data tables (admins excluded) — reported before a reset.
export async function dataCounts() {
  const { rows } = await query(
    `SELECT (SELECT count(*) FROM investors)::int AS investors,
            (SELECT count(*) FROM access_requests)::int AS requests,
            (SELECT count(*) FROM documents)::int AS documents,
            (SELECT count(*) FROM invites)::int AS invites,
            (SELECT count(*) FROM access_logs)::int AS logs`
  );
  return rows[0];
}

// Wipe all operational data (investors, requests, documents, invites, logs).
// Admin accounts are deliberately preserved so the console stays accessible.
export async function resetData() {
  await query('TRUNCATE investors, access_requests, documents, invites, access_logs RESTART IDENTITY CASCADE');
}

// ------------------------------------------------------------- investors
// Auth query: also computes is_expired in Postgres so expiry is server-authoritative.
export async function getInvestorByEmail(email) {
  const { rows } = await query(
    'SELECT *, (expires_at IS NOT NULL AND now() > expires_at) AS is_expired FROM investors WHERE email = $1',
    [String(email || '').toLowerCase()]
  );
  return rows[0] ? { ...mapInvestor(rows[0]), passwordHash: rows[0].password_hash } : null;
}

export async function getInvestorById(id) {
  const { rows } = await query(
    'SELECT *, (expires_at IS NOT NULL AND now() > expires_at) AS is_expired FROM investors WHERE id = $1',
    [id]
  );
  return rows[0] ? mapInvestor(rows[0]) : null;
}

export async function listInvestors() {
  const { rows } = await query(
    'SELECT *, (expires_at IS NOT NULL AND now() > expires_at) AS is_expired FROM investors ORDER BY created_at ASC'
  );
  return rows.map(mapInvestor);
}

export async function createInvestor(f) {
  const { rows } = await query(
    `INSERT INTO investors
       (email, name, org, role, country, investor_type, password_hash, access_level,
        ticket, interest, timeline, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      String(f.email).toLowerCase(), f.name || '', f.org || '', f.role || '', f.country || '',
      f.investorType || '', f.passwordHash || null, Number(f.accessLevel || 1),
      f.ticket || '', f.interest || '', f.timeline || '', f.requestId || null,
    ]
  );
  return rows[0].id;
}

// Columns an admin may patch, mapped to SQL columns. Keys not in this allowlist
// are ignored — this is the injection guard for the dynamic UPDATE.
const INVESTOR_PATCH = {
  accessLevel: 'access_level',
  ndaSigned: 'nda_signed',
  ndaSignedAt: 'nda_signed_at',
  expiresAt: 'expires_at',
  revoked: 'revoked',
  revokedAt: 'revoked_at',
  approvedBy: 'approved_by',
  approvedLevel: 'approved_level',
  approvedAt: 'approved_at',
  commitAmount: 'commit_amount',
  commitStatus: 'commit_status',
  instrument: 'instrument',
  notes: 'notes',
  followUpAt: 'follow_up_at',
  meetingBooked: 'meeting_booked',
  passwordHash: 'password_hash',
  name: 'name',
  org: 'org',
  role: 'role',
  country: 'country',
};

export async function updateInvestor(id, patch) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, col] of Object.entries(INVESTOR_PATCH)) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      sets.push(`${col} = $${i++}`);
      vals.push(patch[k]);
    }
  }
  if (!sets.length) return getInvestorById(id);
  // Setting/resetting the password stamps the change so older sessions become stale.
  if (Object.prototype.hasOwnProperty.call(patch, 'passwordHash')) {
    sets.push('password_changed_at = now()');
  }
  sets.push(`updated_at = now()`);
  vals.push(id);
  const { rows } = await query(
    `UPDATE investors SET ${sets.join(', ')} WHERE id = $${i} RETURNING *, (expires_at IS NOT NULL AND now() > expires_at) AS is_expired`,
    vals
  );
  return rows[0] ? mapInvestor(rows[0]) : null;
}

// Hard-delete an investor account together with their access-log history and any
// invites (GDPR erasure). The admin action itself is logged separately by the caller.
export async function deleteInvestor(id) {
  await query("DELETE FROM access_logs WHERE actor_id = $1 AND actor_type = 'investor'", [id]);
  await query('DELETE FROM invites WHERE investor_id = $1', [id]);
  await query('DELETE FROM nda_submissions WHERE investor_id = $1', [id]);
  await query('DELETE FROM investors WHERE id = $1', [id]);
}

// --------------------------------------------------- set-password invites
// Create a fresh single-use invite, invalidating any prior unused ones for this
// investor (re-inviting revokes the old link). Returns the RAW token (emailed once;
// only its hash is stored).
export async function createInvite(investorId, ttlSec = INVITE_TTL_SEC) {
  await query('UPDATE invites SET used_at = now() WHERE investor_id = $1 AND used_at IS NULL', [investorId]);
  const raw = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + ttlSec * 1000).toISOString();
  await query('INSERT INTO invites (investor_id, token_hash, expires_at) VALUES ($1,$2,$3)', [investorId, hashToken(raw), expires]);
  return raw;
}

// Peek without consuming: is the token currently valid? Returns { investorId } or null.
export async function peekInvite(rawToken) {
  if (!rawToken) return null;
  const { rows } = await query(
    'SELECT investor_id FROM invites WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() LIMIT 1',
    [hashToken(rawToken)]
  );
  return rows[0] ? { investorId: rows[0].investor_id } : null;
}

// Atomically consume the token (mark used) iff still valid. Returns { investorId } or null.
export async function consumeInvite(rawToken) {
  if (!rawToken) return null;
  const { rows } = await query(
    'UPDATE invites SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING investor_id',
    [hashToken(rawToken)]
  );
  return rows[0] ? { investorId: rows[0].investor_id } : null;
}

// -------------------------------------------------------- access requests
export async function insertAccessRequest(f) {
  const { rows } = await query(
    `INSERT INTO access_requests
       (request_id, full_name, email, organisation, role, country, linkedin,
        investor_type, ticket_range, role_in_round, interest_area, timeline,
        meeting_type, message, referral, internal_routing_hint, status, source, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending',$17,$18)
     RETURNING id`,
    [
      f.requestId, f.fullName || '', String(f.email || '').toLowerCase(), f.organisation || '',
      f.role || '', f.country || '', f.linkedin || '', f.investorType || '', f.ticketRange || '',
      f.roleInRound || '', f.interestArea || '', f.timeline || '', f.meetingType || '',
      f.message || '', f.referral || '', f.internalRoutingHint || '', f.source || '', f.ip || '',
    ]
  );
  return rows[0].id;
}

export async function listAccessRequests() {
  const { rows } = await query('SELECT * FROM access_requests ORDER BY created_at DESC');
  return rows.map((r) => ({
    id: r.id,
    requestId: r.request_id,
    fullName: r.full_name,
    email: r.email,
    organisation: r.organisation,
    role: r.role,
    country: r.country,
    linkedin: r.linkedin,
    investorType: r.investor_type,
    ticketRange: r.ticket_range,
    roleInRound: r.role_in_round,
    interestArea: r.interest_area,
    timeline: r.timeline,
    meetingType: r.meeting_type,
    message: r.message,
    referral: r.referral,
    internalRoutingHint: r.internal_routing_hint,
    status: r.status,
    createdAt: iso(r.created_at),
  }));
}

export async function setRequestStatus(requestId, status) {
  await query('UPDATE access_requests SET status = $1 WHERE request_id = $2', [status, requestId]);
}

// ------------------------------------------------------------- documents
// Metadata only (never selects bytes) — for the console and the room listing.
export async function listDocuments() {
  const { rows } = await query(
    'SELECT id, title, min_level, tier, content_type, size, pages, is_nda_template, added_at, updated_at FROM documents ORDER BY min_level ASC, updated_at DESC'
  );
  return rows.map(mapDoc);
}

// Documents an investor at `level` is authorised to see (min_level <= level).
export async function listDocumentsForLevel(level) {
  const { rows } = await query(
    'SELECT id, title, min_level, tier, content_type, size, pages, is_nda_template, added_at, updated_at FROM documents WHERE min_level <= $1 ORDER BY min_level ASC, updated_at DESC',
    [Number(level)]
  );
  return rows.map(mapDoc);
}

export async function getDocumentMeta(id) {
  const { rows } = await query(
    'SELECT id, title, min_level, tier, content_type, size, pages, is_nda_template, added_at, updated_at FROM documents WHERE id = $1',
    [id]
  );
  return rows[0] ? mapDoc(rows[0]) : null;
}

// Full row incl. bytes — used only by the authorised streaming route.
export async function getDocumentWithBytes(id) {
  const { rows } = await query('SELECT * FROM documents WHERE id = $1', [id]);
  const r = rows[0];
  if (!r) return null;
  return { ...mapDoc(r), bytes: r.bytes == null ? null : Buffer.from(r.bytes) };
}

export async function insertDocument(d) {
  await query(
    'INSERT INTO documents (id, title, min_level, tier, content_type, size, pages, bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [d.id, d.title, Number(d.minLevel), Number(d.tier), d.contentType || 'application/octet-stream', Number(d.size || 0), d.pages || '', d.bytes || null]
  );
  return getDocumentMeta(d.id);
}

const DOC_PATCH = { title: 'title', minLevel: 'min_level', tier: 'tier', pages: 'pages' };
export async function updateDocument(id, patch) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, col] of Object.entries(DOC_PATCH)) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      sets.push(`${col} = $${i++}`);
      vals.push(patch[k]);
    }
  }
  if (!sets.length) return getDocumentMeta(id);
  // Any catalogue change (metadata or a re-upload) counts as an update for the room.
  sets.push('updated_at = now()');
  vals.push(id);
  await query(`UPDATE documents SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  return getDocumentMeta(id);
}

export async function deleteDocument(id) {
  await query('DELETE FROM documents WHERE id = $1', [id]);
}

// The NDA template = the single document flagged is_nda_template, that investors
// download to sign. Setting one clears the flag on any other (at most one template).
export async function setNdaTemplate(id) {
  await query('UPDATE documents SET is_nda_template = false WHERE is_nda_template = true');
  if (id) await query('UPDATE documents SET is_nda_template = true WHERE id = $1', [id]);
  return getNdaTemplate();
}
export async function getNdaTemplate() {
  const { rows } = await query(
    'SELECT id, title, min_level, tier, content_type, size, pages, is_nda_template, added_at, updated_at FROM documents WHERE is_nda_template = true ORDER BY updated_at DESC LIMIT 1'
  );
  return rows[0] ? mapDoc(rows[0]) : null;
}

// -------------------------------------------------------- NDA submissions
function mapNda(r) {
  if (!r) return null;
  return {
    id: r.id,
    investorId: r.investor_id,
    filename: r.filename,
    contentType: r.content_type,
    size: Number(r.size || 0),
    status: r.status,
    submittedAt: iso(r.submitted_at),
    reviewedAt: iso(r.reviewed_at),
    reviewedBy: r.reviewed_by || null,
  };
}

// Store a freshly-submitted signed NDA; any prior still-pending submission from the
// same investor is marked superseded so only the newest is actionable.
export async function insertNdaSubmission({ investorId, filename, contentType, size, bytes }) {
  await query("UPDATE nda_submissions SET status = 'superseded' WHERE investor_id = $1 AND status = 'submitted'", [investorId]);
  const { rows } = await query(
    'INSERT INTO nda_submissions (investor_id, filename, content_type, size, bytes) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [investorId, filename || '', contentType || 'application/pdf', Number(size || 0), bytes || null]
  );
  return rows[0].id;
}

export async function getLatestNdaSubmission(investorId) {
  const { rows } = await query(
    'SELECT id, investor_id, filename, content_type, size, status, submitted_at, reviewed_at, reviewed_by FROM nda_submissions WHERE investor_id = $1 ORDER BY submitted_at DESC LIMIT 1',
    [investorId]
  );
  return rows[0] ? mapNda(rows[0]) : null;
}

export async function getNdaSubmissionWithBytes(id) {
  const { rows } = await query('SELECT * FROM nda_submissions WHERE id = $1', [id]);
  const r = rows[0];
  if (!r) return null;
  return { ...mapNda(r), bytes: r.bytes == null ? null : Buffer.from(r.bytes) };
}

// Latest NDA submission per investor (id + status + date), for the console list.
export async function latestNdaByInvestor() {
  const { rows } = await query(
    'SELECT DISTINCT ON (investor_id) investor_id, id, status, submitted_at FROM nda_submissions ORDER BY investor_id, submitted_at DESC'
  );
  const out = new Map();
  for (const r of rows) out.set(Number(r.investor_id), { id: r.id, status: r.status, submittedAt: iso(r.submitted_at) });
  return out;
}

// Accept/reject a submission. Accepting also flips the investor's nda_signed grant
// (the single source of truth the room enforces on). Returns the investor id.
export async function setNdaSubmissionStatus(id, status, reviewedBy) {
  const { rows } = await query(
    'UPDATE nda_submissions SET status = $1, reviewed_at = now(), reviewed_by = $2 WHERE id = $3 RETURNING investor_id',
    [status, reviewedBy || null, id]
  );
  const investorId = rows[0] && rows[0].investor_id;
  if (investorId && status === 'accepted') {
    // Executing the NDA also opens Diligence (Level 3) — the NDA IS the L2→L3 gate.
    // GREATEST keeps any higher level; it never assigns 4/5 (those need named approval).
    await query('UPDATE investors SET nda_signed = true, nda_signed_at = now(), access_level = GREATEST(access_level, 3), updated_at = now() WHERE id = $1', [investorId]);
  }
  return investorId || null;
}

// ------------------------------------------------------------ access logs
export async function logEvent(e) {
  await query(
    `INSERT INTO access_logs (actor_type, actor_id, email, event, document_id, detail, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      e.actorType || 'anon', e.actorId ?? null, e.email || null, e.event,
      e.documentId || null, e.detail || '', e.ip || '', (e.userAgent || '').slice(0, 400),
    ]
  );
}

export async function listLogs({ limit = 200, actorId = null } = {}) {
  const { rows } = actorId
    ? await query('SELECT * FROM access_logs WHERE actor_id = $1 ORDER BY created_at DESC LIMIT $2', [actorId, limit])
    : await query('SELECT * FROM access_logs ORDER BY created_at DESC LIMIT $1', [limit]);
  return rows.map(mapLog);
}

// Set of document ids this investor has actually opened (from the audit log), so
// the room can mark each row viewed / not-viewed per user. Derived data — no new
// column, and it can never reveal a document the investor was not served.
export async function viewedDocIdsByInvestor(investorId) {
  const { rows } = await query(
    "SELECT DISTINCT document_id FROM access_logs WHERE actor_type = 'investor' AND actor_id = $1 AND event = 'document_view' AND document_id IS NOT NULL",
    [investorId]
  );
  return new Set(rows.map((r) => r.document_id));
}

// Per-investor engagement, aggregated from the audit log, for the console lead
// score. document_view count + last activity across ANY event.
export async function engagementByInvestor() {
  const { rows } = await query(
    `SELECT actor_id,
            count(*) FILTER (WHERE event = 'document_view') AS views,
            max(created_at) AS last_at
       FROM access_logs
      WHERE actor_type = 'investor' AND actor_id IS NOT NULL
      GROUP BY actor_id`
  );
  const out = new Map();
  for (const r of rows) out.set(Number(r.actor_id), { views: Number(r.views || 0), lastAt: iso(r.last_at) });
  return out;
}

export { ensureSchema };
