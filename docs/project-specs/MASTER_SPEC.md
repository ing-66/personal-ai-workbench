# Personal AI Workbench V1 — 软件开发全套规格（合并版）

---

# Personal AI Workbench V1 文档总索引

**文档基线日期：2026-09-16（Phase 1.5 重基线）**  
**产品代号：Personal AI Workbench（暂名）**  
**外壳：T3 Code Fork**  
**目标平台：Windows 优先，本地优先，单用户**

## 一、项目一句话定义

以 T3 Code 为交互外壳，在用户已打开的 Project / Folder 中构建个人 AI 工作台：每条 Canonical Thread 明确依附 `Project.workspaceRoot`，并可在多个真实本地 Harness 之间切换，通过自动 Handoff Package 无感接力；同时提供文件/Office/PDF、浏览器、知识库、Coding 与独立模型路由能力。

## 二、冻结的 V1 决策

- T3 Code 作为唯一主 UI 壳。
- 用户必须先选择或打开 Project / Folder，Thread 必须关联 `projectId`；运行目录为 `thread.worktreePath ?? project.workspaceRoot`。
- 不支持 Folderless Chat、Managed Personal Workspace、Hidden Personal Workspace 或任何无 Project 的 Thread fallback。
- 不导入原有 Codex/Claude/OpenCode 历史会话。
- 同一条 visible thread 必须支持中途切 Harness。
- 切换时自动生成高质量 Handoff Package，并自动让目标 Harness 继续任务。
- V1 不做多 Harness 同时工作；任意时刻只有一个 Baton Holder。
- Qwen Code / Kimi Code / DSH 优先通过 Generic ACP 接入。
- 文件、Word、PDF、PPT、Excel：读取、分析、创建、修改已有文件均纳入 V1。
- 浏览器：真实打开、点击、登录、填表、上传、下载、执行网站操作均纳入 V1。
- 知识库：创建、上传、解析、切片、索引、检索、更新、删除、管理均纳入 V1。
- Harness 与 Model 完全解耦。
- CC Switch 的能力最终融入模型基础设施，但不得成为 Canonical Thread / Handoff 的硬依赖。

## 三、文档清单

1. `01_PROJECT_CHARTER.md` — 项目启动说明书 / Project Charter
2. `02_PRODUCT_OVERVIEW.md` — 项目说明书 / 产品总览
3. `03_PRD.md` — 产品需求说明书
4. `04_SRS.md` — 软件需求规格说明书
5. `05_BUILD_VS_REUSE_AUDIT.md` — 最终 Build vs Reuse 审计
6. `06_ARCHITECTURE_SPEC.md` — 总体架构设计说明书
7. `07_DATA_MODEL_AND_THREAD_SPEC.md` — 数据模型与统一会话设计
8. `08_HANDOFF_SPEC.md` — Harness Handoff 详细设计
9. `09_TOOL_AND_ARTIFACT_SPEC.md` — Tool Bus / Artifact / Office 设计
10. `10_BROWSER_AUTOMATION_SPEC.md` — 浏览器自动化设计
11. `11_KNOWLEDGE_BASE_SPEC.md` — 知识库设计
12. `12_MODEL_ROUTER_SPEC.md` — 模型路由与 CC Switch 融合设计
13. `13_SECURITY_AND_PERMISSION_SPEC.md` — 安全、权限与高风险操作规范
14. `14_TEST_AND_ACCEPTANCE_PLAN.md` — 测试与验收计划
15. `15_DEVELOPMENT_PLAN.md` — 研发阶段、里程碑与工作分解
16. `16_RELEASE_DEPLOYMENT_OPERATIONS.md` — 发布、部署、升级与运维
17. `17_RISK_AND_CHANGE_CONTROL.md` — 风险登记与变更控制
18. `18_OPEN_SOURCE_COMPLIANCE.md` — 开源许可与第三方合规
19. `19_TRACEABILITY_MATRIX.md` — 需求追踪矩阵
20. `20_PROJECT_STARTUP_RUNBOOK.md` — 开工前执行手册
21. `99_KICKOFF_PROMPT.md` — 给 Coding Harness 的启动提示词
22. `SOURCES.md` — 本轮审计的主要上游来源

## 四、软件开发流程

本项目按以下顺序推进，禁止跳阶段直接堆功能：

**立项 → 需求冻结 → Build/Reuse 审计 → 架构设计 → 详细设计 → 环境/基线建立 → 分阶段开发 → 单元/集成/回归测试 → V1 验收 → 打包发布 → 运维与变更控制。**

每个阶段必须满足对应 Exit Criteria 才能进入下一阶段。

---

# 项目启动说明书（Project Charter）

## 1. 项目名称

Personal AI Workbench V1（暂名）。

## 2. 项目背景

现有 AI Coding / Agent 工具高度碎片化：Codex、Claude Code、DeepSeek Harness、Qwen Code、Kimi Code、OpenCode 等各自维护 Session、模型配置、工具与上下文。用户切换 Harness 时通常需要重新解释任务，且 Coding、Office、浏览器、知识库、普通聊天又分散在不同产品中。

本项目以 T3 Code 为 UI 壳，将“使用哪个 Harness”“使用哪个模型”“调用哪些工具”“当前任务上下文”拆成独立层，建立一个本地优先、单用户的 Personal AI Workbench。

## 3. 项目目标

### 3.1 核心目标

1. 在一条统一会话中自由选择并切换真实本地 Harness。
2. 切换后由目标 Harness 直接接力当前任务，而不是让用户重新讲一遍。
3. 同一工作台覆盖普通聊天、Coding、Office 文件、PDF、浏览器、知识库。
4. Harness 与 Model 解耦；模型路由能力可替换。
5. 尽可能复用成熟开源项目，避免重复造轮子。

### 3.2 V1 成功标准

- Qwen Code、Kimi Code、DSH 可通过 Generic ACP 接入 T3。
- Codex 与 T3 已有原生 Harness 保持可用。
- Codex → DSH / Qwen / Kimi 以及反向切换可在同一 visible thread 中无感接力。
- Handoff 后目标 Harness 不需要用户重复任务即可继续正确工作。
- Office/PDF 五类文件实现读、析、建、改闭环。
- 浏览器能完成真实登录态任务、表单、上传下载。
- 知识库可完整管理并被所有 Harness 以统一工具调用。
- 模型可独立选择，且 CC Switch 派生能力不成为系统硬依赖。

## 4. 范围

### 4.1 V1 In Scope

- T3 Code Fork 与品牌/信息架构适配。
- Project-bound Canonical Thread / Task State / Artifact Registry / Capability Registry。
- Canonical Thread / Task State / Artifact Registry / Capability Registry。
- Generic ACP Adapter。
- Harness Router 与 Baton ownership。
- 自动 Handoff Engine。
- Workbench Tool Bus（MCP 优先）。
- Office/PDF 工具。
- Browser Tool。
- Knowledge Tool / SAG 集成。
- Model Gateway 抽象；CC Switch-derived adapter。
- 安全审批、审计日志、测试、安装包。

### 4.2 V1 Out of Scope

- 多 Harness 同时并行写同一工作区。
- 企业级多用户、RBAC、SSO、组织治理。
- 导入历史 Codex / Claude / OpenCode Session。
- 云端托管 SaaS。
- 手机端作为 V1 核心交付。
- 自动付款、自动发送不可撤销业务请求等无确认高风险动作。

## 5. 干系人

- Product Owner：用户本人。
- Implementation Agent：Codex/DSH/Qwen/Kimi 等 Coding Harness。
- Upstream Projects：T3 Code、Paseo、Loom、CC Switch、Playwright MCP、SAG 等。

## 6. 技术原则

