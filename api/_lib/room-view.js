// Shared builder for the investor room view. Both the investor's own endpoint
// (/api/room/overview) and the founder's read-only preview (/api/admin/preview-room)
// call buildRoomOverview(investor) so the preview is computed by the SAME
// authorisation logic the investor is served — there is no second, drifting copy.
//
// It returns ONLY what the given grant is cleared to see: unlocked sections carry
// documents; the next section carries static gate copy (no document names); deeper
// sections carry a title only.

import { listDocumentsForLevel, viewedDocIdsByInvestor } from './store.js';

const NDA_MIN_LEVEL = 3;
const RECENT_DAYS = 14;

// Canonical section metadata — approved stage labels + tier. Not confidential.
const SECTION_META = {
  1: { title: 'Overview', tier: 'open' },
  2: { title: 'Business case', tier: 'open' },
  3: { title: 'Diligence', tier: 'nda' },
  4: { title: 'Lead / Anchor', tier: 'nda' },
  5: { title: 'Closing', tier: 'nda' },
};

const LEVEL_NAME = { 1: 'First contact', 2: 'Interested', 3: 'Qualified · NDA', 4: 'Lead / Anchor', 5: 'Signing' };

// Static gate copy per section level (verbatim from the approved mockup). Generic
// stage copy — names no specific document, safe to send.
const GATE = {
  2: { kind: 'verify', tag: null, title: 'Verification in progress', body: 'The full investor deck, market analysis and team materials unlock once your investor profile is verified by the VitaBahn team.', cta: 'Verification pending', disabled: true, note: 'Assigned manually — no action required from you.' },
  3: { kind: 'nda', tag: 'nda', title: 'Diligence access requires an executed NDA', body: 'The financial model, capitalisation table, regulatory strategy, clinical dossier and the data-room Q&A unlock once your NDA is countersigned.', cta: 'Review & sign NDA', disabled: false, note: 'Countersignature is confirmed before access opens.' },
  4: { kind: 'named', tag: 'appr', title: 'Lead / Anchor materials — named approval', body: 'Signed LOIs, the detailed unit-economics model and the draft term sheet are released to confirmed lead or anchor investors by named approval.', cta: 'Request lead access', disabled: false, note: 'Granted per person by a founder — never automatic.' },
  5: { kind: 'named', tag: 'appr', title: 'Closing materials — signing parties only', body: 'Closing and legal materials are released to signing parties and their authorised advisers by named approval.', cta: 'Request closing access', disabled: true, note: 'Opened only to confirmed closing parties.' },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function initials(name, email) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  if (parts.length === 1 && parts[0]) return parts[0].slice(0, 2).toUpperCase();
  return String(email || '?').slice(0, 2).toUpperCase();
}
function ftLabel(contentType) {
  const c = String(contentType || '').toLowerCase();
  if (c.includes('pdf')) return 'PDF';
  if (c.includes('sheet') || c.includes('excel') || c.includes('csv')) return 'XLSX';
  if (c.includes('word') || c.includes('officedocument.wordprocessing')) return 'DOC';
  if (c.includes('html')) return 'HTML';
  if (c.includes('image')) return 'IMG';
  return 'FILE';
}
function humanSize(n) {
  n = Number(n || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Compute the exact room payload for `investor` (an object with accessLevel,
// ndaSigned, name, org, email, expiresAt, id). Async: reads authorised docs + the
// per-user view set from the DB.
export async function buildRoomOverview(investor) {
  const level = investor.accessLevel;
  const nda = investor.ndaSigned;

  const authorised = (await listDocumentsForLevel(level)).filter((d) => d.minLevel < NDA_MIN_LEVEL || nda);
  const viewed = await viewedDocIdsByInvestor(investor.id);
  const now = Date.now();

  const toDocView = (d) => {
    const isViewed = viewed.has(d.id);
    const recent = d.updatedAt && now - new Date(d.updatedAt).getTime() < RECENT_DAYS * 86400000;
    return {
      id: d.id,
      name: d.title,
      ft: ftLabel(d.contentType),
      pages: d.pages || humanSize(d.size),
      updated: fmtDate(d.updatedAt) || fmtDate(d.addedAt) || '—',
      status: isViewed ? 'viewed' : recent ? 'new' : 'unviewed',
      downloadable: d.minLevel < NDA_MIN_LEVEL,
    };
  };

  const authorisedFor = (lvl) => level >= lvl && (SECTION_META[lvl].tier === 'open' || nda);
  let gateLevel = null;
  for (let lvl = 1; lvl <= 5; lvl++) {
    if (!authorisedFor(lvl)) { gateLevel = lvl; break; }
  }

  let docCount = 0;
  const sections = [];
  for (let lvl = 1; lvl <= 5; lvl++) {
    const meta = SECTION_META[lvl];
    if (authorisedFor(lvl)) {
      const docs = authorised.filter((d) => d.minLevel === lvl).map(toDocView);
      docCount += docs.length;
      sections.push({ level: lvl, title: meta.title, tier: meta.tier, state: 'unlocked', docs });
    } else if (lvl === gateLevel) {
      sections.push({ level: lvl, title: meta.title, tier: meta.tier, state: 'gate', gate: GATE[lvl] || null });
    } else {
      sections.push({ level: lvl, title: meta.title, tier: meta.tier, state: 'locked' });
    }
  }

  return {
    investor: {
      name: investor.name || investor.email,
      org: investor.org || '',
      email: investor.email,
      initials: initials(investor.name, investor.email),
    },
    access: {
      level,
      levelName: LEVEL_NAME[level] || String(level),
      ndaSigned: nda,
      ndaStatus: nda ? 'Executed' : level >= 2 ? 'Required for L3' : 'Not required',
      validUntil: fmtDate(investor.expiresAt),
      docCount,
    },
    sections,
  };
}
