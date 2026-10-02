# Phase 7 Report

Model Gateway / CC Switch Core V1. Audited and implemented 2026-09-16.

## 1. Result

**PASS.**

Workbench now has a unified, loopback-only Model Gateway owned by the environment. A provider instance may keep its own provider settings (Native) or name a gateway route; when it names one, the gateway endpoint and a per-session bearer are injected into the harness process Workbench already spawns. No user-global CLI configuration is read, written, or backed up. Failover is bounded, protocol-preserving, and never replays a response the client has already begun to receive. Every exit criterion in the phase brief is satisfied; the evidence is in sections 10-23, and the known limitations are stated in section 23 rather than smoothed over.

## 2. CC Switch Version / Commit Audited

- Latest release **v3.20.3 (2026-09-11)**; the audited `main` tree reports `3.20.3` in both `package.json` and `src-tauri/Cargo.toml`.
- **Release commit `d695a2d`** (as recorded by the phase brief). **GitHub API HEAD SHA: UNVERIFIED** - `api.github.com` returned HTTP 403 for every request from this environment. The tree was therefore obtained as a `codeload.github.com` tarball of `main` and inspected file-by-file locally, so the audit is genuine source inspection rather than snippet reading. Pinning must be completed later with API access.
- Licence **MIT**, Copyright (c) 2025 Jason Young, confirmed from `LICENSE` in the tree.

## 3. CC Switch Reuse Findings

Full detail in `docs/spikes/PHASE7_IMPLEMENTATION_AUDIT.md`. The findings that shaped this phase:

- **In-process local HTTP proxy**, Axum 0.7 behind a manual hyper accept loop, default `127.0.0.1:15721`. Upstream client `reqwest 0.12`. The proxy module is roughly 2 MB of Rust across ~60 files.
- **Protocol conversion is opt-in per provider and defaults to passthrough.** For Claude the resolution order is `meta.apiFormat` > legacy `settings_config.api_format` > `openrouter_compat_mode` > default `anthropic` (a direct pass).
- **Failover excludes only `400, 405, 406, 413, 414, 415, 422, 501`.** Everything else - including **401, 403**, 404, 408, 409, 429, 451 and all 5xx - fails over. `max_attempts = max_retries + 1`, with **no backoff at all**.
- **Circuit breaker** per `(app, provider)`: Closed/Open/HalfOpen with exactly one half-open probe; defaults 4 failures / 2 successes / 60 s plus an error-rate rule.
- **Usage** records `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens` into SQLite with a 30-day rollup-then-prune retention.
- **API keys are stored in plaintext in the SQLite database.** There is no encryption or keystore layer; the only protection is log redaction. This is the single strongest reason not to copy that layer.
- CC Switch is a **configuration takeover tool**: it rewrites `~/.claude/settings.json`, `~/.codex/config.toml` and `auth.json`, `~/.gemini/.env`, and others, with backup/restore.

## 4. Direct Code Reuse vs Reimplementation Decisions

| CC Switch part                                                   | Decision           | Why                                                               |
| ---------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------- |
| `circuit_breaker.rs` (states, thresholds, single probe)          | Algorithm ported   | Rust; the design is small and clear                               |
| `provider_router.rs` bounded failover walk                       | Algorithm ported   | The rules were re-decided here (§13)                              |
| `forwarder.rs` status-exclusion list                             | Datum reused       | The list is the valuable part; code is welded to Rust error types |
| Streaming "prime the first chunk" insight                        | Algorithm ported   | Behavioural insight, not code                                     |
| `usage/parser.rs` field mapping                                  | Field names reused | Per-protocol field names are the value; extraction rewritten      |
| SQLite DDL subset                                                | Adapted            | Our schema is a numbered migration with our own types             |
| ~600 KB `*ProviderPresets.ts`                                    | **Declined**       | Would import dozens of vendors and their quirks into V1           |
| ~1.2 MB `transform_*.rs`, `streaming_*.rs`, `media_sanitizer.rs` | **Not used**       | Conversions V1 deliberately does not perform                      |
| Tauri shell, tray, UI, MCP/Skills/cloud-sync                     | **Not used**       | Out of scope; a second information architecture                   |

**No CC Switch source file was copied into this repository.** Every reuse is algorithmic or schematic, so no MIT file header needed to travel and no vendored file was added.

## 5. Gateway Architecture