1. **复用优先**：已有成熟引擎不重写。
2. **单一 UI**：最终用户只使用 Workbench，不需要并行打开多个管理 App。
3. **逻辑松耦合**：用户层完全融合，源码层模块化。
4. **本地优先**：Thread、Artifact、凭据、日志默认本机。
5. **Canonical Thread 为真源**：不把任意 Harness Native Session 当产品主会话。
6. **Artifact-first**：非 Coding 任务是一等公民。
7. **可替换基础设施**：CC Switch/SAG/Browser Engine 均通过接口接入。
8. **安全默认**：高风险外部动作需审批。

## 7. 阶段性 Gate

- Gate 0：上游基线、许可证、开发环境验证完成。
- Gate 1：T3 原生功能回归 + Generic ACP Provider 通过。
- Gate 2：Project-bound Canonical Thread + Core State 通过，不包含完整 Handoff。
- Gate 3：Handoff / Baton V1 通过。
- Gate 4：Tool Bus + Office、Browser、Knowledge 分阶段端到端通过。
- Gate 5：Model Gateway 与 CC Switch-derived core 通过。
- Gate 6：V1 Hardening、全量验收与安装包。

## 8. 变更规则

需求冻结后，任何新增“大功能”必须进入 Change Request，不允许直接塞进当前 Sprint。若发现已有现成轮子，必须重新执行 Build vs Reuse 评估后再开发。

---

# 项目说明书 / 产品总览

## 1. 产品定位

Personal AI Workbench 是一个以任务为中心而不是以代码仓库为中心的本地 AI 工作台。

用户只需要关心两件事：

- **谁来干活（Harness）**：Codex / DSH / Qwen Code / Kimi Code / OpenCode …
- **用哪个脑子（Model）**：GPT / DeepSeek / GLM / Kimi / Qwen / Local …

底层负责统一会话、上下文交接、文件、浏览器、知识库与模型基础设施。

## 2. 目标体验

```text
[Thread: 2027届招聘扫描]
Harness: Codex ▼        Model: GLM ▼

你：继续扫剩余企业，并把结果写进 Excel。
Codex：……

──── 已自动从 Codex 交接给 DeepSeek Harness ────
DSH：已接手。当前完成 438 家，未完成 666 家；我继续从……开始。
```

用户始终处于同一 Thread，不需要重新贴上下文。

## 3. 主要工作域

- 普通聊天与通用知识工作。
- 软件开发 / Shell / Git / Diff。
- Word / Excel / PowerPoint / PDF / 普通文件。
- 浏览器自动操作。
- 本地知识库。
- 多模型选择、用量与路由。

## 4. Project / Workspace 依赖

用户必须先选择或打开 Project / Folder，建立 `Project.workspaceRoot` 后才能创建工作 Thread。Thread 必须显式关联 `projectId`；Harness 运行目录为 `thread.worktreePath ?? project.workspaceRoot`。系统不得创建隐藏个人工作区，也不得提供无 Project 的会话 fallback。

## 5. 核心差异化

真正的核心不是“支持很多 Harness”，而是：

> **不同 Harness 在同一条任务线程里可以交棒，下一 Harness 能直接继续工作。**

围绕这点建立 Canonical Thread、Task State、Artifact Registry 和 Handoff Engine。

---

# 产品需求说明书（PRD）

## 1. 用户画像

单用户、重度 AI 工作流用户；需要在 Coding、文档、网页、知识库之间频繁切换；会使用多家模型与 Harness，希望减少配置、上下文重复和工具割裂。

## 2. 核心用户故事

### US-01 在 Project 中新建任务

作为用户，我希望先选择或打开一个 Project / Folder，再在该 Project 中新建 Canonical Thread 并开始工作。

### US-02 切换 Harness

作为用户，我希望在当前 Thread 中将 Codex 切换为 DSH/Qwen/Kimi，并让新 Harness 立即接着当前任务做。

### US-03 自动交接

作为用户，我不希望阅读/确认交接摘要；系统应自动生成、注入并执行。需要时我可以打开“交接详情”排查。

### US-04 文件工作

我希望拖入 Word/PDF/PPT/Excel，让 Harness 读取、分析、创建新文件、修改已有文件，并将产物留在 Artifact Registry 中。

### US-05 浏览器工作

我希望 Harness 在授权后操作真实浏览器，保留登录态，点击、填表、上传和下载。

### US-06 知识库

我希望在 Workbench 中创建知识库、上传资料、查看解析状态、检索和管理；所有 Harness 均可使用同一知识库。

### US-07 模型独立选择

我希望 Harness 选择与 Model 选择互不绑定，例如 DSH + GPT、Codex + GLM、Qwen Code + DeepSeek。

### US-08 安全审批

我希望付款、删除、提交不可逆表单、发送消息等高风险外部动作在真正执行前得到明确确认。

## 3. 页面需求

### 3.1 左侧

- Thread 列表。
- Knowledge Bases。
- Artifacts / Recent Files。
- 可选 Workspace / Project。

### 3.2 主区

- Canonical Thread。
- Harness handoff 分界线。
- Tool activity 折叠视图。
- Artifact card / preview。

### 3.3 Composer

- Harness Selector。
- Model Selector。
- Attach / Artifact。
- Knowledge scope。
- Browser/Tool 状态。

### 3.4 Settings

- Harnesses。
- Models / Providers。
- MCP / Skills。
- Browser。
- Knowledge。
- Permissions。
- Usage / Cost。
- Diagnostics。

## 4. Handoff 交互

### 空闲状态切换

只改变 Active Harness；下一条用户消息由新 Harness 处理。

### 正在执行时切换

弹出三项：

1. 当前 Turn 完成后交接（默认）。
2. 停止当前 Turn 并立即交接。
3. 取消。

### 未完成任务切换完成后

系统自动：冻结状态 → 生成 Handoff Package → 恢复/创建目标 Native Session → 注入 → 继续执行。

## 5. 成功指标

- 典型 Handoff 任务中，目标 Harness 无需追问“你要我做什么”即可继续：≥ 90%。
- 连续切换 3 次 Harness，Task State / Artifact 不丢失。
- 同一知识库被 4 个 Harness 调用结果一致且可追源。
- Office/Browser 端到端任务成功率达到验收集要求。
- 核心应用不依赖 CC Switch 单独进程即可启动。

---

# 软件需求规格说明书（SRS）

## 1. 功能需求编号

### FR-THREAD

- FR-THREAD-001：只有在已选择 Project / Folder 后才能创建工作 Thread。
- FR-THREAD-002：每条 Thread 有唯一 Canonical ID。
- FR-THREAD-003：保存用户消息、Harness 输出、工具事件、Artifact 引用、Handoff 事件。
- FR-THREAD-004：Thread 必须关联 `projectId`，并从 Project 解析 `thread.worktreePath ?? project.workspaceRoot` 作为工作目录。
- FR-THREAD-005：支持 Thread 标题、归档、删除、搜索。

### FR-HARNESS

- FR-HARNESS-001：保留 T3 原生 Codex/Claude/OpenCode 等 Provider。
- FR-HARNESS-002：新增 Generic ACP Provider。
- FR-HARNESS-003：至少接入 Qwen Code、Kimi Code、DSH。
- FR-HARNESS-004：Active Harness 可在 Thread 中切换。
- FR-HARNESS-005：任一时刻最多一个 Baton Holder。
- FR-HARNESS-006：维护 Canonical Thread ↔ Native Session 映射。

### FR-HANDOFF

- FR-HANDOFF-001：切换时生成结构化 Handoff Package。
- FR-HANDOFF-002：Package 至少包含 Mission、Current State、Completed、Pending、Decisions、Constraints、Artifacts、Browser、Knowledge、Failures、Next Action。
- FR-HANDOFF-003：Handoff Package 自动注入目标 Harness。
- FR-HANDOFF-004：任务处于未完成状态时自动继续执行。
- FR-HANDOFF-005：Handoff 分界线可查看交接详情。
- FR-HANDOFF-006：Handoff 过程必须脱敏，不传递明文密码/API Key/cookie。

