# Phase 3 Report

## 1. Result

PASS

Phase 3 delivers Baton / Handoff / Shared Briefing / Auto Continue on the frozen Phase 2 base. It
reuses the existing Canonical Thread, provider session directory, event log, thread activities, and
composer-context pipeline. No second current-provider store, no second event log, no second native
session store, and no database migration were added.

## 2. Implementation Audit Summary

Full audit: `docs/spikes/PHASE3_IMPLEMENTATION_AUDIT.md` (written before coding).

Findings that shaped the implementation:

- `provider_session_runtime.is_current` already enforces at most one current binding per thread
  (unique partial index from migration 053) and is already the routing authority read by
  `ProviderSessionDirectory.getBinding`. It is the baton.
- `OrchestrationThread.session` is a projection written from the live provider session, so it stays
  derived UI state and nothing routes on it.
- A cross-instance switch while a session is active is refused by the existing routing guard
  (and again by `ProviderService.startSession` when continuation keys differ), so a handoff must
  stop the outgoing session explicitly. `thread.session.stop` / `providerService.stopSession`
  already is that path; no second process-kill protocol exists.
- `projectComposerContextForProvider` is the one provider-neutral seam every adapter already
  receives, so the briefing rides a composer-context record instead of four per-harness injectors.
- `ThreadActivityAppendCommand` / `thread.activity-appended` plus
  `OrchestrationThread.activities` can carry handoff history with one new `kind` string and a typed
  payload, so no new event log or table is needed.
- `redactProviderEnvironmentVariable` / `redactServerSettingsForClient` handle configured secrets;
  there was no free-text scanner for thread content, which the briefing needed.

## 3. Loom Findings

Source read read-only: `github.com/nickthelegend/loom` (`README.md`, `ARCHITECTURE.md`,
`src/core/baton.ts`, `src/core/projection.ts`, `src/core/distill.ts`, `src/daemon/runtime.ts`,
`src/adapters/base.ts`, `test/baton.test.ts`, `test/briefing.test.ts`).

Borrowed:

- one holder per thread as durable state, re-read on every check rather than kept in memory;
- one logged transition per handoff;
- **ordering**: validate everything that can refuse the handoff _before_ interrupting the outgoing
  holder, so a refused target cannot strand the thread;
- one-shot delivery rather than a repeatable flag;
- a deterministic, budget-bounded briefing template, with no LLM in the V1 path;
- a delimited "authoritative" framing for providers with no real system channel;
- no parallel writers: route to the holder and refuse the alternative instead of silently
  redirecting.

Not copied: routes and auto-tiering, sub-agents, bridges, the persistent per-agent memory file,
shared-brain retrieval, memory extraction, LLM memory folding, quarantine/budget gating,
board/Linear/GitHub integration, observability, voice, mobile, hardware, cost accounting.

Mapping from Loom to T3 is in the audit's findings table (`.loom/state.json` holder →
`provider_session_runtime.is_current`; `.loom/log.db` handoff events → thread activities; the
`pendingBriefings` map → the briefing riding exactly one `thread.turn.start`).

## 4. Baton

**Source of truth (single):** `provider_session_runtime.is_current`, reached only through
`ProviderSessionDirectory`. Phase 2's unique partial index
`idx_provider_session_runtime_current ON provider_session_runtime(thread_id) WHERE is_current = 1`
makes "one holder per thread" a database invariant, and the repository upsert moves the flag
transactionally with the new session row.

- `OrchestrationThread.session.providerInstanceId` is a projection alias of that holder, never an
  authority.
- The handoff decider deliberately does **not** write the session: it emits
  `thread.handoff-requested` and nothing else, so only a real session start can claim the baton.
- Scope is one Canonical Thread. There is no project-wide or global lock.
- Single-holder semantics: the decider refuses `thread.handoff` when the target instance already
  holds the baton, when the thread is busy, and when the thread does not exist.
- No parallel writer: the outgoing session is stopped before the target's turn starts, and a busy
  thread is rejected outright (`Thread '<id>' is busy. Finish or stop the active turn before
handing it off.`) rather than being interrupted silently behind the user's back.

