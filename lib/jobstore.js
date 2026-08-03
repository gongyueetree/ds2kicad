// lib/jobstore.js — v0.8.4 item 1/9：JobStore 抽象 + PostgreSQL（生产）/ SQLite（本地）双适配器。
// 生产（Vercel / NODE_ENV=production）**必须**使用 PostgreSQL：Serverless 多实例与冷启动下
// :memory: 与本地 SQLite 文件不共享，作业会丢失，因此在生产环境显式 fail closed。
// Idempotency-Key 语义（item 9）：唯一键 = tenantId + ownerId + operation + documentSha256 + key，
// 且只对 active 作业生效（过期/撤销后同键可重新创建，不再撞唯一索引）。
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';

export const JOB_STATUS = { ACTIVE: 'active', REVOKED: 'revoked', EXPIRED: 'expired' };
export const SCHEMA_VERSION = 'ds2kicad.canonical-ir.v1';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** item 9：幂等作用域指纹 */
export function idempotencyScope({ tenantId, ownerId, operation = 'extract', documentSha256 = '', key }) {
  if (!key) return null;
  return createHash('sha256')
    .update([tenantId, ownerId, operation, documentSha256 || '', key].join('\u0000'))
    .digest('hex');
}

const shape = (row) => ({
  jobId: row.job_id, tenantId: row.tenant_id, ownerId: row.owner_id,
  datasheetSha256: row.datasheet_sha256, schemaVersion: row.schema_version,
  revision: Number(row.revision), status: row.status, operation: row.operation,
  createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
  ir: typeof row.ir_json === 'string' ? JSON.parse(row.ir_json) : row.ir_json
});

function guard(job) {
  if (!job) return { ok: false, error: '作业不存在', code: 'job_not_found' };
  if (job.status === JOB_STATUS.REVOKED) return { ok: false, error: '作业已撤销', code: 'job_revoked' };
  if (Date.now() > job.expiresAt) return { ok: false, error: '作业已过期，请重新提取', code: 'job_expired' };
  return { ok: true, job };
}

