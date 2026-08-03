// test/pg.test.js — v0.8.5 item 10：**真实 PostgreSQL** 集成测试。
// 需要环境变量 TEST_DATABASE_URL 指向可用的 PG 实例；未配置时整体 skip 并明确标注 NOT VERIFIED。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresJobStore, idempotencyScope } from '../lib/jobstore.js';

const URL = process.env.TEST_DATABASE_URL;
let store, pool;

before(async () => {
  if (!URL) return;
  store = await PostgresJobStore.connect(URL);   // 内含 migrate()
  pool = store.pool;
  await pool.query('DELETE FROM ds2kicad_job_audit');
  await pool.query('DELETE FROM ds2kicad_jobs');
});
after(async () => { if (pool) await pool.end(); });

const skipIfNoDb = (t) => {
  if (!URL) { t.skip('TEST_DATABASE_URL 未配置 — 真实 PostgreSQL NOT VERIFIED'); return true; }
  return false;
};
const ir = (mpn = 'PG1') => ({ part: { mpn }, packages: [], pinsets: [], figures: [], mock: false });

test('PG-1：迁移建表成功，且索引/约束就位', async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await pool.query("SELECT indexname FROM pg_indexes WHERE tablename = 'ds2kicad_jobs'");
  const names = rows.map((r) => r.indexname);
  assert.ok(names.includes('ds2kicad_jobs_idem'), JSON.stringify(names));
  assert.ok(names.includes('ds2kicad_jobs_exp'));
  // 重复 migrate 幂等
  await store.migrate();
});

test('PG-2：create/get/update 跨"实例"共享（两个独立连接池）', async (t) => {
  if (skipIfNoDb(t)) return;
  const instanceA = await PostgresJobStore.connect(URL);
  const instanceB = await PostgresJobStore.connect(URL);
  try {
    const job = await instanceA.create({ ir: ir('SHARED'), tenantId: 't1', ownerId: 'u1', datasheetSha256: 'd1' });
    const got = await instanceB.get(job.jobId);
    assert.equal(got.ok, true, '另一实例必须能读到');
    assert.equal(got.job.ir.part.mpn, 'SHARED');
    const upd = await instanceB.update(job.jobId, { ir: ir('FROM-B') }, 1, 'u1');
    assert.equal(upd.job.revision, 2);
    const back = await instanceA.get(job.jobId);
    assert.equal(back.job.ir.part.mpn, 'FROM-B', '实例 A 必须看到实例 B 的更新');
    // "重启"：全新连接池仍可读
    const restarted = await PostgresJobStore.connect(URL);
    assert.equal((await restarted.get(job.jobId)).job.revision, 2);
    await restarted.pool.end();
  } finally {
    await instanceA.pool.end(); await instanceB.pool.end();
  }
});

test('PG-3：并发 update 只有一个成功（乐观锁 CAS）', async (t) => {
  if (skipIfNoDb(t)) return;
  const job = await store.create({ ir: ir('RACE'), tenantId: 't1', ownerId: 'u1' });
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => store.update(job.jobId, { ir: ir(`W${i}`) }, 1, 'u1'))
  );
  const okCount = results.filter((r) => r.ok).length;
  const conflicts = results.filter((r) => !r.ok && r.code === 'revision_conflict').length;
  assert.equal(okCount, 1, `期望恰好 1 个成功，实际 ${okCount}`);
  assert.equal(conflicts, 7);
  assert.equal((await store.get(job.jobId)).job.revision, 2);
});

