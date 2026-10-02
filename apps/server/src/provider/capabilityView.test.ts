import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { normalizeHarnessCapabilityView } from "./capabilityView.ts";

describe("normalizeHarnessCapabilityView", () => {
  it("normalizes reported capabilities and applies explicit overrides", () => {
    expect(
      normalizeHarnessCapabilityView({
        providerInstanceId: ProviderInstanceId.make("qwen-acp"),
        available: true,
        reported: {
          nativeSessionResume: true,
          mcpServers: true,
          filesystemRead: true,
          filesystemWrite: false,
        },
        overrides: {
          supportsMcpServers: false,
          fsWriteTextFile: true,
          terminal: false,
        },
      }),
    ).toEqual({
      providerInstanceId: "qwen-acp",
      available: true,
      nativeSessionResume: "supported",
      mcpServers: "unsupported",
      filesystemRead: "supported",
      filesystemWrite: "supported",
      terminal: "unsupported",
      // Reachable host tools are derived from the live session, so an unreported
      // value stays unknown rather than claiming availability.
      workspaceTools: "unknown",
      browser: "unknown",
      knowledge: "unknown",
    });
  });

  it("reports host tool and browser reachability from live session facts, with no override", () => {
    expect(
      normalizeHarnessCapabilityView({
        providerInstanceId: ProviderInstanceId.make("office-capable"),
        available: true,
        reported: { mcpServers: true, workspaceTools: true, browser: true },
      }).workspaceTools,
    ).toBe("supported");
    expect(
      normalizeHarnessCapabilityView({
        providerInstanceId: ProviderInstanceId.make("office-capable"),
        available: true,
        reported: { mcpServers: true, workspaceTools: true, browser: true },
      }).browser,
    ).toBe("supported");
    expect(
      normalizeHarnessCapabilityView({
        providerInstanceId: ProviderInstanceId.make("no-mcp"),
        available: true,
        reported: { mcpServers: false },
      }).workspaceTools,
    ).toBe("unknown");
    // A harness that cannot speak MCP is never reported as browser-capable, and
    // there is no override that could claim otherwise.
    expect(
      normalizeHarnessCapabilityView({
        providerInstanceId: ProviderInstanceId.make("no-mcp"),
        available: true,
        reported: { mcpServers: false, browser: false },
        overrides: { supportsMcpServers: true },
      }).browser,
    ).toBe("unsupported");
  });

  it("derives knowledge reachability from the same live facts, with no override", () => {
    // Ready SAG + a valid project scope + a provider that speaks MCP.
    expect(
      normalizeHarnessCapabilityView({
        providerInstanceId: ProviderInstanceId.make("knowledge-capable"),
        available: true,
        reported: { mcpServers: true, knowledge: true },
      }).knowledge,
    ).toBe("supported");
    // SAG offline, or a scope that resolves to nothing: the caller reports false.
    expect(
      normalizeHarnessCapabilityView({
        providerInstanceId: ProviderInstanceId.make("knowledge-capable"),
        available: true,
        reported: { mcpServers: true, knowledge: false },
      }).knowledge,
    ).toBe("unsupported");
    // Unresolved project: nothing is claimed.
    expect(
      normalizeHarnessCapabilityView({
        providerInstanceId: ProviderInstanceId.make("knowledge-capable"),
        available: true,
        reported: { mcpServers: true },
      }).knowledge,
    ).toBe("unknown");
    // A harness that cannot speak MCP is never reported as knowledge-capable, and
    // there is no override that could claim otherwise.
    expect(
      normalizeHarnessCapabilityView({
        providerInstanceId: ProviderInstanceId.make("no-mcp"),
        available: true,
        reported: { mcpServers: false, knowledge: false },
        overrides: { supportsMcpServers: true },
      }).knowledge,
    ).toBe("unsupported");
  });

  it("keeps unknown values unknown and isolates providers", () => {
    const first = normalizeHarnessCapabilityView({
      providerInstanceId: ProviderInstanceId.make("kimi-acp"),
      available: false,
      reported: {},
    });
    const second = normalizeHarnessCapabilityView({
      providerInstanceId: ProviderInstanceId.make("deepseek-acp"),
      available: true,
      reported: { terminal: true },
    });
    expect(first.terminal).toBe("unknown");
    expect(second.terminal).toBe("supported");
    expect(first.providerInstanceId).not.toBe(second.providerInstanceId);
  });
});
