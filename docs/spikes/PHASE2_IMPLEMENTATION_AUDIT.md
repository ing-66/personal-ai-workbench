# Phase 2 Implementation Audit

## Existing Thread Model

`OrchestrationThread` is already T3's durable, provider-neutral conversation and work-history identity. Its `id` is used by messages, activities, turns, checkpoints, projected session state, provider runtime persistence, and client routing. The thread stores `projectId` as a required field and does not encode a provider in its identity. It is therefore sufficient to be the Workbench Canonical Thread. A second `CanonicalThread` model or table would duplicate the existing source of truth and is prohibited.

## Existing Project Relationship

`ProjectCreateCommand.workspaceRoot`, `OrchestrationProject.workspaceRoot`, `ThreadCreateCommand.projectId`, and `OrchestrationThread.projectId` are required non-empty values. `projection_threads.project_id` is non-null. Provider, checkpoint, terminal, Git, and file paths already resolve the working directory from the thread's worktree when present and otherwise from the owning Project's workspace root.

The canonical rule remains:

```text
Project -> Thread
cwd = thread.worktreePath ?? project.workspaceRoot
```

No managed, hidden, default, or folderless workspace fallback is required or permitted.

## Existing Session Persistence

T3 separates the current projected session (`projection_thread_sessions`) from resumable provider runtime persistence (`provider_session_runtime`). The latter already contains the required mapping material:

- `thread_id`;
- provider driver identity (`provider_name`);
- configured provider identity (`provider_instance_id`);
- adapter identity;
- provider-owned resume cursor/native session identifier;
- provider runtime payload;
- status and `last_seen_at`.

`ProviderSessionDirectory` is the sole domain boundary for this persistence. ACP native session identifiers are already carried by `resumeCursor`/runtime payload from `AcpSessionRuntime`; Phase 2 must not add an ACP-specific session table or implement a resume protocol.

The only structural gap is cardinality: `provider_session_runtime` currently has `thread_id` as its primary key, so changing provider overwrites the previous provider binding. The minimal extension is to preserve the same table and directory while keying stored mappings by canonical thread plus configured provider instance. `projection_thread_sessions` remains the single current/active-session projection and is not a second native-session source of truth.

## Existing Artifact Concepts

T3 has chat attachments, preview/browser recording artifacts, generated assets, file-change activities, and Codex artifact templates. None is a general thread-scoped metadata registry, and none safely represents an important existing file as metadata bounded to the Project/worktree. These concepts should not be repurposed as file storage or duplicated into a blob system.

Phase 2 needs a lightweight thread artifact metadata projection only. It stores a workspace-relative path, a small type label, optional producing provider instance, and timestamps. The file remains in the Project/worktree; contents, versions, parsing, uploads, embeddings, and Office processing remain out of scope. Registration must resolve and validate the path within `thread.worktreePath ?? project.workspaceRoot`.

## Existing Task State Concepts

T3 already has turn lifecycle state, session status, proposed plans, transient plan progress, archive/settlement state, and thread titles. None answers the durable Workbench question "what is this thread currently doing and where is it?" without conflating a provider turn or proposed implementation plan with the cross-provider task.

The minimal addition is one optional task state owned by the existing thread: a small status vocabulary (`active`, `paused`, `completed`, `blocked`), an objective/title, and `updatedAt`. It is not a workflow, plan graph, dependency graph, or orchestration engine.

## Existing Capability Concepts

Capability information already has four authoritative inputs:

- provider availability and model metadata from `ServerProvider` snapshots;
- live adapter behavior from `ProviderAdapterCapabilities`;
- ACP negotiated capabilities inside `AcpSessionRuntime`;
- Generic ACP user overrides in `GenericAcpSettings.capabilityOverrides`.

`ProviderService`/the provider instance registry already derives the live adapter capability view. Persisting another capability table would create stale state and a second protocol. Phase 2 should expose a normalized derived view per provider instance/thread, explicitly separating reported/default behavior, configured overrides, and derived availability. Only capabilities that currently exist are included: provider availability, native-session resume support, MCP server injection, client filesystem, and terminal access where those values are known.

## Existing Database / Persistence

T3 uses the existing SQLite database, numbered Effect migrations, event persistence, and projection repositories. Phase 2 must use this database and migration runner. No JSON store, second SQLite file, external database, Redis, or Postgres is needed.

The provider runtime migration must retain every existing row and safely promote legacy nullable provider instance ids using the same default-instance compatibility rule already used by `ProviderSessionDirectory`. New task/artifact persistence must use focused tables/repositories and thread/project ownership checks, not a global Core State manager.

## Reusable Components

- `OrchestrationThread` / `projection_threads` as Canonical Thread.
- `OrchestrationProject` / `projection_projects` as workspace owner.
- `ProviderSessionDirectory` and `provider_session_runtime` as native-session mapping source of truth.
- `projection_thread_sessions` as current active session UI projection.
- `WorkspacePaths` and the existing Project/thread cwd resolution rule for artifact containment.
- provider instance registry, server provider snapshots, adapter capabilities, and Generic ACP overrides for a derived capability view.
- existing SQLite migration and Effect repository patterns.

## Required Extensions

1. Change the existing provider runtime mapping cardinality from one row per thread to one row per thread/provider instance, with lookup for a requested provider instance and a deterministic most-recent fallback for legacy/current callers.
2. Add minimal thread task-state persistence and typed create/read/update access.
3. Add thread artifact metadata persistence and typed register/list/update/unregister access with workspace-bound path validation.
4. Add a derived capability view over existing provider/runtime/settings facts; do not persist derived capability snapshots.
5. Add focused tests for Project/thread/cwd invariants, multi-provider native mappings, task ownership, artifact isolation/path containment, capability normalization/overrides, and Generic ACP regressions.

## Things We Must Not Duplicate

- T3 Thread with a new `CanonicalThread`.
- `ProviderSessionDirectory` with `native_sessions` or an ACP session table.
- current session projection with resumable native-session mappings.
- ACP initialize/resume/load behavior.
- attachments, preview recordings, or file contents in an Artifact Storage System.
- `ModelCapabilities`, adapter capabilities, or ACP capabilities with a new protocol.
- a global `CoreStateManager`, workflow engine, Baton, briefing, handoff, or auto-continue layer.

## Proposed Minimal Architecture

```text
Project (workspaceRoot)
  -> existing T3 Thread (projectId, optional worktreePath)  [Canonical Thread]
       -> cwd = worktreePath ?? workspaceRoot
       -> minimal Task State
       -> Artifact metadata rows (workspace-relative paths only)
       -> existing provider_session_runtime
            key: thread + provider instance
            value: adapter + resume cursor/native session + runtime payload
       -> derived Capability View
            reported/default + configured override + live availability

projection_thread_sessions
  -> current active provider/session status only
```

Sources of truth are singular:

- Canonical Thread: existing T3 orchestration Thread/event/projection model.
- Native session mapping: existing `provider_session_runtime` through `ProviderSessionDirectory`.
- Workspace cwd: owning Project plus optional Thread worktree path.
- Capabilities: provider/runtime reported behavior plus explicit settings override, normalized at read time; no persisted derived copy.
