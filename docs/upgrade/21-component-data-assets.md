# DS2KiCad v1.3 — 器件数据资产流水线

本次将现有 PDF → KiCad 流程扩展为参数、证据、独立数据发布与可恢复批次的第一版生产代码。九项能力共享一个入口和作业；并非九项原始规格中的所有扩展都已经完成。

## 用户流程

Gemini 超时修复：完整提取的应用预算为 150 秒，函数上限 180 秒；单次模型调用上限 65 秒，最多两次，共享同一个截止时间。Gemini 2.5 Flash 的思考预算默认 1024 tokens。HTTP 鉴权、限流、模型不存在、输出截断和调用超时分别返回错误码及请求 ID。目标型号与手册中明确识别的型号不匹配时，模型调用前拒绝，防止错误归属。

维护人员可仅为 Preview 分支设置 `DS2_GEMINI_DIAGNOSTIC=tmuxl27518`，构建时调用真实 Gemini 完成短文本及公开 TI PDF 提取检查。生成的 `/gemini-health.json` 只包含模型名、状态、耗时、数量等诊断摘要，不含 API Key、原始模型响应或用户资料。关闭该变量可停止后续构建检查。

1. 单器件选择“完整资产”，输入 PDF URL 或上传 PDF。现有 Gemini 请求同时抽取参数候选，原生文本规则补充明确对齐的表格。
2. 若只需要结构化参数，选择“文本参数提取（无需模型）”。仅使用原生文本/OCR结果中能明确解释的表格，不产生占位的符号/封装。
3. 查看九阶段状态、参数候选、标准单位、测试条件、Min/Typ/Max、适用型号和页码原文。自动分类均待人工确认。
4. 填写审核理由，确认类别，核对/修正并接受或拒绝每个候选。纯参数模式支持确认型号与厂商。
5. publisher 发布参数资产，产生内容寻址的不可变 JSON 快照。参数发布不要求 KiCad 符号/封装/3D 成功。后续修改不会改写旧快照；必须再次发布。
6. 完整模式继续使用原有 EDA 审核/批准/发布。ZIP 额外包含明确标记为草稿的 component-data-draft.json；正式数据使用独立发布接口下载。
7. 批量入口每行一个 PDF URL，最多100项；服务器去重并保存每项进度。点击继续处理后页面逐项驱动服务器。关闭页面停止发起后续任务；可通过带 batch 参数的地址或批次 ID 恢复。正在执行的一项仍可能完成。

## 已实现能力与边界

| 能力 | 本次实现 | 尚未完成 |
|---|---|---|
| 01 接入 | PDF上传/URL、租户范围内内容寻址去重、不可变原文对象、哈希回读 | 厂商产品页解析、网站目录同步、完整文档版本目录 |
| 02 解析 | 复用原生PDF/OCR路由，记录页面覆盖及OCR状态 | OCR引擎部署与真实语料质量基准 |
| 03 分类 | 运放、LDO、MOSFET、ADC、模拟开关五类版本化模板；冲突为unknown | 其他器件类别及Schema管理后台 |
| 04 定位 | 电气/工作条件/额定值/订购等区域索引，参数页加入模型切片 | 完整跨页单元格IR与脚注关联 |
| 05 参数 | 模型+保守规则抽取、十进制字符串单位变换、原始观测与审核事实分离 | 曲线数字化、不等式/±/表达式自动解释 |
| 06 管脚/订购 | 复用现有pinsets、packages、orderableParts | 完整OrderingVariant、Pin Mux、电压域 |
| 07 审核 | 服务端权限、理由、乐观锁、事务日志、原文、独立发布 | 厂商确认门户、双人复核、批量审核 |
| 08 符号 | 复用现有确定性生成/发布 | 多单元Symbol IR、官方KiCad回读Worker |
| 09 封装/3D | 复用现有封装与近似WRL资产 | 库匹配服务、STEP/CAD Worker、机械精度认证 |