```text
Canonical Thread
      |
Provider Instance (harness)          <- who works; names a route by id, or nothing (Native)
      |
Session-scoped env overlay           <- OPENAI_BASE_URL / ANTHROPIC_BASE_URL + per-session bearer
      |
Workbench Model Gateway              <- 127.0.0.1:<ephemeral>, loopback only, in-process
      |
Route Resolver                       <- primary, then bounded backups, protocol-homogeneous
      |
Primary Upstream -- eligible failure --> Failover Policy --> Backup Upstream
      |                                                        |
      +---------------- Usage (metadata only) -----------------+
```

The gateway is an in-process `node:http` listener, not a child process: it is the smallest thing that works here and matches the existing `McpHttpServer`/`BrowserRuntime` pattern. Lifecycle is `stopped -> starting -> ready -> error -> stopping -> stopped`, started lazily on first need.

## 6. Ownership

The gateway, its provider profiles, its routes and its usage rows belong to the **Workbench environment**, exactly as the SAG connection does - never to a project, a thread, a harness, or a provider instance.

- A **provider instance** selects a route; it holds no credential copy.
- A **route** selects upstreams.
- A **harness** never selects an upstream, and the gateway never learns which harness called it.
- `modelGateway/**` contains **zero** references to `handoff`, `baton`, `decider`, `is_current`, `provider_session_runtime`, or `orchestration` (verified by full-directory grep). Model failover cannot reach Phase 3's state machine because there is no code path from one to the other.

## 7. Provider Profiles

Environment-level, `ServerSettings.modelGateway.providers`, keyed by a user-chosen id. Fields: `id`, `name`, `protocol`, `baseUrl`, `apiKey` (redaction marker on disk), `defaultModel`, `enabled`. `normalizeModelGatewayBaseUrl` accepts only `http`/`https`, rejects credentials in the URL and rejects a query, so a pasted URL cannot silently become something other than what the user configured. A disabled provider is absent from the attempt list - that is the whole meaning of disabling one.

## 8. Routes

`ServerSettings.modelGateway.routes`: `id`, `name`, `enabled`, `primaryProviderId`, `backupProviderIds[]` (ordered, bounded), `modelMapping` (requested -> billing model; unmapped passes through), `failoverEnabled`.

**A disabled route is a named refusal, not silence.** `resolveModelGatewayHarness` returns `{ selection, reason }` with `reason` typed by the contract's `ModelGatewayDiagnostic`: a missing route reports `route-not-found`, a present-but-off route reports `route-disabled`, and an instance naming no route reports nothing at all (Native by the user's own choice). There is **no re-selection and no "first enabled route" lookup anywhere**, asserted including the case where another enabled route exists.

## 9. Session-scoped Injection

- The overlay is resolved in `ProviderService.prepareMcpSession`, carried on `McpProviderSessionConfig.modelGatewayEnvironment`, and merged by `withModelGatewayEnvironment` at each `withAgentDeviceEnvironment` site.
- For Codex it rides a new `CodexSessionRuntimeOptions.modelGatewayEnvironment`, so `options.environment` stays `undefined` and `extendEnv = options.environment === undefined` is untouched - the overlay lands **on top of** the inherited environment rather than replacing it (the trap that would have dropped `PATH`).
- For Claude the overlay is applied at `ClaudeAdapter.ts:4750`, which does not depend on `homePath`.
- Cursor / Grok / Antigravity / OpenCode / Generic ACP receive no overlay: their drivers are not pointed at the gateway, reported as `unsupported-by-harness` rather than guessed.
- **No path in Phase 7 reads or writes `~/.codex`, `~/.claude`, `~/.gemini`, `auth.json`, `config.toml`, or any profile directory** (grep-verified across every Phase 7 file). Injection shapes only processes Workbench itself spawned.

## 10. Protocol Support

Three families, all protocol-preserving: `openai-chat`, `openai-responses`, `anthropic-messages`. Harness mapping: `codex` -> `openai-responses`, `claudeAgent` -> `anthropic-messages`. Gemini is deliberately absent - no configured harness needs it, and admitting a protocol that cannot be exercised would be a claim without evidence.

## 11. Protocol Conversion

**Phase 7 V1 performs NO protocol conversion.** Routes therefore require a homogeneous protocol family, and this is enforced twice:

