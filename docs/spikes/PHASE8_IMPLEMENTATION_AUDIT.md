# Phase 8 Implementation Audit

Personal AI Workbench V1 — Hardening / Release. Audit written before any Phase 8 code change.

Phase 1–7 are complete and PASS. This audit fixes the V1 feature freeze, measures the release
surface that already exists, classifies every known defect, and states what Phase 8 is allowed to
touch. Nothing here adds a feature.

---

## Current V1 Feature Inventory

Frozen. Phase 8 does not widen this list.

| Phase | Capability                                                                                                              | Primary artifacts                                                                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Generic ACP Provider (`acp` provider kind, stdio lifecycle, initialize/session/stream/cancel)                           | `apps/server/src/provider/Drivers/GenericAcpDriver.ts`, `apps/server/src/provider/Layers/GenericAcpAdapter.ts`, `apps/server/src/provider/acp/*`     |
| 2     | Canonical Thread on a Project workspace + Native Session mapping + Task State + Artifact metadata + Capability Registry | `packages/contracts/src/coreState.ts`, `apps/server/src/coreState/CanonicalThreadCoreState.ts`, migration `053_CanonicalThreadCoreState`             |
| 3     | Baton / Handoff Composer / Validator / Redactor / briefing / auto-continue                                              | `packages/contracts/src/handoff.ts`, `apps/server/src/orchestration/decider.ts` (handoff events), `apps/web/src/components/chat/HandoffControls.tsx` |
| 4     | Workbench Tool Bus (MCP) + Office adapters (DOCX/XLSX/PPTX/PDF)                                                         | `apps/server/src/mcp/toolkits/office/*`                                                                                                              |
| 5     | Browser via `@playwright/mcp`, per-thread persistent profile, download/upload artifact bridge                           | `apps/server/src/browser/*`                                                                                                                          |
| 6     | Knowledge via external SAG, per-Project scope, knowledge MCP tools                                                      | `apps/server/src/knowledge/*`, `packages/contracts/src/knowledge.ts`                                                                                 |
| 7     | Model Gateway (loopback proxy, routes, bounded failover, circuit breaker, usage)                                        | `apps/server/src/modelGateway/*`, migration `054_ModelGatewayUsage`                                                                                  |

**V1 feature freeze:** the seven capabilities above, at the state recorded in
`docs/spikes/PHASE1_REPORT.md` … `PHASE7_REPORT.md`. Anything not listed is out of V1.

---

## Current Working Tree State

Recorded at the start of Phase 8 (before any Phase 8 edit).

```
HEAD                 c1b2210411da79350a3f9f5a65a4a64971e4acad
branch               (detached working tree, no Phase 1-7 commit)
tracked modified     56 files, +2742 / -86
untracked files      93
git diff --check     clean (no whitespace errors, no conflict markers)
git status           clean of staged changes; nothing committed since upstream baseline
```

Untracked content is Phase 2/3/4/5/6/7 source, tests and docs:

- `apps/server/src/browser/`, `coreState/`, `knowledge/`, `modelGateway/`, `mcp/toolkits/office/`
- `apps/server/src/provider/{GenericAcpDriver,GenericAcpAdapter,ModelGatewayHarness*}.ts`, `capabilityView.ts`
- `apps/server/src/persistence/Migrations/053_*`, `054_*`
- `apps/web/src/components/{chat/HandoffControls,settings/KnowledgeSettings,settings/ModelGatewaySettings}*`, `apps/web/src/state/{handoff,knowledge,modelGateway}.ts`
- `packages/contracts/src/{browserSession,coreState,handoff,knowledge,modelGateway,modelGatewayRuntime,modelGatewayUsage}.ts`
- `docs/project-specs/`, `docs/spikes/` (all phase reports)

