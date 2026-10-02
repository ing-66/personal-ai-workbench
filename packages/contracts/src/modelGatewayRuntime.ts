/**
 * Model Gateway - failover policy: when an attempt may be abandoned for another
 * upstream, and when it must not be.
 *
 * This module is pure. Every decision the proxy makes about failover is a function
 * of data here, so the rules are testable without a network and cannot drift into
 * the request path as special cases.
 *
 * @module ModelGatewayRuntime
 */
import * as Schema from "effect/Schema";

import { ModelProviderId } from "./modelGateway.ts";

/**
 * How an attempt ended, in the only terms the failover policy needs.
 *
 * `response-committed` is the load-bearing one. It means the client already
 * received part of this upstream's answer, so a second upstream would be answering
 * a question the client has already seen an answer begin - and, for a tool-using
 * agent, would risk the same side effect executing twice.
 */
export const ModelGatewayFailureClass = Schema.Literals([
  "connection",
  "timeout",
  "rate-limited",
  "quota-exhausted",
  "server-error",
  "auth",
  "not-found",
  "invalid-request",
  "overloaded",
  "response-committed",
  "client-aborted",
  "malformed-upstream",
]);
export type ModelGatewayFailureClass = typeof ModelGatewayFailureClass.Type;

/**
 * Whether a failure class may move on to the next upstream.
 *
 * The two rules that matter, and why:
 *
 * - **Auth and invalid-request never fail over.** A 401 means *this* provider's
 *   credential is wrong and a 400 means the request is malformed; both would be
 *   wrong against every other upstream too, and silently rotating through backups
 *   would turn one configuration mistake into a tour of four others. The failure is
 *   surfaced on the provider that caused it.
 * - **`response-committed` never fails over.** Once bytes have reached the client,
 *   replaying the request against a backup is a duplicate side effect rather than a
 *   retry. The client sees the interruption instead.
 *
 * `client-aborted` is here for the same reason: nobody is listening, so there is
 * nothing to fail over to.
 */
export const MODEL_GATEWAY_FAILOVER_POLICY: Readonly<Record<ModelGatewayFailureClass, boolean>> = {
  connection: true,
  timeout: true,
  "rate-limited": true,
  "quota-exhausted": true,
  "server-error": true,
  overloaded: true,
  "malformed-upstream": true,
  auth: false,
  "not-found": false,
  "invalid-request": false,
  "response-committed": false,
  "client-aborted": false,
};

/** Client-facing copy for every failure class, shared by Settings and usage rows. */
export const MODEL_GATEWAY_FAILURE_MESSAGES: Readonly<Record<ModelGatewayFailureClass, string>> = {
  connection: "Could not reach the upstream.",
  timeout: "The upstream did not answer in time.",
  "rate-limited": "The upstream is rate limiting this key.",
  "quota-exhausted": "The upstream reports no remaining quota.",
  "server-error": "The upstream returned a server error.",
  auth: "The upstream rejected this provider's API key.",
  "not-found": "The upstream has no such endpoint or model.",
  "invalid-request": "The upstream rejected the request as malformed.",
  overloaded: "The upstream is overloaded.",
  "response-committed": "The upstream failed after its response had already started.",
  "client-aborted": "The caller disconnected before the upstream finished.",
  "malformed-upstream": "The upstream returned a response this gateway could not follow.",
};

/**
 * Map an upstream HTTP status onto a failure class.
 *
 * 5xx is not one class. 500/502/503/504/507 and 529 are the transient family
 * failover exists for. A 505 or 501 means the upstream does not implement what was
 * asked, which the next upstream may well implement - still failover-eligible, so it
 * falls into `server-error` for now and is recorded with its real status either way.
 *
 * 402 is classified as exhausted quota because "this key is out of credit" is
 * precisely the case a backup should answer.
 */
export const classifyModelGatewayHttpStatus = (status: number): ModelGatewayFailureClass => {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota-exhausted";
  if (status === 404) return "not-found";
  if (status === 408) return "timeout";
  if (status === 429) return "rate-limited";
  if (status === 529) return "overloaded";
  if (status >= 500) return "server-error";
  return "invalid-request";
};

export const shouldFailoverForFailureClass = (failure: ModelGatewayFailureClass): boolean =>
  MODEL_GATEWAY_FAILOVER_POLICY[failure];

/**
 * Whether a failure counts against an upstream's circuit breaker.
 *
 * A 400 says nothing about the upstream's health - it says the caller sent
 * something wrong - and neither does a client that hung up. Counting either would
 * open a breaker on a provider that is working perfectly.
 */
export const countsTowardCircuitBreaker = (failure: ModelGatewayFailureClass): boolean =>
  failure !== "invalid-request" &&
  failure !== "auth" &&
  failure !== "not-found" &&
  failure !== "client-aborted";

