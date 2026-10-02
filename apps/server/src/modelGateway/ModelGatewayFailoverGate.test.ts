// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off - this test drives real loopback node:http upstreams through the real proxy, asserting what each upstream was actually asked for.
import { assert, it } from "@effect/vitest";
import {
  ModelGatewayProvider,
  ModelGatewayRoute,
  ModelRouteId,
  ProviderInstanceId,
  ThreadId,
  type ModelGatewayProtocol,
  type ModelGatewayUsageRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeHttp from "node:http";

import { makeModelGatewayCircuitBreaker } from "./ModelGatewayCircuitBreaker.ts";
import { make as makeModelGatewayProxy } from "./ModelGatewayProxy.ts";

const SESSION_TOKEN = "session-bearer-9f3a";
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

/** A real upstream on an ephemeral loopback port, counting exactly what it was asked for. */
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
        respond({ response, hit });
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

interface HarnessSpec {
  readonly upstreams: Readonly<Record<string, Responder>>;
  readonly primary: string;
  readonly backups?: ReadonlyArray<string>;
  readonly apiKeys?: Readonly<Record<string, string>>;
  readonly protocol?: ModelGatewayProtocol;
  readonly requestTimeoutMs?: number;
}

interface Harness {
  readonly endpoint: string;
  readonly recorded: Array<ModelGatewayUsageRecord>;
  readonly upstreams: Readonly<Record<string, Upstream>>;
  readonly awaitRow: () => Promise<ModelGatewayUsageRecord>;
  readonly post: (input: { readonly path: string; readonly body: unknown }) => Promise<Response>;
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
      protocol,
      baseUrl: upstream.baseUrl,
      enabled: true,
    });
  }
  const route = decodeRoute({
    id: ROUTE_ID,
    name: "route",
    primaryProviderId: spec.primary,
    backupProviderIds: spec.backups ?? [],
    modelMapping: {},
    failoverEnabled: true,
  });

  const recorded: Array<ModelGatewayUsageRecord> = [];
  const waiters: Array<(row: ModelGatewayUsageRecord) => void> = [];

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
      breaker: makeModelGatewayCircuitBreaker(),
    }),
  );
  const endpoint = await Effect.runPromise(proxy.start);

  return {
    endpoint,
    recorded,
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
    post: (input) =>
      fetch(`${endpoint}${input.path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${SESSION_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(input.body),
      }),
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

/** A tool call that reaches the client, then an upstream that dies mid-stream. */
const TOOL_CALL_STREAM = [
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"write_file","arguments":""}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"x\\"}"}}]},"finish_reason":null}]}\n\n',
].join("");

it.effect("does not fail over on a 422 and surfaces the upstream's answer", () =>
  withHarness(
    {
      upstreams: {
        primary: ({ response }) => json(response, 422, { error: "unprocessable entity" }),
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
        assert.strictEqual(response.status, 422);
        assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
          error: "unprocessable entity",
        });
        assert.strictEqual(
          harness.upstreams.backup!.hits.length,
          0,
          "422 means the caller sent something wrong: a backup must not be asked the same thing",
        );
        assert.strictEqual(harness.upstreams.primary!.hits.length, 1, "no same-provider retry");

        const row = yield* Effect.promise(() => harness.awaitRow());
        assert.deepStrictEqual(row.attempts, ["primary:invalid-request"]);
        assert.isFalse(row.failedOver);
        assert.strictEqual(row.status, "failed");
        assert.strictEqual(row.failureClass, "invalid-request");
        assert.strictEqual(row.upstreamHttpStatus, 422);
      }),
  ),
);

it.effect("never replays a streamed tool call onto either backup once the connection dies", () =>
  withHarness(
    {
      upstreams: {
        primary: ({ response }) => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          // The tool call is written to the client, and only then does the
          // upstream drop the connection - the exact shape that would make a
          // replayed answer run a tool twice.
          response.write(TOOL_CALL_STREAM, () => response.destroy());
        },
        "backup-a": ({ response }) => json(response, 200, { ok: true, served: "backup-a" }),
        "backup-b": ({ response }) => json(response, 200, { ok: true, served: "backup-b" }),
      },
      primary: "primary",
      backups: ["backup-a", "backup-b"],
      protocol: "openai-chat",
      apiKeys: { primary: "upstream-key-primary", "backup-a": "k-a", "backup-b": "k-b" },
    },
    (harness) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          harness.post({
            path: "/v1/chat/completions",
            body: { model: "asked-for", tools: [{ type: "function" }] },
          }),
        );
        assert.strictEqual(response.status, 200);
        const text = yield* Effect.promise(() => readBody(response));
        // Nothing a backup said may reach this client, whatever the client did
        // manage to read out of a truncated stream.
        assert.isFalse(text.includes("served"));

        assert.strictEqual(harness.upstreams.primary!.hits.length, 1);
        assert.strictEqual(
          harness.upstreams["backup-a"]!.hits.length,
          0,
          "a committed tool call is never replayed onto a backup",
        );
        assert.strictEqual(
          harness.upstreams["backup-b"]!.hits.length,
          0,
          "a committed tool call is never replayed onto a backup",
        );

        const row = yield* Effect.promise(() => harness.awaitRow());
        assert.deepStrictEqual(row.attempts, ["primary:response-committed"]);
        assert.strictEqual(row.status, "failed");
        assert.strictEqual(row.failureClass, "response-committed");
        assert.strictEqual(row.servedByProviderId, "primary");
        assert.isFalse(row.failedOver);
      }),
  ),
);

it.effect(
  "makes exactly one pass over the route: primary plus two backups, three attempts, no fourth",
  () =>
    withHarness(
      {
        upstreams: {
          primary: ({ response }) => json(response, 500, { error: "primary exploded" }),
          "backup-a": ({ response }) => json(response, 500, { error: "backup-a exploded" }),
          "backup-b": ({ response }) => json(response, 500, { error: "backup-b exploded" }),
        },
        primary: "primary",
        backups: ["backup-a", "backup-b"],
      },
      (harness) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            harness.post({ path: "/v1/responses", body: { model: "asked-for" } }),
          );
          assert.strictEqual(response.status, 503);
          assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
            error: "server-error",
          });

          // Bounded: one request, one pass, each upstream at most once, and no
          // return to the primary after the route is exhausted.
          assert.strictEqual(harness.upstreams.primary!.hits.length, 1);
          assert.strictEqual(harness.upstreams["backup-a"]!.hits.length, 1);
          assert.strictEqual(harness.upstreams["backup-b"]!.hits.length, 1);

          const row = yield* Effect.promise(() => harness.awaitRow());
          assert.deepStrictEqual(row.attempts, [
            "primary:server-error",
            "backup-a:server-error",
            "backup-b:server-error",
          ]);
          assert.strictEqual(row.status, "failed");
          assert.strictEqual(row.failureClass, "server-error");
          assert.isTrue(row.failedOver);
          assert.strictEqual(row.servedByProviderId, "backup-b");
          assert.strictEqual(harness.recorded.length, 1, "one request writes one row");
        }),
    ),
);