### FR-ARTIFACT

- FR-ARTIFACT-001：注册文件、URL、知识源、生成物。
- FR-ARTIFACT-002：维护 path/URI、hash、版本、MIME、创建者 Harness、最后修改时间、读写授权。
- FR-ARTIFACT-003：支持 DOCX/XLSX/PPTX/PDF 读、析、建、改。
- FR-ARTIFACT-004：修改前保留可回滚版本或工作副本。
- FR-ARTIFACT-005：大文件内容不重复塞进 Thread 数据库，只存引用与摘要。

### FR-BROWSER

- FR-BROWSER-001：真实可视浏览器操作。
- FR-BROWSER-002：支持持久化登录状态。
- FR-BROWSER-003：支持 navigate/click/type/select/scroll/upload/download。
- FR-BROWSER-004：下载文件自动注册 Artifact。
- FR-BROWSER-005：高风险动作执行前进入 Permission Gate。

### FR-KB

- FR-KB-001：创建/重命名/删除知识库。
- FR-KB-002：上传并解析文件/网页源。
- FR-KB-003：切片、Embedding、结构化索引、检索。
- FR-KB-004：解析/索引状态可见。
- FR-KB-005：结果可追溯原文。
- FR-KB-006：通过统一 Tool Bus 提供给所有 Harness。

### FR-MODEL

- FR-MODEL-001：Harness 与 Model Selector 独立。
- FR-MODEL-002：支持 Native route、CC Switch-derived route、Custom OpenAI-compatible route。
- FR-MODEL-003：Provider/Model 有健康状态与可用性。
- FR-MODEL-004：记录 usage/cost（可用时）。
- FR-MODEL-005：路由模块替换不影响 Handoff/Thread。

## 2. 非功能需求

### NFR-PERF

- UI 操作响应不应被后台索引/浏览器长任务阻塞。
- Streaming 期间禁止每个 token/小 chunk 重写完整 Thread snapshot。
- 大工具输出写入 Artifact/Blob Store，事件只保存轻量引用。

### NFR-RELIABILITY

- 所有 Native Session 失败不得损坏 Canonical Thread。
- Handoff 必须具备 transaction-like 状态：requested → prepared → injected → accepted → running/failed。
- 崩溃后可恢复 Baton owner 与任务状态。

### NFR-SECURITY

- 凭据进入 OS keychain/安全存储，不进 Handoff Package。
- 浏览器登录数据不得写入聊天记录。
- 高风险 tool call 有统一审批。

### NFR-MAINTAINABILITY

- 第三方组件通过 Adapter/Service 边界接入。
- 第三方版本固定并记录 upstream SHA。
- 禁止复制整套上游 UI 造成双重信息架构。

### NFR-PORTABILITY

- V1 Windows 优先。
- 结构上保持 macOS/Linux 可扩展。

## 3. 兼容边界

- 高级 Office 对象可能存在第三方库无法无损修改的情况；系统必须采用原文件备份、局部编辑和渲染对比，并在无法保证保真时告知用户，而不是静默破坏文件。
- PDF “修改”必须存在可执行路径：对象/页面/表单/标注层优先；必要时可走渲染重建，但必须保留原文件版本。

---

# 最终 Build vs Reuse Audit

**审计日期：2026-09-15**

## 1. 审计结论总表

| 能力                                                 | 决策                    | 复用对象                                    | 原因                                                                                      |
| ---------------------------------------------------- | ----------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 主 UI / Server / Provider 基础                       | Fork                    | T3 Code                                     | 已是多 Harness control surface，保留现有 Provider/Thread/Remote/SQLite 基础               |
| Generic ACP                                          | 适配/借鉴，不从零       | Paseo Generic ACP + ACP 标准                | Paseo 已验证任意 ACP over stdio 模式；T3 尚缺通用入口                                     |
| Qwen Code                                            | 外部 Harness            | qwen --acp                                  | 官方稳定 ACP 模式                                                                         |
| Kimi Code                                            | 外部 Harness            | kimi acp                                    | 官方 ACP 模式                                                                             |
| DeepSeek Harness                                     | 外部 Harness            | dsh --profile acp                           | 官方 stdio ACP server，支持 session persistence/resume                                    |
| Handoff / Baton                                      | 吸收设计与部分实现      | Loom                                        | 已验证 shared brain + baton handoff，MIT；但其产品模型偏 coding，需泛化 Artifact          |
| Native transcript extract/inject                     | V1 不采用               | handoff                                     | 本项目不导入旧 Session，Canonical Thread 自己是真源，V1 无必要引入                        |
| Model Provider / Proxy / Usage / Failover            | 抽取/移植核心           | CC Switch                                   | 本地单用户定位合适，MIT；不复用其整套 UI/Tauri shell                                      |
| LiteLLM                                              | 预留 Adapter，V1 非默认 | LiteLLM                                     | 路由和成本能力强，但引入独立 Python Proxy/DB/Redis 路线过重，且部分能力有 Enterprise 边界 |
| Browser                                              | 直接采用                | Playwright MCP                              | Apache-2.0；真实浏览器、持久 profile、跨 Windows CI、MCP 适合统一 Tool Bus                |
| 视觉 Browser/Computer fallback                       | 延后                    | Agent TARS / UI-TARS                        | 很强但模型/视觉栈更重；V1 浏览器主流程先用 Playwright MCP，接口预留                       |
| 文件解析                                             | 直接采用                | Microsoft MarkItDown                        | MIT；DOCX/XLSX/PPTX/PDF 等统一抽取适合 LLM 分析                                           |
| Word                                                 | 直接采用                | python-docx (+ 可选 Windows Office COM)     | 读/建/改；MIT；COM 可提高 Windows 高保真编辑                                              |
| Excel                                                | 直接采用                | openpyxl / ExcelJS (+ 可选 Office COM)      | 读写成熟，MIT                                                                             |
| PowerPoint                                           | 组合复用                | python-pptx + PptxGenJS (+ 可选 Office COM) | python-pptx 可读/更新；PptxGenJS 创建能力强；均 MIT                                       |
| PDF                                                  | 直接采用                | pdf-lib + MarkItDown                        | pdf-lib MIT，明确支持修改已有 PDF；抽取由 MarkItDown                                      |
| 知识库                                               | 嵌入/Sidecar            | SAG / zleap-sag                             | MIT、本地优先、单用户、解析/切片/索引/追源/API/MCP 已具备；避免自研 RAG                   |
| Canonical Thread                                     | 自研（在 T3 上扩展）    | —                                           | 这是产品核心，现成项目的数据模型均不完全符合通用个人工作台                                |
| Task State / Artifact Registry / Capability Registry | 自研                    | —                                           | Handoff 必需的产品级状态层                                                                |
| Workbench Tool Bus                                   | 自研薄层                | MCP SDK + 上述工具                          | 只做统一权限、审计、注册，不重写工具本身                                                  |

## 2. 关键发现

### 2.1 T3 不应被推翻

T3 已把 provider process、terminal、Git、project files 放在 server/environment 侧，并通过统一 RPC 供 desktop/web/mobile 控制；它适合继续做壳。

### 2.2 历史方案：Managed Personal Workspace（Superseded / Rejected）

早期审计曾建议为无文件夹 Thread 自动绑定隐藏的 Managed Personal Workspace，以兼容 T3 的 cwd 假设。该方案已在 Phase 0 后被正式撤销，仅作为历史决策记录保留。

当前唯一有效模型是 `Project → workspaceRoot → Thread`；若 Thread 使用 worktree，则 cwd 为 `thread.worktreePath ?? project.workspaceRoot`。不得实现 Managed Personal Workspace、Folderless Chat 或隐藏 fallback。

