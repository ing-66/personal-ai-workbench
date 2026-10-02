# Phase 5 Report

## 1. Result

**PASS**, with the environment caveats recorded in §21 and the known limitations in §22.

Phase 5 gives a Canonical Thread a real browser by reusing Microsoft's official Playwright MCP
server. No browser driver, no Playwright wrapper, no second tool protocol, no proxy layer, no new
table, and no per-harness browser code were written. The browser session is owned by the thread, so a
harness handoff reuses the same process and the same profile, and the endpoint is delivered to
whichever provider holds the baton as one extra standard MCP server entry.

This run resumed after an unintended API interruption. It did **not** restart the phase: the audit,
sources, and working-tree changes from the interrupted run were kept, the dependency environment was
repaired first, and only then was the phase verified and closed out (§19, §23).

## 2. Implementation Audit Summary

Full pre-coding audit: `docs/spikes/PHASE5_IMPLEMENTATION_AUDIT.md`. The findings that shaped the
implementation:

- **MCP client injection already existed.** `ProviderService.prepareMcpSession` writes a per-thread
  `McpProviderSessionConfig` (`endpoint`, `authorizationHeader`, `capabilities`) into an in-memory map
  that every adapter reads at session start. `AcpSessionRuntime` already typed its option as
  `ReadonlyArray<McpServer>`, so the ACP family was _already_ multi-server capable.
- **`GenericAcpAdapter` is not a separate implementation** — it is `CursorAdapter` with an
  `acpRuntime` override, so the browser work touches one injection site for Qwen/Kimi/DSH.
- **Preview is not a browser lifecycle.** `PreviewAutomationBroker` plus the 14 `preview_*` tools drive
  a _collaborative tab in the desktop client_. It owns no process, no port, and no profile, so there
  was no low-level infrastructure to share. The two stay separate (§11).
- **A process pattern already existed**: `LocalDeviceHost` (loopback port reservation, spawn bound to a
  scope, HTTP readiness probe, `hub.json` for stale reaping, scope-based stop). Phase 5 reuses that
  shape rather than adding a second supervisor.
- **The real profile problem is upstream's default.** Playwright MCP derives its default profile from
  the _workspace root_ (`mcp-{channel}-{workspace-hash}`), which would have produced exactly the
  project-shared profile V1 forbids. The profile path therefore always has to be passed explicitly.
- **The frozen decisions were carried in, not re-litigated**: one Canonical Thread ⇒ exactly one
  Workbench-managed persistent profile; browser capability provided by the official server through the
  existing Tool Bus; runtime lifetime ≠ profile lifetime.

## 3. Official Playwright MCP Version

| Field                   | Value                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------- |
| Package                 | `@playwright/mcp`                                                                   |
| Version                 | **0.0.81** (pinned, exact — no caret, no `latest`, no `npx`)                        |
| Licence                 | Apache-2.0                                                                          |
| Transitive dependencies | `playwright` / `playwright-core` `1.64.0-alpha-2026-09-14`                          |
| Binary                  | `playwright-mcp` → `cli.js`, launched as `node <cli.js>` with the server's own Node |

Every recent `@playwright/mcp` release depends on an alpha Playwright build; that is upstream's normal
release shape, and pinning the MCP package pins those transitive versions exactly in the lockfile.
`pnpm-lock.yaml` now contains `'@playwright/mcp@0.0.81'`.

## 4. Build vs Reuse Decision

| Concern                                          | Decision                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser automation                               | **Reuse** — the official Playwright MCP server. No `BrowserDriver`, `BrowserController`, `BrowserAutomationEngine`, `PlaywrightWrapper`, or `WebAutomationProtocol` was created |
| `navigate` / `click` / `type` / `snapshot` tools | **Reuse** — they are upstream's `browser_*` tools. Nothing is proxied into `Tool.make`, and no schema is copied                                                                 |
| MCP transport                                    | **Reuse** — upstream's streamable-HTTP transport on loopback, handed to providers as one more MCP server entry                                                                  |
| Process supervision                              | **Reuse the device-hub pattern** (port reservation, scope-bound spawn, readiness probe, stale-record reaping); no second generic supervisor                                     |
| Capability reporting                             | **Reuse and extend** — one derived `HarnessCapabilityView.browser` field, no persisted catalog                                                                                  |
| Persistence                                      | **None** — no table, no migration, no settings store beyond two existing-key additions                                                                                          |
| Browser runtime and profile on disk              | **Build the thin part only**: path derivation, lifecycle, diagnostics                                                                                                           |

