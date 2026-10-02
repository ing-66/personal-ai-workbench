# Personal AI Workbench V1 — Phase 0 报告

日期：2026-09-16（Asia/Shanghai）

## 0. 结论

技术路线成立，但当前 Windows 基线尚未达到“原版全量构建通过”：T3 的核心 server/web 依赖已安装，官方开发入口能够进入 dev-runner，但全量安装受 npm registry 超时影响而不完整，导致 dev/build/lint/typecheck 失败。失败均发生在依赖解析/读取阶段，没有证据表明是 T3 业务源码缺陷。

最重要的新发现是：T3 已有成熟的 ACP client/runtime，不需要新写 ACP 协议栈。Phase 1 应只增加可配置的 Generic ACP Provider/Driver，并复用现有 `effect-acp`、`AcpSessionRuntime`、事件归一化、权限和 Session 基础设施。

本轮正式需求覆盖规格中的旧设计：Thread 必须绑定用户已打开的本地文件夹，禁止 folderless chat，取消 Managed Personal Workspace。

## 1. 环境事实

| 项目                  | 事实                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| 工作目录              | `D:\personal-ai-workbench`                                                                                   |
| OS                    | Windows 11，NT 10.0.22631，build 22631.6199，x64                                                             |
| Git                   | 2.55.0.windows.3                                                                                             |
| 系统 Node             | 24.16.0                                                                                                      |
| Vite+ 管理 Node       | 24.21.0（满足仓库 `^24.13.1`）                                                                               |
| npm                   | 11.13.0                                                                                                      |
| 系统 pnpm             | 11.19.0                                                                                                      |
| 仓库声明 pnpm         | 11.10.0                                                                                                      |
| Vite+                 | 安装器为 0.3.2；仓库依赖为 0.3.0                                                                             |
| Python                | 3.13.15；另有 3.12.10                                                                                        |
| Rust / Cargo / rustup | 未安装或不在 PATH                                                                                            |
| Tauri                 | T3 本身不使用 Tauri；桌面壳是 Electron。仓库无 `tauri.conf.*`。Rust 仅用于 `native/*` 辅助程序和部分桌面打包 |

Windows 安装包构建还缺 Rust、Visual Studio Build Tools（Desktop development with C++）、Windows SDK、MSVC/Spectre 库。普通 server/web 开发不要求 Rust。

## 2. Git 基线

| 项目        | 值                                                                         |
| ----------- | -------------------------------------------------------------------------- |
| remote      | `origin https://github.com/pingdotgg/t3code`（fetch/push）                 |
| branch      | `main`，跟踪 `origin/main`                                                 |
| HEAD        | `c1b2210411da79350a3f9f5a65a4a64971e4acad`                                 |
| commit      | `fix(desktop): keep the sidebar brand and window buttons aligned (#11906)` |
| tag at HEAD | 无                                                                         |
| clone       | `--depth 1` 浅克隆                                                         |
| license     | MIT，Copyright 2026 T3 Tools Inc.                                          |

业务源码无修改。当前 Git 非干净的原因是用户提供的 `docs/project-specs/` 本来就是未跟踪目录，以及本报告。`node_modules` 和隔离 `.t3` 状态不进入 Git。

## 3. 仓库与文档基线

主要目录：

- `apps/server`：WebSocket/RPC、事件编排、Provider、Session、SQLite、MCP、Git/checkpoint。
- `apps/web`：React/Vite 主客户端。
- `apps/desktop`：Electron 壳。
- `apps/mobile`：React Native 客户端。
- `packages/contracts`：跨 server/client 的 Effect Schema/RPC 合同。
- `packages/client-runtime`：Web/Mobile 共用状态与客户端逻辑。
- `packages/effect-acp`：ACP v1 JSON-RPC stdio client/agent/runtime 基础。
- `packages/shared`：共享运行时工具。
- `native`：resource monitor、Linux snapshot、browser-secret、Ghostty VT 等原生组件。
- `docs/internals`、`docs/operations`、`docs/user`：架构、维护和用户文档。