### 2.3 DSH 不再需要专用 JSON-RPC Adapter

DeepSeek Harness 官方已提供 `dsh --profile acp` 的 stdio ACP server，并支持持久 session/list/resume/close。因此 Qwen/Kimi/DSH 均可统一走 Generic ACP。

### 2.4 Handoff 不从白纸设计

Loom 已验证 baton/shared brain 机制。本项目复用其事件/投影/briefing 思路，但 Canonical Thread 从 coding project 泛化为 Task + Artifact + Tool State。

### 2.5 知识库绝对不自研 RAG Core

SAG 已提供本地优先、单用户、文件/网页摄入、解析、切片、Embedding、关系索引、检索、原文追踪、API/MCP；V1 只做嵌入 UI、权限与 Thread 绑定。

### 2.6 Browser 不自研 Agent Loop

Playwright MCP 直接作为 Workbench Browser Tool；使用 persistent profile 保存登录态。视觉 GUI Agent 只做 fallback 插槽，不做 V1 主路径。

### 2.7 Office 不做“一套万能 OOXML 引擎”

采用多个成熟库组合，并用统一 Office Tool API 封装。Windows 有 Office 时可增加 COM 高保真路径；没有 Office 时走跨平台库。

## 3. 明确禁止重复开发的内容

- 不写新的浏览器驱动。
- 不写新的向量数据库/RAG pipeline。
- 不写新的 DOCX/XLSX/PPTX/PDF 文件格式解析器。
- 不写新的模型协议转换器，优先复用 CC Switch 派生模块或现成 adapter。
- 不为 Qwen/Kimi/DSH 各写一套专用 T3 Adapter；优先 Generic ACP。
- 不再做第二套 T3/Paseo/Loom UI。
- 不在 Handoff 中尝试复制模型隐藏 CoT 或不可访问的私有状态。

## 4. 复用方式分级

- **依赖包**：MarkItDown、python-docx、openpyxl、python-pptx、PptxGenJS、pdf-lib。
- **外部本地进程**：Qwen Code、Kimi Code、DSH、Playwright MCP、SAG sidecar。
- **代码/架构吸收**：Loom handoff、CC Switch model infra、Paseo Generic ACP 经验。
- **仅作参考/备用**：LiteLLM、Agent TARS/UI-TARS、handoff transcript tool。

## 5. 开源合规提醒

T3/Loom/CC Switch/SAG/Kimi 多为 MIT；Paseo/Qwen/Playwright 为 Apache-2.0。若直接复制 Apache-2.0 源文件，必须保留对应版权/许可证/NOTICE 要求，不能简单改成 MIT。详见 `18_OPEN_SOURCE_COMPLIANCE.md`。

---

# 总体架构设计说明书

## 1. 目标架构

```text
                  ┌──────────────────────────────┐
                  │        T3 Code Shell         │
                  │ Desktop / Web / Settings UI  │
                  └──────────────┬───────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │    Canonical Thread     │
                    │ Task State / Event Log  │
                    └────────────┬────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
      Artifact Registry    Handoff Engine    Capability Registry
              │                  │                  │
              └──────────────────┼──────────────────┘
                                 │
                       ┌─────────▼─────────┐
                       │  Harness Router   │
                       └─────────┬─────────┘
                                 │
      ┌──────────────┬───────────┼───────────┬─────────────┐
      │              │           │           │             │
   Codex native   Claude     OpenCode    Generic ACP     Others
                                           │
                                  Qwen / Kimi / DSH
                                 │
                       ┌─────────▼─────────┐
                       │ Workbench Tool Bus│
                       │       MCP         │
                       └───┬─────┬─────┬───┘
                           │     │     │
                      Browser  Office  Knowledge
                           │     │     │
                       Playwright libs   SAG
                                 │
                       ┌─────────▼─────────┐
                       │   Model Gateway   │
                       └───┬─────────┬─────┘
                           │         │
                       Native   CC Switch-derived
                           │         │
                       GPT/DS/GLM/Kimi/Qwen/Local
```

## 2. 核心边界

### 2.1 Canonical Thread 是产品真源

Native Session 只是执行器状态；删除/损坏某个 Native Session 不应删除 Canonical Thread。

### 2.2 Harness Router 不关心模型

它只负责 Harness 生命周期、Session、stream、permission/cancel 与 capability。

### 2.3 Model Gateway 不关心 Thread/Handoff

Model routing 故障不能破坏 Handoff 数据。

### 2.4 Tool Bus 统一工具能力

Office/Browser/Knowledge 属于 Workbench，而不是某个 Harness。不同 Harness 通过 MCP/ACP mcpServers/native bridge 使用同一工具集。

## 3. Project Workspace（Phase 1.5 Current Baseline）

- 用户必须先选择或打开 Project / Folder。
- `Project.workspaceRoot` 是 Thread、Harness、Terminal、Git 和文件工具的根目录。
- Thread 必须持有非空 `projectId`，不得脱离 Project 创建。
- Harness cwd 固定解析为 `thread.worktreePath ?? project.workspaceRoot`。
- 不创建 Managed Personal Workspace、全局隐藏 root 或 folderless storage root。

## 4. 事件模型

Canonical Thread 使用追加事件 + 投影：

- user.message
- harness.turn.started / delta / completed / failed
- tool.call.requested / approved / completed
- artifact.added / updated / versioned
- task.state.updated
- handoff.requested / prepared / injected / accepted / failed
- harness.active.changed
- knowledge.query
- browser.navigation/download

大 payload 不存事件正文；存 blob/artifact reference + hash。

## 5. 进程结构建议

- T3 Server：Node/TS，继续作为主后台。
- Python Office Sidecar：仅在需要 python-docx/openpyxl/python-pptx/MarkItDown/SAG engine 时启动。
- Playwright MCP：按需子进程。
- Harness CLIs：T3 按 Provider 启动。
- Model Gateway：V1 可内嵌/sidecar，接口先固定。

## 6. 故障隔离

- Harness crash：Thread 保留，允许 retry 或切换 Harness。
- Browser crash：重启 Browser Tool，不重启 T3。
- SAG crash：知识检索不可用但普通 Thread/Coding 可继续。
- Model Router crash：允许 Native route fallback。
- Office sidecar crash：Artifact 原文件不覆盖，工作副本可恢复。

---

# 数据模型与 Canonical Thread 设计

## 1. 设计目标

- Thread 不属于某个 Harness。
- Thread 明确依附某个 Project，但不属于某个 Harness。
- Artifact、Knowledge、Browser、Task State 可跨 Harness 继承。
- Native Session 是可丢失、可重建的执行缓存。

## 2. 主要实体

### canonical_threads

- id
- title
- environment_id
- project_id
- active_harness_profile_id
- baton_state
- task_status
- created_at / updated_at / archived_at

### harness_profiles

- id
- kind: native | acp
- provider_key
- display_name
- command / args
- capabilities_json
- default_model_route_id

### thread_harness_sessions

- id
- thread_id
- harness_profile_id
- native_session_id
- last_handoff_revision
- status
- created_at / last_used_at

### task_states

- thread_id
- mission
- current_phase
- completed_json
- pending_json
- blockers_json
- decisions_json
- constraints_json
- next_action
- revision

### artifacts

- id
- thread_id nullable
- type
- original_uri/path
- working_uri/path
- content_hash
- mime
- size
- version
- created_by_harness
- write_policy
- metadata_json

### artifact_versions

- artifact_id
- version
- path/blob_ref
- hash
- reason
- created_at

### handoffs

- id
- thread_id
- from_harness
- to_harness
- task_revision
- package_ref
- status
- error
- created_at / accepted_at