The official server is the single source of truth for browser tool definitions. Workbench stores and
derives only: server configured, server available, profile, endpoint, capability, lifecycle state.

## 5. Browser Architecture

```text
Canonical Thread
   │
   ├── Harness native session ──► POST /mcp ──► T3 toolkits (pull-requests, preview, device, office)
   │
   └── Browser runtime (keyed by threadId, owned by the server)
           │  <stateDir>/browser/<thread>/profile   (Chromium owns the contents)
           │  <stateDir>/browser/<thread>/output    (auto-named screenshots, snapshots, traces)
           │  <stateDir>/browser/<thread>/runtime.json (crash-recovery hint only)
           ▼
   Playwright MCP process  (pinned 0.0.81, HTTP, 127.0.0.1, --user-data-dir, --shared-browser-context)
           ▼
   the same MCP credential hands the endpoint to whichever provider session holds the baton:
        mcpServers = [ t3-code (existing), playwright (new, one extra entry) ]
           ▼
   official browser_* tools ──► real Chrome (headed by default)
```

Implementation: `apps/server/src/browser/BrowserPaths.ts` (pure path derivation) and
`apps/server/src/browser/BrowserRuntime.ts` (one service).

## 6. Browser Ownership

> A Canonical Thread owns exactly one Workbench-managed browser runtime and exactly one browser
> profile. Ownership attaches to the thread — not to the harness, the provider, the native session,
> or the project.

Consequences that are visible in the code:

- The runtime registry is a `Ref<Map<ThreadId, RuntimeEntry>>`; nothing on the path knows which
  provider is calling. A handoff (which replaces the native session, never the thread) is simply a
  second `start` for the same thread, which hits the reuse branch.
- The profile directory is a pure function of the thread id, so no handoff, restart, or crash can
  produce a new one.
- `Project` contributes only `workspaceRoot` for the process's working directory.
- No `project_profile_id`, `shared_profile_id`, or profile-inheritance concept exists anywhere.

## 7. Profile Strategy

**Persistent by default** (`agentBrowserProfileMode`, default `persistent`); **`isolated`** is
supported and stores nothing on disk.

Profile identity is derived, not stored:

```text
threadId → "<sanitized-id-prefix>-<fnv1a32>" → <stateDir>/browser/<segment>/profile
```

- `stateDir` comes from the existing `ServerConfig` path abstraction (`userdata/`, or `dev/` under a
  dev server). Nothing is hardcoded; no `C:\…` or `D:\…` appears in the source.
- The raw thread id is never used as a filename: it is a free-form non-empty string, so characters
  outside `[A-Za-z0-9_-]` are replaced and a stable 32-bit digest is appended, keeping
  `../../etc/passwd` and `a/b` distinct from `a_b`.
- Thread isolation: `Thread A → Profile A`, `Thread B → Profile B`, and A ≠ B. Asserted by test.
- Nothing under the profile is ever read, parsed, copied into the database, or logged; Chromium owns
  the contents. `git status` stays clean — asserted by test and by the smoke test.

## 8. Process Lifecycle

```text
Stopped ──start──► Starting ──ready──► Ready ──stop──► Stopping ──► Stopped
                      │                   │
                      └──► Error ◄────────┘   (browser launch / MCP handshake failure)
```

- **One runtime per thread, by construction**: state is keyed by thread id and every transition runs
  under one `Semaphore`, so concurrent starts cannot produce two processes and two processes can
  never fight over one persistent profile.
- **Reuse**: a second `start` for a ready thread returns the existing endpoint and spawns nothing.
- **Stop keeps the profile**: `stop` kills the process and closes its scope, then removes only
  `runtime.json`.
- **Restart reuses the profile**: the same thread always re-resolves to the same directory.
- **Crash recovery**: `runtime.json` (`{ pid, endpoint }`) is reaped on the next start; a dead pid is
  cleaned up and the profile is reused.
- **Profile lock**: a lock entry in the profile directory, or a live pid recorded by a previous
  server, produces `profile-locked`. Lock files are never deleted and browsers Workbench did not
  start are never killed.
- **Shutdown**: the layer is built with `Effect.acquireRelease`, so an orderly teardown stops every
  process this server started.
