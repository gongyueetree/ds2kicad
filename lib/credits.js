import { randomUUID } from 'node:crypto';

export const OPERATION_COSTS = Object.freeze({
  datasheet_to_kicad: Number(process.env.COST_DATASHEET_TO_KICAD || 1),
  schematic_to_kicad: Number(process.env.COST_SCHEMATIC_TO_KICAD || 5)
});

// Test-stage default: metering remains visible, but quota enforcement is OFF unless explicitly enabled.
// Launch switch: set CREDIT_ENFORCEMENT=1 and configure normal grants/costs. No code migration required.
export const creditEnforcementEnabled = () => process.env.CREDIT_ENFORCEMENT === '1';
const testBalance = () => Math.max(1000, Number(process.env.TEST_CREDIT_BALANCE || 100000));

const mem = globalThis.__ds2kicadCreditStore || (globalThis.__ds2kicadCreditStore = {
  wallets: new Map(),
  ledger: new Map()
});
let pgPoolPromise = null;
let pgReadyPromise = null;

const isProd = () => process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production' || !!process.env.VERCEL;

export function principalKey(session) {
  if (session?.guest && session.guestId) return `guest:${session.guestId}`;
  if (session?.sub) return `user:${session.tenantId || 'default'}:${session.sub}`;
  throw new Error('无法确定计费主体');
}

export function initialCredits(session) {
  if (!creditEnforcementEnabled()) return testBalance();
  if (session?.guest) return Math.max(0, Number(process.env.GUEST_FREE_CREDITS || 3));
  return Math.max(0, Number(process.env.REGISTERED_FREE_CREDITS || 5));
}

function operationCost(operation, override) {
  const n = override == null ? OPERATION_COSTS[operation] : Number(override);
  if (!Number.isFinite(n) || n < 0) throw new Error(`非法 Credit 成本: ${operation}`);
  return Math.ceil(n);
}

async function getPool() {
  if (pgPoolPromise) return pgPoolPromise;
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (isProd()) throw new Error('DATABASE_URL 未配置：生产环境无法持久化 Trial/Credit');
    return null;
  }
  pgPoolPromise = import('pg').then(({ default: pg }) => new pg.Pool({
    connectionString: url,
    max: Math.max(1, Number(process.env.PGPOOL_MAX || 2)),
    ssl: /sslmode=require|neon\.tech|supabase\.co|vercel-storage\.com/i.test(url) ? { rejectUnauthorized: false } : undefined
  }));
  return pgPoolPromise;
}

async function ensurePg(pool) {
  if (!pool) return;
  if (!pgReadyPromise) pgReadyPromise = pool.query(`
    CREATE TABLE IF NOT EXISTS ds2kicad_credit_wallet (
      principal_key TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL,
      channel TEXT,
      balance INTEGER NOT NULL,
      granted_total INTEGER NOT NULL,
      spent_total INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ds2kicad_credit_ledger (
      id UUID PRIMARY KEY,
      principal_key TEXT NOT NULL,
      operation TEXT NOT NULL,
      cost INTEGER NOT NULL,
      state TEXT NOT NULL,
      ref_key TEXT,
      metadata_json JSONB,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ds2kicad_credit_ledger_principal ON ds2kicad_credit_ledger(principal_key, created_at DESC);
  `);
  await pgReadyPromise;
}

function walletView(row, session) {
  const enforced = creditEnforcementEnabled();
  const rawBalance = Number(row.balance || 0);
  const granted = Number(row.granted_total || 0);
  const spent = Number(row.spent_total || 0);
  return {
    principalKey: row.principal_key,
    type: session?.guest ? 'guest' : 'registered',
    channel: row.channel || session?.channel || 'direct',
    balance: enforced ? rawBalance : Math.max(rawBalance, testBalance()),
    rawBalance,
    grantedTotal: enforced ? granted : Math.max(granted, testBalance()),
    spentTotal: spent,
    freeTrial: session?.guest === true,
    costs: OPERATION_COSTS,
    enforcementEnabled: enforced,
    testMode: !enforced,
    unlimitedForTesting: !enforced
  };
}

function ensureMemWallet(session) {
  const key = principalKey(session);
  let w = mem.wallets.get(key);
  if (!w) {
    const grant = initialCredits(session);
    w = {
      principal_key: key,
      owner_type: session?.guest ? 'guest' : 'registered',
      channel: session?.channel || 'direct',
      balance: grant,
      granted_total: grant,
      spent_total: 0,
      created_at: Date.now(),
      updated_at: Date.now()
    };
    mem.wallets.set(key, w);
  }
  return w;
}

async function ensurePgWallet(client, session) {
  const key = principalKey(session);
  const grant = initialCredits(session);
  const now = Date.now();
  await client.query(`INSERT INTO ds2kicad_credit_wallet
    (principal_key, owner_type, channel, balance, granted_total, spent_total, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$4,0,$5,$5)
    ON CONFLICT(principal_key) DO NOTHING`, [key, session?.guest ? 'guest' : 'registered', session?.channel || 'direct', grant, now]);
  const r = await client.query('SELECT * FROM ds2kicad_credit_wallet WHERE principal_key=$1', [key]);
  return r.rows[0];
}

export async function getWallet(session) {
  const pool = await getPool();
  if (!pool) return walletView(ensureMemWallet(session), session);
  await ensurePg(pool);
  const c = await pool.connect();
  try { return walletView(await ensurePgWallet(c, session), session); }
  finally { c.release(); }
}

