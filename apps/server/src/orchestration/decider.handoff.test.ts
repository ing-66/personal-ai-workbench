import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeReadModel(thread: OrchestrationThread): OrchestrationReadModel {
  return { snapshotSequence: 0, projects: [], threads: [thread], updatedAt: NOW };
}

const handoff = {
  type: "thread.handoff" as const,
  commandId: CommandId.make("handoff-1"),
  threadId,
  targetProviderInstanceId: ProviderInstanceId.make("kimi-acp"),
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  createdAt: NOW,
};

it.layer(NodeServices.layer)("thread handoff decider", (it) => {
  it.effect("records a handoff request without moving the baton itself", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel(makeThread());
      const event = yield* decideOrchestrationCommand({ command: handoff, readModel });
      expect(Array.isArray(event)).toBe(false);
      const decision = Array.isArray(event) ? event[0]! : event;
      expect(decision.type).toBe("thread.handoff-requested");
      expect(decision.payload).toMatchObject({
        threadId,
        targetProviderInstanceId: "kimi-acp",
        continueAfterHandoff: false,
      });
      // The decider never writes the session: only the target session start may
      // claim `provider_session_runtime.is_current`.
      const projected = yield* projectEvent(readModel, { ...decision, sequence: 1 });
      expect(projected.threads[0]?.session).toBeNull();
      expect(projected.threads[0]?.modelSelection.instanceId).toBe("codex");
    }),
  );

  it.effect("marks a handoff as continuing only when the user asked for it", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: { ...handoff, continuationText: "keep going" },
        readModel: makeReadModel(makeThread()),
      });
      const decision = Array.isArray(event) ? event[0]! : event;
      expect(decision.payload).toMatchObject({ continueAfterHandoff: true });
    }),
  );

  it.effect("refuses to hand a thread to the instance that already holds it", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: { ...handoff, targetProviderInstanceId: ProviderInstanceId.make("codex") },
        readModel: makeReadModel(
          makeThread({
            session: {
              threadId,
              status: "ready",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ),
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      expect(String((error as { detail?: string }).detail)).toContain("already holds the baton");
    }),
  );

  it.effect("refuses a handoff while the outgoing provider is still working", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: handoff,
        readModel: makeReadModel(
          makeThread({
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ),
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        detail: "Thread 'thread-1' is busy. Finish or stop the active turn before handing it off.",
      });
    }),
  );

  it.effect("refuses a handoff for an unknown thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: handoff,
        readModel: { snapshotSequence: 0, projects: [], threads: [], updatedAt: NOW },
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
    }),
  );
});
