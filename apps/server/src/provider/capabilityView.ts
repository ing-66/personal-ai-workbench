import type {
  GenericAcpSettings,
  HarnessCapabilityState,
  HarnessCapabilityView,
  ProviderInstanceId,
} from "@t3tools/contracts";

type CapabilityOverrides = GenericAcpSettings["capabilityOverrides"];

export interface ReportedHarnessCapabilities {
  readonly nativeSessionResume?: boolean;
  readonly mcpServers?: boolean;
  readonly filesystemRead?: boolean;
  readonly filesystemWrite?: boolean;
  readonly terminal?: boolean;
  /**
   * Whether host Workbench tools (today: the office toolkit) are reachable.
   * Reported from the live session facts: the harness must speak MCP and the
   * session's credential must grant the capability. Never a persisted catalog of
   * individual tool names.
   */
  readonly workspaceTools?: boolean;
  /**
   * Whether this harness was handed the thread's browser endpoint. Reported from
   * the live session facts: the harness must speak MCP and the thread's
   * Playwright MCP runtime must be ready. Never a persisted per-tool catalog -
   * the official `browser_*` tool list is discovered by the provider, not
   * mirrored here.
   */
  readonly browser?: boolean;
  /**
   * Whether this harness was handed its project's knowledge endpoint. Reported
   * from the live session facts: the harness must speak MCP, the environment's
   * SAG connection must be ready, and the thread's project must resolve to a
   * scope. Never a persisted per-tool catalog - SAG's own `search`, `grep`,
   * `read`, and the rest are discovered by the provider over MCP.
   */
  readonly knowledge?: boolean;
}

function normalizeCapability(
  reported: boolean | undefined,
  override: boolean | undefined,
): HarnessCapabilityState {
  const value = override ?? reported;
  return value === undefined ? "unknown" : value ? "supported" : "unsupported";
}

/**
 * Read-time capability normalization. Reported/default behavior remains the
 * source, explicit Generic ACP settings override it, and availability is live.
 * No derived capability snapshot is persisted.
 */
export function normalizeHarnessCapabilityView(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly available: boolean;
  readonly reported: ReportedHarnessCapabilities;
  readonly overrides?: CapabilityOverrides;
}): HarnessCapabilityView {
  return {
    providerInstanceId: input.providerInstanceId,
    available: input.available,
    nativeSessionResume: normalizeCapability(input.reported.nativeSessionResume, undefined),
    mcpServers: normalizeCapability(input.reported.mcpServers, input.overrides?.supportsMcpServers),
    filesystemRead: normalizeCapability(
      input.reported.filesystemRead,
      input.overrides?.fsReadTextFile,
    ),
    filesystemWrite: normalizeCapability(
      input.reported.filesystemWrite,
      input.overrides?.fsWriteTextFile,
    ),
    terminal: normalizeCapability(input.reported.terminal, input.overrides?.terminal),
    // A harness reaches Workbench tools only through the MCP endpoint, so the
    // reported MCP behavior gates it. No explicit override exists: a user cannot
    // make a harness speak a protocol it does not implement.
    workspaceTools: normalizeCapability(input.reported.workspaceTools, undefined),
    // Browser access is delivered as a second MCP server entry, so the reported
    // MCP behavior gates it exactly as it gates the Workbench tools. No explicit
    // override exists: a harness cannot be made to speak a protocol it does not
    // implement, and no provider-specific browser bridge is written.
    browser: normalizeCapability(input.reported.browser, undefined),
    // Knowledge is delivered the same way, as one more MCP server entry, gated by
    // the same reported MCP behavior. No override exists: a harness cannot be
    // made to speak a protocol it does not implement.
    knowledge: normalizeCapability(input.reported.knowledge, undefined),
  };
}
