# Personal AI Workbench V1 — Architecture Snapshot

Frozen at V1. Written so the ownership boundaries do not have to be re-derived from the source.

## The one sentence

A local-first, single-user workbench built on the T3 Code shell: one Canonical Thread inside a
Project can be worked by several real local harnesses in turn, and the baton moves between them
automatically without the user restating the task.

## Ownership

```text
Project ─────────────► Workspace
  the user's folder; the only allowed root for file work

Canonical Thread ────► task state + conversation + artifacts + browser profile
  the product's source of truth; it belongs to a Project, never to a harness

Harness ─────────────► executor
  a CLI Workbench spawns; interchangeable, and its native session is disposable cache

Baton ───────────────► exactly one current harness
  at most one write-capable owner at any moment

Workbench ───────────► external integrations + the model gateway
  owns the tool bus, the browser, the SAG connection and the gateway

Project ─────────────► SAG scope
  knowledge is environment-owned; a thread only holds a binding

SAG ─────────────────► knowledge
  an external service the user runs; Workbench never installs or stops it

Model Gateway ───────► upstream routing
  loopback only, per-session credentials, bounded failover
```

## Layers

| Layer                           | Owns                                                                      | Does not own                                         |
| ------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Project / Workspace**         | the folder, its git checkout, worktrees                                   | threads, knowledge, credentials                      |
| **Canonical Thread**            | task state, artifacts, native-session mappings, the baton                 | model choice, upstream endpoints                     |
| **Harness (provider instance)** | one CLI process and one native session                                    | the thread, the artifacts, the browser, knowledge    |
| **Baton**                       | which harness may act right now                                           | anything durable                                     |
| **Workbench Tool Bus (MCP)**    | permissions, audit, artifact registration, timeouts                       | the underlying file/browser/RAG engines              |
| **Browser**                     | one per-thread persistent Chromium profile and one Playwright MCP process | the user's own browser, page content in the database |
| **Knowledge**                   | the SAG connection and a Project's scope                                  | any document, chunk, embedding or vector             |
| **Model Gateway**               | routes, provider profiles, failover, usage telemetry                      | threads, handoffs, or a harness's identity           |
| **Secret store**                | every credential, by name                                                 | any DTO that leaves the process                      |

## Runtime shape

```text
Desktop (Electron)  ──spawns──►  Server (bundled, ELECTRON_RUN_AS_NODE from server.asar)
                                     │
                                     ├── SQLite state.sqlite  (threads, events, artifacts, usage)
                                     ├── settings.json        (non-secret configuration)
                                     ├── secrets/             (OS keyring-backed fallback)
                                     ├── browser/<thread>/     (per-thread Chromium profile)
                                     ├── logs/                (server, provider, terminal)
                                     │
                                     ├── harness CLI processes        (per provider instance, on demand)
                                     ├── Playwright MCP + Chromium    (per thread, lazy)
                                     └── Model Gateway listener       (in-process, lazy, loopback only)
```

Everything above lives under the server base directory. Nothing that matters is written into a
Project workspace except the files a task actually produces.

## Boundaries that are enforced by contract, not convention

1. **No thread without a Project.** `thread.projectId` is non-null and the working directory is
   `thread.worktreePath ?? project.workspaceRoot`. There is no folderless chat and no hidden
   personal workspace.
2. **One baton holder.** A handoff freezes the outgoing harness before the incoming one is injected.
3. **Native sessions are cache.** A lost native session degrades to a new session plus a full
   handoff package; it never damages the Canonical Thread.
4. **Tool paths stay inside the workspace.** Office output, browser upload/download and artifact
   registry resolution are workspace-relative and reject escapes.
5. **Browser profile is per thread and thread-derived.** It is a pure function of the thread id and
   the state directory, so it can never land in a Project and never collide between threads.
6. **Secrets never leave the store in the clear.** Settings, DTOs, logs, activity, handoff packages
   and usage rows carry a redaction marker or a boolean, never a value.
7. **The gateway never touches user-global CLI configuration.** It injects a per-session environment
   overlay into processes Workbench itself spawned.
8. **Model routing cannot reach handoff.** `apps/server/src/modelGateway/**` has no code path to
   `handoff`, `baton`, `decider` or `provider_session_runtime`.

## Where the code lives

| Concern                     | Path                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Generic ACP                 | `apps/server/src/provider/Drivers/GenericAcpDriver.ts`, `apps/server/src/provider/Layers/GenericAcpAdapter.ts`                      |
| Canonical Thread core state | `packages/contracts/src/coreState.ts`, `apps/server/src/coreState/CanonicalThreadCoreState.ts`                                      |
| Handoff / baton             | `packages/contracts/src/handoff.ts`, `apps/server/src/orchestration/decider.ts`, `apps/web/src/components/chat/HandoffControls.tsx` |
| Office                      | `apps/server/src/mcp/toolkits/office/*`                                                                                             |
| Browser                     | `apps/server/src/browser/*`, `packages/contracts/src/browserSession.ts`                                                             |
| Knowledge                   | `apps/server/src/knowledge/*`, `packages/contracts/src/knowledge.ts`                                                                |
| Model Gateway               | `apps/server/src/modelGateway/*`, `packages/contracts/src/modelGateway*.ts`                                                         |
| Secrets                     | `apps/server/src/auth/ServerSecretStore.ts`                                                                                         |
| Migrations                  | `apps/server/src/persistence/Migrations/` (001 … 054)                                                                               |

## What V1 deliberately does not do

Recorded in full in `V1_KNOWN_LIMITATIONS.md`. In architecture terms: no multi-harness parallelism,
no protocol conversion in the gateway, no bundled RAG engine, no second information architecture,
and no packaging machinery beyond the existing T3 Code desktop pipeline.
