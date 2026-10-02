import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Live gateway state for one environment: lifecycle, diagnostic, the providers and
 * routes it was configured with, and each provider's breaker state.
 *
 * Read-only, and deliberately credential-free: the status reports whether a key is
 * stored, never the key. Failure is a state of the payload ("unavailable"), so this
 * atom only fails when the environment itself refused the question.
 */
export const modelGatewayStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:model-gateway:status",
  tag: WS_METHODS.serverModelGatewayStatus,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

/**
 * Proxy-observed usage for one environment: totals, one grouping, and the newest
 * rows. The query is the panel's whole window and grouping, so switching group
 * dimension is one round trip rather than a client-side re-aggregation.
 */
export const modelGatewayUsage = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:model-gateway:usage",
  tag: WS_METHODS.serverModelGatewayUsage,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});
