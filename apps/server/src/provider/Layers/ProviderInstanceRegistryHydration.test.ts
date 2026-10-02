import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

describe("deriveProviderInstanceConfigMap", () => {
  it("exposes first-party ACP harnesses as honest disabled defaults", () => {
    const config = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);
    const qwen = config[ProviderInstanceId.make("qwenAcp")];
    const kimi = config[ProviderInstanceId.make("kimiAcp")];
    const deepseek = config[ProviderInstanceId.make("deepseekAcp")];

    assert.strictEqual(qwen?.driver, "qwenAcp");
    assert.strictEqual(qwen?.enabled, false);
    assert.deepStrictEqual(qwen?.config, {
      command: "qwen",
      args: ["--acp"],
      capabilityOverrides: {},
    });
    assert.strictEqual(kimi?.driver, "kimiAcp");
    assert.strictEqual(kimi?.enabled, false);
    assert.deepStrictEqual(kimi?.config, {
      command: "kimi",
      args: ["acp"],
      capabilityOverrides: {},
    });
    assert.strictEqual(deepseek?.driver, "deepseekAcp");
    assert.strictEqual(deepseek?.enabled, false);
    assert.deepStrictEqual(deepseek?.config, {
      command: "dsh",
      args: ["--profile", "acp"],
      capabilityOverrides: {},
    });
    assert.strictEqual(config[ProviderInstanceId.make("genericAcp")], undefined);
  });

  it("keeps an explicit first-party ACP configuration", () => {
    const config = deriveProviderInstanceConfigMap({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        ...DEFAULT_SERVER_SETTINGS.providerInstances,
        [ProviderInstanceId.make("qwenAcp")]: {
          driver: ProviderDriverKind.make("qwenAcp"),
          enabled: true,
          config: { command: "qwen", args: ["--acp", "--verbose"] },
        },
      },
    });

    assert.strictEqual(config[ProviderInstanceId.make("qwenAcp")]?.enabled, true);
    const qwen = config[ProviderInstanceId.make("qwenAcp")];
    assert.deepStrictEqual(qwen?.config, {
      command: "qwen",
      args: ["--acp", "--verbose"],
    });
  });
});
