import { describe, expect, it } from "vite-plus/test";

import { translate } from "./i18n";

describe("translate", () => {
  it("returns English unchanged", () => {
    expect(translate("en", "Settings")).toBe("Settings");
  });

  it("uses the Simplified Chinese catalog", () => {
    expect(translate("zh-CN", "Settings")).toBe("设置");
  });

  it("falls back to English for missing catalog entries", () => {
    expect(translate("zh-CN", "Provider-specific value")).toBe("Provider-specific value");
  });

  it("interpolates values after translation", () => {
    expect(translate("zh-CN", "{environment} is reconnecting", { environment: "Ying" })).toBe(
      "Ying 正在重新连接",
    );
  });

  it("translates the draft surface and CLI switch labels", () => {
    expect(translate("zh-CN", "Enable a provider in Settings to send a message")).toBe(
      "请在设置中启用提供商后发送消息",
    );
    expect(translate("zh-CN", "Switch CLI")).toBe("切换 CLI");
  });
});
