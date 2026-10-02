# Phase 7 Implementation Audit

Model Gateway / CC Switch Core V1. Written 2026-09-16, before any Phase 7 code, against CC Switch v3.20.3 (source inspected locally) and the Phase 1-6 working tree.

## Current T3 Provider Architecture

- A provider is a **driver** (`apps/server/src/provider/ProviderDriver.ts`) registered in `apps/server/src/provider/builtInDrivers.ts`, with a catalog in `builtInProviderCatalog.ts` and a driver-agnostic instance envelope.
- Instances live in `ServerSettings.providerInstances: Record<ProviderInstanceId, ProviderInstanceConfig>` (`packages/contracts/src/settings.ts:1273`). The envelope (`packages/contracts/src/providerInstance.ts:124`) is `{ driver, displayName?, accentColor?, environment?, enabled?, config? }`, where `config` is driver-specific and deliberately `Schema.Unknown` at that layer so unknown drivers round-trip.
- Today there are seven drivers: Codex, Claude, Cursor, Grok, Antigravity, OpenCode, and Generic ACP (Qwen / Kimi / DSH).
- `apps/server/src/provider/Layers/ProviderService.ts` prepares each session (`prepareMcpSession`, line 1024) and hands the provider's native session the thread's browser and knowledge MCP servers as plain descriptors.
- **Provider instances are who works. They are not model upstreams,** and nothing today maps one onto the other. That gap is what Phase 7 fills.

## Current Harness Launch Configuration

- Every driver's `create()` merges the instance's static env through `mergeProviderInstanceEnvironment(environment)` (`apps/server/src/provider/ProviderInstanceEnvironment.ts`), which overlays `environment` entries onto `process.env` and expands `~` for `CODEX_HOME` / `CLAUDE_CONFIG_DIR` only. Confirmed call sites: `CodexDriver.ts:137`, `ClaudeDriver.ts:118`, `CursorDriver.ts:109`, `GrokDriver.ts:72`, `AntigravityDriver.ts:95`, `OpenCodeDriver.ts:109`, `GenericAcpDriver.ts:71`.
- Per-session overlays already exist: `McpProviderSession.withAgentDeviceEnvironment(base, config)` is applied at seven adapter sites (Claude `ClaudeAdapter.ts:4749`, Codex `CodexAdapter.ts:2277`, Cursor `:556`, Grok `:1000`, OpenCode `:2836`, Antigravity `AntigravityDriver.ts:166`).
- **The injection point is therefore already built and already per-session.** Workbench controls a harness process it spawned, so `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` can be supplied at launch. No user-global CLI file has to be touched to point a harness at a local endpoint.
- Codex runs on a per-instance `CODEX_HOME` (shadow home supported, `CodexDriver.ts:138`); Claude reads `CLAUDE_CONFIG_DIR`.

## Current Provider Instance Settings

- `apps/server/src/serverSettings.ts` owns persistence, validation, secret materialization, and the client-facing redaction pass `redactServerSettingsForClient` (line 174).
- `ProviderInstanceConfig.environment: ProviderInstanceEnvironment` is an array of `{ name, value, sensitive, valueRedacted? }` (`providerInstance.ts:104`) - arbitrary env variables an instance's process receives. `sensitive` already exists as a concept.
- `settings.json` is written **sparsely**: a key equal to its decoding default can be dropped, which is why Phase 6's `KnowledgeSagConnection` fields carry decoding defaults (`PHASE6_REPORT.md` section 24). Any new settings struct must do the same.
- Redaction precedent: `KNOWLEDGE_SAG_TOKEN_REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022"` (`packages/contracts/src/knowledge.ts:129`) is stored in `settings.json` in place of the real token; echoing it keeps the stored secret and an empty string clears it (`serverSettings.ts:740, 918, 935`).

## Existing Secret Store

`apps/server/src/auth/ServerSecretStore.ts` (314 lines) is a `Context.Service` with `get`, `set`, `create`, `getOrCreateRandom`, `remove`. Secrets are individual `0600` files under `ServerConfig.secretsDir` (directory `0700`), written via a UUID-named temp file plus `rename` (atomic), and read as `Uint8Array`. There is no OS keychain integration and none is needed: the file-permission store is the project's frozen equivalent and Phase 6 already stores the SAG token there under `knowledge-sag-token`.