- **Teardown ordering matters and is deliberate**: the child is killed _before_ its scope is closed.
  Closing the scope also has to interrupt the fiber draining the process's stdout, and a browser that
  never closes its streams would leave that interruption pending — which hung every stop until this
  was fixed.

## 9. MCP Injection

One optional field, one entry per adapter — no browser-specific adapter code:

- `McpProviderSessionConfig.extraMcpServers?: ReadonlyArray<{ name, url }>` — plain launch data, the
  same shape of precedent as the existing `agentDeviceEnvironment`.
- `ProviderService.resolveThreadBrowserServer` starts (or reuses) the thread's runtime and returns the
  entry, or `undefined` for every reason there is no browser: the runtime service is absent, the
  browser is switched off for the thread's project, the thread/project cannot be resolved, or the
  session never reached `ready`.
- Adapters append it to their _existing_ MCP configuration:

  | Adapter                                    | Shape                                       |
  | ------------------------------------------ | ------------------------------------------- |
  | Cursor / **Generic ACP** (Qwen, Kimi, DSH) | one more element of `mcpServers[]`          |
  | Grok                                       | one more element of `mcpServers[]`          |
  | Antigravity                                | one more element of `mcpServers[]`          |
  | Claude                                     | one more key of `mcpServers{}`              |
  | Codex                                      | one more `-c mcp_servers.<name>.url=…` pair |
  | OpenCode                                   | one more `mcp.add` registration             |

The ACP entries carry `headers: []` because ACP's `McpServerHttp` requires the field; upstream's HTTP
transport is loopback-only and unauthenticated, so nothing is minted for it.

`GenericAcpAdapter` itself was **not** modified — it inherits the injection through the shared
Cursor/ACP path.

## 10. Capability View

`HarnessCapabilityView.browser` is a new **derived** field (`supported | unsupported | unknown`),
computed at read time from live facts: the target instance is available, and the thread's runtime is
ready with a known endpoint. It is not persisted, and there is no per-tool or per-server catalog — the
official `browser_*` tool list stays upstream's.

**Deliberate deviation from the audit**: the audit proposed a new `McpCapability` value `"browser"`.
Implementation showed it would be dead machinery, because `McpCapability` exists to gate _T3's own_
toolkits at call time and Playwright MCP is a separate server with no credential of ours. The audit was
updated to record this. The existing `enableAgentBrowserAccess` switch remains the on/off gate, so no
new user-facing toggle was invented.

A provider that cannot speak MCP simply never receives the endpoint, and its capability view reports
`browser: unsupported`. There is no fallback path, no terminal substitute, and no provider-specific
bridge.

## 11. Preview Boundary

Preview and the thread browser stay **separate**, and Preview was not modified.

|            | Preview                                           | Thread browser (Phase 5)                         |
| ---------- | ------------------------------------------------- | ------------------------------------------------ |
| What it is | A collaborative browser tab in the desktop client | A standalone browser process owned by the server |
| Owner      | The Electron client rendering the tab             | The Workbench server                             |
| Profile    | The client's own tab storage                      | A Workbench-managed per-thread directory         |
| Capability | `preview`                                         | derived `browser`                                |

The Playwright browser is deliberately **not** embedded in the preview panel: doing so would force it
through a desktop client connection and break the headless/remote cases. The audit found no reusable
`browser process` / `profile` / `port` / `lifecycle` in Preview, so nothing was shared.

## 12. Workspace / Downloads / Uploads

The boundary is upstream's own, positioned correctly rather than re-implemented:

- The Playwright MCP process is spawned with **cwd = `thread.worktreePath ?? project.workspaceRoot`**.
  Upstream's documented default is "access to the file system is restricted to workspace root
  directories (or cwd if no roots are configured) only, and navigation to `file://` URLs is blocked".
  cwd therefore _is_ the boundary, and `--allow-unrestricted-file-access` is never passed.
- `--output-dir` points at `<stateDir>/browser/<thread>/output`, so auto-named output (an unnamed
  screenshot, a page snapshot, a trace) lands in userdata and never sprays the project. This is
  asserted by test and observed in the smoke run, where upstream wrote
  `…/output/page-<timestamp>.yml`.
- Explicitly named files still resolve against the workspace root, by upstream design.
- Uploads are bounded by the same cwd rule: the agent cannot reach `~/.ssh`, an `.env` outside the
  project, or the browser profile through the browser tool surface.