- **Save-time**: `serverSettings.updateSettings` runs `validateModelGatewayRoute` and refuses a write whose incoming `modelGateway` slice contains a `backup-protocol-mismatch` route, before any secret is written or the file touched. Only that one problem is refused: every other problem (missing provider, disabled primary, missing backup, duplicate, bad base URL, `no-backup`) stays saveable, because the fix for those _is_ to save settings and refusing them would make a broken config unfixable through the UI. Typed as `ServerSettingsError` with `operation: "validate-model-gateway"` and the offending `modelGatewayRouteId`, reusing the contract's existing copy.
- **Runtime, fail closed**: `planModelGatewayAttempts` resolves the route's protocol from its primary and excludes any upstream that differs, keeping it in `ordered` as `protocol-mismatch`. It is never converted, never resolved by picking a winner, and never silently dropped. Proven end-to-end with already-wrong settings on disk: an `openai-responses` route whose backup is `anthropic-messages`, primary answering 500 - the backup receives **0 requests**, the client gets 503, and the row reads `["primary:server-error", "backup-a:protocol-mismatch"]`.

Consequence stated plainly: **same-protocol passthrough only; no cross-protocol media or image conversion is supported or claimed.**

## 12. Streaming / Tools / Media

- Response bytes are relayed **byte-identically**; only the credential header and a route-mapped `model` field are touched. Because nothing is re-serialised, tool calls, tool ids, arguments, reasoning blocks and base64 images survive intact.
- Usage is read from a **copy** of the stream, never by rewriting it.
- Streaming and non-streaming are both covered; usage, error and finish semantics are not lost in either.
- The commit rule is deliberately stronger than the minimum: the client response begins only after the upstream returns a non-error status **and** the first body byte arrives, so a `200` that dies before producing any byte can still fail over, while anything after the first byte cannot.

## 13. Failover Semantics

Frozen in `packages/contracts/src/modelGatewayRuntime.ts`, applied only through `shouldFailoverForFailureClass` - the request path never re-derives a rule.

**Eligible:** connection error, timeout before response, 402 quota exhausted, 408, 429 rate limit, 5xx (500/502/503/504/507), 529 overloaded, malformed upstream response.

**Never eligible:** **401 and 403** (a credential or authorization configuration problem - surfaced, not rotated), 400 and 422 and the rest of 4xx (a malformed request would be malformed against every upstream), 404, `response-committed` (the client already has part of the answer), and `client-aborted` (nobody is listening).

**Bounded:** one pass over `resolveModelGatewayAttempts`, each provider at most once, no same-provider retry, no return to the primary, no recursion. Proven: primary + two backups all failing produces exactly three requests and no fourth.

### Intentional divergence from CC Switch

> **CC Switch lets 401/403 participate in failover. Workbench intentionally does NOT.**

This is a deliberate product-safety divergence, not an oversight. CC Switch's providers are alternate _subscriptions_, so another entry may hold a valid key. In Workbench a route's upstreams are alternate _endpoints for the same harness_; a 401 there is a configuration error, and silently rotating through backups would turn one mistake into a tour of several others while hiding the actual fault. The failure is surfaced on the provider that caused it.

## 14. Circuit Breaker

In-memory, per-prefix, never persisted: `closed -> open` at 3 consecutive **eligible** failures, `open -> half-open` after an exponential (capped) cooldown, exactly **one** trial probe per cooldown, success closes and resets, failure re-opens on the longer window. Time is an injected parameter, so the whole cycle is testable without a wall clock.

**A 401/403/400/404 or an aborted caller does not move the counter** - it says nothing about the upstream's health.

Two defects were found by architecture review and fixed with tests that fail against the old code:

1. **Half-open deadlock.** `recordFailure` returned early for non-eligible failures _before_ releasing the probe, so a provider whose half-open probe ended in 400/401/abort stayed `probing = true` and was excluded **permanently** (`mayAttempt` false forever, and never attempted again, so no success could ever clear it). The probe is now released before the eligibility test.
2. **`failedOver` over-counted.** It counted planned entries rather than attempts actually made, so a route whose only backup was skipped by the breaker reported a failover that never happened. It now counts real attempts, matching the contract's "abandoned _for another_".

Request-path coverage exists, not just reducer unit tests: `ModelGatewayProxy.test.ts` records failures against a frozen clock and asserts a real request yields `["primary:breaker-open", "backup:success"]`.

## 15. Usage Accounting

One row per proxied request, written after the response is delivered. **Metadata only** - the schema has no field capable of holding a prompt, a completion, a tool argument, a header, or a key, which is a stronger guarantee than a rule against filling one in.

