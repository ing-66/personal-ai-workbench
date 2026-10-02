# 项目启动提示词（历史 Phase 0 快照，执行状态已 Superseded）

> **Phase 1.5 基线说明（2026-09-16）**：本文保留 Phase 0 启动上下文作为历史记录；其中“现在执行 Phase 0”的状态已完成并失效。后续实施以 `MASTER_SPEC.md`、`PHASE0_REPORT.md`、`PHASE1_REPORT.md` 和最新 Phase 指令为准。Managed Personal Workspace / Folderless Chat 方案已被拒绝，当前唯一模型是 `Project → workspaceRoot → Thread`。

你现在接手一个长期软件工程项目：**Personal AI Workbench V1**。这是一个对 T3 Code 的深度 Fork，不是从零重写。

## 你的第一原则

**禁止先写代码再理解项目。禁止重造已有开源轮子。禁止一次同时改多层。**

项目规格文档已经放在 `docs/spec/`。开始前必须完整阅读至少以下文件：

- `00_INDEX.md`
- `01_PROJECT_CHARTER.md`
- `03_PRD.md`
- `04_SRS.md`
- `05_BUILD_VS_REUSE_AUDIT.md`
- `06_ARCHITECTURE_SPEC.md`
- `08_HANDOFF_SPEC.md`
- `14_TEST_AND_ACCEPTANCE_PLAN.md`
- `15_DEVELOPMENT_PLAN.md`
- `18_OPEN_SOURCE_COMPLIANCE.md`
- `20_PROJECT_STARTUP_RUNBOOK.md`

## 产品目标（不可擅自改写）

以 T3 Code 为唯一主 UI 壳，构建一个本地优先、单用户的 Personal AI Workbench：

1. 用户必须先选择或打开 Project / Folder；Thread 必须关联 `projectId`，Harness cwd 为 `thread.worktreePath ?? project.workspaceRoot`。不得创建 Managed Personal Workspace、Hidden Personal Workspace 或 Folderless Chat fallback。
2. 同一 Canonical Thread 中可以切换真实本地 Harness。
3. V1 至少保留/支持 Codex、OpenCode 等 T3 原生 Harness，并新增通过 Generic ACP 接入：
   - Qwen Code：`qwen --acp`
   - Kimi Code：`kimi acp`
   - DeepSeek Harness：`dsh --profile acp`
4. 任意时刻只有一个 Harness 持有 Baton；V1 不做多 Harness 并行工作。
5. 切 Harness 时自动生成 Handoff Package、注入目标 Harness，并在任务未完成时自动继续，不要求用户重新描述任务。
6. Handoff 的首要 KPI 是“目标 Harness 能顺利接着做”，不是复制不可访问的隐藏状态。
7. V1 同时覆盖：普通聊天、Coding、Word/PDF/PPT/Excel 读取+分析+创建+修改、真实浏览器点击/登录/填表/上传下载、完整知识库。
8. Office/Browser/Knowledge 属于 Workbench Tool Bus，不属于某个 Harness。
9. Harness 和 Model 完全解耦。
10. CC Switch 的核心能力最终可以融入 Model Gateway，但 CC Switch 不能成为 Canonical Thread / Handoff 的硬依赖。

## Build vs Reuse 决策（必须遵守）

- 主壳：Fork T3 Code，不重写 UI/Server。
- Generic ACP：先研究/复用 Paseo 的 Generic ACP 思路和 ACP 标准，不给 Qwen/Kimi/DSH 各写一套专用 adapter。
- Handoff：研究并吸收 Loom 的 shared brain / baton / briefing 机制，不从白纸发明。
- Browser：使用 Playwright MCP，不自研浏览器驱动。
- Knowledge：使用 SAG / zleap-sag，不自研 RAG pipeline/vector DB/parser/chunker。
- 文件解析：优先 MarkItDown。
- Word：python-docx；Excel：openpyxl/ExcelJS；PPT：python-pptx + PptxGenJS；PDF：pdf-lib。
- Model infra：后续抽取 CC Switch 的 provider/proxy/usage/failover 等必要 core；不要搬其整套 UI。
- 原有 Harness 历史 Session 不导入 V1，因此不要优先开发 transcript migration。

