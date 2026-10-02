// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - the gateway is a raw node:http relay: it owns its own attempt deadline, timestamps a usage row with ISO-8601 UTC, and relays bytes outside any Effect fiber.
import {
  MODEL_GATEWAY_PROTOCOL_PATHS,
  modelGatewayProtocolCredentialHeader,
  normalizeModelGatewayBaseUrl,
  resolveModelGatewayUpstreamModel,
  type ModelGatewayFailureClass,
  type ModelGatewayProvider,
  type ModelGatewayProtocol,
  type ModelGatewayRoute,
  type ModelGatewayUsageRecord,
  type ModelProviderId,
  type ModelRouteId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";

import { guardHttpResponseWriteErrors } from "../httpResponseErrorGuard.ts";
import type { ModelGatewayCircuitBreakerShape } from "./ModelGatewayCircuitBreaker.ts";
import {
  classifyModelGatewayHttpStatus,
  modelGatewayAttemptLabel,
  planModelGatewayAttempts,
  resolveModelGatewayRouteProtocol,
  shouldFailoverForFailureClass,
} from "./ModelGatewayPolicy.ts";
import {
  EMPTY_MODEL_GATEWAY_USAGE_TOKENS,
  makeModelGatewayUsageExtractor,
  type ModelGatewayUsageTokens,
} from "./ModelGatewayUsageExtractor.ts";

/**
 * Model Gateway - the loopback listener that carries a harness's model calls to
 * a configured upstream.
 *
 * What this is: a byte-preserving, protocol-preserving forwarder. It reads the
 * request body once into a buffer so an attempt can be replayed onto a backup,
 * then hands the answer back *unmodified* - same status, same headers, same
 * bytes - because that is what keeps a tool call's `id`, a reasoning block, and
 * a base64 image intact. The request body is rewritten in exactly one case: when
 * the route maps (or defaults) the `model` field, which is the only thing a
 * route is allowed to change.
 *
 * What this is not: a translator, and not a relay. Only the paths in
 * `MODEL_GATEWAY_PROTOCOL_PATHS[protocol]` for the route's own protocol are
 * carried; everything else is a 404. An unknown bearer is a 401 before any
 * upstream is contacted, so loopback is not treated as trust.
 *
 * The duplicate-side-effect guarantee lives in one rule: **the client response is
 * not started until the upstream returns a non-error status.** Before that, an
 * eligible failure advances to the next upstream; after the first byte has been
 * written, a failure is `response-committed` and is never replayed onto a backup,
 * because for a tool-using agent that would be the same side effect twice.
 *
 * @module ModelGatewayProxy
 */
export interface ModelGatewayCredentialScope {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly routeId: ModelRouteId;
}

/** Everything one request needs to know about the configured upstreams. */
export interface ModelGatewayUpstreamConfig {
  readonly providers: Readonly<Record<string, ModelGatewayProvider>>;
  readonly routes: Readonly<Record<string, ModelGatewayRoute>>;
  readonly requestTimeoutMs: number;
  readonly cooldownMs: number;
  readonly usageRetentionDays: number;
}

/**
 * The proxy's outside world.
 *
 * Plain promises rather than Effects on purpose: the request path is a node:http
 * handler, and keeping the boundary synchronous keeps the failover loop readable
 * and testable against real servers. The service is what adapts Effect into it.
 */
export interface ModelGatewayProxyDeps {
  readonly resolveCredential: (token: string) => Promise<ModelGatewayCredentialScope | undefined>;
  /** Read per request, so a settings edit applies without a restart. */
  readonly loadConfig: () => Promise<ModelGatewayUpstreamConfig>;
  /** Materialize one upstream's key. Returned to the forwarder and nothing else. */
  readonly loadApiKey: (providerId: ModelProviderId) => Promise<string | undefined>;
  /** Persist one finished request's metadata. Never sees a header, key, or body. */
  readonly recordUsage: (row: ModelGatewayUsageRecord) => Promise<void>;
  readonly breaker: ModelGatewayCircuitBreakerShape;
  /** Injected so tests can drive cooldowns without waiting on a wall clock. */
  readonly now?: () => number;
}

export class ModelGatewayBindError extends Schema.TaggedError<ModelGatewayBindError>()(
  "ModelGatewayBindError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The model gateway could not bind a loopback port.";
  }
}