“已处理”仅表示该阶段有产物，不能解释为工程准确率或通过审核。模板待补字段并非断言手册缺失。数据模型保留指标性质，典型值和绝对最大额定值均不能自动当作设计保证值。

## 数据与API

新增 `job.ir.dataAssets`（ds2kicad.component-data.v1）：

- sourceDocument：源文件SHA256、URL、字节数、页数、解析页、模型页和部分覆盖标志。
- classification：类别、规则/模型候选来源、模板版本、人工确认。
- observations：不可变raw、normalized、nature、conditions、appliesTo、evidence、review。
- publications：不可变content快照、sha256、versionId、发布者和时间。
- history：审核、身份变更与发布记录。

所有新增功能使用既有 PostgreSQL JSONB 作业存储与 commitGeneration 事务，不需要新表。新增发布快照随作业持久化；已发布参数或EDA资产的作业不因处理TTL而不可读。未发布新提取作业和批次默认90天。撤销作业仍禁止读取。

### 参数资产

- `GET /api/data-assets?jobId=...`：参数、权限、模板与流程状态。
- `POST /api/data-assets` action=review：jobId、expectedRevision、reason；可附categoryId、decisions、addObservations。纯参数作业可附identity={mpn,manufacturer}。
- `POST /api/data-assets` action=publish：需要已认证publisher；类别已确认、所有候选已接受/拒绝、至少一条接受参数、明确型号和厂商。
- `GET /api/data-assets?jobId=...&export=draft`：含nonPromotable的草稿。
- `GET /api/data-assets?jobId=...&export=published&versionId=...`：指定或最新发布快照，供ezPLM/API读取；保留同租户认证，不是公开匿名下载。

审核请求示例：

```json
{"jobId":"UUID","expectedRevision":1,"action":"review","categoryId":"op_amp","reason":"对照手册核对","decisions":[{"id":"obs-ID","status":"accepted","value":{"min":null,"typ":"0.0003","max":"0.001"},"unit":"V","nature":"guaranteed","conditions":"TA=25°C, VS=5V","appliesTo":["PART-A"],"page":4,"quotedText":"原文参数行"}]}
```

修改类别或器件身份会重置相关审核。审核身份来自会话；客户端不能写reviewer、publications等字段。访客可提取和查看草稿，不能接受事实或发布。

### 批次

- `POST /api/batch` action=create、urls、assetMode(full/data)、requestId。
- `GET /api/batch?batchId=...`：恢复状态。
- `POST /api/batch` action=tick、batchId、expectedRevision：领取并执行一项。
- `POST /api/batch` action=retry、batchId、expectedRevision、itemId：将失败项恢复为待处理。

领取通过事务和乐观锁提交，租约3分钟；过期后可恢复。结果携带leaseId防止旧Worker覆盖新结果。每项稳定幂等键避免重复生成；计费账本对同主体/操作/输入refKey防重复扣费。执行中的计费保留5分钟后可恢复。单批创建者执行，租户审核者可查看但不能借用别人的身份运行。

持续后台执行：

```bash
# 以平台任务/容器进程启动，密钥通过环境变量注入，勿写进仓库。
node scripts/batch-worker.mjs
```

设置 DS2KICAD_URL、DS2KICAD_WORKER_TOKEN、BATCH_ID。该版本一次Worker处理一个已创建批次；并未部署全局调度器或自动抓取厂商目录。

## 存储与部署

必须先配置持久化原文存储，再部署本版本：

