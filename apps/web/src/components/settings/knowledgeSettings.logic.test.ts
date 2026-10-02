import {
  KNOWLEDGE_DIAGNOSTIC_MESSAGES,
  type KnowledgeScope,
  type KnowledgeSourceSummary,
  type KnowledgeStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  knowledgeScopeFromSelectValue,
  knowledgeScopeSelectValue,
  knowledgeSourceChoices,
  projectKnowledgeStatusText,
  resolveKnowledgeDiagnostic,
  resolveKnowledgeDisplay,
} from "./knowledgeSettings.logic";

function status(overrides: Partial<KnowledgeStatus> = {}): KnowledgeStatus {
  return {
    diagnostic: "ready",
    endpoint: "http://127.0.0.1:8000/mcp/",
    mcpUrl: "http://127.0.0.1:8000/mcp/",
    scope: { mode: "none" },
    tools: [],
    sources: [],
    hasToken: false,
    ...overrides,
  };
}

const SOURCES: ReadonlyArray<KnowledgeSourceSummary> = [
  { sourceId: "legal", displayName: "Legal Documents" },
  { sourceId: "handbook", displayName: "Handbook" },
];

describe("resolveKnowledgeDiagnostic", () => {
  it("reports a running test over the previous answer", () => {
    expect(resolveKnowledgeDiagnostic({ status: status(), isPending: true, isError: false })).toBe(
      "authenticating",
    );
  });

  it("reports the diagnostic the server sent", () => {
    expect(
      resolveKnowledgeDiagnostic({
        status: status({ diagnostic: "source-not-found" }),
        isPending: false,
        isError: false,
      }),
    ).toBe("source-not-found");
  });

  it("reads a refused request as a failed connection rather than as unconfigured", () => {
    expect(resolveKnowledgeDiagnostic({ status: null, isPending: false, isError: true })).toBe(
      "connection-failed",
    );
  });

  it("falls back to not-configured before anything has been asked", () => {
    expect(resolveKnowledgeDiagnostic({ status: null, isPending: false, isError: false })).toBe(
      "not-configured",
    );
  });
});

describe("resolveKnowledgeDisplay", () => {
  it("carries the contract copy and the discovered sources", () => {
    const display = resolveKnowledgeDisplay({
      status: status({ diagnostic: "unauthorized", sources: SOURCES, hasToken: false }),
      isPending: false,
      isError: false,
    });
    expect(display.message).toBe(KNOWLEDGE_DIAGNOSTIC_MESSAGES.unauthorized);
    expect(display.sources).toEqual(SOURCES);
    expect(display.hasToken).toBe(false);
  });

  it("shows no sources until a request has answered", () => {
    const display = resolveKnowledgeDisplay({ status: null, isPending: true, isError: false });
    expect(display.diagnostic).toBe("authenticating");
    expect(display.sources).toEqual([]);
    expect(display.message).toBe(KNOWLEDGE_DIAGNOSTIC_MESSAGES.authenticating);
  });
});

describe("projectKnowledgeStatusText", () => {
  it("names a missing source instead of widening the scope", () => {
    expect(
      projectKnowledgeStatusText({
        status: status({ diagnostic: "source-not-found" }),
        isPending: false,
      }),
    ).toBe(KNOWLEDGE_DIAGNOSTIC_MESSAGES["source-not-found"]);
  });

  it("names an offline server and rejected credentials", () => {
    expect(
      projectKnowledgeStatusText({
        status: status({ diagnostic: "connection-failed" }),
        isPending: false,
      }),
    ).toBe(KNOWLEDGE_DIAGNOSTIC_MESSAGES["connection-failed"]);
    expect(
      projectKnowledgeStatusText({
        status: status({ diagnostic: "unauthorized" }),
        isPending: false,
      }),
    ).toBe(KNOWLEDGE_DIAGNOSTIC_MESSAGES.unauthorized);
  });

  it("reports readiness once SAG answers for this scope", () => {
    expect(
      projectKnowledgeStatusText({
        status: status({ mcpUrl: "http://127.0.0.1:8000/mcp/?source_id=legal" }),
        isPending: false,
      }),
    ).toBe(KNOWLEDGE_DIAGNOSTIC_MESSAGES.ready);
  });

  it("leaves the environment's own states to the environment's settings", () => {
    expect(
      projectKnowledgeStatusText({ status: status({ diagnostic: "disabled" }), isPending: false }),
    ).toBeNull();
    expect(
      projectKnowledgeStatusText({
        status: status({ diagnostic: "not-configured" }),
        isPending: false,
      }),
    ).toBeNull();
    expect(projectKnowledgeStatusText({ status: null, isPending: false })).toBeNull();
  });

  it("says a test is running rather than nothing", () => {
    expect(projectKnowledgeStatusText({ status: null, isPending: true })).toBe(
      KNOWLEDGE_DIAGNOSTIC_MESSAGES.authenticating,
    );
  });
});

describe("knowledgeSourceChoices", () => {
  it("lists what SAG reports when nothing is selected", () => {
    expect(knowledgeSourceChoices(SOURCES, { mode: "none" })).toEqual(SOURCES);
    expect(knowledgeSourceChoices(SOURCES, { mode: "all" })).toEqual(SOURCES);
  });

  it("keeps the selected source listed when SAG still has it", () => {
    const scope: KnowledgeScope = { mode: "source", sourceId: "legal", displayName: "Legal" };
    expect(knowledgeSourceChoices(SOURCES, scope)).toEqual(SOURCES);
  });

  it("keeps a deleted source as an option so the row can show what it selects", () => {
    const scope: KnowledgeScope = { mode: "source", sourceId: "gone", displayName: "Old Name" };
    expect(knowledgeSourceChoices(SOURCES, scope)).toEqual([
      ...SOURCES,
      { sourceId: "gone", displayName: "Old Name" },
    ]);
  });

  it("labels a selected source that never had a display name with its id", () => {
    expect(knowledgeSourceChoices([], { mode: "source", sourceId: "gone" })).toEqual([
      { sourceId: "gone", displayName: "gone" },
    ]);
  });
});

describe("knowledge scope picker values", () => {
  it("round-trips none, all, and a named source", () => {
    expect(knowledgeScopeSelectValue({ mode: "none" })).toBe("none");
    expect(knowledgeScopeSelectValue({ mode: "all" })).toBe("all");
    expect(
      knowledgeScopeSelectValue({ mode: "source", sourceId: "legal", displayName: "Legal" }),
    ).toBe("source:legal");
    expect(knowledgeScopeFromSelectValue("none", SOURCES)).toEqual({ mode: "none" });
    expect(knowledgeScopeFromSelectValue("all", SOURCES)).toEqual({ mode: "all" });
    expect(knowledgeScopeFromSelectValue("source:legal", SOURCES)).toEqual({
      mode: "source",
      sourceId: "legal",
      displayName: "Legal Documents",
    });
  });

  it("reads a source-less entry as none", () => {
    expect(knowledgeScopeSelectValue({ mode: "source", sourceId: "  " })).toBe("none");
  });

  it("refuses a value naming a source that is not an option", () => {
    expect(knowledgeScopeFromSelectValue("source:gone", SOURCES)).toBeNull();
    expect(knowledgeScopeFromSelectValue("", SOURCES)).toBeNull();
  });
});
