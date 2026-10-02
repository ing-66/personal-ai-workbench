# Phase 3 Implementation Audit

Phase 3 target: Baton / Handoff / Shared Briefing / Auto Continue on the frozen Phase 2 base
(`OrchestrationThread` + `projection_threads`, `ProviderSessionDirectory` +
`provider_session_runtime`, `CanonicalThreadCoreState`, derived capability view).

## Existing Current-Provider State

Two candidate stores already exist, plus one writer.

1. `provider_session_runtime` (repository: `apps/server/src/persistence/ProviderSessionRuntime.ts`)
   - Phase 2 key: `PRIMARY KEY (thread_id, provider_instance_id)`; a thread holds one resumable
     mapping per configured provider instance.
   - `is_current` marks the active mapping. Migration 053 created
     `CREATE UNIQUE INDEX idx_provider_session_runtime_current ON provider_session_runtime(thread_id) WHERE is_current = 1`.
     The database therefore enforces at most one current row per thread.
   - The repository upsert is transactional over that flag: it clears `is_current` for the thread's
     other rows and then sets the row for the requested binding (`SET is_current = 0` / `= 1`).
   - `ProviderSessionDirectory.getBinding(threadId)` reads the current row; with a
     `providerInstanceId` argument it reads that instance's retained mapping instead. Legacy `null`
     provider instance ids are promoted at the persistence boundary to
     `defaultInstanceIdForDriver(provider)`.

2. `projection_thread_sessions` (surfaces as `OrchestrationThread.session`) carries
   `status`, `providerName`, `providerInstanceId`, `runtimeMode`, `activeTurnId`, `lastError`.
   It is written by `ProviderCommandReactor` from the live provider session and is a UI/status
   projection, not a routing authority.

3. Routing writer: `ProviderService.startSession` resolves the requested provider instance, refuses
   disabled instances, and reads both the current binding and the target-instance binding. Its
   compatibility guard rejects a cross-instance switch while a session is active when the driver
   kind or continuation key differs, so a harness switch cannot ride on a normal turn start.

**Conclusion**: `provider_session_runtime.is_current` already carries exactly the semantics a Baton
holder needs (which configured provider instance owns this thread), is already durable, and is
already constrained to one holder per thread. No `baton_holder` / `current_agent` /
`active_harness` store may be added. `OrchestrationThread.session` remains derived UI state.

## Existing Turn / Session Routing

- A turn is requested by `thread.turn.start` (client command) → `thread.message-sent` (user role) +
  `thread.turn-start-requested` events → `ProviderCommandReactor` reaction.
- The reactor resolves the thread's project, computes
  `cwd = thread.worktreePath ?? project.workspaceRoot` (`resolveThreadWorkspaceCwd`), ensures the
  provider session (`ProviderService.startSession`), then sends the turn.
- `buildSendTurnRequestForThread` builds the request from the message text plus attachments,
  optional `modelSelection`, and `interactionMode`. Provider message history is not replayed from
  orchestration messages: continuity belongs to the provider's own native session/resume cursor,
  which is exactly what `provider_session_runtime` retains per provider instance.
- `resolveThreadWorkspaceCwd` is the only cwd rule; there is no folderless fallback.

## Existing Interrupt / Cancel Semantics

- Command `thread.turn.interrupt` (optional `turnId`) → `thread.turn-interrupt-requested` →
  `ProviderCommandReactor` calls `ProviderService`/adapter `interruptTurn`.
- ACP adapters cancel through `AcpSessionRuntime` native cancellation (including bounded cancellation
  and process retirement on timeout, covered by existing ACP tests).
- `thread.session.stop` → `thread.session-stop-requested` stops the provider session; the decider
  supports `onlyIfSettled` conditional stops.
- `ProviderSessionReaper` handles orphaned runtime rows at startup.

Phase 3 must reuse these. No second process-kill protocol.

## Existing Prompt Context Pipeline

`OrchestrationMessageContext` (`packages/contracts/src/composerContext.ts`) is the existing
provider-neutral carrier for structured context riding a user message: a message keeps canonical
reference links `[label](t3-context://v1/<kind>/<contextId>)` in its text, and the typed payload
travels in `context.records`, keyed by `contextId`.

`@t3tools/shared/composerContextReferences.projectComposerContextForProvider({ text, records })`
turns that pair into a provider-neutral envelope appended to the prompt text
(`<t3_context version="1"><context kind="…" id="…">…</context></t3_context>`), escaping payload text
that could forge a record. `ProviderCommandReactor` already routes every user turn through it:

```text
messageText: projectComposerContextForProvider({ text: message.text, records: message.context?.records ?? [] })
```

