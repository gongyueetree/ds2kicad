import { createHash } from 'node:crypto';
import { getJobStore } from './jobstore.js';

// Small acceptance-test files only. Explicit opt-in; never a production fallback.
export class PreviewPostgresObjectStore {
  constructor({ pool, namespace = process.env.PREVIEW_STORAGE_NAMESPACE, maxBytes = 20 * 1024 * 1024, quotaBytes = 250 * 1024 * 1024 } = {}) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(namespace || '')) throw new Error('需要有效的 PREVIEW_STORAGE_NAMESPACE');
    this.kind = 'preview-postgres'; this.namespace = namespace;
    this.pool = pool; this.maxBytes = maxBytes; this.quotaBytes = quotaBytes;
  }
  async ready() {
    if (!this.initializing) this.initializing = (async () => {
      if (!this.pool) {
        const store = await getJobStore();
        if (store.kind !== 'postgres') throw new Error('数据库文件测试模式需要 PostgreSQL');
        this.pool = store.pool;
      }
      await this.pool.query(`CREATE TABLE IF NOT EXISTS ds2kicad_preview_objects (
        namespace TEXT NOT NULL, object_key TEXT NOT NULL, sha256 TEXT NOT NULL,
        content_type TEXT NOT NULL, body BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(namespace, object_key))`);
    })().catch(e => { this.initializing = null; throw e; });
    await this.initializing;
  }
  validate(key) {
    if (typeof key !== 'string' || !key || key.length > 1024 || /[\x00-\x1f]/.test(key)) throw new Error('非法对象键');
  }
  async put(key, buf, { contentType = 'application/octet-stream' } = {}) {
    this.validate(key);
    if (!Buffer.isBuffer(buf) || buf.length > this.maxBytes) throw new Error('测试模式单个文件最多 20MB');
    await this.ready();
    const sha256 = createHash('sha256').update(buf).digest('hex'), client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize quota checks across serverless instances, including concurrent duplicate puts.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ds2-preview:${this.namespace}`]);
      const existing = await client.query('SELECT sha256 FROM ds2kicad_preview_objects WHERE namespace=$1 AND object_key=$2', [this.namespace, key]);
      if (existing.rows[0]) {
        if (existing.rows[0].sha256 !== sha256) throw new Error('不可变对象内容冲突');
      } else {
        const used = await client.query('SELECT COALESCE(SUM(octet_length(body)),0) AS bytes FROM ds2kicad_preview_objects WHERE namespace=$1', [this.namespace]);
        if (Number(used.rows[0].bytes) + buf.length > this.quotaBytes) throw new Error('测试文件空间已满（250MB），请清理测试数据或接入 S3');
        await client.query('INSERT INTO ds2kicad_preview_objects(namespace,object_key,sha256,content_type,body) VALUES($1,$2,$3,$4,$5)', [this.namespace,key,sha256,contentType,buf]);
      }
      await client.query('COMMIT');
      return { key, sha256, bytes: buf.length, contentType };
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
  async get(key) {
    this.validate(key); await this.ready();
    const { rows } = await this.pool.query('SELECT body,sha256 FROM ds2kicad_preview_objects WHERE namespace=$1 AND object_key=$2', [this.namespace,key]);
    if (!rows[0]) return null;
    const buf = Buffer.from(rows[0].body);
    if (createHash('sha256').update(buf).digest('hex') !== rows[0].sha256) throw new Error('测试文件校验失败');
    return buf;
  }
  async exists(key) {
    this.validate(key); await this.ready();
    const { rows } = await this.pool.query('SELECT 1 FROM ds2kicad_preview_objects WHERE namespace=$1 AND object_key=$2', [this.namespace,key]);
    return rows.length > 0;
  }
}
