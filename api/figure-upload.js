// api/figure-upload.js — v0.8.6 item 6：真实 Figure 文件链。
// 浏览器裁剪 PNG → POST 本接口 → 服务端校验 PNG 魔数/尺寸/大小 → 存入对象存储（或 IR 内联）
// → 写回 IR 的 imagePath/imageSha256 → Part Bundle / Manifest / ZIP / postMessage 引用同一文件。
import { createHash } from 'node:crypto';
import { setCors } from './extract.js';
import { getJobStore } from '../lib/jobstore.js';
import { authenticate, authorizeJobAccess } from '../lib/auth.js';
import { safeFileName } from '../lib/textsafe.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_BYTES = 4 * 1024 * 1024;

/** 校验 PNG：魔数 + IHDR 尺寸解析（拒绝伪装成 PNG 的其他内容） */
export function validatePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return { ok: false, error: '数据过短' };
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return { ok: false, error: '不是 PNG（魔数不匹配）' };
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') return { ok: false, error: 'PNG 缺少 IHDR' };
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  if (!width || !height || width > 20000 || height > 20000) return { ok: false, error: `PNG 尺寸非法 ${width}x${height}` };
  if (buf.length > MAX_BYTES) return { ok: false, error: `PNG 超过 ${MAX_BYTES / 1048576}MB` };
  return { ok: true, width, height };
}

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: '仅支持 POST' });

  const auth = authenticate(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const session = auth.session;

  const body = req.body && typeof req.body === 'object' ? req.body : safeParse(req.body);
  if (!body) return res.status(422).json({ error: '请求体不是合法 JSON' });
  const { jobId, figureId, pngBase64, expectedRevision } = body;
  if (!jobId || !figureId || typeof pngBase64 !== 'string') {
    return res.status(400).json({ error: '需要 jobId / figureId / pngBase64', code: 'bad_request' });
  }

  const store = await getJobStore();
  const got = await store.get(jobId);
  if (!got.ok) return res.status(400).json({ error: got.error, code: got.code });
  const job = got.job;
  const az = authorizeJobAccess(session, job, { requireRole: 'reviewer' });
  if (!az.ok) return res.status(az.status).json({ error: az.error, code: az.code });
  if (expectedRevision !== undefined && expectedRevision !== job.revision) {
    return res.status(409).json({ error: `版本冲突：当前 ${job.revision}`, code: 'revision_conflict', currentRevision: job.revision });
  }

  let buf;
  try { buf = Buffer.from(pngBase64, 'base64'); } catch { return res.status(400).json({ error: 'base64 非法' }); }
  const v = validatePng(buf);
  if (!v.ok) return res.status(422).json({ error: `PNG 校验失败：${v.error}`, code: 'invalid_png' });

  const fig = (job.ir.figures || []).find((f) => f.figureId === figureId);
  if (!fig) return res.status(400).json({ error: `未知 figureId=${figureId}`, code: 'unknown_figure' });

  const sha = createHash('sha256').update(buf).digest('hex');
  const imagePath = `figures/${safeFileName(`${figureId}.png`)}`;
  const nextIr = structuredClone(job.ir);
  const target = nextIr.figures.find((f) => f.figureId === figureId);
  target.imageBase64 = buf.toString('base64');   // 无对象存储时内联；有 OBJECT_STORE_URL 时改为上传后存 URL
  target.imagePath = imagePath;
  target.imageSha256 = sha;
  target.imageWidth = v.width;
  target.imageHeight = v.height;
  target.imageUploadedBy = { sub: session.sub, at: new Date().toISOString() };

  const commit = await store.commitGeneration(jobId, {
    ir: nextIr, expectedRevision: job.revision, actor: session.sub,
    auditEntries: [{ action: 'figure_image_uploaded', detail: { figureId, imagePath, sha256: sha, bytes: buf.length, size: `${v.width}x${v.height}` } }]
  });
  if (!commit.ok) return res.status(409).json({ error: commit.error, code: commit.code });

  return res.status(200).json({ jobId, figureId, imagePath, imageSha256: sha, bytes: buf.length, width: v.width, height: v.height, revision: commit.job.revision });
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
