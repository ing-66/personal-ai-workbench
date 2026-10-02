import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  diagnosticForStatus,
  parseJsonRpcEnvelope,
  probeKnowledgeMcp,
  sourcesFromListSourcesText,
  toolNamesFromListResult,
  toolResultText,
} from "./KnowledgeProbe.ts";

/**
 * A fixture that speaks SAG's side of the contract, driven through the probe's
 * own `fetch` seam instead of a socket.
 *
 * It mirrors the current upstream wrapper in `apps/api/sag_api/mcp/mount.py`:
 * a bearer check first (`401` with no token, `401` for a bad one), then an
 * optional `source_id` scope resolved from the query string (`404` when that
 * source does not exist), and only then the stateless Streamable HTTP MCP
 * server. Requests are recorded so a test can assert what Workbench did *not*
 * send.
 */
interface FakeSagSource {
  readonly sourceId: string;
  readonly name: string;
  readonly documents: number;
  readonly chunks: number;
}

interface FakeSagOptions {
  readonly token?: string;
  readonly sources?: ReadonlyArray<FakeSagSource>;
  readonly tools?: ReadonlyArray<string>;
  readonly delayMs?: number;
  readonly replyWithHtml?: boolean;
  readonly replyWithGarbage?: boolean;
}

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly toolName: string | null;
  readonly authorized: boolean;
}

interface JsonRpcBody {
  readonly id?: number | undefined;
  readonly method?: string | undefined;
  readonly params?: { readonly name?: string | undefined } | undefined;
}

/** JSON at the fixture's edges goes through Schema, like the product code does. */
const JsonRpcRequestBody = Schema.Struct({
  id: Schema.optional(Schema.Number),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
});
const decodeRequestBody = Schema.decodeUnknownSync(Schema.fromJsonString(JsonRpcRequestBody));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const DEFAULT_TOOLS = [
  "list_sources",
  "search",
  "get_entity",
  "list_documents",
  "outline",
  "grep",
  "read",
  "get_chunk",
];

const DEFAULT_SOURCES: ReadonlyArray<FakeSagSource> = [
  { sourceId: "source-a", name: "Legal Documents", documents: 3, chunks: 41 },
  { sourceId: "source-b", name: "Company Docs", documents: 5, chunks: 77 },
];

/** Exactly how SAG renders one hit, `chunk_id` and citation line included. */
const SEARCH_TEXT =
  "[1] 合同终止（chunk_id=chunk-7）\n来源：Legal Documents（source_id=source-a）\n终止条款要求提前三十日书面通知。";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(encodeJson(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function startFakeSag(options: FakeSagOptions = {}) {
  const sources = options.sources ?? DEFAULT_SOURCES;
  const tools = options.tools ?? DEFAULT_TOOLS;
  const requests: RecordedRequest[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const body: JsonRpcBody = rawBody.length > 0 ? decodeRequestBody(rawBody) : {};
    const method = body.method ?? "";
    const toolName = method === "tools/call" ? (body.params?.name ?? null) : null;
    requests.push({
      url,
      method,
      toolName,
      authorized: (headers.get("authorization") ?? "").length > 0,
    });

    if (options.delayMs) {
      // Rejects with an AbortError once the probe's own timeout fires.
      await delay(options.delayMs, undefined, {
        ...(init?.signal ? { signal: init.signal } : {}),
      });
    }

    const parsed = new URL(url);
    const authorization = headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : authorization;
    if (options.token !== undefined && token !== options.token) {
      return jsonResponse({ error: token.length === 0 ? "缺少认证令牌" : "令牌无效或已过期" }, 401);
    }
    const scoped = parsed.searchParams.get("source_id") ?? "";
    if (scoped.length > 0 && !sources.some((source) => source.sourceId === scoped)) {
      return jsonResponse({ error: "信源不存在" }, 404);
    }
    if (options.replyWithHtml) {
      return new Response("<html><body>not an MCP server</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    if (options.replyWithGarbage) {
      return new Response("{ this is not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "initialize") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "sag-knowledge", version: "1.28.1" },
        },
      });
    }
    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (method === "tools/list") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: tools.map((name) => ({ name, description: `${name} tool` })) },
      });
    }
    if (toolName === "list_sources") {
      const visible = scoped.length > 0 ? sources.filter((s) => s.sourceId === scoped) : sources;
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [
            {
              type: "text",
              text: visible
                .map(
                  (source) =>
                    `- ${source.name}（source_id=${source.sourceId}） · ${source.documents} 文档 · ${source.chunks} 分块`,
                )
                .join("\n"),
            },
          ],
        },
      });
    }
    if (toolName === "search") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: SEARCH_TEXT }] },
      });
    }
    return jsonResponse({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32601, message: "unknown" },
    });
  };

  return {
    url: "http://127.0.0.1:8000/mcp/",
    requests,
    fetch: fetchImpl,
  };
}

