/**
 * Model Gateway - usage accounting.
 *
 * Usage is **telemetry metadata**, not a conversation recorder. Every field here
 * describes a request; none describes what was in it. There is deliberately no field
 * for a prompt, a completion, a tool argument, or a file body, because a schema
 * without the field is a stronger guarantee than a rule against filling it in.
 *
 * Token counts come from the upstream's own `usage` fields and are `null` when the
 * upstream did not report them. `null` means *unknown*, which is the honest answer;
 * tokenising locally and presenting the result as a measurement would not be.
 *
 * @module ModelGatewayUsage
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ModelGatewayProtocol, ModelProviderId } from "./modelGateway.ts";
import { ModelGatewayFailureClass } from "./modelGatewayRuntime.ts";

/**
 * One proxied request.
 *
 * `attempts` is the whole ordered story (`provider:outcome`), so "primary failed,
 * backup succeeded" is visible in one row without a join and without a second table.
 */
export const ModelGatewayUsageRecord = Schema.Struct({
  id: Schema.String,
  recordedAt: Schema.String,
  threadId: Schema.String,
  providerInstanceId: Schema.String,
  routeId: Schema.String,
  protocol: ModelGatewayProtocol,
  /** The model name the harness asked for. */
  requestedModel: Schema.String,
  /** The model name the upstream was actually billed for. */
  upstreamModel: Schema.String,
  /** The provider that actually produced the answer. */
  servedByProviderId: ModelProviderId,
  /** Every provider attempted, in order, as `provider:outcome`. */
  attempts: Schema.Array(Schema.String),
  failedOver: Schema.Boolean,
  status: Schema.Literals(["success", "failed"]),
  failureClass: Schema.NullOr(ModelGatewayFailureClass),
  upstreamHttpStatus: Schema.NullOr(Schema.Finite),
  streamed: Schema.Boolean,
  latencyMs: Schema.Finite,
  timeToFirstTokenMs: Schema.NullOr(Schema.Finite),
  inputTokens: Schema.NullOr(Schema.Finite),
  outputTokens: Schema.NullOr(Schema.Finite),
  cacheReadTokens: Schema.NullOr(Schema.Finite),
  cacheWriteTokens: Schema.NullOr(Schema.Finite),
  reasoningTokens: Schema.NullOr(Schema.Finite),
});
export type ModelGatewayUsageRecord = typeof ModelGatewayUsageRecord.Type;

/** Rolled-up totals for Settings' lightweight usage panel. */
export const ModelGatewayUsageSummary = Schema.Struct({
  requests: Schema.Finite,
  succeeded: Schema.Finite,
  failed: Schema.Finite,
  inputTokens: Schema.Finite,
  outputTokens: Schema.Finite,
  cacheReadTokens: Schema.Finite,
  cacheWriteTokens: Schema.Finite,
  /** Requests where at least one upstream was abandoned for another. */
  failovers: Schema.Finite,
  medianTimeToFirstTokenMs: Schema.NullOr(Schema.Finite),
  medianLatencyMs: Schema.NullOr(Schema.Finite),
});
export type ModelGatewayUsageSummary = typeof ModelGatewayUsageSummary.Type;

/** Usage rows grouped by one dimension, for the per-provider/model/route views. */
export const ModelGatewayUsageGroup = Schema.Struct({
  key: Schema.String,
  summary: ModelGatewayUsageSummary,
});
export type ModelGatewayUsageGroup = typeof ModelGatewayUsageGroup.Type;

/** The dimensions Settings can group a usage window by. */
export const ModelGatewayUsageDimension = Schema.Literals([
  "provider",
  "model",
  "route",
  "protocol",
]);
export type ModelGatewayUsageDimension = typeof ModelGatewayUsageDimension.Type;

/** Usage the client asks for: a window and a grouping. */
export const ModelGatewayUsageQuery = Schema.Struct({
  /** How many hours back to read. Bounded so a client cannot ask for everything. */
  sinceHours: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(24))),
  groupBy: ModelGatewayUsageDimension.pipe(
    Schema.withDecodingDefault(Effect.succeed("route" as const)),
  ),
});
export type ModelGatewayUsageQuery = typeof ModelGatewayUsageQuery.Type;

/** Everything Settings' usage panel renders in one round trip. */
export const ModelGatewayUsageView = Schema.Struct({
  sinceHours: Schema.Finite,
  totals: ModelGatewayUsageSummary,
  groups: Schema.Array(ModelGatewayUsageGroup),
  /** The newest rows, already redacted by construction: metadata only. */
  recent: Schema.Array(ModelGatewayUsageRecord),
  retentionDays: Schema.Finite,
});
export type ModelGatewayUsageView = typeof ModelGatewayUsageView.Type;

/**
 * Median of a sample. `values` is copied before sorting so a caller's array is never
 * reordered underneath it.
 */
export const medianOf = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle]!;
  if (sorted.length % 2 === 1) return upper;
  return Math.round((sorted[middle - 1]! + upper) / 2);
};

/** Aggregate rows into the summary Settings shows. */
export const summarizeModelGatewayUsage = (
  rows: ReadonlyArray<ModelGatewayUsageRecord>,
): ModelGatewayUsageSummary => {
  let succeeded = 0;
  let failed = 0;
  let failovers = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  const ttfts: Array<number> = [];
  const latencies: Array<number> = [];
  for (const row of rows) {
    if (row.status === "success") succeeded += 1;
    else failed += 1;
    if (row.failedOver) failovers += 1;
    inputTokens += row.inputTokens ?? 0;
    outputTokens += row.outputTokens ?? 0;
    cacheReadTokens += row.cacheReadTokens ?? 0;
    cacheWriteTokens += row.cacheWriteTokens ?? 0;
    if (row.timeToFirstTokenMs !== null) ttfts.push(row.timeToFirstTokenMs);
    latencies.push(row.latencyMs);
  }
  return {
    requests: rows.length,
    succeeded,
    failed,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    failovers,
    medianTimeToFirstTokenMs: medianOf(ttfts),
    medianLatencyMs: medianOf(latencies),
  };
};