- Vercel建议S3兼容存储：S3_BUCKET、S3_ENDPOINT、S3_REGION、S3_ACCESS_KEY_ID、S3_SECRET_ACCESS_KEY；AWS可使用默认凭证链。
- Railway/自托管可使用挂载持久卷的OBJECT_STORE_DIR。
- 生产环境不再默认为临时目录。开发环境仍可使用/tmp。
- S3适配器真实实现Put/Get/Head，采用内容哈希对象键与IfNoneMatch不可变写入；已通过注入客户端协议测试，真实云桶连接需要部署环境验收。
- 新提取原文不再存入Job JSON的Base64。历史作业的Base64读取兼容保留；既有对象应迁移到所选存储后再切换配置。
- 发布数据快照保存在PostgreSQL，保留数据库备份；对象存储生命周期不能提前删除仍被证据引用的源PDF。
- 保留 DATABASE_URL、GEMINI_API_KEY、身份/令牌密钥、VITE_EZPLM_ORIGINS 等现有配置。参数模式无需Gemini；完整提取仍需模型配置。

## 验证

- 新增单位、条件/额定值、分类歧义、证据、审核、发布不可变性、身份变更、批次租约测试。
- HTTP集成测试使用真实生成的合成PDF与真实解析器，覆盖上传→持久化→提取→审核→发布→回读，以及租户和角色隔离。
- 完整模型分支使用显式GEMINI_STUB，未据此宣称真实模型提取准确率。
- Playwright覆盖实际页面上传、类别/身份确认、参数审核、发布下载、刷新恢复和手机布局。
- 既有PostgreSQL专用测试需要TEST_DATABASE_URL；未配置时会跳过，不能算作真实PostgreSQL验收。

浏览器测试（本地服务启用同一个测试JWT密钥）：

```bash
E2E_BASE_URL=http://localhost:5173 E2E_SESSION_SECRET=<local-test-secret> npx playwright test e2e/data-assets.spec.js
```

如使用外部Chromium，可设置PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH。

## 后续实施顺序

1. 100–300份人工标注语料，分类/参数/条件/适用性分别评估；先测人工审核分钟数，再制定商业报价。
2. 厂商目录接入、文档更新差异、OrderingVariant和Schema扩展。
3. 对接ezPLM已有封装/3D候选库，几何与Pin-Pad验证，CAD/STEP Worker。
4. 厂商确认门户、更新维护SLA、API分发、使用分析。赞助标识与技术事实分离。
# 浏览器验收：无需 S3 的 Preview 模式

升级分支支持 `OBJECT_STORE_MODE=preview-postgres`。它只在 `VERCEL_ENV=preview` 生效，复用现有 PostgreSQL，将 PDF 和图片存入独立的 `ds2kicad_preview_objects` 表，跨函数实例和冷启动读取。生产环境不能用此模式；后续正式运行仍使用 S3 或持久化磁盘。

- 为指定 Preview 分支设置 `PREVIEW_STORAGE_NAMESPACE`，单文件 20MB、命名空间合计 250MB；同内容重复写入不重复占空间。浏览器上传仍受平台请求限制，原始 PDF 最大 3MB；较大文件使用 URL。
- 设置随机 `PREVIEW_ACCESS_CODE`（至少 24 字符）、`PREVIEW_ACCESS_EXPIRES_AT`、独立的 `EZPLM_JWT_SECRET/ISS/AUD` 和 `AUTH_MODE=production`。页面输入访问码后获得 HttpOnly、Secure Cookie，最长 24 小时，不超过访问码到期时间。
- 测试身份固定归属 `preview-<namespace>`，具备审核和发布权限，无法访问其他租户作业。访问码不要公开分享；只用于持码测试人员。Vercel 的项目访问保护保持启用。
- `CREDIT_ENFORCEMENT=0` 不扣平台积分；真实模型调用仍使用该项目的模型配额。未启用 Mock，也不绕过参数或 EDA 审核规则。
- 推荐测试顺序：进入测试 → 上传小于 3MB 的厂商 PDF → 选择参数资产或完整 EDA → 确认型号、厂商、分类 → 核对参数、条件、适用型号、证据 → 接受或驳回全部候选 → 发布 → 下载 → 重新打开任务。
- 数据不会自动清除。结束测试后停用访问码，按 `namespace` 删除测试对象前确认已导出需要的结果。测试发布只作为验收，迁移存储前必须复制对象并核对哈希，不能直接切换后端。
