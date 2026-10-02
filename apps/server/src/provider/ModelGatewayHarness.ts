/**
 * Which harness, if any, the model gateway is allowed to carry for a provider
 * instance - and, when it is not, *why not*.
 *
 * This is the settings-side half of launch-time injection, and it is deliberately
 * pure: given a `ServerSettings` snapshot and an instance id it either names a route
 * to ask the gateway about, or it says "leave this harness alone" together with the
 * reason that is worth telling the user about. Nothing here reads or writes a global
 * CLI configuration file, and nothing here touches a credential.
 *
 * The distinction the reason exists to hold: *not configured* and *refused* are not
 * the same answer. An instance that names no route is a Native choice and is reported
 * with no reason at all; an instance that names a route the user switched off has had
 * its traffic quietly stop going where it was asked to go, and silence there would be
 * indistinguishable from Native. Only the second one carries a reason.
 *
 * The protocol table mirrors the frozen gateway interface: a harness is carried
 * only when the route it names speaks the protocol that harness speaks, because
 * V1 routes are protocol-preserving. A driver that is not in the table gets no
 * selection rather than a guessed environment variable - the gateway reports
 * `unsupported-by-harness` for it and the harness keeps its own provider
 * settings, which is exactly how it behaved before Phase 7. Whether a driver can be
 * pointed at the gateway is the gateway's rule to state, so this module does not
 * claim a reason for it.
 *
 * @module ModelGatewayHarness
 */
import type {
  ModelGatewayDiagnostic,
  ModelGatewayProtocol,
  ModelGatewayRoute,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
} from "@t3tools/contracts";

/** The protocol each harness actually speaks when pointed at the gateway. */
export const MODEL_GATEWAY_HARNESS_PROTOCOLS: Readonly<Record<string, ModelGatewayProtocol>> = {
  codex: "openai-responses",
  claudeAgent: "anthropic-messages",
};

/** The protocol a driver must be spoken to in, or `undefined` if none exists. */
export function modelGatewayHarnessProtocol(
  driverKind: ProviderDriverKind,
): ModelGatewayProtocol | undefined {
  return MODEL_GATEWAY_HARNESS_PROTOCOLS[driverKind];
}

/** The instance ids a route could be selected for. Never a fallback, only the one named. */
export interface ModelGatewayHarnessSelection {
  readonly providerInstanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly gatewayRouteId: string;
}

/**
 * The outcome of asking whether the gateway carries one instance's harness.
 *
 * `selection` is what the gateway should be asked about; `reason` is non-undefined
 * only when the harness was configured for the gateway and is nevertheless not
 * being carried, which is the case a user has to be told about.
 */
export interface ModelGatewayHarnessResolution {
  readonly selection: ModelGatewayHarnessSelection | undefined;
  readonly reason: ModelGatewayDiagnostic | undefined;
}

const NATIVE: ModelGatewayHarnessResolution = { selection: undefined, reason: undefined };

/**
 * The route an instance points at, or `undefined`.
 *
 * A missing instance, a missing route id, and a disabled instance all resolve to
 * `undefined`, because all three mean the same thing here: this harness names no
 * route.
 */
export function resolveModelGatewayRouteId(
  settings: ServerSettings,
  providerInstanceId: ProviderInstanceId,
): string | undefined {
  const instance = settings.providerInstances[providerInstanceId];
  if (!instance) return undefined;
  const routeId = instance.modelGatewayRouteId;
  return routeId !== undefined && routeId.length > 0 ? routeId : undefined;
}

/**
 * What the gateway should be asked to do for one provider instance, and why not
 * when the answer is "nothing".
 *
 * The reasons, and nothing beyond them:
 *
 * - no instance, no route id, a disabled instance, or a driver the gateway cannot
 *   carry -> no selection and no reason. That is the whole native-mode guarantee:
 *   the harness is spawned with exactly the environment it had before, and a
 *   legitimate Native choice is never dressed up as a problem.
 * - the named route does not exist -> `route-not-found`.
 * - the named route exists and is switched off -> `route-disabled`.
 *
 * A disabled route is never replaced by another one. There is no re-selection and no
 * "first enabled route" fallback anywhere in this module: silently carrying a harness
 * on a route the user did not choose is the exact failure this reason exists to
 * prevent, so the only two answers are the named route or a refusal.
 */
export function resolveModelGatewayHarness(input: {
  readonly settings: ServerSettings;
  readonly providerInstanceId: ProviderInstanceId;
}): ModelGatewayHarnessResolution {
  const instance = input.settings.providerInstances[input.providerInstanceId];
  if (!instance) return NATIVE;
  if (instance.enabled === false) return NATIVE;
  const gatewayRouteId = resolveModelGatewayRouteId(input.settings, input.providerInstanceId);
  if (gatewayRouteId === undefined) return NATIVE;
  // Routes are keyed by a branded id while the instance stores a plain string; the
  // key is what the gateway looks a route up by, so this lookup stays key-based.
  const routes = input.settings.modelGateway.routes as Readonly<
    Record<string, ModelGatewayRoute | undefined>
  >;
  const route = routes[gatewayRouteId];
  if (route === undefined) return { selection: undefined, reason: "route-not-found" };
  if (route.enabled === false) return { selection: undefined, reason: "route-disabled" };
  // Driver support is the gateway's rule to state, so an unsupported driver is a
  // refusal without a reason rather than a second opinion invented here.
  if (modelGatewayHarnessProtocol(instance.driver) === undefined) return NATIVE;
  return {
    selection: {
      providerInstanceId: input.providerInstanceId,
      driverKind: instance.driver,
      gatewayRouteId,
    },
    reason: undefined,
  };
}
