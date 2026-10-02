import { describe, expect, it } from "@effect/vitest";

import {
  buildKnowledgeMcpUrl,
  isKnowledgeStatusAvailable,
  knowledgeScopeLabel,
  knowledgeScopeOrNone,
  normalizeKnowledgeEndpoint,
  type KnowledgeStatus,
} from "./knowledge.ts";

const status = (over: Partial<KnowledgeStatus>): KnowledgeStatus => ({
  diagnostic: "ready",
  endpoint: "http://127.0.0.1:8000/mcp/",
  mcpUrl: "http://127.0.0.1:8000/mcp/",
  scope: { mode: "all" },
  tools: [],
  sources: [],
  hasToken: false,
  ...over,
});

describe("normalizeKnowledgeEndpoint", () => {
  it("adds the MCP path to a bare origin", () => {
    expect(normalizeKnowledgeEndpoint("http://127.0.0.1:8000")).toBe("http://127.0.0.1:8000/mcp/");
    expect(normalizeKnowledgeEndpoint("https://sag.example.com")).toBe(
      "https://sag.example.com/mcp/",
    );
  });

  it("normalizes a missing trailing slash without doubling it", () => {
    expect(normalizeKnowledgeEndpoint("http://127.0.0.1:8000/mcp")).toBe(
      "http://127.0.0.1:8000/mcp/",
    );
    expect(normalizeKnowledgeEndpoint("http://127.0.0.1:8000/mcp/")).toBe(
      "http://127.0.0.1:8000/mcp/",
    );
    expect(normalizeKnowledgeEndpoint("http://127.0.0.1:8000/mcp//")).toBe(
      "http://127.0.0.1:8000/mcp//",
    );
  });

  it("keeps a deployment subpath", () => {
    expect(normalizeKnowledgeEndpoint("http://host:9000/sag")).toBe("http://host:9000/sag/");
  });

  it("drops a pasted query, including a source scope", () => {
    // Scope belongs to the project. Honouring a URL-scoped base would silently
    // widen every other project's scope, so it is dropped, not preserved.
    expect(normalizeKnowledgeEndpoint("http://127.0.0.1:8000/mcp/?source_id=legal")).toBe(
      "http://127.0.0.1:8000/mcp/",
    );
    expect(normalizeKnowledgeEndpoint("http://127.0.0.1:8000/mcp/?token=abc#frag")).toBe(
      "http://127.0.0.1:8000/mcp/",
    );
  });

  it("rejects anything that is not a plain http(s) endpoint", () => {
    expect(normalizeKnowledgeEndpoint("")).toBeUndefined();
    expect(normalizeKnowledgeEndpoint("   ")).toBeUndefined();
    expect(normalizeKnowledgeEndpoint("127.0.0.1:8000")).toBeUndefined();
    expect(normalizeKnowledgeEndpoint("file:///etc/passwd")).toBeUndefined();
    expect(normalizeKnowledgeEndpoint("ftp://host/mcp")).toBeUndefined();
    expect(normalizeKnowledgeEndpoint("http://user:pass@host/mcp")).toBeUndefined();
  });

  it("trims surrounding whitespace from a pasted value", () => {
    expect(normalizeKnowledgeEndpoint("  http://127.0.0.1:8000  ")).toBe(
      "http://127.0.0.1:8000/mcp/",
    );
  });
});

describe("buildKnowledgeMcpUrl", () => {
  it("resolves no scope to no URL", () => {
    expect(buildKnowledgeMcpUrl("http://host:8000/mcp/", { mode: "none" })).toBeUndefined();
  });

  it("resolves all-sources to the bare endpoint", () => {
    expect(buildKnowledgeMcpUrl("http://host:8000/mcp/", { mode: "all" })).toBe(
      "http://host:8000/mcp/",
    );
  });

  it("adds a source scope as a query parameter", () => {
    expect(
      buildKnowledgeMcpUrl("http://host:8000/mcp/", { mode: "source", sourceId: "legal-docs" }),
    ).toBe("http://host:8000/mcp/?source_id=legal-docs");
  });

  it("encodes a source id", () => {
    expect(
      buildKnowledgeMcpUrl("http://host:8000/mcp/", { mode: "source", sourceId: "a b/c" }),
    ).toBe("http://host:8000/mcp/?source_id=a+b%2Fc");
  });

  it("resolves a source scope with no identity to no URL", () => {
    expect(buildKnowledgeMcpUrl("http://host:8000/mcp/", { mode: "source" })).toBeUndefined();
    expect(
      buildKnowledgeMcpUrl("http://host:8000/mcp/", { mode: "source", sourceId: "  " }),
    ).toBeUndefined();
  });

  it("never produces a doubled slash or a dangling query", () => {
    const url = buildKnowledgeMcpUrl("http://host:8000", {
      mode: "source",
      sourceId: "legal",
    });
    expect(url).toBe("http://host:8000/mcp/?source_id=legal");
    expect(url?.includes("/mcp//?")).toBe(false);
  });
});

describe("knowledgeScopeLabel", () => {
  it("labels each scope for a briefing or a diagnostic row", () => {
    expect(knowledgeScopeLabel({ mode: "none" })).toBeNull();
    expect(knowledgeScopeLabel({ mode: "all" })).toBe("All Sources");
    expect(
      knowledgeScopeLabel({ mode: "source", sourceId: "legal", displayName: "Legal Documents" }),
    ).toBe("Legal Documents");
    expect(knowledgeScopeLabel({ mode: "source", sourceId: "legal" })).toBe("legal");
    expect(knowledgeScopeLabel({ mode: "source" })).toBe("SAG source");
  });

  it("defaults an unset project scope to none, never to all", () => {
    expect(knowledgeScopeOrNone(undefined)).toEqual({ mode: "none" });
  });
});

describe("isKnowledgeStatusAvailable", () => {
  it("requires both a ready connection and a resolved scope", () => {
    expect(isKnowledgeStatusAvailable(status({}))).toBe(true);
    expect(isKnowledgeStatusAvailable(status({ mcpUrl: null }))).toBe(false);
    expect(isKnowledgeStatusAvailable(status({ diagnostic: "unauthorized" }))).toBe(false);
    expect(
      isKnowledgeStatusAvailable(status({ diagnostic: "source-not-found", mcpUrl: null })),
    ).toBe(false);
  });
});
