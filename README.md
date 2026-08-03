# DS2KiCad — 数据手册 → KiCad 符号 / 封装 / 3D / 图区提取

贴入元器件 PDF 数据手册 URL，一键提取原理图符号（管脚名/编号/功能/电气属性）、自动生成 KiCad PCB 封装与 3D 模型、在浏览器中在线预览，并截取内部功能框图（Block Diagram）与应用示例图。**全部提取结果经用户确认后才生成文件**。

测试样例：`https://www.ti.com.cn/cn/lit/ds/symlink/tmuxl27518.pdf`（TI TMUXL27518，3.3V 六通道 2:1 SPDT 模拟开关）

---

## 一、架构总览

```
┌────────────────────────────  浏览器（React 18 + Vite 5）────────────────────────────┐
│  URL 输入 → ① 器件信息 → ② 管脚表 → ③ 封装参数 → ④ 图区截取 → 生成 → ⑤ 预览 → ⑥ 导出 │
│                                  │                          │                       │
│                        pdf.js 页面渲染 + 拖拽框选裁剪   Viewer 内核(符号SVG/封装SVG/  │
│                                  │                     three.js WRL) 移植自          │
│                                  │                     eehubio/kicad_part_viewer     │
└──────────┬───────────────────────┼──────────────────────────────────────────────────┘
           │                       │
   POST /api/extract        GET /api/fetch-pdf（Edge，流式 PDF 代理，绕 CORS）
           │
┌──────────▼──────────── Vercel Serverless（Node ESM）────────────────────────────────┐
│ api/extract.js  服务端下载 PDF（≤15MB，SSRF 防护）→ Gemini Flash 结构化提取           │
│                 → validate.js 清洗 →（仅 MOCK_MODE=1 时返回演示数据；无 Key 则 503）   │
│ api/generate.js lib/kicadgen 确定性引擎：.kicad_sym + .kicad_mod + .wrl + legacy .lib │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**核心原则（与 AltPart AI / PCB Quote AI / CKF 一致）：AI 只做语义提取，确定性规则引擎负责全部几何数学。v0.2 起进一步"确定性优先"：**

- **阶段 1（零 AI）**：服务端 pdfjs 提取 PDF 文本层（带坐标）→ `lib/heuristics.js` 确定性解析器提取器件信息、管脚表（正则+列结构，带置信度模型）、**图区定位**（以 "Figure N. Functional Block Diagram" 等说明行 / 章节标题的精确坐标推算图区，比 AI 的 bbox 更准）。
- **阶段 2（按需 AI）**：只有程序化拿不到的字段才进 Gemini 提示词（`buildPrompt(need)` 按需拼装）。管脚表高置信时 AI 完全不碰管脚；封装机械尺寸因需读图基本总需 AI。同时用 pdf-lib 把 PDF 裁成相关页子集（首页+管脚页+机械图页+图区页）再喂 Gemini，token/时延双降。扫描版 PDF（无文本层）自动回退全量 AI。
- **逐字段溯源**：响应带 `sources`（parser / gemini / fallback），UI 逐字段显示来源徽标（Evidence Binding）。
- **降级模式**：AI 整体不可用但程序化管脚高置信时仍返回结果（封装参数为默认值待手填），不至于全盘失败。
- Gemini 仅返回语义；符号布局、焊盘坐标、丝印/庭院/Fab 层、3D 几何全部由 `lib/kicadgen` 纯函数计算。
- 图区包围盒（无论来自解析器还是 AI）仅是候选，用户在渲染页面上拖拽重新框选后才截图（前端 pdf.js 本地完成，2000px 宽 PNG，像素级精确）。
- Gemini 响应经 3 次重试（指数退避）+ `repairJSON()`，`maxOutputTokens=16384` 防截断。
- `DETERMINISTIC_FIRST=0` 可关闭混合策略回到全量 AI（对照调试用）。

## 一·三、v0.8.5 生产闭环要点（必读）

- **唯一 Canonical 流程**：Patch → 严格校验 → normalized Reviewed IR → 生成/自检 → **单事务**保存 IR+revision+audit+manifest。生成失败绝不修改 Job；响应 `reviewedIr`、数据库 IR、Part Bundle、KiCad 全部来自同一份 normalized IR。
- **显式状态机**：`extracted → edited → reviewed → approved → published / revoked`。Review / Approve / Publish / Revoke 是独立接口 `POST /api/lifecycle`，分别要求 reviewer / publisher。
- **canPublish 依赖持久化批准**：只有 `lifecycle.approvals[asset]` 存在、当前闸门允许、且调用者是 publisher，该资产才可发布——单纯有 publisher 角色不够。
- **EvidenceGate fail closed**：`relevantFields` 与 landPattern 每个字段都必须有 EvidenceAnchor；缺锚点、`unverified`、`model_inference`、`default` 一律阻断 footprint/3D。**删除 evidence 不会让资产变得可晋升。**
- **资产阻断范围**：封装几何问题只影响 footprint/3D；管脚问题影响 symbol 及依赖它的资产；图区问题只影响 figures。
- **Patch 严格校验**：数值越界**直接 400**（不再接受后 clamp）；`confirmed` 必须 boolean、`page` 正整数、`bbox` 必须在 [0,1] 且 x0<x1、y0<y1；addPins/removePins/resolveTransformations/evidence 各层未知字段一律 400；`resolveTransformations` 必须带 reason + evidence。
- **PostgreSQL**：生产必填 `DATABASE_URL`；自然过期的作业会在创建新作业前被标记 `expired` 并释放幂等唯一索引；Job/Audit/manifest 同一事务提交。
- **postMessage 协议 v3**：宿主收到的 `files.entries` 现在带**真实文件内容**（`content`）与 `assetToken`（绑定 tenant+job+revision，15 分钟有效）；图区 PNG 由服务端保存并计入 manifest 哈希。

## 一·四、v0.8.4 生产闭环要点

- **生产必须 PostgreSQL**：`DATABASE_URL` 未配置、或在生产设置了 `JOBSTORE_FILE`，服务启动即 fail closed。Vercel Serverless 多实例与冷启动下 `:memory:`/本地 SQLite 不共享，作业必然丢失。本地开发默认 node:sqlite。
- **Idempotency-Key 作用域** = tenantId + ownerId + operation + documentSha256 + key；唯一索引只对 `active` 作业生效，撤销/过期后同键可重建。
- **管脚稳定 pinId**：支持新增、删除（墓碑）、改编号；转换证据可经 `resolveTransformations` 由 reviewer 显式 accept。
- **审核身份**：只有 reviewer/publisher 的实质修改才写入 `reviewedBy`；editor 的空 Patch 不留审核痕迹，editor 提交修改直接 403。
- **资产级发布**：`canPublish` 是 `{symbol, footprint, model3d, figures}` 对象，各自判定并要求 publisher 角色。
- **证据驱动闸门**：关键几何字段的 EvidenceAnchor 为 `unverified` / `model_inference` / `default` 时阻断 footprint 与 3D；无已确认图区时 figures 不可晋升。
- **人工 land pattern** 的 `landPatternSource` 为 `reviewer_entered`，二次清洗不会被重标成 `datasheet`。

## 一·五、v0.8.3 生产数据一致性要点（必读）

- **服务端持久化 JobStore**：`/api/extract` 把 Canonical IR 存入数据库（默认 node:sqlite，`JOBSTORE_FILE` 可配），返回**不透明 UUID** jobId；IR 不再放进客户端可解码 token。支持幂等键、过期、撤销、乐观锁与审计日志。
- **`/api/generate` 只接受 `{ jobId, patch }`**：Patch 用稳定 ID（`packageId`/`pinsetId`/`figureId`），逐字段记录 before/after/reviewer/reason/evidence/time；非法字段直接 400，不静默忽略。
- **鉴权授权**：校验 JWT 的 iss/aud/exp/nbf/tenantId，角色 viewer<editor<reviewer<publisher；同租户他人不得重放 jobId（403）；提交修改需 reviewer。
- **服务端组装产物**：part-bundle.json（v3）、文件 SHA256、manifest 全部由服务端基于同一份 reviewed IR 生成，前端不再本地拼装。
- **资产级晋升**：symbol / footprint / model3d / figures 分别判定——参数化 WRL 只阻断 3D，已审核的 symbol/footprint 可独立晋升。
- **严格 family allowlist**：只有明确识别的 SOIC/TSSOP/SSOP/MSOP/SOP/DIP/QFN/DFN/SOT-23 系列受支持；未知类型返回 `unknown` 并拒绝生成，**不再默认回退 dual**。
- **文本安全层**：MPN/封装名/管脚名/描述统一拒绝控制字符与换行、限长；S-expression、Legacy LIB、文件名、ZIP 路径分别转义，杜绝注入与路径穿越。

## 二、KLC 合规（v0.6，对照 klc.kicad.org v3.0.6x）

生成器按 KiCad Library Convention 逐条对齐：符号——S3.3 IC 本体背景填充、S3.6 管脚名偏移 20mil、S3.7 EP=N+1、S4.1 管脚原点 100mil 网格且长度按编号位数（≤2 位 100mil / ≥3 位 200mil，全符号等长）、S4.2 功能分边、S4.7 低有效脚自动转 `~{NAME}` 上划线（识别尾缀 #、前缀 / 或 ~）。封装——F4.2 一脚左上、F5.1 丝印 0.12mm/RefDes 1.0mm/丝印避让焊盘、F5.2 Fab 轮廓 0.1mm + 1 脚斜角 min(1mm, 25% 本体) + 第二 `${REFERENCE}`（居中、0.5–1.0mm 随本体缩放）、F5.3 庭院 0.05mm 线宽/0.01mm 网格/间距 0.25mm（小件 0.15mm）、F6.2 SMD 锚点在本体中心、F6.3 roundrect 圆角半径 ≤0.25mm、F7.2 THT 锚点在 1 脚（3D model offset 自动补偿）、F7.3 THT 一脚方形、F2.1/F3.4/F3.5 命名带尺寸（`SOIC-8_3.9x4.9mm_P1.27mm`、`PDIP-8_W7.62mm_P2.54mm`、QFN 带 `-1EP`/`_EPx.xXx.xmm`）、F9.1 tags 关键词。3D——KLC M2.1 要求官方库用 STEP，本项目 WRL 用于预览与 KiCad 渲染，STEP 生成在路线图（需 CAD 内核）。S4.3 原生 pinstack（KiCad 10）为后续项。建议用官方 kicad-library-utils 的 klc-check 脚本复核产物。

## 三、证据绑定与可订购性（v0.4，部分设计参考外部 GPT 版数据模型）

- **推荐 land pattern 优先**：封装带 `landPattern {padW, padL, rowSpan, holeDia?, sourcePage}`（数据手册附录的推荐焊盘，权威值），焊盘引擎优先采用；缺失或经几何校验自相矛盾（如 padW≥pitch）时弃用并回退规则派生 + 告警。UI ③ 可查看/编辑/清除。
- **可订购性过滤**：合并家族手册（如 LM358 与 LM158/LM358B 同册）必须按 Package Option Addendum 过滤——仅保留请求型号可订购的封装（LM358 应排除 LM158 专属的 CDIP/LCCC、LM358B 专属的 DDF）。提示词强制执行，每封装记录 `orderableParts`，不确定时保留但写入 `notes`。
- **封装级溯源**：`drawingId`（机械图编号如 D0008A）、`sourcePages`、`notes` 全部展示在 ③ 并随 part-bundle 导出，复核可直达对应页。

## 四、多封装与管脚定义集（pinset）— v0.3

一份数据手册常提供多种封装（如 LM358 的 SOIC-8 / PDIP-8 / TSSOP-8 / VSSOP-8 / DSBGA），且部分封装的管脚定义不同（DSBGA 用球号 A1/B1…）。数据模型：

- `pinsets: [{id, label, pins[]}]` — 每种**不同的管脚编号方案**一个集合；每个封装带 `pinsetId` 引用
- **符号按 pinset 指纹去重**：管脚兼容的封装共享一个符号（`MPN`）；不同 pinset 生成符号变体（`MPN_<封装代号>`）。一个 `.kicad_sym` 库文件承载全部变体
- **每个勾选的封装各自生成** `.kicad_mod` + `.wrl`（BGA/DSBGA 暂只出符号变体并给出 warning）
- 提取端：多列管脚表（TI 格式 `NAME | D,P,PW | DSBGA | I/O | DESC`）程序化解析为多个 pinset，列头 token 与封装 tiCode 精确匹配完成归属；解析不了列头则降置信交 Gemini（其 schema 同为 pinsets）
- `/api/generate` 双形状兼容：`{part, items:[{pkg,pins}]}` 批量（新）与 `{part, pkg, pins}` 单封装（旧）

## 五、封装生成引擎覆盖范围

| 家族 | 封装类型 | 算法要点 |
|---|---|---|
| `dual` | SOIC / TSSOP / SSOP / MSOP / SOP / SOT-23-5/6 | 逆时针编号，焊盘趾部外延 0.4 / 跟部至本体边 0.25，padW < pitch−0.2 |
| `qfn` | QFN / WQFN / UQFN / VQFN / DFN / SON | 四边逆时针，EP 裸露焊盘（编号 = 引脚数+1），丝印角标自适应收短避让焊盘 |
| `dip` | PDIP / DIP | 通孔 Ø0.8 钻孔 / Ø1.6 焊盘，1 脚方形，孔距 rowSpan |
| `sot23` | SOT-23（3 脚） | 1/2 左列 ±0.95，3 右侧居中 |

3D 模型为参数化 VRML 2.0（`.wrl`，KiCad 约定 1 单位 = 2.54mm）：环氧本体 + 1 脚标记 + 按家族生成引脚（鸥翼两段简化 / QFN 侧焊端 / DIP 直插柱），three.js `VRMLLoader` 在线预览与下载文件同源同构。

## 六、本地开发

```bash
npm install
cp .env.example .env        # 填入 GEMINI_API_KEY；留空则自动 MOCK 演示模式
npm run dev                 # 前端 :5173 + API :3001（Vite 代理 /api）
npm test                    # 生成引擎单元测试（13 项）
node test/smoke.mjs         # 端到端冒烟（提取→生成回环 / SSRF / 错误处理，14 项）
```

> macOS 注意：项目目录（尤其 `node_modules`）**严禁放在 iCloud Drive 同步范围内**。

## 七、部署到 Vercel

1. 推送本仓库到 GitHub，Vercel 导入项目（框架自动识别为 Vite）。
2. Environment Variables 中配置：
   - `GEMINI_API_KEY`（必填；不填则永远返回演示数据）
   - `GEMINI_MODEL`（可选，默认 `gemini-2.5-flash`）
   - `MOCK_MODE`（联调期可设 `1`，先打通 ezPLM 端到端链路再切真实 API——与 AltPart AI 的 mock 先行策略一致）
   - `ALLOWED_ORIGINS`（可选；默认已放行 `*.ezplm.cn` / `*.eetree.cn` 来源）
3. Deploy。`vercel.json` 已配置 `extract` 函数 `maxDuration=60`（Hobby 计划需在 Project Settings 确认 Fluid Compute / 函数时长上限允许 60s，否则大 PDF 可能超时）。

**Vercel 平台约束与对策**（已内置）：

| 约束 | 对策 |
|---|---|
| Serverless 响应体 4.5MB 上限 | v0.8.1 起 `fetch-pdf` **不再是公开 Edge 代理**：改为 Node Runtime + SafeDownloader + 短期 HMAC 令牌（绑定 URL）；大文件走上传通道或直接由浏览器访问原始 URL |
| Gemini inline 请求 20MB 上限 | PDF 下载上限默认 15MB（`MAX_PDF_MB`），超限返回 413 |
| 函数无状态 | 无任何持久化；PDF 按次下载，前端 pdf.js 侧有文档缓存 |

## 八、ezPLM 插件集成（预留协议）

**嵌入方式**：iframe 加载 `https://<deployment>/?embed=1&pdf=<encodeURIComponent(datasheetUrl)>`