### knowledge_bindings

- thread_id
- knowledge_base_id
- scope_mode

### capability_registry

- subject_type: harness/tool
- subject_id
- capability_key
- state: supported/unsupported/unknown
- details_json

## 3. Native Session 策略

- 第一次切到 Harness：创建新 Native Session。
- 之前使用过该 Harness：默认 resume 已有 Native Session，同时注入自上次离开后的 Handoff Delta。
- resume 失败：自动创建新 Session 并注入完整 Handoff Package。
- Native Session ID 永不作为 Canonical Thread ID。

## 4. 存储控制

T3 已有事件/SQLite 体系，但长期线程有数据库膨胀风险。因此：

- streaming delta 进行 coalescing，不每 chunk 落一行持久化快照。
- tool stdout、网页快照、大模型原始 payload、Office 中间文件进 Blob/Artifact Store。
- DB 只保存索引、状态、摘要、hash、引用。
- 支持 thread compaction：保留用户可见消息 + Handoff/Task State，旧细粒度 activity 可归档。

## 5. 删除语义

- 删除 Thread：先删除映射/状态，再按设置决定是否删除托管 Artifact；外部原文件默认不删除。
- 删除某 Harness 配置：Native Session 映射标记 orphan，不影响 Thread。
- 删除知识库：需显式确认；Thread 的历史 citation 仍保留不可变引用信息。

---

# Harness Handoff 详细设计

## 1. 目标

Handoff 的唯一首要 KPI：**目标 Harness 能正确、快速、少重复地继续任务。**

不追求复制不可访问的隐藏思维链、私有缓存或某家 Harness 的内部状态。

## 2. Handoff Package Schema（逻辑）

```yaml
handoff_version: 1
thread_id: ...
from_harness: codex
to_harness: dsh
task_revision: 42
mission: ...
user_intent: ...
current_state: ...
completed:
  - ...
pending:
  - ...
key_decisions:
  - decision: ...
    reason: ...
constraints:
  - ...
artifacts:
  - id: ...
    role: input|working|output
    state: ...
browser_state:
  current_url: ...
  downloads: [...]
  notes: ...
knowledge_state:
  bound_kbs: [...]
  important_citations: [...]
workspace_state:
  cwd: ...
  git_summary: ...
failures_and_attempts:
  - ...
next_action: ...
continuation_instruction: "Continue the task immediately. Do not ask the user to restate it unless a required fact is genuinely missing."
```

## 3. 生成流程

1. Freeze 当前 Turn 的最终事件边界。
2. Materialize 最新 Task State。
3. 收集 Artifact/Browser/Knowledge/Workspace 状态。
4. 从最近对话与关键事件抽取必要上下文。
5. 运行 Handoff Composer 生成结构化包。
6. Secret Redactor 清理凭据、cookie、token、密码。
7. Validator 检查字段完整性和引用有效性。
8. 持久化 package + hash。
9. 建立/恢复目标 Native Session。
10. 注入 package。
11. 目标 Harness 返回 acceptance/ack。
12. 若任务未完成，自动发送 continue 指令并开始执行。

## 4. 自动继续判定

### 自动继续

- 当前 Task State = running / pending。
- 用户是在执行中主动切 Harness。
- 旧 Harness 刚失败，用户选择“换 Harness 继续”。

### 不自动产生新工作

- 当前 task_status = completed。
- 用户在空闲 Thread 仅提前切 Harness。

## 5. 切换中的并发控制

Baton 状态机：

`idle -> held(A) -> handoff_pending -> frozen -> injecting(B) -> held(B)`

在 `handoff_pending/frozen/injecting` 期间禁止两个 Harness 同时获得 write-capable tools。

## 6. 回退策略

- Handoff Composer 失败：不切 baton；当前 Harness 保持 owner。
- 目标 Harness 启动失败：保留 package，提示 retry/选择其他 Harness。
- 目标 Session resume 失败：创建新 Session + full package。
- Tool capability 不足：切换前警告并提供可选 Harness；若用户强制，允许但不静默失败。

## 7. 质量评估

每个 Handoff 测试打分：

- 任务识别准确性。
- 已完成工作识别。
- 未完成工作识别。
- Artifact 可访问性。
- 不重复失败尝试。
- 第一动作是否正确。
- 是否无意义追问。

V1 验收目标：核心测试集中 ≥90% handoff 可直接继续。

---

# Tool Bus、Artifact 与 Office 设计

## 1. Workbench Tool Bus

所有跨 Harness 公共能力以 Workbench Tool Bus 暴露。首选 MCP，因为 Codex/Claude/ACP Harness 均可适配 MCP；对不支持 MCP 的 Harness 再加 native bridge。

统一工具命名空间示例：

- `artifact.*`
- `office.word.*`
- `office.excel.*`
- `office.ppt.*`
- `pdf.*`
- `browser.*`
- `knowledge.*`

Tool Bus 负责：权限、审计、调用关联、Artifact 注册、超时、取消；不负责重写底层文件格式/浏览器/RAG。

## 2. 文件读取/分析

统一抽取：Microsoft MarkItDown。

输出结构：

- normalized text/markdown
- document outline
- tables
- image references
- metadata
- source page/slide/sheet anchors

## 3. Word

优先级：

1. Windows 安装 Microsoft Word 时，可选 Office COM 高保真 adapter。
2. 跨平台 fallback：python-docx。

必须：读取、创建、段落/样式/表格/图片基础编辑、保存新版本。

## 4. Excel

优先级：

1. 可选 Excel COM 高保真 adapter。
2. openpyxl 作为 Python 默认编辑器；必要时 ExcelJS 供 Node 场景。

必须：单元格/公式/样式/表格/工作表/图表基本处理；修改前版本化。

## 5. PowerPoint

- 分析/更新：python-pptx。
- 新建：PptxGenJS 优先，适合 T3/Electron/Node 生态。
- 有 PowerPoint 时可选 COM 用于高保真修改、渲染/导出。

必须：读取 slide/text/shape 信息、创建、增加/删除/修改常见 shape/text/image/table/chart、替换页、保存版本。

## 6. PDF

- 读取/分析：MarkItDown。
- 创建/修改：pdf-lib。
- 支持：页面增删/合并/拆分、文本/图片/矢量添加、表单、附件、metadata、标注/覆盖等。
- 对复杂原生 PDF 文字重排：必要时采用 render/rebuild fallback；原文件必须保留。

## 7. Artifact 生命周期

`imported -> working-copy -> modified -> validated -> committed/output`

任何覆盖原文件前：

- hash current file
- 建立 version snapshot
- 写临时文件
- validation（可打开、结构可读、必要时渲染比较）
- atomic replace

## 8. Artifact 与 Handoff

Handoff 不塞完整文件内容；只传：Artifact ID、角色、版本、可访问路径/授权、摘要、当前修改状态。

---

# 浏览器自动化设计

## 1. V1 主引擎

采用 Microsoft Playwright MCP，不自研 Browser Agent Driver。

理由：

- MCP 原生适配 Tool Bus。
- headed 模式可见。
- 支持 Chrome/Edge/Firefox/WebKit。
- persistent profile 默认可保留 cookie/login。
- Windows 测试链成熟。

## 2. 能力

- navigate / back / forward
- click / double-click
- text input / select / keyboard
- scroll
- file upload
- file download
- tab/window
- screenshot / accessibility snapshot
- 登录态持久化

## 3. Profile 策略

Workbench 管理独立 Browser Profiles：

- `personal-default`
- 可按用途创建 profile
- 不直接复制用户主 Chrome profile 的敏感数据
- 首次需登录的网站，可由用户在可视浏览器中人工登录一次

## 4. 下载/上传

- Browser Tool 下载完成后自动调用 `artifact.register`。
- 上传只能选 Artifact Registry 中已授权文件或用户明确选择文件。

