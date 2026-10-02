import {
  MODEL_GATEWAY_DIAGNOSTIC_MESSAGES,
  MODEL_GATEWAY_ROUTE_PROBLEM_MESSAGES,
  type ModelGatewayProvider,
  type ModelGatewayProviderHealth,
  type ModelGatewayRoute,
  type ModelGatewayStatus,
  type ModelGatewayUsageGroup,
  type ModelGatewayUsageSummary,
  type UsageModelPriceOverride,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  appendModelGatewayBackup,
  blankModelGatewayProvider,
  blankModelGatewayRoute,
  estimateModelGatewayUsageCostUsd,
  formatModelGatewayCostUsd,
  formatModelGatewayCount,
  formatModelGatewayLatency,
  formatModelGatewayPercent,
  mergeModelGatewayRouteProblems,
  modelGatewayProviderChoices,
  modelGatewayProviderHasCredential,
  modelGatewayProviderHealthText,
  modelGatewayProtocolChoices,
  modelGatewayProtocolLabel,
  modelGatewayRouteChoices,
  modelGatewayRouteDisplay,
  modelGatewayRouteIdFromSelectValue,
  modelGatewayRouteProblemMessages,
  modelGatewayRouteSelectValue,
  modelGatewayRouteStatusText,
  modelGatewaySettingsPatch,
  modelGatewaySuccessRate,
  modelGatewayUsageDimensionLabel,
  modelGatewayUsageGroupLabel,
  modelGatewayUsageSummaryRows,
  moveModelGatewayEntry,
  readModelGatewaySettings,
  resolveModelGatewayDisplay,
  uniqueModelGatewayId,
} from "./modelGatewaySettings.logic";

const provider = (overrides: Partial<ModelGatewayProvider> = {}): ModelGatewayProvider => ({
  id: "primary" as ModelGatewayProvider["id"],
  name: "Primary" as ModelGatewayProvider["name"],
  protocol: "openai-chat",
  baseUrl: "https://api.example.com/v1",
  apiKey: "",
  defaultModel: "",
  enabled: true,
  ...overrides,
});

const route = (overrides: Partial<ModelGatewayRoute> = {}): ModelGatewayRoute => ({
  id: "default" as ModelGatewayRoute["id"],
  name: "Default" as ModelGatewayRoute["name"],
  enabled: true,
  primaryProviderId: "primary" as ModelGatewayRoute["primaryProviderId"],
  backupProviderIds: [],
  modelMapping: {},
  failoverEnabled: true,
  ...overrides,
});

const summary = (overrides: Partial<ModelGatewayUsageSummary> = {}): ModelGatewayUsageSummary => ({
  requests: 0,
  succeeded: 0,
  failed: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  failovers: 0,
  medianTimeToFirstTokenMs: null,
  medianLatencyMs: null,
  ...overrides,
});

const status = (overrides: Partial<ModelGatewayStatus> = {}): ModelGatewayStatus => ({
  lifecycle: "ready",
  diagnostic: "ready",
  enabled: true,
  endpoint: "http://127.0.0.1:51234",
  providers: [],
  routes: [],
  health: [],
  ...overrides,
});

const health = (
  overrides: Partial<ModelGatewayProviderHealth> = {},
): ModelGatewayProviderHealth => ({
  providerId: "primary" as ModelGatewayProviderHealth["providerId"],
  state: "healthy",
  consecutiveFailures: 0,
  coolingUntilMs: null,
  lastFailureClass: null,
  ...overrides,
});

describe("readModelGatewaySettings", () => {
  it("reads the gateway slice of a settings object", () => {
    const settings = readModelGatewaySettings({
      modelGateway: { enabled: true, usageRetentionDays: 7 },
    });
    expect(settings.enabled).toBe(true);
    expect(settings.usageRetentionDays).toBe(7);
  });

  it("fills every field's default for a sparse or missing slice", () => {
    const settings = readModelGatewaySettings({});
    expect(settings.enabled).toBe(false);
    expect(settings.providers).toEqual({});
    expect(settings.routes).toEqual({});
  });

  it("falls back to the defaults when the stored value is unreadable", () => {
    expect(readModelGatewaySettings({ modelGateway: "nonsense" }).enabled).toBe(false);
    expect(
      readModelGatewaySettings({ modelGateway: { routes: { broken: { id: "!!" } } } }).routes,
    ).toEqual({});
  });

  it("wraps a patch in the settings key the update path expects", () => {
    expect(modelGatewaySettingsPatch({ enabled: true })).toEqual({
      modelGateway: { enabled: true },
    });
  });
});

