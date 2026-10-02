# Phase 5 Implementation Audit

Phase 5 target: give a Canonical Thread a real browser that survives harness handoff, by reusing
Microsoft's official Playwright MCP server instead of building any browser driver.

Frozen Phase 1–4 facts this audit must not disturb: Canonical Thread = `OrchestrationThread`; native
session mapping = `ProviderSessionDirectory` → `provider_session_runtime`; baton holder =
`provider_session_runtime.is_current`; handoff briefing composed from Canonical Thread facts; cwd =
`thread.worktreePath ?? project.workspaceRoot`; Tool Bus = the registered MCP toolkits behind the
existing `POST /mcp` transport.

## Frozen Decisions Carried Into This Phase

These are **not** open questions in Phase 5. They are recorded here so the implementation is judged
against them rather than re-litigated:

> **Decision: Canonical Thread owns exactly one Workbench-managed persistent browser profile in V1.**

> **Decision: Browser capability is provided by the official Playwright MCP server, reached through
> the existing MCP Tool Bus. No browser driver, no Playwright wrapper, no second tool protocol.**

> **Decision: Browser Runtime ≠ Browser Profile.** The runtime (the Playwright MCP process, and the
> browser it launches) may start, stop, crash and restart; the profile outlives all of that.

Project-shared profiles, shared browser identities, `project_profile_id` / `shared_profile_id` /
profile inheritance hierarchies, and multi-thread profile sharing are explicitly **out of scope for
V1** and are not designed here. The audit's only job is the smallest implementation of the frozen
decision above.

## Existing MCP Client / Injection Path

T3 is already an MCP _server_; Phase 5 needs T3 to be an MCP _client configurator_. That path exists:

1. `ProviderService.prepareMcpSession` (`apps/server/src/provider/Layers/ProviderService.ts:948-964`)
   computes the session's capability set, issues a per-thread bearer credential, and writes a
   `McpProviderSessionConfig` into a module-level, per-thread in-memory map.
2. `McpProviderSession` (`apps/server/src/mcp/McpProviderSession.ts`) is that map:
   `setMcpProviderSession` / `readMcpProviderSession(threadId)` / `clearMcpProviderSession`. It carries
   `endpoint`, `authorizationHeader`, `capabilities`, and an optional `agentDeviceEnvironment` — an
   existing precedent for shipping _non-secret launch data_ to adapters.
3. Each adapter reads it at session-start time and translates it into that provider's own MCP config
   shape:

   | Adapter                     | Injection site                                               | Shape                                                  |
   | --------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
   | Claude                      | `ClaudeAdapter.ts:4711-4760`                                 | `mcpServers: { <name>: { type, url, headers } }`       |
   | Codex                       | `CodexAdapter.ts:2257-2285`                                  | `-c mcp_servers.<name>.url=…` + bearer env             |
   | Cursor                      | `CursorAdapter.ts:551-594`                                   | `mcpServers: [ { type: "http", name, url, headers } ]` |
   | Generic ACP (Qwen/Kimi/DSH) | `GenericAcpAdapter.ts:20-29` delegates to the Cursor runtime | same array                                             |
   | OpenCode                    | `OpenCodeAdapter.ts:2830-2860`                               | `mcp: { <name>: { url, headers } }`                    |
   | Grok                        | `GrokAdapter.ts:995-1025`                                    | `mcpServers: [ … ]`                                    |
   | Antigravity                 | `AntigravityAdapter.ts:788-810`                              | `mcpServers: { … }`                                    |

   `GenericAcpAdapter` is not a separate implementation: it is `CursorAdapter` with an
   `acpRuntime` override, so the ACP family shares one injection site and the browser work never
   touches it directly.

**Key finding**: `AcpSessionRuntime` already types its option as
`readonly mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>` (`acp/AcpSessionRuntime.ts:96`) and
passes `options.mcpServers ?? []` straight into `session/new` and `session/load`
(`:728`, `:757`, `:830`). The ACP client path is therefore already **multi-server**; only one entry is
currently supplied, and that is a data decision, not an architectural limit.

**Conclusion**: injecting a second MCP server (Playwright MCP) requires no new transport, no new
client, and no per-provider browser code. It requires one new optional field on
`McpProviderSessionConfig` and one appended entry per adapter's existing MCP shape.

