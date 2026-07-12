// test/smoke.mjs — 单进程端到端冒烟：启动 dev API → 自请求 → 校验 → 退出
process.env.MOCK_MODE = '1';
process.env.PORT = '3123';
import express from 'express';
import extractHandler from '../api/extract.js';
import generateHandler from '../api/generate.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.all('/api/extract', (req, res) => extractHandler(req, res));
app.all('/api/generate', (req, res) => generateHandler(req, res));
const srv = app.listen(3123);

const post = async (path, body) => {
  const r = await fetch(`http://localhost:3123${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
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
  check('extract 图区 2 项', ex.data.figures?.length === 2);

  // 2. SSRF 拒绝
  const bad = await post('/api/extract', { pdfUrl: 'http://127.0.0.1/x.pdf' });
  check('SSRF 内网拒绝 400', bad.status === 400, bad.data.error);
  const bad2 = await post('/api/extract', { pdfUrl: 'ftp://x.com/a.pdf' });
  check('非 http 拒绝 400', bad2.status === 400);

  // 3. 提取 → 生成 回环
  const payload = {
    part: ex.data.part,
    pkg: ex.data.packages[ex.data.recommendedPackageIndex],
    pins: ex.data.pins
  };
  const gen = await post('/api/generate', payload);
  check('generate 200', gen.status === 200, JSON.stringify(gen.data.error || ''));
  check('generate 四文件齐全', ['kicadSym', 'kicadMod', 'wrl', 'legacyLib'].every((k) => gen.data.files?.[k]?.length > 100));
  check('generate 文件名正确', gen.data.names?.kicadSym === 'TMUXL27518.kicad_sym', gen.data.names?.kicadSym);
  const padCount = (gen.data.files.kicadMod.match(/\(pad "/g) || []).length;
  check('QFN-24 焊盘 24+EP', padCount === 25, `实际 ${padCount}`);
  check('generate 无阻断性告警', Array.isArray(gen.data.warnings), JSON.stringify(gen.data.warnings));

  // 4. 空管脚 → 422
  const empty = await post('/api/generate', { part: { mpn: 'X' }, pkg: payload.pkg, pins: [] });
  check('空管脚返回 422', empty.status === 422);

  // 5. 非法 JSON 请求体
  const rawResp = await fetch('http://localhost:3123/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'not json'
  });
  check('非 JSON 请求体不 500', rawResp.status !== 500, `status ${rawResp.status}`);
} finally {
  srv.close();
}
console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
