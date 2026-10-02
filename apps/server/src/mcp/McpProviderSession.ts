import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

/**
 * A second MCP server the session should also be given, beyond T3's own.
 *
 * Today the only producer is the thread browser: the official Playwright MCP
 * server runs on a loopback port the server owns, and the harness reaches it the
 * same way it reaches T3 - by being handed a URL, not by Workbench proxying the
 * upstream tools. Keeping it as plain data is what stops any adapter from growing
 * browser-specific code.
 */
export interface McpProviderSessionExtraServer {
  /** Server name the provider shows the agent. */
  readonly name: string;
  /** MCP endpoint owned by whoever runs the server. */
  readonly url: string;
  /**
   * Credential for that endpoint, when it needs one. Absent for a loopback
   * server the user's own machine owns: SAG, which the user runs as an external
   * service, is the reason this field exists, and it is passed to the provider's
   * own HTTP transport rather than to any code in this repository.
   */
  readonly authorizationHeader?: string;
}

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /**
   * The model gateway overlay for this thread's harness, when the gateway is
   * carrying it. Absent is the normal case and means "this harness keeps its own
   * provider settings": the gateway is off, the instance names no route, the
   * route is unusable, or the driver cannot be pointed at the gateway at all.
   *
   * It is an *overlay*: adapters merge it over the environment the process would
   * otherwise inherit, never in place of it.
   */
  readonly modelGatewayEnvironment?: Readonly<Record<string, string>>;
  /**
   * Additional MCP servers for this session. Absent when the thread has no
   * browser session and its project reaches no knowledge, which is exactly how
   * "browser unavailable" and "knowledge unavailable" reach a provider that
   * cannot speak MCP for itself.
   */
  readonly extraMcpServers?: ReadonlyArray<McpProviderSessionExtraServer>;
}

/**
 * Header list for a provider that takes MCP headers as `{ name, value }` pairs
 * (the ACP-speaking harnesses). Empty for a server that needs no credential.
 */
export function extraServerHeaderList(
  server: McpProviderSessionExtraServer,
): ReadonlyArray<{ readonly name: string; readonly value: string }> {
  return server.authorizationHeader
    ? [{ name: "Authorization", value: server.authorizationHeader }]
    : [];
}

/** Header record for a provider that takes MCP headers as a JSON object. */
export function extraServerHeaderRecord(
  server: McpProviderSessionExtraServer,
): Readonly<Record<string, string>> {
  return server.authorizationHeader ? { Authorization: server.authorizationHeader } : {};
}

/**
 * The environment variable name a provider reads an extra server's token from.
 *
 * Codex takes MCP credentials only as a bearer token named by an environment
 * variable, so the descriptor's header is passed through the subprocess
 * environment rather than on a command line the OS would show to anyone.
 */
export function extraServerBearerTokenEnvVar(serverName: string): string {
  const safe = serverName.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_");
  return `T3_EXTRA_MCP_${safe}_BEARER_TOKEN`;
}

/** The token environment for every extra server that carries a credential. */
export function extraServerTokenEnvironment(
  servers: ReadonlyArray<McpProviderSessionExtraServer> | undefined,
): Readonly<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const server of servers ?? []) {
    if (!server.authorizationHeader) continue;
    entries[extraServerBearerTokenEnvVar(server.name)] = server.authorizationHeader.replace(
      /^Bearer\s+/,
      "",
    );
  }
  return entries;
}

/**
 * Provider env with the model gateway overlay applied over `base`, or `base`
 * untouched.
 *
 * Merging is the whole point: the overlay names two or three variables that point
 * a harness at the loopback gateway while everything the process would otherwise
 * inherit (`PATH` above all) survives. A harness whose overlay is undefined - every
 * driver the gateway cannot carry, and every instance that names no route - gets
 * exactly the environment it got before Phase 7 existed.
 */
export function withModelGatewayEnvironment(
  base: NodeJS.ProcessEnv,
  config:
    | { readonly modelGatewayEnvironment?: Readonly<Record<string, string>> | undefined }
    | undefined,
): NodeJS.ProcessEnv {
  const overlay = config?.modelGatewayEnvironment;
  if (!overlay || Object.keys(overlay).length === 0) return base;
  return { ...base, ...overlay };
}

/**
 * The environment variable a gateway overlay carries its minted bearer in.
 *
 * The gateway mints one credential per (thread, instance) and the harness reads
 * it from a protocol-specific variable; a driver whose overlay names neither is
 * not carried by the gateway at all.
 */
export function modelGatewayCredentialEnvVar(
  environment: Readonly<Record<string, string>>,
): "OPENAI_API_KEY" | "ANTHROPIC_AUTH_TOKEN" | undefined {
  if ("ANTHROPIC_AUTH_TOKEN" in environment) return "ANTHROPIC_AUTH_TOKEN";
  if ("OPENAI_API_KEY" in environment) return "OPENAI_API_KEY";
  return undefined;
}

/**
 * Substitute the session bearer into an overlay.
 *
 * `resolveHarnessEnvironment` knows the endpoint and the variable names but not
 * the thread, so it cannot mint a credential; `issueCredential` mints one but does
 * not know which harness will read it. Joining them here keeps the overlay the
 * single object adapters see, and keeps the decision of *which* variable holds the
 * bearer derived from the overlay itself rather than from a second driver table.
 *
 * An overlay that already carries a bearer (or names no credential variable) is
 * returned unchanged, so this is safe whether or not the gateway minted one.
 */
export function withModelGatewayCredential(
  environment: Readonly<Record<string, string>>,
  credential: string | undefined,
): Readonly<Record<string, string>> {
  if (!credential) return environment;
  const key = modelGatewayCredentialEnvVar(environment);
  if (!key) return environment;
  return { ...environment, [key]: credential };
}

/**
 * Provider env with the device variables applied over `base`, or `base`
 * untouched.
 */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
