/**
 * Model Gateway - the environment's gateway service.
 *
 * Owns three things and nothing else:
 *
 * - the **listener's lifecycle** (`stopped -> starting -> ready -> error -> stopping -> stopped`),
 *   started lazily the first time a harness or Settings needs an endpoint. A
 *   disabled or unconfigured gateway never binds a port at all, so "off" costs
 *   nothing.
 * - **per-session credentials**: one bearer per `(thread, provider instance)`,
 *   minted from 32 random bytes and revoked with the thread. The token is the
 *   only thing guarding the listener, so loopback is never treated as trust.
 * - the **usage view**, which is metadata only by construction.
 *
 * What it deliberately does not own: which upstream answers. That is the route's
 * decision, made per request by the proxy. This service only answers "can this
 * harness be pointed at the gateway, and with which overlay", which is a question
 * about configuration, and gets a real `undefined` when the answer is no.
 *
 * @module ModelGatewayService
 */
import {
  DEFAULT_MODEL_GATEWAY_SETTINGS,
  ModelGatewayLifecycleState,
  ModelGatewaySettings,
  ModelGatewayStatus,
  ModelProviderId,
  modelProviderSecretName,
  resolveModelGatewayAttempts,
  summarizeModelGatewayUsage,
  validateModelGatewayRoute,
  type ModelGatewayDiagnostic,
  type ModelGatewayProtocol,
  type ModelGatewayUsageDimension,
  type ModelGatewayUsageQuery,
  type ModelGatewayUsageRecord,
  type ModelGatewayUsageView,
  type ModelRouteId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeModelGatewayCircuitBreaker } from "./ModelGatewayCircuitBreaker.ts";
import { resolveModelGatewayRouteProtocol } from "./ModelGatewayPolicy.ts";
import {
  make as makeModelGatewayProxy,
  type ModelGatewayCredentialScope,
  type ModelGatewayProxyShape,
  type ModelGatewayUpstreamConfig,
} from "./ModelGatewayProxy.ts";
import {
  layer as modelGatewayUsageStoreLayer,
  ModelGatewayUsageStore,
} from "./ModelGatewayUsageStore.ts";

/**
 * The protocol each harness speaks when it is pointed at the gateway.
 *
 * Only the two harnesses this phase actually verified are listed. Every other
 * driver - Cursor, Grok, Antigravity, OpenCode, Generic ACP - is absent on
 * purpose: reporting `unsupported-by-harness` and leaving the harness on its own
 * provider settings beats guessing an environment variable for an adapter nobody
 * has exercised.
 */
const MODEL_GATEWAY_DRIVER_PROTOCOLS: Readonly<Partial<Record<string, ModelGatewayProtocol>>> = {
  codex: "openai-responses",
  claudeAgent: "anthropic-messages",
};

const MAX_USAGE_WINDOW_ROWS = 5_000;
const MAX_RECENT_USAGE_ROWS = 50;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const decodeGatewaySettings = Schema.decodeUnknownOption(ModelGatewaySettings);

/**
 * The gateway's slice of settings.
 *
 * Read through a decoder rather than off the settings object directly, so a
 * settings file without the key, or one whose gateway section did not survive
 * decoding, degrades to the frozen defaults - a gateway that is off. Failing
 * closed is the only safe direction here; guessing at half a configuration is
 * not.
 */
const readModelGatewaySettings = (settings: unknown): ModelGatewaySettings =>
  Option.getOrElse(
    decodeGatewaySettings(asRecord(settings)?.modelGateway ?? {}),
    () => DEFAULT_MODEL_GATEWAY_SETTINGS,
  );

/** A branded driver kind compared as the plain string it is, for the map above. */
const driverKindName = (kind: ProviderDriverKind): string => kind;

const secretDecoder = new TextDecoder();

const diagnosticFor = (
  settings: ModelGatewaySettings,
  lifecycle: ModelGatewayLifecycleState,
): ModelGatewayDiagnostic => {
  if (!settings.enabled) return "disabled";
  if (lifecycle === "error") return "bind-failed";
  if (lifecycle === "ready") return "ready";
  if (lifecycle === "starting") return "starting";
  return "not-configured";
};

const usageGroupKey = (
  row: ModelGatewayUsageRecord,
  dimension: ModelGatewayUsageDimension,
): string => {
  switch (dimension) {
    case "provider":
      return row.servedByProviderId;
    case "model":
      return row.upstreamModel;
    case "route":
      return row.routeId;
    case "protocol":
      return row.protocol;
  }
};