## 5. 高风险动作

以下默认 Require Confirmation：

- 付款/下单。
- 最终提交报名/申请/合同。
- 删除云端数据。
- 发送邮件/消息/发帖。
- 修改账户安全设置。
- 任何明确不可撤销操作。

普通搜索、翻页、下载公开文件、草拟表单可以自动执行。

## 6. 视觉 fallback

V1 预留 `BrowserEngine` 接口；Agent TARS/UI-TARS 可作为未来视觉/DOM 混合 fallback。由于其视觉模型与桌面权限栈更重，不作为 V1 默认依赖。

---

# 知识库设计

## 1. Build vs Reuse 决策

采用 SAG / `zleap-sag` 作为 V1 Knowledge Core；Workbench 不自研 Parser/Chunker/Embedding/Retriever。

## 2. 采用理由

- MIT。
- 本地优先、单用户。
- 默认可从 SQLite + LanceDB 起步，不要求外部数据库。
- 已包含文件/网页来源、解析、切片、Embedding、事件/实体索引、检索、原文追踪。
- 有 REST/OpenAPI、OpenAI-compatible chat、MCP、Python engine。
- 已有 Codex/Claude/DSH 等 Agent 集成路径。

## 3. 集成形态

优先两种方式二选一，Phase 0 PoC 后定：

A. **Python sidecar**：Workbench 启动 SAG API/engine sidecar，通过 localhost 调用。
B. **直接 engine wrapper**：Office/KB Python sidecar 内直接使用 `zleap-sag`。

不复用 SAG 自己完整 UI；知识库 UI 由 T3 Workbench 统一呈现。

## 4. V1 UI 功能

- KB 列表/新建/重命名/删除。
- Source 管理。
- 上传文件/导入网页。
- 解析与索引进度。
- 文档状态/失败原因/重试。
- Search playground。
- Citation 回源。
- Thread 绑定 KB 范围。

## 5. 统一工具

- `knowledge.list_bases`
- `knowledge.search`
- `knowledge.read_source`
- `knowledge.add_source`
- `knowledge.delete_source`
- `knowledge.status`

所有 Harness 只调用 Workbench Knowledge Tool，不直接写 SAG 内部存储。

## 6. 数据归属

知识库属于 Workbench Environment，不属于 Harness 或 Thread；Thread 只保存绑定/引用。

---

# Model Gateway / CC Switch 融合设计

## 1. 原则

CC Switch 可以融入最终产品，但作为 `ModelGateway` 的一种实现，不成为 Canonical Thread/Handoff 的硬依赖。

## 2. ModelGateway Interface

逻辑能力：

- listProviders()
- listModels(provider)
- healthCheck(route)
- resolveEndpoint(route)
- getCredentialRef(route)
- getUsage(range)
- setPricing()
- route/failover policy

Harness Adapter 只获取“如何连接模型”的 route，不直接调用 CC Switch 内部模块。

## 3. V1 路由类型

- Native Harness Route。
- CC Switch-derived Local Proxy Route。
- Custom OpenAI-compatible Route。

## 4. 从 CC Switch 复用的优先模块

- Provider definitions / presets。
- Local proxy core。
- 协议转换。
- health/model test。
- failover / circuit breaker。
- usage / cost accounting。

不复用：

- CC Switch Tauri shell。
- 整套导航/UI。
- 与 Workbench 重复的 Sessions/MCP/Skills 页面。

## 5. CC Switch 缺失时

Workbench 必须仍能：

- 启动。
- 使用 Harness 自己原生 provider。
- 使用 Custom Gateway。
- Handoff/Office/Browser/KB 正常工作。

## 6. LiteLLM 决策

V1 不设 LiteLLM 为默认 Model Router。原因：对单用户桌面 Workbench 来说进程/DB/Redis/管理面更重；保留 `LiteLLMGateway` 扩展点，未来若需 100+ provider、预算策略或团队级治理再接入。

---

# 安全与权限规范

## 1. 信任边界

- Workbench UI / T3 server。
- Harness child processes。
- Tool Bus services。
- Browser profile。
- Knowledge store。
- External model APIs。

## 2. Secret 管理

API key、OAuth token、browser cookie、password：

- 进入 OS Keychain/Credential Manager 或 Harness 自己安全存储。
- Canonical Thread、Handoff Package、日志禁止保存明文。
- Debug export 默认 redaction。

## 3. Tool Risk Levels

### L0 Read-only

读取文件、搜索知识库、浏览公开网页。

### L1 Local reversible write

修改工作副本、生成新文件。

### L2 External reversible

上传文件、创建草稿、修改可恢复云端内容。

### L3 External consequential

发送消息、提交表单、删除云端数据、发布内容。

### L4 Financial/Security critical

付款、下单、账户安全、不可撤销法律/财务动作。

L3/L4 默认必须 Human Confirmation；Harness 切换不能重置审批状态或绕过 Gate。

## 4. Handoff 安全

- SecretRedactor 必经。
- Browser State 只传 URL/业务状态/Artifact，不传 cookie。
- Knowledge 引用传 source ID/citation，不复制受限源全文超过需要。

## 5. 文件安全

- 外部原文件写入前自动版本化。
- 删除外部文件必须单独确认。
- Tool path 规范化，防止目录穿越。

## 6. 第三方进程

- 记录版本与 SHA。
- 默认最小环境变量注入。
- 不把全量 credential env 传给所有 Harness。

---

# 测试与验收计划

## 1. 测试层级

1. Unit。
2. Adapter contract tests。
3. Integration。
4. End-to-end。
5. Handoff benchmark。
6. Security/permission tests。
7. Upgrade/migration tests。
8. Packaging smoke tests。

## 2. 必测矩阵

### Harness

- Codex native。
- Qwen ACP。
- Kimi ACP。
- DSH ACP。
- OpenCode native（回归）。

### Handoff

至少：

- Codex → DSH。
- DSH → Qwen。
- Qwen → Kimi。
- Kimi → Codex。
- 同一 Harness 回切并 resume。
- 当前 Harness 崩溃后交接。

### Task 类型

- Coding。
- 普通聊天。
- Word。
- Excel。
- PPT。
- PDF。
- Browser。
- Knowledge。
- 混合任务（网页下载 Excel → 分析 → 生成 PPT）。

## 3. Handoff Golden Tests

建立不少于 20 个固定任务；每个任务在关键节点强制切 Harness，检查：

- 不要求用户重述。
- 不重复已完成步骤。
- 能打开正确 Artifact。
- 继续正确 next action。
- 不泄漏 secret。

通过标准：≥90% 不需人工补上下文即可继续；其余失败必须有明确可诊断原因。

## 4. Office 验收

每种格式准备：简单、复杂、中文、多图表/多页样本。

- 读取内容一致性。
- 创建文件可被 Office/LibreOffice 打开。
- 修改后未触及区域尽量保持。
- 原文件版本可恢复。
- 渲染对比无明显破坏。

## 5. Browser 验收

- 登录网站并保持 session。
- 多步表单但不最终提交。
- 用户确认后最终提交测试环境表单。
- 上传 Artifact。
- 下载文件并注册 Artifact。
- 高风险动作确认 Gate。

## 6. Knowledge 验收

- 新建 KB。
- 上传 PDF/DOCX/PPTX/XLSX。
- 等待索引。
- 4 个 Harness 查询同一问题。
- citation 能打开原文。
- 删除/重建索引。

## 7. Regression

每个阶段都必须验证 T3 原生：Thread、Codex、OpenCode、Terminal、Git/Diff、Settings、desktop launch 不被破坏。

---

# 研发计划与里程碑

## Phase 0 — Baseline / Build vs Reuse Audit（DONE）

目标：绝不带着错误假设开工。

