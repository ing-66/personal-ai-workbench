import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { migrationManifest, runMigrations } from "../Migrations.ts";

/**
 * Release gate for the Phase 1-8 schema additions (Phase 2's 053 and Phase 7's
 * 054), driven through the real migration runner rather than through the
 * individual migration modules.
 *
 * The other migration tests each prove one migration's own behaviour. These
 * cases prove the three properties a release depends on and that no single
 * migration can prove about itself: an old database still upgrades, running the
 * runner twice on the same file changes nothing, and a migration that cannot
 * complete fails without recreating or deleting the database.
 */
const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

/**
 * Each case needs its own database. `it.layer` shares one build across the
 * suite, and these cases disagree about what the schema is at the start: the
 * upgrade case begins before 053, and the failure case has to create a
 * conflicting object before 053 can run.
 */
const freshDatabase = Layer.fresh(NodeSqliteClient.layerMemory());

const LATEST_MIGRATION_ID = 54;

const latestIdIn = (manifest: ReadonlyArray<readonly [number, string]>) =>
  manifest.reduce((highest, [id]) => Math.max(highest, id), 0);

layer("PHASE8_ReleaseUpgrade", (it) => {
  it.effect("upgrades a pre-053 database and keeps the rows it already had", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // A database from before the Phase 2 schema additions.
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, provider_instance_id, adapter_key,
          runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json
        ) VALUES (
          'thread-legacy', 'codex', NULL, 'codex', 'full-access', 'running',
          '2026-09-16T00:00:00.000Z', '{"threadId":"native-legacy"}', NULL
        )
      `;

      const applied = yield* runMigrations();
      const appliedIds = applied.map(([id]) => id);
      assert.isTrue(appliedIds.includes(53), "053 must run on a pre-053 database");
      assert.isTrue(appliedIds.includes(54), "054 must run on a pre-053 database");
      assert.equal(latestIdIn(applied), LATEST_MIGRATION_ID);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('thread_task_states', 'thread_artifacts', 'model_gateway_usage')
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((row) => row.name),
        ["model_gateway_usage", "thread_artifacts", "thread_task_states"],
      );

      // The legacy row survives the 053 table rebuild, carrying its mapping.
      const rows = yield* sql<{
        readonly providerInstanceId: string;
        readonly resumeCursor: string;
        readonly isCurrent: number;
      }>`
        SELECT
          provider_instance_id AS "providerInstanceId",
          resume_cursor_json AS "resumeCursor",
          is_current AS "isCurrent"
        FROM provider_session_runtime
        WHERE thread_id = 'thread-legacy'
      `;
      assert.deepStrictEqual(rows, [
        {
          providerInstanceId: "codex",
          resumeCursor: '{"threadId":"native-legacy"}',
          isCurrent: 1,
        },
      ]);
    }).pipe(Effect.provide(freshDatabase)),
  );

  it.effect("re-running the runner on a current database applies nothing and loses nothing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, provider_instance_id, adapter_key,
          runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json
        ) VALUES (
          'thread-idempotent', 'genericAcp', 'qwen-acp', 'genericAcp', 'full-access', 'running',
          '2026-09-16T00:05:00.000Z', '{"sessionId":"native-idem"}', NULL
        )
      `;
      yield* sql`
        INSERT INTO model_gateway_usage (
          id, recorded_at, thread_id, provider_instance_id, route_id, protocol,
          requested_model, upstream_model, served_by_provider_id, attempts,
          failed_over, status, failure_class, upstream_http_status, streamed,
          latency_ms, time_to_first_token_ms, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, reasoning_tokens
        ) VALUES (
          'usage-idempotent', '2026-09-16T00:05:00.000Z', 'thread-idempotent', 'codex', 'route-a',
          'openai-responses', 'gpt-x', 'gpt-x', 'provider-a', '["primary:success"]',
          0, 'success', NULL, 200, 1, 42, 7, 10, 20, 0, 0, 3
        )
      `;

      const tablesBefore = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
      `;

      // A second boot of the same installation.
      const reapplied = yield* runMigrations();
      assert.deepStrictEqual(reapplied, []);

      const tablesAfter = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
      `;
      assert.deepStrictEqual(tablesAfter, tablesBefore);

      const usage = yield* sql<{ readonly id: string; readonly outputTokens: number }>`
        SELECT id, output_tokens AS "outputTokens" FROM model_gateway_usage
      `;
      assert.deepStrictEqual(usage, [{ id: "usage-idempotent", outputTokens: 20 }]);

      const mappings = yield* sql<{ readonly providerInstanceId: string }>`
        SELECT provider_instance_id AS "providerInstanceId"
        FROM provider_session_runtime
        WHERE thread_id = 'thread-idempotent'
      `;
      assert.deepStrictEqual(mappings, [{ providerInstanceId: "qwen-acp" }]);
    }).pipe(Effect.provide(freshDatabase)),
  );

  it.effect("a migration that cannot complete fails loudly and leaves the database alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, provider_instance_id, adapter_key,
          runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json
        ) VALUES (
          'thread-failure', 'codex', NULL, 'codex', 'full-access', 'running',
          '2026-09-16T00:00:00.000Z', '{"threadId":"native-failure"}', NULL
        )
      `;

      // Make 053 impossible to complete: its first statement drops this name as
      // a table, and a view cannot be dropped that way.
      yield* sql`CREATE VIEW provider_session_runtime_v2 AS SELECT 1 AS marker`;

      const failure = yield* Effect.exit(runMigrations());
      assert.strictEqual(failure._tag, "Failure");

      // The old table and its rows are still there: nothing was recreated,
      // truncated or deleted to make the migration "succeed".
      const rows = yield* sql<{
        readonly resumeCursor: string;
      }>`
        SELECT resume_cursor_json AS "resumeCursor"
        FROM provider_session_runtime
        WHERE thread_id = 'thread-failure'
      `;
      assert.deepStrictEqual(rows, [{ resumeCursor: '{"threadId":"native-failure"}' }]);

      // And the migration's own output was never created.
      const created = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('thread_task_states', 'thread_artifacts', 'model_gateway_usage')
      `;
      assert.deepStrictEqual(created, []);

      // The failing migration is not recorded as applied, so the next run still
      // owes 53 and 54 rather than believing the schema is current.
      const recorded = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.isFalse(recorded.some((row) => row.name.startsWith("53_")));
      assert.isFalse(recorded.some((row) => row.name.startsWith("54_")));
    }).pipe(Effect.provide(freshDatabase)),
  );

  it.effect("the migration manifest ends at the schema this release ships", () =>
    Effect.sync(() => {
      assert.equal(latestIdIn(migrationManifest), LATEST_MIGRATION_ID);
      const names = new Map(migrationManifest);
      assert.equal(names.get(53), "CanonicalThreadCoreState");
      assert.equal(names.get(54), "ModelGatewayUsage");
    }),
  );
});