`git reset`, `git clean`, `git stash`, `git checkout .`, `git restore .` are **forbidden** for the
whole phase. Working tree size is dominated by `node_modules` (~9 GB), `.pnpm-store`, `.repos`
(vendored read-only upstreams) and `caches/`; none of it is a release input.

---

## Current Build Pipeline

Package manager is **`vp`** (vite-plus) with pnpm 11 behind it; `pnpm` is not on `PATH`, so every
project command runs through `node_modules\.bin\vp.CMD`.

| Target             | Command                                      | Notes                                                                               |
| ------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| Root (all apps)    | `vp run build`                               | builds every `apps/*`, including mobile/marketing — not the release path            |
| Desktop + server   | `node_modules\.bin\vp.CMD run build:desktop` | `vp run --filter @t3tools/desktop --filter t3 build`; **this is the release build** |
| Server bundle only | `vp run --filter t3 build:bundle`            | `vp pack`                                                                           |
| Server exe         | `vp run --filter t3 build:exe`               | `node scripts/cli.ts build-exe`                                                     |
| Typecheck          | `vp run -r --concurrency-limit 2 typecheck`  | per-workspace `tsc --noEmit`                                                        |
| Tests              | `vp test run <paths>`                        | vitest through vp                                                                   |
| Clean              | `npm run clean`                              | deletes `node_modules`, `dist`, `.vite-plus` — destructive, not used here           |

Outputs: `apps/web/dist`, `apps/server/dist` (bundled `bin.mjs`), `apps/desktop/dist-electron`.

The server bundle has a hard self-containment contract enforced at package time: `effect` must be
inlined (`BUNDLE_SELF_CONTAINED_SENTINEL`), and native-loading packages must stay external
(`CLI_RUNTIME_EXTERNAL_PREFIXES`). A build that violates either is caught by
`scripts/build-desktop-artifact.ts`, not by the build itself.

## Current Desktop Packaging

`scripts/build-desktop-artifact.ts` is the single packaging entry point. There is **no
`electron-builder.yml`**; the electron-builder config is generated in code by `createBuildConfig`
(line 2621) and passed to electron-builder programmatically.

```
npm run dist:desktop:win        -> node scripts/build-desktop-artifact.ts --platform win --target nsis
npm run dist:desktop:win:x64    -> ... --target nsis --arch x64
```

Windows packaging, in order:

1. `vp run build:desktop` inputs are required: `apps/desktop/dist-electron`, server `dist`, bundled
   server client assets.
2. `stageResourceMonitor` runs `cargo build --locked --release --target x86_64-pc-windows-msvc
--manifest-path native/resource-monitor/Cargo.toml` and stages `t3-resource-monitor.exe`, unless
   `T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR` is set (then it only verifies the cached binary exists).
3. `vp install --prod` into a staging directory, with `allowBuilds`/`patchedDependencies`/`overrides`
   mirrored from `pnpm-workspace.yaml`.
4. The server tree is hand-packed into `resources/server.asar` plus a `server.asar.unpacked` sibling
   carrying `*.node`, `*.dll`, `*.exe`, `*.so*`, `*.dylib`.
5. The Linux CLI archive is embedded as `resources/wsl-runtime.tar.gz` + `.sha256`.
6. `validateWindowsPackagedPayload` asserts the payload contains the app dir, `server.asar`, the
   unpacked natives, the resource monitor, and the WSL runtime, and that the payload is at most
   `WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT = 80` files.
7. electron-builder produces the NSIS installer.

Windows build prerequisites, as probed in code (line 392): **rust** (cargo + MSVC target),
**python 3** (node-gyp), **msvc** (`cl.exe` + Windows SDK + Spectre libs), **tar**. macOS and Linux
have their own prerequisite probes. There is no second installer framework and Phase 8 must not add one.

## Current Server Packaging

