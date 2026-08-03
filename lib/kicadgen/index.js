// lib/kicadgen/index.js — 生成编排：一次输入（确认后的数据）→ 全套文件文本
import { generateKicadSym, generateLegacyLib, kicadSymBlock, generateKicadSymLib } from './symbol.js';
import { generateFootprint, footprintName } from './footprint.js';
import { generateWrl } from './model3d.js';
import { sanitizePins, sanitizePackage } from '../validate.js';
import { normalizeGeometryDetailed } from './geometry.js';
import { evaluateItem, evaluateBundle, BLOCK } from '../promotion.js';

/** 参数化引擎不支持的封装家族：绝不近似生成可发布产物 */
// item 6：不受支持家族的唯一来源是 validate.js 的 allowlist 判定结果，
// 这里不再各自维护列表（否则新增家族时会漏判并近似生成）
import { UNSUPPORTED_FAMILY_NOTES, SUPPORTED_FAMILIES } from '../validate.js';
const unsupportedNoteFor = (pkg) =>
  (pkg.familySupported === false || !SUPPORTED_FAMILIES.includes(pkg.family))
    ? (UNSUPPORTED_FAMILY_NOTES[pkg.family] || `不受支持的封装家族 ${pkg.family}`)
    : null;

/** 符号变体命名：默认符号用 MPN，其余 MPN_<封装代号> */
function symbolVariantName(mpn, pkg, isFirst) {
  if (isFirst) return mpn;
  const tag = String(pkg.tiCode || pkg.type || pkg.name || 'ALT').replace(/\W+/g, '').toUpperCase() || 'ALT';
  return `${mpn}_${tag}`;
}

/**
 * 多封装批量生成。
 * @param {object} input { part, items: [{ pkg, pins }] }
 * @returns {object} {
 *   files: { kicadSym },                             // 单一库文件，含全部符号变体
 *   names: { kicadSym },
 *   symbols: [{ name, legacyLib, packages: [pkgName] }],
 *   items: [{ pkgName, fpName, symbolName, family, files: { kicadMod?, wrl? }, names, warnings }],
 *   warnings
 * }
 */