## Existing Usage / Token Accounting

`apps/server/src/usage/` already exists and is entirely **transcript-derived**: `usageTranscripts.ts`, `usageTranscriptReader.ts`, `usageScanCache.ts`, `usageAggregation.ts`, `usagePricing.ts`, `UsageService.ts`, `cliproxyApi.ts`, `UsageLimitSources.ts`.

- Numbers come from scanning CLI session logs and provider limit APIs, not from the request path.
- A pricing vocabulary already exists (`usagePricing.ts`, `ServerSettings.usagePriceOverrides`), so cost estimation has a precedent to extend rather than invent.
- **There is no proxy-observed usage of any kind,** and nothing that records latency or time-to-first-token.
- Phase 7's gateway sits _in_ the request path, so proxy-observed usage is the correct V1 source (brief section 38) and the transcript importers are not touched.

## Existing Model Metadata

- `apps/server/src/provider/ModelManifest.ts` + `model-manifest.json` (Codex), `ClaudeModelCatalog.ts` + `ClaudeModelManifest.ts` (Claude), and `builtInProviderCatalog.ts` for the rest.
- Model lists are per **harness**, which is exactly the confusion Phase 7 removes: a harness's model list is what that CLI can name, not what an upstream bills for. Route-level model mapping is new and belongs to the gateway, not to these catalogs.

## Existing Request Proxy Infrastructure

- `apps/server/src/mcp/McpHttpServer.ts` - the closest existing precedent: a loopback HTTP server the Workbench owns, handed to providers as an MCP endpoint. Its credential story is per-thread: `apps/server/src/mcp/McpSessionRegistry.ts` mints credentials and `McpInvocationContext.ts` validates them. Phase 5 recorded its boundary as "loopback only plus an unguessable port" with no bearer of its own (`PHASE5_REPORT.md` section 18).
- `apps/server/src/browser/BrowserRuntime.ts` - the lifecycle precedent: loopback port reservation, scope-bound spawn/start, HTTP readiness probe, stale-record reaping, `Stopped -> Starting -> Ready -> Stopping -> Stopped` (`PHASE5_REPORT.md` line 132).
- `apps/server/src/device/` (`LocalDeviceHost`) is the original of that pattern; Phase 5 reused it rather than writing a second supervisor.
- **There is no model-API proxy of any kind today.** The gateway is new code, but it is new code shaped like `McpHttpServer` (a loopback listener the Workbench owns and hands out as a URL), not like a child process.

## Current CC Switch Version / Commit

- Latest release **v3.20.3, 2026-09-11**; the audited `main` tree already reports `3.20.3` in both `package.json` and `src-tauri/Cargo.toml`.
- **HEAD commit SHA: UNVERIFIED.** `api.github.com` returned HTTP 403 for every request from this environment, so the tree was obtained as a `codeload.github.com` tarball of `main` and inspected locally at `.plans/phase7/_ccs/cc-switch-main/`. Upstream pinning must be completed later with API access.
- Licence **MIT**, Copyright (c) 2025 Jason Young - confirmed from `LICENSE` in the tree.
- Stack: Tauri 2 (Rust backend, React/TypeScript/Vite frontend, pnpm), single crate, no workspace. Release cadence is fast: 3.20.3 self-reports 22 commits over 62 files.

## CC Switch Provider Model

- Providers are per **target app** (`claude`, `codex`, `gemini`, `grokbuild`, plus `opencode`, `openclaw`, `pi`, `mcode`, `hermes`), stored in SQLite and managed by `src-tauri/src/services/provider/`.
- A provider entry carries a target-app-specific `settings_config` blob plus `meta` (including `apiFormat`), an `enabled`-style flag, and a name. Presets ship as data: roughly 600 KB of `src/config/*ProviderPresets.ts` covering dozens of vendors.
- **API keys are stored in plaintext in the SQLite database.** There is no encryption or keystore layer; the only protection is log redaction. This is the single largest reason not to copy that layer wholesale.