/**
 * Consecutive eligible failures that open a breaker, and the ceiling the cooldown
 * doubles towards.
 *
 * Deliberately small and in-memory. This is not a distributed breaker: the state
 * lives in one process, is derived from real request outcomes, and is gone on
 * restart, which is exactly the lifetime a local single-user gateway wants.
 */
export const MODEL_GATEWAY_BREAKER_THRESHOLD = 3;
export const MODEL_GATEWAY_BREAKER_COOLDOWN_MAX_MS = 5 * 60_000;

/**
 * Cooldown for one provider after a breaker opened: exponential from the configured
 * base, capped, never zero.
 */
export const modelGatewayCooldownMs = (baseMs: number, consecutiveFailures: number): number => {
  const steps = Math.max(0, consecutiveFailures - MODEL_GATEWAY_BREAKER_THRESHOLD);
  const bounded = Math.min(8, steps);
  return Math.min(MODEL_GATEWAY_BREAKER_COOLDOWN_MAX_MS, Math.max(1_000, baseMs) * 2 ** bounded);
};

// ---------------------------------------------------------------------------
// Lifecycle, diagnostics and status
// ---------------------------------------------------------------------------

/**
 * Gateway lifecycle. Mirrors `BrowserRuntime`'s vocabulary so the two local
 * servers the server owns report their state the same way.
 */
export const ModelGatewayLifecycleState = Schema.Literals([
  "stopped",
  "starting",
  "ready",
  "error",
  "stopping",
]);
export type ModelGatewayLifecycleState = typeof ModelGatewayLifecycleState.Type;

/**
 * The user-facing reason the gateway is not usable. Like `KnowledgeDiagnostic`,
 * this vocabulary cannot carry a URL, a key, or a prompt.
 */
export const ModelGatewayDiagnostic = Schema.Literals([
  "disabled",
  "not-configured",
  "starting",
  "ready",
  "bind-failed",
  "route-not-found",
  // The instance names a route the user switched off. Reported, never silently Native.
  "route-disabled",
  "no-usable-upstream",
  "unsupported-by-harness",
]);
export type ModelGatewayDiagnostic = typeof ModelGatewayDiagnostic.Type;

export const MODEL_GATEWAY_DIAGNOSTIC_MESSAGES: Readonly<Record<ModelGatewayDiagnostic, string>> = {
  disabled: "The model gateway is switched off; harnesses use their own provider settings.",
  "not-configured": "Add a provider profile and a route to use the gateway.",
  starting: "The model gateway is starting.",
  ready: "The model gateway is running.",
  "bind-failed": "The model gateway could not bind a loopback port.",
  "route-not-found": "The route this harness refers to no longer exists.",
  "route-disabled":
    "This harness names a route that is switched off, so it keeps its own provider settings.",
  "no-usable-upstream": "This route has no enabled upstream to send requests to.",
  "unsupported-by-harness":
    "This harness cannot be pointed at the gateway; it keeps using its own provider settings.",
};

/** One provider's live-derived health. Runtime state, never persisted. */
export const ModelGatewayProviderHealth = Schema.Struct({
  providerId: ModelProviderId,
  /** `healthy` sends traffic; `cooling` is a tripped breaker; `disabled` is the user's switch. */
  state: Schema.Literals(["healthy", "cooling", "disabled"]),
  consecutiveFailures: Schema.Finite,
  /** Epoch ms at which the breaker next allows a trial, when `cooling`. */
  coolingUntilMs: Schema.NullOr(Schema.Finite),
  lastFailureClass: Schema.NullOr(ModelGatewayFailureClass),
});
export type ModelGatewayProviderHealth = typeof ModelGatewayProviderHealth.Type;

/** What Settings renders about the gateway. Never carries a credential or a prompt. */
export const ModelGatewayStatus = Schema.Struct({
  lifecycle: ModelGatewayLifecycleState,
  diagnostic: ModelGatewayDiagnostic,
  enabled: Schema.Boolean,
  /** The loopback endpoint harnesses are pointed at, or null while stopped. */
  endpoint: Schema.NullOr(Schema.String),
  providers: Schema.Array(
    Schema.Struct({
      id: ModelProviderId,
      name: Schema.String,
      protocol: Schema.String,
      enabled: Schema.Boolean,
      hasCredential: Schema.Boolean,
    }),
  ),
  routes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      enabled: Schema.Boolean,
      primaryProviderId: Schema.String,
      backupProviderIds: Schema.Array(Schema.String),
      failoverEnabled: Schema.Boolean,
      problems: Schema.Array(Schema.String),
    }),
  ),
  health: Schema.Array(ModelGatewayProviderHealth),
});
export type ModelGatewayStatus = typeof ModelGatewayStatus.Type;