Recorded: `id`, `recordedAt`, `threadId`, `providerInstanceId`, `routeId`, `protocol`, `requestedModel`, `upstreamModel`, `servedByProviderId`, `attempts` (the ordered `provider:outcome` story), `failedOver`, `status`, `failureClass`, `upstreamHttpStatus`, `streamed`, `latencyMs`, `timeToFirstTokenMs`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`.

- **Token counts come from the upstream's own `usage` fields.** Missing means `NULL` - meaning _unknown_, which is the honest answer. Nothing is tokenised locally and presented as a measurement.
- A failed-then-succeeded request is fully reconstructible from one row: `["primary:server-error", "backup:success"]`.

### Retention

Bounded, with a stated strategy: `retentionCutoffMs(now, retentionDays)` with `usageRetentionDays` defaulting to **30**; the cleanup trigger is a `DELETE FROM model_gateway_usage WHERE recorded_at < cutoff` run **opportunistically from a write**, throttled to at most once per hour so a busy gateway does not delete per request. Reads are windowed (`sinceHours`). There is no unbounded mode.

## 16. Pricing

**Not implemented, by decision.** Estimated cost is not a Phase 7 blocker and token usage is the more important fact. The UI shows a cost estimate only where the environment's existing `usagePriceOverrides` makes one computable (the Model grouping), and labels it as an estimate; other groupings say it is not computable rather than showing a fabricated number. No models.dev sync was built.

## 17. Secret Handling

- An API key lives in `ServerSecretStore` under `modelProviderSecretName(id)`; `settings.json` and every client DTO carry only `MODEL_GATEWAY_CREDENTIAL_REDACTED` (the same six-bullet marker the knowledge token uses). Echoing the marker keeps the stored secret; an empty string clears it.
- The harness receives a **per-session bearer**, never the upstream key. 32 random bytes, base64url, revoked with the thread exactly as the MCP session is.
- An unknown or revoked token is refused with `401` **before any upstream is contacted**.
- The upstream key is materialized only at the moment of forwarding and appears only in the outbound credential header.
- Cross-cutting leakage test with the fixture `sk-phase7-super-secret-token` driving a **real request path** (real settings service, real secret store, real listener, real upstream): the value is absent from usage rows as read back from SQLite, from the status/diagnostics DTO, from the redacted settings, from response bodies and headers, and from captured logs; and it is **positively asserted to have been sent** as `Authorization: Bearer sk-phase7-super-secret-token` to the upstream, so the test cannot pass merely because the secret never got used. A second case asserts an upstream key presented as the client credential is refused with 401 with the upstream seeing zero requests.

## 18. Persistence / Migration

- Provider profiles, routes, retention and cooldown: existing `settings.json` beside `knowledge`. No second config file, no `gateway.json`, no `cc-switch.sqlite`.
- API keys: existing `ServerSecretStore`.
- Circuit-breaker state: in memory only, derived at read time.
- **One migration, `054_ModelGatewayUsage`**: a single `model_gateway_usage` table plus three indexes. It holds **usage telemetry only** - there is no provider table, no route table, no key column, no prompt column, no response column, no tool-argument column and no file-content column. Provider profiles and routes are not duplicated into SQLite, so there is exactly one source of truth for each.
- No new dependency was added: the only entries in the `apps/server` package diff are Phase 5's `@playwright/mcp`, `@xmldom/xmldom` and `fflate`.

## 19. UI

A deliberately small `Model Gateway` settings section: gateway status and diagnostic, providers (Name / Protocol / Base URL / API key / Enabled / default model), routes (Name / Primary / Enabled / Failover / ordered backups / optional model mapping, with contract-copy problem messages), and a lightweight usage panel (requests, tokens, success rate, estimated cost where computable, grouped by provider / model / route / protocol).

The provider-instance form gained exactly one control: Native, or a configured route, defaulting to **Native**. Disabled routes are excluded from that picker, except that a route the instance already names stays visible as a disabled entry with the reason - so a user who switches a route off sees why traffic stopped instead of having their selection silently rewritten. No charts, no marketplace, no provider-logo catalog, no pricing sync, no tray, no CC Switch UI.

## 20. Tests

Command:

```
node_modules\.bin\vp.CMD test run packages/contracts/src/modelGateway.test.ts apps/server/src/modelGateway apps/server/src/provider/ModelGatewayHarness.test.ts apps/server/src/mcp/McpProviderSession.modelGateway.test.ts apps/server/src/serverSettings.test.ts apps/web/src/components/settings/modelGatewaySettings.logic.test.ts apps/web/src/components/settings/settingsSearch.test.ts
```

Result:

```
Test Files  12 passed (12)
     Tests  235 passed (235)