export function generateBundle(input) {
  const part = input?.part || {};
  const mpn = String(part.mpn || 'PART').trim() || 'PART';
  const rawItems = Array.isArray(input?.items) ? input.items : [];
  if (!rawItems.length) throw new Error('items 为空，无法生成');
  const warnings = [];

  // 1) 按 pinset 指纹分组 → 符号去重
  const groups = new Map(); // fingerprint → { pins, symbolName, legacyLib, block, packages: [] }
  const items = [];
  for (const it of rawItems) {
    const pins = sanitizePins(it?.pins);
    const pkg = sanitizePackage(it?.pkg);
    if (!pins.length) throw new Error(`封装 ${pkg.name} 的管脚列表为空`);
    const fp = pins.map((p) => `${p.number}|${p.name}|${p.type}`).join(';');
    if (!groups.has(fp)) {
      const symbolName = symbolVariantName(mpn, pkg, groups.size === 0);
      groups.set(fp, {
        pins, symbolName, packages: [], packageIds: [], pinsetIds: [],
        block: null, legacyLib: null, fpNameOfFirst: null
      });
    }
    const grp = groups.get(fp);
    grp.packages.push(pkg.name);
    if (pkg.packageId) grp.packageIds.push(pkg.packageId);
    if (pkg.pinsetId && !grp.pinsetIds.includes(pkg.pinsetId)) grp.pinsetIds.push(pkg.pinsetId);
    items.push({ pkg, pins, group: groups.get(fp) });
  }

  // 2) 每封装生成封装 + 3D（bga 家族暂只出符号；关键几何缺失过多 → blocked）
  const outItems = items.map(({ pkg, pins, group }) => {
    const itemWarnings = [];
    const missing = pkg.missingFields || [];
    const unsupportedNote = unsupportedNoteFor(pkg);
    // 关键几何缺失（pitch + 任一本体维度）→ 阻断生成
    let blocked = missing.includes('pitch') && (missing.includes('bodyLength') || missing.includes('bodyWidth'));
    if (blocked) {
      itemWarnings.push(`blocked_missing_geometry：数据手册未提供 ${missing.join('/')}，已阻断封装/3D 生成；请在 ③ 手工补齐后重新生成`);
    }
    let single = null;
    if (!blocked && !unsupportedNote) {
      single = safeSingle({ part, pkg, pins }, itemWarnings);
      if (!single) blocked = true; // safeSingle 内部拒绝（如 QFN 非 4 倍数）
    }
    if (unsupportedNote) itemWarnings.push(`unsupported_package：${unsupportedNote}，仅输出符号变体`);
    const fpName = single ? single.fpName : null;
    if (!group.fpNameOfFirst && fpName) group.fpNameOfFirst = fpName;
    const files = single ? { kicadMod: single.kicadMod, wrl: single.wrl } : {};
    // item 6：无手册 land pattern → 焊盘为规则推导；WRL 恒为参数化近似，不得冒充厂商 STEP
    const landPatternSource = single?.landPatternSource || pkg.landPatternSource || 'derived_by_rules';
    const assetFlags = {
      footprintPadSource: landPatternSource,                       // datasheet | derived_by_rules
      model3dKind: single ? 'approximate_3d' : null,               // 参数化 WRL，非厂商 STEP
      model3dAuthoritative: false
    };
    const promotion = evaluateItem({
      mock: !!input.mock,
      pkg, pins, warnings: itemWarnings, files,
      family: pkg.family,
      blocked,
      unsupportedFamily: !!unsupportedNote,
      unsupportedNote,
      confirmedFigureCount: input.confirmedFigureCount,
      figures: input.figures,
      transformations: single?.transformations || [],
      landPatternSource,
      landPatternReviewer: Object.entries(pkg.fieldProvenance || {}).find(([k, v]) => k.startsWith('landPattern.') && v.source === 'reviewer')?.[1]?.reviewer || null,
      hasModel3d: !!single,
      pinsReviewRequired: input.pinsReviewRequired,
      validationErrors: pkg.validationErrors,
      familySupported: pkg.familySupported,
      sessionAuthenticated: input.sessionAuthenticated
    });
    return {
      packageId: pkg.packageId || null,     // item 13
      pkgName: pkg.name,
      family: pkg.family,
      symbolName: group.symbolName,
      fpName,
      blocked,
      missingFields: missing,
      transformations: single?.transformations || [],
      assetFlags,
      promotion,
      placeholder: promotion.nonPromotable,
      files,
      names: fpName ? { kicadMod: `${fpName}.kicad_mod`, wrl: `${fpName}.wrl` } : {},
      warnings: itemWarnings
    };
  });

  // 3) 符号块（Footprint 属性指向该 pinset 第一个可用封装）+ 合并库
  const blocks = [];
  const symbols = [];
  for (const g of groups.values()) {
    blocks.push(kicadSymBlock({
      name: g.symbolName,
      footprintName: g.fpNameOfFirst || mpn,
      pins: g.pins,
      description: part.title || part.description_zh || ''
    }));
    symbols.push({
      name: g.symbolName,
      legacyLib: generateLegacyLib({ mpn: g.symbolName, pins: g.pins }),
      packages: g.packages,
      packageIds: g.packageIds,          // item 13：ID 关联
      pinsetIds: g.pinsetIds,
      pins: g.pins
    });
  }

  for (const it of outItems) warnings.push(...it.warnings.map((w) => `[${it.pkgName}] ${w}`));
  return {
    files: { kicadSym: generateKicadSymLib(blocks) },
    names: { kicadSym: `${mpn}.kicad_sym` },
    symbols,
    items: outItems,
    mock: !!input.mock,
    ...evaluateBundle({ items: outItems, mock: !!input.mock, confirmedFigureCount: input.confirmedFigureCount, assetKeys: input.assetKeys || [] }), // 唯一晋升闸门
    warnings
  };
}

