import { inspect } from "node:util";

import {
  DEFAULT_SERVER_SETTINGS,
  KNOWLEDGE_SAG_TOKEN_REDACTED,
  ProjectId,
  buildKnowledgeMcpUrl,
  isKnowledgeStatusAvailable,
  type ServerSettings,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  KNOWLEDGE_MCP_SERVER_NAME,
  knowledgeScopeForProject,
  makeWith,
  type KnowledgeServiceShape,
} from "./KnowledgeService.ts";
import {
  readyProbe,
  type KnowledgeProbeInput,
  type KnowledgeProbeResult,
} from "./KnowledgeProbe.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

const TOKEN = "sag-secret-token-value";

/** A recording probe, so a test can assert what Workbench asked SAG for. */
interface ProbeCall {
  readonly url: string;
  readonly token: string;
  readonly scoped: boolean;
  readonly includeSources: boolean;
}

function recordingProbe(outcome: (call: ProbeCall) => KnowledgeProbeResult) {
  const calls: ProbeCall[] = [];
  return {
    calls,
    probe: async (input: KnowledgeProbeInput): Promise<KnowledgeProbeResult> => {
      const call: ProbeCall = {
        url: input.url,
        token: input.token,
        scoped: input.scoped,
        includeSources: input.includeSources,
      };
      calls.push(call);
      return outcome(call);
    },
  };
}

const withService = <A>(
  build: (service: KnowledgeServiceShape) => Effect.Effect<A>,
  probe: (input: KnowledgeProbeInput) => Promise<KnowledgeProbeResult>,
): Effect.Effect<A> =>
  Effect.gen(function* () {
    const service = yield* makeWith({ probe });
    return yield* build(service);
  });

const SAG_TOOLS = [
  "list_sources",
  "search",
  "get_entity",
  "list_documents",
  "outline",
  "grep",
  "read",
  "get_chunk",
];

function settingsWith(overrides: Partial<ServerSettings["knowledge"]> = {}): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    knowledge: {
      enabled: true,
      endpoint: "http://127.0.0.1:8000/mcp/",
      token: TOKEN,
      ...overrides,
    },
  };
}

function scopedSettings(): ServerSettings {
  return {
    ...settingsWith(),
    projectSettingsOverrides: {
      [projectA]: {
        knowledgeScope: { mode: "source", sourceId: "source-a", displayName: "Legal" },
      },
      [projectB]: {
        knowledgeScope: { mode: "source", sourceId: "source-b", displayName: "Company" },
      },
    },
  };
}

const ready = () => recordingProbe(() => readyProbe(SAG_TOOLS, []));

it.effect("resolves each project's scope to its own MCP URL, with no cross-project leak", () =>
  Effect.gen(function* () {
    const { calls, probe } = ready();
    const settings = scopedSettings();
    const result = yield* withService(
      (service) =>
        Effect.gen(function* () {
          const a = yield* service.resolveProviderServer(settings, projectA);
          const b = yield* service.resolveProviderServer(settings, projectB);
          return { a, b };
        }),
      probe,
    );
    expect(result.a?.name).toBe(KNOWLEDGE_MCP_SERVER_NAME);
    expect(result.a?.url).toBe("http://127.0.0.1:8000/mcp/?source_id=source-a");
    expect(result.b?.url).toBe("http://127.0.0.1:8000/mcp/?source_id=source-b");
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:8000/mcp/?source_id=source-a",
      "http://127.0.0.1:8000/mcp/?source_id=source-b",
    ]);
    // Whatever else happens, project A's session is never handed project B's scope.
    expect(result.a?.url).not.toContain("source-b");
  }),
);

