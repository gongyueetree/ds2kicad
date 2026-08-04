#!/usr/bin/env node
// scripts/mint-session.mjs — 本地/联调环境签发一个 ezPLM 风格会话 JWT。
//
// 为什么需要它：前端 src/api.js **刻意不把令牌写进浏览器 bundle**，它依赖同源 Cookie
// `ezplm_session` 或网关注入的 Authorization 头。因此只在服务端配好 EZPLM_JWT_SECRET
// 并不会让浏览器自动带上令牌 —— 请求仍是无令牌的，AUTH_MODE=dev 会把它静默降级为
// authenticated:false 的匿名身份，于是所有资产恒挂 no_authenticated_ezplm_session。
//
// 本脚本只在你已经掌握 EZPLM_JWT_SECRET 的前提下工作，不构成权限提升：
// 它做的事等同于 ezPLM 正常签发会话，只是搬到了命令行。
//
// 用法：
//   EZPLM_JWT_SECRET=xxx node scripts/mint-session.mjs \
//     --sub u1 --name 张三 --tenant eetree --roles reviewer,publisher \
//     --iss https://ezplm.cn --aud ds2kicad --ttl 28800
//
// 输出：JWT 本身 + 在浏览器控制台设置 Cookie 的命令 + curl 示例。

import { issueDevSession } from '../lib/auth.js';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};

const key = process.env.EZPLM_JWT_SECRET;
if (!key) {
  console.error('✕ 缺少 EZPLM_JWT_SECRET 环境变量。它必须与服务端配置完全一致，否则验签会失败。');
  process.exit(1);
}

const sub = arg('sub', 'local-reviewer');
const name = arg('name', '本地复核员');
const tenantId = arg('tenant', process.env.EZPLM_TENANT_ID || 'dev');
const roles = String(arg('roles', 'reviewer,publisher')).split(/[\s,]+/).filter(Boolean);
const iss = arg('iss', process.env.EZPLM_JWT_ISS || undefined);
const aud = arg('aud', process.env.EZPLM_JWT_AUD || undefined);
const ttlSec = Number(arg('ttl', 8 * 3600));
const origin = String(arg('origin', 'http://localhost:5173')).replace(/\/+$/, '');

const token = issueDevSession({ sub, name, tenantId, roles, iss, aud, ttlSec }, key);

const secure = origin.startsWith('https://');
console.log(`
✓ 已签发会话 JWT
  sub=${sub}  tenantId=${tenantId}  roles=${roles.join(',')}
  iss=${iss ?? '(未设置)'}  aud=${aud ?? '(未设置)'}  有效期=${ttlSec}s

── JWT ──
${token}

── 方式一：浏览器控制台设置 Cookie（在 ${origin} 页面上执行）──
document.cookie = "ezplm_session=${token}; path=/; max-age=${ttlSec}; samesite=lax${secure ? '; secure' : ''}";
location.reload();

── 方式二：curl 直连 API ──
curl -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" \\
  -d '{"pdfUrl":"https://www.ti.com/lit/ds/symlink/tmuxl27518.pdf"}' \\
  ${origin}/api/extract

── 提醒 ──
· tenantId 必须与作业所属租户一致，否则 403 tenant_mismatch。
  之前用匿名身份（tenantId=dev）提取的作业，换成本令牌后访问不了 —— 需要重新提取一次。
· 生产环境请设 AUTH_MODE=production：无令牌会直接 401，而不是静默降级为匿名身份。
· iss / aud 必须与服务端的 EZPLM_JWT_ISS / EZPLM_JWT_AUD 完全一致，否则验签失败。
`);