export class ModelGatewayService extends Context.Service<
  ModelGatewayService,
  {
    /** Ensure the loopback listener exists when the gateway is enabled and configured. */
    readonly start: Effect.Effect<ModelGatewayStatus>;
    readonly stop: Effect.Effect<void>;
    readonly status: Effect.Effect<ModelGatewayStatus>;
    /**
     * Env overlay that points one provider instance's harness at the gateway, or
     * undefined when it must keep its own provider settings (gateway off, no route,
     * route missing, no usable upstream, or the driver cannot be pointed at it).
     *
     * `threadId` is optional and additive to the frozen shape: given one, the
     * overlay carries a bearer minted for exactly that session. Without one the
     * overlay reuses the credential most recently issued for this provider
     * instance, which is what makes the overlay usable when the caller asks for
     * it before it mints. Neither form ever carries an upstream key.
     */
    readonly resolveHarnessEnvironment: (input: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly driverKind: ProviderDriverKind;
      readonly gatewayRouteId: string | undefined;
      readonly threadId?: ThreadId;
    }) => Effect.Effect<Readonly<Record<string, string>> | undefined>;
    /** Mint/reuse the per-session bearer for one (thread, instance) pair. */
    readonly issueCredential: (input: {
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly routeId: ModelRouteId;
    }) => Effect.Effect<string | undefined>;
    readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly usageView: (query: ModelGatewayUsageQuery) => Effect.Effect<ModelGatewayUsageView>;
  }
>()("t3/modelGateway/ModelGatewayService") {}

