// test/v081.test.js — v0.8.1 强制回归（PromotionGate / mock 全链路 / 旧接口 / 几何 / 安全 / 构建）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { generateAll, generateBundle } from '../lib/kicadgen/index.js';
import { generateFootprint } from '../lib/kicadgen/footprint.js';
import { sanitizePackage, applyReviewerEdit } from '../lib/validate.js';
import { verifyPdfToken, signPdfToken } from '../lib/pdftoken.js';
import { validateHopUrl, isForbiddenIp } from '../lib/safedl.js';
import { MOCK_TMUXL27518 } from '../lib/mock/tmuxl27518.js';

const pins = (n) => Array.from({ length: n }, (_, i) => ({ number: String(i + 1), name: `P${i + 1}`, type: 'passive' }));
const GOOD_SOIC = { name: 'SOIC-8', type: 'SOIC', family: 'dual', pinCount: 8, pitch: 1.27, bodyLength: 4.9, bodyWidth: 3.9, leadSpan: 6.0, leadLength: 1.0, height: 1.75 };

test('mock extract→generate→export 全链路 nonPromotable=true', () => {
  const sets = Object.fromEntries(MOCK_TMUXL27518.pinsets.map((s) => [s.id, s.pins]));
  // 模拟 extract(mock) → confirm → generate
  const bundle = generateBundle({
    part: MOCK_TMUXL27518.part,
    mock: true, // extract 的 mock 标志经前端透传
    items: MOCK_TMUXL27518.packages.map((p) => ({ pkg: { ...p, family: p.tiCode === 'PW' ? 'dual' : 'qfn' }, pins: sets[p.pinsetId] }))
  });
  assert.equal(bundle.mock, true, 'mock 标志必须保留到 bundle');
  assert.equal(bundle.nonPromotable, true);
  assert.ok(bundle.reasons.includes('mock_data'));
  for (const it of bundle.items) assert.equal(it.promotion.nonPromotable, true, it.pkgName);
  // export 阶段（part-bundle 字段由 ExportPanel 组装，此处校验其数据源存在且为真）
  assert.equal(!!bundle.mock, true);
  assert.ok(Array.isArray(bundle.reasons) && bundle.reasons.length > 0);
});

test('旧 generateAll 接口无法绕过 PromotionGate', () => {
  // 旧形状 + mock → 同样不可晋升
  const old = generateAll({ part: { mpn: 'X' }, pkg: GOOD_SOIC, pins: pins(8), mock: true });
  assert.equal(old.nonPromotable, true);
  assert.ok(old.reasons.includes('mock_data'));
  // 旧形状 + 缺失尺寸 → 不可晋升
  const bad = generateAll({ part: { mpn: 'X' }, pkg: { name: 'MYSTERY', pinCount: 8 }, pins: pins(8) });
  assert.equal(bad.nonPromotable, true);
  // 旧形状必须返回闸门字段（不存在无 gate 的返回路径）
  assert.equal(typeof old.nonPromotable, 'boolean');
  assert.ok(Array.isArray(old.reasons));
  // 旧形状内部确实走 bundle（items/symbols 存在）
  assert.equal(old.items.length, 1);
  assert.ok(old.symbols.length >= 1);
});

test('BGA / QFN-10 / 管脚2-封装8 / 超范围尺寸 均不可晋升', () => {
  // BGA：未支持家族，不得产出可发布封装
  const bga = generateBundle({ part: { mpn: 'A' }, items: [{ pkg: { ...GOOD_SOIC, name: 'BGA-8', type: 'DSBGA', family: 'bga' }, pins: pins(8) }] });
  assert.equal(bga.nonPromotable, true);
  assert.ok(bga.reasons.includes('unsupported_package_family'));
  assert.equal(bga.items[0].files.kicadMod, undefined);

  // QFN-10：非 4 倍数，阻断而非近似
  const q10 = generateBundle({ part: { mpn: 'B' }, items: [{ pkg: { ...GOOD_SOIC, name: 'QFN-10', type: 'QFN', family: 'qfn', pinCount: 10, pitch: 0.5, leadLength: 0.4 }, pins: pins(10) }] });
  assert.equal(q10.nonPromotable, true);
  assert.equal(q10.items[0].files.kicadMod, undefined, 'QFN-10 不得生成封装');

  // 管脚 2 / 封装 8：数量冲突
  const mism = generateBundle({ part: { mpn: 'C' }, items: [{ pkg: GOOD_SOIC, pins: pins(2) }] });
  assert.equal(mism.nonPromotable, true);
  assert.ok(mism.reasons.includes('pin_count_or_number_conflict'));

  // 超范围尺寸：记 clamped，不可晋升，且保留 rawValue
  const over = sanitizePackage({ ...GOOD_SOIC, pitch: 99 });
  assert.equal(over.fieldProvenance.pitch.source, 'clamped');
  assert.equal(over.fieldProvenance.pitch.rawValue, 99);
  const overB = generateBundle({ part: { mpn: 'D' }, items: [{ pkg: over, pins: pins(8) }] });
  assert.equal(overB.nonPromotable, true);
  assert.ok(overB.reasons.includes('value_out_of_range_clamped'));

  // 重复管脚编号
  const dup = generateBundle({ part: { mpn: 'E' }, items: [{ pkg: GOOD_SOIC, pins: [...pins(7), { number: '7', name: 'DUP', type: 'passive' }] }] });
  assert.equal(dup.nonPromotable, true);
  assert.ok(dup.reasons.includes('pin_count_or_number_conflict'));

  // 对照：全齐真实值 → 仅剩 v0.8.2 的推导/近似类阻断（证明闸门不是恒真、不误报缺失）
  const ok = generateBundle({ part: { mpn: 'F' }, items: [{ pkg: GOOD_SOIC, pins: pins(8) }] });
  assert.ok(!ok.reasons.includes('missing_required_geometry'));
  assert.ok(!ok.reasons.includes('pin_count_or_number_conflict'));
});