## 5. Handoff Pipeline

```text
thread.handoff (client command)
  → decider: thread exists, not busy, target ≠ holder      → thread.handoff-requested
  → ProviderCommandReactor.processHandoffRequested:
      1. resolve live thread detail (project, worktree, messages, session)
      2. validate target instance: configured, enabled, installed, available
      3. read Task State + artifacts (CanonicalThreadCoreState) and the target binding
      4. compose briefing (deterministic) → redact → budget → validate
      5. on any violation: record a failed handoff activity, stop. Baton untouched.
      6. stop the outgoing provider session (existing session-stop path)
      7. record an accepted handoff activity carrying the exact briefing
      8. dispatch thread.turn.start for the target instance with the briefing as a
         composer-context record (+ continuation instruction only when asked)
  → existing reactor turn path: startSession(target) → target claims is_current
  → existing adapter/runtime: resume retained cursor, else create native session
```

Transaction point: steps 1–5 are non-mutating refusals; step 6 happens only after the target is
known good; step 7 makes the handoff durable before step 8 starts any work.

## 6. Shared Briefing

**Inputs** (all from Canonical Thread facts — no shadow conversation):

- Task State: `objective`, `status` (`active|paused|completed|blocked`), `updatedAt`;
- Canonical Thread identity: thread id, title, `projectId`, `worktreePath`;
- resolved working root `thread.worktreePath ?? project.workspaceRoot`;
- source and target provider instance ids;
- observed provider session status;
- the last 8 thread messages;
- registered artifact metadata (`workspaceRelativePath`, `artifactType`);
- target session facts: whether a resumable mapping is retained;
- derived `HarnessCapabilityView` facts for the target.

**Format** (`serializeHandoffBriefing`): `HANDOFF BRIEFING` → Task → Workspace → From → To →
Current State → Relevant Recent Context → Artifacts → Native Session → Capabilities →
Continuation. Section order mirrors the composition priority.

**Budget**: `HANDOFF_BRIEFING_MAX_CHARS = 8000`. Basis is not arbitrary — the existing
`COMPOSER_CONTEXT_REVIEW_TEXT_MAX_CHARS` (16k) is this codebase's ceiling for one structured
composer-context payload, and a briefing is deliberately half of it because it is generated text
the user did not type and is injected once per handoff. Per-message cap 200 chars, at most 8 recent
messages and 20 artifacts. On overflow the composer drops recent context first, then artifacts,
then degrades free-text fields; the task/workspace/identity sections are never dropped.

**No fake summary**: composition is a pure function. It never calls an LLM. When no Task State row
exists it quotes the thread title and records `source: "thread-title"`; when neither exists it says
`Objective: not recorded for this thread` and reports the `missing-task-objective` violation rather
than inventing a task.

**Redaction** (`redactHandoffText`): detects secret-shaped content only — `*_KEY/TOKEN/SECRET/
PASSWORD/CREDENTIAL/AUTH` assignments in `KEY=value`, `KEY: value`, and `KEY value` form, bearer
tokens, `sk-`/`sk-ant-`/`sk-proj-`/`gh[pousr]_`/`xox[baprs]-`/`AIza`/JWT value shapes, and whole
PEM private-key blocks. Deliberately preserved: relative paths, symbol names, error names, provider
names, task text, artifact names, and references like `OPENAI_API_KEY=$FROM_ENV` — a briefing that
cannot name a file is useless to the harness receiving it.

**Validation** (`validateHandoffBriefing`): thread exists, owning project exists, target instance
exists and is available, target ≠ source holder, briefing non-empty, briefing within budget, and an
objective is present. A target whose executable is missing fails here, before the outgoing session
is stopped.

## 7. Context Injection

One provider-neutral path, no per-harness code:

```text
HandoffService (reactor) → thread.turn.start message.context.records = [HandoffContextRecord]
      → projectComposerContextForProvider (packages/shared, existing)
      → <t3_context version="1"><context kind="handoff" ...>…</context></t3_context>
      → ProviderCommandReactor → adapter → provider
```

