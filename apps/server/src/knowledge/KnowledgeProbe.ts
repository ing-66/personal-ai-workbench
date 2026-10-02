/**
 * The live MCP probe for a configured SAG endpoint.
 *
 * This is the only place Workbench talks to SAG by itself, and it exists for
 * exactly one reason: a provider session must not be handed a knowledge server
 * that cannot answer. SAG answers `404` at connect time when the requested
 * `source_id` does not exist and `401` when the credential is missing or bad, so
 * probing before injection is what makes "Source Missing" and "Unauthorized"
 * observable states instead of a harness that mysteriously cannot search.
 *
 * It performs handshake-level traffic only - `initialize`, `tools/list`, and
 * optionally a `list_sources` call for source discovery. It never searches, never
 * reads a document, and never ingests anything. Retrieval is exclusively the
 * harness's business through the MCP server it is handed.
 *
 * The transport is MCP Streamable HTTP, which SAG mounts statelessly: one JSON-RPC
 * POST per request, answered with either `application/json` or an SSE stream.
 *
 * @module KnowledgeProbe
 */
import type { KnowledgeDiagnostic, KnowledgeSourceSummary } from "@t3tools/contracts";

/** The MCP protocol revision this build announces, matching the browser runtime. */
const MCP_PROTOCOL_VERSION = "2025-06-18";

/** How long one probe may take. A hung SAG must not hold up a session start. */
export const KNOWLEDGE_PROBE_TIMEOUT_MS = 4_000;

export interface KnowledgeProbeInput {
  /** The exact MCP URL, already scope-normalized by the caller. */
  readonly url: string;
  /** The stored credential, without any `Bearer ` prefix. Empty when none. */
  readonly token: string;
  /** True when the URL carries a `source_id`, which changes what a 404 means. */
  readonly scoped: boolean;
  /** Also read the sources visible in this scope. */
  readonly includeSources: boolean;
  /** Test seam. Production uses the platform fetch. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface KnowledgeProbeResult {
  readonly diagnostic: KnowledgeDiagnostic;
  /** Tool names as discovered from the live server. Never a hardcoded catalog. */
  readonly tools: ReadonlyArray<string>;
  readonly sources: ReadonlyArray<KnowledgeSourceSummary>;
}

export const NO_KNOWLEDGE_TOOLS: ReadonlyArray<string> = [];

/** A probe that reached a usable server. */
export function readyProbe(
  tools: ReadonlyArray<string>,
  sources: ReadonlyArray<KnowledgeSourceSummary>,
): KnowledgeProbeResult {
  return { diagnostic: "ready", tools, sources };
}

export function failedProbe(diagnostic: KnowledgeDiagnostic): KnowledgeProbeResult {
  return { diagnostic, tools: NO_KNOWLEDGE_TOOLS, sources: [] };
}

interface JsonRpcEnvelope {
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

interface JsonRpcCall {
  readonly body: unknown;
  readonly expectResult: boolean;
}

function initializeCall(): JsonRpcCall {
  return {
    expectResult: true,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "t3-code-workbench", version: "1" },
      },
    },
  };
}

function initializedNotification(): JsonRpcCall {
  return { expectResult: false, body: { jsonrpc: "2.0", method: "notifications/initialized" } };
}

function listToolsCall(): JsonRpcCall {
  return {
    expectResult: true,
    body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  };
}

function listSourcesCall(): JsonRpcCall {
  return {
    expectResult: true,
    body: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_sources", arguments: {} },
    },
  };
}

/**
 * What an HTTP status means for this probe. `404` is the load-bearing case: SAG
 * answers it when a scoped `source_id` does not exist, and a missing source must
 * surface as `source-not-found` - never as a fallback to the whole knowledge base.
 */
export function diagnosticForStatus(
  status: number,
  scoped: boolean,
): KnowledgeDiagnostic | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return scoped ? "source-not-found" : "mcp-handshake-failed";
  return "connection-failed";
}

/**
 * Read one JSON-RPC envelope out of a Streamable HTTP response. Both wire shapes
 * are accepted: a plain JSON body, and an SSE stream whose `data:` lines carry
 * the envelope.
 */