export async function reserveCredit(session, operation, { cost, refKey = null, metadata = {} } = {}) {
  const charge = operationCost(operation, cost);
  // During testing we deliberately keep usage metering available but never block or deduct.
  if (!creditEnforcementEnabled()) {
    return { ok: true, reservationId: null, wallet: await getWallet(session), cost: 0, nominalCost: charge, testMode: true };
  }
  if (charge === 0) return { ok: true, reservationId: null, wallet: await getWallet(session), cost: 0 };
  const key = principalKey(session);
  const id = randomUUID();
  const now = Date.now();
  const pool = await getPool();

  if (!pool) {
    const w = ensureMemWallet(session);
    if (w.balance < charge) return { ok: false, code: 'credits_exhausted', wallet: walletView(w, session), cost: charge };
    w.balance -= charge; w.spent_total += charge; w.updated_at = now;
    mem.ledger.set(id, { id, principal_key: key, operation, cost: charge, state: 'reserved', ref_key: refKey, metadata_json: metadata, created_at: now, updated_at: now });
    return { ok: true, reservationId: id, wallet: walletView(w, session), cost: charge };
  }

  await ensurePg(pool);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await ensurePgWallet(c, session);
    const r = await c.query('SELECT * FROM ds2kicad_credit_wallet WHERE principal_key=$1 FOR UPDATE', [key]);
    const w = r.rows[0];
    if (Number(w.balance) < charge) {
      await c.query('ROLLBACK');
      return { ok: false, code: 'credits_exhausted', wallet: walletView(w, session), cost: charge };
    }
    await c.query('UPDATE ds2kicad_credit_wallet SET balance=balance-$2, spent_total=spent_total+$2, updated_at=$3 WHERE principal_key=$1', [key, charge, now]);
    await c.query(`INSERT INTO ds2kicad_credit_ledger
      (id, principal_key, operation, cost, state, ref_key, metadata_json, created_at, updated_at)
      VALUES ($1,$2,$3,$4,'reserved',$5,$6,$7,$7)`, [id, key, operation, charge, refKey, metadata, now]);
    await c.query('COMMIT');
    const wr = await pool.query('SELECT * FROM ds2kicad_credit_wallet WHERE principal_key=$1', [key]);
    return { ok: true, reservationId: id, wallet: walletView(wr.rows[0], session), cost: charge };
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch {}
    throw e;
  } finally { c.release(); }
}

export async function commitCredit(reservationId) {
  if (!reservationId) return { ok: true };
  const pool = await getPool();
  if (!pool) {
    const row = mem.ledger.get(reservationId);
    if (!row) return { ok: false, code: 'reservation_not_found' };
    if (row.state === 'reserved') { row.state = 'committed'; row.updated_at = Date.now(); }
    return { ok: true };
  }
  await ensurePg(pool);
  const r = await pool.query(`UPDATE ds2kicad_credit_ledger SET state='committed', updated_at=$2
    WHERE id=$1 AND state='reserved' RETURNING id`, [reservationId, Date.now()]);
  return { ok: true, committed: r.rowCount > 0 };
}

export async function refundCredit(reservationId) {
  if (!reservationId) return { ok: true };
  const pool = await getPool();
  if (!pool) {
    const row = mem.ledger.get(reservationId);
    if (!row || row.state !== 'reserved') return { ok: true };
    const w = mem.wallets.get(row.principal_key);
    if (w) { w.balance += row.cost; w.spent_total = Math.max(0, w.spent_total - row.cost); w.updated_at = Date.now(); }
    row.state = 'refunded'; row.updated_at = Date.now();
    return { ok: true };
  }
  await ensurePg(pool);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(`SELECT * FROM ds2kicad_credit_ledger WHERE id=$1 FOR UPDATE`, [reservationId]);
    const row = r.rows[0];
    if (!row || row.state !== 'reserved') { await c.query('COMMIT'); return { ok: true }; }
    await c.query('UPDATE ds2kicad_credit_wallet SET balance=balance+$2, spent_total=GREATEST(0,spent_total-$2), updated_at=$3 WHERE principal_key=$1', [row.principal_key, Number(row.cost), Date.now()]);
    await c.query("UPDATE ds2kicad_credit_ledger SET state='refunded', updated_at=$2 WHERE id=$1", [reservationId, Date.now()]);
    await c.query('COMMIT');
    return { ok: true };
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch {}
    throw e;
  } finally { c.release(); }
}

export async function topupCredits(session, amount, metadata = {}) {
  const n = Math.floor(Number(amount));
  if (!Number.isFinite(n) || n <= 0 || n > 1000000) throw new Error('充值额度必须为 1..1000000');
  const key = principalKey(session);
  const now = Date.now();
  const id = randomUUID();
  const pool = await getPool();
  if (!pool) {
    const w = ensureMemWallet(session);
    w.balance += n; w.granted_total += n; w.updated_at = now;
    mem.ledger.set(id, { id, principal_key: key, operation: 'topup', cost: -n, state: 'committed', metadata_json: metadata, created_at: now, updated_at: now });
    return walletView(w, session);
  }
  await ensurePg(pool);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await ensurePgWallet(c, session);
    await c.query('UPDATE ds2kicad_credit_wallet SET balance=balance+$2, granted_total=granted_total+$2, updated_at=$3 WHERE principal_key=$1', [key, n, now]);
    await c.query(`INSERT INTO ds2kicad_credit_ledger
      (id, principal_key, operation, cost, state, metadata_json, created_at, updated_at)
      VALUES ($1,$2,'topup',$3,'committed',$4,$5,$5)`, [id, key, -n, metadata, now]);
    await c.query('COMMIT');
    return await getWallet(session);
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch {}
    throw e;
  } finally { c.release(); }
}