export interface ModelGatewayProxyShape {
  /** Idempotent: already-listening returns the endpoint it is listening on. */
  readonly start: Effect.Effect<string, ModelGatewayBindError>;
  readonly stop: Effect.Effect<void>;
  readonly endpoint: string | undefined;
}

/**
 * How much of a request body is accepted. Generous because a prompt carries base64
 * images, but bounded so one request cannot exhaust the process.
 */
const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

/** How much of an upstream *error* body is kept, only to be surfaced verbatim. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/**
 * Headers that belong to one hop and must not be relayed. `transfer-encoding`
 * and `content-length` are deliberately *not* in this set for responses: the
 * answer is relayed byte-for-byte, so the upstream's framing still describes it.
 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Request headers that are never forwarded: hop-by-hop, the inbound credential
 * (replaced with the upstream's own), the inbound framing, and `expect`, whose
 * 100-continue handshake has already happened on our side of the hop.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "authorization",
  "x-api-key",
  "host",
  "content-length",
  "expect",
]);

type AttemptResult = {
  readonly failure: ModelGatewayFailureClass | null;
  readonly status: number | null;
  /** True once any byte of this upstream's answer reached the client. */
  readonly committed: boolean;
  readonly errorBody: Buffer | null;
  readonly errorHeaders: NodeHttp.IncomingHttpHeaders | null;
  readonly timeToFirstTokenMs: number | null;
  readonly streamed: boolean;
  readonly tokens: ModelGatewayUsageTokens;
};

type BodyReadResult =
  | { readonly kind: "ok"; readonly body: Buffer }
  | { readonly kind: "too-large" }
  | { readonly kind: "failed" };

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const parseJsonObject = (body: Buffer): Record<string, unknown> | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
  return asRecord(parsed);
};

const firstHeader = (value: string | Array<string> | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * The session bearer, from either header a harness might use.
 *
 * Anthropic clients send `x-api-key`; OpenAI clients send `Authorization: Bearer`.
 * Both are the gateway's per-session token, never an upstream key.
 */
const readCredentialToken = (headers: NodeHttp.IncomingHttpHeaders): string | undefined => {
  const authorization = firstHeader(headers.authorization);
  if (authorization !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    const token = match?.[1]?.trim();
    if (token !== undefined && token.length > 0) return token;
  }
  const apiKey = firstHeader(headers["x-api-key"])?.trim();
  return apiKey !== undefined && apiKey.length > 0 ? apiKey : undefined;
};

const readBody = (request: NodeHttp.IncomingMessage): Promise<BodyReadResult> =>
  new Promise((resolve) => {
    const chunks: Array<Buffer> = [];
    let total = 0;
    let oversized = false;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        oversized = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () =>
      resolve(oversized ? { kind: "too-large" } : { kind: "ok", body: Buffer.concat(chunks) }),
    );
    request.on("error", () => resolve({ kind: "failed" }));
  });

const respondJson = (
  response: NodeHttp.ServerResponse,
  status: number,
  payload: Readonly<Record<string, string>>,
): void => {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.length),
  });
  response.end(body);
};

const relayableHeaders = (headers: NodeHttp.IncomingHttpHeaders): NodeHttp.OutgoingHttpHeaders => {
  const relayed: NodeHttp.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    relayed[name] = value;
  }
  return relayed;
};

const outboundHeaders = (
  inbound: NodeHttp.IncomingHttpHeaders,
  protocol: ModelGatewayProtocol,
  apiKey: string | undefined,
  contentLength: number,
): NodeHttp.OutgoingHttpHeaders => {
  const outbound: NodeHttp.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(inbound)) {
    if (value === undefined) continue;
    if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    outbound[name] = value;
  }
  outbound["content-length"] = String(contentLength);
  if (apiKey !== undefined) {
    if (modelGatewayProtocolCredentialHeader(protocol) === "x-api-key") {
      outbound["x-api-key"] = apiKey;
    } else {
      outbound.authorization = `Bearer ${apiKey}`;
    }
  }
  return outbound;
};

/**
 * The path the upstream is asked for.
 *
 * A Codex harness pointed at `<endpoint>/v1` sends `/v1/responses`, while a
 * configured base URL such as `https://api.deepseek.com/v1` already carries that
 * segment - concatenating both would ask for `/v1/v1/responses`. So the inbound
 * path loses its leading `/v1` exactly when the base URL ends with it, and is
 * passed through untouched otherwise. `MODEL_GATEWAY_PROTOCOL_PATHS` accepts both
 * forms, which is why this is the one place the two are reconciled.
 */
