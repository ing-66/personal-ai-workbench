// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off - the point of this test is real loopback node:http upstreams driven through a real HTTP client, asserting raw wire bodies.
import { assert, it } from "@effect/vitest";
import {
  ModelGatewayProvider,
  ModelGatewayRoute,
  ModelProviderId,
  ModelRouteId,
  ProviderInstanceId,
  ThreadId,
  type ModelGatewayProtocol,
  type ModelGatewayUsageRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeHttp from "node:http";

import {
  makeModelGatewayCircuitBreaker,
  type ModelGatewayCircuitBreakerShape,
} from "./ModelGatewayCircuitBreaker.ts";
import { make as makeModelGatewayProxy, type ModelGatewayProxyShape } from "./ModelGatewayProxy.ts";

const SESSION_TOKEN = "session-bearer-9f3a";
const PRIMARY_ID = ModelProviderId.make("primary");
const ROUTE_ID = "route-1";
const ROUTE = ModelRouteId.make(ROUTE_ID);

const decodeProvider = Schema.decodeSync(ModelGatewayProvider);
const decodeRoute = Schema.decodeSync(ModelGatewayRoute);

interface UpstreamHit {
  readonly path: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

type Responder = (input: {
  readonly request: NodeHttp.IncomingMessage;
  readonly response: NodeHttp.ServerResponse;
  readonly hit: UpstreamHit;
}) => void;

interface Upstream {
  readonly baseUrl: string;
  readonly hits: Array<UpstreamHit>;
  readonly close: () => Promise<void>;
}

const closeServer = (server: NodeHttp.Server): Promise<void> =>
  new Promise((resolve) => {
    const withIdleClose = server as NodeHttp.Server & { closeIdleConnections?: () => void };
    server.close(() => resolve());
    withIdleClose.closeIdleConnections?.();
  });

/** A real upstream on an ephemeral loopback port, recording exactly what it received. */
const startUpstream = (respond: Responder): Promise<Upstream> =>
  new Promise((resolve, reject) => {
    const hits: Array<UpstreamHit> = [];
    const server = NodeHttp.createServer((request, response) => {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const hit: UpstreamHit = {
          path: request.url ?? "",
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        hits.push(hit);
        respond({ request, response, hit });
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the fixture upstream did not receive a loopback address"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        hits,
        close: () => closeServer(server),
      });
    });
  });

const json = (response: NodeHttp.ServerResponse, status: number, body: unknown): void => {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(payload.length),
  });
  response.end(payload);
};

const sse = (response: NodeHttp.ServerResponse, body: string): void => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(body);
};

interface HarnessSpec {
  readonly upstreams: Readonly<Record<string, Responder>>;
  readonly primary: string;
  readonly backups?: ReadonlyArray<string>;
  readonly apiKeys?: Readonly<Record<string, string>>;
  readonly protocol?: ModelGatewayProtocol;
  /** One provider's protocol, when a test needs a heterogeneous (invalid) route. */
  readonly providerProtocols?: Readonly<Record<string, ModelGatewayProtocol>>;
  readonly modelMapping?: Readonly<Record<string, string>>;
  readonly failoverEnabled?: boolean;
  readonly requestTimeoutMs?: number;
  readonly breaker?: ModelGatewayCircuitBreakerShape;
  readonly now?: () => number;
}

interface Harness {
  readonly endpoint: string;
  readonly token: string;
  readonly proxy: ModelGatewayProxyShape;
  readonly recorded: Array<ModelGatewayUsageRecord>;
  readonly breaker: ModelGatewayCircuitBreakerShape;
  readonly upstreams: Readonly<Record<string, Upstream>>;
  readonly awaitRow: () => Promise<ModelGatewayUsageRecord>;
  readonly post: (input: {
    readonly path: string;
    readonly body: unknown;
    readonly token?: string;
    readonly headerName?: "authorization" | "x-api-key";
    readonly method?: string;
  }) => Promise<Response>;
  readonly dispose: () => Promise<void>;
}

