// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off globalDate:off globalDateInEffect:off - the point of this test is a real gateway listener, a real loopback upstream and the real secret/settings/usage stores, so the assertions grep the bytes that actually landed in rows, DTOs, logs and responses.
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MODEL_GATEWAY_CREDENTIAL_REDACTED,
  ModelRouteId,
  ProviderInstanceId,
  ThreadId,
  modelProviderSecretName,
  type ModelGatewayUsageRecord,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as NodeHttp from "node:http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { make as makeModelGatewayService, ModelGatewayService } from "./ModelGatewayService.ts";
import {
  layer as modelGatewayUsageStoreLayer,
  ModelGatewayUsageStore,
} from "./ModelGatewayUsageStore.ts";

/**
 * Obviously fake, and the only credential this test ever writes. It is never a
 * real key and never appears in a request body - only in the configured profile.
 */
const SECRET = "sk-phase7-super-secret-token";
const PROMPT_SENTINEL = "PROMPT-SENTINEL-9f3a";
const PROBE_LOG_LINE = "model-gateway-secret-test-log-probe";

const ROUTE_ID = ModelRouteId.make("route-1");
const THREAD_ID = ThreadId.make("thread-1");
const INSTANCE_ID = ProviderInstanceId.make("codex-1");

const requireValue = <A>(value: A | null | undefined, what: string): A => {
  if (value === null || value === undefined) throw new Error(`the test expected ${what}`);
  return value;
};

const SUCCESS_STREAM = [
  'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
  'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":7,"output_tokens":3}}}\n\n',
  "data: [DONE]\n\n",
].join("");