export const resolveModelGatewayUpstreamPath = (baseUrl: string, inboundPath: string): string => {
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, "");
  return basePath.endsWith("/v1") && inboundPath.startsWith("/v1/")
    ? inboundPath.slice("/v1".length)
    : inboundPath;
};

/**
 * The upstream model for one attempt.
 *
 * A route maps *requested* names onto *billing* names; an unmapped name passes
 * through. When the request names no model at all, the provider's `defaultModel`
 * is the one that goes out, which is what makes a bare harness usable.
 */
const resolveOutgoingModel = (
  provider: ModelGatewayProvider,
  route: ModelGatewayRoute,
  requestedModel: string,
): string => {
  if (requestedModel.length > 0) {
    return resolveModelGatewayUpstreamModel(route.modelMapping, requestedModel);
  }
  return provider.defaultModel;
};

/**
 * The request body as the upstream should receive it.
 *
 * Returns the original buffer untouched unless the outgoing model differs from
 * what the harness asked for - the single sanctioned modification, and the only
 * one this gateway makes to a request.
 */
const withUpstreamModel = (
  body: Buffer,
  parsedBody: Record<string, unknown>,
  outgoingModel: string,
): Buffer => {
  const requested = typeof parsedBody.model === "string" ? parsedBody.model : undefined;
  if (requested === outgoingModel) return body;
  if (requested === undefined && outgoingModel.length === 0) return body;
  return Buffer.from(JSON.stringify({ ...parsedBody, model: outgoingModel }), "utf8");
};

interface AttemptContext {
  readonly response: NodeHttp.ServerResponse;
  readonly inboundHeaders: NodeHttp.IncomingHttpHeaders;
  readonly protocol: ModelGatewayProtocol;
  readonly pathname: string;
  readonly search: string;
  readonly body: Buffer;
  readonly parsedBody: Record<string, unknown>;
}

/**
 * One upstream attempt: forward, commit if the answer is usable, and relay it.
 *
 * Never fails over itself and never records anything - it answers only with what
 * happened, so the caller owns the policy. That separation is what keeps
 * "may this be retried" a decision of the frozen contract rather than of this
 * function's control flow.
 */