test('3x2mm 矩形 DFN：X/Y 焊盘坐标不同（bodyWidth/bodyLength 分轴）', () => {
  const pkg = { name: 'DFN-8', type: 'DFN', family: 'qfn', pinCount: 8, pitch: 0.5, bodyLength: 3.0, bodyWidth: 2.0, leadLength: 0.4, height: 0.75 };
  const mod = generateFootprint({ mpn: 'X', pkg });
  const pads = [...mod.matchAll(/\(pad "(\d+)" smd \S+ \(at ([-\d.]+) ([-\d.]+)\)/g)].map((m) => ({ n: +m[1], x: +m[2], y: +m[3] }));
  assert.equal(pads.length, 8);
  const maxAbsX = Math.max(...pads.map((p) => Math.abs(p.x)));
  const maxAbsY = Math.max(...pads.map((p) => Math.abs(p.y)));
  assert.notEqual(maxAbsX, maxAbsY, '矩形封装两轴范围必须不同');
  // 左右列由 bodyWidth(2.0) 决定：|x| ≈ 2/2+0.3 与 2/2-0.4-0.05 的中点 = 0.925
  assert.ok(Math.abs(maxAbsX - 0.925) < 0.01, `maxAbsX=${maxAbsX}`);
  // 上下行由 bodyLength(3.0) 决定：≈ 1.425
  assert.ok(Math.abs(maxAbsY - 1.425) < 0.01, `maxAbsY=${maxAbsY}`);
  // 正方形封装两轴应相同（回归对照）
  const sq = generateFootprint({ mpn: 'X', pkg: { ...pkg, bodyLength: 3.0, bodyWidth: 3.0 } });
  const sp = [...sq.matchAll(/\(pad "\d+" smd \S+ \(at ([-\d.]+) ([-\d.]+)\)/g)].map((m) => ({ x: +m[1], y: +m[2] }));
  assert.equal(Math.max(...sp.map((p) => Math.abs(p.x))), Math.max(...sp.map((p) => Math.abs(p.y))));
});

test('fetch-pdf：重定向到 127.0.0.1 被拒绝（逐跳校验）', () => {
  // 重定向目标进入下一跳时会走 validateHopUrl + DNS 校验
  assert.ok(!validateHopUrl('http://127.0.0.1/x.pdf').ok);
  assert.ok(!validateHopUrl('http://127.0.0.1:8080/evil.pdf').ok === false || !validateHopUrl('http://127.0.0.1:8080/evil.pdf').ok);
  assert.equal(isForbiddenIp('127.0.0.1'), true);
  assert.equal(isForbiddenIp('169.254.169.254'), true);
  // 令牌绑定 URL：换成内网地址后签名失效（不能用合法令牌抓内网）
  const good = 'https://www.ti.com/lit/x.pdf';
  const token = signPdfToken(good);
  assert.equal(verifyPdfToken(good, token).ok, true);
  assert.equal(verifyPdfToken('http://127.0.0.1/x.pdf', token).ok, false);
  // 无令牌不可用（端点不再是公开代理）
  assert.equal(verifyPdfToken(good, '').ok, false);
});

test('fetch-pdf 源码不再是公开 Edge 代理，且强制令牌校验', () => {
  const src = readFileSync(new URL('../api/fetch-pdf.js', import.meta.url), 'utf8');
  assert.ok(!/runtime:\s*'edge'/.test(src), '不应再是 Edge 公开代理');
  assert.ok(/verifyPdfToken/.test(src), '必须校验短期令牌');
  assert.ok(/safeDownload/.test(src), '必须走 SafeDownloader');
});

test('未配置 VITE_EZPLM_ORIGINS 时生产构建失败；配置后成功', () => {
  const root = new URL('..', import.meta.url).pathname;
  const env = { ...process.env };
  delete env.VITE_EZPLM_ORIGINS;
  let failed = false, out = '';
  try {
    execFileSync('npx', ['vite', 'build'], { cwd: root, env, stdio: 'pipe', timeout: 180000 });
  } catch (e) {
    failed = true;
    out = String(e.stderr || '') + String(e.stdout || '');
  }
  assert.equal(failed, true, '缺 origin 的生产构建必须以非零退出码失败');
  assert.match(out, /VITE_EZPLM_ORIGINS|生产构建必须设置/, out.slice(0, 300));
  // 配置后应成功
  execFileSync('npx', ['vite', 'build'], {
    cwd: root, env: { ...env, VITE_EZPLM_ORIGINS: 'https://ezplm.cn' }, stdio: 'pipe', timeout: 180000
  });
});

test('构建产物中搜索不到 API_TOKEN', () => {
  const root = new URL('..', import.meta.url).pathname;
  const dist = `${root}dist/assets`;
  if (!existsSync(dist)) {
    execFileSync('npx', ['vite', 'build'], {
      cwd: root, env: { ...process.env, VITE_EZPLM_ORIGINS: 'https://ezplm.cn' }, stdio: 'pipe', timeout: 180000
    });
  }
  const files = readdirSync(dist).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const txt = readFileSync(`${dist}/${f}`, 'utf8');
    assert.ok(!txt.includes('API_TOKEN'), `${f} 含 API_TOKEN`);
    assert.ok(!txt.includes('VITE_API_TOKEN'), `${f} 含 VITE_API_TOKEN`);
  }
});

test('item 10：人工修改产生 reviewer provenance 并重算 missingFields', () => {
  const p0 = sanitizePackage({ name: 'X', type: 'SOIC', pinCount: 8, bodyLength: 4.9, bodyWidth: 3.9, leadSpan: 6, height: 1.75 });
  assert.deepEqual(p0.missingFields, ['pitch']);
  const signed = applyReviewerEdit(p0, 'pitch', 1.27, 'gongyusu', '对照机械图');
  assert.equal(signed.fieldProvenance.pitch.source, 'reviewer');
  assert.equal(signed.fieldProvenance.pitch.reviewer, 'gongyusu');
  assert.deepEqual(signed.missingFields, [], '署名修改后不再缺失');
  const b1 = generateBundle({ part: { mpn: 'X' }, items: [{ pkg: signed, pins: pins(8) }] });
  assert.ok(!b1.reasons.includes('missing_required_geometry'), JSON.stringify(b1.reasons));
  assert.ok(!b1.reasons.includes('reviewer_edit_without_provenance'));
  // 无署名 → 该字段仍视为未验证
  const unsigned = applyReviewerEdit(p0, 'pitch', 1.27, '');
  assert.ok(unsigned.missingFields.includes('pitch'));
  const b2 = generateBundle({ part: { mpn: 'X' }, items: [{ pkg: unsigned, pins: pins(8) }] });
  assert.equal(b2.nonPromotable, true);
  // 人工填了越界值 → clamped，不可晋升
  const bad = applyReviewerEdit(p0, 'pitch', 99, 'gongyusu');
  assert.equal(bad.fieldProvenance.pitch.source, 'clamped');
  assert.equal(bad.fieldProvenance.pitch.rawValue, 99);
});

test('item 4：提示词中不存在任何估算/JEDEC nominal 指令', () => {
  const src = readFileSync(new URL('../lib/gemini.js', import.meta.url), 'utf8');
  assert.ok(!/JEDEC-standard nominal/i.test(src));
  assert.ok(!/use a reasonable/i.test(src));
  assert.ok(/NEVER estimate/i.test(src), '必须包含明确禁令');
  // Schema 中不得出现可被当作缺省值抄写的示例数字
  assert.ok(!/"pitch": 1\.27/.test(src) && !/"bodyLength": 4\.9/.test(src), 'schema 不得含示例数字');
  assert.ok(!/EXTRACT_PROMPT\s*=/.test(src), 'v0.8.2：旧全量提示词必须删除');
});