- `embed=1`：隐藏页头页脚、启用「发送到 ezPLM」按钮
- `pdf=`：预填 URL（不自动提取，用户点击开始）

**postMessage 协议 v1**：

```js
// 宿主 → 插件：注入数据手册并立即开始提取
iframe.contentWindow.postMessage({ type: 'ezplm:ds2kicad:load', pdfUrl: 'https://…' }, PLUGIN_ORIGIN);

// 插件 → 宿主（v3）：payload 含 mock / nonPromotable / promotionBlockReasons /
// assetToken（tenant+job+revision 绑定，15 分钟）/ files.entries（含真实 content）
window.addEventListener('message', (e) => {
  if (e.origin !== PLUGIN_ORIGIN) return;          // 必须校验来源
  if (e.data?.type === 'ezplm:ds2kicad:result') {
    const { bundle, files } = e.data;
    // bundle: part-bundle.json（schema: ds2kicad.part-bundle.v1，含管脚/封装/图 PNG dataURL）
    // files:  { kicadSym, kicadMod, wrl, legacyLib } 纯文本
  }
});
```

`part-bundle.json` 的结构与 CKF 的 Part Bundle 思路对齐（器件元信息 + 结构化管脚 + 封装参数 + 图区 + 文件清单 + warnings），后续可直接喂给 CKF 入库管线。正式集成时按既有模式追加 nonce 校验与 JWT，`postMessage` 的 `targetOrigin` 从 `'*'` 收敛到 ezPLM 域。