const startHarness = async (spec: HarnessSpec): Promise<Harness> => {
  const upstreams: Record<string, Upstream> = {};
  for (const [id, respond] of Object.entries(spec.upstreams)) {
    upstreams[id] = await startUpstream(respond);
  }
  const protocol = spec.protocol ?? "openai-responses";
  const providers: Record<string, ModelGatewayProvider> = {};
  for (const [id, upstream] of Object.entries(upstreams)) {
    providers[id] = decodeProvider({
      id,
      name: id,
      protocol: spec.providerProtocols?.[id] ?? protocol,
      baseUrl: upstream.baseUrl,
      enabled: true,
    });
  }
  const route = decodeRoute({
    id: ROUTE_ID,
    name: "route",
    primaryProviderId: spec.primary,
    backupProviderIds: spec.backups ?? [],
    modelMapping: spec.modelMapping ?? {},
    failoverEnabled: spec.failoverEnabled ?? true,
  });

  const recorded: Array<ModelGatewayUsageRecord> = [];
  const waiters: Array<(row: ModelGatewayUsageRecord) => void> = [];
  const breaker = spec.breaker ?? makeModelGatewayCircuitBreaker();

  const proxy = await Effect.runPromise(
    makeModelGatewayProxy({
      resolveCredential: async (candidate) =>
        candidate === SESSION_TOKEN
          ? {
              threadId: ThreadId.make("thread-1"),
              providerInstanceId: ProviderInstanceId.make("codex-1"),
              routeId: ROUTE,
            }
          : undefined,
      loadConfig: async () => ({
        providers,
        routes: { [ROUTE_ID]: route },
        requestTimeoutMs: spec.requestTimeoutMs ?? 5_000,
        cooldownMs: 30_000,
        usageRetentionDays: 30,
      }),
      loadApiKey: async (providerId) => spec.apiKeys?.[providerId],
      recordUsage: async (row) => {
        recorded.push(row);
        waiters.shift()?.(row);
      },
      breaker,
      ...(spec.now === undefined ? {} : { now: spec.now }),
    }),
  );
  const endpoint = await Effect.runPromise(proxy.start);

  return {
    endpoint,
    token: SESSION_TOKEN,
    proxy,
    recorded,
    breaker,
    upstreams,
    awaitRow: () =>
      new Promise((resolve) => {
        const existing = recorded[0];
        if (existing !== undefined) {
          resolve(existing);
          return;
        }
        waiters.push(resolve);
      }),
    post: (input) => {
      const bearer = input.token ?? SESSION_TOKEN;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (input.headerName === "x-api-key") headers["x-api-key"] = bearer;
      else headers.authorization = `Bearer ${bearer}`;
      const method = input.method ?? "POST";
      return fetch(`${endpoint}${input.path}`, {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(input.body) } : {}),
      });
    },
    dispose: async () => {
      await Effect.runPromise(proxy.stop);
      for (const upstream of Object.values(upstreams)) await upstream.close();
    },
  };
};

/** Run a body with a live harness, disposing it however the body ends. */
const withHarness = <A>(
  spec: HarnessSpec,
  body: (harness: Harness) => Effect.Effect<A>,
): Effect.Effect<A> =>
  Effect.promise(() => startHarness(spec)).pipe(
    Effect.flatMap((harness) =>
      body(harness).pipe(Effect.ensuring(Effect.promise(() => harness.dispose()))),
    ),
  );

const readBody = (response: Response): Promise<string> => response.text().catch(() => "");

const RESPONSES_STREAM = [
  'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","name":"read_file","arguments":""}}\n\n',
  'data: {"type":"response.function_call_arguments.done","item_id":"fc_1","arguments":"{\\"path\\":\\"a.txt\\"}"}\n\n',
  'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":1200,"output_tokens":45,"input_tokens_details":{"cached_tokens":800},"output_tokens_details":{"reasoning_tokens":12}}}}\n\n',
  "data: [DONE]\n\n",
].join("");

const CHAT_TOOL_STREAM = [
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"write_file","arguments":""}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"x\\"}"}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":4}}}\n\n',
  "data: [DONE]\n\n",
].join("");