已完整阅读 `README.md`、`CONTRIBUTING.md`、`docs/internals/overview.md`、`docs/project-specs/MASTER_SPEC.md`、`docs/project-specs/99_KICKOFF_PROMPT.md`；并阅读了 `AGENTS.md`、开发 runbook、glossary、provider constraints 和相关源码。

需求优先级：本轮用户指令 > `MASTER_SPEC.md` > `99_KICKOFF_PROMPT.md`。因此所有“无文件夹 Thread / Managed Personal Workspace”条款均作废，其余冻结需求保留。

## 4. 依赖、启动、build/test/lint/typecheck

### 4.1 依赖安装

- 官方 Vite+ Windows 安装命令执行成功，但 `current` shim 链接异常；版本目录中的 0.3.2 可执行文件可用。
- `vp i` 两次全量安装均在 `apps/mobile` 的 direct dependency 下载阶段因 registry timeout 退出。
- 随后按锁文件定向安装 root + scripts + server + web 及依赖成功，共覆盖 10/16 workspace。
- 未修改 lockfile 或源码。

### 4.2 原版启动

命令：`vp run dev --home-dir D:\personal-ai-workbench\.t3\phase0`

- dev-runner 成功选择 `serverPort=13773`、`webPort=5733`。
- 状态严格位于仓库内隔离目录 `.t3\phase0`；未读取或写入真实 `~/.t3/userdata`。
- 启动失败：Web Vite 配置加载时找不到 `@babel/core/index.js`。这是中断/不完整依赖树的直接结果。
- 没有遗留开发服务器进程。

### 4.3 检查矩阵

| 检查                                                     | 结果 | 证据/原因                                                              |
| -------------------------------------------------------- | ---- | ---------------------------------------------------------------------- |
| `vp run build`                                           | 失败 | task planning 找不到 `apps/marketing` 的 `astro`，全量依赖未完成       |
| `vp run test`                                            | 失败 | 沙箱读取 `node_modules/.../vitest.mjs` 返回 EPERM，4 个 workspace 失败 |
| `vp run lint`                                            | 失败 | `oxlint-plugin-t3code` 无法解析 `@oxlint/plugins`，依赖不完整          |
| `vp run typecheck`                                       | 失败 | task planning 找不到 `apps/marketing` 的 `astro`                       |
| `pnpm --filter effect-acp test`（沙箱外复核）            | 通过 | 5 files，40 tests                                                      |
| `vp test run apps/server/src/provider/acp`（沙箱外复核） | 通过 | 13 files passed、2 skipped；230 passed、8 skipped                      |

未为通过测试而修改源码。全量基线的下一步只能是网络稳定后重新完成 `vp i`，然后原样重跑，不能把当前失败归类为产品回归。

## 5. T3 当前架构地图

核心流：Client RPC → `OrchestrationEngine` → pure `decider` → SQLite event + projection + command receipt 同事务提交 → reactors 执行副作用 → `ProviderService` → instance registry → provider adapter → provider process。Provider runtime events 经 ingestion/normalizer 回写编排事件和投影。

关键位置：

- 合同：`packages/contracts/src/orchestration.ts`、`providerRuntime.ts`、`providerInstance.ts`、`model.ts`。
- 编排：`apps/server/src/orchestration/decider.ts`、`projector.ts`、`Layers/OrchestrationEngine.ts`、`Layers/ProviderCommandReactor.ts`、`Layers/ProviderRuntimeIngestion.ts`。
- 持久化：`apps/server/src/persistence/Migrations/`、`Layers/OrchestrationEventStore.ts`、`Layers/Projection*.ts`。
- Provider SPI：`apps/server/src/provider/ProviderDriver.ts`、`Services/ProviderAdapter.ts`、`Layers/ProviderInstanceRegistryLive.ts`、`Layers/ProviderService.ts`。
- Session 绑定：`apps/server/src/provider/Layers/ProviderSessionDirectory.ts`、`persistence/ProviderSessionRuntime.ts`。
- ACP：`packages/effect-acp`、`apps/server/src/provider/acp/AcpSessionRuntime.ts`、`AcpRuntimeModel.ts`、`AcpCoreRuntimeEvents.ts`。
- MCP/工具：`apps/server/src/mcp`，现有 server toolkits 为 device、preview、pullRequests。
- Checkpoint：`apps/server/src/checkpointing/CheckpointStore.ts`。

