import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_status_entries (
      thread_id TEXT NOT NULL,
      status_key TEXT NOT NULL,
      status_text TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, status_key)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_status_entries_thread_updated
    ON projection_thread_status_entries(thread_id, updated_at)
  `;
});