## Existing External MCP Configuration

There is no third-party MCP _server_ configuration surface in the product. `ServerSettings` has no
`mcpServers` list, there is no MCP marketplace, and `.mcp.json` at the repo root is contributor
tooling for the agents working _on_ this repo (`xcodebuildmcp`), not a product feature.

The only external-MCP precedent is the same one Phase 4 relied on: the host decides, the adapter
translates. Playwright MCP must follow it. A user-facing "add any MCP server" surface would be a
different feature and is out of scope.

## Existing MCP Server Lifecycle

T3's own MCP server is **in-process**: `McpServer.layerHttp({ name: "T3 Code", path: "/mcp" })`
(`mcp/McpHttpServer.ts:630`), merged with toolkit registrations
(`McpHttpServer.ts:596-620`). It has no spawn, no port reservation, no health probe, no restart logic,
because it _is_ the server process.

Consequence: Phase 5 is the first case where T3 must own a **separate, long-lived, out-of-process**
MCP server. That is a genuinely new capability, and the honest question is whether an existing
Lifecycle pattern can be reused rather than invented.

## Existing Device Hub Process Pattern

Yes — `LocalDeviceHost` already owns exactly this shape of process
(`apps/server/src/device/LocalDeviceHost.ts`):

| Concern          | Existing mechanism                                                                       | Lines              |
| ---------------- | ---------------------------------------------------------------------------------------- | ------------------ |
| Serialized start | `Semaphore.make(1)` + `Ref<RunningHost \| null>`                                         | `:195-197`         |
| Port             | `net.reserveLoopbackPort("127.0.0.1")`                                                   | `:310`             |
| Spawn            | `ChildProcessSpawner.spawn(ChildProcess.make(...))` bound to a `Scope`                   | `:321-354`         |
| Health           | `waitForHttpReady({ baseUrl, path: "/readyz", timeoutMs })`, stop on failure             | `:358-371`         |
| Output           | `Stream.decodeText` → `Stream.splitLines` → debug log                                    | `:377-387`         |
| Crash recovery   | `hub.json` = `{ pid, port, entryPath }` written under the state dir                      | `:241`, `:293-301` |
| Stale reap       | read `hub.json`, `process.kill(pid, 0)`, confirm argv contains `entryPath`, then SIGTERM | `:258-291`         |
| Stop             | `Scope.close(scope)` — process lifetime, never data lifetime                             | `:238-239`         |

This is the pattern to reuse. Phase 5 must **not** build a second generic supervisor; it adds one more
thin consumer of the same primitives.

## Existing Preview Architecture

T3 already ships an agent-drivable browser, and it is important to be precise about what it is:

- `PreviewAutomationBroker` (`apps/server/src/mcp/PreviewAutomationBroker.ts`) brokers preview
  automation between a provider session and a **desktop runtime**: it selects a host connection,
  issues a host-assignment lease, and forwards operations over the connected desktop client.
- The `preview` toolkit (`mcp/toolkits/preview/tools.ts`) exposes 14 tools — `preview_open`,
  `preview_navigate`, `preview_click`, `preview_type`, `preview_press`, `preview_scroll`,
  `preview_evaluate`, `preview_wait_for`, `preview_snapshot`, `preview_resize`,
  `preview_set_appearance`, `preview_recording_start/stop`, `preview_status`.
- It is gated by the existing `ServerSettings.enableAgentBrowserAccess` (default `true`) through the
  `preview` MCP capability (`ProviderService.ts:873-917`).
- It owns **no** browser process, **no** profile directory, and **no** port. The browser tab, its
  window, and its storage live in the Electron client that displays it; the broker only routes
  commands to a tab that a human is also looking at.

**Answer to the audit's explicit question**: Preview is a UI preview/rendering surface with
agent automation attached. It is _not_ a general browser lifecycle, and it has no reusable
`browser process`, `profile`, `port`, or `lifecycle` to share.

## Existing Browser-related State

- Capability: `preview` in `McpInvocationContext.McpCapability`
  (`McpInvocationContext.ts:11` — today `"preview" | "device" | "pull-requests" | "office"`).
