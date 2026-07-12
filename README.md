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
│                 → validate.js 清洗 →（MOCK_MODE / 无 Key 时返回内置演示数据）         │
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

## 二、多封装与管脚定义集（pinset）— v0.3

一份数据手册常提供多种封装（如 LM358 的 SOIC-8 / PDIP-8 / TSSOP-8 / VSSOP-8 / DSBGA），且部分封装的管脚定义不同（DSBGA 用球号 A1/B1…）。数据模型：

- `pinsets: [{id, label, pins[]}]` — 每种**不同的管脚编号方案**一个集合；每个封装带 `pinsetId` 引用
- **符号按 pinset 指纹去重**：管脚兼容的封装共享一个符号（`MPN`）；不同 pinset 生成符号变体（`MPN_<封装代号>`）。一个 `.kicad_sym` 库文件承载全部变体
- **每个勾选的封装各自生成** `.kicad_mod` + `.wrl`（BGA/DSBGA 暂只出符号变体并给出 warning）
- 提取端：多列管脚表（TI 格式 `NAME | D,P,PW | DSBGA | I/O | DESC`）程序化解析为多个 pinset，列头 token 与封装 tiCode 精确匹配完成归属；解析不了列头则降置信交 Gemini（其 schema 同为 pinsets）
- `/api/generate` 双形状兼容：`{part, items:[{pkg,pins}]}` 批量（新）与 `{part, pkg, pins}` 单封装（旧）

## 三、封装生成引擎覆盖范围

| 家族 | 封装类型 | 算法要点 |
|---|---|---|
| `dual` | SOIC / TSSOP / SSOP / MSOP / SOP / SOT-23-5/6 | 逆时针编号，焊盘趾部外延 0.4 / 跟部至本体边 0.25，padW < pitch−0.2 |
| `qfn` | QFN / WQFN / UQFN / VQFN / DFN / SON | 四边逆时针，EP 裸露焊盘（编号 = 引脚数+1），丝印角标自适应收短避让焊盘 |
| `dip` | PDIP / DIP | 通孔 Ø0.8 钻孔 / Ø1.6 焊盘，1 脚方形，孔距 rowSpan |
| `sot23` | SOT-23（3 脚） | 1/2 左列 ±0.95，3 右侧居中 |

3D 模型为参数化 VRML 2.0（`.wrl`，KiCad 约定 1 单位 = 2.54mm）：环氧本体 + 1 脚标记 + 按家族生成引脚（鸥翼两段简化 / QFN 侧焊端 / DIP 直插柱），three.js `VRMLLoader` 在线预览与下载文件同源同构。

## 四、本地开发

```bash
npm install
cp .env.example .env        # 填入 GEMINI_API_KEY；留空则自动 MOCK 演示模式
npm run dev                 # 前端 :5173 + API :3001（Vite 代理 /api）
npm test                    # 生成引擎单元测试（13 项）
node test/smoke.mjs         # 端到端冒烟（提取→生成回环 / SSRF / 错误处理，14 项）
```

> macOS 注意：项目目录（尤其 `node_modules`）**严禁放在 iCloud Drive 同步范围内**。

## 五、部署到 Vercel

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
| Serverless 响应体 4.5MB 上限 | `fetch-pdf` 使用 **Edge Runtime 流式转发**，不受该限制 |
| Gemini inline 请求 20MB 上限 | PDF 下载上限默认 15MB（`MAX_PDF_MB`），超限返回 413 |
| 函数无状态 | 无任何持久化；PDF 按次下载，前端 pdf.js 侧有文档缓存 |

## 六、ezPLM 插件集成（预留协议）

**嵌入方式**：iframe 加载 `https://<deployment>/?embed=1&pdf=<encodeURIComponent(datasheetUrl)>`

- `embed=1`：隐藏页头页脚、启用「发送到 ezPLM」按钮
- `pdf=`：预填 URL（不自动提取，用户点击开始）

**postMessage 协议 v1**：

```js
// 宿主 → 插件：注入数据手册并立即开始提取
iframe.contentWindow.postMessage({ type: 'ezplm:ds2kicad:load', pdfUrl: 'https://…' }, PLUGIN_ORIGIN);

// 插件 → 宿主：用户确认并点击「发送到 ezPLM」后
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

## 七、目录结构

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

## 八、已知边界与后续路线

- **管脚↔物理位置映射**：封装引脚位置按编号 1..N 标准排布；若器件管脚编号非标准顺序（极少见），需在封装参数中人工核对。
- **异形封装**（BGA / LGA / 非对称引脚）暂不支持，属 v0.2 范围；QFN 引脚数非 4 倍数时自动回退 dual 并给出 warning。
- **图区包围盒精度**：Gemini 对 PDF 的坐标定位是近似的，UI 的拖拽框选即为此设计——演示模式下包围盒为占位值。
- **STEP 3D**：当前输出 WRL（KiCad 渲染用）；机械级 STEP 需要 CAD 内核，规划接入服务端 CadQuery/build123d 生成（v0.3）。
- 生成结果投产前请以数据手册机械图复核（`descr` 字段与 UI 均有提示）。

---

在线预览内核移植自 [eehubio/kicad_part_viewer](https://github.com/eehubio/kicad_part_viewer)（符号/封装 SVG 渲染、three.js 场景与取景逻辑）。