## 历史执行任务：Phase 0 Baseline & Spike（DONE / Superseded as current instruction）

### Step 1 — 环境与仓库事实采集

先报告：

- OS、Node、包管理器、Python、Git 版本。
- 当前工作目录、仓库 remote、当前 branch、HEAD SHA、dirty status。
- T3 Code upstream SHA/tag 与 LICENSE。
- 不得修改用户真实 T3 userdata。

### Step 2 — 建立隔离开发基线

- 按 T3 官方开发文档使用隔离 home/base-dir。
- 原样启动 T3，验证现有 Codex/OpenCode 等至少一个 provider。
- 运行最小必要的定向测试/构建，不要无理由跑超大范围全仓测试。
- 记录 baseline 成功命令、端口、日志与问题。

### Step 3 — 建 `THIRD_PARTY_LOCK.md`

对以下上游记录：repo、exact commit/tag、license、使用方式（dependency/process/reference/ported code）：
T3 Code、Paseo、Loom、CC Switch、Qwen Code、Kimi Code、DeepSeek Harness、Playwright MCP、SAG/zleap-sag、MarkItDown、python-docx、openpyxl、python-pptx、PptxGenJS、pdf-lib。

如果许可证与规格文档描述不一致，以当前上游事实为准，先报告，不要擅自复制代码。

### Step 4 — 独立 Harness Smoke Tests

逐个、串行验证：

A. Qwen Code：CLI 可启动；ACP `qwen --acp` 可 initialize/session/stream/cancel。
B. Kimi Code：CLI 可启动；ACP `kimi acp` 可 initialize/session/stream/cancel。
C. DSH：CLI 可启动；ACP `dsh --profile acp` 可 initialize/session/list/resume/stream/cancel。

使用同一个一次性测试目录，测试：读取一个文件、修改它、执行 shell、恢复 session。不要碰正式项目文件。

### Step 5 — 三个外部能力 Spike

- Browser Spike：Playwright MCP headed + persistent profile，完成打开网页、一次输入/点击、下载一个无害测试文件，并把下载路径记录下来。
- Knowledge Spike：SAG 本地零基础设施模式完成 ingest → index → search → citation。优先不使用 Docker；只有确认当前 SAG 版本必须用 Docker 时才报告并停下等待决策。
- Office Spike：对 DOCX/XLSX/PPTX/PDF 各准备一个临时样本，完成 read → modify → save → reopen 验证，不修改用户原文件。

### Step 6 — 输出 Phase 0 报告，不进入 Phase 1

创建 `docs/spikes/PHASE0_REPORT.md`，内容必须包括：

- 所有事实与版本。
- 成功/失败矩阵。
- ACP 三 Harness 的 capability 差异。
- Browser/Knowledge/Office 的验证结果。
- 任何与规格冲突的新发现。
- Phase 1 Generic ACP Provider 的最小实施计划。
- 明确指出哪些现成代码可以复用、哪些不能复制。

**完成 Phase 0 后停止，不要自动开始修改 T3 Generic ACP。等待我确认。**

## 开发纪律

- 不要杀错进程，不要按模糊进程名批量 kill。
- 不要触碰/清空真实 T3 数据库。
- 不要隐藏失败，不要为了“跑通”改掉需求。
- 不要把大 tool output 直接塞进 SQLite event stream。
- 不要把 API key/token/password/cookie 写入 Markdown、Git、Handoff 或日志。
- 不要因为某个第三方不兼容就立刻重写整个模块；先证明不兼容。
- 每个结论给出可复现证据：命令、测试、文件位置或上游文档。

现在从 **Step 1 环境与仓库事实采集** 开始执行。
