# Phase 4 Implementation Audit

Phase 4 target: let whichever harness currently holds the baton discover and safely call host-side
tools through one Workbench Tool Bus, with local Office (`.docx`, `.xlsx`, `.pptx`, `.pdf`) file
work as the first real tool family.

Frozen Phase 1–3 facts this audit must not disturb: Canonical Thread = `OrchestrationThread`;
native session mapping = `ProviderSessionDirectory` → `provider_session_runtime`; baton holder =
`provider_session_runtime.is_current`; handoff briefing from Canonical Thread facts through the
deterministic composer and the provider-neutral context pipeline; cwd =
`thread.worktreePath ?? project.workspaceRoot`.

## Existing Tool Model

T3 already has a first-class tool model, not just MCP plumbing. Tools are declared with
`effect/unstable/ai`:

- `Tool.make(name, { description, parameters, success, failure, dependencies })` plus
  `.annotate(Tool.Title | Tool.Readonly | Tool.Destructive | Tool.Idempotent | Tool.OpenWorld)`.
- `Toolkit.make(...tools)` groups them and `Toolkit.toLayer(make)` supplies the handlers.
- Example: `apps/server/src/mcp/toolkits/pullRequests/tools.ts` (`link_pull_request`,
  `unlink_pull_request`, `list_thread_pull_requests`).

So the Workbench tool surface is already defined by typed Effect tools with a typed success schema
and a typed, tagged error union. Phase 4 extends that surface; it does not invent a tool protocol.

## Existing MCP Infrastructure

T3 **is** an MCP server for its own agents:

- Transport: `McpServer.layerHttp({ name: "T3 Code", path: "/mcp", protocols: [McpProtocol.v2025_06_18] })`
  (`apps/server/src/mcp/McpHttpServer.ts:624-629`).
- Registration pattern (the one Phase 4 must follow):
  `McpServer.toolkit(PullRequestsToolkit).pipe(Layer.provide(PullRequestsToolkitHandlersLive))`,
  composed in `Layer.mergeAll(...)` at `McpHttpServer.ts:607-635`.
- Auth: per-request `Authorization: Bearer <token>` → `McpSessionRegistry.resolve` →
  `Effect.provideService(McpInvocationContext, invocation)` (`McpHttpServer.ts:84-107`). Tokens are
  stored hashed with liveness and revocation (`McpSessionRegistry.ts:121-207`).
- The per-thread MCP URL + credential is minted in `McpSessionRegistry.issue` and handed to the
  provider session in `ProviderService.ts:909-955`, which also grants capabilities.

**Conclusion**: the MCP server, its auth, its session registry, its transport, and the
toolkit→handlers→dependencies wiring already exist. Phase 4 adds a toolkit and registers it.

## Existing ACP MCP Injection

- Generic ACP settings already carry capability overrides, including `supportsMcpServers`
  (`packages/contracts/src/settings.ts`), surfaced through the Phase 2 derived capability view as
  `mcpServers: supported | unsupported | unknown`.
- `ProviderService` decides what the provider session receives: the MCP endpoint plus a credential
  whose capability set is computed per session (`ProviderService.ts:909-955`), and
  `McpProviderSession.setMcpProviderSession` records it.
- Capabilities are checked **at call time**: `requireMcpCapability` fails the call with
  `McpCapabilityUnavailableError` when the credential does not grant it
  (`McpInvocationContext.ts:32-55`). `McpCapability = "preview" | "device" | "pull-requests"`.

Answers to the audit's MCP questions:

1. Is there an MCP server registry? Yes — T3's own hosted MCP endpoint plus the toolkits registered
   on it. There is no third-party MCP _client_ configuration surface.
2. Per provider instance? Yes — the credential is issued for a provider session and carries
   `providerInstanceId`, `threadId`, `providerSessionId`, `environmentId`.
3. Per thread / project? Yes — the scope is per thread; the project is derived from the thread at
   call time (`toolkits/pullRequests/handlers.ts:163-180`).