const forwardAttempt = async (
  context: AttemptContext,
  input: {
    readonly provider: ModelGatewayProvider;
    readonly apiKey: string | undefined;
    readonly outgoingModel: string;
    readonly timeoutMs: number;
  },
  now: () => number,
): Promise<AttemptResult> => {
  const baseUrl = normalizeModelGatewayBaseUrl(input.provider.baseUrl);
  if (baseUrl === null) {
    // A base URL this gateway cannot parse is an unusable upstream, which is
    // exactly what the next one on the route is for.
    return {
      failure: "connection",
      status: null,
      committed: false,
      errorBody: null,
      errorHeaders: null,
      timeToFirstTokenMs: null,
      streamed: false,
      tokens: EMPTY_MODEL_GATEWAY_USAGE_TOKENS,
    };
  }

  const url = new URL(
    `${baseUrl}${resolveModelGatewayUpstreamPath(baseUrl, context.pathname)}${context.search}`,
  );
  const body = withUpstreamModel(context.body, context.parsedBody, input.outgoingModel);
  const headers = outboundHeaders(
    context.inboundHeaders,
    context.protocol,
    input.apiKey,
    body.length,
  );
  const requestFn = url.protocol === "https:" ? NodeHttps.request : NodeHttp.request;
  const attemptStartedAtMs = now();

  return await new Promise<AttemptResult>((resolve) => {
    let settled = false;
    let committed = false;
    let timedOut = false;
    let clientAborted = false;
    let gotResponse = false;
    let streamed = false;
    let timeToFirstTokenMs: number | null = null;
    let upstreamRequest: NodeHttp.ClientRequest | undefined;
    let extractor: ReturnType<typeof makeModelGatewayUsageExtractor> | undefined;

    const tokensNow = (): ModelGatewayUsageTokens =>
      extractor?.finish() ?? EMPTY_MODEL_GATEWAY_USAGE_TOKENS;

    const finish = (result: AttemptResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    /**
     * Why a transport-level failure happened. Anything after the first byte is
     * `response-committed`: the answer has begun, so it may not be replayed.
     */
    const transportFailure = (): ModelGatewayFailureClass =>
      clientAborted
        ? "client-aborted"
        : committed
          ? "response-committed"
          : timedOut
            ? "timeout"
            : "connection";

    const timer = setTimeout(() => {
      timedOut = true;
      upstreamRequest?.destroy();
    }, input.timeoutMs);

    // Nobody is listening any more, so there is nothing to fail over to, and the
    // upstream should stop working on an answer no one will read.
    context.response.on("close", () => {
      if (context.response.writableEnded) return;
      clientAborted = true;
      upstreamRequest?.destroy();
    });

    upstreamRequest = requestFn(url, { method: "POST", headers }, (upstreamResponse) => {
      gotResponse = true;
      const status = upstreamResponse.statusCode ?? 502;
      streamed = (firstHeader(upstreamResponse.headers["content-type"]) ?? "").includes(
        "text/event-stream",
      );
      extractor = makeModelGatewayUsageExtractor(context.protocol, { streamed });

      if (status >= 300) {
        // Not a success status, so nothing reaches the client yet and this
        // attempt may still be abandoned for the next upstream. The body is read
        // only so a failure that must *not* fail over (a 400, a 401) can be
        // surfaced verbatim. A 3xx is classified like any other non-success
        // status - the gateway follows no redirect, because the next hop would
        // leave the gateway and that is the open relay this is not.
        const chunks: Array<Buffer> = [];
        let total = 0;
        upstreamResponse.on("data", (chunk: Buffer) => {
          if (total >= MAX_ERROR_BODY_BYTES) return;
          total += chunk.length;
          chunks.push(chunk);
        });
        upstreamResponse.on("error", () => {
          /* `close` settles it. */
        });
        upstreamResponse.on("end", () =>
          finish({
            failure: classifyModelGatewayHttpStatus(status),
            status,
            committed: false,
            errorBody: Buffer.concat(chunks),
            errorHeaders: upstreamResponse.headers,
            timeToFirstTokenMs: null,
            streamed,
            tokens: tokensNow(),
          }),
        );
        upstreamResponse.on("close", () => {
          if (upstreamResponse.complete) return;
          finish({
            failure: transportFailure(),
            status: null,
            committed: false,
            errorBody: null,
            errorHeaders: null,
            timeToFirstTokenMs: null,
            streamed,
            tokens: tokensNow(),
          });
        });
        return;
      }

      // A success status is necessary but not sufficient to start the client's
      // response: the commit happens on the first body byte (or on a clean end, for
      // an answer that is legitimately empty). A 200 the upstream never follows
      // through on has reached nobody, so it may still be abandoned for the next
      // upstream; once a byte has gone out, nothing may be replayed.
      const commit = (): void => {
        if (committed) return;
        committed = true;
        context.response.writeHead(status, relayableHeaders(upstreamResponse.headers));
      };
      upstreamResponse.on("data", (chunk: Buffer) => {
        if (timeToFirstTokenMs === null) timeToFirstTokenMs = now() - attemptStartedAtMs;
        commit();
        extractor?.push(chunk);
        if (!context.response.write(chunk)) upstreamResponse.pause();
      });
      context.response.on("drain", () => upstreamResponse.resume());
      upstreamResponse.on("error", () => {
        /* `close` settles it. */
      });
      upstreamResponse.on("end", () => {
        commit();
        context.response.end();
        finish({
          failure: null,
          status,
          committed: true,
          errorBody: null,
          errorHeaders: null,
          timeToFirstTokenMs,
          streamed,
          tokens: tokensNow(),
        });
      });
      upstreamResponse.on("close", () => {
        if (upstreamResponse.complete) return;
        const failure = transportFailure();
        // A truncated answer is the honest signal: the client must not read a
        // complete response out of bytes that stopped arriving. Nothing was
        // written before the first chunk, so nothing is truncated in that case.
        if (committed && !context.response.writableEnded) context.response.destroy();
        finish({
          failure,
          status,
          committed,
          errorBody: null,
          errorHeaders: null,
          timeToFirstTokenMs,
          streamed,
          tokens: tokensNow(),
        });
      });
    });

    upstreamRequest.on("error", () => finish(failureWithoutResponse()));
    upstreamRequest.on("close", () => {
      if (!gotResponse) finish(failureWithoutResponse());
    });
    upstreamRequest.end(body);

    function failureWithoutResponse(): AttemptResult {
      return {
        failure: transportFailure(),
        status: null,
        committed: false,
        errorBody: null,
        errorHeaders: null,
        timeToFirstTokenMs: null,
        streamed,
        tokens: tokensNow(),
      };
    }
  });
};

/** The status a synthesized failure response carries when no upstream status exists. */
const responseStatusForFailure = (failure: ModelGatewayFailureClass): number => {
  switch (failure) {
    case "auth":
      return 401;
    case "quota-exhausted":
      return 402;
    case "not-found":
      return 404;
    case "invalid-request":
      return 400;
    case "rate-limited":
      return 429;
    case "timeout":
      return 504;
    case "overloaded":
    case "server-error":
      return 503;
    default:
      return 502;
  }
};

export const make = (deps: ModelGatewayProxyDeps): Effect.Effect<ModelGatewayProxyShape> => {
  const now = deps.now ?? Date.now;

  const handleRequest = async (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ): Promise<void> => {
    const receivedAtMs = now();

    // Loopback is not trust: an unknown token is refused here, before anything
    // about the request is parsed and long before an upstream is contacted.
    const token = readCredentialToken(request.headers);
    if (token === undefined) {
      respondJson(response, 401, { error: "unauthorized" });
      return;
    }
    const scope = await deps.resolveCredential(token);
    if (scope === undefined) {
      respondJson(response, 401, { error: "unauthorized" });
      return;
    }

    const config = await deps.loadConfig();
    const route = config.routes[scope.routeId];
    if (route === undefined || !route.enabled) {
      respondJson(response, 404, { error: "route-not-found" });
      return;
    }
    const protocol = resolveModelGatewayRouteProtocol(route, config.providers);
    if (protocol === undefined) {
      respondJson(response, 404, { error: "no-usable-upstream" });
      return;
    }

    // The allow-list is the route's own protocol: nothing else is carried, so
    // this listener cannot be used as a relay to whatever the upstream serves.
    const target = new URL(request.url ?? "/", "http://127.0.0.1");
    if (
      request.method !== "POST" ||
      !MODEL_GATEWAY_PROTOCOL_PATHS[protocol].includes(target.pathname)
    ) {
      respondJson(response, 404, { error: "not-carried" });
      return;
    }

    const read = await readBody(request);
    if (read.kind !== "ok") {
      respondJson(response, read.kind === "too-large" ? 413 : 400, { error: "invalid-request" });
      return;
    }
    const parsedBody = parseJsonObject(read.body);
    if (parsedBody === undefined) {
      respondJson(response, 400, { error: "invalid-request" });
      return;
    }

    const requestedModel = typeof parsedBody.model === "string" ? parsedBody.model : "";
    const plan = planModelGatewayAttempts({
      route,
      providers: config.providers,
      isAvailable: (providerId) => deps.breaker.mayAttempt(providerId, now()),
    });
    if (plan.attempts.length === 0) {
      respondJson(response, 502, { error: "no-usable-upstream" });
      return;
    }

    const attempts: Array<string> = [];
    let servedBy: ModelGatewayProvider | undefined;
    let attempted: ModelGatewayProvider | undefined;
    let upstreamModel = requestedModel;
    let failure: ModelGatewayFailureClass | null = null;
    let upstreamStatus: number | null = null;
    let streamed = false;
    let timeToFirstTokenMs: number | null = null;
    let tokens: ModelGatewayUsageTokens = EMPTY_MODEL_GATEWAY_USAGE_TOKENS;

    const context: AttemptContext = {
      response,
      inboundHeaders: request.headers,
      protocol,
      pathname: target.pathname,
      search: target.search,
      body: read.body,
      parsedBody,
    };

    // One pass over the route's ordered upstreams, each at most once. There is
    // no same-provider retry and no loop beyond this list.
    let attemptedCount = 0;
    for (const planned of plan.ordered) {
      // An upstream that was skipped - because its protocol is not the route's, or
      // because the breaker is cooling it - is still part of the story the row
      // tells. Only upstreams actually called count as attempts.
      if (planned.kind !== "upstream") {
        attempts.push(modelGatewayAttemptLabel(planned.providerId, planned.kind));
        continue;
      }
      attemptedCount += 1;
      const provider = planned.provider;
      const apiKey = await deps.loadApiKey(provider.id);
      const outgoingModel = resolveOutgoingModel(provider, route, requestedModel);
      deps.breaker.beginAttempt(provider.id, now());

      const result = await forwardAttempt(
        context,
        { provider, apiKey, outgoingModel, timeoutMs: config.requestTimeoutMs },
        now,
      );

      attempted = provider;
      upstreamModel = outgoingModel;
      upstreamStatus = result.status;
      streamed = result.streamed;
      timeToFirstTokenMs = result.timeToFirstTokenMs;
      tokens = result.tokens;

      if (result.failure === null) {
        deps.breaker.recordSuccess(provider.id);
        attempts.push(modelGatewayAttemptLabel(provider.id, "success"));
        servedBy = provider;
        failure = null;
        break;
      }

      attempts.push(modelGatewayAttemptLabel(provider.id, result.failure));
      failure = result.failure;
      deps.breaker.recordFailure(provider.id, result.failure, {
        nowMs: now(),
        baseCooldownMs: config.cooldownMs,
      });

      // The duplicate-side-effect guarantee: bytes have already reached the
      // client, so this answer may not be replayed onto a backup.
      if (result.committed) break;

      if (!shouldFailoverForFailureClass(result.failure)) {
        if (
          result.status !== null &&
          result.errorBody !== null &&
          result.errorHeaders !== null &&
          !response.headersSent
        ) {
          response.writeHead(result.status, relayableHeaders(result.errorHeaders));
          response.end(result.errorBody);
        } else {
          respondJson(response, responseStatusForFailure(result.failure), {
            error: result.failure,
          });
        }
        break;
      }
    }

    if (!response.writableEnded && !response.destroyed) {
      respondJson(response, responseStatusForFailure(failure ?? "server-error"), {
        error: failure ?? "server-error",
      });
    }

    const servingProvider = servedBy ?? attempted;
    if (servingProvider === undefined) return;

    await deps
      .recordUsage({
        id: randomUUID(),
        recordedAt: new Date(now()).toISOString(),
        threadId: scope.threadId,
        providerInstanceId: scope.providerInstanceId,
        routeId: scope.routeId,
        protocol,
        requestedModel,
        upstreamModel,
        servedByProviderId: servingProvider.id,
        attempts,
        // A failover happened when a second upstream was actually called, not
        // merely because a skipped one is listed.
        failedOver: attemptedCount > 1,
        status: servedBy === undefined ? "failed" : "success",
        failureClass: servedBy === undefined ? failure : null,
        upstreamHttpStatus: upstreamStatus,
        streamed,
        latencyMs: Math.max(0, Math.round(now() - receivedAtMs)),
        timeToFirstTokenMs,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cacheReadTokens: tokens.cacheReadTokens,
        cacheWriteTokens: tokens.cacheWriteTokens,
        reasoningTokens: tokens.reasoningTokens,
      })
      .catch(() => {
        // A usage row that cannot be written is telemetry loss, not a request
        // failure: the answer has already been delivered.
      });
  };

  let server: NodeHttp.Server | undefined;
  let endpoint: string | undefined;

  const start = Effect.tryPromise({
    try: async (): Promise<string> => {
      if (server !== undefined && endpoint !== undefined) return endpoint;
      const created = guardHttpResponseWriteErrors(
        NodeHttp.createServer((request, response) => {
          handleRequest(request, response).catch(() => {
            respondJson(response, 502, { error: "gateway-failure" });
          });
        }),
      );
      const bound = await new Promise<string>((resolve, reject) => {
        created.once("error", reject);
        // Port 0 on 127.0.0.1, never 0.0.0.0: this listener exists for harnesses
        // on this machine and for nothing else.
        created.listen(0, "127.0.0.1", () => {
          const address = created.address();
          if (address === null || typeof address === "string") {
            created.close();
            reject(new Error("the gateway did not receive a loopback TCP address"));
            return;
          }
          resolve(`http://127.0.0.1:${address.port}`);
        });
      });
      server = created;
      endpoint = bound;
      return bound;
    },
    catch: (cause) => new ModelGatewayBindError({ cause }),
  });

  const stop = Effect.promise<void>(
    () =>
      new Promise((resolve) => {
        const current = server;
        server = undefined;
        endpoint = undefined;
        if (current === undefined) {
          resolve();
          return;
        }
        const withIdleClose = current as NodeHttp.Server & {
          closeIdleConnections?: () => void;
        };
        current.close(() => resolve());
        // Idle keep-alive sockets would otherwise hold the listener open long
        // after the last request; in-flight work is left alone.
        withIdleClose.closeIdleConnections?.();
      }),
  );

  return Effect.succeed({
    start,
    stop,
    get endpoint() {
      return endpoint;
    },
  });
};