- Settings: `ServerSettings.enableAgentBrowserAccess` (default `true`) and the per-project override
  key `EnableAgentBrowserAccess` in `projectSettingsOverrides`
  (`packages/contracts/src/settings.ts:1016-1017`, `:1078`, `:1104`); resolved per thread by
  `agentAccessSettings` in `ProviderService.ts:869-904`.
- UI: `apps/web/src/components/settings/ProjectDefaultsSettings.tsx:424-452` already renders a
  scoped "agent browser access" switch, and `SettingsPanels.tsx:618-791` tracks it as a
  non-default setting.
- Artifacts: `browser-artifacts` directory for preview screenshots (see below).
- **No** browser table, **no** cookie/tab/history storage, **no** profile registry.

## Existing Userdata Paths

`deriveServerPaths` (`apps/server/src/config.ts:111-147`) is the single path abstraction:

- `stateDir` = `<baseDir>/userdata` (or `<baseDir>/dev` when serving a dev URL and `baseDir` was not
  explicit) — this is the "T3 userdata directory" the phase brief refers to.
- Already derived: `dbPath`, `attachmentsDir`, `logsDir`, `providerLogsDir`, `worktreesDir`,
  `settingsPath`, `themesDir`, `providerStatusCacheDir`, `secretsDir`, and
  **`browserArtifactsDir = join(stateDir, "browser-artifacts")`** — an existing browser-adjacent
  userdata path, currently used only for preview screenshots (`McpHttpServer.ts:308-310`).

So a thread-scoped browser profile belongs under this abstraction, next to `browser-artifacts`, and
must never be derived from the project workspace root.

## Playwright MCP Current Architecture

Checked against the current upstream source and README (not old tutorials):

- Package: **`@playwright/mcp`**, Apache-2.0, `bin.playwright-mcp` → `cli.js`, `engines.node >= 18`.
- Latest published version at audit time: **`0.0.81`**, depending on
  `playwright` / `playwright-core` `1.64.0-alpha-2026-09-14`. Every recent `@playwright/mcp` release
  depends on an alpha Playwright build — that is upstream's normal release shape, and pinning the
  MCP package in the lockfile pins those transitive versions exactly.
- `cli.js` is a thin shim: it requires `playwright-core/lib/utilsBundle` and
  `playwright-core/lib/coreBundle` and calls `tools.decorateMCPCommand(program, version)`. The real
  CLI lives in `playwright-core`; the repo's `src/` is a README pointer only.
- An `install-browser` subcommand exists (`playwright-mcp install-browser` → rewrites to
  `playwright install`), i.e. upstream provides an **explicit** browser-install action.
- Tools are the official `browser_*` family (navigate/click/type/snapshot/screenshot/…), defined by
  upstream. Workbench does not restate, wrap, or proxy them.

## Playwright MCP Transport Options

| Option                       | Meaning                                                     | Phase 5 reading                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| (none)                       | stdio MCP                                                   | Natural for a client that spawns its own server; wrong here, because the process must be shared by whichever harness holds the baton |
| `--port <n>`                 | serve MCP over HTTP/SSE                                     | **Chosen** — matches the existing Tool Bus shape (URL + optional headers), so adapters need one more entry, not a new client         |
| `--host <host>`              | bind host; default localhost                                | Bound to `127.0.0.1`                                                                                                                 |
| `--allowed-hosts <hosts...>` | DNS-rebinding protection for the HTTP server                | Set to the loopback host                                                                                                             |
| `--shared-browser-context`   | reuse one browser context across all connected HTTP clients | Needed so a handoff target picks up the _same_ tabs, not a fresh context                                                             |

The HTTP transport is chosen because the session-credential/Tool-Bus architecture already speaks MCP
over HTTP, and because a stdio server cannot be shared across provider sessions without T3 becoming
an MCP proxy — exactly the thing the phase brief forbids.

## Playwright MCP Profile Modes

| Mode                 | Flag                     | Behaviour                                                                                            |
| -------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| Persistent (default) | `--user-data-dir <path>` | Logged-in state persists on disk; the profile can be deleted between sessions to clear offline state |
| Isolated             | `--isolated`             | Profile kept in memory; all storage state lost when the browser closes                               |
| Storage state        | `--storage-state <file>` | Seeds an isolated context from a JSON file                                                           |
| Existing browser     | `--extension`            | Connects to the user's running Chrome/Edge via the Playwright extension                              |
| CDP                  | `--cdp-endpoint`         | Attaches to an existing Chromium-family browser over CDP                                             |