4. Permission flow for tool calls? Only the bearer credential + capability check. There is **no**
   approval gate today.
5. Who owns MCP server lifecycle? T3 itself (in-process, part of the server layer).
6. How are results returned? Toolkit tools return typed JSON (serialized as MCP text content);
   image-shaped results use `server.addTool` instead (`McpHttpServer.ts:346-577`).
7. Provider without MCP? All three toolkits register unconditionally and there is no list-time
   filtering, so a provider that cannot speak MCP simply never calls them. Availability is
   effectively provider-capability-dependent at the client, not enforced server-side.
8. Generic ACP override effect on MCP? The override only changes what the capability view
   _reports_; capability enforcement is the credential's call-time check.

## Existing Provider Tool Capabilities

- `ProviderAdapterCapabilities` (`sessionModelSwitch`, `promptlessTurnContinuation`,
  `supportsConversationRollback`) — about turns, not tools.
- `normalizeHarnessCapabilityView` (Phase 2) reports `mcpServers`, `filesystemRead`,
  `filesystemWrite`, `terminal`, `nativeSessionResume`, `available` from reported/default provider
  behavior plus explicit Generic ACP overrides. This is the derived view a Tool Bus should consult
  for "can this harness reach these tools at all".

## Existing Tool Call Lifecycle

1. Provider asks its MCP client for tools → the MCP server lists the registered toolkits.
2. Provider calls a tool → HTTP `POST /mcp` with the bearer credential.
3. Auth middleware resolves the scope and provides `McpInvocationContext`.
4. The toolkit handler runs with its declared `dependencies` resolved from the app graph.
5. The handler returns the typed success value or fails with a tagged error.

Nothing on this path is provider-specific, which is exactly why Office must live here rather than in
an adapter.

## Existing Permission / Approval Model