describe("probeKnowledgeMcp", () => {
  it("completes the handshake and discovers the server's own tool list", async () => {
    // The fixture advertises a deliberately non-canonical list: the probe must
    // report what the server said, never a hardcoded SAG catalog.
    const advertised = ["list_sources", "search", "a_tool_added_upstream"];
    const sag = startFakeSag({ tools: advertised });
    const result = await probeKnowledgeMcp({
      url: sag.url,
      token: "",
      scoped: false,
      includeSources: false,
      fetch: sag.fetch,
    });
    expect(result.diagnostic).toBe("ready");
    expect(result.tools).toEqual(advertised);
    expect(sag.requests.map((entry) => entry.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
  });

  it("treats a missing or rejected credential as unauthorized, never as ready", async () => {
    const sag = startFakeSag({ token: "right-token" });
    const anonymous = await probeKnowledgeMcp({
      url: sag.url,
      token: "",
      scoped: false,
      includeSources: false,
      fetch: sag.fetch,
    });
    expect(anonymous.diagnostic).toBe("unauthorized");
    const wrong = await probeKnowledgeMcp({
      url: sag.url,
      token: "wrong-token",
      scoped: false,
      includeSources: false,
      fetch: sag.fetch,
    });
    expect(wrong.diagnostic).toBe("unauthorized");
    expect(wrong.tools).toEqual([]);
  });

  it("reports a scoped source that does not exist as source-not-found", async () => {
    const sag = startFakeSag();
    const result = await probeKnowledgeMcp({
      url: `${sag.url}?source_id=deleted-source`,
      token: "",
      scoped: true,
      includeSources: false,
      fetch: sag.fetch,
    });
    // Never a silent fallback to the whole knowledge base.
    expect(result.diagnostic).toBe("source-not-found");
    expect(result.tools).toEqual([]);
  });

  it("classifies each HTTP status the way SAG's contract requires", () => {
    expect(diagnosticForStatus(200, false)).toBeUndefined();
    expect(diagnosticForStatus(401, false)).toBe("unauthorized");
    expect(diagnosticForStatus(403, true)).toBe("forbidden");
    // 404 means "no such source" only when a scope was requested; on a bare
    // endpoint it means the path is not an MCP server at all.
    expect(diagnosticForStatus(404, true)).toBe("source-not-found");
    expect(diagnosticForStatus(404, false)).toBe("mcp-handshake-failed");
    expect(diagnosticForStatus(500, false)).toBe("connection-failed");
  });

  it("reports an unreachable endpoint as connection-failed", async () => {
    const unreachable: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const result = await probeKnowledgeMcp({
      url: "http://127.0.0.1:1/mcp/",
      token: "",
      scoped: false,
      includeSources: false,
      fetch: unreachable,
    });
    expect(result.diagnostic).toBe("connection-failed");
  });

  it("bounds a whole probe by the caller's timeout", async () => {
    const sag = startFakeSag({ delayMs: 400 });
    const result = await probeKnowledgeMcp({
      url: sag.url,
      token: "",
      scoped: false,
      includeSources: false,
      fetch: sag.fetch,
      timeoutMs: 80,
    });
    expect(result.diagnostic).toBe("timeout");
  });

  it("rejects an endpoint that answers with something that is not MCP", async () => {
    const html = startFakeSag({ replyWithHtml: true });
    const garbage = startFakeSag({ replyWithGarbage: true });
    expect(
      (
        await probeKnowledgeMcp({
          url: html.url,
          token: "",
          scoped: false,
          includeSources: false,
          fetch: html.fetch,
        })
      ).diagnostic,
    ).toBe("mcp-handshake-failed");
    expect(
      (
        await probeKnowledgeMcp({
          url: garbage.url,
          token: "",
          scoped: false,
          includeSources: false,
          fetch: garbage.fetch,
        })
      ).diagnostic,
    ).toBe("mcp-handshake-failed");
  });

  it("only reads sources when asked, and never searches on its own", async () => {
    const sag = startFakeSag();
    const quiet = await probeKnowledgeMcp({
      url: sag.url,
      token: "",
      scoped: false,
      includeSources: false,
      fetch: sag.fetch,
    });
    expect(quiet.diagnostic).toBe("ready");
    expect(quiet.sources).toEqual([]);
    // Workbench must not perform retrieval on a user's behalf. Session start is
    // the hot path for this, so it issues no tool call at all.
    expect(sag.requests.some((entry) => entry.method === "tools/call")).toBe(false);

    const withSources = await probeKnowledgeMcp({
      url: `${sag.url}?source_id=source-a`,
      token: "",
      scoped: true,
      includeSources: true,
      fetch: sag.fetch,
    });
    expect(withSources.sources).toEqual([{ sourceId: "source-a", displayName: "Legal Documents" }]);
    expect(
      sag.requests.filter((entry) => entry.method === "tools/call").map((e) => e.toolName),
    ).toEqual(["list_sources"]);
  });

  it("leaves a retrieval result exactly as SAG produced it", async () => {
    const sag = startFakeSag();
    // The path a harness owns: it calls SAG itself through the MCP server it was
    // handed, and Workbench has no code there - it never wraps, re-ranks,
    // truncates, or re-serializes a tool result. The one Workbench function that
    // ever reads a tool result returns SAG's text unchanged, so the citation
    // line, the chunk id, and the source id survive verbatim.
    const response = await sag.fetch(`${sag.url}?source_id=source-a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: encodeJson({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "search", arguments: { query: "终止条件" } },
      }),
    });
    const payload = parseJsonRpcEnvelope(await response.text());
    const text = toolResultText(payload?.result);
    expect(text).toContain("chunk_id=chunk-7");
    expect(text).toContain("来源：Legal Documents（source_id=source-a）");
    expect(text).toBe(SEARCH_TEXT);
  });
});

describe("probe helpers", () => {
  it("parses both Streamable HTTP wire shapes", () => {
    expect(parseJsonRpcEnvelope('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
    expect(
      parseJsonRpcEnvelope(
        'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n',
      ),
    ).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(parseJsonRpcEnvelope("<html></html>")).toBeUndefined();
  });

  it("reads tool names and source identities without inventing any", () => {
    expect(toolNamesFromListResult({ tools: [{ name: "search" }, { name: "grep" }] })).toEqual([
      "search",
      "grep",
    ]);
    expect(toolNamesFromListResult({ nope: true })).toBeUndefined();
    expect(toolNamesFromListResult("nope")).toBeUndefined();

    expect(sourcesFromListSourcesText("- Legal（source_id=source-a） · 3 文档 · 41 分块")).toEqual([
      { sourceId: "source-a", displayName: "Legal" },
    ]);
    // An unrecognized line yields nothing rather than a guessed scope.
    expect(sourcesFromListSourcesText("- Legal Documents")).toEqual([]);
    expect(sourcesFromListSourcesText("（知识库还没有信源）")).toEqual([]);
  });
});
