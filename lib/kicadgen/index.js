// lib/kicadgen/index.js — 生成编排：一次输入（确认后的数据）→ 全套文件文本
import { generateKicadSym, generateLegacyLib, kicadSymBlock, generateKicadSymLib } from './symbol.js';
import { generateFootprint, footprintName } from './footprint.js';
import { generateWrl } from './model3d.js';
import { sanitizePins, sanitizePackage } from '../validate.js';

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
        pins, symbolName, packages: [],
        block: null, legacyLib: null, fpNameOfFirst: null
      });
    }
    groups.get(fp).packages.push(pkg.name);
    items.push({ pkg, pins, group: groups.get(fp) });
  }

  // 2) 每封装生成封装 + 3D（bga 家族暂只出符号）
  const outItems = items.map(({ pkg, pins, group }) => {
    const itemWarnings = [];
    const single = safeSingle({ part, pkg, pins }, itemWarnings);
    const fpName = pkg.family === 'bga' ? null : footprintName(mpn, pkg);
    if (!group.fpNameOfFirst && fpName) group.fpNameOfFirst = fpName;
    return {
      pkgName: pkg.name,
      family: pkg.family,
      symbolName: group.symbolName,
      fpName,
      files: single ? { kicadMod: single.kicadMod, wrl: single.wrl } : {},
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
    symbols.push({ name: g.symbolName, legacyLib: generateLegacyLib({ mpn: g.symbolName, pins: g.pins }), packages: g.packages });
  }

  for (const it of outItems) warnings.push(...it.warnings.map((w) => `[${it.pkgName}] ${w}`));
  return {
    files: { kicadSym: generateKicadSymLib(blocks) },
    names: { kicadSym: `${mpn}.kicad_sym` },
    symbols,
    items: outItems,
    warnings
  };
}

/** 单封装生成（内部）：bga 跳过，QFN 非 4 倍数等告警透传 */
function safeSingle({ part, pkg, pins }, warnings) {
  if (pkg.family === 'bga') {
    warnings.push(`BGA/DSBGA 封装与 3D 暂不支持自动生成，仅输出符号变体`);
    return null;
  }
  const physical = pins.length;
  if (physical !== pkg.pinCount && physical !== pkg.pinCount + 1) {
    warnings.push(`管脚表共 ${physical} 项，与封装引脚数 ${pkg.pinCount}（+EP）不一致，请核对`);
  }
  const p = { ...pkg };
  if (p.family === 'qfn' && p.pinCount % 4 !== 0) {
    warnings.push(`QFN 引脚数 ${p.pinCount} 非 4 的倍数，封装按 dual 家族回退生成`);
    p.family = 'dual';
  }
  const mpn = String(part.mpn || 'PART').trim() || 'PART';
  return { kicadMod: generateFootprint({ mpn, pkg: p }), wrl: generateWrl({ pkg: p }) };
}

/**
 * @param {object} input  { part:{mpn,manufacturer,title,description_zh}, pkg, pins }
 * @returns {object} { files: {kicadSym, legacyLib, kicadMod, wrl}, names, warnings }
 */
export function generateAll(input) {
  const warnings = [];
  const part = input?.part || {};
  const mpn = String(part.mpn || 'PART').trim() || 'PART';
  const pins = sanitizePins(input?.pins);
  const pkg = sanitizePackage(input?.pkg);
  if (!pins.length) throw new Error('管脚列表为空，无法生成');

  // 管脚数一致性检查（EP 计入 pinCount+1 场景）
  const physical = pins.filter((p) => p.type !== 'no_connect' || true).length;
  if (physical !== pkg.pinCount && physical !== pkg.pinCount + 1) {
    warnings.push(`管脚表共 ${physical} 项，与封装引脚数 ${pkg.pinCount}（+EP）不一致，请核对`);
  }
  // 编号重复检查
  const seen = new Set();
  for (const p of pins) {
    if (seen.has(p.number)) warnings.push(`管脚编号 ${p.number} 重复`);
    seen.add(p.number);
  }
  if (pkg.family === 'qfn' && pkg.pinCount % 4 !== 0) {
    warnings.push(`QFN 引脚数 ${pkg.pinCount} 非 4 的倍数，封装按 dual 家族回退生成`);
    pkg.family = 'dual';
  }

  const fpName = footprintName(mpn, pkg);
  const files = {
    kicadSym: generateKicadSym({ mpn, footprintName: fpName, pins, description: part.title || part.description_zh || '' }),
    legacyLib: generateLegacyLib({ mpn, pins }),
    kicadMod: generateFootprint({ mpn, pkg }),
    wrl: generateWrl({ pkg })
  };
  return {
    files,
    names: {
      kicadSym: `${mpn}.kicad_sym`,
      kicadMod: `${fpName}.kicad_mod`,
      wrl: `${fpName}.wrl`,
      legacyLib: `${mpn}.lib`
    },
    warnings
  };
}