`vp pack` produces `apps/server/dist/bin.mjs`, a single bundle that keeps a selected runtime-external
closure (`selectCliRuntimeExternalDependencies`) outside the bundle. The packaged Windows desktop runs
that server from inside `server.asar` through an asar-aware `ELECTRON_RUN_AS_NODE` Electron runtime;
`resources/wsl-runtime.tar.gz` is the same Linux CLI archive users download, so WSL runs identical bytes.

## Current Web Packaging

`apps/web` builds to `apps/web/dist` with Vite. The desktop app loads the built assets; the server
serves the same build for the browser surface. `applyWebBrandAssets` rewrites brand assets per release
channel before packaging. No separate web packaging exists for V1 and none is needed.

## Current Windows Runtime Requirements

| Requirement                                          | Needed for                                 | Consequence if missing                                                                                      |
| ---------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Windows 10+ x64                                      | primary V1 platform                        | not supported                                                                                               |
| Node/Electron runtime                                | bundled by the installer                   | n/a                                                                                                         |
| Rust + MSVC Build Tools + Python 3 + tar             | **building** the installer, not running it | packaging fails with a typed `WindowsDesktopBuildPrerequisitesMissingError` listing exactly what is missing |
| A harness CLI (Codex / Claude / Qwen / Kimi / DSH …) | running any conversation                   | Workbench starts; the instance reports unavailable                                                          |
| Chrome, Edge or another Playwright-supported browser | Browser tool                               | Browser tool reports unavailable; nothing else is affected                                                  |
| An external SAG service                              | Knowledge tool                             | Knowledge reports unconfigured/unavailable                                                                  |
| Internet + model credentials                         | model calls                                | Workbench starts, UI works, native-login harnesses still usable                                             |

## Current Node Runtime Strategy

Node **24.x** for development and for the CLI surface. Packaged desktop does **not** depend on a
system Node: the server runs inside the Electron binary via `ELECTRON_RUN_AS_NODE`, and the native
resource monitor and node-pty prebuilds are staged per architecture. No `.ts`, `.vite-temp`, `.tools`
or repo-source path is read at packaged runtime; the bundle plus the selected external closure is the
entire server runtime.

## Current Database / Migration Boot Path

- `runMigrations` is called by the SQLite persistence layer at startup, before the app serves.
- Migrations are **statically imported** in `apps/server/src/persistence/Migrations.ts` (no dynamic
  filesystem loading) and registered in a numbered `migrationEntries` manifest, currently ending at
  `[54, "ModelGatewayUsage", Migration0054]`.
- Effect's `Migrator.make({})` creates `effect_sql_migrations`, then runs any migration whose id is
  greater than the highest recorded one. Migration id+name is the recorded key, so a completed
  migration is never re-run.
- `runMigrations({ toMigrationInclusive })` exists and is the fixture mechanism for testing an
  upgrade from an older schema.
- There is **no** database drop, recreate or delete path on migration failure. A failing migration
  fails the boot.

## Current Userdata / State Paths

From `apps/server/src/config.ts:deriveServerPaths`, `<baseDir>` is the server base directory and
`<stateDir>` is `<baseDir>/userdata`, or `<baseDir>/dev` when a dev URL is in play and the base dir
was not given explicitly.

| What                                                  | Path                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Database                                              | `<stateDir>/state.sqlite`                                                                              |
| Settings                                              | `<stateDir>/settings.json`                                                                             |
| Secrets                                               | `<stateDir>/secrets/`                                                                                  |
| Keybindings                                           | `<stateDir>/keybindings.json`                                                                          |
| Environment id / anonymous id                         | `<stateDir>/environment-id`, `<stateDir>/anonymous-id`                                                 |
| Server runtime state (pid/port)                       | `<stateDir>/server-runtime.json`                                                                       |
| Attachments                                           | `<stateDir>/attachments`                                                                               |
| Browser artifacts (screenshots the user asks to keep) | `<stateDir>/browser-artifacts`                                                                         |
| Thread browser profile + runtime state                | `<stateDir>/browser/<thread>-<hash>/` and `.../profile`                                                |
| Logs                                                  | `<stateDir>/logs/server.log`, `logs/server.trace.ndjson`, `logs/provider/events.log`, `logs/terminals` |
| Themes                                                | `<stateDir>/themes`                                                                                    |
| Provider status cache                                 | `<baseDir>/caches`                                                                                     |
| Worktrees                                             | `<baseDir>/worktrees`                                                                                  |

