// lib/objectstore.js — v0.8.7 item 8：对象存储抽象。
// PNG 等二进制资产**不再存进 Job IR**，只在 IR 中保留不可变对象键 + SHA256 + 尺寸 + 媒体类型。
// 默认适配器：本地文件（LocalObjectStore，可真实测试）；生产用 S3/Vercel Blob 适配器（同接口）。
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

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
    const p = join(this.root, key);
    mkdirSync(dirname(p), { recursive: true });
    if (!existsSync(p)) writeFileSync(p, buf);          // 不可变：已存在则不覆盖
    return { key, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length, contentType };
  }
  async get(key) {
    const p = join(this.root, key);
    if (!existsSync(p)) return null;
    return readFileSync(p);
  }
  async exists(key) { return existsSync(join(this.root, key)); }
}

/** S3 兼容适配器骨架（接口一致；真实 S3 连接 NOT VERIFIED） */
export class S3ObjectStore {
  constructor({ endpoint, bucket, accessKeyId, secretAccessKey } = {}) {
    this.kind = 's3';
    this.cfg = { endpoint, bucket, accessKeyId, secretAccessKey };
    if (!bucket) throw new Error('S3ObjectStore 需要 bucket');
  }
  async put() { throw new Error('S3ObjectStore 未实现：请安装并接入 @aws-sdk/client-s3'); }
  async get() { throw new Error('S3ObjectStore 未实现'); }
  async exists() { return false; }
}

let singleton = null;
export function getObjectStore() {
  if (singleton) return singleton;
  singleton = process.env.S3_BUCKET
    ? new S3ObjectStore({ endpoint: process.env.S3_ENDPOINT, bucket: process.env.S3_BUCKET, accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY })
    : new LocalObjectStore();
  return singleton;
}
export function resetObjectStoreForTests(store) { singleton = store || new LocalObjectStore(`/tmp/ds2kicad-objects-test-${Date.now()}`); return singleton; }
