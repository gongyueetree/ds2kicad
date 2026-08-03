// lib/jobstore.js — v0.8.2 item 1：服务端权威作业存储。
// extract 产出 Canonical IR 并以 HMAC 密封为 jobId（无状态部署下等价于服务端持久化：
// 内容由服务端签名，客户端无法伪造/篡改 mock、provenance、原始证据）。
// generate 只接受 jobId + 审核 Patch，所有权威字段从密封载荷恢复，不信任客户端提交。
// 迁入 ezPLM 后台后应替换为 数据库/对象存储 + jobId 主键（本模块接口保持不变）。
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const TTL_MS = 60 * 60 * 1000; // 1 小时

function secret() {
  const s = process.env.JOB_SECRET || process.env.PDF_TOKEN_SECRET;
  if (!s) throw new Error('JOB_SECRET 未配置：无法签发作业令牌');
  return s;
}

const mac = (payload) => createHmac('sha256', secret()).update(payload).digest('base64url');

/**
 * 密封 Canonical IR → jobId。
 * @param {object} ir  服务端权威内容（part/packages/pinsets/figures/mock/sources/tenantId…）
 */
export function sealJob(ir) {
  const body = {
    jobId: randomUUID(),
    createdAt: Date.now(),
    exp: Date.now() + TTL_MS,
    ir
  };
  const packed = gzipSync(Buffer.from(JSON.stringify(body), 'utf8')).toString('base64url');
  return { jobId: `${packed}.${mac(packed)}`, id: body.jobId };
}

/** 打开 jobId → Canonical IR；签名/过期/结构任一不符即失败 */
export function openJob(jobId) {
  if (typeof jobId !== 'string' || !jobId) return { ok: false, error: '缺少 jobId' };
  const idx = jobId.lastIndexOf('.');
  if (idx < 1) return { ok: false, error: 'jobId 格式非法' };
  const packed = jobId.slice(0, idx);
  const sig = jobId.slice(idx + 1);
  const expect = Buffer.from(mac(packed));
  const got = Buffer.from(sig);
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) return { ok: false, error: 'jobId 签名不匹配（内容被篡改或密钥不符）' };
  let body;
  try {
    body = JSON.parse(gunzipSync(Buffer.from(packed, 'base64url')).toString('utf8'));
  } catch {
    return { ok: false, error: 'jobId 载荷损坏' };
  }
  if (!body?.exp || Date.now() > body.exp) return { ok: false, error: 'jobId 已过期，请重新提取' };
  return { ok: true, job: body };
}
