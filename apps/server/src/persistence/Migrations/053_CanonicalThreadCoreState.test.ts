import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("053_CanonicalThreadCoreState", (it) => {
  it.effect("preserves legacy provider mappings and enables multiple providers per thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, provider_instance_id, adapter_key,
          runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json
        ) VALUES (
          'thread-a', 'codex', NULL, 'codex', 'full-access', 'running',
          '2026-09-16T00:00:00.000Z', '{"threadId":"native-a1"}', NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, provider_instance_id, adapter_key,
          runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json
        ) VALUES (
          'thread-a', 'genericAcp', 'qwen-acp', 'genericAcp', 'full-access', 'running',
          '2026-09-16T00:01:00.000Z', '{"sessionId":"native-b1"}', NULL
        )
      `;

      const rows = yield* sql<{
        readonly providerInstanceId: string;
        readonly resumeCursor: string;
      }>`
        SELECT
          provider_instance_id AS "providerInstanceId",
          resume_cursor_json AS "resumeCursor"
        FROM provider_session_runtime
        WHERE thread_id = 'thread-a'
        ORDER BY provider_instance_id
      `;
      assert.deepStrictEqual(rows, [
        { providerInstanceId: "codex", resumeCursor: '{"threadId":"native-a1"}' },
        { providerInstanceId: "qwen-acp", resumeCursor: '{"sessionId":"native-b1"}' },
      ]);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('thread_task_states', 'thread_artifacts')
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((row) => row.name),
        ["thread_artifacts", "thread_task_states"],
      );
    }),
  );
});
