// scripts/reset-db.mjs — clear investor data before go-live. DESTRUCTIVE.
//
// Runs against the SAME database the app uses:
//   • Production: set POSTGRES_URL to your Neon connection string.
//   • Local persistent: set PGLITE_DATA_DIR.
//   (A plain in-memory dev DB has nothing to clear — it resets every restart.)
//
// SAFE BY DEFAULT: with no --yes it only REPORTS the current row counts and
// deletes nothing. Add --yes to actually wipe. Admin logins are KEPT unless you
// pass --include-admins, so you never lock yourself out.
//
//   node scripts/reset-db.mjs                                         # dry run
//   POSTGRES_URL="postgres://…neon…" node scripts/reset-db.mjs --yes  # wipe data, keep admins
//   POSTGRES_URL="postgres://…neon…" node scripts/reset-db.mjs --yes --include-admins
//
// NOTE: access_requests are REAL investor submissions (leads) and personal data.
// Make sure there are none you want to keep before wiping.

import { query, ensureSchema, driver } from '../api/_lib/db.js';

const args = process.argv.slice(2);
const YES = args.includes('--yes');
const INCLUDE_ADMINS = args.includes('--include-admins');

// No cross-table foreign keys in the schema, so a single TRUNCATE is enough and
// works on Neon's one-statement HTTP driver too.
const DATA_TABLES = ['access_logs', 'invites', 'access_requests', 'documents', 'investors'];
const TABLES = INCLUDE_ADMINS ? [...DATA_TABLES, 'admins'] : DATA_TABLES;

await ensureSchema();

async function count(t) {
  const { rows } = await query(`SELECT count(*)::int AS n FROM ${t}`);
  return rows[0].n;
}

const hasPg = Boolean(process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_PRISMA_URL);
const target = hasPg ? 'PRODUCTION Postgres/Neon' : process.env.PGLITE_DATA_DIR ? `local PGlite (${process.env.PGLITE_DATA_DIR})` : 'in-memory (nothing persists here)';

console.log(`\nTarget: ${target}   [driver=${driver()}]`);
console.log('Current rows:');
for (const t of ['admins', ...DATA_TABLES]) console.log(`  ${t.padEnd(16)} ${await count(t)}`);

if (!YES) {
  console.log('\nDRY RUN — nothing deleted.');
  console.log(`Re-run with --yes to TRUNCATE: ${TABLES.join(', ')}${INCLUDE_ADMINS ? '' : '   (admins kept)'}\n`);
  process.exit(0);
}

await query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY`);

console.log('\n✓ Wiped. Rows now:');
for (const t of ['admins', ...DATA_TABLES]) console.log(`  ${t.padEnd(16)} ${await count(t)}`);
console.log(INCLUDE_ADMINS ? '\nAdmins removed — bootstrap a new one before signing in.\n' : '\nAdmin logins kept.\n');
