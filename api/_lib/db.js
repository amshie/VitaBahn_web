// Portable Postgres access layer.
//
// Production (Vercel): the Neon serverless driver when a connection string is
// present (POSTGRES_URL / DATABASE_URL — Vercel Postgres is now Neon-backed).
// Local dev + tests: PGlite, an embedded WASM Postgres that needs no server, so
// the full auth/authz/logging suite runs hermetically on any machine.
//
// Both paths speak standard Postgres with $1,$2 placeholders and return { rows }.

import { schemaStatements } from './schema.js';

let _clientPromise = null;
let _driver = null;
let _schemaReady = false;

function connectionString() {
  return (
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    ''
  );
}

async function makeClient() {
  const cs = connectionString();
  if (cs) {
    _driver = 'neon';
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(cs, { fullResults: true });
    return {
      query: async (text, params = []) => {
        const res = await sql.query(text, params);
        // neon returns { rows, ... } with fullResults, or a bare array otherwise.
        return Array.isArray(res) ? { rows: res } : res;
      },
    };
  }
  _driver = 'pglite';
  const { PGlite } = await import('@electric-sql/pglite');
  // PGLITE_DATA_DIR => durable local store (e.g. `vercel dev`); unset => in-memory.
  const dir = process.env.PGLITE_DATA_DIR || undefined;
  const pg = new PGlite(dir);
  return { query: (text, params = []) => pg.query(text, params) };
}

function client() {
  if (!_clientPromise) _clientPromise = makeClient();
  return _clientPromise;
}

export function driver() {
  return _driver;
}

export async function query(text, params = []) {
  const c = await client();
  return c.query(text, params);
}

// Create tables/indexes if absent. Idempotent; safe to call on every cold start.
export async function ensureSchema() {
  if (_schemaReady) return;
  const c = await client();
  for (const stmt of schemaStatements()) {
    await c.query(stmt);
  }
  _schemaReady = true;
}

// Test-only: wipe all rows but keep the schema, for isolated test cases.
export async function resetDbForTests() {
  await ensureSchema();
  await query(
    'TRUNCATE access_logs, access_requests, documents, investors, admins, invites RESTART IDENTITY CASCADE'
  );
}