const ANTHROPIC_STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":300,"cache_read_input_tokens":200,"cache_creation_input_tokens":50}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

it.effect("listens on loopback only, on an ephemeral port, and start is idempotent", () =>
  withHarness({ upstreams: { primary: () => undefined }, primary: "primary" }, (harness) =>
    Effect.gen(function* () {
      assert.isTrue(harness.endpoint.startsWith("http://127.0.0.1:"));
      assert.isFalse(harness.endpoint.includes("0.0.0.0"));
      const again = yield* Effect.promise(() => Effect.runPromise(harness.proxy.start));
      assert.strictEqual(again, harness.endpoint);
    }),
  ),
);

it.effect("forwards a streamed response byte-for-byte", () =>
  withHarness(
    {
      upstreams: { primary: ({ response }) => sse(response, RESPONSES_STREAM) },
      primary: "primary",
      apiKeys: { primary: "upstream-key-primary" },
    },
    (harness) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          harness.post({
            path: "/v1/responses",
            body: { model: "asked-for", input: "SENTINEL-PROMPT-9f3a" },
          }),
        );
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get("content-type"), "text/event-stream");
        assert.strictEqual(yield* Effect.promise(() => readBody(response)), RESPONSES_STREAM);

        const [hit] = harness.upstreams.primary!.hits;
        assert.strictEqual(hit?.path, "/v1/responses");
        // The inbound per-session bearer is replaced with the upstream's own key.
        assert.strictEqual(hit?.headers.authorization, "Bearer upstream-key-primary");
        assert.isFalse(JSON.stringify(hit?.headers ?? {}).includes(SESSION_TOKEN));
      }),
  ),
);

it.effect("fails over to the backup on a 500, once, and records both", () =>
  withHarness(
    {
      upstreams: {
        primary: ({ response }) => json(response, 500, { error: "upstream exploded" }),
        backup: ({ response }) => json(response, 200, { ok: true, served: "backup" }),
      },
      primary: "primary",
      backups: ["backup"],
      apiKeys: { primary: "k1", backup: "k2" },
    },
    (harness) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          harness.post({ path: "/v1/responses", body: { model: "asked-for" } }),
        );
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
          ok: true,
          served: "backup",
        });
        assert.strictEqual(harness.upstreams.primary!.hits.length, 1, "no same-provider retry");
        assert.strictEqual(harness.upstreams.backup!.hits.length, 1);

        const row = yield* Effect.promise(() => harness.awaitRow());
        assert.deepStrictEqual(row.attempts, ["primary:server-error", "backup:success"]);
        assert.isTrue(row.failedOver);
        assert.strictEqual(row.status, "success");
        assert.strictEqual(row.servedByProviderId, "backup");
        assert.strictEqual(row.failureClass, null);
        assert.strictEqual(row.upstreamHttpStatus, 200);
      }),
  ),
);

it.effect("does not fail over on a 400 and surfaces the upstream's answer", () =>
  withHarness(
    {
      upstreams: {
        primary: ({ response }) => json(response, 400, { error: "bad model" }),
        backup: ({ response }) => json(response, 200, { ok: true }),
      },
      primary: "primary",
      backups: ["backup"],
    },
    (harness) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          harness.post({ path: "/v1/responses", body: { model: "asked-for" } }),
        );
        assert.strictEqual(response.status, 400);
        assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
          error: "bad model",
        });
        assert.strictEqual(harness.upstreams.backup!.hits.length, 0, "400 is not a failover case");

        const row = yield* Effect.promise(() => harness.awaitRow());
        assert.deepStrictEqual(row.attempts, ["primary:invalid-request"]);
        assert.isFalse(row.failedOver);
        assert.strictEqual(row.status, "failed");
        assert.strictEqual(row.failureClass, "invalid-request");
        assert.strictEqual(row.upstreamHttpStatus, 400);
      }),
  ),
);