Two upstream facts drive the V1 design:

1. **The default profile path is per _workspace_, not per thread**:
   `%USERPROFILE%\AppData\Local\ms-playwright\mcp-{channel}-{workspace-hash}`, where the hash comes
   from the MCP client's workspace root. Leaving the default in place would give a _project_-scoped
   profile shared by every thread in the project — the exact ownership model V1 forbids. The profile
   path must therefore always be passed explicitly.
2. **A persistent profile is single-occupancy**: "A persistent profile can only be used by one browser
   instance at a time." That is the real source of `Profile Locked`, and it is why ≥2 browser
   runtimes for one thread/profile must be impossible by construction rather than by convention.

## Browser Ownership Decision

> **A Canonical Thread owns exactly one Workbench-managed browser runtime and exactly one browser
> profile.** Ownership attaches to the thread — not to the harness, the provider, the native session,
> or the project.

Rejected, with reasons:

| Option                                                             | Why rejected                                                                                                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-harness browser (`CodexBrowser`, `KimiBrowser`, …)             | Directly contradicts the product's reason to exist: handoff would reset browser state, and it duplicates process/profile management per provider                            |
| Per-native-session browser                                         | Same failure, one level lower: every handoff creates a new native session, so this is per-harness ownership in disguise                                                     |
| One global Workbench profile                                       | Cross-thread cookie and `localStorage` leakage; a single profile can also only be used by one browser instance, so all threads would serialize behind one lock              |
| Project-shared profile for multiple threads                        | **V1 forbidden.** Introduces cross-thread state leakage, profile locking between threads, ambiguous lifecycle, ambiguous cleanup ownership, and ambiguous handoff semantics |
| Project shared profile _plus_ thread runtime (two-layer ownership) | Same problems with an extra layer to explain                                                                                                                                |

The project contributes only `workspaceRoot` (the filesystem boundary). It owns no browser identity.

## Thread/Profile Mapping Decision

```text
Project
  ├── Thread A ──► Browser Profile A   (userdata/browser/<threadId>/profile)
  ├── Thread B ──► Browser Profile B
  └── Thread C ──► Browser Profile C
```

- Profile identity is **derived**, not stored: `Canonical Thread ID` → deterministic path under
  `ServerConfig.stateDir`. Same thread ⇒ same directory, forever, across process restarts, handoffs,
  Workbench restarts and crash recovery. Different threads ⇒ disjoint directories ⇒ disjoint
  cookies, `localStorage`, `sessionStorage`, IndexedDB, history and tabs.
- The exact path comes from the existing `Path.Path` service plus the existing `stateDir`; nothing is
  hardcoded, and nothing is placed under the project workspace or the git repository.

## Preview vs Browser MCP Boundary

They stay **separate**. The audit found no shared low-level infrastructure to reuse:

|            | Preview                                                                    | Playwright MCP (Phase 5)                                            |
| ---------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| What it is | A collaborative browser **tab in the desktop client**, driven by the agent | A standalone **browser process** owned by the server                |
| Owner      | The Electron client that renders the tab                                   | The Workbench server                                                |
| Profile    | The client's own tab storage                                               | Workbench-managed per-thread directory                              |
| Lifecycle  | Tab lifetime = client session                                              | Process + profile lifecycle, restartable                            |
| Purpose    | Let a human watch dev-server output while an agent pokes at it             | Let an agent really browse, log in, fill forms, upload and download |
| Capability | `preview`                                                                  | new `browser`                                                       |

Merging them would force the browser through a desktop client connection and break the headless/
remote cases. Phase 5 therefore does **not** embed the Playwright browser into the preview panel
(§55 of the brief), and does **not** reimplement preview tools.

## Handoff Browser Continuity

```text
Thread A, baton = Provider A, browser profile = P(A), runtime = R(A)
   └── handoff ──► baton = Provider B
Thread A, browser profile = P(A)  ← unchanged
           runtime = R(A)         ← unchanged (same thread key, same process)
```

