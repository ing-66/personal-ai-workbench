// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ProviderInstanceId, ThreadArtifactId, ThreadId } from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CanonicalThreadCoreState, layer as coreStateLayer } from "./CanonicalThreadCoreState.ts";

const infrastructure = Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer);
const projectRepositoryLayer = ProjectionProjectRepositoryLive.pipe(Layer.provide(infrastructure));
const threadRepositoryLayer = ProjectionThreadRepositoryLive.pipe(Layer.provide(infrastructure));
const workspacePathsLayer = WorkspacePaths.layer.pipe(Layer.provide(infrastructure));
const testLayer = Layer.mergeAll(
  infrastructure,
  projectRepositoryLayer,
  threadRepositoryLayer,
  workspacePathsLayer,
  coreStateLayer.pipe(Layer.provide(Layer.mergeAll(infrastructure, workspacePathsLayer))),
);

const now = "2026-09-16T00:00:00.000Z";

it.layer(testLayer)("CanonicalThreadCoreState", (it) => {
  it.effect("creates and updates task state and isolates artifact metadata by thread", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const threads = yield* ProjectionThreadRepository;
      const coreState = yield* CanonicalThreadCoreState;
      const workspaceRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-core-state-"));
      const projectId = ProjectId.make("project-core-state");
      const threadA = ThreadId.make("thread-core-a");
      const threadB = ThreadId.make("thread-core-b");

      yield* projects.upsert({
        projectId,
        title: "Core State",
        workspaceRoot,
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        autoPull: false,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      for (const threadId of [threadA, threadB]) {
        yield* threads.upsert({
          threadId,
          projectId,
          title: String(threadId),
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
            options: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurnId: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          unsettledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          pinnedAt: null,
          latestUserMessageAt: null,
          pendingApprovalCount: 0,
          pendingUserInputCount: 0,
          hasActionableProposedPlan: 0,
          deletedAt: null,
        });
      }

      yield* coreState.setTaskState({
        threadId: threadA,
        status: "active",
        objective: "Build Phase 2",
      });
      yield* coreState.setTaskState({
        threadId: threadA,
        status: "paused",
        objective: "Build Phase 2 safely",
      });
      expect(Option.getOrThrow(yield* coreState.getTaskState(threadA))).toMatchObject({
        threadId: threadA,
        status: "paused",
        objective: "Build Phase 2 safely",
      });
      assert(Option.isNone(yield* coreState.getTaskState(threadB)));

      const artifactId = ThreadArtifactId.make("artifact-readme");
      yield* coreState.registerArtifact({
        artifactId,
        threadId: threadA,
        workspaceRelativePath: "docs/README.md",
        artifactType: "document",
        producingProviderInstanceId: ProviderInstanceId.make("codex"),
      });
      expect(yield* coreState.listArtifacts(threadA)).toHaveLength(1);
      expect(yield* coreState.listArtifacts(threadB)).toHaveLength(0);

      const updated = yield* coreState.updateArtifact({
        artifactId,
        threadId: threadA,
        workspaceRelativePath: "docs/REPORT.md",
        artifactType: "report",
      });
      expect(updated.workspaceRelativePath).toBe("docs/REPORT.md");
      yield* coreState.unregisterArtifact({ artifactId, threadId: threadA });
      expect(yield* coreState.listArtifacts(threadA)).toHaveLength(0);

      const outside = yield* coreState
        .registerArtifact({
          artifactId: ThreadArtifactId.make("artifact-outside"),
          threadId: threadA,
          workspaceRelativePath: "../outside.txt",
          artifactType: "file",
        })
        .pipe(Effect.flip);
      assert.equal(outside._tag, "WorkspacePathOutsideRootError");
    }),
  );
});