- Fork 当前 T3 Code。
- 记录 upstream SHA/tag/license。
- 用隔离 T3 home 跑通原版。
- 安装并独立 smoke test：Qwen Code、Kimi Code、DSH。
- 验证命令：`qwen --acp`、`kimi acp`、`dsh --profile acp`。
- PoC Playwright MCP。
- PoC SAG zero-infrastructure/local sidecar。
- 检查 CC Switch core 边界与可移植 Rust 模块。

**Exit**：所有外部组件独立可用，形成 `THIRD_PARTY_LOCK.md`。

## Phase 1 — Generic ACP Provider（DONE）

- Provider kind/driver 扩展。
- ACP process lifecycle。
- initialize/capability/model/session/permission/stream/cancel。
- Qwen/Kimi/DSH 接入。
- Provider Settings UI。

**Exit**：三者可在 T3 新建 Thread 并完成 coding smoke task。

## Phase 2 — Canonical Thread + Core State on Project Workspace

目标：让一个 Project 内的 Thread 成为未来 Harness 切换、Handoff、Artifacts、Tools、Knowledge 的统一宿主。

- Project-bound Canonical Thread。
- Native Session Mapping：不同 Harness 的 native session 可映射到同一 Canonical Thread。
- Task State。
- Artifact Registry（本阶段登记 metadata，不扩张到完整 Office Tool Bus）。
- Capability Registry。
- 保持 `projectId` 与 `thread.worktreePath ?? project.workspaceRoot` 强约束。
- 不实现完整 Baton/Handoff Composer/Validator/Redactor/Auto Continue；这些属于 Phase 3。

**Exit Criteria**：

1. 无 Project 时不能创建工作 Thread。
2. 打开 Project 后可以创建 Canonical Thread。
3. Thread 明确关联非空 `projectId`。
4. Thread 能解析 `thread.worktreePath ?? project.workspaceRoot`。
5. 不同 Harness 的 native session 可以映射到同一个 Canonical Thread。
6. Thread 可以拥有 Task State。
7. Thread 可以登记 Artifact metadata。
8. Thread 可以表达 Harness / Tool capability state。
9. Canonical Thread 不依赖某一个具体 Harness。
10. 不存在 Managed Personal Workspace、Folderless Chat 或隐藏 workspace fallback。

Phase 2 不要求真正完成 Harness Handoff。

## Phase 3 — Handoff / Baton V1

- Baton state machine。
- Handoff Composer/Validator/Redactor。
- 重点复用 Loom shared-brain / baton / briefing / handoff 思路。
- UI 分界线/交接详情。
- Auto continue。
- 20 个 Golden tests 初版。

**Exit**：Codex ↔ DSH/Qwen/Kimi 多轮接力通过目标指标。

## Phase 4 — Tool Bus + Office Integration

- MCP Tool Bus。
- MarkItDown。
- Word/Excel/PPT/PDF adapters。
- Artifact versioning/validation。

**Exit**：四类 Office/PDF 各完成读/析/建/改 E2E。

## Phase 5 — Browser（复用 Playwright MCP，不自研 Browser Driver）

- Playwright MCP lifecycle/profile。
- download/upload artifact bridge。
- permission gates。

**Exit**：登录态多步任务 E2E。

## Phase 6 — Knowledge（复用 SAG / zleap-sag，不自研完整 RAG 引擎）

- SAG sidecar/engine。
- KB UI。
- Knowledge MCP tools。
- citation。

**Exit**：任意 Harness 搜同一 KB 并追源。

## Phase 7 — Model Gateway（复用 CC Switch core，不复用其 UI）

- Gateway abstraction。
- Native/custom routes。
- 移植 CC Switch 核心所需模块。
- health/usage/cost/failover。

**Exit**：Harness selector 与 Model selector 真正独立；拔掉 CC Switch-derived route 仍可运行。

## Phase 8 — Hardening & Release

- DB compaction。
- crash recovery。
- security review。
- updater/installer。
- migration/backup/restore。
- full acceptance。

## 实施规则

- 每 Phase 单独 branch/PR/commit series。
- 未过 Exit Criteria 不进入下一阶段。
- 不并行实现 Browser/KB/Model Router 以避免排障混乱。

---

# 发布、部署与运维说明

## 1. V1 发布形态

Windows x64 Desktop 安装包优先；服务均本机启动。

## 2. 随应用/按需安装组件

- T3-derived desktop/server。
- Python runtime/sidecar（若采用 bundled runtime）。
- Office libraries。
- Playwright MCP + browser binaries/channel。
- SAG engine/API。

Harness CLI 不一定打包，首次设置可检测并指导安装；若许可证/分发允许，可提供可选 installer。

## 3. 数据目录

建议：

- `userdata/state.sqlite`
- `userdata/artifacts/`
- `userdata/blobs/`
- `userdata/browser-profiles/`
- `userdata/knowledge/`
- `userdata/logs/`
- `userdata/backups/`

Secrets 单独由 OS secure storage 管理。

## 4. 升级

- DB migration 必须可回滚/备份。
- 升级前自动 checkpoint + backup。
- 第三方 sidecar 版本固定；升级需 smoke test。
- Upstream T3 merge 采用周期性 rebase/merge，不跟 nightly 自动漂移。

## 5. 诊断

Diagnostics 页面显示：

- T3 version/commit。
- Harness binary/version/status。
- ACP initialize result。
- Browser status/profile。
- Knowledge engine status。
- Model routes health。
- DB size/event count/artifact disk usage。

## 6. 备份恢复

备份至少包括：Canonical Thread DB、Artifacts/Blobs、Knowledge 数据、配置；不明文导出 Secrets。

---

# 风险登记与变更控制

## 1. 主要风险

| 风险                        | 等级 | 应对                                                                                 |
| --------------------------- | ---: | ------------------------------------------------------------------------------------ |
| T3 上游变化快、Fork 冲突    |   高 | 固定 baseline；模块化改造；定期 upstream sync                                        |
| Thread/状态错误脱离 Project |   高 | 保持 `projectId` 与 `workspaceRoot/worktreePath` 强约束；禁止隐藏 workspace fallback |
| 长 Thread SQLite 膨胀       |   高 | delta 合并、Blob 外置、compaction、指标监控                                          |
| 不同 ACP 实现能力不一致     | 中高 | Capability Registry + contract tests                                                 |
| Handoff 质量不稳定          |   高 | 结构化 Task State + Golden tests，而非纯摘要                                         |
| Office 高保真编辑           |   高 | 版本化、局部编辑、Office COM optional、渲染验证                                      |
| Browser 网站差异/反自动化   | 中高 | Playwright 主路径；视觉 fallback 接口预留                                            |
| CC Switch 上游结构耦合      |   中 | 抽象 ModelGateway，仅移植必要 core                                                   |
| 第三方许可证混合            |   中 | THIRD_PARTY_NOTICES + 文件级 license 保留                                            |
| Secret 泄漏到 Handoff/log   |   高 | centralized redactor + tests                                                         |

## 2. Change Request 流程

任何冻结范围之外需求：

1. 建 CR。
2. 说明用户价值。
3. 先执行现成开源扫描。
4. 评估架构影响、测试影响、许可证。
5. Product Owner 批准。
6. 排入后续版本。

## 3. 禁止行为

- “顺手加一下”大功能。
- 未查现成项目就自研底层。
- 未做 migration 就直接改生产 SQLite。
- 用 live userdata 做开发测试。
- 破坏 T3 原生 Provider 为代价实现新 Harness。

---

# 开源许可与第三方合规

> 本文是工程合规清单，不构成法律意见。

## 1. 主要许可证

