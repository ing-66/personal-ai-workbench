import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Keep provider_session_runtime as the one native-session mapping store,
  // but retain one resumable mapping per configured provider instance.
  yield* sql`DROP TABLE IF EXISTS provider_session_runtime_v2`;
  yield* sql`
    CREATE TABLE provider_session_runtime_v2 (
      thread_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      adapter_key TEXT NOT NULL,
      runtime_mode TEXT NOT NULL DEFAULT 'full-access',
      status TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      resume_cursor_json TEXT,
      runtime_payload_json TEXT,
      is_current INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (thread_id, provider_instance_id)
    )
  `;
  yield* sql`
    INSERT INTO provider_session_runtime_v2 (
      thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode,
      status, last_seen_at, resume_cursor_json, runtime_payload_json, is_current
    )
    SELECT
      thread_id,
      provider_name,
      COALESCE(provider_instance_id, provider_name),
      adapter_key,
      runtime_mode,
      status,
      last_seen_at,
      resume_cursor_json,
      runtime_payload_json,
      1
    FROM provider_session_runtime
  `;
  yield* sql`DROP TABLE provider_session_runtime`;
  yield* sql`ALTER TABLE provider_session_runtime_v2 RENAME TO provider_session_runtime`;
  yield* sql`
    CREATE INDEX idx_provider_session_runtime_status
    ON provider_session_runtime(status)
  `;
  yield* sql`
    CREATE INDEX idx_provider_session_runtime_provider
    ON provider_session_runtime(provider_name)
  `;
  yield* sql`
    CREATE INDEX idx_provider_session_runtime_instance
    ON provider_session_runtime(provider_instance_id)
  `;
  yield* sql`
    CREATE INDEX idx_provider_session_runtime_thread_recent
    ON provider_session_runtime(thread_id, last_seen_at DESC)
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_provider_session_runtime_current
    ON provider_session_runtime(thread_id)
    WHERE is_current = 1
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_task_states (
      thread_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'blocked')),
      objective TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_artifacts (
      artifact_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      workspace_relative_path TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      producing_provider_instance_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      UNIQUE (thread_id, workspace_relative_path)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_artifacts_thread_updated
    ON thread_artifacts(thread_id, updated_at DESC)
  `;
});