test('PG-4：commitGeneration 事务性 —— 失败整体回滚', async (t) => {
  if (skipIfNoDb(t)) return;
  const job = await store.create({ ir: ir('TX'), tenantId: 't1', ownerId: 'u1' });
  const before = await store.listAudit(job.jobId);
  // 版本冲突 → IR 与 audit 均不得变化
  const bad = await store.commitGeneration(job.jobId, {
    ir: ir('SHOULD-NOT-PERSIST'), expectedRevision: 99, actor: 'u1',
    auditEntries: [{ action: 'should_not_appear' }], manifest: { irSha256: 'x', files: [] }
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'revision_conflict');
  const after = await store.get(job.jobId);
  assert.equal(after.job.ir.part.mpn, 'TX', 'IR 不得被修改');
  const audit = await store.listAudit(job.jobId);
  assert.equal(audit.length, before.length, 'audit 不得写入');
  assert.ok(!audit.some((a) => a.action === 'should_not_appear'));
  // 正常提交 → IR + audit + manifest 一起生效
  const ok = await store.commitGeneration(job.jobId, {
    ir: ir('TX2'), expectedRevision: 1, actor: 'u1',
    auditEntries: [{ action: 'review_patch_applied', detail: { changes: 3 } }],
    manifest: { irSha256: 'abc', partBundleSha256: 'def', files: [1, 2, 3] }
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.job.revision, 2);
  const audit2 = (await store.listAudit(job.jobId)).map((a) => a.action);
  assert.ok(audit2.includes('review_patch_applied') && audit2.includes('manifest_saved'), JSON.stringify(audit2));
});

test('PG-5：幂等作用域 —— 同租户不同用户/不同文档不串 Job', async (t) => {
  if (skipIfNoDb(t)) return;
  const mk = (owner, doc) => store.create({ ir: ir('IDEM'), tenantId: 't1', ownerId: owner, datasheetSha256: doc, idempotencyKey: 'SAME' });
  const a1 = await mk('u1', 'docA');
  const a2 = await mk('u1', 'docA');
  const b = await mk('u2', 'docA');
  const c = await mk('u1', 'docB');
  assert.equal(a1.jobId, a2.jobId);
  assert.notEqual(a1.jobId, b.jobId);
  assert.notEqual(a1.jobId, c.jobId);
  assert.notEqual(idempotencyScope({ tenantId: 't1', ownerId: 'u1', operation: 'extract', documentSha256: 'd', key: 'k' }),
    idempotencyScope({ tenantId: 't1', ownerId: 'u1', operation: 'generate', documentSha256: 'd', key: 'k' }));
});

test('PG-6：自然过期后同 Idempotency-Key 可重建（唯一索引不冲突）', async (t) => {
  if (skipIfNoDb(t)) return;
  const first = await store.create({
    ir: ir('EXPIRE'), tenantId: 't2', ownerId: 'u1', datasheetSha256: 'dX',
    idempotencyKey: 'EXP-KEY', ttlMs: 50
  });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal((await store.get(first.jobId)).ok, false, '应已过期');
  // 关键：过期行不得继续占用 active 唯一索引
  const rebuilt = await store.create({
    ir: ir('EXPIRE2'), tenantId: 't2', ownerId: 'u1', datasheetSha256: 'dX', idempotencyKey: 'EXP-KEY'
  });
  assert.notEqual(rebuilt.jobId, first.jobId);
  assert.equal((await store.get(rebuilt.jobId)).ok, true);
  const { rows } = await pool.query("SELECT status FROM ds2kicad_jobs WHERE job_id = $1", [first.jobId]);
  assert.equal(rows[0].status, 'expired', '过期行必须被标记为 expired');
});

test('PG-7：撤销后同 Idempotency-Key 可重建；撤销的作业不可读', async (t) => {
  if (skipIfNoDb(t)) return;
  const j = await store.create({ ir: ir('REV'), tenantId: 't3', ownerId: 'u1', datasheetSha256: 'dR', idempotencyKey: 'REV-KEY' });
  await store.revoke(j.jobId, 'u1');
  assert.equal((await store.get(j.jobId)).code, 'job_revoked');
  const again = await store.create({ ir: ir('REV2'), tenantId: 't3', ownerId: 'u1', datasheetSha256: 'dR', idempotencyKey: 'REV-KEY' });
  assert.notEqual(again.jobId, j.jobId);
});

test('PG-8：并发 create 同 Idempotency-Key 只产生一个 Job', async (t) => {
  if (skipIfNoDb(t)) return;
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    store.create({ ir: ir('CONC'), tenantId: 't4', ownerId: 'u1', datasheetSha256: 'dC', idempotencyKey: 'CONC-KEY' })));
  const ids = new Set(results.map((r) => r.jobId));
  assert.equal(ids.size, 1, `并发创建应收敛为 1 个 Job，实际 ${ids.size}`);
});