export function parseJsonRpcEnvelope(text: string): JsonRpcEnvelope | undefined {
  const candidates: unknown[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      candidates.push(JSON.parse(trimmed));
    } catch {
      // Fall through to the SSE scan below.
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^data:\s*(.*)$/.exec(line.trim());
    if (match === null) continue;
    try {
      candidates.push(JSON.parse(match[1] ?? ""));
    } catch {
      // A non-JSON SSE frame is not an MCP envelope; ignore it.
    }
  }
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const envelope = candidate as JsonRpcEnvelope;
    if ("result" in envelope || "error" in envelope) return envelope;
  }
  return undefined;
}

/** `tools/list` payload → tool names, in the order the server reported them. */
export function toolNamesFromListResult(result: unknown): ReadonlyArray<string> | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return undefined;
  const names: string[] = [];
  for (const tool of tools) {
    const name = (tool as { name?: unknown } | null)?.name;
    if (typeof name === "string" && name.length > 0) names.push(name);
  }
  return names;
}

/**
 * Parse SAG's `list_sources` text into source identities.
 *
 * SAG labels each source as `<name>（source_id=<id>） · n 文档 · m 分块`. Only the
 * identity pair is read, and only when the server actually reported an id: an
 * unrecognized line is dropped rather than guessed at, so a format change
 * degrades to "no sources listed" instead of inventing a scope.
 */
export function sourcesFromListSourcesText(text: string): ReadonlyArray<KnowledgeSourceSummary> {
  const sources: KnowledgeSourceSummary[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /source_id=([^\s)）,，;；]+)/.exec(line);
    const sourceId = (match?.[1] ?? "").trim();
    if (sourceId.length === 0 || seen.has(sourceId)) continue;
    seen.add(sourceId);
    const name =
      line
        .replace(/^\s*[-*]\s*/, "")
        .split(/（|\(/)[0]
        ?.trim() ?? "";
    sources.push({ sourceId, displayName: name.length > 0 ? name : sourceId });
  }
  return sources;
}

/** The first text blocks of a `tools/call` result, joined. */
export function toolResultText(result: unknown): string {
  if (result === null || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const text = (block as { text?: unknown } | null)?.text;
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("\n");
}

/**
 * Probe one endpoint. Never throws: every failure is classified into the closed
 * diagnostic vocabulary, because "SAG is down" is a state the Workbench has to
 * display and keep working through, not an exception that unwinds a session start.
 */
export async function probeKnowledgeMcp(input: KnowledgeProbeInput): Promise<KnowledgeProbeResult> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return failedProbe("connection-failed");
  const timeoutMs = input.timeoutMs ?? KNOWLEDGE_PROBE_TIMEOUT_MS;
  // One budget for the whole probe, not one per request: three round trips to a
  // wedged server must not add up to three times the wait a caller agreed to.
  // `performance.now()` is the monotonic clock; this module is deliberately plain
  // async so it can be driven directly by tests, so it does not take Effect's
  // `Clock` as a dependency.
  const deadline = performance.now() + timeoutMs;

  const post = async (call: JsonRpcCall): Promise<JsonRpcEnvelope | KnowledgeDiagnostic> => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return "timeout";
    try {
      const response = await fetchImpl(input.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // MCP Streamable HTTP requires both; SAG answers with one of them.
          accept: "application/json, text/event-stream",
          ...(input.token.length > 0 ? { authorization: `Bearer ${input.token}` } : {}),
        },
        body: JSON.stringify(call.body),
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(remaining))),
      });
      const failure = diagnosticForStatus(response.status, input.scoped);
      if (failure) return failure;
      if (!call.expectResult) return {};
      const text = await response.text();
      const envelope = parseJsonRpcEnvelope(text);
      if (!envelope) return "mcp-handshake-failed";
      if (envelope.error !== undefined) return "mcp-handshake-failed";
      return envelope;
    } catch (cause) {
      const aborted =
        cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError");
      return aborted ? "timeout" : "connection-failed";
    }
  };

  const initialized = await post(initializeCall());
  if (typeof initialized === "string") return failedProbe(initialized);
  // A stateless server does not require this notification, and ignores the reply.
  const notification = await post(initializedNotification());
  if (typeof notification === "string") return failedProbe(notification);

  const listed = await post(listToolsCall());
  if (typeof listed === "string") return failedProbe(listed);
  const tools = toolNamesFromListResult(listed.result);
  if (tools === undefined) return failedProbe("mcp-handshake-failed");

  if (!input.includeSources) return readyProbe(tools, []);

  const sourcesCall = await post(listSourcesCall());
  if (typeof sourcesCall === "string") return readyProbe(tools, []);
  return readyProbe(tools, sourcesFromListSourcesText(toolResultText(sourcesCall.result)));
}
