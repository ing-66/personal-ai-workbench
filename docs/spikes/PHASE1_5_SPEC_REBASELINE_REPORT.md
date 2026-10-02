# Phase 1.5 Spec Rebaseline Report

## 1. Result

PASS

所有具有当前规范效力的文档已统一到 `Project → workspaceRoot/worktreePath → Thread`。本阶段只修改文档，没有实施 Phase 2，也没有新增业务源码改动。

## 2. Obsolete Requirements Found

在 `MASTER_SPEC.md` 与历史启动提示中发现以下失效要求：

- 产品定义要求 Thread 不依赖代码文件夹。
- 冻结决策及 V1 Scope 包含 Managed Personal Workspace。
- 产品总览允许直接创建空白 Thread，并使用隐藏 cwd。
- US-01、FR-THREAD-001、FR-THREAD-004 允许无 Project 创建 Thread。
- 架构章节定义受管隐藏目录和无显式 Project 的默认 cwd。
- `canonical_threads` 使用 `managed_workspace_id`。
- Phase 2 被定义为 Folder-independent Thread，并以“无用户指定目录可创建普通 Thread”为 Exit。
- 风险、RTM、启动 Runbook 和嵌入式启动提示仍把 Managed Personal Workspace 当作后续实现。
- Gate 2 将 Core State 与 Handoff PoC 混在同一阶段。

## 3. Requirements Superseded

以上要求均被下列正式基线替代：

```text
Open / Select Project or Folder
  -> Project.workspaceRoot
  -> Canonical Thread(projectId)
  -> Harness / ACP process
```

若 Thread 使用 worktree：

```text
cwd = thread.worktreePath ?? project.workspaceRoot
```

系统不得创建 Managed Personal Workspace、Hidden Personal Workspace、Folderless Chat 或无 Project fallback。

## 4. Current Workspace Model

`Project → workspaceRoot/worktreePath → Thread` 是唯一正式模型：

- 无 Project 时不能创建工作 Thread。
- Thread 必须持有非空 `projectId`。
- Canonical Thread 属于 Project，但不属于任一具体 Harness。
- Native Session、Task State、Artifact metadata 和 Capability State 均依附 Project / Thread。
- Harness cwd 只能来自 Project workspaceRoot 或 Thread worktreePath。

## 5. Updated Phase Roadmap

- Phase 0 — Baseline / Build vs Reuse Audit — DONE
- Phase 1 — Generic ACP Provider — DONE
- Phase 2 — Canonical Thread + Core State on Project Workspace
- Phase 3 — Handoff / Baton V1，重点复用 Loom shared-brain / baton / briefing / handoff
- Phase 4 — Tool Bus + Office Integration
- Phase 5 — Browser，复用 Playwright MCP，不自研 Browser Driver
- Phase 6 — Knowledge，复用 SAG / zleap-sag，不自研完整 RAG 引擎
- Phase 7 — Model Gateway，复用 CC Switch provider/proxy/usage/failover core，不复用其 UI
- Phase 8 — Hardening / Release

## 6. Updated Phase 2 Definition

Phase 2 为 **Canonical Thread + Core State on Project Workspace**。

在 Project-bound Canonical Thread 上建立：

- Native Session Mapping；
- Task State；
- Artifact metadata Registry；
- Capability Registry。

Phase 2 不实现 Baton、Handoff Composer、Validator、Redactor、Shared Briefing、Auto Continue 或完整 Harness Switching；这些严格属于 Phase 3。

## 7. Updated Exit Criteria

1. 无 Project 时不能创建工作 Thread。
2. 打开 Project 后可以创建 Canonical Thread。
3. Thread 明确关联非空 `projectId`。
4. Thread 能解析 `thread.worktreePath ?? project.workspaceRoot`。
5. 不同 Harness 的 native session 可以映射到同一个 Canonical Thread。
6. Thread 可以拥有 Task State。
7. Thread 可以登记 Artifact metadata。
8. Thread 可以表达 Harness / Tool capability state。
9. Canonical Thread 不依赖某一个具体 Harness。
10. 不存在 Managed Personal Workspace fallback。

## 8. Historical Records Preserved

- `PHASE0_REPORT.md` 保留了旧方案、冲突发现及撤销结论，未被改写。
- `PHASE1_IMPLEMENTATION_AUDIT.md` 与 `PHASE1_REPORT.md` 保留了 Phase 1 的实际架构和验证事实。
- MASTER 的 Build vs Reuse 历史判断没有被伪造成从未发生；相关段落明确标为 `Superseded / Rejected` 并记录替代模型。
- `99_KICKOFF_PROMPT.md` 作为 Phase 0 历史快照保留，并增加醒目的 Superseded 状态说明；其中产品模型已更新，避免被后续 Harness 当作有效旧需求执行。

## 9. Files Changed

- `docs/project-specs/MASTER_SPEC.md`
- `docs/project-specs/99_KICKOFF_PROMPT.md`
- `docs/spikes/PHASE1_5_SPEC_REBASELINE_REPORT.md`

## 10. Source Code Changes

本次 Phase 1.5 新增业务源码修改：**0**。

工作区中仍存在 Phase 1 已完成但未提交的 Generic ACP 源码改动；本任务完整保留它们，没有修改、重置、清理或暂存。Phase 1.5 的新改动全部位于 `docs/`。

## 11. Git Diff Summary

- 文档当前规格已移除所有正向要求的 Managed Personal Workspace / Folderless Thread。
- 历史记录中的相关词汇仅出现在明确的 Superseded、Rejected、禁止或“已取消”语境。
- 未执行 commit、push、tag、reset、clean 或 stash。
- `git diff --check` 已通过。

## 12. Phase 2 Readiness

规格层面已具备正式进入 Phase 2 的条件，且 Phase 2/Phase 3 边界清晰。进入需要完整 build/UI 验证的工作前，仍应恢复 Phase 0/1 已记录的 workspace dependency、Vite+ shim、`react/jsx-runtime` 与 Node types 环境基线；不得通过产品架构或业务源码绕过这些环境问题。
