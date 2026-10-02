# Phase 6 Implementation Audit

Scope: Workbench ↔ SAG Knowledge integration V1.

Audited: 2026-09-16. SAG upstream `Zleap-AI/SAG` @ `125073866c5377f7d126762d39d368f841913efb` (main, 2026-09-15), latest release tag `v1.8.7` (2026-09-13). Workbench tree at the Phase 5 end state (all Phase 1–5 changes still uncommitted).

## Current SAG Architecture

SAG is a self-hosted knowledge base with two halves that matter here: a FastAPI application (`apps/api`) that owns sources, documents, chunking, embedding, entity/event extraction and retrieval, and a web app (`apps/web`) that owns its own source/document/graph/chat UI. The retrieval architecture is SAG's own (`sag_api/services/retrieval_service.py`, `EngineManager`), backed by a local engine and its own storage.

Nothing about ingestion, indexing, or retrieval is Workbench's concern. SAG ships:

- `apps/api/sag_api/mcp/` – the official MCP server (`server.py`, `mount.py`).
- `apps/api/sag_api/tools/mcp.py` – SAG's own _client_ side (how SAG consumes other MCP servers); not relevant to this integration.
- `@zleap-ai/sag-cli` (`docs/sag-cli.md`) – CLI, including `sag agent connect codex|claude-code`.
- `@zleap-ai/dsh-sag` – a DeepSeek Harness connector.
- OCTX source import/export for backup and migration.

The old `v1` line is archived; current development is on `main` against the `1.8.x` release line. This audit targets the current implementation only.

## Current SAG MCP Interface

Mounted by `attach_source_mcp()` in `apps/api/sag_api/mcp/mount.py`.- **Endpoint**: `http(s)://<host>/mcp/` (trailing slash; FastAPI `Mount("/mcp")` over an inner FastMCP whose `streamable_http_path` is rewritten to `/`).

- **Transport**: MCP **Streamable HTTP**, `stateless_http=True`, DNS-rebinding protection disabled because the outer ASGI wrapper enforces auth. There is no `Mcp-Session-Id` requirement for a stateless server, so one POST may carry `initialize` and the next POST may carry `tools/list`.
- **stdio entry** also exists (`serve_stdio`, `SAG_MCP_SOURCE_ID`) for in-process/desktop use. Workbench uses HTTP only.
- **Health**: there is no separate health route on the MCP mount. A missing token is answered `401 {"error":"缺少认证令牌"}` before MCP is reached, so an unauthenticated probe cannot be mistaken for a healthy server.
- Tool results are **plain text blocks**. `search` formats each hit as `[n] <heading>（chunk_id=…）` plus a `来源：<name>（source_id=…）` line when more than one source is in scope. Citations and chunk identity are therefore carried _inside_ the tool result text.

## SAG Authentication

`ScopedKnowledgeMCP._bearer` reads only the `Authorization` header. The value after an optional `Bearer ` prefix is validated by `authenticate_user_token` against a SAG JWT **or** the local DSH connector token.

- No token → `401 {"error":"缺少认证令牌"}`.
- Invalid/expired token → `401 {"error":"令牌无效或已过期"}`.
- `403` is not produced by this wrapper; it is kept in the client vocabulary for reverse proxies and future upstream changes.

## SAG Source Model

A **Source** is the unit of knowledge ownership and is what `source.id` names. A source contains many **Documents**; each document has a `document_id`, a `status`, a `chunk_count`, a stored original file (`storage_path`), and chunks reachable by `chunk_id`. Document identity is stable and is the value a project should persist if it ever needs finer scope than a source; source identity is the value this phase persists.

## SAG Source Scoping

Scoping is applied by the ASGI wrapper, per request, before any tool runs:

```
/mcp/                      → all sources
/mcp/?source_id=<source>   → exactly that source
```

The wrapper loads `Source` rows, injects them into a `contextvars.ContextVar` (`use_scope`), and delegates. Consequences that shape this phase:

- Scope is **server-enforced**: tool-level `source_id` arguments can only _narrow within_ the injected scope (`_selected_sources` filters `scope.sources`), never widen it. A request scoped to source B cannot read source A through a tool argument.
- A `source_id` that does not exist returns **`404 {"error":"信源不存在"}` at connect time** — the MCP handshake never happens. This is the exact signal for the required "Source Missing" state, and it arrives before a harness could issue a single query.
- Scope isolation is per request, so one SAG instance serves many projects with different scopes concurrently.

## Real Instance Verification (this machine)

A SAG instance is already running locally, so the audited contract was checked against it rather than trusted from source alone. Endpoint `http://127.0.0.1:8000/mcp/`, credential from the existing `%APPDATA%\\sag\\dsh-connection.json` (never printed, never copied into Workbench). Read-only calls only; no source, document, or knowledge was created.

| observation                            | result                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| `initialize`, no credential            | `401 {"error":"缺少认证令牌"}`                                                        |
| `initialize`, with credential          | `200`, SSE stream, `serverInfo.name = "sag-knowledge"`, `serverInfo.version = 1.28.1` |
| transport shape                        | `event: message` + `data: {...}` SSE frames (mixed with `: ping` keep-alives)         |
| `tools/list`                           | the eight tools below, with SAG's Chinese titles                                      |
| `list_sources`, unscoped               | both sources, each with `source_id=<32 hex>` and document/chunk counts                |
| `list_sources`, `?source_id=<real id>` | `200`, exactly that one source - scope is real and server-enforced                    |
| `tools/call search`, scoped            | `200`, `（无相关资料）` for a non-matching query                                      |
| `?source_id=<nonexistent>`             | `404 {"error":"信源不存在"}`, before any MCP handshake                                |

Two notes for the record. First, the installed instance reports `1.28.1`, which is ahead of the `v1.8.7` release tag; the tool inventory and the scope/auth behaviour match `main` exactly, so the interface this phase codes against is the one actually deployed. Second, responses arrive as SSE with keep-alive comment frames, so the client must parse `data:` lines rather than expect a plain JSON body - the probe does.

## SAG Tool Inventory

Eight read-only tools, discovered via `tools/list` (all carry `readOnlyHint=True`):

| tool             | arguments                                            | purpose                                                      |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| `list_sources`   | –                                                    | sources in scope, with document/chunk counts and `source_id` |
| `search`         | `query`, `top_k` (1–50, default 8), `source_id?`     | semantic retrieval; returns evidence with `chunk_id`         |
| `get_entity`     | `name`, `source_id?`                                 | entity/context lookup                                        |
| `list_documents` | `source_id?`                                         | documents with `document_id` and status                      |
| `outline`        | `document_id`                                        | chapter/chunk structure with `chunk_id`s                     |
| `grep`           | `pattern`, `limit` (1–100, default 20), `source_id?` | literal search                                               |
| `read`           | `document_id`, `offset` (1-based), `limit` (≤500)    | raw line paging of the original file                         |
| `get_chunk`      | `chunk_id`, `source_id?`                             | full text of one chunk                                       |

There is no search-mode vocabulary (no `simple`/`advanced`), no rerank knob, and no document-creation tool. Retrieval policy is entirely SAG's. Workbench must not define a second vocabulary for any of this.

## Existing T3 External MCP Infrastructure

Phase 5 already generalized external MCP servers for provider sessions: `apps/server/src/mcp/McpProviderSession.ts` defines `McpProviderSessionExtraServer { name, url }` and `McpProviderSessionConfig.extraMcpServers`. Today the only producer is the thread browser (`ProviderService.resolveThreadBrowserServer`, which returns the loopback Playwright endpoint). The browser proved the ordering and failure semantics this phase reuses: no endpoint → the server is simply not attached.

## Existing MCP Authentication Support

Two distinct credential paths exist:

1. T3's own server: the server mints a credential (`issueMcpCredential`) and carries it as `authorizationHeader`; every adapter knows how to hand a Bearer credential to its provider (Codex via `bearer_token_env_var` + env var, Claude via `headers`, OpenCode via inline `headers`, the ACP adapters via `{name,value}` header lists).
2. Extra servers: **no credential field exists**. Each adapter currently hardcodes "no headers" for extras because the only extra server today is loopback-only and unauthenticated by upstream.