Every one of these is under the server base dir. Browser profiles are resolved from the thread id and
the state dir only — deliberately **not** from the project workspace, so a profile can never appear in
`git status` (`apps/server/src/browser/BrowserPaths.ts`). No secret, no browser state and no runtime
state is written under a project workspace root.

## Current Secret Storage

- `ServerSecretStore` (`apps/server/src/auth/ServerSecretStore.ts`) is the single secret store, backed
  by the OS credential facility through `keyring`, with `<stateDir>/secrets/` as the fallback location.
- Secrets are referenced by name. Known names: provider/harness credentials, the Model Gateway
  provider key (`modelProviderSecretName(id)`), and the knowledge/SAG token.
- Client-visible surfaces carry only a redaction marker, never the value:
  `MODEL_GATEWAY_CREDENTIAL_REDACTED` (six bullets) for gateway keys and the equivalent marker for the
  knowledge token. Echoing the marker back keeps the stored secret; an empty string clears it.
- A harness receives a **per-session bearer** minted by Workbench, never the upstream key. The upstream
  key exists only in the outbound credential header at forwarding time.

## Current Process Lifecycle

Managed child processes are spawned by Workbench and tracked, never discovered by name:

| Process                             | Owner                                      | Start                                                                                     |
| ----------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Harness CLI (per provider instance) | `ProviderService` / provider drivers       | on thread/turn need                                                                       |
| MCP Tool Bus HTTP listener          | in-process `node:http`                     | with the server                                                                           |
| Playwright MCP + browser            | `BrowserRuntime`, `@playwright/mcp@0.0.81` | **lazily**, on first browser use for a thread                                             |
| Model Gateway listener              | in-process `node:http`                     | **lazily**, on first need; `stopped -> starting -> ready -> error -> stopping -> stopped` |
| Terminal/PTY                        | `terminal/Manager.ts`                      | on demand                                                                                 |
| SAG                                 | **external**, user-owned                   | never started or stopped by Workbench                                                     |

## Current Shutdown Semantics

Server shutdown tears down the components Workbench owns: provider sessions per thread, MCP sessions
and their per-session bearers, the browser runtime for each thread, terminal PTYs, the in-process
gateway listener and its pending work, and the HTTP/WS listeners. Shutdown preserves state: the thread
browser profile directory is kept so login state survives a restart, and no `state.sqlite` write is
started during teardown. Workbench does not stop an external SAG service and does not kill a browser
or Node process it did not spawn.

## Current Crash Recovery

- `server-runtime.json` records the running server's runtime coordinates. A stale file left by a crash
  is detectable because the recorded process is gone.
- Thread browser directories are a pure function of the thread id, so a crashed browser is re-created
  against the same persistent profile and the user's login state is intact.
- If a profile is held by a live foreign process the runtime reports a lock diagnostic; it never
  deletes the lock and never kills an unrelated process.
- Canonical Thread state lives in SQLite and is the source of truth, so a lost native session degrades
  to a new native session plus a full handoff package rather than lost work.
- Gateway circuit-breaker state is in memory only and is intentionally rebuilt empty on restart.

## Current External Dependencies