That is the single provider-neutral injection seam for a briefing. It is already used by web,
mobile, and server, and every adapter receives the result as ordinary prompt text — no
provider-specific injector is needed. `OrchestrationMessageContext` decodes unknown record kinds
through `UnknownContextRecord` / `ForwardCompatibleArray`, so a new record kind is forward
compatible with older clients.

## Existing Event / Activity Model

- `OrchestrationEventType` is a closed literal union; events are append-only and persisted in
  `orchestration_events`.
- `ThreadActivityAppendCommand` (internal) → `thread.activity-appended` →
  `OrchestrationThread.activities` (`OrchestrationThreadActivity`:
  `id`, `tone`, `kind`, `summary`, `payload: Unknown`, `turnId`, `createdAt`).
- Threads are projected into `projection_threads` with `thread_id`/`project_id`/`deleted_at`, and
  Phase 2 core state already resolves a live thread by joining `projection_threads` to
  `projection_projects` with `deleted_at IS NULL` checks.
- A user message and its activity are distinct: text lives in `projection_thread_messages`, while
  activities are the user-visible operation log.

**Conclusion**: handoff history is expressible with the existing activity mechanism (one new
`kind` string plus a typed payload). No second event log.

## Existing Sensitive-Value Redaction

- `serverSettings.ts` owns provider environment secret handling:
  `redactProviderEnvironmentVariable` blanks sensitive values and sets `valueRedacted`, and
  `redactServerSettingsForClient` applies it for every client payload.
- Secret material lives in the secret store, not in settings payloads.
- There is no generic free-text secret scanner in the server today. Phase 3 needs one only for the
  briefing body (thread messages can contain pasted credentials), and it must be additive: never
  un-redact, and never blank ordinary engineering content.

## Loom Baton Findings

Source read (read-only, nothing vendored): `github.com/nickthelegend/loom` — `README.md`,
`ARCHITECTURE.md`, `src/core/baton.ts`, `src/core/projection.ts`, `src/core/distill.ts`,
`src/daemon/runtime.ts`, `src/adapters/base.ts`, `test/baton.test.ts`, `test/briefing.test.ts`.

- The baton is the write lock: exactly one holder per project, persisted next to the project state
  and re-read from disk on every check, so two processes cannot disagree about the holder.
- Every transition appends one `handoff` event `{from, to, meta}` to the append-only log; the current
  holder is a single resolved value, not a replay-derived guess.
- Enforcement sits in two places: a typed `NotHolderError(agentId, holder)` thrown before any side
  effect, plus an `assertHolder` guard on the write path. Routing defaults to the holder and refuses
  a non-holder instead of silently redirecting.
- `handoff(to)` order is the load-bearing detail: guards and validation run **before** the outgoing
  holder is interrupted, so a refused target cannot strand the thread with no writer. Only then does
  it `await current.interrupt()` if the holder is busy.
- One-shot briefing is structural: `pendingBriefings` is a map consumed with get-and-delete at the
  next send, so "exactly once" is idempotent under retries rather than a flag anyone can forget.
- The briefing builder is a deterministic template over log rows with fixed budgets (last N items,
  per-item character truncation), and the optional LLM renderer sits behind the same interface with
  an unconditional template fallback.
- Where a transport has no real system channel, the briefing is injected as a delimited block framed
  as authoritative ground truth and placed above the user's message.
- Two self-healing rules: clear a holder that no longer exists in config, and release the lock when
  the session owning it is gone. Parallel worktrees are never auto-merged at handoff.

Adopted for Phase 3, mapped onto what T3 already has:

| Loom principle                                       | Phase 3 mapping in T3                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| one holder per unit of work                          | `provider_session_runtime.is_current`, already unique per thread                   |
| durable holder re-read from storage                  | `ProviderSessionDirectory.getBinding` reads the row every time; no in-memory baton |
| one logged transition per handoff                    | existing thread activity log (one `handoff` activity per switch)                   |
| validate before interrupting the holder              | target validation precedes `stopSession` on the outgoing instance                  |
| one-shot = consumed, not a flag                      | briefing rides exactly one `thread.turn.start`; the next turn is a new command     |
| deterministic briefing with budgets                  | fixed-budget composer, no LLM call anywhere in the path                            |
| delimited authoritative block above the user message | handoff context record rendered above the continuation instruction                 |
| no silent redirect to a non-holder                   | existing routing guard already rejects a cross-instance switch                     |

Not adopted, because Phase 3 V1 does not need them and they are explicitly out of scope: routes and
auto-tiering, sub-agent spawn/review agents, bridges, the persistent per-agent memory file, shared
brain retrieval, memory extraction, LLM memory folding, quarantine/budget gating, board/Linear/GitHub
integration, observability stack, voice, mobile, hardware, cost accounting.

