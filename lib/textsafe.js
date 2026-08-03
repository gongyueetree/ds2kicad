// lib/textsafe.js — v0.8.3 item 7：统一文本安全层。
// 输入侧：拒绝控制字符/换行、限长；输出侧：按目标格式分别转义
//   - KiCad S-expression 字符串（.kicad_sym / .kicad_mod）
//   - Legacy .lib DEF 行（空白分隔，字段内不得有空格/引号）
//   - 文件名（禁止路径分隔符、..、保留名）
//   - ZIP 条目路径（禁止穿越、绝对路径）

// item 8：/g 正则的 .test 会推进 lastIndex 导致连续调用漏判——
// 分开两个常量：CTRL_G 只用于 replace，CTRL_T（无 g）只用于 test。
const CTRL_G = /[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g;
const CTRL_T = /[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/;

export const LIMITS = { mpn: 64, packageName: 64, pinName: 48, pinNumber: 12, description: 300, title: 200 };

/** 清洗输入文本：去控制字符/换行、折叠空白、限长。返回 {value, changed, rejected} */
export function safeText(raw, { max = 200, field = 'text', allowEmpty = true } = {}) {
  const original = raw === null || raw === undefined ? '' : String(raw);
  let v = original.replace(CTRL_G, ' ');           // 控制字符与换行 → 空格
  v = v.replace(/\s+/g, ' ').trim();
  const truncated = v.length > max;
  if (truncated) v = v.slice(0, max);
  if (!allowEmpty && !v) return { value: '', changed: true, rejected: true, reason: 'empty_after_sanitize' };
  return {
    value: v,
    changed: v !== original,
    rejected: false,
    ...(truncated ? { truncated: true } : {}),
    ...(CTRL_T.test(original) ? { hadControlChars: true } : {})
  };
}

/** 严格模式：含控制字符/换行即拒绝（用于 MPN 等关键标识） */
export function strictText(raw, { max = 64, field = 'text' } = {}) {
  const original = String(raw ?? '');
  if (CTRL_T.test(original)) return { ok: false, error: `${field} 含控制字符或换行` };
  if (original.length > max) return { ok: false, error: `${field} 超长（>${max}）` };
  const v = original.trim();
  if (!v) return { ok: false, error: `${field} 为空` };
  return { ok: true, value: v };
}

/** KiCad S-expression 字符串转义：反斜杠与双引号；控制字符先剔除 */
export function escSexpr(raw) {
  return String(raw ?? '').replace(CTRL_G, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Legacy .lib DEF 字段：空白分隔格式，字段内不得有空格/引号/井号 */
export function escLegacyField(raw) {
  return String(raw ?? '')
    .replace(CTRL_G, '')
    .replace(/["'#]/g, '')
    .replace(/[\\/]/g, '_')      // 路径分隔符
    .replace(/\.{2,}/g, '_')      // .. 穿越串
    .replace(/\s+/g, '_')
    .slice(0, 64) || 'X';
}

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/** 文件名安全化：禁止路径分隔符、..、控制字符、保留名；保留 KiCad 命名允许的字符 */
export function safeFileName(raw, { fallback = 'unnamed', max = 120 } = {}) {
  let v = String(raw ?? '').replace(CTRL_G, '');
  v = v.replace(/[\\/]/g, '_');            // 路径分隔符
  v = v.replace(/\.{2,}/g, '_');            // .. 穿越
  v = v.replace(/[^A-Za-z0-9._,+\-]/g, '_');
  v = v.replace(/^[.\-]+/, '_');            // 前导点/横杠（隐藏文件、参数注入）
  if (WINDOWS_RESERVED.test(v.split('.')[0])) v = `_${v}`;
  v = v.slice(0, max);
  return v || fallback;
}

/** ZIP 条目路径：只允许 已知安全目录/文件名 组合，绝不出现绝对路径或 .. */
export function safeZipPath(raw, { fallback = 'file' } = {}) {
  const parts = String(raw ?? '').split('/').filter(Boolean);
  const safe = parts
    .filter((p) => p !== '.' && p !== '..')
    .map((p) => safeFileName(p, { fallback }));
  const joined = safe.join('/');
  if (!joined || joined.startsWith('/')) return fallback;
  return joined;
}

/** 校验一组关键文本字段，返回错误列表（用于 API 层 400） */
export function validateTextFields(obj = {}) {
  const errors = [];
  const check = (field, value, max) => {
    if (value === undefined || value === null) return;
    const r = strictText(value, { max, field });
    if (!r.ok) errors.push({ field, error: r.error });
  };
  check('mpn', obj.mpn, LIMITS.mpn);
  check('packageName', obj.packageName, LIMITS.packageName);
  return errors;
}