- No `BrowserArtifactRegistry` was created. A downloaded file that a user or agent deliberately keeps
  is a workspace file and follows the existing `thread_artifacts` path; nothing auto-registers
  browser output as an important artifact.

## 13. Authentication / Sensitive State

- The profile directory is never read, parsed, or copied. Workbench only creates it, points at it and
  (on explicit request) deletes it.
- Cookies, `Authorization` headers, form values, passwords, and storage state never enter a log, a
  thread activity, a handoff briefing, the Artifact Registry, or the project workspace. The diagnostic
  channel is a **closed enum** with fixed user-facing copy, so there is no free-form field a URL, page
  title, or cookie could be smuggled through.
- Upstream's process output is logged at debug level only and never forwarded to a client.
- No password manager, no storage-state export, no credentials were added.
- `resetProfile` (which deletes the stored profile) is a destructive action reachable only from an
  explicit caller; no agent-callable tool triggers it.

## 14. Handoff Continuity

```text
Thread A, baton = Provider A, profile = P(A), runtime = R(A)
   └── handoff ──► baton = Provider B
Thread A, profile = P(A)  ← unchanged
           runtime = R(A)  ← unchanged
```

Both follow from the frozen mapping rather than from handoff-specific code, and both are covered by
tests:

- `reuses the same browser when the baton changes harness` — a second `start` for the same thread
  returns the same endpoint and spawns nothing.
- `stopping keeps the stored profile and restarting reuses it` — a new runtime, the same profile
  identity.
- `keeps thread profiles disjoint` — Thread B cannot inherit Thread A's cookies or storage.

The briefing carries **two facts and a mode** (`available`, `profileMode`,
`persistentSessionExists`) plus one derived capability line. No DOM, no tab list, no URL, no cookie,
no storage state, and no `browser_*` tool catalog. The target discovers tools through normal MCP
listing.

## 15. Persistence

**No runtime state is persisted.** Everything is derived or ephemeral:

| Fact                            | Where it lives                              | Persisted?                                      |
| ------------------------------- | ------------------------------------------- | ----------------------------------------------- |
| Which thread owns which profile | thread id → path function                   | Derived                                         |
| Profile contents                | `<stateDir>/browser/<thread>/profile`       | On disk, owned by Chromium, never read          |
| Status / endpoint / pid         | in-memory registry                          | Ephemeral                                       |
| Crash-recovery hint             | `<stateDir>/browser/<thread>/runtime.json`  | Written for reaping only, not a source of truth |
| User preferences                | existing `ServerSettings` → `settings.json` | Existing file store                             |
| Browser availability            | computed at read time                       | Derived                                         |

Two settings keys were added to the existing `ServerSettings` (and `ServerSettingsPatch`):
`agentBrowserProfileMode`, `agentBrowserChannel`, `agentBrowserHeadless` — all with decoding defaults,
so an existing `settings.json` decodes unchanged. They are environment-level, not project-scoped:
a project owns a workspace, never a browser identity.

## 16. Migration

**NONE.** `Migrations.ts` is untouched by Phase 5. No `browser_sessions`, `browser_profiles`,
`browser_tabs`, `browser_history`, or `browser_cookies` table exists, and no profile or session
registry was introduced.

## 17. Dependencies Added

| Package           | Version        | Licence    | Why                                                             |
| ----------------- | -------------- | ---------- | --------------------------------------------------------------- |
| `@playwright/mcp` | 0.0.81 (exact) | Apache-2.0 | The official Playwright MCP server, spawned as a pinned process |

Plus one configuration entry: `allowBuilds: playwright: false` in `pnpm-workspace.yaml`. This is the
deliberate "no silent browser download" decision — the package-manager postinstall cannot fetch a
browser runtime during install, and a missing browser is surfaced to the user as `Runtime Missing`
instead. No Chromium/Chrome/Edge/Playwright browser binary was downloaded by this phase (the
`ms-playwright` cache is unchanged). The browser used is the **system Chrome channel**, which is
already installed on this machine.

## 18. Diagnostics

A closed, user-facing vocabulary: `not-configured`, `runtime-missing`, `starting`, `ready`,
`browser-launch-failed`, `mcp-handshake-failed`, `profile-locked`, `stopped`, `error`. Each has fixed
copy in `BROWSER_DIAGNOSTIC_MESSAGES`, and a contract test asserts the map and the enum stay in step.