**服务端复用**：`lib/kicadgen` 与 `lib/validate.js` 为零依赖纯 ESM 模块，ezPLM 后端可直接 import 复用，无需经 HTTP。

## 九、目录结构

```
api/            Vercel 函数：extract（Gemini 提取）、generate（确定性生成）、fetch-pdf（Edge PDF 代理）
lib/kicadgen/   确定性生成引擎：symbol.js（.kicad_sym + legacy .lib）、footprint.js（.kicad_mod）、model3d.js（.wrl）
lib/validate.js SSRF 防护 / 管脚 / 封装 / 图区清洗（AI 输出的唯一入口）
lib/gemini.js   提示词 + 3×重试 + repairJSON
lib/mock/       TMUXL27518 演示数据（品红条纹徽标明确标识，非真实提取）
src/            React 前端；src/viewer/ 为移植自 eehubio/kicad_part_viewer 的渲染内核
server/dev.js   本地开发 API 宿主（不部署）
test/           单元测试 + 端到端冒烟
```

## 十、已知边界与后续路线

- **管脚↔物理位置映射**：封装引脚位置按编号 1..N 标准排布；若器件管脚编号非标准顺序（极少见），需在封装参数中人工核对。
- **异形封装**（BGA/DSBGA/WLCSP、LCCC/PLCC、QFP、TO/DPAK、未知类型）一律判为 unsupported，只输出符号变体，**绝不近似生成封装**；QFN/DFN 引脚数非 4 倍数时 **阻断生成**（v0.8.2 起不再回退 dual）。
- **图区包围盒精度**：Gemini 对 PDF 的坐标定位是近似的，UI 的拖拽框选即为此设计——演示模式下包围盒为占位值。
- **STEP 3D**：当前输出 WRL（KiCad 渲染用）；机械级 STEP 需要 CAD 内核，规划接入服务端 CadQuery/build123d 生成（v0.3）。
- 生成结果投产前请以数据手册机械图复核（`descr` 字段与 UI 均有提示）。

---

在线预览内核移植自 [eehubio/kicad_part_viewer](https://github.com/eehubio/kicad_part_viewer)（符号/封装 SVG 渲染、three.js 场景与取景逻辑）。
