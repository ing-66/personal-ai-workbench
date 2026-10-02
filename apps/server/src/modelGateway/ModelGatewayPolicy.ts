/**
 * Model Gateway - attempt planning.
 *
 * The failover *rules* are frozen in `@t3tools/contracts`'s `modelGatewayRuntime`
 * module, and the ordered upstream list a route names is resolved by
 * `resolveModelGatewayAttempts` in `modelGateway.ts`. This module exists only to
 * turn those two into the one plan a request walks, so the proxy iterates a
 * bounded list and never re-derives a policy the contract already decided.
 *
 * Kept deliberately thin: anything that looks like a rule belongs in the
 * contract, where it is testable without a network and cannot drift into the
 * request path as a special case.
 *
 * @module ModelGatewayPolicy
 */
import {
  MODEL_GATEWAY_FAILOVER_POLICY,
  classifyModelGatewayHttpStatus,
  countsTowardCircuitBreaker,
  resolveModelGatewayAttempts,
  shouldFailoverForFailureClass,
  type ModelGatewayFailureClass,
  type ModelGatewayProtocol,
  type ModelGatewayProvider,
  type ModelGatewayRoute,
  type ModelProviderId,
} from "@t3tools/contracts";

export {
  MODEL_GATEWAY_FAILOVER_POLICY,
  classifyModelGatewayHttpStatus,
  countsTowardCircuitBreaker,
  resolveModelGatewayAttempts,
  shouldFailoverForFailureClass,
};

/** Whether an upstream is currently in rotation. False means the breaker is cooling it. */
export type ModelGatewayAttemptAvailability = (providerId: ModelProviderId) => boolean;

export interface ModelGatewayAttemptPlan {
  /**
   * Every upstream the route names, in route order, with the ones the breaker
   * holds out marked. Kept separate from `attempts` so a usage row can tell the
   * whole story in the order it happened.
   */
  readonly ordered: ReadonlyArray<ModelGatewayPlannedAttempt>;
  /** Only the upstreams to attempt, in the same order. */
  readonly attempts: ReadonlyArray<ModelGatewayProvider>;
}

export type ModelGatewayPlannedAttempt =
  | { readonly kind: "upstream"; readonly provider: ModelGatewayProvider }
  | { readonly kind: "breaker-open"; readonly providerId: ModelProviderId }
  /** Excluded because it speaks a different protocol from the route's primary. */
  | { readonly kind: "protocol-mismatch"; readonly providerId: ModelProviderId };

/**
 * The bounded attempt list for one request: the route's usable upstreams minus
 * the ones the breaker is cooling and the ones that speak another protocol, in
 * the order the route declares.
 *
 * A cooling upstream is *skipped*, never retried later in the same request, so
 * one request still makes at most one pass over the route.
 *
 * **Protocol homogeneity is enforced here, at request time, and it fails
 * closed.** V1 converts nothing between protocols, so an upstream that does not
 * speak the route's protocol cannot be carried: forwarding an OpenAI-shaped body
 * to an Anthropic endpoint would silently corrupt a tool call, a reasoning block
 * or an image, which is exactly the class of defect the protocol-preserving
 * design exists to prevent. `validateModelGatewayRoute` rejects such a route when
 * it is saved, but a route can also reach the request path from settings written
 * by an older build, a hand-edited file, or a bad merge - so the rule is enforced
 * twice, and the second check is the one that holds when the first was skipped.
 *
 * A mismatched upstream is neither converted nor picked as a winner: it is
 * excluded and recorded in `ordered` as `protocol-mismatch`, so the usage row
 * says why it never ran. A route whose primary is missing has no protocol to
 * compare against and stays unresolvable, exactly as before.
 */
export const planModelGatewayAttempts = (input: {
  readonly route: ModelGatewayRoute;
  readonly providers: Readonly<Record<string, ModelGatewayProvider>>;
  readonly isAvailable: ModelGatewayAttemptAvailability;
}): ModelGatewayAttemptPlan => {
  const ordered: Array<ModelGatewayPlannedAttempt> = [];
  const attempts: Array<ModelGatewayProvider> = [];
  const protocol = resolveModelGatewayRouteProtocol(input.route, input.providers);
  for (const provider of resolveModelGatewayAttempts(input.route, input.providers)) {
    if (protocol !== undefined && provider.protocol !== protocol) {
      ordered.push({ kind: "protocol-mismatch", providerId: provider.id });
      continue;
    }
    if (input.isAvailable(provider.id)) {
      ordered.push({ kind: "upstream", provider });
      attempts.push(provider);
    } else {
      ordered.push({ kind: "breaker-open", providerId: provider.id });
    }
  }
  return { ordered, attempts };
};

/**
 * The protocol a route carries.
 *
 * Taken from the primary upstream because `validateModelGatewayRoute` rejects a
 * route whose upstreams disagree, so the primary speaks for the whole route. An
 * undefined answer means the route is not carryable at all.
 */
export const resolveModelGatewayRouteProtocol = (
  route: ModelGatewayRoute,
  providers: Readonly<Record<string, ModelGatewayProvider>>,
): ModelGatewayProtocol | undefined => providers[route.primaryProviderId]?.protocol;

/**
 * How one entry in a usage row's `attempts` list reads: `provider:outcome`.
 *
 * A skipped upstream is recorded because it is part of the story the row tells;
 * neither `breaker-open` nor `protocol-mismatch` is an attempt, so neither
 * touches the breaker.
 */
export type ModelGatewayAttemptOutcome =
  | ModelGatewayFailureClass
  | "success"
  | "breaker-open"
  | "protocol-mismatch";

export const modelGatewayAttemptLabel = (
  providerId: string,
  outcome: ModelGatewayAttemptOutcome,
): string => `${providerId}:${outcome}`;
