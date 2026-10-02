import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const CanonicalTaskStatus = Schema.Literals(["active", "paused", "completed", "blocked"]);
export type CanonicalTaskStatus = typeof CanonicalTaskStatus.Type;

export const CanonicalThreadTaskState = Schema.Struct({
  threadId: ThreadId,
  status: CanonicalTaskStatus,
  objective: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});
export type CanonicalThreadTaskState = typeof CanonicalThreadTaskState.Type;

export const ThreadArtifactId = TrimmedNonEmptyString.pipe(Schema.brand("ThreadArtifactId"));
export type ThreadArtifactId = typeof ThreadArtifactId.Type;

export const ThreadArtifactMetadata = Schema.Struct({
  artifactId: ThreadArtifactId,
  threadId: ThreadId,
  workspaceRelativePath: TrimmedNonEmptyString,
  artifactType: TrimmedNonEmptyString,
  producingProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadArtifactMetadata = typeof ThreadArtifactMetadata.Type;

export const HarnessCapabilityState = Schema.Literals(["supported", "unsupported", "unknown"]);
export type HarnessCapabilityState = typeof HarnessCapabilityState.Type;

export const HarnessCapabilityView = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  available: Schema.Boolean,
  nativeSessionResume: HarnessCapabilityState,
  mcpServers: HarnessCapabilityState,
  filesystemRead: HarnessCapabilityState,
  filesystemWrite: HarnessCapabilityState,
  terminal: HarnessCapabilityState,
  /**
   * Whether the host Workbench tools are reachable for this harness. Derived at
   * read time from live session facts (the harness speaks MCP and its credential
   * grants the tool capability); there is deliberately no persisted tool catalog.
   */
  workspaceTools: HarnessCapabilityState,
  /**
   * Whether this harness can reach its thread's browser session. Derived at read
   * time from live facts (the harness speaks MCP, the session's credential
   * grants the browser capability, and the thread's Playwright MCP runtime is
   * ready); there is deliberately no persisted per-tool or per-server catalog.
   */
  browser: HarnessCapabilityState,
  /**
   * Whether this harness can reach its project's knowledge scope. Derived at
   * read time from live facts (the harness speaks MCP, the environment's SAG
   * connection is ready, and the project's scope resolves); the SAG tool list is
   * discovered over MCP and is deliberately never mirrored here.
   */
  knowledge: HarnessCapabilityState,
});
export type HarnessCapabilityView = typeof HarnessCapabilityView.Type;
