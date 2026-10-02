import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { GenericAcpSettings } from "@t3tools/contracts";

import {
  DeepSeekAcpDriver,
  GENERIC_ACP_PRESETS,
  KimiAcpDriver,
  QwenAcpDriver,
} from "./GenericAcpDriver.ts";

const decode = Schema.decodeSync(GenericAcpSettings);

describe("Generic ACP presets", () => {
  it("maps Qwen Code to qwen --acp", () => {
    expect(GENERIC_ACP_PRESETS.qwen).toMatchObject({ command: "qwen", args: ["--acp"] });
    expect(QwenAcpDriver.defaultConfig()).toEqual(decode({ command: "qwen", args: ["--acp"] }));
  });

  it("maps Kimi Code to kimi acp", () => {
    expect(GENERIC_ACP_PRESETS.kimi).toMatchObject({ command: "kimi", args: ["acp"] });
    expect(KimiAcpDriver.defaultConfig()).toEqual(decode({ command: "kimi", args: ["acp"] }));
  });

  it("maps DeepSeek Harness to dsh --profile acp", () => {
    expect(GENERIC_ACP_PRESETS.deepseek).toMatchObject({
      command: "dsh",
      args: ["--profile", "acp"],
    });
    expect(DeepSeekAcpDriver.defaultConfig()).toEqual(
      decode({ command: "dsh", args: ["--profile", "acp"] }),
    );
  });

  it("keeps every preset on the same generic driver implementation", () => {
    expect(QwenAcpDriver.configSchema).toBe(KimiAcpDriver.configSchema);
    expect(KimiAcpDriver.configSchema).toBe(DeepSeekAcpDriver.configSchema);
  });
});