describe("modelGatewayProtocolLabel", () => {
  it("names every configured protocol", () => {
    expect(modelGatewayProtocolChoices().map((choice) => choice.label)).toEqual([
      "OpenAI Chat Completions",
      "OpenAI Responses",
      "Anthropic Messages",
    ]);
    expect(modelGatewayProtocolLabel("anthropic-messages")).toBe("Anthropic Messages");
  });

  it("shows an unknown protocol id as itself rather than as blank", () => {
    expect(modelGatewayProtocolLabel("gemini-generate")).toBe("gemini-generate");
  });
});

describe("resolveModelGatewayDisplay", () => {
  it("reports the gateway's own diagnostic and lifecycle", () => {
    const display = resolveModelGatewayDisplay({
      status: status({ lifecycle: "ready", diagnostic: "ready" }),
      isPending: false,
      isError: false,
    });
    expect(display.diagnostic).toBe("ready");
    expect(display.message).toBe(MODEL_GATEWAY_DIAGNOSTIC_MESSAGES.ready);
    expect(display.lifecycleLabel).toBe("Running");
    expect(display.running).toBe(true);
    expect(display.endpoint).toBe("http://127.0.0.1:51234");
  });

  it("keeps a known state on screen while the next read is in flight", () => {
    const display = resolveModelGatewayDisplay({
      status: status({ lifecycle: "stopped", diagnostic: "disabled" }),
      isPending: true,
      isError: false,
    });
    expect(display.diagnostic).toBe("disabled");
    expect(display.running).toBe(false);
  });

  it("does not claim a diagnostic it was never given", () => {
    expect(
      resolveModelGatewayDisplay({ status: null, isPending: true, isError: false }),
    ).toMatchObject({ diagnostic: null, lifecycleLabel: "Reading" });
    expect(
      resolveModelGatewayDisplay({ status: null, isPending: false, isError: true }).message,
    ).toMatch(/did not answer/);
  });
});

describe("modelGatewayProviderHealthText", () => {
  it("counts a breaker's cooldown down from a supplied clock", () => {
    expect(
      modelGatewayProviderHealthText(
        health({ state: "cooling", coolingUntilMs: 30_000, lastFailureClass: "rate-limited" }),
        5_000,
      ),
    ).toBe("Cooling down for another 25s (The upstream is rate limiting this key.)");
  });

  it("never counts a cooldown below zero", () => {
    expect(
      modelGatewayProviderHealthText(health({ state: "cooling", coolingUntilMs: 1_000 }), 9_000),
    ).toBe("Cooling down for another 0s");
  });

  it("names the other two states and an absent report", () => {
    expect(modelGatewayProviderHealthText(health(), 0)).toBe("Healthy");
    expect(modelGatewayProviderHealthText(health({ consecutiveFailures: 2 }), 0)).toBe(
      "Healthy; 2 recent failures",
    );
    expect(modelGatewayProviderHealthText(health({ state: "disabled" }), 0)).toBe("Disabled");
    expect(modelGatewayProviderHealthText(null, 0)).toBeNull();
  });
});