/** 单封装生成（内部）：bga 跳过，QFN 非 4 倍数等告警透传 */
function safeSingle({ part, pkg, pins }, warnings) {
  const note = unsupportedNoteFor(pkg);
  if (note) {
    warnings.push(`unsupported_package：${note}，仅输出符号变体`);
    return null;
  }
  const physical = pins.length;
  if (physical !== pkg.pinCount && physical !== pkg.pinCount + 1) {
    warnings.push(`管脚表共 ${physical} 项，与封装引脚数 ${pkg.pinCount}（+EP）不一致，请核对`);
  }
  const p = { ...pkg };
  if (p.family === 'qfn' && p.pinCount % 4 !== 0) {
    // 不再以 dual 近似冒充：四边封装引脚不能被 4 整除时，几何无法确定性还原
    warnings.push(`blocked_missing_geometry：QFN/DFN 引脚数 ${p.pinCount} 非 4 的倍数，无法确定性还原四边排布，已阻断封装/3D 生成`);
    return null;
  }
  const mpn = String(part.mpn || 'PART').trim() || 'PART';
  // item 1：若上游（Canonical Pipeline）已完成几何归一化，生成器**不得再次修改几何数值**，
  // 直接使用 Final IR 中的数值；仅在旧调用路径（未预归一化）时才就地归一化。
  let g, transformations, geoWarn;
  if (p.geometryNormalized) {
    g = p; transformations = p.geometryTransformations || []; geoWarn = [];
  } else {
    ({ normalizedPackage: g, transformations, warnings: geoWarn } = normalizeGeometryDetailed(p));
  }
  warnings.push(...geoWarn);
  // 名称唯一计算点：normalized IR 之后
  const fpName = footprintName(mpn, g);
  const kicadMod = generateFootprint({ mpn, pkg: g, footprintNameOverride: fpName });
  const wrl = generateWrl({ pkg: g });
  // 交叉校验（失败即抛错，不允许产出名称不一致的资产）
  const declared = /\(footprint "([^"]+)"/.exec(kicadMod)?.[1];
  if (declared !== fpName) throw new Error(`footprint 内部名 ${declared} 与文件名 ${fpName} 不一致`);
  const modelRef = /\(model "[^"]*?([^/"]+)\.wrl"/.exec(kicadMod)?.[1];
  if (modelRef !== fpName) throw new Error(`model 引用 ${modelRef}.wrl 与实际 WRL 文件名 ${fpName}.wrl 不一致`);
  return { kicadMod, wrl, fpName, transformations, landPatternSource: g.landPatternSource || p.landPatternSource || 'derived_by_rules' };
}

/**
 * @param {object} input  { part:{mpn,manufacturer,title,description_zh}, pkg, pins }
 * @returns {object} { files: {kicadSym, legacyLib, kicadMod, wrl}, names, warnings }
 */
/** 兼容旧单封装形状 { part, pkg, pins }：内部转换为 generateBundle，
 *  确保旧调用同样经过唯一 PromotionGate（不存在绕过闸门的旁路）。 */
export function generateAll(input) {
  // item 8：完整传递闸门上下文；未提供的身份/复核状态由 PromotionGate fail closed
  const b = generateBundle({
    part: input?.part,
    mock: input?.mock,
    pinsReviewRequired: input?.pinsReviewRequired,
    sessionAuthenticated: input?.sessionAuthenticated,
    evidence: input?.evidence,
    items: [{ pkg: input?.pkg, pins: input?.pins }]
  });
  const it = b.items[0];
  const sym = b.symbols[0];
  return {
    files: {
      kicadSym: b.files.kicadSym,
      legacyLib: sym?.legacyLib || '',
      ...(it.files.kicadMod ? { kicadMod: it.files.kicadMod } : {}),
      ...(it.files.wrl ? { wrl: it.files.wrl } : {})
    },
    names: {
      kicadSym: b.names.kicadSym,
      ...(it.names.kicadMod ? { kicadMod: it.names.kicadMod, wrl: it.names.wrl } : {})
    },
    items: b.items,
    symbols: b.symbols,
    mock: b.mock,
    nonPromotable: b.nonPromotable,
    reasons: b.reasons,
    assetPromotion: b.assetPromotion,
    assetBlockReasons: b.assetBlockReasons,
    warnings: b.warnings
  };
}