SAG requires a Bearer credential, so the extra-server descriptor needs exactly one new optional field and each adapter needs to pass it through. That is a mechanical follow-through of an existing pattern, not new machinery.

## Existing MCP Multiple Server Injection

Already handled in all six adapters — each maps `mcpSession.extraMcpServers` into its own native config (Codex `-c mcp_servers.<name>.url=…`, Claude JSON `mcpServers`, OpenCode `mcp.add`, Cursor/Grok/Antigravity ACP `mcpServers` arrays). Generic ACP (`GenericAcpAdapter`, `CursorAcpSupport`) is transport-level and contains no browser knowledge: it receives whatever servers its caller assembled. Adding a second extra server therefore requires **no adapter to learn about SAG**; the only change is the optional credential passthrough.

## Existing Project Settings

`packages/contracts/src/settings.ts` already models exactly the shape this phase needs:

- `PROJECT_SCOPED_SERVER_SETTING_KEYS` + `ProjectSettingsOverrides` – a per-project override record, applied through `resolveProjectSettings(settings, projectId)`.
- `projectSettingsOverrides: Record<ProjectId, ProjectSettingsOverrides>` in `ServerSettings`.
- `ProjectSettingsOverrides.enableAgentBrowserAccess` is the precedent for a project-scoped, capability-gating key.

A project-scoped knowledge scope is one new key in that record. **No migration is required**: project settings are a settings-file record, not a database table.

## Existing Sensitive Settings Handling

`apps/server/src/serverSettings.ts` is the only secret path:

- Provider-instance environment variables marked `sensitive` are stripped from `settings.json` and stored in `ServerSecretStore` under a derived key; on read they are materialized back; `redactServerSettingsForClient` blanks the value and sets `valueRedacted`.
- `usageLimitSources[].managementKey` uses the same trick with a six-bullet marker (`USAGE_LIMIT_SOURCE_KEY_REDACTED`) written to the file, so a client echoing the marker means "keep what you have".

This is the mechanism for the SAG token: a marker in `settings.json`, the value in `ServerSecretStore`, materialized for the server's own probe and never for a client DTO. No new vault, no new dependency.

## Existing Capability View

`apps/server/src/provider/capabilityView.ts` derives a `HarnessCapabilityView` at read time from live facts (never persisted). Browser and workspace tools both follow the pattern: "the harness must speak MCP **and** the second server must actually be up". `ProviderCommandReactor` supplies the facts when it composes a handoff. Knowledge needs the same treatment: `supported` when the provider is available, SAG is ready, and the project's scope resolves.

## Existing Handoff Knowledge Context

`packages/contracts/src/handoff.ts` composes a deterministic, budget-bounded briefing. It already has a `browser` section fed by live facts from the browser runtime (availability, profile mode, whether a stored profile exists) and drops it in as `capabilities.browser` for the capability list. The Phase 6 requirement ("briefing may say available + scope display name, never tool lists or content") is a second such section, sourced from the knowledge service rather than from the provider.

## Existing Artifact Registry

`thread_artifacts` (Phase 4) holds task-scoped files. Nothing about SAG sources or documents belongs there, and this phase writes no artifacts. The two stay separate; no "Add to Knowledge" action is built in V1.

## Existing Settings UI

`apps/web/src/components/settings/` already carries the primitives a minimal Knowledge section needs: `ScopedSwitch`, `SettingInheritance`, `RedactedSensitiveText`, `settingsScope.ts`, and the settings search registry. Project settings render through `ProjectSettingsPanel` with the scoped-settings hooks. The section is built from those pieces; no SAG-branded surface, no source/document manager, no graph viewer.

## SAG Process Ownership Decision

**Workbench does not install, deploy, or start SAG.** SAG is a configured external service reached over HTTP. No Docker pull, no compose file, no Python sidecar, no embedded `zleap-sag` runtime, no Desktop install, no database download. Absent SAG, Workbench behaves exactly as it did in Phase 5.