it.effect("a project with no scope reaches nothing and never falls back to all sources", () =>
  Effect.gen(function* () {
    const { calls, probe } = ready();
    const settings = settingsWith();
    const result = yield* withService(
      (service) =>
        Effect.gen(function* () {
          const server = yield* service.resolveProviderServer(settings, projectA);
          const status = yield* service.status({ settings, projectId: projectA });
          return { server, status };
        }),
      probe,
    );
    expect(result.server).toBeUndefined();
    expect(result.status.scope).toEqual({ mode: "none" });
    expect(result.status.mcpUrl).toBeNull();
    // Settings still probes the bare endpoint - that is how a user picks a scope -
    // but no scoped URL was ever handed to a provider.
    expect(result.status.diagnostic).toBe("ready");
    expect(calls).toEqual([
      { url: "http://127.0.0.1:8000/mcp/", token: TOKEN, scoped: false, includeSources: false },
    ]);
  }),
);

it.effect("a scope whose source SAG reports as missing yields no server at all", () =>
  Effect.gen(function* () {
    const { probe } = recordingProbe(() => ({
      diagnostic: "source-not-found",
      tools: [],
      sources: [],
    }));
    const settings = scopedSettings();
    const result = yield* withService(
      (service) =>
        Effect.gen(function* () {
          const status = yield* service.status({ settings, projectId: projectA });
          const server = yield* service.resolveProviderServer(settings, projectA);
          return { status, server };
        }),
      probe,
    );
    expect(result.status.diagnostic).toBe("source-not-found");
    expect(result.status.mcpUrl).toBeNull();
    expect(isKnowledgeStatusAvailable(result.status)).toBe(false);
    expect(result.server).toBeUndefined();
  }),
);

it.effect("a rejected token yields no server, and the token stays out of every DTO", () =>
  Effect.gen(function* () {
    const { probe } = recordingProbe(() => ({
      diagnostic: "unauthorized",
      tools: [],
      sources: [],
    }));
    const settings = scopedSettings();
    const result = yield* withService(
      (service) =>
        Effect.gen(function* () {
          const status = yield* service.status({ settings, projectId: projectA });
          const server = yield* service.resolveProviderServer(settings, projectA);
          const facts = yield* service.describeForHandoff(settings, projectA);
          return { status, server, facts };
        }),
      probe,
    );
    expect(result.status.diagnostic).toBe("unauthorized");
    expect(result.server).toBeUndefined();
    expect(result.facts).toEqual({ available: false, scope: "Legal" });
    // The credential is sent to SAG and to the injected server descriptor, and to
    // nothing else: not to a status DTO, not to a briefing.
    expect(inspect(result.status)).not.toContain(TOKEN);
    expect(inspect(result.facts)).not.toContain(TOKEN);
    expect(result.status.hasToken).toBe(true);
  }),
);

it.effect("hands the stored credential to the injected server descriptor", () =>
  Effect.gen(function* () {
    const { calls, probe } = ready();
    const settings = scopedSettings();
    const server = yield* withService(
      (service) => service.resolveProviderServer(settings, projectA),
      probe,
    );
    expect(calls[0]?.token).toBe(TOKEN);
    expect(server).toEqual({
      name: KNOWLEDGE_MCP_SERVER_NAME,
      url: "http://127.0.0.1:8000/mcp/?source_id=source-a",
      authorizationHeader: `Bearer ${TOKEN}`,
    });
  }),
);

it.effect("switched off and unconfigured are their own states, and probe nothing", () =>
  Effect.gen(function* () {
    const { calls, probe } = ready();
    const result = yield* withService(
      (service) =>
        Effect.gen(function* () {
          const disabled = yield* service.status({ settings: settingsWith({ enabled: false }) });
          const unconfigured = yield* service.status({
            settings: settingsWith({ endpoint: "  " }),
          });
          return { disabled, unconfigured };
        }),
      probe,
    );
    expect(result.disabled.diagnostic).toBe("disabled");
    expect(result.unconfigured.diagnostic).toBe("not-configured");
    expect(result.unconfigured.endpoint).toBe("");
    expect(calls).toHaveLength(0);
  }),
);