| Dependency                                                                         | Version / pin                  | License    | Delivery                                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------ | ---------- | --------------------------------------------------------------------------------- |
| `@playwright/mcp`                                                                  | **`0.0.81`** (exact)           | Apache-2.0 | npm dependency of `apps/server`                                                   |
| `@xmldom/xmldom`                                                                   | `^0.9.12`                      | MIT        | npm dependency (Office OOXML)                                                     |
| `fflate`                                                                           | `^0.8.3`                       | MIT        | npm dependency (Office zip)                                                       |
| Playwright browser binary                                                          | system Chrome/Edge channel     | —          | **not** downloaded; `playwright` install script disabled in `pnpm-workspace.yaml` |
| SAG / zleap-sag                                                                    | external service               | MIT        | not packaged                                                                      |
| CC Switch                                                                          | reference only, no code copied | MIT        | not packaged                                                                      |
| Harness CLIs (Codex, Claude, Qwen, Kimi, DSH, OpenCode, Cursor, Grok, Antigravity) | user-installed                 | —          | not packaged                                                                      |

Phase 1–7 added exactly three npm dependencies, all to `apps/server`. No vendored source tree, no
second installer, no bundled RAG engine, no bundled CC Switch.

## Current First-run Experience

1. Desktop app starts, starts the bundled server, opens the web UI.
2. `ensureServerDirectories` creates the state tree; `runMigrations` brings the schema to 54.
3. With no `settings.json` the server starts on defaults (the read path tolerates a missing file).
4. With no Project open the user must open a folder before a thread can exist; folderless chat is
   refused by contract.
5. With no model credentials the app is fully usable for configuration; only model calls fail.
6. Optional subsystems report their own state rather than blocking startup.

## Current Settings Migration

`settings.json` is read with a tolerant path: an unparsable file logs a warning and falls back to
defaults (upstream T3 behaviour). `serverSettings.updateSettings` validates the incoming write and
refuses a Model Gateway route whose upstreams disagree on protocol **before** writing, so a broken
route cannot be persisted. Deletion of a gateway provider/route is not expressible through the
deep-merge patch; disabling is the contract's retirement mechanism.

## Current Error / Diagnostics Surfaces

Diagnostics exist per optional subsystem, each with its own vocabulary rather than one unified enum:

- Model Gateway: `ModelGatewayDiagnostic` — `route-not-found`, `route-disabled`,
  `unsupported-by-harness`, `no-backup`, `backup-protocol-mismatch`, plus runtime failure classes.
- Knowledge/SAG: configured / unreachable / error states including the knowledge-token redaction marker.
- Browser: runtime present/absent, profile-locked, missing browser executable.
- Generic ACP: executable resolution and handshake diagnostics per provider instance.
- Harness capabilities: capability registry entries with `supported` / `unsupported` / `unknown`.

At minimum each surface distinguishes: configured, ready, unavailable, misconfigured, error. The
vocabulary is not unified in V1 and Phase 8 will not unify it.

## Current Logging

- Server log: `<stateDir>/logs/server.log`; trace: `logs/server.trace.ndjson`; provider events:
  `logs/provider/events.log`; terminal logs: `logs/terminals`.
- Effect's `Logger` with the level from server config. Redaction of credentials exists in the gateway
  path; the usage table has no column capable of holding a prompt, completion, header or key.
- Phase 7 noted one honest weakness: the gateway proxy relays bytes inside `node:http` callbacks that
  run outside a test's logger context, so a test logger cannot observe what the request path logs. It
  is mitigated by the fact that `apps/server/src/modelGateway/**` emits no log lines at all.

## Current Test Baseline

Known at the Phase 8 boundary:

| Suite                                                                                                       | Result                             |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Phase 7 suite (contracts + gateway + settings + web logic)                                                  | 235 passed / 235                   |
| Phase 3–6 regression suite                                                                                  | 261 passed / 261                   |
| Provider adapters (`CodexSessionRuntime`, `ProviderService`, `CodexAdapter`, `ClaudeAdapter`, `ClaudeHome`) | 313 passed, **8 failed**           |
| `packages/contracts` + `apps/server/src/mcp` + `apps/server/src/terminal`                                   | 729 passed, **2 failed**           |
| `apps/server/src/cli`                                                                                       | 95 passed, 4 skipped, **1 failed** |

