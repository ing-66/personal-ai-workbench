# Phase 6 Report

Knowledge / SAG Integration V1. Audited and implemented 2026-09-16.

## 1. Result

**PASS.**

Workbench now treats SAG as the environment's knowledge engine and hands it to every MCP-capable harness through the Phase 5 external-MCP path, scoped per Project. No second RAG, no knowledge storage, no provider-specific integration, no automatic retrieval, and no automatic ingestion were built. Every item in the Phase 6 exit criteria is satisfied; the evidence is in sections 6-20 and the deviation notes in section 21.

## 2. SAG Version / Commit Audited

- `Zleap-AI/SAG` `main` @ `125073866c5377f7d126762d39d368f841913efb` (2026-09-15), latest release tag `v1.8.7` (2026-09-13).
- The instance already running on this machine reports `serverInfo.version = 1.28.1` over MCP. Its tool inventory, auth behaviour, and scope behaviour match `main` exactly, so the interface this phase codes against is the one actually deployed (section 12).
- The old `v1` line was ignored entirely.

## 3. Current SAG MCP Findings

From `apps/api/sag_api/mcp/{server.py,mount.py}`, confirmed live against the local instance:

- Endpoint `http(s)://<host>/mcp/`, MCP **Streamable HTTP**, `stateless_http=true`; responses arrive as SSE (`event: message` + `data: {...}`, with `: ping` keep-alive frames mixed in).
- Auth is a single `Authorization: Bearer <token>` header (SAG JWT or the local DSH connector token): no token -> `401 {"error":"缺少认证令牌"}`, bad token -> `401 {"error":"令牌无效或已过期"}`. `403` is kept in the client vocabulary for reverse proxies, not produced by SAG itself.
- Scope is enforced by the ASGI wrapper _before_ MCP runs: `/mcp/?source_id=<id>` loads exactly that source, and an unknown id returns `404 {"error":"信源不存在"}` with no handshake at all. Tool-level `source_id` arguments can only narrow the injected scope, never widen it.
- Eight read-only tools, discovered via `tools/list`: `list_sources`, `search`, `get_entity`, `list_documents`, `outline`, `grep`, `read`, `get_chunk`. No search-mode vocabulary, no rerank knob, no ingest tool.
- Citations live inside the tool result text: `[n] <heading>（chunk_id=…）` plus `来源：<name>（source_id=…）`.
- SAG also ships `@zleap-ai/sag-cli`, `@zleap-ai/dsh-sag`, and OCTX import/export. **None is used** (section 5).

## 4. Build vs Reuse Decision

Reuse, with zero new machinery for knowledge itself:

| concern                                                       | decision                                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| knowledge engine, storage, retrieval, reranking, entity/graph | SAG's own, untouched                                                               |
| interface                                                     | SAG's official MCP server (no proxying into native Workbench tools)                |
| injection                                                     | the Phase 5 `McpProviderSession.extraMcpServers` path (no new adapter abstraction) |
| connection config                                             | the existing settings file + the existing `ServerSecretStore`                      |
| project scope                                                 | the existing `projectSettingsOverrides` record (no migration)                      |
| reporting                                                     | the existing capability view and handoff briefing                                  |

Built (all small, all Workbench-side): a knowledge contract module, a live MCP probe, a `KnowledgeService`, one optional credential field on the extra-server descriptor, and the settings/project UI.

## 5. Knowledge Architecture

```
Workbench settings                        Project settings
  knowledge.enabled / .endpoint / .token    knowledgeScope = none | source(<id>) | all
        │                                        │
        └──────────────► KnowledgeService ◄──────┘
                          resolves the scope to one MCP URL and probes it
                             (initialize -> tools/list -> optional list_sources)
        │
        ▼
ProviderService.prepareMcpSession
  extraMcpServers = [ playwright?, sag-knowledge? ]
        │
        ▼
Provider adapters (unchanged logic, one credential passthrough)
        │
        ▼
SAG  /mcp/?source_id=<id>  →  sources · documents · retrieval
```

SAG is a configured external service. Workbench never installs, deploys, starts, or supervises it: no Docker, no compose, no Python sidecar, no embedded engine, no Desktop install.

## 6. SAG Connection

Environment-level settings: `knowledge.enabled`, `knowledge.endpoint`, `knowledge.token`. Endpoints are normalized through one pure function: missing path -> `/mcp/`, missing trailing slash added, `http`/`https` only, credentials in the URL rejected, and a pasted query (including a `source_id`) dropped on purpose so a URL can never widen a project's scope. Scope URLs are built with the URL API, so `/mcp//?source…` cannot be produced by concatenation.

