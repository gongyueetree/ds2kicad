// test/v083.test.js — v0.8.3 端到端反例（真实 HTTP + 持久化 JobStore）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import JSZip from 'jszip';
import { resetJobStoreForTests, getJobStore } from '../lib/jobstore.js';
import { issueDevSession } from '../lib/auth.js';
import { applyReviewPatch } from '../lib/reviewpatch.js';
import { sanitizePackage, sanitizePinsets, guessFamily } from '../lib/validate.js';
import { generateBundle, generateAll } from '../lib/kicadgen/index.js';
import { assembleAssets } from '../lib/assets.js';
import { safeFileName, safeZipPath, escSexpr } from '../lib/textsafe.js';
import { makeAnchor, SOURCE_TYPE, isDatasheetBacked } from '../lib/evidence.js';
import { routeOcr } from '../lib/ocr/router.js';

const KEY = 'v083-test-secret';
const PORT = 3983;
let srv, store;

const sess = (o) => issueDevSession({ iss: 'https://ezplm.cn', aud: 'ds2kicad', ...o }, KEY);
const post = async (body, token) => {
  const r = await fetch(`http://localhost:${PORT}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  return { status: r.status, data: await r.json() };
};

const pinsetOf = (pins) => sanitizePinsets([{ id: 'default', pins }], [])[0];
const basePins = Array.from({ length: 8 }, (_, i) => ({ number: String(i + 1), name: `P${i + 1}`, type: 'passive' }));
const SOIC = { name: 'SOIC-8', type: 'SOIC', pinCount: 8, pitch: 1.27, bodyLength: 4.9, bodyWidth: 3.9, leadSpan: 6.0, leadLength: 1.0, height: 1.75, pinsetId: 'default' };

function makeIr({ packages, pins = basePins, part = { mpn: 'ACME123' } } = {}) {
  return {
    part,
    packages: (packages || [SOIC]).map((p, i) => ({ ...sanitizePackage(p), packageId: `pkg_${i + 1}`, pinsetId: p.pinsetId || 'default' })),
    pinsets: [pinsetOf(pins)],
    figures: [{ figureId: 'fig_1', kind: 'block_diagram', title: 'Figure 1. Block Diagram', page: 3, bbox: [0.1, 0.1, 0.9, 0.5], confirmed: false }],
    mock: false,
    pdfUrl: 'https://example.com/x.pdf'
  };
}

before(async () => {
  process.env.EZPLM_JWT_SECRET = KEY;
  process.env.EZPLM_JWT_ISS = 'https://ezplm.cn';
  process.env.EZPLM_JWT_AUD = 'ds2kicad';
  process.env.AUTH_MODE = 'production';
  store = resetJobStoreForTests();
  const { default: generateHandler } = await import('../api/generate.js');
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.all('/api/generate', (req, res) => generateHandler(req, res));
  srv = app.listen(PORT);
});
after(() => srv?.close());

test('E2E-1：修改 MPN/管脚/LandPattern 后 Canonical IR、KiCad 与 Part Bundle 完全一致', async () => {
  const job = store.create({ ir: makeIr(), tenantId: 't1', ownerId: 'u-owner', datasheetSha256: 'sha-abc' });
  const token = sess({ sub: 'u-owner', name: '龚工', tenantId: 't1', roles: ['reviewer'] });
  const r = await post({
    jobId: job.jobId,
    patch: {
      schemaVersion: 'ds2kicad.review-patch.v1',
      part: { mpn: { value: 'NEWMPN-9', reason: '对照封面', evidence: { page: 1 } } },
      pinsets: [{ pinsetId: 'default', pins: [{ number: '3', name: { value: 'VREF', reason: '手册 p.5' }, type: { value: 'input', reason: '手册 p.5' } }] }],
      packages: [{ packageId: 'pkg_1', landPattern: { padW: { value: 0.6, reason: '手册 p.63' }, padL: { value: 1.55, reason: '手册 p.63' }, rowSpan: { value: 5.4, reason: '手册 p.63' } } }]
    }
  }, token);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const { reviewedIr, partBundle, files } = { ...r.data, files: r.data.assetFiles };

  // IR 已更新
  assert.equal(reviewedIr.part.mpn, 'NEWMPN-9');
  assert.equal(reviewedIr.pinsets[0].normalizedPins.find((p) => p.number === '3').name, 'VREF');
  assert.equal(reviewedIr.packages[0].landPattern.padW, 0.6);
  // KiCad 文件与 IR 一致
  assert.ok(r.data.files.kicadSym.includes('"NEWMPN-9"'), 'symbol 应使用新 MPN');
  assert.ok(r.data.files.kicadSym.includes('"VREF"'), 'symbol 应使用新管脚名');
  assert.match(r.data.items[0].names.kicadMod, /^NEWMPN-9_/, '封装文件名应使用新 MPN');
  assert.match(r.data.items[0].files.kicadMod, /land pattern per datasheet/);
  // Part Bundle 与 IR 一致
  assert.equal(partBundle.part.mpn, 'NEWMPN-9');
  assert.equal(partBundle.pinsets[0].normalizedPins.find((p) => p.number === '3').name, 'VREF');
  // v0.8.4 item 7：人工录入的 land pattern 保持 reviewer 来源，不得重标 datasheet
  assert.equal(partBundle.packages[0].landPatternSource, 'reviewer_entered');
  // manifest 覆盖全部文件且哈希存在
  assert.ok(files.length >= 4);
  for (const f of files) assert.match(f.sha256, /^[0-9a-f]{64}$/);
  // 变更留痕
  // 逐字段留痕：mpn(1) + 管脚 name/type(2) + landPattern padW/padL/rowSpan(3) = 6
  assert.equal(partBundle.review.changeLog.length, 6, JSON.stringify(partBundle.review.changeLog.map((c) => c.path)));
  assert.ok(partBundle.review.changeLog.every((c) => c.reviewer?.sub === 'u-owner' && c.at));
  // revision 递增
  assert.equal(r.data.revision, 2);
});

test('E2E-2：未知 XYZ-PACKAGE 不生成 footprint', async () => {
  assert.equal(guessFamily('XYZ-PACKAGE'), 'unknown');
  const job = store.create({ ir: makeIr({ packages: [{ ...SOIC, name: 'XYZ-PACKAGE', type: 'XYZ-PACKAGE' }] }), tenantId: 't1', ownerId: 'u-owner' });
  const r = await post({ jobId: job.jobId, patch: {} }, sess({ sub: 'u-owner', tenantId: 't1', roles: ['editor'] }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.items[0].files.kicadMod, undefined, '未知封装不得生成 footprint');
  assert.equal(r.data.items[0].files.wrl, undefined);
  assert.ok(r.data.reasons.includes('unsupported_package_family'));
  assert.equal(r.data.assetPromotion.footprint, false);
});

test('E2E-3：duplicate pin 的 transformationLog 经 extract→job→generate 仍存在', async () => {
  const dupPins = [...basePins, { number: '7', name: 'DUP', type: 'input' }];
  const job = store.create({ ir: makeIr({ pins: dupPins }), tenantId: 't1', ownerId: 'u-owner' });
  // 存储层已有证据
  assert.ok(store.get(job.jobId).job.ir.pinsets[0].transformationLog.some((l) => l.op === 'duplicate_number_dropped'));
  const r = await post({ jobId: job.jobId, patch: {} }, sess({ sub: 'u-owner', tenantId: 't1', roles: ['editor'] }));
  assert.equal(r.status, 200);
  const ps = r.data.partBundle.pinsets[0];
  assert.ok(ps.transformationLog.some((l) => l.op === 'duplicate_number_dropped' && l.number === '7'), JSON.stringify(ps.transformationLog));
  assert.equal(ps.rawPins.length, 9, 'rawPins 必须完整保留');
  assert.equal(ps.reviewRequired, true);
  assert.ok(r.data.reasons.includes('pin_data_transformed_requires_review'));
});

test('E2E-4：同租户其他普通用户重放 jobId 返回 403', async () => {
  const job = store.create({ ir: makeIr(), tenantId: 't1', ownerId: 'u-owner' });
  // 同租户、非本人、仅 editor → 403
  const other = await post({ jobId: job.jobId, patch: {} }, sess({ sub: 'u-other', tenantId: 't1', roles: ['editor'] }));
  assert.equal(other.status, 403, JSON.stringify(other.data));
  assert.equal(other.data.code, 'not_job_owner');
  // 跨租户 → 403 tenant_mismatch
  const cross = await post({ jobId: job.jobId, patch: {} }, sess({ sub: 'u-x', tenantId: 't2', roles: ['reviewer'] }));
  assert.equal(cross.status, 403);
  assert.equal(cross.data.code, 'tenant_mismatch');
  // 本人 → 200；同租户 reviewer → 200
  assert.equal((await post({ jobId: job.jobId, patch: {} }, sess({ sub: 'u-owner', tenantId: 't1', roles: ['editor'] }))).status, 200);
  assert.equal((await post({ jobId: job.jobId, patch: {} }, sess({ sub: 'u-rev', tenantId: 't1', roles: ['reviewer'] }))).status, 200);
  // editor 试图提交修改 patch → 需要 reviewer 权限
  const editorPatch = await post({ jobId: job.jobId, patch: { part: { mpn: 'X2' } } }, sess({ sub: 'u-owner', tenantId: 't1', roles: ['editor'] }));
  assert.equal(editorPatch.status, 403);
  assert.equal(editorPatch.data.code, 'insufficient_role');
});

test('E2E-5：重复封装名称仍可通过稳定 ID 独立修改', async () => {
  const ir = makeIr({ packages: [{ ...SOIC, name: 'SOIC-8' }, { ...SOIC, name: 'SOIC-8' }] });
  const job = store.create({ ir, tenantId: 't1', ownerId: 'u-owner' });
  const token = sess({ sub: 'u-owner', tenantId: 't1', roles: ['reviewer'] });
  const r = await post({
    jobId: job.jobId,
    patch: { packages: [{ packageId: 'pkg_2', bodyLength: { value: 6.2, reason: '核对机械图' } }] }
  }, token);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const [p1, p2] = r.data.reviewedIr.packages;
  assert.equal(p1.bodyLength, 4.9, '第一个同名封装不应被改动');
  assert.equal(p2.bodyLength, 6.2, '第二个同名封装按 ID 精确修改');
  // 名称做主键会被拒绝
  const byName = await post({ jobId: job.jobId, patch: { packages: [{ name: 'SOIC-8', bodyLength: { value: 7, reason: 'x' } }] } }, token);
  assert.equal(byName.status, 400);
  assert.ok(byName.data.errors.some((e) => /packageId/.test(e.error)));
});

test('E2E-6：换行/引号/../ 控制字符不能破坏任何 KiCad / ZIP 文件', async () => {
  const evil = 'EV"IL\n(pad ../../etc/passwd\u0000X';
  const evilPins = [
    { number: '1', name: 'A"\nB', type: 'passive' },
    { number: '2', name: '../../x', type: 'passive' },
    ...basePins.slice(2)
  ];
  const ir = makeIr({ part: { mpn: evil }, packages: [{ ...SOIC, name: evil }], pins: evilPins });
  const job = store.create({ ir, tenantId: 't1', ownerId: 'u-owner' });
  const r = await post({ jobId: job.jobId, patch: {} }, sess({ sub: 'u-owner', tenantId: 't1', roles: ['editor'] }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const mod = r.data.items[0].files.kicadMod;
  const sym = r.data.files.kicadSym;
  // s-expression 括号平衡（未被注入破坏）
  const balance = (t) => { let d = 0, inS = false, esc = false; for (const c of t) { if (inS) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inS = false; continue; } if (c === '"') inS = true; else if (c === '(') d++; else if (c === ')') d--; if (d < 0) return -999; } return d; };
  assert.equal(balance(mod), 0, 'kicad_mod 括号必须平衡');
  assert.equal(balance(sym), 0, 'kicad_sym 括号必须平衡');
  // 文件名无路径穿越
  for (const f of r.data.assetFiles) {
    assert.ok(!f.path.includes('..'), f.path);
    assert.ok(!f.path.startsWith('/'), f.path);
    assert.ok(!/[\u0000-\u001F]/.test(f.path), f.path);
  }
  // legacy lib 每行字段数正确（换行未破坏行结构）
  const xLines = r.data.symbols[0].legacyLib.split('\n').filter((l) => l.startsWith('X '));
  assert.equal(xLines.length, 8);
  for (const l of xLines) assert.equal(l.split(/\s+/).length, 12, l);
  // ZIP 实际打包可解析且路径安全
  const zip = new JSZip();
  for (const f of r.data.assetFiles) zip.file(f.path, 'x');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const back = await JSZip.loadAsync(buf);
  for (const name of Object.keys(back.files)) {
    assert.ok(!name.includes('..') && !name.startsWith('/'), name);
  }
  // 单元级：转义函数本身
  assert.ok(!escSexpr('a"b').includes('"') || escSexpr('a"b') === 'a\\"b');
  assert.equal(safeFileName('../../etc/passwd'), '____etc_passwd');
  assert.equal(safeZipPath('/../../evil.txt'), 'evil.txt');
});

test('E2E-7：generateAll 不得丢失未认证与管脚复核状态', () => {
  const pkg = sanitizePackage({ ...SOIC, landPattern: { padW: 0.6, padL: 1.55, rowSpan: 5.4, sourcePage: 63 } });
  // 完全不提供上下文 → 两项都 fail closed
  const bare = generateAll({ part: { mpn: 'X' }, pkg, pins: basePins });
  assert.ok(bare.reasons.includes('no_authenticated_ezplm_session'));
  assert.ok(bare.reasons.includes('pin_data_transformed_requires_review'));
  // 显式传 false/true → 正确反映
  const withCtx = generateAll({ part: { mpn: 'X' }, pkg, pins: basePins, sessionAuthenticated: true, pinsReviewRequired: false });
  assert.ok(!withCtx.reasons.includes('no_authenticated_ezplm_session'));
  assert.ok(!withCtx.reasons.includes('pin_data_transformed_requires_review'));
  const reviewNeeded = generateAll({ part: { mpn: 'X' }, pkg, pins: basePins, sessionAuthenticated: true, pinsReviewRequired: true });
  assert.ok(reviewNeeded.reasons.includes('pin_data_transformed_requires_review'));
  // 资产级结论也要透传
  assert.ok(withCtx.assetPromotion && typeof withCtx.assetPromotion.symbol === 'boolean');
});

test('E2E-8：全扫描 PDF 实际调用 OCR，且 OCR 文本进入程序解析', async () => {
  const calls = [];
  const worker = {
    available: true,
    async recognize(buf, pages) {
      calls.push(pages);
      return pages.map((p) => ({ page: p, width: 612, height: 792, lines: [{ text: 'Pin Configuration and Functions', x: 60, y: 700, x1: 300, h: 10 }] }));
    }
  };
  // 全扫描：文本层为空，所有页都需 OCR
  const r = await routeOcr(Buffer.from('%PDF-'), { profile: { pagesNeedingOcr: [1, 2, 3] }, textPages: [], worker });
  assert.equal(calls.length, 1, 'OCR Worker 必须被实际调用');
  assert.deepEqual(calls[0], [1, 2, 3]);
  assert.equal(r.status, 'ocr_completed');
  assert.equal(r.mergedPages.length, 3, 'OCR 结果必须进入 mergedPages');
  // OCR 文本能被程序解析器识别（喂进 heuristics 不报错且能取到内容）
  const { selectRelevantPages } = await import('../lib/heuristics.js');
  const rel = selectRelevantPages(r.mergedPages, []);
  assert.ok(rel.includes(1), 'OCR 出的 Pin Configuration 页应被选为相关页');
});

test('E2E-9：无厂商 STEP 时仅 3D 不可晋升，symbol/footprint 可独立晋升', async () => {
  const ir = makeIr({ packages: [{ ...SOIC, landPattern: { padW: 0.6, padL: 1.55, rowSpan: 5.4, sourcePage: 63 } }] });
  const job = store.create({ ir, tenantId: 't1', ownerId: 'u-owner' });
  const r = await post({ jobId: job.jobId, patch: {} }, sess({ sub: 'u-owner', tenantId: 't1', roles: ['reviewer'] }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // v0.8.4 item 6：未确认图区会额外阻断 figures 资产（symbol/footprint 不受影响）
  assert.ok(r.data.reasons.includes('approximate_parametric_3d_not_vendor_step'));
  assert.ok(r.data.reasons.includes('no_confirmed_figures'));
  // v0.8.5 item 5：无字段级证据 → footprint 也被阻断（symbol 仍独立可晋升，item 6 范围划分）
  assert.equal(r.data.assetPromotion.symbol, true, 'symbol 应可独立晋升');
  assert.equal(r.data.assetPromotion.footprint, false, '无证据锚点时 footprint 阻断');
  assert.equal(r.data.assetPromotion.model3d, false, '仅 3D 被阻断');
  assert.equal(r.data.items[0].assetFlags.model3dKind, 'approximate_3d');
});

test('item 10：EvidenceAnchor 不因字段含数字就标记 datasheet', () => {
  const noLocator = makeAnchor({ field: 'pitch', sourceType: SOURCE_TYPE.DATASHEET_DRAWING, extractor: 'x' });
  assert.equal(noLocator.sourceType, SOURCE_TYPE.UNVERIFIED, '缺定位信息必须降级');
  assert.equal(noLocator.downgradedFrom, SOURCE_TYPE.DATASHEET_DRAWING);
  assert.equal(isDatasheetBacked(noLocator), false);
  const good = makeAnchor({ field: 'pitch', sourceType: SOURCE_TYPE.DATASHEET_DRAWING, documentSha256: 'a'.repeat(64), page: 62, bbox: [0, 0, 1, 1], extractor: 'gemini', extractorVersion: '1', confidence: 0.9 });
  assert.equal(good.sourceType, SOURCE_TYPE.DATASHEET_DRAWING);
  assert.equal(isDatasheetBacked(good), true);
  assert.equal(good.confidence, 0.9);
});

test('item 1：JobStore 幂等 / 乐观锁 / 撤销 / 审计', () => {
  const s = resetJobStoreForTests();
  const a = s.create({ ir: makeIr(), tenantId: 't1', ownerId: 'u1', idempotencyKey: 'idem-1' });
  const b = s.create({ ir: makeIr(), tenantId: 't1', ownerId: 'u1', idempotencyKey: 'idem-1' });
  assert.equal(a.jobId, b.jobId, '幂等键必须复用作业');
  assert.match(a.jobId, /^[0-9a-f]{8}-[0-9a-f]{4}-/, 'jobId 必须是不透明 UUID');
  assert.ok(!a.jobId.includes('.'), 'jobId 不得是可解码 token');
  assert.equal(s.update(a.jobId, { ir: {} }, 99).code, 'revision_conflict');
  assert.equal(s.update(a.jobId, { ir: { x: 1 } }, 1, 'u1').job.revision, 2);
  s.revoke(a.jobId, 'u1');
  assert.equal(s.get(a.jobId).code, 'job_revoked');
  const audit = s.listAudit(a.jobId).map((x) => x.action);
  assert.deepEqual(audit, ['job_created', 'job_updated', 'job_revoked']);
  // 恢复给后续测试
  store = resetJobStoreForTests();
});

test('item 3：Patch 非法字段报错而非静默忽略', () => {
  const ir = makeIr();
  const reviewer = { sub: 'u1', name: 'A' };
  const bad = applyReviewPatch(ir, { unknownTop: 1, part: { evilField: 'x' } }, { reviewer });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.path === 'unknownTop'));
  assert.ok(bad.errors.some((e) => e.path === 'part.evilField'));
  // 控制字符 MPN 被拒
  const ctrl = applyReviewPatch(ir, { part: { mpn: 'A\nB' } }, { reviewer });
  assert.equal(ctrl.ok, false);
  assert.ok(ctrl.errors.some((e) => /控制字符/.test(e.error)));
  // 非法管脚类型被拒
  const badType = applyReviewPatch(ir, { pinsets: [{ pinsetId: 'default', pins: [{ number: '1', type: 'nonsense' }] }] }, { reviewer });
  assert.equal(badType.ok, false);
  // 无审核者身份被拒
  assert.equal(applyReviewPatch(ir, { part: { mpn: 'X' } }, {}).ok, false);
});