## CC Switch Proxy Architecture

- A real local HTTP server, **in-process with the Tauri app** - not a separate daemon. Axum 0.7 `Router` behind a manual hyper 1.x HTTP/1.1 accept loop using `preserve_header_case(true)`, default `127.0.0.1:15721`, with a per-app `proxy_config` row controlling port and retry policy.
- Upstream client is `reqwest 0.12` (rustls), with an additional hyper-rustls path.
- The proxy module is large: `src-tauri/src/proxy/` holds roughly 2 MB of Rust across ~60 files, including `forwarder.rs` (222 KB), `handlers.rs` (145 KB), `server.rs` (50 KB) and `provider_router.rs` (23 KB).

## CC Switch Protocol Conversion

- Conversion is **opt-in per provider**, and the default is passthrough. For Claude, the resolution order is `meta.apiFormat` > legacy `settings_config.api_format` > `openrouter_compat_mode` > default **`anthropic`**, which is a direct pass. Choosing `openai_chat`, `openai_responses` or `gemini_native` turns on conversion.
- Codex converts Responses <-> Chat / Anthropic only when the upstream is Chat-only; v3.20.3 moved the major official Codex presets to native Responses direct-connect.
- The conversion surface is enormous and bespoke: `transform_responses.rs` (197 KB), `transform_codex_chat.rs` (189 KB), `transform_codex_anthropic.rs` (124 KB), `transform_gemini.rs` (94 KB), `streaming_responses.rs` (345 KB), plus `media_sanitizer.rs` (43 KB), `tool_media.rs` (31 KB), `cache_injector.rs`, `thinking_*` rectifiers and `model_mapper.rs`.
- Read as a whole it is a per-vendor compatibility layer, not a general protocol translator. It encodes many accumulated upstream quirks.

## CC Switch Failover / Circuit Breaker

- Failover walks the provider list: `max_attempts = max_retries + 1`, additionally bounded by the number of providers, **with no backoff at all**.
- `categorize_proxy_error` fails over on timeout, forwarding failure, provider-unhealthy, config error, transform error, **auth error**, stream-idle-timeout, **and any upstream status not in an exclusion set**. The exclusion set is **400, 405, 406, 413, 414, 415, 422, 501** - so 401, 403, 404, 408, 409, 429, 451 and all 5xx **do** fail over.
- Hardcoded overrides: official Codex cards never fail over (account boundary); xAI OAuth `AuthError` never fails over.
- Circuit breaker is per `(app, provider)`: Closed / Open / HalfOpen with exactly one half-open probe. Defaults 4 failures, 2 successes, 60 s open, plus an error-rate rule (0.6 over a 10-minute min-request window); the Claude app layer uses 8 / 3 / 90 s / 0.7 / 15. Config is persisted per app.
- Before-versus-after-first-byte is handled explicitly: streaming primes the first chunk before committing downstream, and Responses streams are held until productive output or a valid terminal event, so early failures stay failover-safe while committed streams do not.

## CC Switch Usage Accounting

- Records `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens` per request, plus derived per-field costs and a total.
- Lives in SQLite (`proxy_request_logs`), with `usage_daily_rollups` for aggregation and a 30-day rollup-then-prune retention policy. `proxy/usage/parser.rs` (47 KB) extracts fields per protocol; `usage/logger.rs` (28 KB) owns write and rollup.
- Parsing is proxy-observed, which is the same choice Phase 7 makes. The parser's field-extraction mapping is the reusable part.

## CC Switch Pricing Model

- A `model_pricing` table with per-model input/output/cache-read/cache-creation rates, backed by a models.dev sync (`src/lib/modelsDevPricing.ts`, `services/model_pricing.rs`) and per-model manual override.
- Cost formula noted from `usage/logger.rs`: for cache-inclusive apps, `billable_input = input - cache_read - cache_creation`; multiplier applied on the total.

## CC Switch Config Takeover Behavior

