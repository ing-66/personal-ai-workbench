/**
 * Knowledge - the environment's connection to SAG.
 *
 * This service answers one question for the rest of the server: *can this
 * project reach knowledge right now, and at which MCP URL?* It owns the SAG
 * connection, resolves a project's scope to that URL, and keeps both the
 * capability view and the handoff briefing honest. It owns no knowledge: no
 * sources, documents, chunks, embeddings, or vectors live here, and none are
 * cached. The one thing it remembers briefly is whether the endpoint answered.
 *
 * Settings are passed in rather than resolved from the settings service, exactly
 * like `BrowserRuntime.start(input)`: the caller already holds them, and the
 * layer then requires nothing beyond its own cache. That is also what keeps
 * adding this service from widening every Effect context in the repository.
 *
 * Two boundaries are load-bearing:
 *
 * - **No fallback.** A missing source, a rejected token, or an unreachable
 *   server yields no server descriptor at all, so a harness is never handed a
 *   knowledge endpoint that is silently wider than the project asked for.
 * - **No retrieval.** The probe only ever handshakes. It never searches, reads,
 *   or ingests; every real query belongs to the harness, through the MCP server
 *   it was handed, and its results reach that harness exactly as SAG produced
 *   them - citations and `chunk_id`s included.
 *
 * @module KnowledgeService
 */
import {
  buildKnowledgeMcpUrl,
  isKnowledgeStatusAvailable,
  knowledgeScopeLabel,
  knowledgeScopeOrNone,
  normalizeKnowledgeEndpoint,
  type KnowledgeScope,
  type KnowledgeStatus,
  type ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  KNOWLEDGE_PROBE_TIMEOUT_MS,
  failedProbe,
  probeKnowledgeMcp,
  type KnowledgeProbeInput,
  type KnowledgeProbeResult,
} from "./KnowledgeProbe.ts";

/**
 * The name SAG is offered to a provider under. One spelling for every adapter, so
 * a provider config never drifts between harnesses.
 */
export const KNOWLEDGE_MCP_SERVER_NAME = "sag-knowledge";

/** How long a probe result is reused, so a session start does not re-probe a burst. */
const PROBE_CACHE_TTL_MS = 10_000;

/** How long the handoff path may wait: a briefing must never stall a handoff. */
const HANDOFF_PROBE_TIMEOUT_MS = 1_500;

export interface KnowledgeProviderServer {
  readonly name: string;
  /** The scope-resolved MCP URL, exactly as SAG expects it. */
  readonly url: string;
  /** `Bearer <token>`, present only when the environment stores a credential. */
  readonly authorizationHeader?: string;
}

/** What a handoff briefing is allowed to know: availability and a scope label. */
export interface KnowledgeHandoffFacts {
  readonly available: boolean;
  /** Null when this project has no scope. Never a tool list or any content. */
  readonly scope: string | null;
}

export interface KnowledgeStatusRequest {
  /** Environment settings, as the caller already read them. */
  readonly settings: ServerSettings;
  /** Omit for the environment-level view (Settings). */
  readonly projectId?: ProjectId | null;
  /** Also read the visible sources, for a scope picker. */
  readonly includeSources?: boolean;
  /** Bound a whole probe, in milliseconds. */
  readonly timeoutMs?: number;
}

export interface KnowledgeServiceShape {
  /** Live status for the environment, or for one project's scope. Never persisted. */
  readonly status: (request: KnowledgeStatusRequest) => Effect.Effect<KnowledgeStatus>;
  /**
   * The extra MCP server entry for a provider session, or `undefined` when this
   * project reaches no knowledge. Absence is the whole of "knowledge
   * unavailable": there is no fallback path.
   */
  readonly resolveProviderServer: (
    settings: ServerSettings,
    projectId: ProjectId | null,
  ) => Effect.Effect<KnowledgeProviderServer | undefined>;
  /** Read-only facts for a handoff briefing. */
  readonly describeForHandoff: (
    settings: ServerSettings,
    projectId: ProjectId | null,
  ) => Effect.Effect<KnowledgeHandoffFacts>;
}

export class KnowledgeService extends Context.Service<KnowledgeService, KnowledgeServiceShape>()(
  "t3/knowledge/KnowledgeService",
) {}

interface ProbeCacheEntry {
  readonly at: number;
  readonly result: KnowledgeProbeResult;
}

export interface KnowledgeServiceLiveOptions {
  /** Test seam for the probe. Production uses the real Streamable HTTP probe. */
  readonly probe?: (input: KnowledgeProbeInput) => Promise<KnowledgeProbeResult>;
}

/**
 * A project's knowledge scope. The scope lives in the project's override record -
 * the same record every other project-scoped setting uses - so reading it needs
 * no persistence of its own.
 */
export function knowledgeScopeForProject(
  settings: ServerSettings,
  projectId: ProjectId | null,
): KnowledgeScope {
  return knowledgeScopeOrNone(resolveProjectSettings(settings, projectId).overrides.knowledgeScope);
}