- `Tool.Readonly` / `Tool.Destructive` / `Tool.Idempotent` / `Tool.OpenWorld` are **metadata only**:
  the only consumers translate them into MCP client hints (`McpHttpServer.ts:360-371, 519-530` and
  effect's own `McpServer.ts:1547-1555`). Grep finds no other reader in `apps/` or `packages/`.
- The only server-side authorization is the bearer credential + capability set.
- Provider-side approvals (`exec_command_approval`, etc.) belong to provider permission prompts and
  cover the provider's own tools, not T3's MCP tools.
- The spec's Tool Risk Levels (L0 read-only … L4 financial) and "high-risk tool calls have unified
  approval" are **not implemented** in this repo today.

Decision: Phase 4 keeps the existing trust boundary. Tool annotations are populated truthfully
(`Readonly`/`Destructive`/`Idempotent`/`OpenWorld`) so clients and future approval work have the
facts, and destructive-by-overwrite is prevented by construction (safe default output naming plus an
explicit `overwrite` flag) rather than by inventing a second approval framework.

## Existing Tool Result Persistence

- MCP tool invocations are **not** persisted or instrumented: the only signals are three
  `Effect.logWarning` sites in `McpHttpServer.ts` (credential rejection, snapshot failure, image-tool
  failure).
- Separately, tool calls the _provider_ reports arrive as provider runtime items and are projected as
  thread activity (`ActivityPayloadProjection.ts:445-453`, `itemType === "mcp_tool_call"`).
- Thread activities are the established lightweight record: `{ id, tone, kind, summary, payload,
turnId, createdAt }` where `tone` is `info | tool | approval | error` and `payload` is free-form
  JSON, appended via `thread.activity.append` (`decider.ts:2112-2138`). Phase 3's handoff activity is
  a direct precedent.

Decision: Office tool calls append one `kind: "office.tool"` activity with `tone: "tool"` (or
`"error"`) carrying tool name, target path, artifact id, and a bounded summary — never document
bytes or cell data.

## Existing Workspace File Operations

- `WorkspaceFileSystem.writeFile` (`apps/server/src/workspace/WorkspaceFileSystem.ts:305-341`):
  internal Effect service surfaced as a WebSocket RPC (`ws.ts:3006`). Not a tool, not atomic
  (plain `writeFileString` after `makeDirectory`).
- `WorkspaceFileSystem.resolveReadTarget` (`:172-208`): realpaths the root and target and raises
  `WorkspaceFilePathEscapeError` on escape — the existing symlink/junction defense for reads.
- `WorkspacePaths.resolveRelativePathWithinRoot` (`:193-222`): **string-only** containment (rejects
  absolute paths and any `..` escape after `path.resolve`/`path.relative`). It does **not** use
  `realpath`, `lstat`, or file-type checks.
- Atomic write helper: `apps/server/src/atomicWrite.ts:5` (`writeFileStringAtomically`, temp dir +
  `fs.rename`) — currently used only for settings/state files, text only.
- Read cap precedent: `PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024` (`WorkspaceFileSystem.ts:31`).

**Gap Phase 4 must close**: nothing on the write path does a realpath containment check, so a
symlink or junction inside the workspace could redirect a write outside it. String validation alone
is not sufficient, and the phase brief calls this out explicitly.

## Existing Attachment / Artifact Handling

- Artifact metadata registry (Phase 2): `registerArtifact` / `listArtifacts` / `updateArtifact` /
  `unregisterArtifact` on `CanonicalThreadCoreState`.
  - `artifactType` is a **free-form** `TrimmedNonEmptyString` (no closed union), so no new taxonomy
    is required to use `document` / `spreadsheet` / `presentation` / `pdf`.
  - Path validation resolves `thread.worktreePath ?? project.workspaceRoot` and runs the same string
    containment helper; the normalized posix relative path is what is stored.
  - `UNIQUE (thread_id, workspace_relative_path)` and the INSERT has no `ON CONFLICT`, so
    re-registering the same path fails. A writer must `updateArtifact` (or unregister first) when it
    rewrites a path it already registered.
- Attachments: uploads go through `assets/AttachmentUpload.ts` (`.part` then `rename`) and are a
  chat-transport concern, not a workspace file registry.

## Existing Office-related Dependencies

Audited the repo and the lockfile before choosing anything:

- No `docx`, `exceljs`, `xlsx`/SheetJS, `pptxgenjs`, `mammoth`, `pdf-lib`, or `unpdf` anywhere in
  the workspace dependency graph.
- Already present: `jszip@3.10.1` (web app only) and `fast-xml-parser@5.x` (transitive, not a
  declared dependency of any workspace package).
- No LibreOffice or `soffice` on this machine, and no Office installation is required or allowed.
- A Python 3.13 interpreter exists on this machine, but the repo has no Python runtime, no Python
  sidecar, and no packaging for one.

## Existing External Tool Configuration

- `ServerSettings.providerInstances[*]` carries provider configuration including Generic ACP settings
  and capability overrides; provider environment values are redacted for clients
  (`serverSettings.ts:153-174`).
- There is no tool/MCP configuration surface for third-party MCP servers, and the spec's "native
  bridge for harnesses that cannot speak MCP" does not exist.

## Reusable Components

- MCP server + transport + auth + per-thread credential: `mcp/McpHttpServer.ts`,
  `mcp/McpSessionRegistry.ts`, `mcp/McpInvocationContext.ts`.
- Tool/Toolkit declaration and handler pattern: `mcp/toolkits/*/tools.ts` + `handlers.ts`.
- Capability reporting: `normalizeHarnessCapabilityView` (`provider/capabilityView.ts`).
- Thread/project facts at call time: `ProjectionSnapshotQuery`, `McpInvocationContext`.
- Thread cwd resolution: `resolveThreadWorkspaceCwd` (`checkpointing/Utils.ts:12`) and the SQL twin
  in `CanonicalThreadCoreState.resolveThreadWorkspace`.
- Path containment: `WorkspacePaths.resolveRelativePathWithinRoot` plus the realpath defense already
  written in `WorkspaceFileSystem.resolveReadTarget`.
- Atomic writes: `atomicWrite.writeFileStringAtomically` (pattern to mirror for bytes).
- Artifact metadata: `CanonicalThreadCoreState`.
- Activity log: `thread.activity.append`.

## Missing Abstractions

1. A realpath-checked **write** containment guard (reads have one; writes do not).
2. A byte-oriented atomic write helper (the existing one is string-only).
3. A tool family that works on workspace documents (nothing exists today).
4. A place where "which tools can this harness actually reach" is answered. The pieces exist
   (`mcpServers` capability + credential capabilities + registered toolkits) but are not joined.

Scope note: (4) is answered for Phase 4 by reusing the credential capability set and the derived
capability view, without persisting a tool catalog. A full tool registry is not built, because the
MCP toolkit registry already is the tool registry: tools are declared once, registered once, and
listed by the protocol. Adding a second registry would create exactly the three-way sync the brief
forbids.

## Proposed Tool Bus

```text
Current Baton Holder (provider session)
  → provider MCP client
  → POST /mcp  (existing transport, existing per-thread bearer credential)
  → McpInvocationContext (threadId, providerInstanceId, capabilities)  [existing]
  → Tool Bus = the registered MCP toolkits                             [existing mechanism]
      ├── pull-requests toolkit      (existing)
      ├── preview toolkit            (existing)
      ├── device toolkit             (existing)
      └── office toolkit             (NEW, Phase 4)
  → Tool Executor = Toolkit handlers                                   [existing mechanism]
      ├── workspace guard (new: realpath write check)
      ├── atomic byte write (new)
      ├── artifact metadata registration (existing CanonicalThreadCoreState)
      └── activity record (existing thread.activity.append)
  → Workspace-bound file (`thread.worktreePath ?? project.workspaceRoot`)
```

No new protocol, no new transport, no new registry, no new persistence.

## Office Integration Options

| Format            | Spec's declared stack                 | Option A: purpose-built JS libs                                          | Option B: OOXML via zip+XML                             | Decision |
| ----------------- | ------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------- | -------- |
| DOCX              | python-docx (+ optional COM)          | `docx@9.7.1` (MIT, 4.6 MB, 6 deps)                                       | `fflate` + `@xmldom/xmldom`                             | **B**    |
| XLSX              | openpyxl (default), ExcelJS for Node  | `exceljs@4.4.0` (MIT, **21.8 MB**, 9 deps incl. archiver/unzipper/saxes) | same                                                    | **B**    |
| PPTX              | python-pptx + PptxGenJS               | `pptxgenjs@4.0.1` (MIT, 2.6 MB, generation only)                         | same                                                    | **B**    |
| PDF               | MarkItDown (extract) + pdf-lib (edit) | `unpdf` (2.0 MB) / `pdf-lib` (18.6 MB, 4 deps)                           | hand-written minimal PDF writer + best-effort extractor | **B**    |
| Conversion/render | optional LibreOffice/COM              | not available here                                                       | not available here                                      | not used |

Why Option B:

- The phase brief forbids installing a Python sidecar/daemon unless the JS/TS ecosystem genuinely
  cannot do the job, and forbids requiring Microsoft Office. The spec's Python stack (MarkItDown,
  python-docx, openpyxl, python-pptx, pdf-lib) would mean a second runtime and a second process
  model in a repo that has neither.
