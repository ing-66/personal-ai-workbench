import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Proxy-observed usage: one append-only row per proxied request, holding the
  // columns of `ModelGatewayUsageRecord` and nothing else. There is deliberately
  // no column for a prompt, a completion, a tool argument, a header or a key.
  //
  // `attempts` is a JSON array rather than a second table: it is an ordered
  // per-request story that is only ever read whole, never joined or aggregated.
  // Token counts are nullable on purpose - NULL means the upstream did not report
  // them, which is a different fact from a measured zero.
  yield* sql`
    CREATE TABLE model_gateway_usage (
      id TEXT PRIMARY KEY NOT NULL,
      recorded_at TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      route_id TEXT NOT NULL,
      protocol TEXT NOT NULL,
      requested_model TEXT NOT NULL,
      upstream_model TEXT NOT NULL,
      served_by_provider_id TEXT NOT NULL,
      attempts TEXT NOT NULL,
      failed_over INTEGER NOT NULL,
      status TEXT NOT NULL,
      failure_class TEXT,
      upstream_http_status INTEGER,
      streamed INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      time_to_first_token_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER
    )
  `;

  yield* sql`
    CREATE INDEX idx_model_gateway_usage_recorded_at
    ON model_gateway_usage(recorded_at)
  `;
  yield* sql`
    CREATE INDEX idx_model_gateway_usage_route_recorded_at
    ON model_gateway_usage(route_id, recorded_at)
  `;
  yield* sql`
    CREATE INDEX idx_model_gateway_usage_provider_recorded_at
    ON model_gateway_usage(served_by_provider_id, recorded_at)
  `;
});
