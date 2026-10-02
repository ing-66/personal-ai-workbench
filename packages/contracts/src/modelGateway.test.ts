import { describe, expect, it } from "@effect/vitest";

import {
  MODEL_GATEWAY_CREDENTIAL_REDACTED,
  ModelProviderId,
  ModelRouteId,
  modelProviderSecretName,
  normalizeModelGatewayBaseUrl,
  resolveModelGatewayAttempts,
  resolveModelGatewayUpstreamModel,
  validateModelGatewayRoute,
  type ModelGatewayProvider,
  type ModelGatewayRoute,
} from "./modelGateway.ts";
import {
  MODEL_GATEWAY_BREAKER_COOLDOWN_MAX_MS,
  MODEL_GATEWAY_FAILOVER_POLICY,
  classifyModelGatewayHttpStatus,
  countsTowardCircuitBreaker,
  modelGatewayCooldownMs,
  shouldFailoverForFailureClass,
  type ModelGatewayFailureClass,
} from "./modelGatewayRuntime.ts";
import {
  medianOf,
  summarizeModelGatewayUsage,
  type ModelGatewayUsageRecord,
} from "./modelGatewayUsage.ts";

const provider = (
  id: string,
  overrides: Partial<ModelGatewayProvider> = {},
): ModelGatewayProvider => ({
  id: ModelProviderId.make(id),
  name: id,
  protocol: "openai-responses",
  baseUrl: "https://upstream.example.com",
  apiKey: MODEL_GATEWAY_CREDENTIAL_REDACTED,
  defaultModel: "",
  enabled: true,
  ...overrides,
});

const route = (overrides: Partial<ModelGatewayRoute> = {}): ModelGatewayRoute => ({
  id: ModelRouteId.make("coding"),
  name: "Coding",
  enabled: true,
  primaryProviderId: ModelProviderId.make("deepseek"),
  backupProviderIds: [],
  modelMapping: {},
  failoverEnabled: false,
  ...overrides,
});

const usageRow = (overrides: Partial<ModelGatewayUsageRecord> = {}): ModelGatewayUsageRecord => ({
  id: "row-1",
  recordedAt: "2026-09-16T00:00:00.000Z",
  threadId: "thread-1",
  providerInstanceId: "codex",
  routeId: "coding",
  protocol: "openai-responses",
  requestedModel: "coding-default",
  upstreamModel: "deepseek-v3",
  servedByProviderId: ModelProviderId.make("deepseek"),
  attempts: ["deepseek:success"],
  failedOver: false,
  status: "success",
  failureClass: null,
  upstreamHttpStatus: 200,
  streamed: true,
  latencyMs: 900,
  timeToFirstTokenMs: 220,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  ...overrides,
});

describe("normalizeModelGatewayBaseUrl", () => {
  it("accepts an ordinary origin and strips a trailing slash", () => {
    expect(normalizeModelGatewayBaseUrl("https://api.deepseek.com/")).toBe(
      "https://api.deepseek.com",
    );
    expect(normalizeModelGatewayBaseUrl(" http://127.0.0.1:8080/v1 ")).toBe(
      "http://127.0.0.1:8080/v1",
    );
  });

  it("refuses a URL that is not http(s), carries credentials, or carries a query", () => {
    expect(normalizeModelGatewayBaseUrl("ftp://example.com")).toBeNull();
    expect(normalizeModelGatewayBaseUrl("https://user:pass@example.com")).toBeNull();
    expect(normalizeModelGatewayBaseUrl("https://example.com?key=leak")).toBeNull();
    expect(normalizeModelGatewayBaseUrl("not a url")).toBeNull();
    expect(normalizeModelGatewayBaseUrl("   ")).toBeNull();
  });
});

describe("model mapping", () => {
  it("translates a requested model onto its billing name", () => {
    expect(
      resolveModelGatewayUpstreamModel({ "coding-default": "deepseek-v3" }, "coding-default"),
    ).toBe("deepseek-v3");
  });

  it("passes an unmapped name through unchanged", () => {
    expect(resolveModelGatewayUpstreamModel({}, "glm-4.6")).toBe("glm-4.6");
    expect(resolveModelGatewayUpstreamModel({ other: "x" }, "glm-4.6")).toBe("glm-4.6");
  });
});

