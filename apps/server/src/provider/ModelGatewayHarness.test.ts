import {
  DEFAULT_SERVER_SETTINGS,
  MODEL_GATEWAY_DIAGNOSTIC_MESSAGES,
  ModelRouteId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  MODEL_GATEWAY_HARNESS_PROTOCOLS,
  modelGatewayHarnessProtocol,
  resolveModelGatewayHarness,
  resolveModelGatewayRouteId,
} from "./ModelGatewayHarness.ts";

const instanceId = ProviderInstanceId.make("codex_work");
const routeId = ModelRouteId.make("coding-default");

/** One enabled `openai-responses` route, plus an optional second one. */
const settingsWithRoutes = (routes: Readonly<Record<string, boolean>>) => {
  const entries: Record<string, unknown> = {};
  for (const [id, enabled] of Object.entries(routes)) {
    entries[id] = {
      id,
      name: id,
      enabled,
      primaryProviderId: "primary",
      backupProviderIds: [],
      modelMapping: {},
      failoverEnabled: false,
    };
  }
  return {
    ...DEFAULT_SERVER_SETTINGS,
    modelGateway: {
      ...DEFAULT_SERVER_SETTINGS.modelGateway,
      routes: entries,
    },
  } as ServerSettings;
};

const settingsWith = (input: {
  readonly driver: string;
  readonly routeId?: string;
  readonly enabled?: boolean;
  readonly routes?: Readonly<Record<string, boolean>>;
}): ServerSettings => ({
  ...settingsWithRoutes(input.routes ?? {}),
  providerInstances: {
    [instanceId]: {
      driver: ProviderDriverKind.make(input.driver),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.routeId === undefined ? {} : { modelGatewayRouteId: input.routeId }),
    },
  },
});

const resolve = (settings: ServerSettings) =>
  resolveModelGatewayHarness({ settings, providerInstanceId: instanceId });

describe("modelGatewayHarnessProtocol", () => {
  it("carries only the two harnesses the gateway can be pointed at", () => {
    expect(MODEL_GATEWAY_HARNESS_PROTOCOLS).toEqual({
      codex: "openai-responses",
      claudeAgent: "anthropic-messages",
    });
    expect(modelGatewayHarnessProtocol(ProviderDriverKind.make("codex"))).toBe("openai-responses");
    expect(modelGatewayHarnessProtocol(ProviderDriverKind.make("claudeAgent"))).toBe(
      "anthropic-messages",
    );
  });

  it("does not invent an environment variable for a driver the harness cannot be pointed at", () => {
    for (const driver of ["cursor", "grok", "antigravity", "opencode", "genericAcp"]) {
      expect(modelGatewayHarnessProtocol(ProviderDriverKind.make(driver))).toBeUndefined();
    }
  });
});

describe("resolveModelGatewayHarness", () => {
  it("names the route a configured instance points at", () => {
    const resolution = resolve(
      settingsWith({
        driver: "codex",
        routeId: "coding-default",
        routes: { "coding-default": true },
      }),
    );
    expect(resolution.selection).toEqual({
      providerInstanceId: instanceId,
      driverKind: "codex",
      gatewayRouteId: "coding-default",
    });
    expect(resolution.reason).toBeUndefined();
  });

  it("leaves an instance with no route entirely alone, with no reason reported", () => {
    const settings = settingsWith({ driver: "codex" });
    const resolution = resolve(settings);
    expect(resolution.selection).toBeUndefined();
    // A Native choice is not a problem, so it is reported as nothing at all.
    expect(resolution.reason).toBeUndefined();
    expect(resolveModelGatewayRouteId(settings, instanceId)).toBeUndefined();
    expect(
      resolveModelGatewayRouteId(settings, ProviderInstanceId.make("never-configured")),
    ).toBeUndefined();
  });

  it("leaves an explicitly disabled instance alone even when it names a route", () => {
    const resolution = resolve(
      settingsWith({
        driver: "codex",
        routeId: "coding-default",
        enabled: false,
        routes: { "coding-default": true },
      }),
    );
    expect(resolution.selection).toBeUndefined();
    expect(resolution.reason).toBeUndefined();
  });

  it("leaves an unsupported driver alone even when it names an enabled route", () => {
    const resolution = resolve(
      settingsWith({
        driver: "cursor",
        routeId: "coding-default",
        routes: { "coding-default": true },
      }),
    );
    expect(resolution.selection).toBeUndefined();
    // Driver support is the gateway's rule to state, not a second opinion here.
    expect(resolution.reason).toBeUndefined();
  });

  it("reports route-not-found when the named route does not exist", () => {
    const resolution = resolve(settingsWith({ driver: "codex", routeId: "coding-default" }));
    expect(resolution.selection).toBeUndefined();
    expect(resolution.reason).toBe("route-not-found");
  });

  it("reports route-disabled when the named route is switched off", () => {
    const resolution = resolve(
      settingsWith({
        driver: "codex",
        routeId: "coding-default",
        routes: { "coding-default": false },
      }),
    );
    expect(resolution.selection).toBeUndefined();
    expect(resolution.reason).toBe("route-disabled");
    // The copy the user sees is the contract's, not a second wording written here.
    expect(MODEL_GATEWAY_DIAGNOSTIC_MESSAGES[resolution.reason!]).toBe(
      MODEL_GATEWAY_DIAGNOSTIC_MESSAGES["route-disabled"],
    );
  });

  it("refuses a disabled route even when another route is enabled, and never re-selects", () => {
    const resolution = resolve(
      settingsWith({
        driver: "codex",
        routeId: "switched-off",
        routes: { "switched-off": false, "still-on": true },
      }),
    );
    // Not "still-on", not the first enabled route, not anything but a refusal.
    expect(resolution.selection).toBeUndefined();
    expect(resolution.reason).toBe("route-disabled");
  });

  it("reports route-not-found rather than falling back to an existing route", () => {
    const resolution = resolve(
      settingsWith({
        driver: "codex",
        routeId: "deleted-route",
        routes: { "still-here": true },
      }),
    );
    expect(resolution.selection).toBeUndefined();
    expect(resolution.reason).toBe("route-not-found");
  });

  it("treats an empty route id as no route rather than as a route named by the empty string", () => {
    const resolution = resolve(
      settingsWith({ driver: "claudeAgent", routeId: "", routes: { [routeId]: true } }),
    );
    expect(resolution.selection).toBeUndefined();
    expect(resolution.reason).toBeUndefined();
  });

  it("carries a claudeAgent instance on the anthropic protocol", () => {
    const resolution = resolve(
      settingsWith({
        driver: "claudeAgent",
        routeId: "coding-default",
        routes: { "coding-default": true },
      }),
    );
    expect(resolution.selection?.driverKind).toBe("claudeAgent");
  });
});