it.effect("does not fail over on a 401 and never leaks a key", () =>
  withHarness(
    {
      upstreams: {
        primary: ({ response }) =>
          json(response, 401, { error: "invalid api key: upstream-key-primary" }),
        backup: ({ response }) => json(response, 200, { ok: true }),
      },
      primary: "primary",
      backups: ["backup"],
      apiKeys: { primary: "upstream-key-primary", backup: "upstream-key-backup" },
    },
    (harness) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          harness.post({ path: "/v1/responses", body: { model: "asked-for" } }),
        );
        assert.strictEqual(response.status, 401);
        // The upstream's own body is surfaced, but the *session bearer* is not in it.
        assert.isFalse((yield* Effect.promise(() => readBody(response))).includes(SESSION_TOKEN));
        assert.strictEqual(harness.upstreams.backup!.hits.length, 0, "401 is a config error");

        const row = yield* Effect.promise(() => harness.awaitRow());
        assert.deepStrictEqual(row.attempts, ["primary:auth"]);
        assert.strictEqual(row.failureClass, "auth");
        assert.isFalse(JSON.stringify(row).includes("upstream-key-primary"));
        assert.isFalse(JSON.stringify(row).includes(SESSION_TOKEN));
      }),
  ),
);

it.effect("fails over on a 429", () =>
  withHarness(
    {
      upstreams: {
        primary: ({ response }) => json(response, 429, { error: "slow down" }),
        backup: ({ response }) => json(response, 200, { ok: true }),
      },
      primary: "primary",
      backups: ["backup"],
    },
    (harness) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          harness.post({ path: "/v1/responses", body: { model: "asked-for" } }),
        );
        assert.strictEqual(response.status, 200);
        const row = yield* Effect.promise(() => harness.awaitRow());
        assert.deepStrictEqual(row.attempts, ["primary:rate-limited", "backup:success"]);
        // A 429 counts against the upstream's health, unlike a 400.
        assert.strictEqual(
          harness.breaker.health({
            providerIds: [PRIMARY_ID],
            disabledProviderIds: new Set<string>(),
            nowMs: 0,
          })[0]?.consecutiveFailures,
          1,
        );
      }),
  ),
);

it.effect(
  "carries a streamed tool call with its id, name, arguments and finish reason intact",
  () =>
    withHarness(
      {
        upstreams: { primary: ({ response }) => sse(response, CHAT_TOOL_STREAM) },
        primary: "primary",
        protocol: "openai-chat",
      },
      (harness) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            harness.post({
              path: "/v1/chat/completions",
              body: { model: "asked-for", tools: [{ type: "function" }] },
            }),
          );
          const text = yield* Effect.promise(() => readBody(response));
          assert.strictEqual(text, CHAT_TOOL_STREAM);

          const events = text
            .split("\n")
            .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
            .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
          const first = events[0]?.choices as Array<Record<string, unknown>>;
          const delta = (first?.[0]?.delta ?? {}) as {
            tool_calls?: Array<Record<string, unknown>>;
          };
          const call = delta.tool_calls?.[0] as
            | { id?: string; function?: { name?: string } }
            | undefined;
          assert.strictEqual(call?.id, "call_abc");
          assert.strictEqual(call?.function?.name, "write_file");
          const last = events[2]?.choices as Array<Record<string, unknown>>;
          assert.strictEqual(last?.[0]?.finish_reason, "tool_calls");

          const [hit] = harness.upstreams.primary!.hits;
          assert.strictEqual(hit?.path, "/v1/chat/completions");
        }),
    ),
);

it.effect("fails over when the upstream drops the connection before answering", () =>
  withHarness(
    {
      upstreams: {
        primary: ({ request }) => request.socket.destroy(),
        backup: ({ response }) => json(response, 200, { ok: true, served: "backup" }),
      },
      primary: "primary",
      backups: ["backup"],
    },
    (harness) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          harness.post({ path: "/v1/responses", body: { model: "asked-for" } }),
        );
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
          ok: true,
          served: "backup",
        });
        const row = yield* Effect.promise(() => harness.awaitRow());
        assert.deepStrictEqual(row.attempts, ["primary:connection", "backup:success"]);
      }),
  ),
);