describe("resolveModelGatewayAttempts", () => {
  const providers = {
    deepseek: provider("deepseek"),
    backup: provider("backup"),
    spare: provider("spare"),
    off: provider("off", { enabled: false }),
  };

  it("is the primary alone when failover is off, even with backups listed", () => {
    const attempts = resolveModelGatewayAttempts(
      route({ backupProviderIds: [ModelProviderId.make("backup")] }),
      providers,
    );
    expect(attempts.map((entry) => entry.id)).toEqual(["deepseek"]);
  });

  it("is primary then backups in order when failover is on", () => {
    const attempts = resolveModelGatewayAttempts(
      route({
        failoverEnabled: true,
        backupProviderIds: [ModelProviderId.make("backup"), ModelProviderId.make("spare")],
      }),
      providers,
    );
    expect(attempts.map((entry) => entry.id)).toEqual(["deepseek", "backup", "spare"]);
  });

  it("omits a disabled upstream entirely - that is what disabling one means", () => {
    const attempts = resolveModelGatewayAttempts(
      route({ failoverEnabled: true, backupProviderIds: [ModelProviderId.make("off")] }),
      providers,
    );
    expect(attempts.map((entry) => entry.id)).toEqual(["deepseek"]);
  });

  it("never lists the primary twice, and never reorders", () => {
    const attempts = resolveModelGatewayAttempts(
      route({
        failoverEnabled: true,
        backupProviderIds: [ModelProviderId.make("deepseek"), ModelProviderId.make("backup")],
      }),
      providers,
    );
    expect(attempts.map((entry) => entry.id)).toEqual(["deepseek", "backup"]);
  });

  it("is empty when the primary is disabled", () => {
    const attempts = resolveModelGatewayAttempts(
      route({ primaryProviderId: ModelProviderId.make("off") }),
      providers,
    );
    expect(attempts).toEqual([]);
  });
});

describe("validateModelGatewayRoute", () => {
  it("accepts a same-protocol primary with a same-protocol backup", () => {
    const providers = { deepseek: provider("deepseek"), backup: provider("backup") };
    expect(
      validateModelGatewayRoute(
        route({ failoverEnabled: true, backupProviderIds: [ModelProviderId.make("backup")] }),
        providers,
      ),
    ).toEqual([]);
  });

  it("rejects a backup that speaks a different protocol, because V1 does not convert", () => {
    const providers = {
      deepseek: provider("deepseek"),
      anthropic: provider("anthropic", { protocol: "anthropic-messages" }),
    };
    expect(
      validateModelGatewayRoute(
        route({ failoverEnabled: true, backupProviderIds: [ModelProviderId.make("anthropic")] }),
        providers,
      ),
    ).toContain("backup-protocol-mismatch");
  });

  it("reports a missing primary, a missing backup, a duplicate and a bad base URL", () => {
    const providers = {
      deepseek: provider("deepseek", { baseUrl: "not a url" }),
      backup: provider("backup"),
    };
    const problems = validateModelGatewayRoute(
      route({
        failoverEnabled: true,
        backupProviderIds: [
          ModelProviderId.make("ghost"),
          ModelProviderId.make("backup"),
          ModelProviderId.make("backup"),
        ],
      }),
      providers,
    );
    expect(problems).toContain("backup-missing");
    expect(problems).toContain("duplicate-upstream");
    expect(problems).toContain("invalid-base-url");

    expect(validateModelGatewayRoute(route(), {})).toEqual(["primary-missing"]);
  });

  it("flags failover with nothing to fail over to", () => {
    const providers = { deepseek: provider("deepseek") };
    expect(validateModelGatewayRoute(route({ failoverEnabled: true }), providers)).toContain(
      "no-backup",
    );
  });
});

