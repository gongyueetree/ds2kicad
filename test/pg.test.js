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
  assert.ok(audit2.includes('review_patch_applied'), JSON.stringify(audit2));
  // v0.8.7 item 10：Manifest 落**独立表**（不再只写 audit 摘要）
  const m = await store.getManifest(job.jobId, 2);
  assert.ok(m, 'manifests 表必须有该 revision 的记录');
  assert.equal(m.revision, 2);
  assert.equal(m.irSha256, 'abc');
  assert.equal(m.manifest.files.length, 3);
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

test('PG-9：Lifecycle + AssetVersion + Manifest 全部事务化（item 12）', async (t) => {
  if (skipIfNoDb(t)) return;
  const { approveAssets, publishAssets } = await import('../lib/lifecycle.js');
  const base = {
    part: { mpn: 'TXN' },
    packages: [{ packageId: 'pkg_1', pinsetId: 'default' }],
    pinsets: [{ id: 'default' }], figures: [],
    lifecycle: { state: 'reviewed' }
  };
  const job = await store.create({ ir: base, tenantId: 'tx', ownerId: 'u1' });
  // approve：IR + audit + manifest 同事务
  const approved = approveAssets(base, { keys: ['footprint:pkg_1'], actor: 'u1', revision: job.revision, irHash: 'ih', manifestHash: 'mh', reason: 'ok' });
  const c1 = await store.commitGeneration(job.jobId, {
    ir: approved, expectedRevision: job.revision, actor: 'u1',
    auditEntries: [{ action: 'lifecycle_approve', detail: { assets: ['footprint:pkg_1'] } }],
    manifest: { irSha256: 'ih', partBundleSha256: 'pb', files: [{ path: 'a', sha256: 'x' }] }
  });
  assert.equal(c1.ok, true);
  assert.ok(c1.job.ir.lifecycle.approvals['footprint:pkg_1']);
  // publish：不可变 AssetVersion 落库
  const published = publishAssets(c1.job.ir, {
    keys: ['footprint:pkg_1'], actor: 'u1', revision: c1.job.revision,
    irHash: 'ih', manifestHash: 'mh', manifest: { files: [{ path: 'a', sha256: 'x', bytes: 1 }] }
  });
  const c2 = await store.commitGeneration(job.jobId, {
    ir: published, expectedRevision: c1.job.revision, actor: 'u1',
    auditEntries: [{ action: 'lifecycle_publish', detail: { assets: ['footprint:pkg_1'] } }],
    manifest: { irSha256: 'ih', partBundleSha256: 'pb', files: [{ path: 'a', sha256: 'x' }] }
  });
  assert.equal(c2.ok, true);
  const versions = c2.job.ir.assetVersions;
  assert.equal(versions.length, 1);
  assert.equal(versions[0].versionId, `footprint:pkg_1@r${c1.job.revision}`);
  assert.equal(versions[0].immutable, true);
  assert.ok(versions[0].files.length === 1);
  // 事务性：冲突提交不得写入任何一部分
  const beforeAudit = (await store.listAudit(job.jobId)).length;
  const bad = await store.commitGeneration(job.jobId, {
    ir: { ...published, part: { mpn: 'SHOULD-NOT' } }, expectedRevision: 99, actor: 'u1',
    auditEntries: [{ action: 'never_appears' }], manifest: { irSha256: 'z', files: [] }
  });
  assert.equal(bad.ok, false);
  const afterAudit = await store.listAudit(job.jobId);
  assert.equal(afterAudit.length, beforeAudit);
  assert.ok(!afterAudit.some((a) => a.action === 'never_appears'));
  assert.equal((await store.get(job.jobId)).job.ir.part.mpn, 'TXN');
});

test('PG-10：revoke 事务化且撤销后不可读', async (t) => {
  if (skipIfNoDb(t)) return;
  const job = await store.create({ ir: { part: { mpn: 'RV' } }, tenantId: 'tx', ownerId: 'u1' });
  await store.revoke(job.jobId, 'u1');
  const g = await store.get(job.jobId);
  assert.equal(g.ok, false);
  assert.equal(g.code, 'job_revoked');
  const audit = (await store.listAudit(job.jobId)).map((a) => a.action);
  assert.ok(audit.includes('job_revoked'));
});