Covered by test: `not-configured` (package unresolvable → no `npx` fallback), `runtime-missing`
(channel probe fails → no download), `profile-locked` (both the runtime record and the profile lock
entry), `mcp-handshake-failed` (server spawned but never answered, and its process is killed and its
record cleared), `ready`, `stopped`. `browser-launch-failed` is the spawn-failure path and is asserted
by code path rather than by test (§22).

## 19. Tests

Dependency recovery had to finish before any of this could run (§23).

**Phase 5 focused suite**

Command:

```
.\node_modules\.bin\vp.CMD test run packages/contracts/src/browserSession.test.ts packages/contracts/src/handoff.test.ts apps/server/src/browser apps/server/src/provider/capabilityView.test.ts
```

Result: **45 passed, 0 failed, 0 skipped (6 files)**

- `browserSession.test.ts` — 4: schema round-trip, usability rule, complete credential-free
  diagnostic vocabulary, rejection of unknown values.
- `BrowserPaths.test.ts` — 3: stable per-thread derivation, everything under userdata, hostile thread
  ids sanitized without collisions.
- `BrowserRuntime.test.ts` — 14 (real child process, fake MCP fixture):
  - one session per thread and reuse for the same thread;
  - **handoff reuse**: baton changes, endpoint and profile do not, and no second process is spawned;
  - launch contract: cwd = thread workspace, `--shared-browser-context`, `--browser`, `--host`,
    `--port`, `--user-data-dir` = the thread's profile, `--output-dir` under userdata, no `--isolated`;
  - thread profiles disjoint;
  - stop keeps the profile and the process exits; restart reuses the same profile;
  - `isolated` mode passes `--isolated`, passes no `--user-data-dir`, reports no stored profile;
  - `profile-locked` refuses instead of repairing, and deletes nothing;
  - a dead recorded pid is reaped and the profile reused;
  - `runtime-missing` and `not-configured` never spawn and never download;
  - `mcp-handshake-failed` kills the process and leaves no endpoint or record;
  - reset deletes the stored profile only when explicitly asked;
  - handoff facts invent nothing (`available:false, profileMode:"unknown"`);
  - no browser state lands in the project workspace.
- `capabilityView.test.ts` — 3: derived `browser` state, and no override can claim browser support for
  a harness that cannot speak MCP.

**Official Playwright MCP smoke test** (real pinned server, real browser, local deterministic page)

Command:

```
.\node_modules\.bin\vp.CMD test run apps/server/src/browser/BrowserRuntime.smoke.test.ts --testTimeout=120000
```

Result: **1 passed, 0 failed, 0 skipped (1 file), 3.2s**

Observed, not asserted-away: the real runtime spawns the pinned server and reaches `ready`; a real MCP
`initialize` returns a session id; `tools/list` returns **26 official tools**
(`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_take_screenshot`,
`browser_tabs`, `browser_file_upload`, `browser_find`, `browser_network_requests`, …); a `data:`
fixture page is opened; a snapshot is written by upstream into
`…/browser/<thread>/output/page-<timestamp>.yml`; `browser_type` executes
`page.locator('#field').fill('workbench')`; `browser_click` executes `page.locator('#go').click()`; the
post-click snapshot reads `- paragraph [ref=e3]: clicked:workbench` — the page really reacted; the
runtime stops cleanly and the stored profile survives. If the browser channel were missing the same
test asserts the `runtime-missing` diagnostic instead.

**Baseline-capture regression (the same commands Phase 4 used)**

Command:

```
.\node_modules\.bin\vp.CMD test run packages/contracts/src/handoff.test.ts apps/server/src/orchestration/decider.handoff.test.ts apps/server/src/provider/capabilityView.test.ts apps/server/src/coreState/CanonicalThreadCoreState.test.ts apps/server/src/persistence/Migrations/053_CanonicalThreadCoreState.test.ts apps/server/src/provider/Layers/ProviderSessionDirectory.test.ts apps/server/src/provider/Drivers/GenericAcpDriver.test.ts apps/server/src/provider/Drivers/GenericAcpDiagnostics.test.ts apps/server/src/provider/Layers/GenericAcpAdapter.test.ts
```

Result: **48 passed, 0 failed, 0 skipped (9 files)** — identical to the Phase 4 baseline.

Command:

```
.\node_modules\.bin\vp.CMD test run apps/server/src/mcp/toolkits/office apps/server/src/mcp/McpHttpServer.test.ts apps/server/src/mcp/McpSessionRegistry.test.ts apps/server/src/mcp/McpInvocationContext.test.ts apps/server/src/mcp/McpDeviceToolkit.test.ts apps/server/src/mcp/toolkits/pullRequests
```

Result: **90 passed, 1 failed, 0 skipped (10 files)** — the single failure is the pre-existing,
unrelated Windows path-escaping assertion in `McpHttpServer.test.ts` documented in §21.

Command:

```
.\node_modules\.bin\vp.CMD test run apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts packages/shared/src/composerContextReferences.test.ts packages/contracts/src/orchestration.test.ts apps/web/src/components/chat/handoff.logic.test.ts
```

Result: **153 passed, 0 failed, 0 skipped (4 files)** — identical to the Phase 4 baseline.

**Typecheck**

Command:

```
.\node_modules\.bin\vp.CMD exec tsc --noEmit -p apps/server/tsconfig.json
```

Result: **350 errors, 0 of them in any Phase 5 file** — the same 350 pre-existing errors Phase 4
recorded (test-harness layer stacks and the repo's `node:http`/`node:fs` rule in pre-existing test
files). Phase 5 adds no type error.

Command:

```
.\node_modules\.bin\vp.CMD exec tsc --noEmit -p packages/contracts/tsconfig.json
```

Result: **1 error**, pre-existing in `composerContext.test.ts` (a Phase 1–3 file). Phase 5 adds none.

## 20. Regression Status

| Suite                                                                                                    | Result                                                                            |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Phase 3 handoff: contracts, decider, briefing composer, `ProviderCommandReactor` (69), web handoff logic | PASS — 153/153                                                                    |
| Phase 3 platform: baton ownership, provider session mapping, one-shot briefing, A → B → A                | PASS — included above and in the 48/48 run                                        |
| Phase 4 Office toolkit                                                                                   | PASS                                                                              |
| Phase 4 MCP: session registry, invocation context, device toolkit, pull-requests, HTTP server            | PASS, except the pre-existing Windows path assertion                              |
| Core State + migration 053                                                                               | PASS                                                                              |
| Generic ACP: driver, diagnostics, adapter                                                                | PASS                                                                              |
| Provider routing and MCP injection                                                                       | PASS — the 153-test reactor suite exercises the injection path with the new field |

## 21. Existing Baseline Issues

Recorded, not fixed, and none of them caused by Phase 5:

1. `apps/server` typecheck reports **350** errors on the pre-Phase-5 tree as well (Phase 4 recorded the
   same count). They live in `server.test.ts`, `AgentSessionImporter.test.ts`, and the repo's
   `effect-tsgo` module rules applied to pre-existing test files.
2. `packages/contracts` typecheck reports **1** error in `composerContext.test.ts` (a Phase 1–3 file
   unmodified by Phase 5).
3. `McpHttpServer.test.ts > saves the snapshot PNG on request and reports its path` fails on Windows
   because the serialized JSON content escapes backslashes (`C:\\Users\\…`) so `toContain` misses. This
   is the exact failure Phase 4 recorded; the file is unmodified.
4. `effect@4.0.0-rc.112` has no `Layer.scoped` and no `Effect.zipRight`; the repo uses
   `Layer.effect` + `Effect.acquireRelease` and `Effect.andThen`. Phase 5 was written to match.
5. `@effect/vitest`'s `it.effect` supplies `TestContext`, i.e. a **TestClock**. Anything that sleeps,
   retries, or times out parks forever under it. Real-process tests must use `it.live`; the runtime's
   own tests do, and the production code uses `Clock.currentTimeMillis` so it is clock-agnostic.

## 22. Known Limitations

- **No user-facing Start/Stop panel in V1.** The runtime, RPC-visible state and diagnostics exist, and
  the existing Settings → agent-browser switch is the on/off gate, but a dedicated
  Start/Stop/Profile/Channel control surface was not built. Recorded rather than claimed.
- **One headed browser per thread.** Headed is the product default (an interactive desktop tool should
  show what the agent is doing); `agentBrowserHeadless` switches it off for machines with no display.
  The automated smoke runs headless so it never steals focus.
- **The loopback MCP endpoint is unauthenticated.** Upstream's HTTP transport has no auth, so the
  boundary is "loopback only plus an unguessable port" — the same trust level as the existing device
  hub listener. Recorded as a limitation rather than papered over with a home-grown auth scheme.