it.effect("knowledge facts for a handoff carry availability and a scope label only", () =>
  Effect.gen(function* () {
    const settings = scopedSettings();
    const { probe } = ready();
    const facts = yield* withService(
      (service) => service.describeForHandoff(settings, projectA),
      probe,
    );
    expect(facts).toEqual({ available: true, scope: "Legal" });
    expect(inspect(facts)).not.toContain(TOKEN);

    // The facts are a function of the project, not of a harness: whichever
    // provider instance asks, the answer is the same - which is why a handoff
    // cannot change a thread's knowledge scope.
    const again = yield* withService(
      (service) => service.describeForHandoff(settings, projectA),
      probe,
    );
    expect(again).toEqual(facts);

    const offline = recordingProbe(() => ({
      diagnostic: "connection-failed",
      tools: [],
      sources: [],
    }));
    const unavailable = yield* withService(
      (service) => service.describeForHandoff(settings, projectA),
      offline.probe,
    );
    // SAG being down is reported, never propagated: the handoff itself proceeds.
    expect(unavailable).toEqual({ available: false, scope: "Legal" });
  }),
);

it.effect(
  "a project's scope is the same for every thread in it and different across projects",
  () =>
    Effect.gen(function* () {
      const settings = scopedSettings();
      // Threads are not a parameter of scope resolution at all, which is what
      // "threads inherit the project's knowledge scope" means. The browser's
      // profile is keyed per thread; this deliberately is not.
      expect(knowledgeScopeForProject(settings, projectA).sourceId).toBe("source-a");
      expect(knowledgeScopeForProject(settings, projectA).sourceId).toBe("source-a");
      expect(knowledgeScopeForProject(settings, projectB).sourceId).toBe("source-b");
      expect(knowledgeScopeForProject(settings, null)).toEqual({ mode: "none" });
    }),
);

it.effect("never asks SAG for content while a provider session is being prepared", () =>
  Effect.gen(function* () {
    const { calls, probe } = ready();
    const settings = scopedSettings();
    yield* withService(
      (service) =>
        Effect.gen(function* () {
          yield* service.resolveProviderServer(settings, projectA);
          yield* service.describeForHandoff(settings, projectA);
        }),
      probe,
    );
    // No `tools/call` at all on either path: preparation and handoff do discovery
    // only, so opening a thread never issues a hidden search.
    expect(calls.every((call) => call.includeSources === false)).toBe(true);
  }),
);

it.effect("surfaces discovered sources and tools for a scope picker when asked", () =>
  Effect.gen(function* () {
    const { probe } = recordingProbe(() =>
      readyProbe(SAG_TOOLS, [
        { sourceId: "source-a", displayName: "Legal Documents" },
        { sourceId: "source-b", displayName: "Company Docs" },
      ]),
    );
    const view = yield* withService(
      (service) =>
        service.status({ settings: settingsWith(), projectId: projectA, includeSources: true }),
      probe,
    );
    expect(view.sources).toEqual([
      { sourceId: "source-a", displayName: "Legal Documents" },
      { sourceId: "source-b", displayName: "Company Docs" },
    ]);
    // The tool list is what the server advertised, verbatim.
    expect(view.tools).toEqual(SAG_TOOLS);
  }),
);

it.effect("fails closed if a redaction marker ever reaches the probe unreplaced", () =>
  Effect.gen(function* () {
    const settings: ServerSettings = {
      ...scopedSettings(),
      knowledge: {
        enabled: true,
        endpoint: "http://127.0.0.1:8000/mcp/",
        token: KNOWLEDGE_SAG_TOKEN_REDACTED,
      },
    };
    const { calls, probe } = recordingProbe(() => ({
      diagnostic: "unauthorized",
      tools: [],
      sources: [],
    }));
    const view = yield* withService(
      (service) => service.status({ settings, projectId: projectA }),
      probe,
    );
    expect(view.diagnostic).toBe("unauthorized");
    expect(inspect(view)).not.toContain(KNOWLEDGE_SAG_TOKEN_REDACTED);
    expect(calls[0]?.url).toBe(
      buildKnowledgeMcpUrl(settings.knowledge.endpoint, {
        mode: "source",
        sourceId: "source-a",
      }),
    );
  }),
);