test('PG-11：失败注入 —— IR/Audit/Manifest/AssetVersion 全部回滚（item 10）', async (t) => {
  if (skipIfNoDb(t)) return;
  const job = await store.create({ ir: ir('ROLLBACK'), tenantId: 'rb', ownerId: 'u1' });
  const baseAudit = (await store.listAudit(job.jobId)).length;
  for (const point of ['after_ir', 'after_audit', 'after_manifest', 'after_assets']) {
    const r = await store.commitGeneration(job.jobId, {
      ir: ir('MUST-NOT-PERSIST'), expectedRevision: job.revision, actor: 'u1',
      auditEntries: [{ action: `never_${point}` }],
      manifest: { irSha256: 'x', state: 'edited', files: [{ path: 'p', sha256: 's', bytes: 1 }] },
      assetVersions: [{ assetKey: 'footprint:pkg_x', revision: job.revision + 1, versionId: `footprint:pkg_x@r${job.revision + 1}`, irHash: 'x', manifestHash: 'y', publishedBy: 'u1', files: [{ path: 'p', sha256: 's', bytes: 1 }] }],
      failInjection: point
    });
    assert.equal(r.ok, false, `${point} 应失败`);
    // IR 未变
    const cur = await store.get(job.jobId);
    assert.equal(cur.job.ir.part.mpn, 'ROLLBACK', `${point}: IR 不得变化`);
    assert.equal(cur.job.revision, job.revision, `${point}: revision 不得变化`);
    // Audit 未增
    const audit = await store.listAudit(job.jobId);
    assert.equal(audit.length, baseAudit, `${point}: audit 不得写入`);
    assert.ok(!audit.some((a) => a.action.startsWith('never_')));
    // Manifest 未写
    assert.equal(await store.getManifest(job.jobId, job.revision + 1), null, `${point}: manifest 不得写入`);
    // AssetVersion 未写
    assert.equal((await store.listAssetVersions(job.jobId)).length, 0, `${point}: asset_versions 不得写入`);
  }
  // 无注入时全部生效
  const ok = await store.commitGeneration(job.jobId, {
    ir: ir('PERSISTED'), expectedRevision: job.revision, actor: 'u1',
    auditEntries: [{ action: 'ok_action' }],
    manifest: { irSha256: 'ih', state: 'edited', files: [{ path: 'p', sha256: 's', bytes: 1 }] },
    assetVersions: [{ assetKey: 'footprint:pkg_x', revision: job.revision + 1, versionId: `footprint:pkg_x@r${job.revision + 1}`, irHash: 'ih', manifestHash: 'mh', assetHash: 'ah', publishedBy: 'u1', files: [{ path: 'p', sha256: 's', bytes: 1, objectKey: 'obj/k', contentType: 'image/png' }] }]
  });
  assert.equal(ok.ok, true);
  assert.equal((await store.get(job.jobId)).job.ir.part.mpn, 'PERSISTED');
  assert.ok(await store.getManifest(job.jobId, ok.job.revision));
  const avs = await store.listAssetVersions(job.jobId);
  assert.equal(avs.length, 1);
  assert.equal(avs[0].files[0].objectKey, 'obj/k');
  assert.equal(avs[0].files[0].contentType, 'image/png');
});

test('PG-12：AssetVersion 唯一约束（job+assetKey+revision）', async (t) => {
  if (skipIfNoDb(t)) return;
  const job = await store.create({ ir: ir('UNIQ'), tenantId: 'uq', ownerId: 'u1' });
  const mk = (rev) => ({
    ir: ir('UNIQ'), expectedRevision: rev, actor: 'u1',
    assetVersions: [{ assetKey: 'symbol:default', revision: rev + 1, versionId: `symbol:default@r${rev + 1}`, irHash: 'h', manifestHash: 'm', publishedBy: 'u1', files: [] }]
  });
  const c1 = await store.commitGeneration(job.jobId, mk(job.revision));
  assert.equal(c1.ok, true);
  // 同 job+assetKey+revision 再插入必须冲突（事务回滚）
  const dup = await store.commitGeneration(job.jobId, {
    ...mk(c1.job.revision),
    assetVersions: [{ assetKey: 'symbol:default', revision: job.revision + 1, versionId: 'dup', irHash: 'h', manifestHash: 'm', publishedBy: 'u1', files: [] }]
  });
  assert.equal(dup.ok, false, '唯一约束必须阻止重复 AssetVersion');
  assert.equal((await store.listAssetVersions(job.jobId)).length, 1);
});