## 6. T3 对核心概念的真实表示

### Workspace / Project

`OrchestrationProject` 必有 `id`、`title`、`workspaceRoot`。`ProjectCreateCommand` 的 `workspaceRoot` 也是必填非空字符串。数据库 `projection_projects.workspace_root` 持久化根目录。

### Thread

`OrchestrationThread` 必有 `projectId`，另含 modelSelection、runtimeMode、interactionMode、branch/worktreePath、messages、activities、checkpoints、session。数据库 `projection_threads.project_id` 非空并建索引；`ThreadCreateCommand.projectId` 必填。

### Provider

分为 driver kind 与 provider instance。`ProviderDriver` 解码实例配置并创建独立 `ProviderInstance`；instance 聚合 snapshot、adapter、text generation 和可选 auth。运行时按 `ProviderInstanceId` 路由，支持同 driver 多账号/多实例。

### Harness Session

产品 Thread 与 provider Session 分离。`OrchestrationSession` 保存 threadId、status、providerName、providerInstanceId、runtimeMode、activeTurnId。`provider_session_runtime` 以 `thread_id` 为主键保存 adapter、resume cursor、runtime payload 和 last seen；内存 adapter session 可退出，绑定仍可恢复。

### Model

`ModelSelection` 与 provider instance 绑定，包含 model slug 与 provider options。模型清单由 provider snapshot/runtime discovery 提供，T3 目前并未实现独立于 Harness 的通用 Model Gateway；“Harness/Model 完全解耦”仍是 Workbench 新能力。

### Tool

Provider 原生事件被归一化为 `command_execution`、`file_change`、`mcp_tool_call`、`dynamic_tool_call`、`collab_agent_tool_call`、`web_search`、`image_view` 等 canonical item/activity。MCP 有 session registry、credentials 和 server toolkits，但尚无 Workbench-wide Office/Browser/Knowledge Tool Bus。

### Artifact

当前没有规格所述通用 Artifact Registry/版本模型。已有的“artifact”主要是附件、preview/browser recording、构建产物和 Codex artifact-template 展示，不能视为统一 Artifact 领域对象。

### Permission

Thread 保存 `runtimeMode`；adapter 把 provider 的 approval/user-input 请求归一化为 pending request/activity，通过 `respondToRequest` / `respondToUserInput` 回传。ACP runtime 已处理 `session/request_permission`，并映射 allow-once/allow-always/reject-once。尚无跨 Browser/Office/Knowledge 的统一 L0–L4 Permission Gate。

## 7. Provider / Harness 接入现状

`BUILT_IN_DRIVERS` 的真实集合：

- Codex：原生 app-server adapter。
- Claude Code：Claude Agent SDK adapter。
- OpenCode：SDK/server adapter；T3-managed chat 每 Thread 一个 server。
- Cursor：ACP adapter。
- Grok Build：ACP adapter及 xAI extensions。
- Antigravity：ACP adapter及 Google/Antigravity extensions、独立 profile/auth。

因此 T3 已是多 Harness control surface，并且 Provider instance/driver 边界可继续复用。Qwen、Kimi、DSH 当前均不在 built-in driver 列表，也没有通用配置项可直接注册任意 ACP command。

## 8. ACP 现状

### 已有

- `packages/effect-acp`：ACP v1 JSON-RPC stdio、schema、client/agent、child-process transport。
- `AcpSessionRuntime`：spawn、initialize、authenticate、session new/load/resume、prompt stream、cancel、model/mode/config option、MCP servers、filesystem/terminal callbacks、permission、extension request/notification。
- `AcpRuntimeModel` / `AcpCoreRuntimeEvents`：ACP updates 到 T3 canonical runtime events 的归一化。
- Cursor/Grok/Antigravity 已在生产 adapter 中验证这套 runtime。
- 270 个相关测试通过，证明协议基础不是空壳。