## Reusable T3 Components

- `OrchestrationThread` / `projection_threads` — Canonical Thread identity and Project binding.
- `ProviderSessionDirectory` + `provider_session_runtime` — native-session mapping and Baton holder.
- `ProjectionSnapshotQuery` — thread read model including `activities`, `messages`, `session`.
- `CanonicalThreadCoreState` — task state and artifact metadata for the briefing.
- `normalizeHarnessCapabilityView` — derived capability facts for the briefing.
- `ProviderService` — instance availability, session start/stop, resume-cursor selection.
- `projectComposerContextForProvider` + `OrchestrationMessageContext` — provider-neutral injection.
- `ThreadActivityAppendCommand` / `thread.activity-appended` — handoff history.
- `WorkspacePaths` — workspace containment for artifact paths.

## Required Extensions

1. A `handoff` composer-context record kind carrying the drafted briefing, so the briefing reaches
   the target through the existing provider-neutral projection instead of a per-provider injector.
2. A deterministic handoff briefing module (compose → redact → budget → validate) that is a pure
   function over Canonical Thread facts, so both the server and the client build the same text.
3. One client command and two events on the existing event log:
   `thread.handoff` (client) → `thread.handoff-requested` (durable intent) and
   `thread.handoff-completed` (validated switch, carrying from/to and the briefing). The handoff
   history is the thread activity log, as Loom uses its append-only log.
4. One explicit baton-switch step that stops the outgoing provider session before the target takes
   over, because the existing routing guard refuses a cross-instance switch while a session is
   active. The switch itself stays on `provider_session_runtime.is_current`.
5. Minimal UI: show the current baton holder, offer available target instances, and offer explicit
   "Handoff" and "Handoff & Continue" actions.

No new table is required. The event log plus `provider_session_runtime` carry the durable state, so
"handoff confirmed, then restart" replays from the same two stores every other projection uses.

## Source-of-Truth Decisions

- **Baton holder**: `provider_session_runtime.is_current`, one row per thread (already unique in the
  database), reached only through `ProviderSessionDirectory`. `OrchestrationThread.session` stays a
  derived projection.
- **Native session mapping**: unchanged — `ProviderSessionDirectory` → `provider_session_runtime`.
  Phase 3 implements no resume protocol; it only ensures the target instance is selected so the
  existing resume-or-create path runs.
- **Canonical Thread**: unchanged — `OrchestrationThread`.
- **Briefing source**: Canonical Thread core state + thread messages/activities + artifact metadata
  - runtime/provider state. No shadow conversation, no second history store.
- **Handoff history**: the existing thread activity log; the durable handoff record exists only for
  the pending/accepted state machine, not as a parallel history.

## Proposed Minimal Architecture

```text
Project
  └── Canonical Thread (OrchestrationThread)
        ├── Task State (CanonicalThreadCoreState)          ─┐
        ├── Artifact metadata (CanonicalThreadCoreState)    │ briefing inputs
        ├── messages / activities (existing projections)    │
        ├── native session mappings (provider_session_runtime, one per instance)
        │      └── is_current = 1  ←── Baton holder (single source of truth)
        └── derived capability view                        ─┘
                    │
                    ▼
        HandoffService (server)
          validate → compose (deterministic) → redact → budget → record → switch baton
                    │
                    ▼
        thread.turn.start with message.context.records = [handoff briefing]
                    │
                    ▼
        projectComposerContextForProvider (existing, provider-neutral)
                    │
                    ▼
        ProviderCommandReactor → ProviderService.startSession(target instance)
                    │
                    ▼
        existing adapter/runtime: resume retained cursor, else create native session
```

Transaction point: the baton switch happens only after validation, composition, redaction, budget
and durable recording succeed; the outgoing session is stopped before the baton switch is written,
and any failure before the switch leaves the previous holder untouched. A failure after the switch
leaves the target identifiable (its binding is current, the handoff record and activity exist), and
the failure is surfaced through the existing turn lifecycle.

## Things We Must Not Build

- a second `CanonicalThread`, `NativeSession`, `ProviderConversation`, or `baton_holder` store;
- per-provider handoff implementations (`CodexHandoff`, `QwenHandoff`, `KimiHandoff`, `DshHandoff`);
- a `BatonManager` + `ProviderCurrentState` + `ThreadCurrentProvider` trio;
- a shared-brain database, memory extractor, LLM memory folding, BM25/hybrid retrieval;
- routes, sub-agents, workflow engine, retry router, parallel writers;
- browser/Playwright, SAG/knowledge, CC Switch/model gateway;
- an LLM call inside briefing composition;
- copying the whole thread history into a briefing;
- a new capability override for native-session resume (capability remains reported/unknown only).