```

**235 passed, 0 failed, 0 skipped.** Covers: contract policy (routes, protocol homogeneity validation, base-URL normalization, model mapping, status classification, failover eligibility, breaker cooldown, usage summary/local median); attempt planning including `protocol-mismatch`; the breaker reducer including the deadlock regression; the proxy (direct passthrough, failover on 500/timeout/429, no failover on 400/401/422, no replay after first byte, no replay after a streamed tool call, bounded three-upstream attempts, breaker-skip from the request path, protocol fail-closed end-to-end, usage extraction per protocol, 401 before upstream contact); the secret cross-cutting test; usage-store write/prune/window; settings save-time rejection with a byte-identical `settings.json`; the credential marker/materialize/keep/clear cycle; harness protocol mapping and the `route-disabled` / `route-not-found` / Native distinction; and the web display logic.

Command:

```
node_modules\.bin\tsc.CMD --noEmit -p packages/contracts/tsconfig.json
```

Result: **1 error, the recorded baseline** (`composerContext.test.ts`); **0 new**. A `vitest`-vs-`@effect/vitest` import regression this phase introduced into `packages/contracts/src/modelGateway.test.ts` was found and fixed.

Command:

```
node_modules\.bin\tsc.CMD --noEmit -p apps/server/tsconfig.json
```

Result: **350 errors, exactly the recorded baseline** (`server.test.ts` 348, `AgentSessionImporter.test.ts` 2); **0 in any Phase 7 file**.

> This figure was the phase's most serious regression and it is worth recording how it was found. Providing the new layer with a bare `Layer.provideMerge(ModelGatewayService.ModelGatewayServiceLive)` left its real requirement (`ServerSettingsService | ServerSecretStore | Crypto.Crypto | SqlClient`) unsatisfied, which surfaced as 122 **new** `missingEffectContext` errors in files nobody had edited (`server.test.ts`, `cli/*`, `bin.test.ts`) - total 472 against the 350 baseline. A workstream's first diagnosis dismissed it after filtering the error list to files it had touched, which structurally cannot see this class of regression. It was isolated by commenting out that single line and re-measuring (472 -> 350, restored byte-identically), then fixed by building the gateway from the same layer values the rest of the runtime uses (the file's existing `ServerSettingsLayerLive` / `UsageLayerLive` idiom), which also keeps the gateway on the _same_ `ServerSecretStore` instance the settings layer writes keys into. Final total: **350**.

Command:

```
node_modules\.bin\tsc.CMD --noEmit -p apps/web/tsconfig.json
```

Result: **3 errors, exactly the recorded baseline** (`scopedSettings.ts` 1, `settingsLayout.tsx` 2); **0 new**.

## 21. Phase 3-6 Regression

Command:

```
node_modules\.bin\vp.CMD test run packages/contracts/src/browserSession.test.ts packages/contracts/src/knowledge.test.ts apps/server/src/browser apps/server/src/knowledge apps/server/src/coreState apps/server/src/orchestration/decider.handoff.test.ts apps/server/src/persistence/Migrations/053_CanonicalThreadCoreState.test.ts apps/server/src/provider/Layers/ProviderSessionDirectory.test.ts apps/server/src/provider/Drivers/GenericAcpDriver.test.ts apps/server/src/provider/Drivers/GenericAcpDiagnostics.test.ts apps/server/src/provider/Layers/GenericAcpAdapter.test.ts apps/server/src/mcp/toolkits apps/server/src/mcp/McpSessionRegistry.test.ts apps/server/src/mcp/McpInvocationContext.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts packages/shared/src/composerContextReferences.test.ts apps/server/src/provider/capabilityView.test.ts
```

Result:

```
Test Files  28 passed (28)
     Tests  261 passed (261)
```

**261 passed, 0 failed, 0 skipped.** Phase 3 handoff/decider/core-state/baton, Phase 4 Office toolkits and MCP session registry, Phase 5 browser runtime and profile, Phase 6 knowledge/SAG probe and scope, Generic ACP drivers and adapter, provider session directory (native-session source of truth), and the provider command reactor are all green.

Additional workstream runs, all failures pre-existing:

- provider adapters (`CodexSessionRuntime`, `ProviderService`, `CodexAdapter`, `ClaudeAdapter`, `ClaudeHome`): **313 passed, 8 failed** - all 8 the known `ProviderService.test.ts` capability-fixture failures, proven pre-existing by stubbing the gateway block out (still 8 failed / 82 passed).
- `packages/contracts apps/server/src/mcp apps/server/src/terminal`: **729 passed, 2 failed** - the known `composerContext.test.ts` handoff round-trip and the Windows path assertion in `McpHttpServer.test.ts`.
- `apps/server/src/cli`: **95 passed, 4 skipped, 1 failed** - `cli/update.test.ts` PATH resolution on Windows, unrelated to this diff.

## 22. Existing Baseline Issues

All unchanged and deliberately not fixed - they are unrelated to this phase:

- `apps/server` typecheck: **350**, from `server.test.ts` (348) and `AgentSessionImporter.test.ts` (2, about a missing `CanonicalThreadCoreState` context entry from Phase 6).
- `packages/contracts` typecheck: **1**, `composerContext.test.ts` missing the `handoff` key (introduced by Phase 3).
- `apps/web` typecheck: **3**, `scopedSettings.ts` (1) and `settingsLayout.tsx` (2).
- `McpHttpServer.test.ts` "saves the snapshot PNG on request and reports its path": Windows path-escaping assertion.
- `ProviderService.test.ts`: 8 stale `agent browser access` capability fixtures that still list only `["pull-requests"]` while production adds `"office"`. Each needs one edit; left alone per the phase rule against sweeping old debts.
- `cli/update.test.ts`: a bare-command PATH resolution assertion on Windows.

## 23. Known Limitations

1. **No protocol conversion.** A route whose upstreams disagree on protocol cannot be saved, and at runtime a differing upstream is skipped as `protocol-mismatch` and fails closed. Cross-protocol media/image conversion is neither implemented nor claimed.
2. **Two harnesses are supported, not seven.** Only `codex` (OpenAI Responses) and `claudeAgent` (Anthropic Messages) can be pointed at the gateway. Cursor, Grok, Antigravity, OpenCode and Generic ACP report `unsupported-by-harness` rather than receiving a guessed environment variable. An ACP harness can still be carried later through ordinary provider configuration; nothing gateway-specific was put into the ACP runtime.
3. **The Codex probe site is wired but unfed.** `CodexProvider.withCodexAppServerClient` accepts a `modelGatewayEnvironment` and merges it correctly, but no caller supplies one: credentials are minted per thread while the probe is per instance, so there is no honest overlay to pass. The probe therefore still reaches the upstream directly.
4. **The terminal reuses the thread's already-minted overlay** via `readMcpProviderSession(threadId)` rather than minting a second credential, because the terminal resolver has no `threadId` in its signature.
5. **The log-leak assertion is a tripwire, not proof of absence.** The proxy relays bytes inside `node:http` callbacks that run outside the test fiber's logger context, so a logger installed in a test cannot see what the request path logs. It is mitigated by the fact that `apps/server/src/modelGateway/**` emits no log lines at all today - but the assertion would not catch a log line added later.
6. **A non-failover upstream error body is relayed verbatim to the client**, by design (a proxy should not rewrite an upstream's error). If an upstream echoed the key it received inside its own error body, that body would be relayed. This is pre-existing proxy behaviour and was not asserted against.
7. **Deleting a provider or route through the settings patch is not expressible**, because `applyServerSettingsPatch` deep-merges map entries; disabling works and is the contract's meaning of retiring an upstream. Deleting therefore requires editing settings directly.
8. **A route may still be saved while naming a provider that no longer exists** - deliberately, so a stale config stays fixable; it is reported as a problem and pinned by test.
9. **`packages/contracts/src/rpc.ts` was edited though neither workstream owned it** (it had no `server.modelGateway{Status,Usage}` methods). Purely additive.
10. **An optional `threadId` was added to `resolveHarnessEnvironment`** beyond the frozen interface, so a session bearer can be minted. Without it the service reuses the credential most recently issued for that provider instance, and only while that credential still names the same route; an overlay is never produced without a usable credential.
11. **UI verification is typecheck and unit tests only.** No browser or dev-server run was performed, so the gateway panel, the route switch and the Native/Gateway picker are not visually verified.
12. **No real paid upstream was called.** Every failover, streaming, tool-call, usage and breaker behaviour is proven against real `node:http` fixtures on `127.0.0.1`.
13. **Usage has no per-attempt latency columns** - the frozen row carries one `latencyMs` and one `timeToFirstTokenMs`; per-attempt detail survives only as `provider:outcome` in `attempts`.
14. **The usage UI window is fixed at 24 hours** and the view's `recent` rows are unused; there are no charts.
15. A disabled route's stale problems stay in the settings payload while the UI suppresses the "needs attention" flag for it, so switching it back on surfaces them immediately rather than hiding them.
16. **CC Switch's HEAD commit SHA remains UNVERIFIED** (HTTP 403 on `api.github.com`); only release `v3.20.3` and the brief's `d695a2d` are recorded.

## 24. Files Changed

New (workstream A - gateway core):

- `apps/server/src/modelGateway/ModelGatewayPolicy.ts`, `ModelGatewayCircuitBreaker.ts`, `ModelGatewayProxy.ts`, `ModelGatewayService.ts`, `ModelGatewayUsageExtractor.ts`, `ModelGatewayUsageStore.ts`
- `apps/server/src/modelGateway/ModelGatewayPolicy.test.ts`, `ModelGatewayCircuitBreaker.test.ts`, `ModelGatewayProxy.test.ts`, `ModelGatewayUsageStore.test.ts`, `ModelGatewayFailoverGate.test.ts`, `ModelGatewaySecret.test.ts`
- `apps/server/src/persistence/Migrations/054_ModelGatewayUsage.ts`

New (workstream B - settings and injection):

- `apps/server/src/provider/ModelGatewayHarness.ts`, `ModelGatewayHarnessLaunch.ts`, `ModelGatewayHarness.test.ts`, `apps/server/src/mcp/McpProviderSession.modelGateway.test.ts`

New (workstream C - UI):

- `apps/web/src/components/settings/ModelGatewaySettings.tsx`, `modelGatewaySettings.logic.ts`, `modelGatewaySettings.logic.test.ts`, `apps/web/src/state/modelGateway.ts`, `apps/web/src/routes/settings.model-gateway.tsx`

New (contracts, written by the coordinating agent):

- `packages/contracts/src/modelGateway.ts`, `modelGatewayRuntime.ts`, `modelGatewayUsage.ts`, `modelGateway.test.ts`

New (docs):

- `docs/spikes/PHASE7_IMPLEMENTATION_AUDIT.md`, `docs/spikes/PHASE7_REPORT.md`

Modified: `packages/contracts/src/{index.ts,settings.ts,providerInstance.ts,rpc.ts}`; `apps/server/src/{server.ts,serverSettings.ts,ws.ts,auth/RpcAuthorization.ts,persistence/Migrations.ts,terminal/Manager.ts}`; `apps/server/src/mcp/McpProviderSession.ts`; `apps/server/src/provider/Layers/{ProviderService,CodexSessionRuntime,CodexAdapter,CodexProvider,ClaudeAdapter,CursorAdapter,GrokAdapter,OpenCodeAdapter,AntigravityAdapter}.ts`; `apps/server/src/provider/Drivers/AntigravityDriver.ts`; `apps/server/src/provider/acp/AntigravityAcpSupport.ts`; `apps/server/src/serverSettings.test.ts`; `apps/web/src/components/settings/{ProviderSettingsForm,ProviderInstanceCard,SettingsSidebarNav,settingsSearch}.tsx|ts`; `apps/web/src/routeTree.gen.ts` (generated, registered by hand because the repo has no codegen script).

## 25. Git Diff Summary

`56 files changed, +2742/-86` tracked, plus 46 untracked new files. Every Phase 1-6 working-tree change is preserved. Nothing was reset, cleaned, stashed, committed, pushed, or tagged. `git diff --check` is clean. No scratch file was left behind; the CC Switch source used for the audit and the phase's working notes live under `.plans/`, which is gitignored, and the vendored CC Switch tree can be deleted at any time.

## 26. Phase 8 Readiness

Ready for hardening, and Phase 8 was deliberately not started.

Named seams a later phase could build on, all of them optional: protocol conversion for a route whose upstreams disagree (with the media and tool-semantics guarantees the audit describes); pointing the Codex probe at the gateway; running the gateway for the ACP harnesses through ordinary provider configuration; per-attempt latency in the usage row; a configurable usage window and richer aggregation; and estimated cost beyond the Model grouping. None is required now.