### 缺失

没有 Generic ACP Provider。现有 ACP adapters 仍包含各自 CLI 探测、启动参数、resume 语义、extensions、auth 和事件细节。

### Generic ACP 最小改造面（仅规划，不实现）

1. 在 contracts/settings 增加 generic ACP instance config：display name、command/args、env 引用、cwd policy、MCP capability override、resume method。
2. 新增 `GenericAcpDriver`，注册到 `BUILT_IN_DRIVERS`，复用现有 instance lifecycle。
3. 新增薄 `GenericAcpAdapter`，组合 `AcpSessionRuntime`、`AcpRuntimeModel`、`AcpCoreRuntimeEvents`，实现 `ProviderAdapterShape`。
4. 增加 CLI probe/diagnostics：binary resolve、version、initialize、session/new、capabilities/models/modes。
5. 让 provider snapshot/model catalog 来自 ACP initialize/session config discovery。
6. 增加 driver/adapter contract tests，并用 Qwen/Kimi/DSH 做外部 conformance tests。

不应复制三套 provider adapter，也不应重写 JSON-RPC、stdio、stream、cancel、permission 或 event normalization。

## 9. Workspace / Thread 现状与新需求

结论：T3 Thread 已天然且强制依赖 Workspace/Project，新需求可以直接沿用现有模型。

数据链证据：

1. `project.create` 要求 `workspaceRoot`。
2. `thread.create` 要求 `projectId`。
3. `OrchestrationThread.projectId` 非空。
4. `projection_threads.project_id` 非空并关联/索引项目。
5. ProviderCommandReactor 根据 Thread 查 Project，以 `thread.worktreePath ?? project.workspaceRoot` 计算 provider cwd。
6. checkpoint、Git/diff、terminal 和 provider process 都使用该 cwd。

因此“必须先选择/打开本地文件夹才能创建和开始对话”与 T3 原生架构一致。Phase 1 不需要 Managed Personal Workspace、nullable projectId 或 folderless 分支；只需确保所有创建 Thread 的入口在未选 Project 时不可用并给出一致提示。是否每个 UI 入口已完全阻止无项目创建，需 Phase 1 做多 surface 行为回归，但数据层已经强制约束。

## 10. Session 恢复、Provider 切换、消息持久化

- 消息：用户/助手消息与 activity 由事件驱动写入 `projection_thread_messages` / `projection_thread_activities`；Thread 本身跨 provider process 生命周期持久存在。
- Session：adapter 返回 provider-specific `resumeCursor`；`ProviderSessionDirectory` 在 `provider_session_runtime` 保存 binding/runtime payload。服务重启后可按 binding 重新创建或恢复。
- Provider 切换：当前 `ModelSelection.instanceId` 决定路由；ProviderCommandReactor 检测 desired/current provider、instance、model、runtime mode 差异，并按能力复用或重启 Session。
- 重要限制：`provider_session_runtime` 以 threadId 为主键，当前模型是一条 Thread 对应一个活动 provider binding，而不是规格设想的“每 Thread × Harness 多条 Native Session 映射”。切换可能覆盖当前 binding，尚无完整 handoff/baton/多 Harness resume map。
- 消息真源已经是 T3 Thread/event log，而不是单个 provider transcript，这为 Canonical Thread 和后续 Handoff 提供了良好基础。

## 11. Qwen / Kimi / DSH 接入前提

### 本机状态

| Harness          | 命令   | 本机状态 | ACP 实测     |
| ---------------- | ------ | -------- | ------------ |
| Qwen Code        | `qwen` | 未安装   | 无法本机握手 |
| Kimi Code CLI    | `kimi` | 未安装   | 无法本机握手 |
| DeepSeek Harness | `dsh`  | 未安装   | 无法本机握手 |

遵照要求，未安装、未执行未知第三方脚本、未写正式 adapter。

### 官方入口核验