it.effect("fails over when the upstream sends headers but no body at all", () =>
  withHarness(
    {
      upstreams: {
        primary: ({ response }) => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.flushHeaders();
          response.destroy();
        },
        backup: ({ response }) => json(response, 200, { ok: true, served: "backup" }),
      },
      primary: "primary",
      backups: ["backup"],
    },
    (harness) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          harness.post({ path: "/v1/responses", body: { model: "asked-for" } }),
        );
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
          ok: true,
          served: "backup",
        });

        const row = yield* Effect.promise(() => harness.awaitRow());
        assert.deepStrictEqual(row.attempts, ["primary:connection", "backup:success"]);
        assert.strictEqual(harness.upstreams.backup!.hits.length, 1);
      }),
  ),
);

it.effect("never replays a failure that happened after the first byte", () =>
  withHarness(
    {
      upstreams: {
        primary: ({ response }) => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n', () =>
            response.destroy(),
          );
        },
        backup: ({ response }) => json(response, 200, { ok: true, served: "backup" }),
      },
      primary: "primary",
      backups: ["backup"],
    },
    (harness) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          harness.post({ path: "/v1/responses", body: { model: "asked-for" } }),
        );
        assert.strictEqual(response.status, 200);
        const text = yield* Effect.promise(() => readBody(response));
        assert.isFalse(text.includes("served"));

        const row = yield* Effect.promise(() => harness.awaitRow());
        assert.deepStrictEqual(
          row.attempts,
          ["primary:response-committed"],
          "the duplicate-side-effect guarantee",
        );
        assert.strictEqual(row.status, "failed");
        assert.strictEqual(row.failureClass, "response-committed");
        assert.strictEqual(row.servedByProviderId, "primary");
        assert.strictEqual(
          harness.upstreams.backup!.hits.length,
          0,
          "a committed response is never replayed onto a backup",
        );
      }),
  ),
);

it.effect("refuses an unknown bearer with a 401 before contacting any upstream", () =>
  withHarness(
    {
      upstreams: { primary: ({ response }) => json(response, 200, { ok: true }) },
      primary: "primary",
    },
    (harness) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          harness.post({
            path: "/v1/responses",
            body: { model: "asked-for" },
            token: "not-a-token",
          }),
        );
        assert.strictEqual(response.status, 401);
        assert.strictEqual(harness.upstreams.primary!.hits.length, 0);
        assert.strictEqual(harness.recorded.length, 0);
      }),
  ),
);

it.effect("carries only the paths the route's protocol serves", () =>
  withHarness(
    {
      upstreams: { primary: ({ response }) => json(response, 200, { ok: true }) },
      primary: "primary",
    },
    (harness) =>
      Effect.gen(function* () {
        const wrongProtocol = yield* Effect.promise(() =>
          harness.post({ path: "/v1/messages", body: { model: "asked-for" } }),
        );
        assert.strictEqual(wrongProtocol.status, 404, "an anthropic path on an OpenAI route");

        const notAnEndpoint = yield* Effect.promise(() =>
          harness.post({ path: "/v1/embeddings", body: { model: "asked-for" } }),
        );
        assert.strictEqual(notAnEndpoint.status, 404);

        const probe = yield* Effect.promise(() =>
          harness.post({ path: "/v1/models", body: { model: "asked-for" }, method: "GET" }),
        );
        assert.strictEqual(probe.status, 404);

        assert.strictEqual(harness.upstreams.primary!.hits.length, 0, "no open relay");
        assert.strictEqual(harness.recorded.length, 0);
      }),
  ),
);