The connection probes with `initialize` -> `tools/list` (and `list_sources` only when a source picker asks for it). There is no `GET / == 200` health check. Probe results are cached for 10 seconds so a handoff and a session start in the same breath do not each pay for a handshake.

The settings surface is the smallest one that works, built from the existing primitives and hosted in the existing Integrations page (no new route, no SAG branding): an enabled switch, the endpoint field, a token field that starts empty and only sends a token the user actually typed (plus a Clear that sends `""`), and a Test connection action that renders `KNOWLEDGE_DIAGNOSTIC_MESSAGES` copy plus the discovered sources. Settings search and the command palette reach every row through the existing registry.

## 7. Knowledge Ownership

SAG owns knowledge. Workbench stores **no** sources, documents, chunks, embeddings, entities, events, graphs, or vectors, and creates no shadow tables (`knowledge_documents`, `knowledge_chunks`, `knowledge_vectors`, … do not exist). The only persisted facts are the connection and a project's scope selection. No Qdrant/Chroma/Milvus/Weaviate/Elasticsearch/pgvector, no embedding pipeline, no chunker, no reranker, no retrieval algorithm.

## 8. Project Source Scope

Scope belongs to the **Project**, in `projectSettingsOverrides[projectId].knowledgeScope`:

- `none` (default) — the project reaches nothing, and nothing is injected;
- `source` — one explicit SAG source, stored as its stable `sourceId` plus a `displayName` label for display;
- `all` — explicit opt-in only, never a default.

A project with `none` never falls back to all sources. A project whose source has been deleted in SAG reports `source-not-found` and injects nothing — no silent widening. Different projects on the same SAG instance resolve to different scoped URLs, and the scope is per project, so every thread in a project inherits it and a handoff changes nothing.

