import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Live knowledge status for one environment, optionally narrowed to one
 * project's scope.
 *
 * Two shapes of this call matter, and the server treats them differently:
 *
 * - Without `projectId` the scope is `none`, so the probe runs against the bare
 *   endpoint and `sources` is every source the credential can see. That is the
 *   list a scope picker is populated from.
 * - With `projectId` the probe runs against that project's scoped MCP URL, so a
 *   project selecting one source sees only that source listed, and a source
 *   SAG no longer has answers `source-not-found`. That is the diagnostic.
 *
 * Failure is a state of the payload, never an RPC error, so this atom only
 * fails when the environment itself refused the request.
 */
export const knowledgeStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:knowledge:status",
  tag: WS_METHODS.serverKnowledgeStatus,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});