## Current Typecheck Baseline

| Workspace            | Errors | Source                                                                                                            |
| -------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| `packages/contracts` | 1      | `composerContext.test.ts` — fixture missing the Phase 3 `handoff` key                                             |
| `apps/server`        | 350    | `server.test.ts` 348, `AgentSessionImporter.test.ts` 2 (missing Phase 6 `CanonicalThreadCoreState` context entry) |
| `apps/web`           | 3      | `scopedSettings.ts` 1, `settingsLayout.tsx` 2                                                                     |

## Current Known Limitations

Carried forward from the phase reports and re-checked here:

1. Model Gateway supports **two** harnesses, `codex` and `claudeAgent`. Cursor, Grok, Antigravity,
   OpenCode and Generic ACP report `unsupported-by-harness`.
2. **No protocol conversion.** A route's upstreams must share a protocol family; a mismatch is refused
   at save time and skipped as `protocol-mismatch` at runtime, failing closed.
3. The Codex probe site accepts a gateway overlay but no caller supplies one.
4. The terminal reuses the thread's minted overlay instead of minting its own credential.
5. Pricing/estimated cost is not implemented; only the Model grouping can compute an estimate.
6. Usage UI window is fixed at 24 hours; no charts.
7. Deleting a gateway provider or route requires editing `settings.json`.
8. Candidate-later seams named in Phase 7 §26 remain unimplemented and are not Phase 8 work.

## Current Performance Risks

- Streaming must not rewrite a full thread snapshot per chunk (T3 upstream already coalesces).
- Thread lists, activity lists and artifact lists must stay keyset-paginated as counts grow.
- Large tool output and Office intermediate files must go to blobs/artifacts, not the event stream.
- Usage retention must stay bounded so the table cannot grow without limit.
- Startup must not eagerly start the browser, contact external providers, or run SAG retrieval.

## Current Security Risks

- A project workspace path must never be able to escape via `..`, UNC, drive-absolute, symlink or
  junction when Office/browser tools resolve a path.
- A browser profile must never be shared between threads or written inside a project.
- A secret must never reach settings plaintext, logs, activity, handoff, usage rows, artifact
  metadata or diagnostics DTOs.
- Gateway failover must never replay a response the client has already begun receiving.
- Gateway must never read or write a user-global CLI configuration file.

## Current Release Blockers

Classified before any change. "Blocker" means it prevents install, start, safe upgrade, data
integrity, secret containment, workspace containment or a correct second launch.

| #   | Item                                                                                                               | Class                          | Reason                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------ |
| B1  | No V1 production build has been run end to end in this phase                                                       | **BLOCKER** (verification gap) | Release cannot be claimed without it                                           |
| B2  | No packaged Windows artifact has been produced or launched                                                         | **BLOCKER** (verification gap) | "Package cannot run in a clean Windows environment" is a blocker by definition |
| B3  | Upgrade from a pre-053 database has never been exercised end to end                                                | **BLOCKER** (verification gap) | Migration failure / data damage on upgrade is a blocker                        |
| B4  | Migration idempotency across two consecutive boots is asserted only per-migration, never on the real boot path     | **BLOCKER** (verification gap) | Double-run damage is a blocker                                                 |
| B5  | Second launch of a packaged artifact (port / pid / profile lock / DB lock) never verified                          | **BLOCKER** (verification gap) | Install-level blocker test                                                     |
| B6  | Secret fixture `phase8-final-super-secret` never driven through all four carrier paths at once                     | **BLOCKER** (verification gap) | Secret leakage is a blocker                                                    |
| B7  | `composerContext.test.ts` typecheck failure and `AgentSessionImporter.test.ts` errors sit on V1-relevant contracts | **MAJOR** → Phase 8 fixes      | See below                                                                      |
| B8  | Windows resource monitor requires Rust + MSVC to package                                                           | **environment prerequisite**   | Not a product defect; blocking only for this machine until installed           |