export const makeWith = (options?: KnowledgeServiceLiveOptions) =>
  Effect.gen(function* () {
    const probe = options?.probe ?? probeKnowledgeMcp;
    const cache = yield* Ref.make(new Map<string, ProbeCacheEntry>());

    /**
     * Probe once per endpoint per short window. The cache exists so a handoff and
     * a session start in the same breath do not each pay for a handshake; it never
     * serves a decision a stale fact would corrupt, because every caller re-reads
     * the scope from settings first.
     */
    const probeOnce = (
      url: string,
      token: string,
      scoped: boolean,
      includeSources: boolean,
      timeoutMs: number,
    ) =>
      Effect.gen(function* () {
        const key = `${url}|${token.length > 0 ? "token" : "anonymous"}|${includeSources ? "sources" : "tools"}`;
        const now = yield* Clock.currentTimeMillis;
        const entries = yield* Ref.get(cache);
        const cached = entries.get(key);
        if (cached !== undefined && now - cached.at < PROBE_CACHE_TTL_MS) return cached.result;
        const result = yield* Effect.promise(() =>
          probe({ url, token, scoped, includeSources, timeoutMs }).catch(() =>
            failedProbe("connection-failed"),
          ),
        );
        yield* Ref.update(cache, (current) => {
          const next = new Map(current);
          next.set(key, { at: now, result });
          return next;
        });
        return result;
      });

    const status = Effect.fn("KnowledgeService.status")(function* (
      request: KnowledgeStatusRequest,
    ) {
      const settings = request.settings;
      const scope = knowledgeScopeForProject(settings, request.projectId ?? null);
      const normalized = normalizeKnowledgeEndpoint(settings.knowledge.endpoint);
      const token = settings.knowledge.token;
      const base = {
        endpoint: normalized ?? "",
        mcpUrl: null,
        scope,
        tools: [] as ReadonlyArray<string>,
        sources: [],
        hasToken: token.length > 0,
      };
      const unavailable = (diagnostic: KnowledgeStatus["diagnostic"]): KnowledgeStatus => ({
        ...base,
        diagnostic,
      });
      if (!settings.knowledge.enabled) {
        // Reported as its own state so a user can tell "switched off" from
        // "misconfigured", and never as an unavailable knowledge base.
        return unavailable("disabled");
      }
      if (!normalized) return unavailable("not-configured");

      // A project with no scope still probes the bare endpoint: Settings has to be
      // able to say whether SAG is reachable, and the source list is what a user
      // picks a scope from. Nothing is handed to a provider in that state - the
      // status carries no `mcpUrl` - so this never becomes a hidden search.
      const scopedUrl = buildKnowledgeMcpUrl(normalized, scope) ?? normalized;
      const result = yield* probeOnce(
        scopedUrl,
        token,
        scope.mode === "source",
        request.includeSources ?? false,
        request.timeoutMs ?? KNOWLEDGE_PROBE_TIMEOUT_MS,
      );
      const ready = result.diagnostic === "ready";
      return {
        diagnostic: result.diagnostic,
        endpoint: normalized,
        mcpUrl: ready && scope.mode !== "none" ? scopedUrl : null,
        scope,
        tools: ready ? result.tools : [],
        sources: result.sources,
        hasToken: token.length > 0,
      } satisfies KnowledgeStatus;
    });

    const resolveProviderServer = Effect.fn("KnowledgeService.resolveProviderServer")(function* (
      settings: ServerSettings,
      projectId: ProjectId | null,
    ) {
      const view = yield* status({ settings, projectId });
      if (!isKnowledgeStatusAvailable(view) || view.mcpUrl === null) {
        if (view.diagnostic !== "disabled" && view.diagnostic !== "not-configured") {
          // Diagnostic only: never the URL, never the token, never a source id.
          yield* Effect.logWarning("Knowledge withheld from this provider session", {
            diagnostic: view.diagnostic,
            scopeMode: view.scope.mode,
          });
        }
        return undefined;
      }
      const token = settings.knowledge.token;
      return {
        name: KNOWLEDGE_MCP_SERVER_NAME,
        url: view.mcpUrl,
        ...(token.length > 0 ? { authorizationHeader: `Bearer ${token}` } : {}),
      } satisfies KnowledgeProviderServer;
    });

    const describeForHandoff = Effect.fn("KnowledgeService.describeForHandoff")(function* (
      settings: ServerSettings,
      projectId: ProjectId | null,
    ) {
      const view = yield* status({ settings, projectId, timeoutMs: HANDOFF_PROBE_TIMEOUT_MS });
      return {
        available: isKnowledgeStatusAvailable(view),
        scope: knowledgeScopeLabel(view.scope),
      } satisfies KnowledgeHandoffFacts;
    });

    return { status, resolveProviderServer, describeForHandoff } satisfies KnowledgeServiceShape;
  });

export const layerWith = (options?: KnowledgeServiceLiveOptions) =>
  Layer.effect(KnowledgeService, makeWith(options));

export const layer = layerWith();