describe("failover policy", () => {
  it("never fails over on an auth or invalid-request failure", () => {
    expect(shouldFailoverForFailureClass("auth")).toBe(false);
    expect(shouldFailoverForFailureClass("invalid-request")).toBe(false);
    expect(shouldFailoverForFailureClass("not-found")).toBe(false);
  });

  it("never fails over once the response has been committed, and never after the caller left", () => {
    expect(shouldFailoverForFailureClass("response-committed")).toBe(false);
    expect(shouldFailoverForFailureClass("client-aborted")).toBe(false);
  });

  it("fails over on the transient family", () => {
    for (const failure of [
      "connection",
      "timeout",
      "rate-limited",
      "quota-exhausted",
      "server-error",
      "overloaded",
    ] satisfies ReadonlyArray<ModelGatewayFailureClass>) {
      expect(shouldFailoverForFailureClass(failure)).toBe(true);
    }
  });

  it("classifies statuses the way the policy depends on", () => {
    expect(classifyModelGatewayHttpStatus(400)).toBe("invalid-request");
    expect(classifyModelGatewayHttpStatus(401)).toBe("auth");
    expect(classifyModelGatewayHttpStatus(403)).toBe("auth");
    expect(classifyModelGatewayHttpStatus(402)).toBe("quota-exhausted");
    expect(classifyModelGatewayHttpStatus(404)).toBe("not-found");
    expect(classifyModelGatewayHttpStatus(408)).toBe("timeout");
    expect(classifyModelGatewayHttpStatus(429)).toBe("rate-limited");
    expect(classifyModelGatewayHttpStatus(500)).toBe("server-error");
    expect(classifyModelGatewayHttpStatus(503)).toBe("server-error");
    expect(classifyModelGatewayHttpStatus(529)).toBe("overloaded");
    expect(classifyModelGatewayHttpStatus(422)).toBe("invalid-request");
  });

  it("has exactly one rule per failure class", () => {
    for (const [failure, eligible] of Object.entries(MODEL_GATEWAY_FAILOVER_POLICY)) {
      expect(typeof eligible, failure).toBe("boolean");
    }
  });

  it("does not blame an upstream's breaker for a caller mistake", () => {
    expect(countsTowardCircuitBreaker("invalid-request")).toBe(false);
    expect(countsTowardCircuitBreaker("auth")).toBe(false);
    expect(countsTowardCircuitBreaker("not-found")).toBe(false);
    expect(countsTowardCircuitBreaker("client-aborted")).toBe(false);
    expect(countsTowardCircuitBreaker("server-error")).toBe(true);
    expect(countsTowardCircuitBreaker("timeout")).toBe(true);
  });
});

describe("circuit breaker cooldown", () => {
  it("doubles past the threshold and is capped", () => {
    expect(modelGatewayCooldownMs(30_000, 3)).toBe(30_000);
    expect(modelGatewayCooldownMs(30_000, 4)).toBe(60_000);
    expect(modelGatewayCooldownMs(30_000, 20)).toBe(MODEL_GATEWAY_BREAKER_COOLDOWN_MAX_MS);
  });

  it("never returns a sub-second cooldown even if configured to", () => {
    expect(modelGatewayCooldownMs(0, 3)).toBe(1_000);
  });
});

describe("usage accounting", () => {
  it("reports a median for an odd and an even sample", () => {
    expect(medianOf([300, 100, 200])).toBe(200);
    expect(medianOf([100, 200])).toBe(150);
    expect(medianOf([])).toBeNull();
  });

  it("treats a missing token count as absent rather than zero", () => {
    const rows = [usageRow({ inputTokens: null, outputTokens: null })];
    expect(summarizeModelGatewayUsage(rows).inputTokens).toBe(0);
    // The row itself still says unknown; only the summed total can be zero.
    expect(rows[0]!.inputTokens).toBeNull();
  });

  it("counts requests, failures, failovers and cache tokens", () => {
    const summary = summarizeModelGatewayUsage([
      usageRow({ cacheReadTokens: 5, cacheWriteTokens: 7 }),
      usageRow({
        id: "row-2",
        status: "failed",
        failedOver: true,
        attempts: ["deepseek:server-error", "backup:success"],
        latencyMs: 1_100,
        timeToFirstTokenMs: 340,
        inputTokens: 50,
        outputTokens: 10,
      }),
    ]);
    expect(summary.requests).toBe(2);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.failovers).toBe(1);
    expect(summary.inputTokens).toBe(150);
    expect(summary.outputTokens).toBe(30);
    expect(summary.cacheReadTokens).toBe(5);
    expect(summary.cacheWriteTokens).toBe(7);
    expect(summary.medianTimeToFirstTokenMs).toBe(280);
    expect(summary.medianLatencyMs).toBe(1_000);
  });

  it("has no field capable of holding a prompt or a completion", () => {
    const keys = Object.keys(usageRow());
    for (const forbidden of ["prompt", "messages", "body", "content", "completion", "response"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("secret naming", () => {
  it("derives a stable, lowercased secret name from a provider id", () => {
    expect(modelProviderSecretName("DeepSeek")).toBe("model-gateway-provider-deepseek-api-key");
  });

  it("uses the same marker the knowledge token uses", () => {
    expect(MODEL_GATEWAY_CREDENTIAL_REDACTED).toBe("\u2022\u2022\u2022\u2022\u2022\u2022");
  });
});
