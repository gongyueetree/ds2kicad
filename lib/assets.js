// lib/assets.js — v0.8.3 item 4：服务端从 Reviewed Canonical IR 组装全部产物。
// 前端不得再用本地 confirmed 状态拼装正式 Part Bundle：part-bundle.json、文件哈希与
// manifest 全部由服务端基于同一份 reviewed IR 生成，保证 IR / KiCad / Bundle 三者一致。
import { createHash } from 'node:crypto';
import { safeFileName, safeZipPath } from './textsafe.js';

export const BUNDLE_SCHEMA = 'ds2kicad.part-bundle.v3';
export const MANIFEST_SCHEMA = 'ds2kicad.asset-manifest.v1';

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * @param {object} p { ir, bundle（generateBundle 结果）, job, reviewer }
 * @returns {{ partBundle, manifest, files: Array<{path, content, sha256, bytes}> }}
 */
export function assembleAssets({ ir, bundle, job, reviewer }) {
  const files = [];
  const push = (path, content) => {
    const safe = safeZipPath(path, { fallback: 'asset' });
    files.push({ path: safe, content, sha256: sha(content), bytes: Buffer.byteLength(content, 'utf8') });
    return safe;
  };

  const symLibPath = push(safeFileName(bundle.names.kicadSym), bundle.files.kicadSym);
  const symbolFiles = bundle.symbols.map((s) => ({
    name: s.name,
    packages: s.packages,
    legacyPath: push(`${safeFileName(s.name)}.lib`, s.legacyLib)
  }));

  const itemFiles = bundle.items.map((it) => {
    const entry = { packageName: it.pkgName, symbolName: it.symbolName, family: it.family, assetFlags: it.assetFlags, promotion: it.promotion };
    if (it.files.kicadMod) entry.footprintPath = push(safeFileName(it.names.kicadMod), it.files.kicadMod);
    if (it.files.wrl) entry.modelPath = push(safeFileName(it.names.wrl), it.files.wrl);
    return entry;
  });

  const partBundle = {
    schema: BUNDLE_SCHEMA,
    generatedAt: new Date().toISOString(),
    job: { jobId: job?.jobId || null, revision: job?.revision ?? null, tenantId: job?.tenantId || null, datasheetSha256: job?.datasheetSha256 || null },
    source: { datasheetUrl: ir.pdfUrl || null, documentSha256: job?.datasheetSha256 || null },
    part: ir.part,
    // item 8：完整 normalized package（含全部几何、landPattern、provenance、证据）
    packages: (ir.packages || []).map((p) => ({
      packageId: p.packageId, name: p.name, type: p.type, family: p.family,
      familySupported: p.familySupported, familyProvenance: p.familyProvenance, pinsetId: p.pinsetId,
      pinCount: p.pinCount, pitch: p.pitch, bodyLength: p.bodyLength, bodyWidth: p.bodyWidth,
      height: p.height, leadSpan: p.leadSpan, leadLength: p.leadLength, leadWidth: p.leadWidth,
      epLength: p.epLength, epWidth: p.epWidth, rowSpan: p.rowSpan,
      landPattern: p.landPattern ?? null,
      landPatternSource: p.landPatternSource, landPatternReviewed: !!p.landPatternReviewed,
      drawingId: p.drawingId, orderableParts: p.orderableParts, sourcePages: p.sourcePages,
      relevantFields: p.relevantFields, missingFields: p.missingFields,
      validationErrors: p.validationErrors || [],
      fieldProvenance: p.fieldProvenance, evidence: p.evidence || null
    })),
    pinsets: (ir.pinsets || []).map((s) => ({
      id: s.id, label: s.label,
      normalizedPins: s.normalizedPins || s.pins,
      rawPins: s.rawPins,
      deletedPinIds: s.deletedPinIds || [],
      transformationLog: s.transformationLog,
      transformationsResolved: !!s.transformationsResolved,
      transformationResolution: s.transformationResolution || null,
      reviewRequired: s.reviewRequired
    })),
    // item 4：图区以 reviewed IR 的 confirmed 为准，不看前端本地状态
    figures: (ir.figures || []).filter((f) => f.confirmed).map((f) => ({
      figureId: f.figureId, kind: f.kind, title: f.title, page: f.page, bbox: f.bbox,
      confirmed: true, evidence: f.evidence || null, fieldEvidence: f.fieldEvidence || null,
      imagePath: f.imagePath || null, imageSha256: f.imageSha256 || null
    })),
    symbols: symbolFiles,
    items: itemFiles,
    // item 8：reviewer 只能来自持久化审核记录（lifecycle.reviewedBy），不接受调用方传入的角色信息
    review: {
      reviewedBy: ir.lifecycle?.reviewedBy || null,
      changeLog: ir.reviewChangeLog || [],
      approvals: ir.lifecycle?.approvals || {},
      published: ir.lifecycle?.published || {},
      state: ir.lifecycle?.state || 'extracted',
      history: ir.lifecycle?.history || []
    },
    mock: !!ir.mock,
    nonPromotable: !!bundle.nonPromotable,
    promotionBlockReasons: bundle.reasons || [],
    assetPromotion: bundle.assetPromotion || null,
    assetBlockReasons: bundle.assetBlockReasons || null,
    warnings: bundle.warnings || []
  };

  // item 9：图区 PNG（由服务端在 IR 中保存 base64）写入文件清单并计入 manifest 哈希
  for (const f of ir.figures || []) {
    if (!f.confirmed || !f.imageBase64) continue;
    const p = safeZipPath(`figures/${safeFileName(`${f.figureId}.png`)}`, { fallback: 'figure.png' });
    const buf = Buffer.from(f.imageBase64, 'base64');
    files.push({ path: p, content: f.imageBase64, encoding: 'base64', sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length });
    const target = partBundle.figures.find((x) => x.figureId === f.figureId);
    if (target) { target.imagePath = p; target.imageSha256 = files[files.length - 1].sha256; }
  }

  const bundleJson = JSON.stringify(partBundle, null, 2);
  const bundlePath = push('part-bundle.json', bundleJson);

  const manifest = {
    schema: MANIFEST_SCHEMA,
    generatedAt: partBundle.generatedAt,
    jobId: job?.jobId || null,
    revision: job?.revision ?? null,
    irSha256: sha(JSON.stringify(ir)),
    partBundleSha256: sha(bundleJson),
    nonPromotable: partBundle.nonPromotable,
    assetPromotion: partBundle.assetPromotion,
    files: files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes }))
  };
  const manifestJson = JSON.stringify(manifest, null, 2);
  files.push({ path: 'manifest.json', content: manifestJson, sha256: sha(manifestJson), bytes: Buffer.byteLength(manifestJson) });

  return { partBundle, manifest, files, paths: { symLibPath, bundlePath } };
}