const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// ───────────────────────────── SQLite（本地/测试）─────────────────────────────
export class SqliteJobStore {
  constructor(file = process.env.JOBSTORE_FILE || ':memory:') {
    this.kind = 'sqlite';
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        datasheet_sha256 TEXT, schema_version TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL, operation TEXT NOT NULL DEFAULT 'extract', idem_scope TEXT,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ir_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_idem ON jobs(idem_scope);
      CREATE TABLE IF NOT EXISTS job_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, at INTEGER NOT NULL,
        actor TEXT, action TEXT NOT NULL, detail_json TEXT
      );
      CREATE TABLE IF NOT EXISTS manifests (
        job_id TEXT NOT NULL, revision INTEGER NOT NULL, ir_sha256 TEXT NOT NULL,
        manifest_sha256 TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
        manifest_json TEXT NOT NULL, PRIMARY KEY (job_id, revision)
      );
      CREATE TABLE IF NOT EXISTS asset_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, asset_key TEXT NOT NULL,
        revision INTEGER NOT NULL, version_id TEXT NOT NULL, ir_sha256 TEXT NOT NULL,
        manifest_sha256 TEXT NOT NULL, asset_sha256 TEXT, published_by TEXT NOT NULL, published_at INTEGER NOT NULL,
        UNIQUE (job_id, asset_key, revision)
      );
      CREATE TABLE IF NOT EXISTS asset_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT, asset_version_id INTEGER NOT NULL,
        path TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
        object_key TEXT, content_type TEXT
      );
    `);
  }

  create({ ir, tenantId, ownerId, datasheetSha256, idempotencyKey = null, operation = 'extract', ttlMs = DEFAULT_TTL_MS }) {
    if (!tenantId || !ownerId) throw new Error('create job 需要 tenantId 与 ownerId');
    this.db.prepare("UPDATE jobs SET status = 'expired', idem_scope = NULL WHERE status = 'active' AND expires_at < ?").run(Date.now());
    const scope = idempotencyScope({ tenantId, ownerId, operation, documentSha256: datasheetSha256, key: idempotencyKey });
    if (scope) {
      const hit = this.findByIdempotencyScope(scope);
      if (hit) return hit;                     // 只复用 active 作业
    }
    const jobId = randomUUID();
    const now = Date.now();
    this.db.prepare(`INSERT INTO jobs
      (job_id, tenant_id, owner_id, datasheet_sha256, schema_version, revision, status, operation, idem_scope, created_at, expires_at, ir_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      jobId, tenantId, ownerId, datasheetSha256 || null, SCHEMA_VERSION, 1,
      JOB_STATUS.ACTIVE, operation, scope, now, now + ttlMs, JSON.stringify(ir));
    this.appendAudit({ jobId, actor: ownerId, action: 'job_created', detail: { datasheetSha256, operation } });
    return this.get(jobId).job;
  }

  get(jobId) {
    if (!isUuid(jobId)) return { ok: false, error: 'jobId 格式非法（应为 UUID）', code: 'invalid_job' };
    const row = this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId);
    return guard(row ? shape(row) : null);
  }

  update(jobId, { ir, status }, expectedRevision, actor = null) {
    const cur = this.get(jobId);
    if (!cur.ok) return cur;
    if (expectedRevision !== undefined && expectedRevision !== cur.job.revision) {
      return { ok: false, error: `版本冲突：期望 revision ${expectedRevision}，当前 ${cur.job.revision}`, code: 'revision_conflict', currentRevision: cur.job.revision };
    }
    const next = cur.job.revision + 1;
    const res = this.db.prepare('UPDATE jobs SET ir_json = ?, status = ?, revision = ? WHERE job_id = ? AND revision = ?')
      .run(JSON.stringify(ir ?? cur.job.ir), status || cur.job.status, next, jobId, cur.job.revision);
    if (!res.changes) return { ok: false, error: '并发更新冲突', code: 'revision_conflict', currentRevision: this.get(jobId).job?.revision };
    this.appendAudit({ jobId, actor, action: 'job_updated', detail: { fromRevision: cur.job.revision, toRevision: next } });
    return this.get(jobId);
  }

  revoke(jobId, actor = null) {
    const cur = this.get(jobId);
    if (!cur.ok) return cur;
    // 撤销时清空幂等作用域，避免"撤销后同键无法重建"（item 9）
    this.db.prepare('UPDATE jobs SET status = ?, idem_scope = NULL WHERE job_id = ?').run(JOB_STATUS.REVOKED, jobId);
    this.appendAudit({ jobId, actor, action: 'job_revoked', detail: {} });
    return { ok: true };
  }

  findByIdempotencyScope(scope) {
    const rows = this.db.prepare('SELECT * FROM jobs WHERE idem_scope = ? ORDER BY created_at DESC').all(scope);
    for (const row of rows) {
      const g = guard(shape(row));
      if (g.ok) return g.job;                 // 过期/撤销的不复用
    }
    return null;
  }

  appendAudit({ jobId, actor, action, detail }) {
    this.db.prepare('INSERT INTO job_audit (job_id, at, actor, action, detail_json) VALUES (?,?,?,?,?)')
      .run(jobId, Date.now(), actor || null, action, JSON.stringify(detail || {}));
  }

  /** item 3/10：IR + revision + audit + manifest 单事务提交（失败整体回滚） */
  commitGeneration(jobId, { ir, status, expectedRevision, actor, auditEntries = [], manifest = null, assetVersions = [], failInjection = null }) {
    const cur = this.get(jobId);
    if (!cur.ok) return cur;
    if (expectedRevision !== undefined && expectedRevision !== cur.job.revision) {
      return { ok: false, error: `版本冲突：期望 ${expectedRevision}，当前 ${cur.job.revision}`, code: 'revision_conflict', currentRevision: cur.job.revision };
    }
    const next = cur.job.revision + 1;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const res = this.db.prepare('UPDATE jobs SET ir_json = ?, status = ?, revision = revision + 1 WHERE job_id = ? AND revision = ?')
        .run(JSON.stringify(ir), status || cur.job.status, jobId, cur.job.revision);
      if (!res.changes) throw new Error('revision_conflict');
      if (failInjection === 'after_ir') throw new Error('injected failure after IR update');
      for (const a of auditEntries) {
        this.db.prepare('INSERT INTO job_audit (job_id, at, actor, action, detail_json) VALUES (?,?,?,?,?)')
          .run(jobId, Date.now(), actor || null, a.action, JSON.stringify(a.detail || {}));
      }
      if (failInjection === 'after_audit') throw new Error('injected failure after audit');
      // item 10：Manifest 完整落独立表（不再只写摘要进 audit）
      if (manifest) {
        const mSha = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
        this.db.prepare(`INSERT INTO manifests (job_id, revision, ir_sha256, manifest_sha256, state, created_at, manifest_json)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(job_id, revision) DO UPDATE SET
          ir_sha256=excluded.ir_sha256, manifest_sha256=excluded.manifest_sha256, state=excluded.state, manifest_json=excluded.manifest_json`)
          .run(jobId, next, manifest.irSha256 || '', mSha, manifest.state || '', Date.now(), JSON.stringify(manifest));
      }
      // item 10：AssetVersion + AssetFile 落独立表（唯一约束 job+asset+revision）
      for (const av of assetVersions) {
        const r = this.db.prepare(`INSERT INTO asset_versions (job_id, asset_key, revision, version_id, ir_sha256, manifest_sha256, asset_sha256, published_by, published_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(jobId, av.assetKey, av.revision, av.versionId, av.irHash || '', av.manifestHash || '', av.assetHash || null, av.publishedBy || actor || '', Date.now());
        const avId = Number(r.lastInsertRowid);
        for (const f of av.files || []) {
          this.db.prepare('INSERT INTO asset_files (asset_version_id, path, sha256, bytes, object_key, content_type) VALUES (?,?,?,?,?,?)')
            .run(avId, f.path, f.sha256, f.bytes || 0, f.objectKey || null, f.contentType || null);
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      return { ok: false, error: e.message === 'revision_conflict' ? '并发更新冲突' : `事务失败: ${e.message}`, code: 'revision_conflict' };
    }
    return this.get(jobId);
  }

  listAudit(jobId) {
    return this.db.prepare('SELECT at, actor, action, detail_json FROM job_audit WHERE job_id = ? ORDER BY id').all(jobId)
      .map((r) => ({ at: Number(r.at), actor: r.actor, action: r.action, detail: JSON.parse(r.detail_json) }));
  }
  getManifest(jobId, revision) {
    const r = this.db.prepare('SELECT * FROM manifests WHERE job_id = ? AND revision = ?').get(jobId, revision);
    return r ? { jobId, revision: Number(r.revision), irSha256: r.ir_sha256, manifestSha256: r.manifest_sha256, state: r.state, manifest: JSON.parse(r.manifest_json) } : null;
  }
  listAssetVersions(jobId) {
    const rows = this.db.prepare('SELECT * FROM asset_versions WHERE job_id = ? ORDER BY id').all(jobId);
    return rows.map((r) => ({
      id: Number(r.id), jobId, assetKey: r.asset_key, revision: Number(r.revision), versionId: r.version_id,
      irSha256: r.ir_sha256, manifestSha256: r.manifest_sha256, assetSha256: r.asset_sha256,
      publishedBy: r.published_by, publishedAt: Number(r.published_at),
      files: this.db.prepare('SELECT path, sha256, bytes, object_key, content_type FROM asset_files WHERE asset_version_id = ? ORDER BY id').all(r.id)
        .map((f) => ({ path: f.path, sha256: f.sha256, bytes: Number(f.bytes), objectKey: f.object_key, contentType: f.content_type }))
    }));
  }
}

// ───────────────────────────── PostgreSQL（生产）─────────────────────────────
// 同步 API 由调用方 await（所有方法返回 Promise）。使用 pg 连接池，Serverless 多实例共享。
export const PG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ds2kicad_jobs (
  job_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  datasheet_sha256 TEXT,
  schema_version TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'extract',
  idem_scope TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  ir_json JSONB NOT NULL
);
-- 部分唯一索引：只对 active 作业生效，撤销/过期后同键可重建（item 9）
-- item 10：自然过期（expires_at 已过）的作业不得继续占用 active 唯一索引。
-- Postgres 的部分索引条件必须是 IMMUTABLE，不能写 now()，因此改为：
-- 创建新作业前先把过期行标记为 expired（reapExpired），索引条件保持 status='active'。
CREATE UNIQUE INDEX IF NOT EXISTS ds2kicad_jobs_idem
  ON ds2kicad_jobs(idem_scope) WHERE idem_scope IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS ds2kicad_jobs_exp ON ds2kicad_jobs(expires_at) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS ds2kicad_job_audit (
  id BIGSERIAL PRIMARY KEY, job_id UUID NOT NULL, at BIGINT NOT NULL,
  actor TEXT, action TEXT NOT NULL, detail_json JSONB
);
-- v0.8.7 item 10：Manifest / AssetVersion / AssetFile 独立表
CREATE TABLE IF NOT EXISTS ds2kicad_manifests (
  job_id UUID NOT NULL,
  revision INTEGER NOT NULL,
  ir_sha256 TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  manifest_json JSONB NOT NULL,
  PRIMARY KEY (job_id, revision)
);
CREATE TABLE IF NOT EXISTS ds2kicad_asset_versions (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL,
  asset_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  version_id TEXT NOT NULL,
  ir_sha256 TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  asset_sha256 TEXT,
  published_by TEXT NOT NULL,
  published_at BIGINT NOT NULL,
  CONSTRAINT ds2kicad_asset_versions_uniq UNIQUE (job_id, asset_key, revision)
);
CREATE TABLE IF NOT EXISTS ds2kicad_asset_files (
  id BIGSERIAL PRIMARY KEY,
  asset_version_id BIGINT NOT NULL REFERENCES ds2kicad_asset_versions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  object_key TEXT,
  content_type TEXT
);
CREATE INDEX IF NOT EXISTS ds2kicad_asset_files_av ON ds2kicad_asset_files(asset_version_id);
`;

export class PostgresJobStore {
  constructor(pool) {
    this.kind = 'postgres';
    this.pool = pool;
  }
  static async connect(connectionString = process.env.DATABASE_URL) {
    if (!connectionString) throw new Error('DATABASE_URL 未配置：生产环境必须使用 PostgreSQL JobStore');
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString, max: Number(process.env.PGPOOL_MAX || 3), ssl: /sslmode=require/.test(connectionString) ? { rejectUnauthorized: false } : undefined });
    const store = new PostgresJobStore(pool);
    await store.migrate();
    return store;
  }
  async migrate() { await this.pool.query(PG_SCHEMA_SQL); }

  /** item 10：把自然过期的 active 作业标记为 expired，释放幂等唯一索引 */
  async reapExpired() {
    await this.pool.query("UPDATE ds2kicad_jobs SET status = 'expired', idem_scope = NULL WHERE status = 'active' AND expires_at < $1", [Date.now()]);
  }

  async create({ ir, tenantId, ownerId, datasheetSha256, idempotencyKey = null, operation = 'extract', ttlMs = DEFAULT_TTL_MS }) {
    if (!tenantId || !ownerId) throw new Error('create job 需要 tenantId 与 ownerId');
    await this.reapExpired();
    const scope = idempotencyScope({ tenantId, ownerId, operation, documentSha256: datasheetSha256, key: idempotencyKey });
    if (scope) {
      const hit = await this.findByIdempotencyScope(scope);
      if (hit) return hit;
    }
    const jobId = randomUUID();
    const now = Date.now();
    try {
      await this.pool.query(
        `INSERT INTO ds2kicad_jobs (job_id, tenant_id, owner_id, datasheet_sha256, schema_version, revision, status, operation, idem_scope, created_at, expires_at, ir_json)
         VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11)`,
        [jobId, tenantId, ownerId, datasheetSha256 || null, SCHEMA_VERSION, JOB_STATUS.ACTIVE, operation, scope, now, now + ttlMs, JSON.stringify(ir)]);
    } catch (e) {
      if (e.code === '23505' && scope) {           // 唯一冲突 → 并发重复请求，返回既有作业
        const hit = await this.findByIdempotencyScope(scope);
        if (hit) return hit;
      }
      throw e;
    }
    await this.appendAudit({ jobId, actor: ownerId, action: 'job_created', detail: { datasheetSha256, operation } });
    return (await this.get(jobId)).job;
  }

  async get(jobId) {
    if (!isUuid(jobId)) return { ok: false, error: 'jobId 格式非法（应为 UUID）', code: 'invalid_job' };
    const { rows } = await this.pool.query('SELECT * FROM ds2kicad_jobs WHERE job_id = $1', [jobId]);
    return guard(rows[0] ? shape(rows[0]) : null);
  }

  async update(jobId, { ir, status }, expectedRevision, actor = null) {
    const cur = await this.get(jobId);
    if (!cur.ok) return cur;
    if (expectedRevision !== undefined && expectedRevision !== cur.job.revision) {
      return { ok: false, error: `版本冲突：期望 revision ${expectedRevision}，当前 ${cur.job.revision}`, code: 'revision_conflict', currentRevision: cur.job.revision };
    }
    // 乐观锁：WHERE revision = 当前值（多实例并发下只有一个成功）
    const { rowCount } = await this.pool.query(
      'UPDATE ds2kicad_jobs SET ir_json = $1, status = $2, revision = revision + 1 WHERE job_id = $3 AND revision = $4',
      [JSON.stringify(ir ?? cur.job.ir), status || cur.job.status, jobId, cur.job.revision]);
    if (!rowCount) {
      const now = await this.get(jobId);
      return { ok: false, error: '并发更新冲突', code: 'revision_conflict', currentRevision: now.job?.revision };
    }
    await this.appendAudit({ jobId, actor, action: 'job_updated', detail: { fromRevision: cur.job.revision, toRevision: cur.job.revision + 1 } });
    return this.get(jobId);
  }

  async revoke(jobId, actor = null) {
    const cur = await this.get(jobId);
    if (!cur.ok) return cur;
    await this.pool.query('UPDATE ds2kicad_jobs SET status = $1, idem_scope = NULL WHERE job_id = $2', [JOB_STATUS.REVOKED, jobId]);
    await this.appendAudit({ jobId, actor, action: 'job_revoked', detail: {} });
    return { ok: true };
  }

  async findByIdempotencyScope(scope) {
    const { rows } = await this.pool.query(
      "SELECT * FROM ds2kicad_jobs WHERE idem_scope = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 5", [scope]);
    for (const row of rows) {
      const g = guard(shape(row));
      if (g.ok) return g.job;
    }
    return null;
  }

  async appendAudit({ jobId, actor, action, detail }) {
    await this.pool.query('INSERT INTO ds2kicad_job_audit (job_id, at, actor, action, detail_json) VALUES ($1,$2,$3,$4,$5)',
      [jobId, Date.now(), actor || null, action, JSON.stringify(detail || {})]);
  }

  /** item 3/10：PostgreSQL 单事务提交 IR + revision + audit + manifest */
  async commitGeneration(jobId, { ir, status, expectedRevision, actor, auditEntries = [], manifest = null, assetVersions = [], failInjection = null }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM ds2kicad_jobs WHERE job_id = $1 FOR UPDATE', [jobId]);
      if (!rows[0]) { await client.query('ROLLBACK'); return { ok: false, error: '作业不存在', code: 'job_not_found' }; }
      const job = shape(rows[0]);
      const g = guard(job);
      if (!g.ok) { await client.query('ROLLBACK'); return g; }
      if (expectedRevision !== undefined && expectedRevision !== job.revision) {
        await client.query('ROLLBACK');
        return { ok: false, error: `版本冲突：期望 ${expectedRevision}，当前 ${job.revision}`, code: 'revision_conflict', currentRevision: job.revision };
      }
      const upd = await client.query(
        'UPDATE ds2kicad_jobs SET ir_json = $1, status = $2, revision = revision + 1 WHERE job_id = $3 AND revision = $4',
        [JSON.stringify(ir), status || job.status, jobId, job.revision]);
      if (!upd.rowCount) { await client.query('ROLLBACK'); return { ok: false, error: '并发更新冲突', code: 'revision_conflict' }; }
      if (failInjection === 'after_ir') throw new Error('injected failure after IR update');
      for (const a of auditEntries) {
        await client.query('INSERT INTO ds2kicad_job_audit (job_id, at, actor, action, detail_json) VALUES ($1,$2,$3,$4,$5)',
          [jobId, Date.now(), actor || null, a.action, JSON.stringify(a.detail || {})]);
      }
      if (failInjection === 'after_audit') throw new Error('injected failure after audit');
      const nextRev = job.revision + 1;
      // item 10：Manifest 完整落独立表
      if (manifest) {
        const mSha = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
        await client.query(`INSERT INTO ds2kicad_manifests (job_id, revision, ir_sha256, manifest_sha256, state, created_at, manifest_json)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (job_id, revision) DO UPDATE SET
          ir_sha256=EXCLUDED.ir_sha256, manifest_sha256=EXCLUDED.manifest_sha256, state=EXCLUDED.state, manifest_json=EXCLUDED.manifest_json`,
          [jobId, nextRev, manifest.irSha256 || '', mSha, manifest.state || '', Date.now(), JSON.stringify(manifest)]);
      }
      if (failInjection === 'after_manifest') throw new Error('injected failure after manifest');
      // item 10：AssetVersion + AssetFile 落独立表
      for (const av of assetVersions) {
        const r = await client.query(`INSERT INTO ds2kicad_asset_versions
          (job_id, asset_key, revision, version_id, ir_sha256, manifest_sha256, asset_sha256, published_by, published_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [jobId, av.assetKey, av.revision, av.versionId, av.irHash || '', av.manifestHash || '', av.assetHash || null, av.publishedBy || actor || '', Date.now()]);
        const avId = r.rows[0].id;
        for (const f of av.files || []) {
          await client.query('INSERT INTO ds2kicad_asset_files (asset_version_id, path, sha256, bytes, object_key, content_type) VALUES ($1,$2,$3,$4,$5,$6)',
            [avId, f.path, f.sha256, f.bytes || 0, f.objectKey || null, f.contentType || null]);
        }
      }
      if (failInjection === 'after_assets') throw new Error('injected failure after asset versions');
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      return { ok: false, error: `事务失败: ${e.message}`, code: 'transaction_failed' };
    } finally {
      client.release();
    }
    return this.get(jobId);
  }

  async listAudit(jobId) {
    const { rows } = await this.pool.query('SELECT at, actor, action, detail_json FROM ds2kicad_job_audit WHERE job_id = $1 ORDER BY id', [jobId]);
    return rows.map((r) => ({ at: Number(r.at), actor: r.actor, action: r.action, detail: r.detail_json }));
  }

  async getManifest(jobId, revision) {
    const { rows } = await this.pool.query('SELECT * FROM ds2kicad_manifests WHERE job_id = $1 AND revision = $2', [jobId, revision]);
    const r = rows[0];
    return r ? { jobId, revision: Number(r.revision), irSha256: r.ir_sha256, manifestSha256: r.manifest_sha256, state: r.state, manifest: r.manifest_json } : null;
  }

  async listAssetVersions(jobId) {
    const { rows } = await this.pool.query('SELECT * FROM ds2kicad_asset_versions WHERE job_id = $1 ORDER BY id', [jobId]);
    const out = [];
    for (const r of rows) {
      const files = await this.pool.query('SELECT path, sha256, bytes, object_key, content_type FROM ds2kicad_asset_files WHERE asset_version_id = $1 ORDER BY id', [r.id]);
      out.push({
        id: Number(r.id), jobId, assetKey: r.asset_key, revision: Number(r.revision), versionId: r.version_id,
        irSha256: r.ir_sha256, manifestSha256: r.manifest_sha256, assetSha256: r.asset_sha256,
        publishedBy: r.published_by, publishedAt: Number(r.published_at),
        files: files.rows.map((f) => ({ path: f.path, sha256: f.sha256, bytes: Number(f.bytes), objectKey: f.object_key, contentType: f.content_type }))
      });
    }
    return out;
  }
}

// ───────────────────────────── 选择与守卫 ─────────────────────────────
const IS_PROD = () => process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production' || !!process.env.VERCEL;

/** item 1：生产必须 PostgreSQL。缺 DATABASE_URL 或试图用 sqlite → 抛错（fail closed） */
export function assertProductionStore() {
  if (!IS_PROD()) return;
  if (!process.env.DATABASE_URL) {
    throw new Error('[DS2KiCad] 生产环境必须配置 DATABASE_URL（PostgreSQL JobStore）：Serverless 多实例下 :memory:/本地 SQLite 不共享，作业会丢失');
  }
  const f = process.env.JOBSTORE_FILE;
  if (f) throw new Error('[DS2KiCad] 生产环境禁止设置 JOBSTORE_FILE（本地 SQLite）；请仅使用 DATABASE_URL');
}

let singleton = null;
/** 统一入口：返回的 store 所有方法都可 await（sqlite 同步实现同样兼容） */
export async function getJobStore() {
  if (singleton) return singleton;
  assertProductionStore();
  if (process.env.DATABASE_URL) singleton = await PostgresJobStore.connect();
  else singleton = new SqliteJobStore();
  return singleton;
}
export function resetJobStoreForTests(fileOrStore = ':memory:') {
  singleton = typeof fileOrStore === 'string' ? new SqliteJobStore(fileOrStore) : fileOrStore;
  return singleton;
}