Both halves follow from the frozen mapping rather than from handoff-specific code:

- The runtime registry is keyed by `threadId`, so a handoff (which changes the provider session, not
  the thread) hits the reuse path instead of the spawn path.
- The profile path is a pure function of `threadId`, so no handoff step can produce a new one.
- The new baton holder receives the _same_ MCP endpoint as the previous one, because the endpoint is
  read from the same per-thread runtime entry.
- `--shared-browser-context` keeps the HTTP connection's browser context stable across the
  credential/session change, and the on-disk profile keeps cookies either way.

Briefing impact is deliberately tiny (one derived capability line plus a two-fact browser section).
The DOM, cookies, storage state, and the `browser_*` tool catalog are never placed in a briefing —
the target harness discovers tools through standard MCP listing.

## Security / Network Boundary

Playwright MCP reaches the open network, so the boundary has to be stated honestly.

What upstream actually provides, per the current README:

- `--allowed-origins` / `--blocked-origins`, with `http://localhost:*`-style wildcard ports;
  blocklist evaluated first. **Upstream states these are not a security boundary and do not affect
  redirects.** They are useful as a speed bump and as an explicit policy surface, not as a sandbox.
- File access is **restricted to workspace roots by default** (cwd when no roots are configured), and
  navigation to `file://` URLs is blocked; `--allow-unrestricted-file-access` is the opt-out.
  This is a real, upstream-enforced boundary and Phase 5 keeps it (no opt-out flag is passed).
- `--output-dir` controls auto-named output files; explicitly named files resolve against the
  workspace root and are unaffected by it. `--output-max-size` evicts old outputs.
- `--allowed-hosts` guards the HTTP server against DNS rebinding.
- `--secrets <path>` masks matching plaintext in tool responses; upstream itself labels it a
  convenience, not a security feature.

What Phase 5 adds on top, and deliberately does not overclaim:

- The MCP HTTP server binds `127.0.0.1` only, and the endpoint is never exposed to the network or to
  clients.
- The loopback endpoint carries **no bearer token** — upstream has no auth for its HTTP transport.
  The boundary is therefore "loopback + unguessable port", the same trust level as the device hub's
  local listener. This is recorded as a known limitation rather than papered over.
- No private-LAN / link-local / cloud-metadata blocklist is invented. A home-grown SSRF framework is
  explicitly out of scope; V1 ships a configurable origin allow/block list passed straight through to
  upstream, and the default is upstream's default (allow all), documented as such.

## Process Lifecycle Decision

Reuse the device-hub pattern, keyed by `threadId`:

```text
Stopped ──start──► Starting ──ready──► Ready ──stop──► Stopping ──► Stopped
                      │                   │
                      └──► Error ◄────────┘   (browser launch / handshake failure)
```

- **start** is idempotent per thread: a semaphore plus a `Ref<Map<ThreadId, Runtime>>` guarantees at
  most one Workbench-owned runtime per thread, whatever the caller concurrency.
- **reuse**: a second start for a ready thread returns the existing endpoint instead of spawning.
- **stop** closes the process scope and leaves the profile directory on disk untouched.
- **restart**: stop then start yields the same profile path — a new runtime, the same identity.
- **crash recovery**: a `runtime.json` `{ pid, port, entryPath }` record under the thread's browser
  directory is reaped on the next start exactly like `hub.json`, after confirming the pid is alive
  _and_ that its command line still names our entry path.
- **profile lock**: if the profile is held by a process Workbench did not start, the runtime reports
  `profile-locked` and does not delete lock files, does not kill unknown browsers, and does not fall
  back to a different directory.
- **idle**: no Workbench idle timer is added. Upstream's own `--idle-timeout` (default: never for
  headed, 1 hour for headless) closes the _browser_ while the MCP server stays up, which is exactly
  the "reduce resource use without losing login state" behaviour the brief asks for.

## Persistence Decision

**None.** Everything Phase 5 needs is derived or ephemeral:

