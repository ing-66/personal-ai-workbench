import { assert, it } from "@effect/vitest";
import { ModelProviderId } from "@t3tools/contracts";

import {
  makeModelGatewayCircuitBreaker,
  type ModelGatewayCircuitBreakerShape,
} from "./ModelGatewayCircuitBreaker.ts";

const primary = ModelProviderId.make("primary");
const backup = ModelProviderId.make("backup");

const cooldown = { nowMs: 0, baseCooldownMs: 30_000 };

const fail = (
  breaker: ModelGatewayCircuitBreakerShape,
  providerId = primary,
  failure: Parameters<ModelGatewayCircuitBreakerShape["recordFailure"]>[1] = "server-error",
  nowMs = 0,
) => breaker.recordFailure(providerId, failure, { nowMs, baseCooldownMs: cooldown.baseCooldownMs });

const healthOf = (breaker: ModelGatewayCircuitBreakerShape, nowMs: number) =>
  breaker.health({
    providerIds: [primary, backup],
    disabledProviderIds: new Set<string>(),
    nowMs,
  });

it("opens only at the threshold and clears on a success", () => {
  const breaker = makeModelGatewayCircuitBreaker();
  assert.isTrue(breaker.mayAttempt(primary, 0));

  fail(breaker, primary, "server-error", 0);
  fail(breaker, primary, "server-error", 1);
  assert.isTrue(breaker.mayAttempt(primary, 2), "two failures must not open the breaker");

  fail(breaker, primary, "server-error", 2);
  assert.isFalse(breaker.mayAttempt(primary, 3), "the third eligible failure opens it");

  const [opened] = healthOf(breaker, 3);
  assert.strictEqual(opened?.state, "cooling");
  assert.strictEqual(opened?.consecutiveFailures, 3);
  assert.strictEqual(opened?.coolingUntilMs, 2 + 30_000);
  assert.strictEqual(opened?.lastFailureClass, "server-error");

  breaker.recordSuccess(primary);
  assert.isTrue(breaker.mayAttempt(primary, 4));
  assert.strictEqual(healthOf(breaker, 4)[0]?.state, "healthy");
  assert.strictEqual(healthOf(breaker, 4)[0]?.consecutiveFailures, 0);
});

it("cools for the configured window, then allows exactly one trial probe", () => {
  const breaker = makeModelGatewayCircuitBreaker();
  for (let index = 0; index < 3; index += 1) fail(breaker, primary, "timeout", 0);

  assert.isFalse(breaker.mayAttempt(primary, 29_999));
  assert.isTrue(breaker.mayAttempt(primary, 30_000), "the cooldown has elapsed");

  breaker.beginAttempt(primary, 30_000);
  assert.isFalse(breaker.mayAttempt(primary, 30_001), "one probe at a time, not a stampede");

  // A failed probe doubles the next cooldown rather than reopening on the base.
  fail(breaker, primary, "timeout", 30_001);
  assert.isFalse(breaker.mayAttempt(primary, 30_002));
  assert.strictEqual(healthOf(breaker, 30_002)[0]?.coolingUntilMs, 30_001 + 60_000);
});

it("ignores failures that say nothing about the upstream's health", () => {
  const breaker = makeModelGatewayCircuitBreaker();
  fail(breaker, primary, "invalid-request", 0);
  fail(breaker, primary, "auth", 0);
  fail(breaker, primary, "client-aborted", 0);
  fail(breaker, primary, "not-found", 0);
  assert.isTrue(breaker.mayAttempt(primary, 0));
  assert.strictEqual(healthOf(breaker, 0)[0]?.consecutiveFailures, 0);
});

it("reports the user's own switch as disabled, whatever the breaker thinks", () => {
  const breaker = makeModelGatewayCircuitBreaker();
  for (let index = 0; index < 3; index += 1) fail(breaker, primary, "overloaded", 0);
  const [disabledEntry, healthyEntry] = breaker.health({
    providerIds: [primary, backup],
    disabledProviderIds: new Set<string>([primary]),
    nowMs: 1,
  });
  assert.strictEqual(disabledEntry?.state, "disabled");
  assert.strictEqual(disabledEntry?.coolingUntilMs, null);
  assert.strictEqual(healthyEntry?.state, "healthy");
  assert.strictEqual(healthyEntry?.lastFailureClass, null);
});

it("releases a half-open probe even when the failure is not the upstream's fault", () => {
  for (const failure of ["invalid-request", "auth", "client-aborted"] as const) {
    const breaker = makeModelGatewayCircuitBreaker();
    for (let index = 0; index < 3; index += 1) fail(breaker, primary, "timeout", 0);

    assert.isFalse(breaker.mayAttempt(primary, 29_999));
    assert.isTrue(breaker.mayAttempt(primary, 30_000));
    breaker.beginAttempt(primary, 30_000);
    assert.isFalse(breaker.mayAttempt(primary, 30_001), "the probe is in flight");

    fail(breaker, primary, failure, 30_001);

    // A probe is answered by whatever comes back. Holding it for a failure the
    // policy exempts from blame would take the upstream out of rotation until the
    // process restarted, because nothing would ever attempt it again.
    assert.isTrue(
      breaker.mayAttempt(primary, 30_002),
      `a ${failure} probe must release the upstream`,
    );
    assert.strictEqual(
      healthOf(breaker, 30_002)[0]?.consecutiveFailures,
      3,
      "an exempted failure does not move the chain",
    );
    assert.strictEqual(healthOf(breaker, 30_002)[0]?.state, "healthy");
  }
});

it("counts an eligible failure that answers a probe, and re-cools on the longer window", () => {
  const breaker = makeModelGatewayCircuitBreaker();
  for (let index = 0; index < 3; index += 1) fail(breaker, primary, "timeout", 0);
  assert.isTrue(breaker.mayAttempt(primary, 30_000));
  breaker.beginAttempt(primary, 30_000);
  fail(breaker, primary, "server-error", 30_000);
  assert.isFalse(breaker.mayAttempt(primary, 30_001));
  assert.strictEqual(healthOf(breaker, 30_001)[0]?.consecutiveFailures, 4);
  assert.strictEqual(healthOf(breaker, 30_001)[0]?.coolingUntilMs, 30_000 + 60_000);
});

it("keeps one provider's chain out of another's", () => {
  const breaker = makeModelGatewayCircuitBreaker();
  for (let index = 0; index < 3; index += 1) fail(breaker, primary, "server-error", 0);
  assert.isFalse(breaker.mayAttempt(primary, 1));
  assert.isTrue(breaker.mayAttempt(backup, 1));
  breaker.reset();
  assert.isTrue(breaker.mayAttempt(primary, 1));
});