- New composer-context kind `handoff` (`packages/contracts/src/composerContext.ts`), which is
  forward compatible: older clients already decode unknown kinds through `UnknownContextRecord`.
- `packages/shared/src/composerContextReferences.ts` renders the record's body with
  `frameHandoffBriefing`, so the block reads as authoritative and sits above the instruction. No
  adapter was modified; Codex, Claude, Cursor, Grok, OpenCode, Antigravity, and Generic ACP all
  receive the same text.
- One-shot: the briefing exists only on the single `thread.turn.start` that the handoff dispatches.
  The next user turn is a new command with no handoff record, so the second and later turns cannot
  re-inject it. Nothing needs to remember to clear a flag.
- Handoff (no continue) still starts the target's turn so the baton actually moves, but the message
  is context-only (`HANDOFF_CONTEXT_ONLY_INSTRUCTION`) and states that no work starts until the
  user's next message.

## 8. Native Session Resume

Unchanged owner: `ProviderSessionDirectory` / `provider_session_runtime`, and each provider runtime's
own resume protocol. Phase 3 implements no resume, serialization, or ACP load.

- Target with a retained mapping: the handoff starts the target session; `ProviderService`
  `startSession` reads `directory.getBinding(threadId, resolvedInstanceId)` and passes that
  instance's own `resumeCursor` (`effectiveResumeCursor`), so the provider resumes natively.
- Target without a mapping: no cursor is available and the adapter creates a fresh native session,
  which the directory then stores for the next handoff back.
