/**
 * Model Gateway - usage accounting store.
 *
 * One append-only table of request *metadata*. The row schema it writes is
 * `ModelGatewayUsageRecord`, which has no field capable of holding a prompt, a
 * completion, a tool argument, a header or a key - a schema without the field is
 * a stronger guarantee than a rule against filling it in, and this module never
 * has one to pass.
 *
 * Retention follows the `usageScanCache` idiom: a cutoff is computed from the
 * configured window and everything older is dropped. Pruning is opportunistic
 * (at most once an hour, from a write) because the alternative - a timer - would
 * need a lifecycle nothing else here has, and the window is the only thing that
 * keeps this table from growing without limit.
 *
 * `recorded_at` is an ISO-8601 UTC string, the same convention as every other
 * timestamp column in this database, which is what makes the retention and
 * window comparisons plain lexicographic SQL rather than date arithmetic.
 *
 * @module ModelGatewayUsageStore
 */
// @effect-diagnostics globalDate:off globalDateInEffect:off - `recorded_at` is an ISO-8601 UTC TEXT column and the retention window is derived from the wall clock, outside any Effect fiber.
import {
  ModelGatewayFailureClass,
  ModelGatewayProtocol,
  type ModelGatewayUsageRecord,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** A write may prune at most this often, so a busy gateway does not delete per request. */
const PRUNE_INTERVAL_MS = MS_PER_HOUR;

/** Start of the retention window: rows older than this are dropped. */
export const retentionCutoffMs = (nowMs: number, retentionDays: number): number =>
  nowMs - Math.max(0, retentionDays) * MS_PER_DAY;

/** Start of the read window, as the value `recorded_at` is compared against. */
export const modelGatewayWindowCutoffIso = (nowMs: number, sinceHours: number): string =>
  new Date(nowMs - Math.max(0, sinceHours) * MS_PER_HOUR).toISOString();

const UsageRow = Schema.Struct({
  id: Schema.String,
  recorded_at: Schema.String,
  thread_id: Schema.String,
  provider_instance_id: Schema.String,
  route_id: Schema.String,
  protocol: ModelGatewayProtocol,
  requested_model: Schema.String,
  upstream_model: Schema.String,
  served_by_provider_id: Schema.String,
  attempts: Schema.String,
  failed_over: Schema.Number,
  status: Schema.Literals(["success", "failed"]),
  failure_class: Schema.NullOr(ModelGatewayFailureClass),
  upstream_http_status: Schema.NullOr(Schema.Number),
  streamed: Schema.Number,
  latency_ms: Schema.Number,
  time_to_first_token_ms: Schema.NullOr(Schema.Number),
  input_tokens: Schema.NullOr(Schema.Number),
  output_tokens: Schema.NullOr(Schema.Number),
  cache_read_tokens: Schema.NullOr(Schema.Number),
  cache_write_tokens: Schema.NullOr(Schema.Number),
  reasoning_tokens: Schema.NullOr(Schema.Number),
});
type UsageRow = typeof UsageRow.Type;

const decodeUsageRow = Schema.decodeUnknownOption(UsageRow);
const parseAttempts = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const encodeAttempts = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const toRecord = (row: UsageRow): ModelGatewayUsageRecord => ({
  id: row.id,
  recordedAt: row.recorded_at,
  threadId: row.thread_id,
  providerInstanceId: row.provider_instance_id,
  routeId: row.route_id,
  protocol: row.protocol,
  requestedModel: row.requested_model,
  upstreamModel: row.upstream_model,
  servedByProviderId: row.served_by_provider_id as ModelGatewayUsageRecord["servedByProviderId"],
  attempts: Option.getOrElse(parseAttempts(row.attempts), () => []),
  failedOver: row.failed_over !== 0,
  status: row.status,
  failureClass: row.failure_class,
  upstreamHttpStatus: row.upstream_http_status,
  streamed: row.streamed !== 0,
  latencyMs: row.latency_ms,
  timeToFirstTokenMs: row.time_to_first_token_ms,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cacheReadTokens: row.cache_read_tokens,
  cacheWriteTokens: row.cache_write_tokens,
  reasoningTokens: row.reasoning_tokens,
});

export interface ModelGatewayUsageStoreShape {
  /** Append one request's metadata; prunes the table opportunistically. */
  readonly record: (
    row: ModelGatewayUsageRecord,
    options: { readonly retentionDays: number; readonly nowMs: number },
  ) => Effect.Effect<void, SqlError.SqlError>;
  /** Newest-first rows inside the requested window. */
  readonly readWindow: (input: {
    readonly sinceHours: number;
    readonly nowMs: number;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ModelGatewayUsageRecord>, SqlError.SqlError>;
  readonly prune: (input: {
    readonly retentionDays: number;
    readonly nowMs: number;
  }) => Effect.Effect<void, SqlError.SqlError>;
}

export class ModelGatewayUsageStore extends Context.Service<
  ModelGatewayUsageStore,
  ModelGatewayUsageStoreShape
>()("t3/modelGateway/ModelGatewayUsageStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lastPruneAtMs = yield* Ref.make(0);

  const prune: ModelGatewayUsageStoreShape["prune"] = Effect.fn("ModelGatewayUsageStore.prune")(
    function* (input) {
      const cutoff = new Date(retentionCutoffMs(input.nowMs, input.retentionDays)).toISOString();
      yield* sql`DELETE FROM model_gateway_usage WHERE recorded_at < ${cutoff}`;
    },
  );

  const record: ModelGatewayUsageStoreShape["record"] = Effect.fn("ModelGatewayUsageStore.record")(
    function* (row, options) {
      yield* sql`
        INSERT INTO model_gateway_usage (
          id, recorded_at, thread_id, provider_instance_id, route_id, protocol,
          requested_model, upstream_model, served_by_provider_id, attempts, failed_over,
          status, failure_class, upstream_http_status, streamed, latency_ms,
          time_to_first_token_ms, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, reasoning_tokens
        ) VALUES (
          ${row.id}, ${row.recordedAt}, ${row.threadId}, ${row.providerInstanceId},
          ${row.routeId}, ${row.protocol}, ${row.requestedModel}, ${row.upstreamModel},
          ${row.servedByProviderId}, ${encodeAttempts(row.attempts)}, ${row.failedOver ? 1 : 0},
          ${row.status}, ${row.failureClass}, ${row.upstreamHttpStatus}, ${row.streamed ? 1 : 0},
          ${row.latencyMs}, ${row.timeToFirstTokenMs}, ${row.inputTokens}, ${row.outputTokens},
          ${row.cacheReadTokens}, ${row.cacheWriteTokens}, ${row.reasoningTokens}
        )
      `;
      const lastPrune = yield* Ref.get(lastPruneAtMs);
      if (options.nowMs - lastPrune >= PRUNE_INTERVAL_MS) {
        yield* Ref.set(lastPruneAtMs, options.nowMs);
        yield* prune({ retentionDays: options.retentionDays, nowMs: options.nowMs });
      }
    },
  );

  const readWindow: ModelGatewayUsageStoreShape["readWindow"] = Effect.fn(
    "ModelGatewayUsageStore.readWindow",
  )(function* (input) {
    const cutoff = modelGatewayWindowCutoffIso(input.nowMs, input.sinceHours);
    const rows = yield* sql<UsageRow>`
      SELECT * FROM model_gateway_usage
      WHERE recorded_at >= ${cutoff}
      ORDER BY recorded_at DESC
      LIMIT ${input.limit}
    `;
    // A row this module cannot read back is a row it must not guess at: skip it
    // rather than invent a protocol or a status it never wrote.
    return rows.flatMap((row) => Option.toArray(Option.map(decodeUsageRow(row), toRecord)));
  });

  return ModelGatewayUsageStore.of({ record, readWindow, prune });
});

export const layer = Layer.effect(ModelGatewayUsageStore, make);
