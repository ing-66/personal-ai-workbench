# Phase 2 Report

## 1. Result

PASS

Phase 2 promotes the existing Project-bound T3 Thread to the Workbench Canonical Thread and adds only the missing core-state relations. It does not implement Baton, Handoff, briefing, auto-continue, Browser, Knowledge, Model Gateway, or Phase 3 behavior.

## 2. Baseline Status

The workspace dependency baseline was restored successfully with the lockfile-declared dependencies:

```text
vp 0.3.2 i --frozen-lockfile
16 workspace projects
1880 packages installed
exit 0
```

The global Vite+ `current` shim still points to a missing executable, so commands used the installed `0.3.2` executable directly. The prior missing `react/jsx-runtime` and incomplete dependency tree were restored. Package typecheck still exposes the pre-existing Node `Buffer`/Node global type errors recorded in Phase 0/1; no product-source shim or tsconfig relaxation was added.

## 3. Implementation Audit Summary

The audit found that:

- `OrchestrationThread` is already durable, provider-neutral, and Project-bound, so it is the Canonical Thread.
- `ProviderSessionDirectory` plus `provider_session_runtime` already owns provider instance identity, adapter identity, resume cursor/native session data, payload, timestamps, and status.
- `projection_thread_sessions` is the current active-session UI projection, not native-session persistence.
- no existing generic thread Task State or workspace-bounded Artifact metadata registry exists.
- provider/ACP capabilities already have reported/runtime/default and Generic ACP override sources, so a derived view is safer than a persisted duplicate.

Full audit: `docs/spikes/PHASE2_IMPLEMENTATION_AUDIT.md`.

## 4. Canonical Thread

The existing `OrchestrationThread` / `projection_threads` model is the only Canonical Thread source of truth. No `CanonicalThread` entity or table was added.

It remains Harness-neutral: provider identity and native session state live outside the thread identity. Required `thread.id`, non-null `thread.projectId`, and optional `thread.worktreePath` already exist.

## 5. Workspace Model

The only workspace model remains:

```text
Project
  -> workspaceRoot
  -> Thread(projectId, optional worktreePath)
  -> cwd = thread.worktreePath ?? project.workspaceRoot
```

Core-state operations resolve a live thread by joining `projection_threads` to `projection_projects`. Artifact paths are workspace-relative and validated through the existing `WorkspacePaths.resolveRelativePathWithinRoot` against the resolved cwd. Absolute paths, empty/root paths, and traversal outside that root are rejected. No hidden/default/managed cwd exists.

## 6. Native Session Mapping

`provider_session_runtime` remains the single native-session mapping source of truth. Migration 053 safely rebuilds the existing table with:

```text
primary key = (thread_id, provider_instance_id)
is_current = deterministic active routing marker
resume_cursor_json = provider-owned native session/resume identity
```

Legacy nullable provider instance ids are promoted to the existing default-instance convention (`provider_instance_id = provider_name`). Existing rows and resume payloads are retained.

`ProviderSessionDirectory.getBinding(threadId, providerInstanceId?)` now supports:

- no provider instance: current active mapping, preserving existing routing behavior;
- provider instance supplied: that Harness/instance's retained mapping.

Starting or updating another provider makes it current without deleting the previous mapping. ProviderService reads the target mapping for resume while retaining its existing current-instance compatibility protection. ACP resume/load remains owned by `AcpSessionRuntime`; Phase 2 added no resume protocol.

## 7. Task State

One optional Task State belongs directly to each existing Thread:

```text
threadId
status: active | paused | completed | blocked
objective
updatedAt
```

`CanonicalThreadCoreState` provides typed read/upsert operations. It first verifies that the Thread and owning Project exist and are not deleted. There is no workflow engine, plan graph, dependency graph, or planner.

## 8. Artifact Metadata Registry

`thread_artifacts` is a lightweight metadata registry with:

```text
artifactId
threadId
workspaceRelativePath
artifactType
producingProviderInstanceId?
createdAt / updatedAt
```

The domain service supports register, list by Thread, update, and unregister. Tests cover Thread isolation and rejection of `../` traversal. Files are not copied, parsed, uploaded, versioned, embedded, or stored in SQLite.

## 9. Capability Registry

Capabilities are derived, not persisted. `normalizeHarnessCapabilityView` combines:

```text
reported/default provider or ACP behavior
  -> explicit Generic ACP capability overrides
  -> normalized supported / unsupported / unknown view
  + live provider availability
```

The vocabulary is intentionally limited to currently real inputs: native-session resume, MCP server injection, filesystem read/write, terminal, and availability. Overrides win over reported/default values. Multiple providers produce independent views. No ACP or T3 capability protocol was redefined, and no stale capability table was added.

## 10. Persistence / Migration

One migration was added: `053_CanonicalThreadCoreState`.

It:

1. preserves and upgrades `provider_session_runtime` from one row per Thread to one row per Thread/provider instance;
2. adds the current-mapping marker and indexes;
3. adds `thread_task_states`;
4. adds `thread_artifacts` with Thread foreign keys and per-Thread path uniqueness.

It uses T3's existing SQLite and migration runner. No second database or JSON store exists.