- Qwen：官方 settings 明确 `--acp` 为稳定参数，替代旧 `--experimental-acp`。Windows 官方安装：`irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex`；亦可 `npm install -g @qwen-code/qwen-code@latest`（Node 22+）。来源：https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/settings.md
- Kimi：官方 README 明确 `kimi acp`；Windows 官方安装：`irm https://code.kimi.com/kimi-code/install.ps1 | iex`，并要求 Git for Windows/Git Bash。来源：https://github.com/MoonshotAI/kimi-code
- DSH：官方 ACP README 确认 `dsh --profile acp` profile，支持 initialize、new、list、resume、close、prompt stream、cancel、MCP；官方根 README 当前推荐 `npx @deepseek-ai/dsh web` 或 clone + pnpm build。建议先用 `npx @deepseek-ai/dsh --profile acp --help` 做无安装验证；如需固定版本，应在确认版本后安装/锁定，而不是使用社区 ACP 插件。来源：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md

DSH 仍标记 developer preview，并明确可能发生 breaking changes，是三者中最高的版本漂移风险。

## 12. Build vs Reuse 最终修订

| 模块                 | 决策                 | 理由                                                                                                                                           |
| -------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-Harness 接入   | Fork                 | 继续 Fork T3 的 driver/instance/adapter/orchestration，不建第二套壳                                                                            |
| Generic ACP          | Fork + Extract       | 主要 Fork/组合 T3 已有 ACP runtime；从 Paseo Extract 配置、诊断和 capability override 思路，不整包搬入                                         |
| Harness Handoff      | Extract + Build      | Extract Loom 的 persisted baton、event projection、briefing/fallback；在 T3 event model 上 Build Artifact/Task-aware 状态，不复用 Loom UI      |
| Model Router         | Build thin interface | T3 当前 model 与 provider instance 绑定，需要独立 `ModelGateway` 边界                                                                          |
| CC Switch 核心能力   | Extract              | 只抽 provider preset、proxy、health、usage、failover；不复用 Tauri shell/UI/session 页面                                                       |
| Browser Automation   | Reuse                | Playwright MCP 已覆盖 headed、persistent profile、navigate/click/type/upload/download；只 Build lifecycle/permission/artifact bridge           |
| Office 文档能力      | Reuse                | 复用 MarkItDown、python-docx、openpyxl/ExcelJS、python-pptx/PptxGenJS、pdf-lib、可选 Office COM；只 Build 统一 tool adapter/version/validation |
| Knowledge Base / RAG | Reuse                | SAG 已覆盖本地 SQLite+LanceDB、ingest/index/search/citation、REST/MCP；只 Build sidecar lifecycle、权限和 T3 UI binding                        |

现成项目适用性：

- T3 Code：主壳和事件/Provider/ACP 基础，适用且比原规格预估更完整。
- Paseo：Generic ACP 已完整覆盖用户配置、诊断、MCP capability override；适合作为设计/行为参考，但不替换 T3。
- Loom：coding 场景的 shared brain/baton/briefing 已覆盖，适合提取机制；不覆盖通用 Office/Browser/KB Artifact 语义。
- CC Switch：仍适合抽取模型/配置/代理能力；Tauri UI 与 Workbench 重复，不应整合。
- Playwright MCP：仍是浏览器主轮子；默认持久 profile，支持显式 `--user-data-dir`。
- SAG：仍完整覆盖 RAG core；无需自建 parser/chunker/vector DB/retriever。
- Qwen/Kimi/DSH：三个 ACP 入口都在当前官方文档中真实存在。

没有发现一个新项目能完整替代 T3 + Handoff + Tool Bus + Office + Browser + KB 的总体产品，但 Paseo 已完整覆盖“Generic ACP Provider”这一子问题，必须先吸收其设计，不可重复发明。

## 13. 风险

