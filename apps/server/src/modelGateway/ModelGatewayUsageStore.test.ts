// @effect-diagnostics globalDate:off - rows are stamped with ISO-8601 UTC, matching the column's own convention.
import { assert, it } from "@effect/vitest";
import { type ModelGatewayUsageRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../persistence/Migrations.ts";
import { make as makeUsageStore, retentionCutoffMs } from "./ModelGatewayUsageStore.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const row = (overrides: Partial<ModelGatewayUsageRecord>): ModelGatewayUsageRecord => ({
  id: "row-1",
  recordedAt: "2026-09-16T10:00:00.000Z",
  threadId: "thread-1",
  providerInstanceId: "codex-1",
  routeId: "route-1",
  protocol: "openai-responses",
  requestedModel: "asked-for",
  upstreamModel: "billed-for",
  servedByProviderId: "primary" as ModelGatewayUsageRecord["servedByProviderId"],
  attempts: ["primary:server-error", "backup:success"],
  failedOver: true,
  status: "success",
  failureClass: null,
  upstreamHttpStatus: 200,
  streamed: true,
  latencyMs: 1_234,
  timeToFirstTokenMs: 321,
  inputTokens: 1_200,
  outputTokens: 45,
  cacheReadTokens: 800,
  cacheWriteTokens: null,
  reasoningTokens: 12,
  ...overrides,
});

layer("ModelGatewayUsageStore", (it) => {
  it.effect("stores one row and reads the window back newest first", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      const store = yield* makeUsageStore;
      const nowMs = Date.parse("2026-09-16T12:00:00.000Z");

      yield* store.record(row({ id: "older", recordedAt: "2026-09-16T09:00:00.000Z" }), {
        retentionDays: 30,
        nowMs,
      });
      yield* store.record(
        row({ id: "newer", recordedAt: "2026-09-16T11:00:00.000Z", failureClass: "timeout" }),
        { retentionDays: 30, nowMs },
      );

      const window = yield* store.readWindow({ sinceHours: 24, nowMs, limit: 50 });
      assert.deepStrictEqual(
        window.map((entry) => entry.id),
        ["newer", "older"],
      );
      const [newer] = window;
      assert.strictEqual(newer?.upstreamModel, "billed-for");
      assert.deepStrictEqual(newer?.attempts, ["primary:server-error", "backup:success"]);
      assert.isTrue(newer?.failedOver);
      assert.isTrue(newer?.streamed);
      assert.strictEqual(newer?.failureClass, "timeout");
      assert.strictEqual(newer?.inputTokens, 1_200);
      assert.strictEqual(newer?.outputTokens, 45);
      assert.strictEqual(newer?.cacheReadTokens, 800);
      assert.strictEqual(newer?.cacheWriteTokens, null);
      assert.strictEqual(newer?.reasoningTokens, 12);
      assert.strictEqual(newer?.latencyMs, 1_234);
      assert.strictEqual(newer?.timeToFirstTokenMs, 321);

      // A window that starts after both rows holds neither.
      const empty = yield* store.readWindow({
        sinceHours: 1,
        nowMs: nowMs + 60 * 60 * 1_000,
        limit: 50,
      });
      assert.deepStrictEqual(empty, []);
    }),
  );

  it.effect("prunes past the retention window and keeps what is inside it", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      const store = yield* makeUsageStore;
      const nowMs = Date.parse("2026-10-01T00:00:00.000Z");

      yield* store.record(row({ id: "ancient", recordedAt: "2026-08-01T00:00:00.000Z" }), {
        retentionDays: 30,
        nowMs,
      });
      yield* store.record(row({ id: "recent", recordedAt: "2026-09-30T00:00:00.000Z" }), {
        retentionDays: 30,
        nowMs,
      });
      assert.strictEqual(retentionCutoffMs(nowMs, 30), nowMs - 30 * 86_400_000);

      yield* store.prune({ retentionDays: 30, nowMs });
      const window = yield* store.readWindow({ sinceHours: 24 * 365, nowMs, limit: 50 });
      const ids = window.map((entry) => entry.id);
      assert.notInclude(ids, "ancient");
      assert.include(ids, "recent");
    }),
  );

  it.effect("creates the retention table and its three indexes", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      const sql = yield* SqlClient.SqlClient;
      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(model_gateway_usage)
      `;
      const names = indexes.map((entry) => entry.name);
      for (const expected of [
        "idx_model_gateway_usage_recorded_at",
        "idx_model_gateway_usage_route_recorded_at",
        "idx_model_gateway_usage_provider_recorded_at",
      ]) {
        assert.include(names, expected);
      }
    }),
  );
});