- T3 Code — MIT。
- CC Switch — MIT。
- Loom — MIT。
- SAG / zleap-sag — MIT。
- Kimi Code — MIT。
- Qwen Code — Apache-2.0。
- Paseo — Apache-2.0（本轮审计按其仓库公开许可处理，实际集成时再次核对具体文件）。
- Playwright / Playwright MCP — Apache-2.0。
- python-docx — MIT。
- python-pptx — MIT。
- PptxGenJS — MIT。
- pdf-lib — MIT。
- MarkItDown — MIT。
- openpyxl — MIT。

## 2. 代码复用规则

### MIT

可以修改/合并/分发，但必须保留版权与许可证文本。

### Apache-2.0

直接复制/修改代码时保留版权、许可证、NOTICE（如适用）及修改说明；不要把 Apache 文件头删掉或宣称其变成 MIT。

## 3. 推荐仓库结构

- 根项目可以继续使用自己的主许可证。
- `THIRD_PARTY_NOTICES.md` 列所有组件、版本、仓库、许可证。
- 对移植的 Apache 源文件保留原 SPDX/file header。
- vendor/submodule 目录保留上游 LICENSE/NOTICE。

## 4. 引入前 Gate

每个第三方组件必须记录：

- repo URL
- exact commit SHA/tag
- license
- copy/modify/link/process 哪种使用方式
- 是否分发二进制
- 是否包含模型权重/额外许可

## 5. 特别提醒

LiteLLM 的开源 core 与 enterprise 目录许可不同；若未来接入，仅使用明确允许的开源部分并重新核对当时版本。

---

# 需求追踪矩阵（RTM）

| 需求                               | 设计                                     | 测试                                       |
| ---------------------------------- | ---------------------------------------- | ------------------------------------------ |
| FR-THREAD-001 Project-bound Thread | Project → workspaceRoot → Thread / 06,07 | 无 Project 拒绝创建 + Project cwd 集成测试 |
| FR-HARNESS-002 Generic ACP         | 06 Harness Router                        | ACP-C01~C10                                |
| FR-HARNESS-003 Qwen/Kimi/DSH       | 05/06                                    | E2E-H01~H03                                |
| FR-HANDOFF-001~006                 | 08                                       | Handoff Golden Suite                       |
| FR-ARTIFACT-001~005                | 07/09                                    | ART-U + Office E2E                         |
| FR-BROWSER-001~005                 | 10                                       | BROWSER-E2E                                |
| FR-KB-001~006                      | 11                                       | KB-E2E                                     |
| FR-MODEL-001~005                   | 12                                       | MODEL-E2E                                  |
| Secret redaction                   | 13                                       | SEC-R01~R20                                |
| Baton single owner                 | 08                                       | CONC-01~05                                 |
| Office 四能力                      | 09                                       | DOCX/XLSX/PPTX/PDF suites                  |
| Legacy session 不导入              | 01/03                                    | Scope check                                |
| 多 Harness 不并行                  | 01/08                                    | Baton tests                                |

开发中每新增 FR/NFR，必须在本表加设计与测试映射，否则不允许标 Done。

---

# 项目启动执行手册

## 0. 总原则

第一天不要写功能代码。先建立可复现基线。

## 1. 建立工作目录

建议新仓库名：`personal-ai-workbench`。

保存：

- `upstream/t3code` remote。
- `origin` 自己的 Fork。
- `docs/spec/` 放本资料。

## 2. 冻结 T3 baseline

1. Clone/Fork T3 Code。
2. 记录当前 upstream commit SHA。
3. 建 tag：`upstream-t3-baseline-YYYYMMDD`。
4. 原版构建、测试、启动。
5. 使用隔离 `.t3`/home，不碰真实 T3 userdata。
6. 保存 baseline screenshots 和 diagnostics。

## 3. 建第三方锁表

创建 `THIRD_PARTY_LOCK.md`，逐项记录 exact SHA/version/license：

- T3 Code
- Paseo（Generic ACP 参考）
- Loom
- CC Switch
- Qwen Code
- Kimi Code
- DeepSeek Harness
- Playwright MCP
- SAG/zleap-sag
- Office libraries

## 4. 独立安装 Harness

逐个验证，不同时排障：

1. Qwen Code：普通 CLI + ACP。
2. Kimi Code：普通 CLI + ACP。
3. DSH：普通运行 + ACP。

每个 Harness 用同一个最小测试目录完成：读取文件 → 修改文件 → shell test → resume session。

## 5. PoC Gate

在改 T3 之前先写 4 个最小 Spike：

- Spike A：独立 ACP client 能 initialize Qwen/Kimi/DSH。
- Spike B：Playwright MCP 能持久 profile 登录 + 下载文件。
- Spike C：SAG 本地引擎/API 能 ingest → search → citation。
- Spike D：Office libraries 对真实样本完成 round-trip edit。

结果写入 `docs/spikes/`。

## 6. 第一个正式开发 PR

只做 **Generic ACP Provider**，不同时做 Handoff/Office/KB/CC Switch。

验收：

- T3 Provider 设置能添加 Generic ACP command。
- Qwen/Kimi/DSH 分别能创建 session、stream、cancel、select model。
- T3 原生 Codex/OpenCode 回归不坏。

## 7. 第二阶段工作

Phase 2：在 Project workspace 上建立 Canonical Thread、Native Session Mapping、Task State、Artifact metadata Registry 与 Capability Registry；不得实现 Managed Personal Workspace 或完整 Handoff。

## 8. 第三阶段工作

Phase 3：实现 Baton、Handoff Composer/Validator/Redactor、Shared Briefing、Auto Continue 与 Harness Switching，并重点复用 Loom 思路。

之后严格按 `15_DEVELOPMENT_PLAN.md` 推进。

---

# 项目启动提示词（直接交给 Coding Harness）

> **历史快照（Superseded）**：以下提示词记录项目启动时的 Phase 0 指令。Phase 0 与 Phase 1 均已完成；后续实施应以本规格的“研发计划与里程碑”、最新 Phase 指令及对应阶段报告为准，不得重新执行本段旧指令。

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

1. 用户必须先选择或打开 Project / Folder；Thread 必须关联 `projectId`，Harness cwd 为 `thread.worktreePath ?? project.workspaceRoot`。禁止 Managed Personal Workspace 和 Folderless Chat。
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

## 历史 Phase 0 工作（DONE / Superseded）：Baseline & Spike

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

---

# Build vs Reuse Audit 主要上游来源

审计日期：2026-09-15。真正实施前仍需锁定 exact commit SHA。

- T3 Code: https://github.com/pingdotgg/t3code
- T3 architecture: https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md
- Paseo: https://github.com/getpaseo/paseo
- Paseo custom/ACP providers: https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md
- Qwen Code: https://github.com/QwenLM/qwen-code
- Qwen ACP settings: https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/settings.md
- Kimi Code: https://github.com/MoonshotAI/kimi-code
- DeepSeek Harness ACP: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md
- Loom: https://github.com/nickthelegend/loom
- handoff: https://github.com/HacksonClark/handoff
- CC Switch: https://github.com/farion1231/cc-switch
- CC Switch manual: https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/README.md
- Playwright MCP: https://github.com/microsoft/playwright-mcp
- Playwright MCP docs: https://github.com/microsoft/playwright/blob/main/docs/src/getting-started-mcp.md
- Agent TARS/UI-TARS: https://github.com/bytedance/UI-TARS-desktop
- SAG: https://github.com/Zleap-AI/SAG
- MarkItDown: https://github.com/microsoft/markitdown
- python-docx: https://github.com/python-openxml/python-docx
- python-pptx: https://github.com/scanny/python-pptx
- PptxGenJS: https://github.com/gitbrent/PptxGenJS
- pdf-lib: https://github.com/Hopding/pdf-lib
- ExcelJS: https://github.com/exceljs/exceljs
- LiteLLM (future alternative): https://github.com/BerriAI/litellm