- Option A's totals are much larger than the work needs: `exceljs` alone is 21.8 MB unpacked.
- The Office formats are ZIP + XML, and the repo already depends on ZIP and XML handling
  (`yauzl`, `jszip`, `fast-xml-parser` in the lockfile). Writing a **deliberately narrow** OOXML
  subset with `fflate` + `@xmldom/xmldom` costs two MIT dependencies with **zero transitive
  dependencies** (~1.2 MB total) and gives exact control over what is and is not supported.
- Correctness risk is managed, not ignored: every writer's output is re-opened by our own reader and
  validated as a ZIP with matching content types in tests, and the supported subset is documented
  with explicit non-goals.

Rejected deliberately: `fast-xml-parser` (6 transitive dependencies) was replaced by
`@xmldom/xmldom` (zero); `pdf-lib` was not needed because the PDF subset is one writer and one
best-effort extractor; no Office COM, no GUI automation, no OCR.

## Build vs Reuse Decision

| Concern                          | Decision                                                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Tool protocol / transport / auth | **Reuse** — existing MCP HTTP server and per-thread credential                                                          |
| Tool declaration, schema, errors | **Reuse** — `Tool.make` / `Toolkit.make`                                                                                |
| Tool discovery                   | **Reuse** — MCP tool listing from the registered toolkits                                                               |
| Capability reporting             | **Reuse and extend** — `HarnessCapabilityView` gains a tool-facing derived field rather than a persisted catalog        |
| Permission                       | **Reuse existing boundary** — credential + capability; annotations filled truthfully; no second approval framework      |
| Path safety                      | **Reuse + close a gap** — existing string containment plus the existing realpath read guard; add a realpath write guard |
| Atomic write                     | **Reuse the pattern** — mirror `atomicWrite` for bytes                                                                  |
| Artifact registration            | **Reuse** — `CanonicalThreadCoreState`                                                                                  |
| Activity                         | **Reuse** — `thread.activity.append` with one new `kind`                                                                |
| Office file formats              | **Build a narrow subset** on `fflate` + `@xmldom/xmldom`                                                                |
| Persistence                      | **None** — no new table, no new settings store                                                                          |