interface UpstreamHit {
  readonly path: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

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
const startUpstream = (
  respond: (input: { readonly response: NodeHttp.ServerResponse; readonly index: number }) => void,
): Promise<Upstream> =>
  new Promise((resolve, reject) => {
    const hits: Array<UpstreamHit> = [];
    const server = NodeHttp.createServer((request, response) => {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const index = hits.length;
        hits.push({
          path: request.url ?? "",
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        respond({ response, index });
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

const httpJson = (response: NodeHttp.ServerResponse, status: number, body: unknown): void => {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(payload.length),
  });
  response.end(payload);
};

const withUpstream = <A, E, R>(
  respond: (input: { readonly response: NodeHttp.ServerResponse; readonly index: number }) => void,
  body: (upstream: Upstream) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.promise(() => startUpstream(respond)),
      (upstream) => Effect.promise(() => upstream.close()),
    ).pipe(Effect.flatMap(body)),
  );

/**
 * Settings, secret store, usage store and the gateway service itself, wired as
 * production wires them. Built by hand instead of using the packaged `layer`
 * only so this test can read the usage rows the service wrote.
 */
const gatewayLayer = () =>
  Layer.effect(ModelGatewayService, makeModelGatewayService()).pipe(
    Layer.provideMerge(modelGatewayUsageStoreLayer),
    Layer.provideMerge(
      ServerSettingsModule.layer.pipe(
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
        Layer.provideMerge(
          Layer.fresh(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "t3code-model-gateway-secret-test-",
            }),
          ),
        ),
      ),
    ),
  );

/**
 * Stop the listener however a body ends, so a failing assertion cannot leave a
 * bound port behind. Reads the service out of the environment, because the
 * finalizer is attached to the effect rather than to the generator's scope.
 */
const stopGateway: Effect.Effect<void, never, ModelGatewayService> = Effect.flatMap(
  ModelGatewayService,
  (gateway) => gateway.stop,
);

/** The one profile and route these tests need, with the key in the secret store. */
const gatewayPatch = (baseUrl: string): ServerSettingsPatch =>
  ({
    modelGateway: {
      enabled: true,
      providers: {
        primary: {
          id: "primary",
          name: "Fake OpenAI upstream",
          protocol: "openai-responses",
          baseUrl,
          apiKey: SECRET,
          defaultModel: "",
          enabled: true,
        },
      },
      routes: {
        "route-1": {
          id: "route-1",
          name: "Route",
          enabled: true,
          primaryProviderId: "primary",
          backupProviderIds: [],
          modelMapping: {},
          failoverEnabled: true,
        },
      },
    },
  }) as unknown as ServerSettingsPatch;

const post = (endpoint: string, token: string, body: unknown): Promise<Response> =>
  fetch(`${endpoint}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** The row the request should have written never showed up in the store. */
class UsageRowsPending extends Schema.TaggedError<UsageRowsPending>()("UsageRowsPending", {
  message: Schema.String,
}) {}

/**
 * The usage row is written after the answer has been delivered, on the server's
 * own fiber, so this waits on the store rather than on a clock: it fails loudly
 * if the row never lands instead of passing because nothing was written yet.
 */
const waitForRows = <E, R>(
  read: Effect.Effect<ReadonlyArray<ModelGatewayUsageRecord>, E, R>,
  count: number,
): Effect.Effect<ReadonlyArray<ModelGatewayUsageRecord>, E | UsageRowsPending, R> =>
  read.pipe(
    Effect.flatMap((rows) =>
      rows.length >= count
        ? Effect.succeed(rows)
        : Effect.fail(
            new UsageRowsPending({
              message: `the usage store holds ${rows.length} rows, expected ${count}`,
            }),
          ),
    ),
    Effect.retry({ schedule: Schedule.spaced("15 millis"), times: 400 }),
  );

it.layer(NodeServices.layer)("model gateway secrets", (it) => {
  it.effect(
    "sends the stored provider key upstream and keeps it out of rows, DTOs, logs and messages",
    () => {
      const messages: Array<string> = [];
      const logger = Logger.make(({ message }) => {
        messages.push(String(message));
      });

      return withUpstream(
        ({ response, index }) => {
          if (index === 0) {
            const payload = Buffer.from(SUCCESS_STREAM, "utf8");
            response.writeHead(200, {
              "content-type": "text/event-stream",
              "content-length": String(payload.length),
            });
            response.end(payload);
            return;
          }
          httpJson(response, 500, { error: "upstream exploded" });
        },
        (upstream) =>
          Effect.gen(function* () {
            const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
            const secretStore = yield* ServerSecretStore.ServerSecretStore;
            const usageStore = yield* ModelGatewayUsageStore;
            const gateway = yield* ModelGatewayService;

            yield* serverSettings.updateSettings(gatewayPatch(upstream.baseUrl));

            // The key is in the store, and only the marker is in settings.
            const stored = yield* secretStore.get(modelProviderSecretName("primary"));
            assert.strictEqual(new TextDecoder().decode(Option.getOrThrow(stored)), SECRET);
            assert.strictEqual(
              Object.values((yield* serverSettings.getSettings).modelGateway.providers)[0]?.apiKey,
              MODEL_GATEWAY_CREDENTIAL_REDACTED,
            );

            const status = yield* gateway.start;
            assert.strictEqual(status.diagnostic, "ready");
            const endpoint = requireValue(status.endpoint, "a bound endpoint");
            const token = requireValue(
              yield* gateway.issueCredential({
                threadId: THREAD_ID,
                providerInstanceId: INSTANCE_ID,
                routeId: ROUTE_ID,
              }),
              "a minted session credential",
            );
            assert.notStrictEqual(token, SECRET, "the session bearer is not the upstream key");

            // A probe so the leak assertion below cannot pass merely because the
            // test logger collects nothing.
            yield* Effect.log(PROBE_LOG_LINE);

            const ok = yield* Effect.promise(() =>
              post(endpoint, token, { model: "asked-for", input: PROMPT_SENTINEL }),
            );
            assert.strictEqual(ok.status, 200);
            assert.strictEqual(yield* Effect.promise(() => ok.text()), SUCCESS_STREAM);

            const failed = yield* Effect.promise(() =>
              post(endpoint, token, { model: "asked-for", input: PROMPT_SENTINEL }),
            );
            assert.strictEqual(failed.status, 503);
            const failureBody = yield* Effect.promise(() => failed.text());
            assert.deepStrictEqual(JSON.parse(failureBody), { error: "server-error" });
            assert.notInclude(failureBody, SECRET, "no error the proxy returns carries the key");

            // The heart of the test: the key *was* used, on both attempts.
            assert.strictEqual(upstream.hits.length, 2, "one request per attempt, no retry");
            for (const hit of upstream.hits) {
              assert.strictEqual(hit.headers.authorization, `Bearer ${SECRET}`);
              assert.strictEqual(hit.path, "/v1/responses");
              const forwarded = JSON.parse(hit.body) as Record<string, unknown>;
              assert.strictEqual(forwarded.input, PROMPT_SENTINEL);
              assert.notInclude(JSON.stringify(hit.body), SECRET, "the key is header-only");
              assert.notInclude(
                JSON.stringify(hit.headers),
                token,
                "the session bearer is replaced, never forwarded",
              );
            }

            // Persisted rows, read back out of the store the service wrote to.
            const rows = yield* waitForRows(
              usageStore.readWindow({ sinceHours: 24, nowMs: Date.now(), limit: 50 }),
              2,
            );
            const succeeded = rows.find((row) => row.status === "success");
            const failedRow = rows.find((row) => row.status === "failed");
            assert.strictEqual(succeeded?.inputTokens, 7);
            assert.strictEqual(succeeded?.outputTokens, 3);
            assert.strictEqual(failedRow?.failureClass, "server-error");
            assert.strictEqual(failedRow?.upstreamHttpStatus, 500);
            for (const row of rows) {
              assert.notInclude(JSON.stringify(row), SECRET, "a usage row has no key field");
            }

            // The status/diagnostics DTO, after real traffic.
            const afterTraffic = yield* gateway.status;
            assert.notInclude(JSON.stringify(afterTraffic), SECRET);
            assert.strictEqual(
              afterTraffic.providers[0]?.hasCredential,
              true,
              "the DTO says a credential is set, and never what it is",
            );
            assert.isTrue((afterTraffic.health[0]?.consecutiveFailures ?? 0) >= 1);

            // Every response header the client saw.
            assert.notInclude(JSON.stringify([...ok.headers]), SECRET);
            assert.notInclude(JSON.stringify([...failed.headers]), SECRET);

            // The client-facing settings DTO: the marker, not the value.
            const forClient = ServerSettingsModule.redactServerSettingsForClient(
              yield* serverSettings.getSettings,
            );
            assert.notInclude(JSON.stringify(forClient), SECRET);
            assert.strictEqual(
              Object.values(forClient.modelGateway.providers)[0]?.apiKey,
              MODEL_GATEWAY_CREDENTIAL_REDACTED,
            );

            // Log capture. The proxy relays bytes from node:http callbacks, which
            // run on the default runtime logger rather than this fiber's, so this
            // is a guard over the logging this test can see - see the report.
            assert.isTrue(
              messages.some((message) => message.includes(PROBE_LOG_LINE)),
              "the test logger captured nothing, so the assertion below proves nothing",
            );
            assert.isFalse(messages.some((message) => message.includes(SECRET)));
          }).pipe(Effect.ensuring(stopGateway)),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(gatewayLayer(), Logger.layer([logger], { mergeWithExisting: false })),
        ),
      );
    },
  );

  it.effect(
    "refuses the upstream's own key as a session credential, before any upstream is called",
    () => {
      return withUpstream(
        ({ response }) => httpJson(response, 200, { ok: true }),
        (upstream) =>
          Effect.gen(function* () {
            const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
            const usageStore = yield* ModelGatewayUsageStore;
            const gateway = yield* ModelGatewayService;

            yield* serverSettings.updateSettings(gatewayPatch(upstream.baseUrl));

            const endpoint = requireValue((yield* gateway.start).endpoint, "a bound endpoint");
            const token = requireValue(
              yield* gateway.issueCredential({
                threadId: THREAD_ID,
                providerInstanceId: INSTANCE_ID,
                routeId: ROUTE_ID,
              }),
              "a minted session credential",
            );

            // A positive control: the listener does accept the credential it minted.
            const accepted = yield* Effect.promise(() =>
              post(endpoint, token, { model: "asked-for", input: PROMPT_SENTINEL }),
            );
            assert.strictEqual(accepted.status, 200);
            assert.strictEqual(upstream.hits.length, 1);

            // The upstream's key is not a credential this listener accepts.
            const refused = yield* Effect.promise(() =>
              post(endpoint, SECRET, { model: "asked-for", input: PROMPT_SENTINEL }),
            );
            const refusedBody = yield* Effect.promise(() => refused.text());
            assert.strictEqual(refused.status, 401);
            assert.deepStrictEqual(JSON.parse(refusedBody), { error: "unauthorized" });
            assert.notInclude(refusedBody, SECRET);
            assert.strictEqual(
              upstream.hits.length,
              1,
              "the refused request contacted no upstream: no second request was made",
            );
            assert.strictEqual(
              (yield* usageStore.readWindow({ sinceHours: 24, nowMs: Date.now(), limit: 50 }))
                .length,
              1,
              "only the accepted request wrote a usage row",
            );
          }).pipe(Effect.ensuring(stopGateway)),
      ).pipe(Effect.provide(gatewayLayer()));
    },
  );
});