- CC Switch is a **configuration takeover tool**: it rewrites `~/.claude/settings.json`, `~/.codex/config.toml` and `auth.json`, `~/.gemini/.env` and `settings.json`, plus OpenCode / OpenClaw / Pi / mcode / Hermes configs, and backs them up for restore (`src-tauri/src/{claude_config,codex_config,gemini_config,opencode_config,...}.rs`, `services/config.rs`).
- It reasons about the keyring for Codex auth-store mode (`codex_config.rs:1316`) and can delete `auth.json` after saving to the keyring.
- **This is the mechanism Phase 7 must not adopt.** Workbench already spawns the harness and owns the session, so it can inject env at launch; a second source of truth for `~/.codex` would be a defect, and rewriting `auth.json` or OAuth state would break the user's official subscription login.

## Direct Code Reuse Feasibility

| Component                                                                                           | Language         | Licence | Usable by this TypeScript project   | Why                                                                                                            |
| --------------------------------------------------------------------------------------------------- | ---------------- | ------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `proxy/circuit_breaker.rs`                                                                          | Rust (~17 KB)    | MIT     | **Algorithm only**                  | Small and clear, but Rust. Port the states, thresholds and single half-open probe.                             |
| `proxy/provider_router.rs` failover walk                                                            | Rust             | MIT     | **Algorithm only**                  | Port the bounded-attempt loop; the rules themselves are re-decided here (see below).                           |
| `proxy/forwarder.rs` error classification                                                           | Rust             | MIT     | **Algorithm only**                  | The status exclusion list is the valuable datum; the code is welded to Rust error types.                       |
| Streaming "prime the first chunk" pattern                                                           | Rust             | MIT     | **Algorithm only**                  | A behavioural insight, not code.                                                                               |
| `proxy/usage/parser.rs` field mapping                                                               | Rust             | MIT     | **Algorithm only**                  | The per-protocol field names are the value; extraction is rewritten in TS.                                     |
| SQLite DDL subset (`proxy_request_logs`, `model_pricing`, `provider_health`, `usage_daily_rollups`) | SQL              | MIT     | **Adaptable**                       | Our schema is written as a numbered migration with our own column types; the shape is a useful starting point. |
| `src/config/*ProviderPresets.ts` (~600 KB)                                                          | TypeScript       | MIT     | **Copyable, deliberately declined** | It would import dozens of vendors and their quirks into V1; the brief caps presets.                            |
| `redact_known_secrets` / `url_for_log` primitive                                                    | Rust (~20 lines) | MIT     | **Algorithm only**                  | Trivially re-implemented.                                                                                      |
| `proxy/providers/transform_*.rs`, `streaming_*.rs`, `media_sanitizer.rs`, `tool_media.rs` (~1.2 MB) | Rust             | MIT     | **No**                              | Per-vendor compatibility code for conversions V1 does not perform.                                             |
| Tauri shell, UI, tray, MCP/Skills/cloud-sync services                                               | Rust/TS          | MIT     | **No**                              | Explicitly out of scope, and a second information architecture.                                                |

**No CC Switch source file is copied into this repository.** Every reuse is algorithmic or schematic, so no MIT file header needs to travel and `THIRD_PARTY_LOCK.md` gains no vendored file. TypeScript was written against the same problem, not transcribed.

## Session-scoped Injection Strategy

