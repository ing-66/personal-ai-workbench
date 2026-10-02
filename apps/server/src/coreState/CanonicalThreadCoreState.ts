import {
  CanonicalThreadTaskState,
  type CanonicalTaskStatus,
  type ProviderInstanceId,
  type ThreadArtifactId,
  ThreadArtifactMetadata,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { WorkspacePaths, type WorkspacePathOutsideRootError } from "../workspace/WorkspacePaths.ts";

export class CanonicalThreadNotFoundError extends Schema.TaggedError<CanonicalThreadNotFoundError>()(
  "CanonicalThreadNotFoundError",
  { threadId: Schema.String },
) {}

export class CanonicalThreadCoreStatePersistenceError extends Schema.TaggedError<CanonicalThreadCoreStatePersistenceError>()(
  "CanonicalThreadCoreStatePersistenceError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export type CanonicalThreadCoreStateError =
  | CanonicalThreadNotFoundError
  | CanonicalThreadCoreStatePersistenceError
  | WorkspacePathOutsideRootError;

const ThreadWorkspace = Schema.Struct({
  threadId: Schema.String,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
});

const TaskStateDbRow = CanonicalThreadTaskState;
const ArtifactDbRow = ThreadArtifactMetadata;

export interface CanonicalThreadCoreStateShape {
  readonly getTaskState: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<CanonicalThreadTaskState>, CanonicalThreadCoreStateError>;
  readonly setTaskState: (input: {
    readonly threadId: ThreadId;
    readonly status: CanonicalTaskStatus;
    readonly objective: string;
  }) => Effect.Effect<CanonicalThreadTaskState, CanonicalThreadCoreStateError>;
  readonly registerArtifact: (input: {
    readonly artifactId: ThreadArtifactId;
    readonly threadId: ThreadId;
    readonly workspaceRelativePath: string;
    readonly artifactType: string;
    readonly producingProviderInstanceId?: ProviderInstanceId;
  }) => Effect.Effect<ThreadArtifactMetadata, CanonicalThreadCoreStateError>;
  readonly listArtifacts: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ThreadArtifactMetadata>, CanonicalThreadCoreStateError>;
  readonly updateArtifact: (input: {
    readonly artifactId: ThreadArtifactId;
    readonly threadId: ThreadId;
    readonly workspaceRelativePath: string;
    readonly artifactType: string;
    readonly producingProviderInstanceId?: ProviderInstanceId | null;
  }) => Effect.Effect<ThreadArtifactMetadata, CanonicalThreadCoreStateError>;
  readonly unregisterArtifact: (input: {
    readonly artifactId: ThreadArtifactId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, CanonicalThreadCoreStateError>;
}

export class CanonicalThreadCoreState extends Context.Service<
  CanonicalThreadCoreState,
  CanonicalThreadCoreStateShape
>()("t3/coreState/CanonicalThreadCoreState") {}

function persistenceError(operation: string) {
  return (cause: unknown) => new CanonicalThreadCoreStatePersistenceError({ operation, cause });
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workspacePaths = yield* WorkspacePaths;

  const findThreadWorkspace = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: Schema.String }),
    Result: ThreadWorkspace,
    execute: ({ threadId }) => sql`
      SELECT
        thread.thread_id AS "threadId",
        project.workspace_root AS "workspaceRoot",
        thread.worktree_path AS "worktreePath"
      FROM projection_threads AS thread
      INNER JOIN projection_projects AS project ON project.project_id = thread.project_id
      WHERE thread.thread_id = ${threadId}
        AND thread.deleted_at IS NULL
        AND project.deleted_at IS NULL
    `,
  });

  const resolveThreadWorkspace = Effect.fn("CanonicalThreadCoreState.resolveThreadWorkspace")(
    function* (threadId: ThreadId) {
      const row = yield* findThreadWorkspace({ threadId }).pipe(
        Effect.mapError(persistenceError("resolveThreadWorkspace")),
      );
      return yield* Option.match(row, {
        onNone: () => Effect.fail(new CanonicalThreadNotFoundError({ threadId })),
        onSome: Effect.succeed,
      });
    },
  );

  const getTaskStateRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: Schema.String }),
    Result: TaskStateDbRow,
    execute: ({ threadId }) => sql`
      SELECT thread_id AS "threadId", status, objective, updated_at AS "updatedAt"
      FROM thread_task_states
      WHERE thread_id = ${threadId}
    `,
  });

  const getTaskState: CanonicalThreadCoreStateShape["getTaskState"] = Effect.fn(
    "CanonicalThreadCoreState.getTaskState",
  )(function* (threadId) {
    yield* resolveThreadWorkspace(threadId);
    return yield* getTaskStateRow({ threadId }).pipe(
      Effect.mapError(persistenceError("getTaskState")),
    );
  });

  const setTaskState: CanonicalThreadCoreStateShape["setTaskState"] = Effect.fn(
    "CanonicalThreadCoreState.setTaskState",
  )(function* (input) {
    yield* resolveThreadWorkspace(input.threadId);
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const row = CanonicalThreadTaskState.make({ ...input, updatedAt });
    yield* sql`
      INSERT INTO thread_task_states (thread_id, status, objective, updated_at)
      VALUES (${row.threadId}, ${row.status}, ${row.objective}, ${row.updatedAt})
      ON CONFLICT (thread_id) DO UPDATE SET
        status = excluded.status,
        objective = excluded.objective,
        updated_at = excluded.updated_at
    `.pipe(Effect.mapError(persistenceError("setTaskState")));
    return row;
  });

  const validateArtifactPath = Effect.fn("CanonicalThreadCoreState.validateArtifactPath")(
    function* (threadId: ThreadId, relativePath: string) {
      const thread = yield* resolveThreadWorkspace(threadId);
      return yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: thread.worktreePath ?? thread.workspaceRoot,
        relativePath,
      });
    },
  );

  const listArtifactRows = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: Schema.String }),
    Result: ArtifactDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        artifact_id AS "artifactId",
        thread_id AS "threadId",
        workspace_relative_path AS "workspaceRelativePath",
        artifact_type AS "artifactType",
        producing_provider_instance_id AS "producingProviderInstanceId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM thread_artifacts
      WHERE thread_id = ${threadId}
      ORDER BY updated_at DESC, artifact_id ASC
    `,
  });

  const registerArtifact: CanonicalThreadCoreStateShape["registerArtifact"] = Effect.fn(
    "CanonicalThreadCoreState.registerArtifact",
  )(function* (input) {
    const path = yield* validateArtifactPath(input.threadId, input.workspaceRelativePath);
    const now = DateTime.formatIso(yield* DateTime.now);
    const row = ThreadArtifactMetadata.make({
      artifactId: input.artifactId,
      threadId: input.threadId,
      workspaceRelativePath: path.relativePath,
      artifactType: input.artifactType,
      producingProviderInstanceId: input.producingProviderInstanceId ?? null,
      createdAt: now,
      updatedAt: now,
    });
    yield* sql`
      INSERT INTO thread_artifacts (
        artifact_id, thread_id, workspace_relative_path, artifact_type,
        producing_provider_instance_id, created_at, updated_at
      ) VALUES (
        ${row.artifactId}, ${row.threadId}, ${row.workspaceRelativePath}, ${row.artifactType},
        ${row.producingProviderInstanceId}, ${row.createdAt}, ${row.updatedAt}
      )
    `.pipe(Effect.mapError(persistenceError("registerArtifact")));
    return row;
  });

  const listArtifacts: CanonicalThreadCoreStateShape["listArtifacts"] = Effect.fn(
    "CanonicalThreadCoreState.listArtifacts",
  )(function* (threadId) {
    yield* resolveThreadWorkspace(threadId);
    return yield* listArtifactRows({ threadId }).pipe(
      Effect.mapError(persistenceError("listArtifacts")),
    );
  });

  const updateArtifact: CanonicalThreadCoreStateShape["updateArtifact"] = Effect.fn(
    "CanonicalThreadCoreState.updateArtifact",
  )(function* (input) {
    const path = yield* validateArtifactPath(input.threadId, input.workspaceRelativePath);
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE thread_artifacts
      SET workspace_relative_path = ${path.relativePath},
          artifact_type = ${input.artifactType},
          producing_provider_instance_id = ${input.producingProviderInstanceId ?? null},
          updated_at = ${updatedAt}
      WHERE artifact_id = ${input.artifactId} AND thread_id = ${input.threadId}
    `.pipe(Effect.mapError(persistenceError("updateArtifact")));
    const rows = yield* listArtifactRows({ threadId: input.threadId }).pipe(
      Effect.mapError(persistenceError("updateArtifact:read")),
    );
    const row = rows.find((artifact) => artifact.artifactId === input.artifactId);
    if (!row) return yield* new CanonicalThreadNotFoundError({ threadId: input.threadId });
    return row;
  });

  const unregisterArtifact: CanonicalThreadCoreStateShape["unregisterArtifact"] = Effect.fn(
    "CanonicalThreadCoreState.unregisterArtifact",
  )(function* (input) {
    yield* resolveThreadWorkspace(input.threadId);
    yield* sql`
      DELETE FROM thread_artifacts
      WHERE artifact_id = ${input.artifactId} AND thread_id = ${input.threadId}
    `.pipe(Effect.mapError(persistenceError("unregisterArtifact")));
  });

  return CanonicalThreadCoreState.of({
    getTaskState,
    setTaskState,
    registerArtifact,
    listArtifacts,
    updateArtifact,
    unregisterArtifact,
  });
});

export const layer = Layer.effect(CanonicalThreadCoreState, make);