- **No Workbench origin allow/blocklist.** `--allowed-origins` / `--blocked-origins` exist upstream
  and upstream explicitly states they are **not** a security boundary and do not affect redirects. V1
  therefore uses upstream's default (allow all) and documents it instead of inventing an SSRF
  framework. The user-facing network boundary is the browser itself plus the workspace file boundary.
- **A browser runtime left behind by a hard kill blocks its thread until that process exits.** The next
  start reports `profile-locked` rather than adopting a pid it cannot prove is its own, or deleting
  lock files. Recovery is "stop the leftover process"; Workbench never kills what it did not start.
- **`browser-launch-failed` is a code path, not a test.** `spawner.spawn` failing is not reproducible
  with the real spawner on this machine, so that one diagnostic is asserted by inspection.
- **The channel-install probe is Windows-first.** Chrome/Edge are probed at their conventional Windows
  paths; `chromium` and non-Windows platforms are reported "available" and left to the launch to fail
  honestly, rather than guessing a layout.
- **The managed profile is not the user's daily Chrome profile.** SSO, existing cookies, and existing
  extensions are _not_ inherited. That is intentional isolation; a future phase can expose upstream's
  `--extension` / `--cdp-endpoint` modes deliberately, and no account-sync mechanism needs to be built.
- **Browser lifecycle events are logged, not appended as thread activities.** §50 of the brief makes
  that optional ("可以记录"); the diagnostics vocabulary plus structured logs carry the information
  without adding an activity kind.
- **Workbench does not read page state.** Current URL, tabs, DOM, and cookies are upstream's business;
  no `browser_tabs` / `browser_history` / `browser_cookies` storage exists, and none is planned.
- **The smoke test drives a `data:` fixture, not a served page.** `file://` is blocked by upstream by
  default (deliberately kept) and the repo bans `node:http` in Effect code, so the deterministic
  fixture is a `data:` URL. It still exercises real navigation, snapshot, type, and click.

## 23. Dependency Recovery And Interruptions

The phase was interrupted by an API failure after most sources were written but before dependencies
and tests were verified. What was found and done:

1. **`node_modules` had been destroyed** by an earlier `pnpm install` purge (`vite-plus` gone, no root
   symlinks, only a partially extracted `.pnpm`). Sources were untouched — verified with
   `git status` before anything else, and no `reset`/`clean`/`stash`/`checkout` was ever run.
2. **Root cause of the multi-hour "hang":** pnpm's global store lives at
   `C:\Users\…\AppData\Local\pnpm\store`, **outside the workspace**, and the sandbox denied writes
   there. pnpm spun on CPU (5.7 GB RSS) for hours while writing zero files. Re-running with
   `--store-dir D:\personal-ai-workbench\.pnpm-store` (inside the workspace) fixed it.
3. **Second cause:** the registry's `playwright` packument is **8.1 MB**, and pnpm aborted with
   `ERR_PNPM_BROKEN_METADATA_JSON` at its default fetch timeout. Adding
   `--fetch-timeout=900000 --fetch-retries=6` made the install succeed.
4. **Package manager restored** with `packageManager: "pnpm@11.10.0"` (the version this repo pins) —
   no version switching was repeated. A project-local pnpm was bootstrapped through npm's JS entry
   into `.tools/` purely to recover; the repo's own `node_modules/.bin/vp` and `node_modules/vite-plus`
   are back, and `.tools/` was removed after the recovery was confirmed.
5. **Final install:** `pnpm install --no-frozen-lockfile --store-dir …\.pnpm-store --fetch-timeout=900000`
   → "Done in 1m 24.4s", 1885 packages, postinstall scripts and `prepare` ran normally, and
   `@playwright/mcp@0.0.81` landed in `pnpm-lock.yaml`.
