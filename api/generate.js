// api/generate.js — v0.8.2 item 1：只接受 { jobId, patch }。
// 权威数据（part/packages/pinsets/mock/provenance/证据）一律从服务端密封的 jobId 恢复，
// 客户端不能提交 part/items/mock/provenance —— 提交了也不会被采纳（显式报错）。
// patch 仅允许对已知封装的白名单几何字段做人工修改，且署名来自已认证会话（非客户端字符串）。
import { generateBundle } from '../lib/kicadgen/index.js';
import { setCors } from './extract.js';
import { openJob } from '../lib/jobstore.js';
import { authenticate } from '../lib/auth.js';
import { sanitizePackage, applyReviewerEdit, sanitizePinsDetailed } from '../lib/validate.js';

const PATCHABLE = new Set([
  'pinCount', 'pitch', 'bodyLength', 'bodyWidth', 'height',
  'leadSpan', 'leadLength', 'leadWidth', 'epLength', 'epWidth', 'rowSpan'
]);
const FORBIDDEN_CLIENT_FIELDS = ['part', 'items', 'pins', 'pinsets', 'packages', 'mock', 'provenance', 'fieldProvenance', 'nonPromotable', 'reviewer'];

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: '仅支持 POST' });

  const auth = authenticate(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const session = auth.session;

  const body = req.body && typeof req.body === 'object' ? req.body : safeParse(req.body);
  if (!body) return res.status(422).json({ error: '请求体不是合法 JSON' });

  // item 1：显式拒绝客户端提交权威数据（防止悄悄回到 v0.8.1 的可伪造模型）
  const offending = FORBIDDEN_CLIENT_FIELDS.filter((k) => body[k] !== undefined);
  if (offending.length) {
    return res.status(400).json({
      error: `不接受客户端提交的权威字段：${offending.join(', ')}。请只提交 { jobId, patch }，权威数据由服务端从 jobId 恢复`,
      code: 'client_authoritative_fields_rejected'
    });
  }

  const opened = openJob(body.jobId);
  if (!opened.ok) return res.status(400).json({ error: opened.error, code: 'invalid_job' });
  const ir = opened.job.ir;

  // 租户隔离：作业必须属于当前会话租户
  if (ir.tenantId && session.authenticated && ir.tenantId !== session.tenantId) {
    return res.status(403).json({ error: '作业不属于当前租户', code: 'tenant_mismatch' });
  }

  try {
    const patch = body.patch && typeof body.patch === 'object' ? body.patch : {};
    const selected = Array.isArray(patch.includePackages) && patch.includePackages.length
      ? patch.includePackages.map(String) : null;
    const edits = patch.packageEdits && typeof patch.packageEdits === 'object' ? patch.packageEdits : {};

    const pinsetMap = Object.fromEntries((ir.pinsets || []).map((s2) => [s2.id, s2.pins]));
    let anyPinsReview = !!ir.pinsReviewRequired;

    const items = [];
    for (const rawPkg of ir.packages || []) {
      if (selected && !selected.includes(rawPkg.name)) continue;
      let pkg = sanitizePackage(rawPkg);   // family 由服务端重新判定，忽略任何客户端值
      const fieldEdits = edits[rawPkg.name] || {};
      for (const [k, v] of Object.entries(fieldEdits)) {
        if (!PATCHABLE.has(k)) continue;                       // 非白名单字段忽略
        // item 2：reviewer 来自已认证会话，不接受客户端字符串
        pkg = applyReviewerEdit(pkg, k, Number(v), session.authenticated ? `${session.name} <${session.sub}>` : '', 'review_patch');
      }
      const det = sanitizePinsDetailed(pinsetMap[pkg.pinsetId] || pinsetMap[Object.keys(pinsetMap)[0]] || []);
      if (det.reviewRequired) anyPinsReview = true;
      items.push({ pkg, pins: det.pins });
    }
    if (!items.length) return res.status(422).json({ error: '没有可生成的封装（检查 patch.includePackages）' });

    const result = generateBundle({
      part: ir.part,
      mock: !!ir.mock,                              // mock 由服务端恢复，客户端无法抹掉
      pinsReviewRequired: anyPinsReview,
      sessionAuthenticated: session.authenticated,
      items
    });
    if (typeof result.nonPromotable !== 'boolean') { result.nonPromotable = true; result.reasons = ['gate_missing']; }
    result.reviewer = session.authenticated ? { sub: session.sub, name: session.name, tenantId: session.tenantId } : null;
    return res.status(200).json(result);
  } catch (e) {
    return res.status(422).json({ error: `生成失败: ${e.message}` });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