## 11. Architecture

```text
Project(workspaceRoot)
  |
  +-- existing T3 Thread(projectId, worktreePath?)   <-- Canonical Thread
        |
        +-- resolved cwd = worktreePath ?? workspaceRoot
        +-- Task State (minimal row)
        +-- Artifact metadata (workspace-relative rows)
        +-- provider_session_runtime                <-- native session truth
        |     +-- current provider mapping
        |     +-- Codex native mapping
        |     +-- Qwen/Kimi/DSH/other mappings
        +-- derived Capability View
              +-- reported/default
              +-- explicit override
              +-- live availability

projection_thread_sessions                         <-- current UI/session status only
Provider Driver -> Adapter -> ACP/native runtime
```

## 12. Tests

Actual commands and results:

1. Core State/workspace/thread/capability first pass:
   - 5 files passed;
   - 26 tests passed.
2. Generic ACP + effect-acp + server ACP + provider/settings regression:
   - 24 files passed, 2 skipped;
   - 422 tests passed, 8 skipped.
3. Migration/Core State/native mapping focused suite:
   - 4 files passed;
   - 15 tests passed.
4. ProviderService routing regression after active-mapping integration:
   - 1 file passed;
   - 87 tests passed.
5. Final combined migration/Core State/workspace/session-startup suite:
   - 8 files passed;
   - 56 tests passed.
6. Changed-file lint:
   - passed with no warnings or errors after cleanup.
7. `git diff --check`:
   - passed.
8. Affected package typecheck:
   - attempted for `@t3tools/contracts` and `t3`;
   - blocked by existing Node `Buffer`/Node global type errors across unchanged files;
   - filtered diagnostics contained no Phase 2 TypeScript error (only Effect suggestions in touched persistence/core-state files).

No browser/computer-use validation was run because the project requires explicit authorization and Phase 2 has no user-visible UI change.

## 13. Regression Status

- Generic ACP: PASS.
- effect-acp: PASS.
- Server ACP: PASS.
- Provider/settings: PASS.
- ProviderService routing and current-session compatibility: PASS.
- Startup/orphaned provider-session reconciliation: PASS.

The Generic ACP native session remains stored only through `ProviderSessionDirectory` / `provider_session_runtime`; no second ACP mapping source was introduced.

## 14. Existing Environment Issues

- Global Vite+ `current` shim remains broken; the installed versioned `vp.exe` works.
- Server/package typecheck still reports the existing Node `Buffer` and Node-global typing failures. Dependency installation fixed the previously missing package tree but did not change that baseline type conflict.
- Vitest reads remain blocked by the filesystem sandbox (`EPERM`); approved runs outside that sandbox pass.

## 15. Files Changed

Phase 2 files:

- `packages/contracts/src/coreState.ts`
- `packages/contracts/src/index.ts`
- `apps/server/src/coreState/CanonicalThreadCoreState.ts`
- `apps/server/src/coreState/CanonicalThreadCoreState.test.ts`
- `apps/server/src/persistence/Migrations/053_CanonicalThreadCoreState.ts`
- `apps/server/src/persistence/Migrations/053_CanonicalThreadCoreState.test.ts`
- `apps/server/src/persistence/Migrations.ts`
- `apps/server/src/persistence/ProviderSessionRuntime.ts`
- `apps/server/src/provider/Services/ProviderSessionDirectory.ts`
- `apps/server/src/provider/Layers/ProviderSessionDirectory.ts`
- `apps/server/src/provider/Layers/ProviderSessionDirectory.test.ts`
- `apps/server/src/provider/Layers/ProviderService.ts`
- `apps/server/src/provider/capabilityView.ts`
- `apps/server/src/provider/capabilityView.test.ts`
- `apps/server/src/server.ts`
- `docs/spikes/PHASE2_IMPLEMENTATION_AUDIT.md`
- `docs/spikes/PHASE2_REPORT.md`

Existing uncommitted Phase 1 Generic ACP and Phase 1.5 documentation changes were preserved and not reset, cleaned, stashed, committed, or pushed.

## 16. Git Diff Summary

Phase 2 is limited to typed core-state contracts/service/tests, one migration, expansion of the existing provider-session persistence cardinality, a derived capability normalizer, server layer composition, and the two required Phase 2 reports. No UI was added and no ACP protocol/runtime was rewritten.

## 17. Known Limitations

- Core State has a server domain API but no Phase 2 UI or public client RPC; future phases can call the composed service from their narrow command/RPC boundaries.
- Capability values that the current provider/runtime cannot report remain `unknown`; this is intentional and avoids speculative capability claims.
- Native session resume succeeds only when the provider runtime already supports it; Phase 2 merely retains and selects the provider-owned cursor.
- Typecheck baseline remains blocked by the existing Node types conflict described above.

## 18. Phase 3 Readiness

The data foundation is ready for Phase 3 Handoff / Baton V1:

- one Project-bound, Harness-neutral Canonical Thread;
- retained per-provider native session mappings with one current routing marker;
- minimal durable Task State;
- workspace-safe Artifact metadata;
- normalized derived capability views.

Phase 3 has not been implemented.
