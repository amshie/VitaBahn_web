// Foundation tests: schema, data layer, password hashing, session signing.
import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureSchema, resetDbForTests } from '../api/_lib/db.js';
import * as store from '../api/_lib/store.js';
import { hashPassword, verifyPassword, createSession, verifySessionToken } from '../api/_lib/auth.js';

test.before(async () => { await ensureSchema(); });
test.beforeEach(async () => { await resetDbForTests(); });

test('password hash verifies correct password and rejects wrong/tampered', () => {
  const h = hashPassword('Correct-Horse-9');
  assert.equal(verifyPassword('Correct-Horse-9', h), true);
  assert.equal(verifyPassword('wrong', h), false);
  assert.equal(verifyPassword('Correct-Horse-9', h.replace(/.$/, '0')), false);
  assert.equal(verifyPassword('x', 'garbage'), false);
  assert.equal(verifyPassword('x', ''), false);
});

test('session token round-trips and rejects tampering/expiry', () => {
  const tok = createSession(7, 'investor');
  const p = verifySessionToken(tok);
  assert.equal(p.sub, 7);
  assert.equal(p.role, 'investor');
  // tamper the body
  const [body, sig] = tok.split('.');
  assert.equal(verifySessionToken(`${body}x.${sig}`), null);
  assert.equal(verifySessionToken(`${body}.${sig}x`), null);
  assert.equal(verifySessionToken('not-a-token'), null);
  // expired
  const expired = createSession(7, 'investor', -10);
  assert.equal(verifySessionToken(expired), null);
});

test('createInvestor + getInvestorByEmail round-trip with normalised email', async () => {
  const id = await store.createInvestor({ email: 'K.Vogel@Nordwind.VC', name: 'Katharina Vogel', accessLevel: 3 });
  const inv = await store.getInvestorByEmail('k.vogel@nordwind.vc');
  assert.equal(inv.id, id);
  assert.equal(inv.accessLevel, 3);
  assert.equal(inv.email, 'k.vogel@nordwind.vc');
  assert.equal(inv.revoked, false);
  assert.equal(inv.isExpired, false);
});

test('expiry is computed server-side (isExpired true when expires_at is past)', async () => {
  const id = await store.createInvestor({ email: 'exp@fund.vc', name: 'Ex Pired', accessLevel: 3 });
  await store.updateInvestor(id, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
  const inv = await store.getInvestorById(id);
  assert.equal(inv.isExpired, true);
});

test('updateInvestor ignores non-allowlisted keys (injection guard)', async () => {
  const id = await store.createInvestor({ email: 'a@b.vc', name: 'A B', accessLevel: 1 });
  // "email" and a bogus SQL-ish key are not in the allowlist -> ignored, no throw.
  const out = await store.updateInvestor(id, { accessLevel: 4, email: 'attacker@evil.com', 'access_level = 9; --': 1 });
  assert.equal(out.accessLevel, 4);
  const reload = await store.getInvestorById(id);
  assert.equal(reload.email, 'a@b.vc'); // unchanged
});

test('documents: level filtering only returns docs at/below the level', async () => {
  await store.insertDocument({ id: 'D-open', title: 'One-Pager', minLevel: 2, tier: 1, size: 10, bytes: Buffer.from('x') });
  await store.insertDocument({ id: 'D-nda', title: 'Financial Model', minLevel: 3, tier: 2, size: 10, bytes: Buffer.from('y') });
  await store.insertDocument({ id: 'D-lead', title: 'Cap Table', minLevel: 4, tier: 2, size: 10, bytes: Buffer.from('z') });

  const l2 = (await store.listDocumentsForLevel(2)).map((d) => d.id);
  assert.deepEqual(l2.sort(), ['D-open']);
  const l3 = (await store.listDocumentsForLevel(3)).map((d) => d.id).sort();
  assert.deepEqual(l3, ['D-nda', 'D-open']);
  const l5 = (await store.listDocumentsForLevel(5)).map((d) => d.id).sort();
  assert.deepEqual(l5, ['D-lead', 'D-nda', 'D-open']);
  // listDocuments (console) never leaks bytes
  const meta = await store.listDocuments();
  assert.equal('bytes' in meta[0], false);
});

test('logEvent appends and listLogs returns newest first', async () => {
  await store.logEvent({ actorType: 'anon', event: 'login_failed', email: 'x@y.z', ip: '1.2.3.4' });
  await store.logEvent({ actorType: 'investor', actorId: 5, event: 'document_view', documentId: 'D-nda' });
  const logs = await store.listLogs({ limit: 10 });
  assert.equal(logs.length, 2);
  assert.equal(logs[0].event, 'document_view'); // newest first
  assert.equal(logs[1].event, 'login_failed');
});
