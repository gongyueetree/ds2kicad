import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ALLOW_GUEST_TRIAL = '1';
process.env.GUEST_SESSION_SECRET = 'test-guest-secret-32-bytes-minimum';
process.env.HANDOFF_TOKEN_SECRET = 'test-handoff-secret-32-bytes-minimum';
process.env.GUEST_FREE_CREDITS = '3';
delete process.env.DATABASE_URL;
delete process.env.VERCEL;
process.env.NODE_ENV = 'test';

const sessionMod = await import('../lib/platform-session.js');
const credits = await import('../lib/credits.js');
const authMod = await import('../lib/auth.js');

test('signed guest token survives cookie/header auth and tampering fails', () => {
  const issued = sessionMod.issueGuestSession({ channel: 'tindie', locale: 'en-US' });
  const verified = sessionMod.verifyGuestSession(issued.token);
  assert.equal(verified.ok, true);
  assert.equal(verified.payload.channel, 'tindie');

  const reqHeader = { headers: { 'x-guest-session': issued.token } };
  const auth = authMod.authenticate(reqHeader);
  assert.equal(auth.ok, true);
  assert.equal(auth.session.guest, true);
  assert.equal(auth.session.channel, 'tindie');

  const bad = issued.token.slice(0, -1) + (issued.token.endsWith('a') ? 'b' : 'a');
  assert.equal(sessionMod.verifyGuestSession(bad).ok, false);
});

test('guest handoff token is signed, expiring and keeps attribution', () => {
  const token = sessionMod.issueHandoff({
    guestId: randomUUID(), channel: 'eetree', locale: 'zh-CN',
    returnTo: 'https://agent.example.test/?channel=eetree', jobId: randomUUID()
  });
  const v = sessionMod.verifyHandoff(token);
  assert.equal(v.ok, true);
  assert.equal(v.payload.channel, 'eetree');
  assert.equal(v.payload.locale, 'zh-CN');
  assert.match(v.payload.returnTo, /channel=eetree/);
});

test('credit wallet follows reserve -> refund / commit semantics', async () => {
  const session = {
    guest: true, guestId: randomUUID(), sub: 'guest:test', tenantId: 'guest',
    channel: 'tindie', locale: 'en-US', roles: ['viewer', 'editor']
  };
  let w = await credits.getWallet(session);
  assert.equal(w.balance, 3);

  const a = await credits.reserveCredit(session, 'datasheet_to_kicad');
  assert.equal(a.ok, true);
  assert.equal(a.wallet.balance, 2);
  await credits.refundCredit(a.reservationId);
  w = await credits.getWallet(session);
  assert.equal(w.balance, 3);

  const b = await credits.reserveCredit(session, 'datasheet_to_kicad');
  assert.equal(b.ok, true);
  const committed = await credits.commitCredit(b.reservationId);
  assert.equal(committed.ok, true);
  w = await credits.getWallet(session);
  assert.equal(w.balance, 2);
});

test('credit exhaustion blocks the fourth conversion', async () => {
  const session = {
    guest: true, guestId: randomUUID(), sub: 'guest:test2', tenantId: 'guest',
    channel: 'eetree', locale: 'zh-CN', roles: ['viewer', 'editor']
  };
  for (let i = 0; i < 3; i++) {
    const r = await credits.reserveCredit(session, 'datasheet_to_kicad');
    assert.equal(r.ok, true);
    await credits.commitCredit(r.reservationId);
  }
  const blocked = await credits.reserveCredit(session, 'datasheet_to_kicad');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'credits_exhausted');
  assert.equal(blocked.wallet.balance, 0);
});