describe("route problems", () => {
  it("keeps the order of the client's problems and ignores unknown server ones", () => {
    expect(
      mergeModelGatewayRouteProblems(
        ["no-backup"],
        ["not-a-problem", "primary-disabled", "no-backup"],
      ),
    ).toEqual(["no-backup", "primary-disabled"]);
  });

  it("renders every problem through the contract's copy", () => {
    expect(
      modelGatewayRouteProblemMessages(["backup-protocol-mismatch", "invalid-base-url"]),
    ).toEqual([
      MODEL_GATEWAY_ROUTE_PROBLEM_MESSAGES["backup-protocol-mismatch"],
      MODEL_GATEWAY_ROUTE_PROBLEM_MESSAGES["invalid-base-url"],
    ]);
  });

  it("flags a route whose backups disagree about protocol", () => {
    const providers = {
      primary: provider(),
      backup: provider({
        id: "backup" as ModelGatewayProvider["id"],
        name: "Backup" as ModelGatewayProvider["name"],
        protocol: "anthropic-messages",
      }),
    };
    const display = modelGatewayRouteDisplay(
      route({ backupProviderIds: ["backup" as ModelGatewayRoute["backupProviderIds"][number]] }),
      providers,
    );
    expect(display.flagged).toBe(true);
    expect(display.problems).toEqual(["backup-protocol-mismatch"]);
    expect(display.problemMessages).toEqual([
      MODEL_GATEWAY_ROUTE_PROBLEM_MESSAGES["backup-protocol-mismatch"],
    ]);
    expect(display.attemptChain).toBe("Primary -> Backup");
  });

  it("does not flag a healthy route and names its attempt chain", () => {
    const providers = {
      primary: provider(),
      backup: provider({
        id: "backup" as ModelGatewayProvider["id"],
        name: "Backup" as ModelGatewayProvider["name"],
      }),
    };
    const display = modelGatewayRouteDisplay(
      route({ backupProviderIds: ["backup" as ModelGatewayRoute["backupProviderIds"][number]] }),
      providers,
    );
    expect(display.flagged).toBe(false);
    expect(display.attemptChain).toBe("Primary -> Backup");
  });

  it("truncates the chain to the primary when failover is off, without flagging it", () => {
    const providers = {
      primary: provider(),
      backup: provider({ id: "backup" as ModelGatewayProvider["id"] }),
    };
    const display = modelGatewayRouteDisplay(
      route({
        failoverEnabled: false,
        backupProviderIds: ["backup" as ModelGatewayRoute["backupProviderIds"][number]],
      }),
      providers,
    );
    expect(display.attemptChain).toBe("Primary");
    // Failover off is a deliberate choice, not a problem: a single upstream route
    // is exactly what it asks for.
    expect(display.problems).toEqual([]);
  });

  it("says outright when no upstream is usable", () => {
    const display = modelGatewayRouteDisplay(route(), { primary: provider({ enabled: false }) });
    expect(display.attemptChain).toBe("No enabled upstream to send requests to.");
    expect(display.flagged).toBe(true);
  });
});