## Knowledge Ownership Decision

**SAG owns knowledge.** Workbench stores no sources, documents, chunks, embeddings, entities, events, graphs, or vectors, and creates no shadow tables. The only persisted facts are a connection (endpoint + credential) and a per-project scope selection (a source identity string).

## Project Scope Decision

Scope belongs to the **Project**, not to a thread, a harness, or a provider instance. Threads inherit their project's scope; a handoff changes nothing. The connection, by contrast, belongs to the Workbench (the server), so the token is configured once and never duplicated per project.

## Reuse Decision

Reuse, in this order: SAG's official MCP server as the only knowledge interface; Phase 5's `extraMcpServers` as the only injection path; the existing settings file for the connection; the existing project-override record for the scope; `ServerSecretStore` for the token; the existing capability view and handoff briefing for reporting. Nothing is proxied into a native toolkit: no `knowledge_search`/`knowledge_read` Workbench tools, because SAG's MCP tools are already reachable and Workbench has no business mirroring them.

## Required Extensions

1. `McpProviderSessionExtraServer` gains an optional `authorizationHeader`, and the six adapters pass it through (Codex via `bearer_token_env_var` + a per-server environment variable).
2. `packages/contracts/src/knowledge.ts`: diagnostic vocabulary + client copy, scope schema, connection schema, status DTO, and pure endpoint normalization/scope-URL helpers.
3. `ServerSettings.knowledge` (enabled/endpoint/token) + a `knowledgeScope` key in `ProjectSettingsOverrides`.
4. A server `KnowledgeService`: normalizes the endpoint, resolves a project's scope to an MCP URL, probes SAG (`initialize` → `tools/list` → optional `list_sources`), classifies failures, caches briefly, and answers "is knowledge available for this project".
5. `ProviderService`: a second extra-server resolver beside the browser's, combined into the same `extraMcpServers` array.
6. Capability view + handoff briefing knowledge facts; a `knowledge.status` RPC for the Settings UI and project diagnostics.
7. Settings UI: a connection card at Workbench level and a scope selector at project level.

## Things We Must Not Build

No second RAG: no retrieval algorithm, vector store, embedding pipeline, chunker, reranker, entity/event extraction, or knowledge graph. No Qdrant/Chroma/Milvus/Weaviate/pgvector/Elasticsearch. No provider-specific knowledge adapters or prompts (`CodexKnowledge`, `KimiKnowledge`, …) – standard MCP is the only path. No automatic retrieval per turn, no automatic project ingestion, no Browser→Knowledge or Office→Knowledge pipeline, no Knowledge chat, no SAG UI clone, no backup/migration engine, no `sag agent connect` CLI calls (they would create a second MCP configuration source of truth in `~/.codex`/`~/.claude`/the DSH profile). No `@zleap-ai/dsh-sag` dependency or DSH special-casing. No shadow knowledge tables, no persistence of `knowledge=true`.

## Proposed Minimal Architecture

```
Workbench settings
  knowledge.endpoint   ─┐
  knowledge.token       ├─ ServerSecretStore
  knowledge.enabled    ─┘
Project settings
  knowledgeScope = none | source(<source_id>) | all
        │
        ▼
KnowledgeService (server, no storage)
  normalize endpoint → build /mcp/?source_id=<id> → probe (initialize, tools/list, list_sources)
  classify: not-configured | disabled | ready | unauthorized | forbidden |
            source-not-found | connection-failed | timeout | mcp-handshake-failed
        │
        ▼
ProviderService.prepareMcpSession
  extraMcpServers = [browser?, sag-knowledge?]
        │
        ▼
Provider adapters (unchanged logic, one credential passthrough)
        │
        ▼
SAG instance  /mcp/  →  sources · documents · retrieval
```

Ownership: `Workbench → SAG connection`, `Project → knowledge scope`, `Thread → inherits`, `Harness → consumes via MCP`. Retrieval results reach the harness exactly as SAG produced them: Workbench never wraps, re-ranks, truncates, or re-serializes a SAG tool result, so `chunk_id`, `source_id` and the `来源：` citation lines survive verbatim.