export const make = Effect.fn("ModelGatewayService.make")(function* () {
  const settingsService = yield* ServerSettingsService;
  const secretStore = yield* ServerSecretStore;
  const usageStore = yield* ModelGatewayUsageStore;
  const crypto = yield* Crypto.Crypto;

  const breaker = makeModelGatewayCircuitBreaker();
  const lifecycle = yield* Ref.make<ModelGatewayLifecycleState>("stopped");
  const credentialsByToken = new Map<string, ModelGatewayCredentialScope>();
  const tokenBySession = new Map<string, { readonly token: string; readonly routeId: string }>();
  const tokenByInstance = new Map<string, { readonly token: string; readonly routeId: string }>();

  const readSettings = settingsService.getSettings.pipe(
    Effect.map(readModelGatewaySettings),
    Effect.catch(() => Effect.succeed(DEFAULT_MODEL_GATEWAY_SETTINGS)),
  );

  const toUpstreamConfig = (settings: ModelGatewaySettings): ModelGatewayUpstreamConfig => ({
    providers: settings.providers,
    routes: settings.routes,
    requestTimeoutMs: settings.requestTimeoutMs,
    cooldownMs: settings.cooldownMs,
    usageRetentionDays: settings.usageRetentionDays,
  });

  const proxy: ModelGatewayProxyShape = yield* makeModelGatewayProxy({
    // Resolved by exact token match against an in-memory map: nothing is ever
    // persisted, so there is nothing on disk to steal and nothing to hash for.
    resolveCredential: async (token) => credentialsByToken.get(token),
    loadConfig: () => Effect.runPromise(readSettings.pipe(Effect.map(toUpstreamConfig))),
    loadApiKey: (providerId) =>
      Effect.runPromise(
        secretStore.get(modelProviderSecretName(providerId)).pipe(
          Effect.map((secret) =>
            Option.match(secret, {
              onSome: (bytes) => secretDecoder.decode(bytes),
              onNone: () => undefined,
            }),
          ),
          // A secret store that cannot be read is an upstream without a key; the
          // upstream's own 401 then surfaces, on the provider that caused it.
          Effect.catch(() => Effect.succeed(undefined)),
        ),
      ),
    recordUsage: async (row) => {
      const nowMs = await Effect.runPromise(Clock.currentTimeMillis);
      await Effect.runPromise(
        readSettings.pipe(
          Effect.flatMap((settings) =>
            usageStore.record(row, {
              retentionDays: settings.usageRetentionDays,
              nowMs,
            }),
          ),
          // A usage row that cannot be written is telemetry loss, not a request
          // failure: the answer has already been delivered by this point.
          Effect.catch(() => Effect.void),
        ),
      );
    },
    breaker,
  });

  /**
   * Bind on first need, and only when there is something to bind for.
   *
   * Idempotent, so every caller may ask. A disabled gateway and one with no
   * profile or no route both report `stopped` without ever opening a port.
   */
  const ensureEndpoint: Effect.Effect<string | undefined> = Effect.gen(function* () {
    const settings = yield* readSettings;
    if (
      !settings.enabled ||
      Object.keys(settings.providers).length === 0 ||
      Object.keys(settings.routes).length === 0
    ) {
      yield* Ref.set(lifecycle, "stopped");
      return undefined;
    }
    yield* Ref.set(lifecycle, "starting");
    return yield* proxy.start.pipe(
      Effect.tap(() => Ref.set(lifecycle, "ready")),
      // The bind error itself is a port detail; Settings renders `bind-failed`,
      // which is the whole of what the diagnostic vocabulary may carry.
      Effect.catch(() => Ref.set(lifecycle, "error").pipe(Effect.as(undefined))),
    );
  });

  const issueCredential: ModelGatewayService["Service"]["issueCredential"] = Effect.fn(
    "ModelGatewayService.issueCredential",
  )(function* (input) {
    const sessionKey = `${input.threadId}\u0000${input.providerInstanceId}`;
    const existing = tokenBySession.get(sessionKey);
    // Reused only while the session still points at the same route; a route
    // change re-mints, because the old token names an answer that no longer
    // applies to this session.
    if (existing !== undefined && existing.routeId === input.routeId) return existing.token;

    const token = yield* crypto.randomBytes(32).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (token === undefined) return undefined;
    if (existing !== undefined) credentialsByToken.delete(existing.token);

    credentialsByToken.set(token, {
      threadId: input.threadId,
      providerInstanceId: input.providerInstanceId,
      routeId: input.routeId,
    });
    tokenBySession.set(sessionKey, { token, routeId: input.routeId });
    tokenByInstance.set(input.providerInstanceId, { token, routeId: input.routeId });
    return token;
  });

  const resolveHarnessEnvironment: ModelGatewayService["Service"]["resolveHarnessEnvironment"] =
    Effect.fn("ModelGatewayService.resolveHarnessEnvironment")(function* (input) {
      const requiredProtocol = MODEL_GATEWAY_DRIVER_PROTOCOLS[driverKindName(input.driverKind)];
      if (requiredProtocol === undefined) return undefined;

      const settings = yield* readSettings;
      if (!settings.enabled) return undefined;
      const routeId = input.gatewayRouteId;
      if (routeId === undefined) return undefined;
      const route = settings.routes[routeId as ModelRouteId];
      if (route === undefined || !route.enabled) return undefined;

      // Protocol-preserving only: a route whose upstreams speak something else
      // cannot be carried, and no conversion exists to make it carryable.
      if (resolveModelGatewayRouteProtocol(route, settings.providers) !== requiredProtocol) {
        return undefined;
      }
      if (resolveModelGatewayAttempts(route, settings.providers).length === 0) return undefined;

      // Given a thread, the bearer is minted for exactly this session. Without
      // one, the overlay reuses what this instance was most recently issued -
      // and only while it still names this route, so a stale credential can
      // never point a session at an upstream its route no longer selects.
      const resolvedToken =
        input.threadId !== undefined
          ? yield* issueCredential({
              threadId: input.threadId,
              providerInstanceId: input.providerInstanceId,
              routeId: route.id,
            })
          : (() => {
              const reuse = tokenByInstance.get(input.providerInstanceId);
              return reuse !== undefined && reuse.routeId === route.id ? reuse.token : undefined;
            })();
      if (resolvedToken === undefined) return undefined;

      const endpoint = yield* ensureEndpoint;
      if (endpoint === undefined) return undefined;

      // The key slot carries the gateway's per-session bearer, never an upstream
      // key: the harness cannot leak what it was never given.
      switch (driverKindName(input.driverKind)) {
        case "codex":
          return { OPENAI_BASE_URL: `${endpoint}/v1`, OPENAI_API_KEY: resolvedToken };
        case "claudeAgent":
          return {
            ANTHROPIC_BASE_URL: endpoint,
            ANTHROPIC_AUTH_TOKEN: resolvedToken,
            ANTHROPIC_API_KEY: "",
          };
        default:
          return undefined;
      }
    });

  const assembleStatus = Effect.fn("ModelGatewayService.assembleStatus")(function* (
    settings: ModelGatewaySettings,
    state: ModelGatewayLifecycleState,
    endpoint: string | undefined,
  ) {
    const providerIds = Object.keys(settings.providers).map((id) => ModelProviderId.make(id));
    const disabledProviderIds = new Set<string>(
      providerIds.filter((id) => settings.providers[id]?.enabled === false),
    );

    const providers = yield* Effect.forEach(
      providerIds,
      (id) =>
        Effect.gen(function* () {
          const provider = settings.providers[id]!;
          const stored = yield* secretStore.get(modelProviderSecretName(id)).pipe(
            Effect.map(Option.isSome),
            Effect.catch(() => Effect.succeed(false)),
          );
          return {
            id,
            name: provider.name,
            protocol: provider.protocol,
            enabled: provider.enabled,
            // Read from the store, not from the redaction marker: a marker in
            // settings means a secret *was* written, which is not the same as one
            // being there now.
            hasCredential: stored,
          };
        }),
      { concurrency: 4 },
    );

    const routes = Object.values(settings.routes).map((route) => ({
      id: route.id,
      name: route.name,
      enabled: route.enabled,
      primaryProviderId: route.primaryProviderId,
      backupProviderIds: route.backupProviderIds,
      failoverEnabled: route.failoverEnabled,
      problems: validateModelGatewayRoute(route, settings.providers),
    }));

    const health = breaker.health({
      providerIds,
      disabledProviderIds,
      nowMs: yield* Clock.currentTimeMillis,
    });

    return {
      lifecycle: state,
      diagnostic: diagnosticFor(settings, state),
      enabled: settings.enabled,
      endpoint: endpoint ?? null,
      providers,
      routes,
      health,
    } satisfies ModelGatewayStatus;
  });

  /**
   * `status` and `start` are the same thing, on purpose. `status` ensures the
   * listener exactly as `start` does, because a gateway that is enabled and
   * configured *will* have an endpoint on the next request a harness makes, so
   * reporting "not running" would be the less true of the two statements.
   */
  const start: Effect.Effect<ModelGatewayStatus> = Effect.gen(function* () {
    const settings = yield* readSettings;
    const endpoint = yield* ensureEndpoint;
    return yield* assembleStatus(settings, yield* Ref.get(lifecycle), endpoint);
  });

  const stop: Effect.Effect<void> = Effect.gen(function* () {
    yield* Ref.set(lifecycle, "stopping");
    yield* proxy.stop;
    yield* Ref.set(lifecycle, "stopped");
  });

  const revokeThread = Effect.fn("ModelGatewayService.revokeThread")(function* (
    threadId: ThreadId,
  ) {
    for (const [token, scope] of credentialsByToken) {
      if (scope.threadId === threadId) credentialsByToken.delete(token);
    }
    for (const [sessionKey, session] of tokenBySession) {
      if (!credentialsByToken.has(session.token)) tokenBySession.delete(sessionKey);
    }
    for (const [instanceId, session] of tokenByInstance) {
      if (!credentialsByToken.has(session.token)) tokenByInstance.delete(instanceId);
    }
  });

  const usageView = Effect.fn("ModelGatewayService.usageView")(function* (
    query: ModelGatewayUsageQuery,
  ) {
    const settings = yield* readSettings;
    const retentionDays = Math.max(1, Math.floor(settings.usageRetentionDays));
    // A client cannot ask for more than the retention window holds, which is also
    // the bound that keeps this read finite.
    const sinceHours = Math.min(Math.max(1, Math.floor(query.sinceHours)), retentionDays * 24);
    const rows = yield* usageStore
      .readWindow({
        sinceHours,
        nowMs: yield* Clock.currentTimeMillis,
        limit: MAX_USAGE_WINDOW_ROWS,
      })
      .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<ModelGatewayUsageRecord>)));

    const buckets = new Map<string, Array<ModelGatewayUsageRecord>>();
    for (const row of rows) {
      const key = usageGroupKey(row, query.groupBy);
      const bucket = buckets.get(key);
      if (bucket === undefined) buckets.set(key, [row]);
      else bucket.push(row);
    }

    return {
      sinceHours,
      totals: summarizeModelGatewayUsage(rows),
      groups: [...buckets.entries()]
        .map(([key, grouped]) => ({ key, summary: summarizeModelGatewayUsage(grouped) }))
        .sort(
          (left, right) =>
            right.summary.requests - left.summary.requests ||
            (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
        ),
      recent: rows.slice(0, MAX_RECENT_USAGE_ROWS),
      retentionDays,
    } satisfies ModelGatewayUsageView;
  });

  return ModelGatewayService.of({
    start,
    stop,
    status: start,
    resolveHarnessEnvironment,
    issueCredential,
    revokeThread,
    usageView,
  });
});

export const layer: Layer.Layer<
  ModelGatewayService,
  never,
  ServerSettingsService | ServerSecretStore | Crypto.Crypto | SqlClient.SqlClient
> = Layer.effect(ModelGatewayService, make()).pipe(Layer.provide(modelGatewayUsageStoreLayer));

export const ModelGatewayServiceLive = layer;