| Fact                                             | Where it lives                               | Persisted?                                                  |
| ------------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------- |
| Which thread owns which profile                  | `threadId` → path function                   | Derived                                                     |
| Profile contents                                 | `<stateDir>/browser/<threadId>/profile`      | On disk, owned by Chrome, never read or parsed by Workbench |
| Runtime status / endpoint / pid                  | in-memory runtime registry                   | Ephemeral                                                   |
| Crash-recovery hints                             | `<stateDir>/browser/<threadId>/runtime.json` | Written for reaping only; not a source of truth             |
| User preferences (profile mode, browser channel) | existing `ServerSettings` → `settings.json`  | Existing file store, no migration                           |
| Browser availability in capability views         | computed at read time                        | Derived                                                     |

No `browser_sessions` table, no `browser_tabs` / `browser_history` / `browser_cookies` table, no
`browser_profiles` registry. `Migrations.ts` is not touched.

## Required Extensions

1. A **browser runtime service** (one thin service, not a framework): per-thread start/stop/reuse/
   restart/status/diagnostics, spawn + loopback port + HTTP readiness + stale reap, profile path
   derivation, and an explicit `Reset Browser Session` destructive action.
2. One optional field on `McpProviderSessionConfig` carrying the extra loopback MCP endpoint(s), so
   adapters stay provider-shaped and browser-agnostic.
3. One appended entry at each existing MCP injection site (7 adapters, all the same data).
4. One **derived** `browser` capability field on `HarnessCapabilityView` and the handoff briefing —
   no tool catalog, no per-tool rows, and no new `McpCapability` value. The audit originally
   proposed a `"browser"` capability; implementation showed it would be dead machinery, because
   `McpCapability` exists to gate _T3's own_ toolkits at call time and Playwright MCP is a separate
   server with no credential of ours. Availability is therefore expressed purely as derived state,
   which is what the phase brief's "browser availability should be derived" actually asks for. The
   existing `enableAgentBrowserAccess` switch remains the on/off gate.
5. Two optional `ServerSettings` keys (profile mode, browser channel) with decoding defaults.
6. Diagnostics vocabulary surfaced to the user: `Not Configured`, `Runtime Missing`, `Starting`,
   `Ready`, `Browser Launch Failed`, `MCP Handshake Failed`, `Profile Locked`, `Stopped`.
7. Minimal user-visible control: start/stop plus profile mode and browser channel, reusing the
   existing Settings surface and the existing `enableAgentBrowserAccess` switch as the on/off gate.

## Things We Must Not Build

- A `BrowserDriver`, `BrowserController`, `BrowserAutomationEngine`, `PlaywrightWrapper`, or
  `WebAutomationProtocol`.
- `navigate` / `click` / `type` / `snapshot` / `screenshot` tools proxied into `Tool.make`.
- Any `browser_*` tool schema copied into Workbench, or into a capability registry.
- Browser logic in `GenericAcpAdapter` (or any adapter beyond appending an MCP entry).
- A `BrowserArtifactRegistry`, `browser_session` table, or per-tool availability table.
- A second process supervisor alongside the device-hub pattern.
- A `BrowserApprovalFramework`; the existing credential + capability boundary stands.
- A password manager, captcha solver, anti-bot bypass, proxy/VPN manager, RPA recorder, browser
  marketplace, remote browser farm, or a self-written SSRF framework.
- Preview-panel embedding of the Playwright browser.
- Automatic browser-binary downloads, or `npx @playwright/mcp@latest` at runtime.
- Knowledge/RAG (Phase 6) or model gateway (Phase 7) work of any kind.

## Proposed Minimal Architecture

```text
Canonical Thread
   │
   ├── Harness native session ──► POST /mcp ──► T3 toolkits (pull-requests, preview, device, office)
   │
   └── Browser runtime (keyed by threadId, owned by the server)
           │  userdata/browser/<threadId>/{profile,output,runtime.json}
           │
           ▼
   Playwright MCP process  (pinned @playwright/mcp, HTTP, 127.0.0.1, --user-data-dir, --shared-browser-context)
           │
           ▼
   the same MCP credential hands the endpoint to whichever provider session currently holds the baton:
        mcpServers = [ t3-code (existing), playwright (new, one extra entry) ]
           │
           ▼
   official browser_* tools ──► real Chrome/Edge (headed by default)
```

Explicitly absent from the diagram: no proxy layer, no tool mirror, no second registry, no migration,
no browser database, and no per-provider browser code.
