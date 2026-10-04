// lib/objectstore.js — v0.8.7 item 8：对象存储抽象。
// PNG 等二进制资产**不再存进 Job IR**，只在 IR 中保留不可变对象键 + SHA256 + 尺寸 + 媒体类型。
// 默认适配器：本地文件（LocalObjectStore，可真实测试）；生产用 S3/Vercel Blob 适配器（同接口）。
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { PreviewPostgresObjectStore } from './preview-objectstore.js';

/** 对象键不可变：内容寻址（sha256 前缀分桶），同内容永远同键 */
export function objectKey({ tenantId, jobId, kind, sha256, ext }) {
  return `${tenantId}/${jobId}/${kind}/${sha256.slice(0, 2)}/${sha256}.${ext}`;
}

export class LocalObjectStore {
  constructor(root = process.env.OBJECT_STORE_DIR || '/tmp/ds2kicad-objects') {
    this.kind = 'local';
    this.root = root;
    mkdirSync(root, { recursive: true });
  }
  async put(key, buf, { contentType = 'application/octet-stream' } = {}) {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    if (!existsSync(p)) writeFileSync(p, buf);          // 不可变：已存在则不覆盖
    return { key, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length, contentType };
  }
  async get(key) {
    const p = this.path(key);
    if (!existsSync(p)) return null;
    return readFileSync(p);
  }
  path(key) {
    if (typeof key !== 'string' || !key || key.includes('\\')) throw new Error('非法对象键');
    const p = resolve(this.root, key), root = resolve(this.root);
    if (!p.startsWith(root + sep)) throw new Error('对象键越界');
    return p;
  }
  async exists(key) { return existsSync(this.path(key)); }
}

/** Content-addressed S3 adapter; compatible with S3/R2/MinIO endpoints. */
export class S3ObjectStore {
  constructor({ endpoint, bucket, accessKeyId, secretAccessKey, region = process.env.S3_REGION || 'auto', client } = {}) {
    this.kind = 's3'; this.bucket = bucket;
    if (!bucket) throw new Error('S3ObjectStore 需要 bucket');
    this.client = client || new S3Client({ region, ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}) });
  }
  async put(key, buf, { contentType = 'application/octet-stream' } = {}) {
    const sha256 = createHash('sha256').update(buf).digest('hex');
    try { await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: buf, ContentType: contentType, Metadata: { sha256 }, IfNoneMatch: '*' })); }
    catch (e) {
      if (e.$metadata?.httpStatusCode !== 412) throw e;
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      if (head.Metadata?.sha256 !== sha256) throw new Error('不可变对象内容冲突');
    }
    return { key, sha256, bytes: buf.length, contentType };
  }
  async get(key) {
    try { const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })); return Buffer.from(await r.Body.transformToByteArray()); }
    catch(e) { if (e.$metadata?.httpStatusCode === 404 || e.name === 'NoSuchKey') return null; throw e; }
  }
  async exists(key) {
    try { await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })); return true; }
    catch(e) { if(e.$metadata?.httpStatusCode === 404) return false; throw e; }
  }
}

let singleton = null;
export function getObjectStore() {
  if (singleton) return singleton;
  if (process.env.OBJECT_STORE_MODE === 'preview-postgres') {
    if (process.env.VERCEL_ENV !== 'preview') throw new Error('preview-postgres 仅允许 Vercel Preview 环境');
    singleton = new PreviewPostgresObjectStore();
    return singleton;
  }
  if (process.env.NODE_ENV === 'production' && !process.env.S3_BUCKET && !process.env.OBJECT_STORE_DIR) throw new Error('生产环境需要配置 S3_BUCKET 或持久化 OBJECT_STORE_DIR');
  singleton = process.env.S3_BUCKET
    ? new S3ObjectStore({ endpoint: process.env.S3_ENDPOINT, bucket: process.env.S3_BUCKET, accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY })
    : new LocalObjectStore();
  return singleton;
}
export function resetObjectStoreForTests(store) { singleton = store || new LocalObjectStore(`/tmp/ds2kicad-objects-test-${Date.now()}`); return singleton; }