The project control offers `None`, `All Sources`, and a picker of the sources SAG reports (read from an unscoped status call, since the scoped one can only ever list the project's own source). It stores the chosen `sourceId` with its `displayName` as a label, keeps a source that SAG no longer lists so the `source-not-found` message can be shown instead of silently widening the scope, and writes through the existing per-project override entry — `knowledgeScope` is not a top-level `ServerSettings` key, so the generic scoped-settings writer would have dropped it silently.

## 9. MCP Injection

`McpProviderSession.McpProviderSessionExtraServer` gained one optional field, `authorizationHeader`, and each of the six adapters passes it through in its own native form (Claude `headers`, OpenCode `headers`, the three ACP harnesses' `{name,value}` header lists, Codex via a per-server `bearer_token_env_var` plus an environment variable). Generic ACP gained nothing: it receives whatever servers its caller assembled, and contains no knowledge or browser branch. No `CodexSAG` / `ClaudeSAG` / `KimiSAG` exists, and no `knowledge_search` / `knowledge_read` Workbench tool was created.

A provider that cannot speak MCP receives no knowledge server, reported as `knowledge: unsupported`. There is no terminal or `curl` fallback.

## 10. Capability View

`HarnessCapabilityView` gained `knowledge`, derived at read time and never persisted:

- `supported` — the target harness is available, speaks MCP, the environment's SAG connection is ready, and the project's scope resolves to an MCP URL;
- `unsupported` — any of those facts is false (SAG off, down, unauthorized, source missing, or no scope selected);
- `unknown` — the fact was not reported.

No `knowledge=true` row exists anywhere.

## 11. Authentication / Secret Handling

- The raw token is stored in the existing `ServerSecretStore` under `knowledge-sag-token`; `settings.json` holds only the existing six-bullet redaction marker.
- `redactServerSettingsForClient` returns the marker (never the value) to clients; echoing the marker keeps the stored credential, an empty string clears it.
- The token reaches exactly two places: SAG itself, and the provider's own MCP transport. It is absent from the status DTO, the handoff briefing, capability views, activity payloads, artifact metadata, and every Workbench log line (logs carry only the diagnostic and the scope _mode_).
- 401/403 never fall back to an unauthenticated or all-sources connection; they surface as `unauthorized` / `forbidden` and withhold knowledge.
- No new vault was written and no new secret path was invented.

## 12. Retrieval / Citation Preservation

Workbench has no code on the retrieval path. The harness calls SAG through the MCP server it was handed, and the tool result — including `chunk_id` and the `来源：…（source_id=…）` citation line — reaches the harness byte-identical. Workbench never wraps, re-serializes, re-ranks, truncates, or caches a SAG tool result, and adds no size guard of its own (the existing MCP runtime already has one).

Verified live against the local instance (read-only; nothing was created):

| observation                           | result                                        |
| ------------------------------------- | --------------------------------------------- |
| unscoped probe                        | `ready`, 8 tools discovered, 2 sources listed |
| scoped probe (`?source_id=<real id>`) | `ready`, exactly 1 source visible             |
| missing source                        | `source-not-found` (from SAG's real `404`)    |
| bad token                             | `unauthorized` (from SAG's real `401`)        |

## 13. Handoff Integration

The briefing gained one section:

```
Knowledge
- Available to this harness: yes|no
- Scope: <display label>|none configured for this project
```

plus `- Knowledge: supported|unsupported|unknown` in the capability list. No endpoint, no token, no tool list, no source list, and no retrieved content ever enters a briefing. The facts are computed from the _thread's project_, not from a provider instance, so a Codex -> Kimi handoff keeps the same knowledge scope. Knowledge facts are read defensively: if SAG is offline the handoff still proceeds and the briefing says knowledge is unavailable.

## 14. Browser / Office Boundary

The browser still owns exactly one Playwright MCP entry per thread; knowledge owns one SAG entry per project. They are separate entries in the same array and neither is derived from the other. Office artifacts still go only to the Artifact Registry: no `Artifact → SAG` upload exists, no `Browser → SAG` ingestion pipeline exists, and opening a project never walks the filesystem or uploads anything. Automatic retrieval per turn does not exist either: a plain "hello" turn triggers no SAG call, because Workbench performs no retrieval at all.

## 15. Persistence

Settings only: `knowledge { enabled, endpoint, token }` on the environment, `knowledgeScope` in the existing `projectSettingsOverrides` record, and the token in the existing secret store. No new table, no new file, no knowledge cache on disk.

## 16. Migration

**None added.** The project override record already exists and already supports project-scoped keys (`enableAgentBrowserAccess` is the precedent), so `knowledgeScope` needed no schema or database change. Nothing else about Phase 6 is persisted.

## 17. Dependencies Added

**None.** Phase 6 adds no package, no lockfile change, and no service dependency. (The only new dependencies in this tree remain Phase 5's `@playwright/mcp`, `@xmldom/xmldom`, and `fflate`.)

## 18. Tests

Command:

```
.\node_modules\.bin\vp.CMD test run packages/contracts/src/knowledge.test.ts apps/server/src/knowledge apps/server/src/serverSettings.test.ts
```

Result: **82 passed, 0 failed, 0 skipped (4 files)** — endpoint normalization/scope/availability; the probe's connection matrix (ready, 401, 403, scoped 404 -> `source-not-found`, unscoped 404 -> `mcp-handshake-failed`, unreachable, timeout, non-MCP body); tool discovery from the server's own list; source listing and its degradation; a retrieval result returned byte-identical with its `chunk_id` and `来源：...（source_id=...）` line; the service's scope isolation, no-fallback behaviour, redaction, and no-retrieval-on-preparation; and the SAG token's marker/materialization/keep/clear cycle in `settings.json`.

Command:

```
.\node_modules\.bin\vp.CMD test run apps/server/src/provider/Layers/ProviderService.test.ts -t "knowledge"
```

Result: **3 passed, 87 skipped (1 file)** — the real `ProviderService` composing the SAG server into a provider session: the scope-resolved URL and `Bearer` credential reach `extraMcpServers`; a project with no knowledge gets no entry (never a fallback); and the list never contains more servers than were resolved. (The rest of that file is skipped by the filter; see section 20 for its 8 pre-existing failures.)

Command:

```
.\node_modules\.bin\vp.CMD test run apps/web/src/components/settings/knowledgeSettings.logic.test.ts apps/web/src/components/settings/settingsSearch.test.ts
```

Result: **70 passed, 0 failed, 0 skipped (2 files)** — the Knowledge section's pure display/diagnostic mapping and the settings-search entries.

Command (real SAG smoke, temporary file, deleted after the run):

```
.\node_modules\.bin\vp.CMD test run apps/server/src/knowledge/RealSagSmoke.tmp.test.ts
```

Result: **1 passed, 0 failed, 0 skipped (1 file)** — section 12's live table, against the running local instance.

Typecheck:

```
.\node_modules\.bin\vp.CMD exec tsc --noEmit -p apps/server/tsconfig.json
.\node_modules\.bin\vp.CMD exec tsc --noEmit -p apps/web/tsconfig.json
.\node_modules\.bin\vp.CMD exec tsc --noEmit -p packages/contracts/tsconfig.json
```

Result: **350 / 3 / 1 errors respectively, 0 of them in any Phase 6 file** — each identical to the recorded baseline (section 20).

## 19. Regression Status

Command:

```
.\node_modules\.bin\vp.CMD test run packages/contracts/src/browserSession.test.ts apps/server/src/browser apps/server/src/orchestration/decider.handoff.test.ts apps/server/src/coreState/CanonicalThreadCoreState.test.ts apps/server/src/persistence/Migrations/053_CanonicalThreadCoreState.test.ts apps/server/src/provider/Layers/ProviderSessionDirectory.test.ts apps/server/src/provider/Drivers/GenericAcpDriver.test.ts apps/server/src/provider/Drivers/GenericAcpDiagnostics.test.ts apps/server/src/provider/Layers/GenericAcpAdapter.test.ts apps/server/src/mcp/toolkits apps/server/src/mcp/McpSessionRegistry.test.ts apps/server/src/mcp/McpInvocationContext.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts packages/shared/src/composerContextReferences.test.ts
```

Result: **220 passed, 0 failed, 0 skipped (24 files)** — Phase 5 browser runtime, Phase 3 handoff and core state, Generic ACP, provider routing, the Office toolkits, and the provider command reactor all green.

Command (the Phase 4/5 Office/MCP set, including the one file with a known Windows assertion):

```
.\node_modules\.bin\vp.CMD test run apps/server/src/mcp/toolkits/office apps/server/src/mcp/McpHttpServer.test.ts apps/server/src/mcp/McpSessionRegistry.test.ts apps/server/src/mcp/McpInvocationContext.test.ts apps/server/src/mcp/McpDeviceToolkit.test.ts apps/server/src/mcp/toolkits/pullRequests apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts packages/shared/src/composerContextReferences.test.ts packages/contracts/src/orchestration.test.ts apps/web/src/components/chat/handoff.logic.test.ts
```

Result: **243 passed, 1 failed, 0 skipped (14 files)** — the single failure is the pre-existing Windows path assertion in `McpHttpServer.test.ts`, unchanged from the Phase 4/5 baseline. Multiple MCP server injection still works: knowledge is a third entry beside the browser's, and neither displaced the other.

Command:

```
.\node_modules\.bin\vp.CMD test run apps/server/src/browser/BrowserRuntime.smoke.test.ts --testTimeout=120000
```

Result: **1 passed, 0 failed, 0 skipped (1 file)** — a real Chrome driven through the official Playwright MCP server.

## 20. Existing Baseline Issues

- `apps/server` typecheck: **350 pre-existing errors**, none in Phase 6 files (unchanged).
- `apps/web` typecheck: **3 pre-existing errors** in `scopedSettings.ts` and `settingsLayout.tsx`, both byte-identical to HEAD, none in Phase 6 files.
- `packages/contracts` typecheck: **1 pre-existing error**, `src/composerContext.test.ts` missing the `handoff` key in its composer-context record — introduced by Phase 3.
- `McpHttpServer.test.ts` "saves the snapshot PNG on request and reports its path": pre-existing Windows path-escaping assertion failure, unchanged.
- `ProviderService.test.ts`: **8 pre-existing failures**, all in the `agent browser access` block, whose expectations still list only `["pull-requests"]` while the working tree's `agentAccessCapabilities` now adds `"office"` for every session. The word `office` appears nowhere in that test file, and that production line predates Phase 6; the Phase 6 diff to that file is an import, one `serviceOption` line, the knowledge resolver, and the extra-server composition, none of which touches credentials. Left unfixed on purpose (section 21).

None was fixed: they are unrelated to this phase.

## 21. Known Limitations

- A project with no scope still probes the _bare_ endpoint so Settings can report reachability and list sources. That probe performs discovery only (`initialize`/`tools/list`/`list_sources`) and produces no `mcpUrl`, so it cannot become a hidden search; but it is one unauthenticated-by-scope request against SAG.
- `list_sources` is parsed textually for source identities. A change in SAG's display format degrades to an empty picker rather than to a wrong scope.
- The handoff path bounds its probe at 1.5 s; with SAG online but wedged, a handoff waits that long before reporting knowledge unavailable. SAG offline (connection refused) returns immediately.
- On the Claude adapter, an extra MCP server's credential travels in the provider's own MCP config, exactly as T3's own MCP credential already does; Codex instead receives it through its subprocess environment. No new exposure class was introduced, but this is unchanged from Phase 5's design rather than a fix for it.
- The in-memory probe cache is 10 s and per-process; two Workbench servers on one machine each probe independently.
- SAG's own source/document management, graph, and chat surfaces are deliberately not reproduced in Workbench. Adding a document to knowledge is done in SAG, not here.
- `@zleap-ai/sag-cli` is never invoked: Workbench does not mutate `~/.codex`, `~/.claude`, or the DSH profile, so there is exactly one MCP configuration source of truth (this server).
- `@zleap-ai/dsh-sag` is not installed, not depended on, and not special-cased: DSH gets SAG through the same standard MCP injection as every other harness.
- The 8 stale `agent browser access` assertions (section 20) were deliberately left alone: they are Phase 4-era expectations about a capability this phase did not touch, and Phase 6's rule is not to fix unrelated problems in passing. They need one edit each to include `"office"`.
- One real bug was found and fixed while writing the tests, and it is worth recording because it was invisible from the feature side: `settings.json` is written sparsely, so a `knowledge.token` equal to its default `""` was dropped from the file while the encoder required the key — the next settings write failed outright. `KnowledgeSagConnection`'s three fields now carry decoding defaults, which is what makes the sparse form legal on both sides.

## 22. Files Changed

New (Workbench):

- `packages/contracts/src/knowledge.ts` — diagnostics + client copy, scope and connection schemas, status DTO, endpoint normalization and scope-URL helpers.
- `packages/contracts/src/knowledge.test.ts`
- `apps/server/src/knowledge/KnowledgeProbe.ts` — the Streamable HTTP MCP probe and its classification.
- `apps/server/src/knowledge/KnowledgeService.ts` — scope resolution, probe caching, provider descriptor, handoff facts.
- `apps/server/src/knowledge/KnowledgeProbe.test.ts`, `apps/server/src/knowledge/KnowledgeService.test.ts`
- `apps/web/src/components/settings/KnowledgeSettings.tsx` — the environment Knowledge section and the project scope control.
- `apps/web/src/components/settings/knowledgeSettings.logic.ts` + `knowledgeSettings.logic.test.ts`
- `apps/web/src/state/knowledge.ts` — the `server.knowledgeStatus` query atom.
- `docs/spikes/PHASE6_IMPLEMENTATION_AUDIT.md`, `docs/spikes/PHASE6_REPORT.md`

Modified (Workbench):

- `packages/contracts/src/{index.ts,settings.ts,handoff.ts,coreState.ts,rpc.ts}`
- `apps/server/src/mcp/McpProviderSession.ts` — optional `authorizationHeader` on an extra server, plus the four header/token helpers the adapters share.
- `apps/server/src/provider/Layers/{ProviderService.ts,CodexAdapter.ts,ClaudeAdapter.ts,CursorAdapter.ts,GrokAdapter.ts,AntigravityAdapter.ts,OpenCodeAdapter.ts}`
- `apps/server/src/provider/capabilityView.ts`, `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `apps/server/src/serverSettings.ts` (token secret + redaction), `apps/server/src/ws.ts` + `apps/server/src/auth/RpcAuthorization.ts` (`server.knowledgeStatus`), `apps/server/src/server.ts` (layer)
- `apps/web/src/components/settings/IntegrationsSettings.tsx` (section host), `ProjectSettingsPanel.tsx` (project control), `settingsSearch.ts` (five entries)
- Tests extended: `apps/server/src/provider/Layers/ProviderService.test.ts` (provider-session injection), `apps/server/src/serverSettings.test.ts` (token lifecycle), `apps/server/src/provider/capabilityView.test.ts` + `packages/contracts/src/handoff.test.ts` (knowledge capability and briefing section).

## 23. Git Diff Summary

`47 files changed, +1807/-59` tracked, plus 31 untracked new files; every Phase 1-5 working-tree change is preserved. Nothing was reset, cleaned, stashed, committed, pushed, or tagged. `git diff --check` is clean, and no scratch file was left behind (a temporary real-SAG smoke test and a scratch typecheck log were deleted after use).

## 24. Phase 7 Readiness

Ready to plan Phase 7, and Phase 7 was deliberately not started.

Known Phase 6 seams a later phase could build on: an explicit "Add Artifact to Knowledge" action, an explicit "Add project file to Knowledge" action, a browser-page "Add to Knowledge" action, per-source multi-scope aggregation if SAG ever exposes it, and OCTX-based backup/migration surfaced from SAG itself. None of these is required now.