it.effect("maps the model field when the route maps it, and only then", () =>
  withHarness(
    {
      upstreams: { primary: ({ response }) => json(response, 200, { ok: true }) },
      primary: "primary",
      modelMapping: { "asked-for": "billed-for" },
    },
    (harness) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          harness.post({
            path: "/v1/responses",
            body: { model: "asked-for", input: "SENTINEL-PROMPT-9f3a", max_output_tokens: 12 },
          }),
        );
        assert.strictEqual(response.status, 200);
        const [hit] = harness.upstreams.primary!.hits;
        const forwarded = JSON.parse(hit?.body ?? "{}") as Record<string, unknown>;
        assert.strictEqual(forwarded.model, "billed-for");
        // Everything else in the body survives untouched.
        assert.strictEqual(forwarded.input, "SENTINEL-PROMPT-9f3a");
        assert.strictEqual(forwarded.max_output_tokens, 12);

        const row = yield* Effect.promise(() => harness.awaitRow());
        assert.strictEqual(row.requestedModel, "asked-for");
        assert.strictEqual(row.upstreamModel, "billed-for");
        // The one thing a usage row must never carry.
        assert.isFalse(JSON.stringify(row).includes("SENTINEL-PROMPT-9f3a"));
      }),
  ),
);

it.effect("reads anthropic usage from message_start and message_delta", () =>
  withHarness(
    {
      upstreams: { primary: ({ response }) => sse(response, ANTHROPIC_STREAM) },
      primary: "primary",
      protocol: "anthropic-messages",
      apiKeys: { primary: "anthropic-upstream-key" },
    },
    (harness) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          harness.post({
            path: "/v1/messages",
            body: { model: "claude-x" },
            headerName: "x-api-key",
          }),
        );
        assert.strictEqual(response.status, 200);
        assert.strictEqual(yield* Effect.promise(() => readBody(response)), ANTHROPIC_STREAM);
        const [hit] = harness.upstreams.primary!.hits;
        // The Anthropic slot is replaced with the upstream's own key, not the bearer.
        assert.strictEqual(hit?.headers["x-api-key"], "anthropic-upstream-key");
        assert.isFalse(JSON.stringify(hit?.headers ?? {}).includes(SESSION_TOKEN));

        const row = yield* Effect.promise(() => harness.awaitRow());
        assert.strictEqual(row.inputTokens, 300);
        assert.strictEqual(row.outputTokens, 25);
        assert.strictEqual(row.cacheReadTokens, 200);
        assert.strictEqual(row.cacheWriteTokens, 50);
        assert.isNull(row.reasoningTokens);
        assert.isTrue(row.streamed);
        assert.isTrue(row.timeToFirstTokenMs !== null && row.timeToFirstTokenMs >= 0);
        assert.isTrue(row.latencyMs >= 0);
      }),
  ),
);

it.effect("reads openai-responses usage, including reasoning and cached tokens", () =>
  withHarness(
    {
      upstreams: { primary: ({ response }) => sse(response, RESPONSES_STREAM) },
      primary: "primary",
    },
    (harness) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          harness.post({ path: "/v1/responses", body: { model: "asked-for" } }),
        );
        assert.strictEqual(response.status, 200);
        const row = yield* Effect.promise(() => harness.awaitRow());
        assert.strictEqual(row.inputTokens, 1_200);
        assert.strictEqual(row.outputTokens, 45);
        assert.strictEqual(row.cacheReadTokens, 800);
        assert.strictEqual(row.reasoningTokens, 12);
        assert.isNull(row.cacheWriteTokens);
        assert.strictEqual(row.protocol, "openai-responses");
      }),
  ),
);

it.effect("leaves token counts null when the upstream reports no usage", () =>
  withHarness(
    {
      upstreams: {
        primary: ({ response }) => sse(response, 'data: {"type":"response.output_text.delta"}\n\n'),
      },
      primary: "primary",
    },
    (harness) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          harness.post({ path: "/v1/responses", body: { model: "asked-for" } }),
        );
        const row = yield* Effect.promise(() => harness.awaitRow());
        assert.isNull(row.inputTokens);
        assert.isNull(row.outputTokens);
        assert.isNull(row.cacheReadTokens);
        assert.isNull(row.cacheWriteTokens);
        assert.isNull(row.reasoningTokens);
      }),
  ),
);

