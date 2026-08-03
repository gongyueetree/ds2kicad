// api/figure-upload.js — v0.8.6 item 6：真实 Figure 文件链。
// 浏览器裁剪 PNG → POST 本接口 → 服务端校验 PNG 魔数/尺寸/大小 → 存入对象存储（或 IR 内联）
// → 写回 IR 的 imagePath/imageSha256 → Part Bundle / Manifest / ZIP / postMessage 引用同一文件。
import { createHash } from 'node:crypto';
import { setCors } from './extract.js';
import { getJobStore } from '../lib/jobstore.js';
import { authenticate, authorizeJobAccess } from '../lib/auth.js';
import { safeFileName } from '../lib/textsafe.js';
import { decodePngStrict } from '../lib/png.js';
import { getObjectStore, objectKey } from '../lib/objectstore.js';
import { invalidateAffectedApprovals } from '../lib/lifecycle.js';

/** item 7：完整 PNG 解码校验（chunk/CRC/IDAT 解压/像素长度），拒绝只有头的伪文件 */
export function validatePng(buf) {
  return decodePngStrict(buf, { maxBytes: 4 * 1024 * 1024 });
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
  // item 7：upload 强制 expectedRevision
  if (expectedRevision === undefined) {
    return res.status(400).json({ error: '必须携带 expectedRevision', code: 'expected_revision_required' });
  }
  if (expectedRevision !== job.revision) {
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

  // item 8：PNG **不入 IR** —— 存对象存储，IR 只留不可变对象键 + 元数据
  const oStore = getObjectStore();
  const key = objectKey({ tenantId: job.tenantId, jobId, kind: 'figure', sha256: sha, ext: 'png' });
  const put = await oStore.put(key, buf, { contentType: 'image/png' });

  let nextIr = structuredClone(job.ir);
  const target = nextIr.figures.find((f) => f.figureId === figureId);
  delete target.imageBase64;                       // 清除历史内联数据
  target.image = {
    objectKey: put.key, sha256: sha, bytes: buf.length,
    width: v.width, height: v.height, contentType: 'image/png',
    // item 7：图片必须绑定文档与裁剪区域
    documentSha256: body.documentSha256 || job.ir.documentSha256 || null,
    page: Number.isInteger(body.page) ? body.page : target.page ?? null,
    bbox: Array.isArray(body.bbox) ? body.bbox.map(Number) : target.bbox ?? null,
    uploadedBy: { sub: session.sub, at: new Date().toISOString() }
  };
  target.imagePath = imagePath;
  target.imageSha256 = sha;

  // item 7：使该 Figure 的旧批准/发布失效
  const inv = invalidateAffectedApprovals(nextIr, [{ path: `figures[${figureId}].image` }]);
  nextIr = inv.ir;

  const commit = await store.commitGeneration(jobId, {
    ir: nextIr, expectedRevision: job.revision, actor: session.sub,
    auditEntries: [{ action: 'figure_image_uploaded', detail: { figureId, objectKey: put.key, sha256: sha, bytes: buf.length, size: `${v.width}x${v.height}`, invalidated: inv.invalidated } }]
  });
  if (!commit.ok) return res.status(409).json({ error: commit.error, code: commit.code });

  return res.status(200).json({
    jobId, figureId, imagePath, imageSha256: sha, objectKey: put.key,
    bytes: buf.length, width: v.width, height: v.height,
    revision: commit.job.revision, invalidatedApprovals: inv.invalidated
  });
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