6. **No browser binary was downloaded** at any point (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` plus
   `allowBuilds: playwright: false`).

Integration facts discovered only by running the real server, all now encoded in code or tests:

- **`--allowed-hosts` is mandatory here.** Upstream advertises `localhost:<port>` and its
  DNS-rebinding guard allows only the advertised host, so a `127.0.0.1` client is refused with
  `403 Access is only allowed at localhost:<port>`. The flag is a **comma-separated list in a single
  argument** (`--allowed-hosts=127.0.0.1:<port>,localhost:<port>`); the space-separated form leaves
  the list empty.
- `browser_type` / `browser_click` take **`target`** (a locator, not a description) **and** `ref`;
  omitting `target` fails schema validation, and a non-matching `target` fails with
  `"X" does not match any elements`.
- Upstream **writes page snapshots to `--output-dir` and returns a link** rather than inlining them.
- `@playwright/mcp`'s `exports` map exposes only `.` and `./package.json`, so
  `require.resolve("@playwright/mcp/cli.js")` fails; the CLI is found via the package manifest and its
  `bin` entry.

## 24. Files Changed

New — browser runtime (`apps/server/src/browser/`):

- `BrowserPaths.ts` — thread-scoped path derivation under the existing userdata abstraction
- `BrowserRuntime.ts` — the runtime service, lifecycle, diagnostics, profile lock, MCP handshake
- `BrowserPaths.test.ts`, `BrowserRuntime.test.ts`, `BrowserRuntime.smoke.test.ts`

New — contracts:

- `packages/contracts/src/browserSession.ts` — view, status, profile mode, channel, diagnostic
  vocabulary and user-facing copy
- `packages/contracts/src/browserSession.test.ts`

New — docs:

- `docs/spikes/PHASE5_IMPLEMENTATION_AUDIT.md`
- `docs/spikes/PHASE5_REPORT.md` (this file)

Modified:

- `packages/contracts/src/index.ts` — export the new module
- `packages/contracts/src/coreState.ts` — derived `HarnessCapabilityView.browser`
- `packages/contracts/src/settings.ts` — three optional keys with decoding defaults
- `packages/contracts/src/handoff.ts` — `capabilities.browser` and a two-fact `browser` section
- `packages/contracts/src/handoff.test.ts` — fixtures for the new required fields
- `apps/server/src/mcp/McpProviderSession.ts` — `extraMcpServers`
- `apps/server/src/provider/Layers/ProviderService.ts` — start/reuse the thread runtime, inject the
  endpoint, derive availability
- `apps/server/src/provider/capabilityView.ts` (+ test) — derive `browser`
- `apps/server/src/provider/Layers/CursorAdapter.ts` — Generic ACP injection site
- `apps/server/src/provider/Layers/{Claude,Codex,Grok,OpenCode,Antigravity}Adapter.ts` — one entry each
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` — browser facts in the briefing
- `apps/server/src/server.ts` — provide `BrowserRuntime.layer`
- `apps/server/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` — the pinned dependency and the
  deliberate "no browser download" build-script setting

`Migrations.ts` is unchanged. No Phase 1–4 file was changed except where listed above.

## 25. Git Diff Summary

Phase 5 adds one browser runtime module (two source files, three test files), one contracts module
(view + diagnostics + tests), one derived capability field threaded through the capability view and the
handoff briefing, one optional `McpProviderSessionConfig` field, one appended MCP entry in six
adapters, three settings keys, one server layer wiring line, and one pinned dependency.

No migration, no new table, no new tool protocol, no new transport, no browser driver, no Playwright
wrapper, no copied tool schema, no per-provider browser code, no new UI surface, no browser
marketplace, no knowledge/RAG, and no model-gateway work.

All Phase 1–4 working-tree changes are preserved: no `git reset`, `clean`, `restore`, `checkout`,
`stash`, or re-clone was executed against working-tree content at any point. `git diff --check` is
clean; `node_modules` and `.pnpm-store` are gitignored; no browser profile, browser binary, or
recovery tooling is tracked.

## 26. Phase 6 Readiness

Phase 5 is complete and Phase 6 (Knowledge / SAG) **has not been started**. No knowledge base, no
vector store, no embeddings, and no RAG path was added; pages the browser fetched are **not** written
into any knowledge store.

What Phase 6 inherits and can build on:

- A working Tool Bus where a new tool family is a toolkit registration plus a capability value.
- A canonical, derived capability view that a knowledge capability can extend the same way.
- An artifact registry and a handoff briefing that already carry registered artifacts and derived
  facts, so a knowledge source can appear in a briefing without a new protocol.
- A reusable pattern for owning a long-lived external process, if a knowledge/embedding service turns
  out to need one.
- A browser that can reach documentation sites under the same thread-scoped, workspace-bounded,
  handoff-surviving rules as everything else.

Open items Phase 6 should not assume are done: the user-facing browser Start/Stop panel (§22), a
configurable origin boundary (§22), and any deliberate sharing of a browser identity across threads
(which V1 explicitly does not implement).
