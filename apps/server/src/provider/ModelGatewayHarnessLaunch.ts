/**
 * The gateway's half of launch-time injection: ask the gateway for a harness
 * overlay, join it with a freshly minted session credential, and hand the result to
 * whoever is about to spawn the harness.
 *
 * Two properties matter more than anything else here:
 *
 * - **Absence is not failure.** Every path that cannot produce a usable overlay -
 *   the gateway layer is not installed, the instance names no route, the route is
 *   gone, the driver cannot be pointed at the gateway - resolves to `undefined`, and
 *   the harness is spawned with exactly the environment it would have had before
 *   Phase 7. Nothing is guessed and no global CLI configuration file is read, written,
 *   or backed up; the gateway only ever shapes the process Workbench itself spawns.
 * - **The credential never leaves this call.** The minted bearer goes straight into
 *   the overlay handed to the spawn site. It is never returned to a settings object,
 *   a client DTO, a log, or a usage row.
 *
 * @module ModelGatewayHarnessLaunch
 */
import {
  MODEL_GATEWAY_DIAGNOSTIC_MESSAGES,
  ModelRouteId,
  type ProviderInstanceId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as ModelGatewayService from "../modelGateway/ModelGatewayService.ts";
import { resolveModelGatewayHarness } from "./ModelGatewayHarness.ts";

/**
 * The environment overlay that points one thread's harness at the gateway.
 *
 * The route id is resolved from settings first, so a harness that is not carried is
 * never even offered to the gateway and no credential is minted for it.
 */
export const resolveModelGatewayHarnessEnvironment = Effect.fn(
  "resolveModelGatewayHarnessEnvironment",
)(function* (input: {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly settings: ServerSettings;
}) {
  const resolution = resolveModelGatewayHarness({
    settings: input.settings,
    providerInstanceId: input.providerInstanceId,
  });
  const selection = resolution.selection;
  if (selection === undefined) {
    // A refusal that came from a configuration the user asked for is reported
    // rather than swallowed: `route-disabled` must not be indistinguishable from
    // Native by the time anyone looks. A legitimate Native choice has no reason and
    // nothing is logged for it. Nothing sensitive is in scope here either way.
    if (resolution.reason !== undefined) {
      yield* Effect.logInfo("The model gateway is not carrying this harness", {
        providerInstanceId: input.providerInstanceId,
        diagnostic: resolution.reason,
        message: MODEL_GATEWAY_DIAGNOSTIC_MESSAGES[resolution.reason],
      });
    }
    return undefined;
  }

  const gateway = yield* Effect.serviceOption(ModelGatewayService.ModelGatewayService);
  if (Option.isNone(gateway)) return undefined;

  const overlay = yield* gateway.value.resolveHarnessEnvironment({
    providerInstanceId: selection.providerInstanceId,
    driverKind: selection.driverKind,
    gatewayRouteId: selection.gatewayRouteId,
  });
  if (overlay === undefined || Object.keys(overlay).length === 0) return undefined;

  const credential = yield* gateway.value.issueCredential({
    threadId: input.threadId,
    providerInstanceId: selection.providerInstanceId,
    routeId: ModelRouteId.make(selection.gatewayRouteId),
  });
  return McpProviderSession.withModelGatewayCredential(overlay, credential);
});

/**
 * Best-effort wrapper for the launch path: a gateway that cannot answer must never
 * be the reason a session fails to start.
 */
export const resolveModelGatewayHarnessEnvironmentOrUndefined = (input: {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly settings: ServerSettings;
}) =>
  resolveModelGatewayHarnessEnvironment(input).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("Could not resolve the model gateway environment", {
            threadId: input.threadId,
            providerInstanceId: input.providerInstanceId,
            cause,
          }).pipe(Effect.as(undefined)),
    ),
  );

/** Retire the thread's gateway credential, the way the MCP session is retired. */
export const revokeModelGatewayThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const gateway = yield* Effect.serviceOption(ModelGatewayService.ModelGatewayService);
    if (Option.isNone(gateway)) return;
    yield* gateway.value.revokeThread(threadId);
  }).pipe(Effect.ignoreCause({ log: false }));