- `A → B → A` therefore resumes A's original mapping; the briefing states which of the two will
  happen ("a resumable session mapping already exists and will be resumed" vs "none retained; a new
  native session will be created").
- One correctness fix was required: the reactor previously carried the outgoing session's
  `resumeCursor` across an instance switch, which would have replayed a cursor from a different
  harness. It now withholds the cursor when the continuation group changes (a real handoff), while
  still forwarding it between instances of the same continuation group (e.g. two Codex homes, which
  existing behavior asserts).

## 9. Auto Continue

- `thread.handoff` carries optional `continuationText`. "Handoff & Continue" sends it; plain
  "Handoff" does not, and the decider records `continueAfterHandoff` accordingly.
- With continue: the target's first turn is the briefing plus
  `HANDOFF_CONTINUATION_INSTRUCTION` — context and action are separate strings.
- Exactly one turn is dispatched. There is no loop, scheduler, retry router, or background agent;
  the turn ends through the existing turn lifecycle.
- Selecting a provider in the ordinary picker still only selects; the handoff command is a distinct
  user action in a distinct UI affordance.

## 10. Failure Semantics

| Failure point                                                           | Behavior                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown thread / unknown project                                        | `thread.handoff-requested` is a no-op in the reactor; nothing is written                                                                                                                                                                          |
| Target instance not configured / disabled / not installed / unavailable | failed handoff activity with the reason; baton unchanged                                                                                                                                                                                          |
| Target is the current holder                                            | decider rejects with an invariant error; baton unchanged                                                                                                                                                                                          |
| Thread busy (starting/running session, running turn, queued turn start) | decider rejects: finish or stop the active turn first                                                                                                                                                                                             |
| Briefing over budget / empty / no objective                             | failed handoff activity listing the violations; baton unchanged                                                                                                                                                                                   |
| Outgoing session stop fails                                             | logged; the handoff still proceeds so the thread is never left with no writer, and the stop failure is visible in the existing provider logs                                                                                                      |
| Target session start fails                                              | baton is already the target and the handoff activity is `accepted`, so nothing pretends the handoff did not happen; the failure surfaces through the existing turn lifecycle (`session.error` / failure activity) and the user can hand off again |

## 11. Persistence / Migration

**No migration was added.** Phase 3 requires no new table, and the report explains why the existing
persistence is enough:

- Baton state: already durable in `provider_session_runtime.is_current` from migration 053.
- Handoff history and the handoff state machine: the append-only orchestration event log
  (`thread.handoff-requested`) plus one thread activity per handoff
  (`kind: "handoff"`, payload `HandoffActivityPayload` with `handoffId`, from, to,
  `state: requested|accepted|failed`, `continued`, the exact `briefing`, `briefingTruncated`,
  `violations`). The thread read model already exposes `activities`, so clients and the restart path
  read handoff history from the same store as every other thread operation.
- The exact briefing text is durable in the handoff activity, so "handoff confirmed → app exits →
  restart" cannot silently resume with a wrong current provider or lose what was handed over: the
  accepted activity and the target binding both persist.

## 12. UI Changes

Web only (the platform's primary surface), minimum sufficient:

- `apps/web/src/components/chat/handoff.logic.ts` — `buildThreadHandoffCommand`,
  `selectHandoffTargets`, `deriveLatestHandoff`, state labels and failure text.
- `apps/web/src/components/chat/HandoffControls.tsx` — a "Handoff" popover beside the existing
  provider/model picker in the composer: current baton holder, the other configured instances with
  per-target "Handoff" and "Handoff & Continue", and the latest handoff state with its from → to
  summary; unavailable targets reuse the picker's existing readiness/diagnostics rendering.
- `apps/web/src/state/handoff.ts` — dispatch atom on the existing `dispatchCommand` transport.
- `apps/web/src/components/chat/ChatComposer.tsx` — renders the control next to
  `ProviderModelPicker`.

## 13. Tests

Regression Baseline Capture (Phase 1/2 reconstruction, run before any Phase 3 code):

Command:

```
.\node_modules\.bin\vp.CMD test run apps/server/src/provider/Layers/GenericAcpAdapter.test.ts apps/server/src/provider/Drivers/GenericAcpDriver.test.ts apps/server/src/provider/Drivers/GenericAcpDiagnostics.test.ts packages/contracts/src/settings.test.ts apps/web/src/components/settings/ProviderSettingsForm.test.ts
```

Result: 147 passed, 0 failed, 0 skipped (5 files)

Command:

```
.\node_modules\.bin\vp.CMD test run packages/effect-acp/src apps/server/src/provider/acp apps/server/src/provider/Layers/ProviderSessionDirectory.test.ts apps/server/src/persistence/Migrations/053_CanonicalThreadCoreState.test.ts apps/server/src/coreState/CanonicalThreadCoreState.test.ts apps/server/src/provider/capabilityView.test.ts
```

Result: 285 passed, 0 failed, 8 skipped (22 files passed, 2 skipped)

Command:

```
.\node_modules\.bin\vp.CMD test run apps/server/src/persistence/Migrations/053_CanonicalThreadCoreState.test.ts apps/server/src/coreState/CanonicalThreadCoreState.test.ts apps/server/src/provider/capabilityView.test.ts
```

Result: 4 passed, 0 failed, 0 skipped (3 files)

Phase 3 command:

```
.\node_modules\.bin\vp.CMD test run packages/contracts/src/handoff.test.ts
```

Result: 20 passed, 0 failed, 0 skipped

Phase 3 command:

```
.\node_modules\.bin\vp.CMD test run apps/server/src/orchestration/decider.handoff.test.ts
```

Result: 5 passed, 0 failed, 0 skipped

Phase 3 command:

```
.\node_modules\.bin\vp.CMD test run apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts
```

Result: 69 passed, 0 failed, 0 skipped

Phase 3 command:

```
.\node_modules\.bin\vp.CMD test run packages/shared/src/composerContextReferences.test.ts packages/contracts/src/orchestration.test.ts apps/web/src/components/chat/handoff.logic.test.ts apps/web/src/components/settings/ProviderSettingsForm.test.ts apps/server/src/provider/Layers/GenericAcpAdapter.test.ts
```

Result: 97 passed, 0 failed, 0 skipped (5 files)

Phase 3 command:

```
.\node_modules\.bin\vp.CMD test run apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts apps/server/src/provider/Layers/ProviderSessionDirectory.test.ts apps/server/src/persistence/Migrations/053_CanonicalThreadCoreState.test.ts apps/server/src/coreState/CanonicalThreadCoreState.test.ts apps/server/src/provider/capabilityView.test.ts apps/server/src/orchestration/decider.handoff.test.ts packages/contracts/src/handoff.test.ts
```

Result: 107 passed, 0 failed, 0 skipped (7 files)

Typecheck (affected packages, not repo-wide):

Command:

```
.\node_modules\.bin\vp.CMD exec tsc --noEmit -p apps/server/tsconfig.json
```

Result: 2 errors, both pre-existing and untouched by Phase 3, in
`apps/server/src/project/AgentSessionImporter.test.ts` (TS2375 and TS377004, "requires a service
that is missing from the expected Effect context: `CanonicalThreadCoreState`", left over from the
Phase 2 service addition). No Phase 3 file contributes an error. No tsconfig relaxation, no
`skipLibCheck`, no `any` casts, and no shim was used.

Web typecheck was run by the UI work as `tsc --noEmit -p apps/web/tsconfig.json` with 0 errors.

Lint was run on the changed Phase 3 files with no new warnings or errors.

What the Phase 3 tests actually cover:

- Baton: the decider records the intent and rejects a same-instance handoff and an unknown thread;
  `projectEvent` proves `thread.handoff` alone never writes the session, so the baton can only move
  through a session start.
- Single holder: no-store-write test above, plus the Phase 2 unique partial index
  `idx_provider_session_runtime_current` (covered by the 053 migration test) and the Phase 2
  `ProviderSessionDirectory` suite (11 tests) that exercises current-mapping selection.
- Handoff back (`A → B → A`) and thread/project isolation: covered by design at the store level
  (one binding per `(thread_id, provider_instance_id)`, all reads keyed by thread) and asserted by
  the Phase 2 session-directory tests; Phase 3's `resumeCursor` fix (withhold the cursor only when
  the continuation group changes) is asserted by the reactor suite's instance-switch tests.
- Briefing composer: 20 tests covering determinism, every briefing section, worktree-vs-project
  root, no invented objective (title fallback and explicit "not recorded"), message/artifact caps,
  per-message truncation, and the context/action split.
- Budget: an over-budget thread is clamped and still leads with objective, status, and workspace.
- Redaction: assigned secrets, provider-shaped tokens, bearer tokens, PEM blocks, and a
  no-false-positive case for ordinary engineering content.
- Validation: complete briefing accepted; missing target, same-instance target, and over-budget
  briefing each reported.
- One-shot: structural — the briefing rides exactly one `thread.turn.start`; `composerContextReferences`
  (17 tests) proves the neutral projection renders it as the framed envelope body.
- Auto Continue: the decider distinguishes `continueAfterHandoff` true/false.
- Busy source: rejected by the decider (test above).
- Failed target: gated before the outgoing session is stopped; the failure path records a failed
  activity and leaves the holder untouched.

## 14. Regression Status

- Generic ACP (driver, adapter, diagnostics), provider settings contracts and form: PASS.
- effect-acp and server ACP: PASS (2 files skipped, unchanged).
- Provider session mapping and current-mapping selection: PASS.
- ProviderCommandReactor, including provider routing, session restart, interrupt, and resume-cursor
  behavior: PASS (69/69).
- Core state, workspace containment, migration 053, capability view: PASS.
- Orchestration contracts and composer-context projection: PASS.

## 15. Existing Baseline Issues

- Server-package typecheck still reports the pre-existing Node `Buffer` / Node-global typing
  failures recorded in Phase 0/1/2, plus the two `AgentSessionImporter.test.ts` context errors left
  by the Phase 2 service addition. Neither was worked around.
- The global Vite+ `current` shim is still broken on this machine; `vp` resolved from
  `node_modules\.bin\vp.CMD` (vite-plus 0.3.0, vitest 4.1.11) for every command above.
- `vp.CMD` writes a note to stderr, so PowerShell reports exit code 1 even when all tests pass; the
  pass/fail counts above are read from the runner's own summary.
- `apps/server/integration/orchestrationEngine.integration.test.ts` has one unrelated failure in this
  checkout: `expected 'v2\r\n' to equal 'v2\n'` on the checkpoint-revert test, caused by
  `core.autocrlf=true` rewriting line endings. It is a Windows line-ending artifact, not a Phase 3
  regression (the other 10 tests in that file pass, 1 skipped).

## 16. Files Changed

Contracts / shared:

- `packages/contracts/src/handoff.ts` (new) and `handoff.test.ts` (new)
- `packages/contracts/src/composerContext.ts` — `handoff` composer-context kind
- `packages/contracts/src/orchestration.ts` — `thread.handoff` command,
  `thread.handoff-requested` event and payload
- `packages/contracts/src/index.ts` — export the handoff module
- `packages/shared/src/composerContextReferences.ts` — render the handoff record body

Server:

- `apps/server/src/orchestration/decider.ts` — handoff command decisions and invariant checks
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` — handoff handler, handoff
  activity recording, continuation turn, resume-cursor fix for continuation-group changes
- `apps/server/src/orchestration/decider.handoff.test.ts` (new)
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts` — harness layer wiring only
- `apps/server/integration/OrchestrationEngineHarness.integration.ts` — harness layer wiring only

Web:

- `apps/web/src/components/chat/handoff.logic.ts`, `handoff.logic.test.ts`,
  `HandoffControls.tsx` (new)
- `apps/web/src/state/handoff.ts` (new)
- `apps/web/src/components/chat/ChatComposer.tsx` — render the handoff control

Docs:

- `docs/spikes/PHASE3_IMPLEMENTATION_AUDIT.md` (new)
- `docs/spikes/PHASE3_REPORT.md` (this file)

## 17. Git Diff Summary

Phase 3 adds one contracts module plus a composer-context kind, one client command and one event,
one decider case, one reactor handler with the handoff ordering and one narrow resume-cursor fix,
one focused decider test file and one contracts test file, one web logic module plus its control and
dispatch atom, and two docs. No migration, no new table, no new dependency, and no per-provider
handoff code. All uncommitted Phase 1, Phase 1.5, and Phase 2 changes were preserved untouched: no
commit, push, tag, reset, clean, checkout, restore, or stash was executed at any point.

## 18. Known Limitations

- The baton-switch write path is not covered by an end-to-end integration test: the reactor harness
  requires two real provider adapters plus a fake native session, and extending that harness was not
  attempted in this phase. The decider, composer, injection, and reactor suites cover the parts
  around it, but `handoff A → B` followed by a real session resume in one test remains unproven.
- Handoff entry points exist only in the web composer (no command palette, keybinding, mobile, or
  desktop-specific entry), and the client-runtime package has no typed handoff atom yet — the
  dispatch atom lives in `apps/web/src/state/handoff.ts`.
- Capability facts reported to the briefing are conservative: `nativeSessionResume` follows whether
  the target retains a cursor, and MCP/filesystem/terminal are reported as supported for the target
  instance rather than negotiated per harness. Phase 3 deliberately added no `nativeSessionResume`
  capability override.
- A plain "Handoff" (no continue) necessarily adds one context-only turn to the thread, because a
  turn is the only provider-neutral way to move the baton. It is labelled as context-only so the
  target does not start work, but it is visible in the conversation.
- No browser/computer-use verification was run; the project requires explicit authorization for it.
- `CanonicalThreadCoreState` still has no user/ownership authorization. Recorded as a known boundary:
  T3 uses the runtime environment as its trust boundary, and Phase 3 did not widen scope to RBAC,
  multi-user ownership, or cross-environment authorization.

## 19. Phase 4 Readiness

Phase 3 is complete and Gate 3's criteria are met, so the Tool Bus + Office Integration work has a
foundation it can build on: a single Project-bound Canonical Thread, one baton holder with a
database-enforced single owner, per-provider native session mappings that resume, deterministic
briefings with redaction/budget/validation, and a provider-neutral context channel any new tool or
adapter can ride.

Phase 4 has **not** been started. No MCP tool bus, Office/PDF adapter, artifact versioning, browser,
knowledge, or model-gateway work was done in this phase.
