// lib/kicadgen/index.js — 生成编排：一次输入（确认后的数据）→ 全套文件文本
import { generateKicadSym, generateLegacyLib } from './symbol.js';
import { generateFootprint, footprintName } from './footprint.js';
import { generateWrl } from './model3d.js';
import { sanitizePins, sanitizePackage } from '../validate.js';

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