## V1 Non-blocking Limitations

Accepted for V1 release; each is explicit behaviour with diagnostics and documentation, none is
silently wrong:

- Gateway harness coverage is two harnesses (upstream contract, not a defect).
- No protocol conversion; cross-protocol routes are refused loudly.
- No pricing engine; cost shown only where computable and labelled as an estimate.
- Diagnostics vocabularies are per-subsystem, not unified.
- Settings deletion of gateway providers/routes requires editing the file.
- No SAG UI clone; knowledge UI is the Workbench surface over an external service.
- No Gateway marketplace, no provider logo catalog, no usage charts.
- No Project-shared browser profile; profile scope is per thread by design.
- Web/mobile/desktop parity is not claimed for Phase 8 additions beyond what already ships.
- macOS and Linux packaging are not validated in V1 (Windows is the validated platform).

## Hardening Work Required

Ordered, and deliberately small:

1. Run the real production build and prove it is not a cache artifact.
2. Run the typecheck gate for contracts / server / web / desktop and classify every error as
   pre-existing baseline or new.
3. Reclassify the baseline list; fix the entries that sit on V1 production paths (stale capability
   fixtures, missing contract fixture keys) and leave unrelated upstream debt alone.
4. Build the V1 Release Test Suite from existing runner commands; repeat the flaky-prone suites.
5. Exercise migration upgrade from a pre-053 schema, then two consecutive boots on the upgraded
   database, then a deliberately failing migration to prove it fails loudly and does not recreate or
   delete the database.
6. Drive the final secret fixture through settings, logs, activity, handoff, usage, artifact metadata,
   diagnostics DTO and client DTO, asserting both absence in the wrong places and presence in the one
   right place.
7. Re-verify workspace containment (Office output, browser upload/download, artifact registry, `..`,
   absolute, UNC, symlink/junction).
8. Verify lazy startup, offline behaviour, no-API-key startup and missing-CLI behaviour.
9. Run the packaged artifact twice with a fresh temporary userdata, then once more against the
   upgraded database.
10. Run the cross-feature V1 scenario end to end.
11. Produce README/user-guide/release-note/architecture/acceptance/known-limitations documents.
12. Remove any temporary file this project's tests created; leave the working tree otherwise untouched.

## Things We Must Not Build

- No new feature in any of the seven frozen areas.
- No protocol conversion, no media transcoding, no gateway marketplace, no pricing sync.
- No second packaging pipeline, no custom installer, no NSIS clone, no electron-builder replacement.
- No bundled browser binaries, no bundled SAG, no bundled CC Switch.
- No new logging framework, no unified diagnostics rewrite.
- No new database schema for circuit-breaker persistence.
- No new third-party security scanner.
- No UI redesign; only broken UI, misleading state, wrong disabled logic, missing error text and
  layout that blocks usage may be touched.
- No `git clean`, `git reset`, `git stash`, `git checkout .`, `git restore .`, and no commit, tag,
  push, publish or GitHub release without an explicit user instruction.

## Proposed Release Gate

Architecture, Generic ACP, Office, Browser, Knowledge, Gateway, Security, Lifecycle, Data, Build,
Regression and Docs gates as listed in the Phase 8 brief, each recorded PASS / FAIL / N/A with the
exact command and observed output in `docs/releases/V1_ACCEPTANCE.md`. A gate with no evidence is
recorded as UNVERIFIED, never as PASS.

**Proposed V1 version: `1.0.0`.** The repo currently carries `0.0.40` in `apps/server`,
`apps/desktop` and `@t3tools/*` packages, inherited from upstream T3 Code; it identifies the fork's
upstream lineage, not the Workbench product. The version bump, commit, tag and release are proposed
only — Phase 8 does not perform them.
