/**
 * Model Gateway - per-upstream circuit breaker.
 *
 * In-memory only, and deliberately so: this is per-process runtime weather
 * derived from real request outcomes, not configuration. Nothing here is written
 * to `settings.json` or to SQLite, and a restart starts every upstream healthy -
 * which is the lifetime a local single-user gateway wants.
 *
 * Time is a parameter of every method rather than a `Clock` read, so the whole
 * cooldown/probe cycle is testable without waiting on a wall clock. Methods are
 * synchronous and the state is a plain `Map`: a caller reads and writes one
 * provider's entry with no `await` in between, so the event loop makes each
 * transition atomic without a lock.
 *
 * @module ModelGatewayCircuitBreaker
 */
import {
  MODEL_GATEWAY_BREAKER_THRESHOLD,
  countsTowardCircuitBreaker,
  modelGatewayCooldownMs,
  type ModelGatewayFailureClass,
  type ModelGatewayProviderHealth,
  type ModelProviderId,
} from "@t3tools/contracts";

interface BreakerEntry {
  consecutiveFailures: number;
  /** Epoch ms the breaker next allows a trial, or null while the chain is closed. */
  coolingUntilMs: number | null;
  /** True while the one half-open trial for this cooldown is in flight. */
  probing: boolean;
  lastFailureClass: ModelGatewayFailureClass;
}

export interface ModelGatewayCircuitBreakerShape {
  /** Whether this upstream may be attempted at `nowMs`. */
  readonly mayAttempt: (providerId: ModelProviderId, nowMs: number) => boolean;
  /**
   * Spend the single trial probe of an elapsed cooldown. Called immediately
   * before an attempt, so two concurrent requests cannot both probe.
   */
  readonly beginAttempt: (providerId: ModelProviderId, nowMs: number) => void;
  /** An answered request closes the chain outright, however long it was open. */
  readonly recordSuccess: (providerId: ModelProviderId) => void;
  /** A failure at `nowMs`; only breaker-eligible classes move the chain. */
  readonly recordFailure: (
    providerId: ModelProviderId,
    failure: ModelGatewayFailureClass,
    input: { readonly nowMs: number; readonly baseCooldownMs: number },
  ) => void;
  /** Health for the configured providers, in the order given. */
  readonly health: (input: {
    readonly providerIds: ReadonlyArray<ModelProviderId>;
    readonly disabledProviderIds: ReadonlySet<string>;
    readonly nowMs: number;
  }) => ReadonlyArray<ModelGatewayProviderHealth>;
  readonly reset: () => void;
}

export const makeModelGatewayCircuitBreaker = (): ModelGatewayCircuitBreakerShape => {
  const entries = new Map<string, BreakerEntry>();

  const mayAttempt: ModelGatewayCircuitBreakerShape["mayAttempt"] = (providerId, nowMs) => {
    const entry = entries.get(providerId);
    if (entry === undefined || entry.coolingUntilMs === null) return true;
    if (nowMs < entry.coolingUntilMs) return false;
    return !entry.probing;
  };

  const beginAttempt: ModelGatewayCircuitBreakerShape["beginAttempt"] = (providerId, nowMs) => {
    const entry = entries.get(providerId);
    if (entry === undefined || entry.coolingUntilMs === null) return;
    if (nowMs >= entry.coolingUntilMs) entry.probing = true;
  };

  const recordSuccess: ModelGatewayCircuitBreakerShape["recordSuccess"] = (providerId) => {
    entries.delete(providerId);
  };

  const recordFailure: ModelGatewayCircuitBreakerShape["recordFailure"] = (
    providerId,
    failure,
    input,
  ) => {
    const entry = entries.get(providerId);
    // A probe is released by *any* terminal outcome, and this happens before the
    // eligibility test. A 400 or a caller who hung up still answers the half-open
    // probe; leaving it held would wedge the upstream out of rotation for the
    // life of the process - on a failure class the policy deliberately exempts
    // from blame - because the next request would be refused by `mayAttempt` and
    // a success could never arrive to clear it.
    if (entry !== undefined) entry.probing = false;
    // A 400 or a caller who hung up says nothing about the upstream's health.
    if (!countsTowardCircuitBreaker(failure)) return;
    const next =
      entry ??
      ({
        consecutiveFailures: 0,
        coolingUntilMs: null,
        probing: false,
        lastFailureClass: failure,
      } satisfies BreakerEntry);
    next.consecutiveFailures += 1;
    next.lastFailureClass = failure;
    next.probing = false;
    next.coolingUntilMs =
      next.consecutiveFailures >= MODEL_GATEWAY_BREAKER_THRESHOLD
        ? input.nowMs + modelGatewayCooldownMs(input.baseCooldownMs, next.consecutiveFailures)
        : null;
    entries.set(providerId, next);
  };

  const health: ModelGatewayCircuitBreakerShape["health"] = (input) =>
    input.providerIds.map((providerId) => {
      const entry = entries.get(providerId);
      const cooling = entry?.coolingUntilMs ?? null;
      const state: ModelGatewayProviderHealth["state"] = input.disabledProviderIds.has(providerId)
        ? "disabled"
        : cooling !== null && input.nowMs < cooling
          ? "cooling"
          : "healthy";
      return {
        providerId,
        state,
        consecutiveFailures: entry?.consecutiveFailures ?? 0,
        coolingUntilMs: state === "cooling" ? cooling : null,
        lastFailureClass: entry?.lastFailureClass ?? null,
      };
    });

  return {
    mayAttempt,
    beginAttempt,
    recordSuccess,
    recordFailure,
    health,
    reset: () => {
      entries.clear();
    },
  };
};
