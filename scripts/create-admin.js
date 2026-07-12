// Local / ops CLI to create or rotate a founder (Level-0) console account.
//
//   Local (persistent PGlite):  PGLITE_DATA_DIR=.pgdata node scripts/create-admin.js you@vitabahn.com 'a-long-password' 'Your Name'
//   Production (Neon/Vercel):   POSTGRES_URL=... node scripts/create-admin.js you@vitabahn.com 'a-long-password' 'Your Name'
//
// On Vercel itself, prefer POST /api/admin/bootstrap (guarded by ADMIN_BOOTSTRAP_TOKEN).

import { ensureSchema } from '../api/_lib/db.js';
import { createAdmin } from '../api/_lib/store.js';
import { hashPassword } from '../api/_lib/auth.js';

const [, , email, password, ...nameParts] = process.argv;
if (!email || !password) {
  console.error('Usage: node scripts/create-admin.js <email> <password> [name]');
  process.exit(1);
}
if (password.length < 12) {
  console.error('Refusing: password must be at least 12 characters.');
  process.exit(1);
}
if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL && !process.env.PGLITE_DATA_DIR) {
  console.error('Refusing: no durable store. Set POSTGRES_URL (prod) or PGLITE_DATA_DIR (local) so the admin persists.');
  process.exit(1);
}

await ensureSchema();
const id = await createAdmin({ email: email.toLowerCase(), name: nameParts.join(' '), passwordHash: hashPassword(password) });
console.log(`Admin ready (id ${id}): ${email.toLowerCase()}`);
process.exit(0);