describe("provider and route editing helpers", () => {
  it("offers every provider with its protocol label", () => {
    expect(modelGatewayProviderChoices({ primary: provider() })).toEqual([
      { id: "primary", name: "Primary", protocolLabel: "OpenAI Chat Completions", enabled: true },
    ]);
  });

  it("moves an entry one step and refuses to move past either end", () => {
    expect(moveModelGatewayEntry(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveModelGatewayEntry(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveModelGatewayEntry(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });

  it("appends only a provider the route does not already use", () => {
    const providers = {
      primary: provider(),
      backup: provider({ id: "backup" as ModelGatewayProvider["id"] }),
    };
    expect(appendModelGatewayBackup([], providers, "primary")).toEqual(["backup"]);
    expect(appendModelGatewayBackup(["backup"], providers, "primary")).toEqual(["backup"]);
  });

  it("generates a slug id that is not already taken", () => {
    expect(uniqueModelGatewayId("provider", [])).toBe("provider-1");
    expect(uniqueModelGatewayId("provider", ["provider-1", "provider-2"])).toBe("provider-3");
  });

  it("creates a blank provider and route the contract accepts", () => {
    expect(blankModelGatewayProvider("provider-1")).toMatchObject({
      id: "provider-1",
      protocol: "openai-chat",
      enabled: true,
      apiKey: "",
    });
    expect(blankModelGatewayRoute("route-1", "provider-1")).toMatchObject({
      id: "route-1",
      primaryProviderId: "provider-1",
      backupProviderIds: [],
      failoverEnabled: true,
    });
  });

  it("trusts the gateway over the file about whether a key is stored", () => {
    const stored = provider({ apiKey: "\u2022\u2022\u2022\u2022\u2022\u2022" });
    expect(modelGatewayProviderHasCredential(stored, null)).toBe(true);
    expect(modelGatewayProviderHasCredential(provider(), null)).toBe(false);
    expect(
      modelGatewayProviderHasCredential(
        stored,
        status({
          providers: [
            {
              id: "primary" as ModelGatewayStatus["providers"][number]["id"],
              name: "Primary",
              protocol: "openai-chat",
              enabled: true,
              hasCredential: false,
            },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("formatting", () => {
  it("groups counts in thousands", () => {
    expect(formatModelGatewayCount(0)).toBe("0");
    expect(formatModelGatewayCount(1_234)).toBe("1,234");
    expect(formatModelGatewayCount(12_345_678)).toBe("12,345,678");
    expect(formatModelGatewayCount(Number.NaN)).toBe("-");
  });

  it("renders latency in the unit that reads best", () => {
    expect(formatModelGatewayLatency(240)).toBe("240 ms");
    expect(formatModelGatewayLatency(1_500)).toBe("1.5 s");
    expect(formatModelGatewayLatency(null)).toBe("-");
  });

  it("reports no success rate rather than a fake zero", () => {
    expect(modelGatewaySuccessRate(summary())).toBeNull();
    expect(modelGatewaySuccessRate(summary({ requests: 4, succeeded: 3 }))).toBe(0.75);
    expect(formatModelGatewayPercent(null)).toBe("-");
    expect(formatModelGatewayPercent(0.975)).toBe("97.5%");
  });

  it("shows a sub-cent cost as a bound instead of as zero", () => {
    expect(formatModelGatewayCostUsd(0.004)).toBe("<$0.01");
    expect(formatModelGatewayCostUsd(1.239)).toBe("$1.24");
    expect(formatModelGatewayCostUsd(0)).toBe("$0.00");
  });

  it("builds the totals rows the panel renders", () => {
    const rows = modelGatewayUsageSummaryRows(
      summary({
        requests: 10,
        succeeded: 9,
        failovers: 2,
        inputTokens: 1_500,
        outputTokens: 500,
        medianLatencyMs: 900,
      }),
    );
    expect(rows.map((row) => row.label)).toEqual([
      "Requests",
      "Tokens",
      "Success rate",
      "Failovers",
      "Median latency",
    ]);
    expect(rows[1]!.value).toBe("1,500 in / 500 out");
    expect(rows[2]!.value).toBe("90.0% of 10");
    expect(rows[4]!.value).toBe("900 ms");
  });
});

describe("usage grouping", () => {
  const groups: ReadonlyArray<ModelGatewayUsageGroup> = [
    {
      key: "deepseek-chat",
      summary: summary({ requests: 2, inputTokens: 1_000_000, outputTokens: 500_000 }),
    },
    { key: "unpriced-model", summary: summary({ requests: 1, inputTokens: 1_000_000 }) },
  ];
  const prices: Readonly<Record<string, UsageModelPriceOverride>> = {
    "deepseek-chat": { inputCostPerMillionTokens: 0.5, outputCostPerMillionTokens: 1.5 },
  };

  it("labels a group by its configured name, falling back to the key", () => {
    expect(
      modelGatewayUsageGroupLabel({
        dimension: "provider",
        key: "primary",
        providerNames: { primary: "Primary" },
        routeNames: {},
      }),
    ).toBe("Primary");
    expect(
      modelGatewayUsageGroupLabel({
        dimension: "route",
        key: "gone",
        providerNames: {},
        routeNames: {},
      }),
    ).toBe("gone");
    expect(
      modelGatewayUsageGroupLabel({
        dimension: "protocol",
        key: "anthropic-messages",
        providerNames: {},
        routeNames: {},
      }),
    ).toBe("Anthropic Messages");
    expect(modelGatewayUsageDimensionLabel("model")).toBe("Model");
  });

  it("prices a model group from the environment's own overrides", () => {
    const estimate = estimateModelGatewayUsageCostUsd({
      groups,
      dimension: "model",
      priceOverrides: prices,
    });
    expect(estimate).toEqual({ usd: 1.25, pricedGroups: 1, totalGroups: 2 });
  });

  it("falls back to the input rate for cache tokens", () => {
    const estimate = estimateModelGatewayUsageCostUsd({
      groups: [{ key: "m", summary: summary({ cacheReadTokens: 2_000_000 }) }],
      dimension: "model",
      priceOverrides: { m: { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2 } },
    });
    expect(estimate?.usd).toBe(2);
  });

  it("refuses to estimate a cost it cannot compute", () => {
    expect(
      estimateModelGatewayUsageCostUsd({ groups, dimension: "route", priceOverrides: prices }),
    ).toBeNull();
    expect(
      estimateModelGatewayUsageCostUsd({ groups, dimension: "model", priceOverrides: {} }),
    ).toBeNull();
  });
});

describe("provider-instance route selection", () => {
  it("round-trips the stored route id through the picker's native value", () => {
    expect(modelGatewayRouteSelectValue(undefined)).toBe("native");
    expect(modelGatewayRouteSelectValue("  ")).toBe("native");
    expect(modelGatewayRouteSelectValue("default")).toBe("default");
    expect(modelGatewayRouteIdFromSelectValue("native")).toBeUndefined();
    expect(modelGatewayRouteIdFromSelectValue("default")).toBe("default");
  });

  it("stays unavailable, with a reason, while no route can be chosen", () => {
    expect(modelGatewayRouteChoices({ enabled: false, routes: [] })).toMatchObject({
      available: false,
      message:
        "The model gateway is off. Turn it on in Settings -> Model Gateway to route this harness.",
    });
    expect(modelGatewayRouteChoices({ enabled: true, routes: [] }).message).toMatch(
      /No gateway routes are configured/,
    );
  });

  it("offers every configured route once one exists", () => {
    const choices = modelGatewayRouteChoices({
      enabled: true,
      routes: [{ id: "default", name: "Default" }],
    });
    expect(choices.available).toBe(true);
    expect(choices.message).toBe("");
    expect(choices.options).toEqual([{ value: "default", label: "Default", disabled: false }]);
  });

  it("excludes a switched-off route from the choices", () => {
    const choices = modelGatewayRouteChoices({
      enabled: true,
      routes: [
        { id: "on", name: "On" },
        { id: "off", name: "Off", enabled: false },
      ],
    });
    expect(choices.available).toBe(true);
    expect(choices.options).toEqual([{ value: "on", label: "On", disabled: false }]);
  });

  it("keeps the selected route visible and unselectable after it is switched off", () => {
    const choices = modelGatewayRouteChoices({
      enabled: true,
      routes: [{ id: "off", name: "Off", enabled: false }],
      selectedRouteId: "off",
    });
    expect(choices.options).toEqual([
      { value: "off", label: "Off (switched off)", disabled: true },
    ]);
    // Still usable, so the way back to Native is not closed off.
    expect(choices.available).toBe(true);
  });

  it("does not resurrect a switched-off route this harness does not name", () => {
    const choices = modelGatewayRouteChoices({
      enabled: true,
      routes: [{ id: "off", name: "Off", enabled: false }],
      selectedRouteId: "elsewhere",
    });
    expect(choices.options).toEqual([]);
    expect(choices.available).toBe(false);
    expect(choices.message).toMatch(/Every gateway route is switched off/);
  });

  it("says a route is off instead of naming the chain it would try", () => {
    expect(modelGatewayRouteStatusText(route())).toBeNull();
    expect(modelGatewayRouteStatusText(route({ enabled: false }))).toMatch(/switched off/);
  });

  it("does not present a switched-off route as broken", () => {
    const providers = { primary: provider() };
    // A backup that no longer exists is a real problem for a route that runs...
    const broken = route({
      backupProviderIds: ["gone" as ModelGatewayRoute["backupProviderIds"][number]],
    });
    expect(modelGatewayRouteDisplay(broken, providers).flagged).toBe(true);
    // ...and not something to warn about on a route the user retired, even
    // though the gateway reports route problems regardless of the switch.
    const retired = modelGatewayRouteDisplay({ ...broken, enabled: false }, providers, [
      "no-backup",
    ]);
    expect(retired.flagged).toBe(false);
    expect(retired.problems.length).toBeGreaterThan(0);
  });
});