- A provider instance gains **one optional field**: its gateway route id. Nothing else about an instance changes.
- When a session is prepared, `ProviderService.prepareMcpSession` resolves that route. If it resolves, the gateway is ready, and the driver can be pointed at it, the adapter receives a small env overlay **for that session only** - placed beside the existing `agentDeviceEnvironment` overlay and applied at the same seven adapter sites.
- The overlay is `OPENAI_BASE_URL` + `OPENAI_API_KEY` (Codex, OpenAI Responses) or `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (Claude, Anthropic Messages). The API-key slot carries the **gateway's per-session bearer**, never the upstream key.
- Nothing reads or writes `~/.codex`, `~/.claude`, `~/.gemini`, or any global CLI config. There is no config-backup system, because there is no config takeover.
- **Native mode is the default and stays intact.** An instance with no route configured is untouched.

## Gateway Ownership

The gateway, its provider profiles, its routes and its usage rows belong to the **Workbench environment**, exactly as the SAG connection does. Not to a project, a thread, a harness, or a provider instance.

## Provider Profile Ownership

Environment-level, keyed by a user-chosen id in `ServerSettings.modelGateway.providers`. An API key is stored in `ServerSecretStore` under `model-gateway-provider-<id>-api-key`; `settings.json` holds only the redaction marker.

## Model Routing Ownership

A **provider instance** selects a route. A **route** selects upstreams. A **harness** never selects an upstream, and the gateway never learns which harness called it.

## Persistence Decision

- Provider profiles, routes, retention and cooldown: **existing `settings.json`**, beside `knowledge`. No second config file.
- API keys: existing `ServerSecretStore`.
- Usage rows: **one new SQLite table**, because they are append-heavy time-series rows with a retention policy, which is what the existing database is for, and because settings are neither sized nor indexed for it.
- Circuit-breaker state: **in memory only**, derived at read time. It is per-process runtime weather, and persisting it would need a lifecycle nothing else here has.

## Security Boundary

- Listener binds `127.0.0.1` on an ephemeral port. Never `0.0.0.0`.
- Loopback is not treated as trust. Every request must carry a per-session bearer minted for one `(threadId, providerInstanceId)` pair; an unknown or revoked token is refused before any upstream is contacted.
- Upstream credentials are materialized only at the moment of forwarding and are never written to usage rows, logs, diagnostics, DTOs, activity, or handoff.
- Usage rows have no field capable of holding prompt text or a tool argument.

## Required Extensions

1. `packages/contracts/src/modelGateway*.ts` - protocols, provider profiles, routes, settings, failover policy, lifecycle/diagnostics, usage DTOs.
2. `apps/server/src/modelGateway/` - route resolution, circuit breaker, the loopback proxy, usage store, and the `ModelGatewayService` layer.
3. One migration: the usage table plus its indexes.
4. One settings key: `modelGateway`, with the established redaction cycle for provider credentials.
5. One per-session env overlay in `McpProviderSession`, applied at the seven existing adapter sites.
6. One optional provider-instance field: the gateway route id.
7. Settings UI: a Model Gateway section (providers, routes, usage).
8. Capability reporting: whether an instance can reach the gateway at all.

## Things We Must Not Build

- No protocol conversion in V1. Routes are protocol-preserving and a mismatched route is rejected at save time. No `transform_*` port, no media sanitizer, no thinking-budget rectifier.
- No CC Switch UI, tray, marketplace, deeplink, or cloud sync.
- No config takeover, no config backup/restore, no `auth.json` or OAuth manipulation.
- No second database, no `gateway.json`, no `cc-switch.sqlite`.
- No weighted balancing, geographic routing, A/B tests, or provider marketplace.
- No transcript importer for usage - the gateway is already in the request path.
- No child-process proxy. An in-process listener is the smallest thing that works here and matches `McpHttpServer`.
- No gateway awareness inside the ACP protocol runtime: an ACP harness receives env like any other process.
- No writes to any global CLI configuration file.

## Proposed Minimal Architecture

```text
Canonical Thread
      |
Provider Instance (harness)          <- who works; selects a route by id
      |
Session-scoped env overlay           <- OPENAI_BASE_URL / ANTHROPIC_BASE_URL + per-session bearer
      |
Workbench Model Gateway              <- 127.0.0.1:<ephemeral>, loopback only
      |
Route Resolver                       <- primary, then bounded backups
      |
Primary Upstream ----- failure -----> Failover Policy -----> Backup Upstream
      |                                                        |
      +---------------- Usage (metadata only) -----------------+
```

Deliberate policy divergences from CC Switch, each documented where it is decided:

1. **Auth errors do not fail over by default.** CC Switch treats 401/403 as failover-eligible because its providers are alternate _subscriptions_ and another may hold a valid key. Workbench's Phase 7 brief freezes the opposite default: a 401 is a configuration error and is surfaced rather than rotated.
2. **400 never fails over.** Both agree; recorded because it is the most likely regression.
3. **Credentials are never plaintext in a database.** CC Switch stores keys in SQLite unencrypted; Workbench uses `ServerSecretStore`.
4. **No backoff-free retry storm.** Attempts are bounded to one pass over the route's providers, with no same-provider retry.