## Things We Must Not Duplicate

- an MCP implementation, tool transport, or credential system;
- a second tool registry, tool catalog table, or tool marketplace;
- per-provider Office code (`CodexOfficeService`, `KimiOfficeService`, …) or Office logic inside
  `GenericAcpAdapter`;
- a second artifact system (`OfficeArtifactRegistry`) or a document-content database;
- a second permission language alongside `Tool.Readonly`/`Destructive` and the credential;
- a workflow engine, tool agent, retry router, or sub-agent orchestration;
- a Python sidecar, FastAPI service, or second backend;
- Office COM/GUI automation, Playwright, OCR;
- browser (Phase 5), knowledge/RAG (Phase 6), model gateway (Phase 7).

## Bounds Chosen for Inspection

The numbers are anchored on existing repo precedent rather than taste:

- Read cap `1 MiB` — `PROJECT_READ_FILE_MAX_BYTES` (`WorkspaceFileSystem.ts:31`).
- Total returned text cap `32_000` chars — `SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS`
  (`packages/contracts/src/orchestration.ts:164-196`), the repo's existing ceiling for "structured
  text handed to a model".
- Per-item caps (paragraphs, rows, columns, cells, slides) are tool parameters with conservative
  defaults, so a model can narrow a read instead of dumping a workbook.

## Scope Boundary Versus MASTER_SPEC

`MASTER_SPEC.md` Phase 4 lists "MCP Tool Bus / MarkItDown / Word-Excel-PPT-PDF adapters / artifact
versioning+validation" and its exit criterion covers all four of Office/PDF. Two facts require an
explicit scope call in the report:

1. MarkItDown is a Python package. Adopting it means a Python sidecar, which this phase's brief
   forbids unless the JS/TS ecosystem cannot do the job.
2. PDF _modification_ in the spec is `pdf-lib`. Phase 4 V1 ships PDF **inspect + create** as a
   narrow subset and does not claim arbitrary PDF editing.

Both decisions, their rationale, and their limits are recorded in `docs/spikes/PHASE4_REPORT.md`
(§9, §12, §19) so a later phase can adopt the spec's stack deliberately rather than by accident.