1. 当前为浅克隆且只有 `origin`，未建立规格建议的独立 upstream/fork remote/tag；在用户决定 fork remote 前不应擅自改 remote 或打 tag。
2. npm registry 不稳定使全量依赖树不完整；Phase 1 前必须完成 `vp i` 并重跑原版基线。
3. Vite+ 全局 `current` shim 安装异常，当前依赖仓库本地 0.3.0；需在环境修复时避免混用 0.3.2/0.3.0。
4. Rust/Cargo/VS Build Tools 缺失，Windows installer/native build 未验证。
5. 本机 Codex shim 存在但缺 `@openai/codex-win32-x64`；Claude/OpenCode/agent/Grok 不在 PATH，无法完成真实 provider smoke。
6. DSH developer preview、安装依赖和 ACP 扩展可能快速变化，必须锁版本并做 contract test。
7. 不同 ACP agent 对 `mcpServers`、client fs/terminal、session resume 和 model config 的支持不一致，需 capability-driven adapter，不能假设统一。
8. 当前每 Thread 仅一条 provider runtime binding；Handoff 需要新增多 Harness session mapping，不能把现有 binding 直接当最终数据模型。
9. 当前没有通用 Artifact Registry、Workbench Permission Gate 或独立 Model Gateway。

## 14. 与规格冲突

必须删除或重写的旧条款包括：项目一句话定义中的“不依赖代码项目文件夹”、冻结决策中的 Managed Personal Workspace、US-01、FR-THREAD-001/004、架构第 3 节、数据模型的 `managed_workspace_id`、Phase 2 folder-independent Thread、RTM 的 E2E-T01、startup runbook 中 Managed Workspace 相关步骤。

Kickoff 的 Phase 0 还要求直接创建 `THIRD_PARTY_LOCK.md`、安装三个 Harness，并执行 Browser/Knowledge/Office spikes；本轮更具体指令规定 Harness 仅做存在性/接口验证、未安装先等待确认，并禁止开发/集成 Browser、Office、Knowledge。本报告遵循本轮指令：没有安装 Harness，也没有运行这些外部 spike。

原规格判断“T3 尚缺通用 ACP 入口”只对 UI/config/driver 层成立；协议 client/runtime 已存在且成熟。Phase 1 工作量应据此下调。

## 15. 建议的 Phase 1 最小范围

Phase 1 只做 Generic ACP：

1. 先恢复干净可重复的全量原版基线。
2. 固定并安装经用户确认的 Qwen/Kimi/DSH 版本，在一次性目录完成 ACP conformance matrix。
3. 定义最小 generic ACP instance config 和 capability overrides。
4. 组合现有 `AcpSessionRuntime` 实现一个 Generic driver/adapter。
5. 只接通 initialize/new/resume/prompt/stream/cancel/permission/model/mode/MCP。
6. 对三 Harness 建 contract tests，保留现有六个 built-in providers 的回归。
7. 不做 Handoff、不做多 session mapping、不做 UI 改造之外的其他模块；若设置 UI 不是 Phase 1 明确授权，可先以配置/测试入口验证。

“必须先打开文件夹才能聊天”无需数据库重构；保持 projectId/workspaceRoot 强约束即可。只需后续核查所有客户端入口一致性。

## 16. 绝对不要重复开发

- ACP JSON-RPC/stdio client、schema、initialize/session/prompt/cancel/permission/event normalization。
- 为 Qwen、Kimi、DSH 各写一套 T3 adapter。
- 新的浏览器驱动或 Browser Agent loop。
- 新的 DOCX/XLSX/PPTX/PDF parser/serializer 全栈。
- 新的 RAG pipeline、parser、chunker、vector DB、retriever、citation engine。
- 第二套 T3/Paseo/Loom UI、Thread 列表或 Provider 管理壳。
- CC Switch 的 Tauri shell、整套 UI、重复的 MCP/Skills/Session 页面。
- Handoff 中不可访问的隐藏 CoT/私有状态复制。
- 隐藏 Managed Personal Workspace 或任何 folderless chat fallback。

## 17. Gate 结论

Phase 0 的架构和复用路线验证通过；原版全量环境基线未通过，原因已定位为依赖下载/链接不完整和沙箱读取限制。进入 Phase 1 前的硬 Gate 是：网络稳定后完成全量 `vp i`，原样启动 server/web，并重新运行 build/test/lint/typecheck；随后经用户确认安装并锁定三个 Harness，执行真实 ACP 握手矩阵。

本报告未进入 Phase 1，未修改 T3 业务源码。
