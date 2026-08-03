// test/smoke.mjs — 单进程端到端冒烟：启动 dev API → 自请求 → 校验 → 退出
process.env.MOCK_MODE = '1';
process.env.PORT = '3123';
process.env.EZPLM_JWT_SECRET = 'smoke-jwt-secret';
process.env.AUTH_MODE = 'production';
process.env.PDF_TOKEN_SECRET = 'smoke-pdf-secret';
import express from 'express';
import { issueDevSession } from '../lib/auth.js';
const TOKEN = issueDevSession({ sub: 'smoke-user', name: 'Smoke', tenantId: 'smoke-tenant', roles: ['reviewer'] }, 'smoke-jwt-secret');
import extractHandler from '../api/extract.js';
import generateHandler from '../api/generate.js';

const app = express();
app.use(express.json({ limit: '8mb' }));
app.all('/api/extract', (req, res) => extractHandler(req, res));
app.all('/api/generate', (req, res) => generateHandler(req, res));
const srv = app.listen(3123);

const post = async (path, body) => {
  const r = await fetch(`http://localhost:3123${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body)
  });
  return { status: r.status, data: await r.json() };
};

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fails++;
};

try {
  // 1. mock 提取
  const ex = await post('/api/extract', { pdfUrl: 'https://www.ti.com.cn/cn/lit/ds/symlink/tmuxl27518.pdf' });
  check('extract 200', ex.status === 200);
  check('extract mock 标记', ex.data.mock === true);
  check('extract 管脚 25 项（含 EP）', ex.data.pins?.length === 25, `实际 ${ex.data.pins?.length}`);
  check('extract 封装候选含 family', ex.data.packages?.[0]?.family === 'qfn');
  check('extract 图区 4 项（框图1+管脚排布2+应用1）', ex.data.figures?.length === 4 && ex.data.figures.filter((f) => f.kind === 'pin_configuration').length === 2);
  check('extract pinsets 2 集（WQFN 含 EP / TSSOP 无）', ex.data.pinsets?.length === 2 && ex.data.pinsets[1].pins.length === 24);
  check('extract 封装带 pinsetId', ex.data.packages?.every((p) => !!p.pinsetId));

  // 1.5 上传通道
  const upBad = await post('/api/extract', { pdfBase64: Buffer.from('not a pdf').toString('base64'), fileName: 'x.pdf' });
  check('上传非 PDF 内容 → 422', upBad.status === 422, upBad.data.error);
  const big = Buffer.alloc(3.4 * 1024 * 1024, 0x41);
  big.write('%PDF-');
  const upBig = await post('/api/extract', { pdfBase64: big.toString('base64'), fileName: 'big.pdf' });
  check('上传超 3MB → 413', upBig.status === 413, upBig.data.error);
  const okPdf = Buffer.from('%PDF-1.4 fake for mock');
  const upOk = await post('/api/extract', { pdfBase64: okPdf.toString('base64'), fileName: 'ad5529r.pdf' });
  check('合法上传（mock 模式）→ 200', upOk.status === 200 && upOk.data.mock === true && /^local:/.test(upOk.data.meta?.pdfUrl), JSON.stringify(upOk.data.meta));

  // 1.8 P0-3 fail-closed：无 Key 且未显式开 mock → 503
  delete process.env.MOCK_MODE;
  const fc = await post('/api/extract', { pdfUrl: 'https://www.ti.com/x.pdf' });
  check('无Key且未显式mock → 503 fail-closed', fc.status === 503 && fc.data.code === 'model_not_configured', JSON.stringify(fc.data));
  process.env.MOCK_MODE = '1';
  // mock 响应必须带 non_promotable
  const nm = await post('/api/extract', { pdfUrl: 'https://www.ti.com/x.pdf' });
  check('mock 响应 non_promotable=true', nm.data.non_promotable === true);

  // 2. SSRF 拒绝
  const bad = await post('/api/extract', { pdfUrl: 'http://127.0.0.1/x.pdf' });
  check('SSRF 内网拒绝 400', bad.status === 400, bad.data.error);
  const bad2 = await post('/api/extract', { pdfUrl: 'ftp://x.com/a.pdf' });
  check('非 http 拒绝 400', bad2.status === 400);

  // 3. 提取 → 生成 回环（v0.8.2 契约：只提交 jobId + patch）
  check('extract 返回 jobId', typeof ex.data.jobId === 'string' && ex.data.jobId.length > 20);
  const gen = await post('/api/generate', { jobId: ex.data.jobId, patch: {} });
  check('generate 200', gen.status === 200, JSON.stringify(gen.data.error || ''));
  check('bundle 两个封装 items', gen.data.items?.length === 2, JSON.stringify(gen.data.error || ''));
  check('mock 由服务端恢复且不可晋升', gen.data.mock === true && gen.data.nonPromotable === true);
  const rejected = await post('/api/generate', { jobId: ex.data.jobId, part: { mpn: 'FAKE' } });
  check('客户端提交 part 被拒绝', rejected.status === 400 && rejected.data.code === 'client_authoritative_fields_rejected');
  check('bundle 两个符号变体（EP 差异）', gen.data.symbols?.length === 2, gen.data.symbols?.map((s2) => s2.name).join());
  check('bundle 合并库文件名', gen.data.names?.kicadSym === 'TMUXL27518.kicad_sym', gen.data.names?.kicadSym);
  check('服务端产出 partBundle + manifest', !!gen.data.partBundle && !!gen.data.manifest && Array.isArray(gen.data.assetFiles));
  check('manifest 含文件哈希', gen.data.manifest?.files?.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
  check('资产级晋升结论', gen.data.assetPromotion && typeof gen.data.assetPromotion.symbol === 'boolean', JSON.stringify(gen.data.assetPromotion));
  const padCount = (gen.data.items[0].files.kicadMod.match(/\(pad "/g) || []).length;
  check('QFN-24 焊盘 24+EP', padCount === 25, `实际 ${padCount}`);
  check('每封装均有封装+3D', gen.data.items.every((it) => it.files.kicadMod && it.files.wrl));
  // v0.8.2：旧形状（直接提交 part/pkg/pins）必须被拒绝
  const old = await post('/api/generate', { part: ex.data.part, pkg: ex.data.packages[0], pins: ex.data.pins });
  check('旧形状被拒绝（无绕过路径）', old.status === 400, JSON.stringify(old.data));

  // 4. 非法 jobId → 400
  const badJob = await post('/api/generate', { jobId: 'forged.sig', patch: {} });
  check('伪造 jobId 返回 400', badJob.status === 400 && badJob.data.code === 'invalid_job');

  // 5. 非法 JSON 请求体
  const rawResp = await fetch('http://localhost:3123/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'not json'
  });
  check('非 JSON 请求体不 500', rawResp.status !== 500, `status ${rawResp.status}`);
  check('mock 响应含 pdfToken（item 9）', typeof ex.data.pdfToken === 'string' && ex.data.pdfToken.length > 10);
} finally {
  srv.close();
}
console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