it.effect("fails closed on a route whose backup speaks another protocol", () =>
  withHarness(
    {
      upstreams: {
        primary: ({ response }) => json(response, 500, { error: "upstream exploded" }),
        "backup-a": ({ response }) => json(response, 200, { ok: true, served: "backup-a" }),
      },
      primary: "primary",
      backups: ["backup-a"],
      protocol: "openai-responses",
      // A route like this can only come from settings written by an older build,
      // a hand-edited file, or a bad merge: the save-time rule rejects it, and
      // this is the runtime half that must hold when that rule was skipped. An
      // OpenAI-shaped request must not reach an Anthropic endpoint.
      providerProtocols: { "backup-a": "anthropic-messages" },
    },
    (harness) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          harness.post({ path: "/v1/responses", body: { model: "asked-for" } }),
        );
        // The last failure was a server error and there was nowhere left to go, so
        // the client is told that rather than being handed the backup's answer.
        assert.strictEqual(response.status, 503);
        assert.strictEqual(
          harness.upstreams["backup-a"]!.hits.length,
          0,
          "the mismatched upstream is never contacted",
        );
        assert.strictEqual(harness.upstreams.primary!.hits.length, 1);

        const row = yield* Effect.promise(() => harness.awaitRow());
        assert.deepStrictEqual(row.attempts, [
          "primary:server-error",
          "backup-a:protocol-mismatch",
        ]);
        assert.strictEqual(row.status, "failed");
        assert.strictEqual(row.servedByProviderId, "primary");
        assert.isFalse(row.failedOver, "nothing was abandoned for another upstream");
      }),
  ),
);

it.effect("skips an upstream the breaker is cooling and says so in the row", () =>
  withHarness(
    {
      upstreams: {
        primary: ({ response }) => json(response, 200, { ok: true, served: "primary" }),
        backup: ({ response }) => json(response, 200, { ok: true, served: "backup" }),
      },
      primary: "primary",
      backups: ["backup"],
      // A frozen clock so the cooldown recorded here is the one the request sees.
      now: () => 0,
    },
    (harness) =>
      Effect.gen(function* () {
        for (let index = 0; index < 3; index += 1) {
          harness.breaker.recordFailure(PRIMARY_ID, "server-error", {
            nowMs: 0,
            baseCooldownMs: 30_000,
          });
        }
        const response = yield* Effect.promise(() =>
          harness.post({ path: "/v1/responses", body: { model: "asked-for" } }),
        );
        assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
          ok: true,
          served: "backup",
        });
        assert.strictEqual(harness.upstreams.primary!.hits.length, 0);

        const row = yield* Effect.promise(() => harness.awaitRow());
        assert.deepStrictEqual(row.attempts, ["primary:breaker-open", "backup:success"]);
        assert.strictEqual(row.servedByProviderId, "backup");
      }),
  ),
);

it.effect("rejects a body it cannot read as JSON without contacting an upstream", () =>
  withHarness(
    {
      upstreams: { primary: ({ response }) => json(response, 200, { ok: true }) },
      primary: "primary",
    },
    (harness) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          fetch(`${harness.endpoint}/v1/responses`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${SESSION_TOKEN}`,
              "content-type": "application/json",
            },
            body: "not json at all",
          }),
        );
        assert.strictEqual(response.status, 400);
        assert.strictEqual(harness.upstreams.primary!.hits.length, 0);
      }),
  ),
);

it.effect("times out an upstream that never answers, before anything is committed", () =>
  withHarness(
    {
      upstreams: {
        primary: () => undefined,
        backup: ({ response }) => json(response, 200, { ok: true, served: "backup" }),
      },
      primary: "primary",
      backups: ["backup"],
      requestTimeoutMs: 50,
    },
    (harness) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          harness.post({ path: "/v1/responses", body: { model: "asked-for" } }),
        );
        assert.strictEqual(response.status, 200);
        const row = yield* Effect.promise(() => harness.awaitRow());
        assert.deepStrictEqual(row.attempts, ["primary:timeout", "backup:success"]);
      }),
  ),
);
