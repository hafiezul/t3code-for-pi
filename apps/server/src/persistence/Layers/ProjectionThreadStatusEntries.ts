import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

import {
  DeleteProjectionThreadStatusEntriesInput,
  DeleteProjectionThreadStatusEntryInput,
  ListProjectionThreadStatusEntriesInput,
  ProjectionThreadStatusEntry,
  ProjectionThreadStatusEntryRepository,
  type ProjectionThreadStatusEntryRepositoryShape,
} from "../Services/ProjectionThreadStatusEntries.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionThreadStatusEntryRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadStatusEntryRow = SqlSchema.void({
    Request: ProjectionThreadStatusEntry,
    execute: (row) =>
      sql`
            INSERT INTO projection_thread_status_entries (
              thread_id,
              status_key,
              status_text,
              updated_at
            )
            VALUES (
              ${row.threadId},
              ${row.statusKey},
              ${row.statusText},
              ${row.updatedAt}
            )
            ON CONFLICT (thread_id, status_key)
            DO UPDATE SET
              status_text = excluded.status_text,
              updated_at = excluded.updated_at
          `,
  });

  const deleteProjectionThreadStatusEntryRow = SqlSchema.void({
    Request: DeleteProjectionThreadStatusEntryInput,
    execute: ({ threadId, statusKey }) =>
      sql`
        DELETE FROM projection_thread_status_entries
        WHERE thread_id = ${threadId} AND status_key = ${statusKey}
      `,
  });

  const listProjectionThreadStatusEntryRows = SqlSchema.findAll({
    Request: ListProjectionThreadStatusEntriesInput,
    Result: ProjectionThreadStatusEntry,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status_key AS "statusKey",
          status_text AS "statusText",
          updated_at AS "updatedAt"
        FROM projection_thread_status_entries
        WHERE thread_id = ${threadId}
        ORDER BY updated_at ASC, status_key ASC
      `,
  });

  const deleteProjectionThreadStatusEntryRows = SqlSchema.void({
    Request: DeleteProjectionThreadStatusEntriesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_status_entries
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadStatusEntryRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadStatusEntryRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadStatusEntryRepository.upsert:query",
          "ProjectionThreadStatusEntryRepository.upsert:encodeRequest",
        ),
      ),
    );

  const remove: ProjectionThreadStatusEntryRepositoryShape["delete"] = (input) =>
    deleteProjectionThreadStatusEntryRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadStatusEntryRepository.delete:query",
          "ProjectionThreadStatusEntryRepository.delete:encodeRequest",
        ),
      ),
    );

  const listByThreadId: ProjectionThreadStatusEntryRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadStatusEntryRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadStatusEntryRepository.listByThreadId:query",
          "ProjectionThreadStatusEntryRepository.listByThreadId:decodeRows",
        ),
      ),
    );

  const deleteByThreadId: ProjectionThreadStatusEntryRepositoryShape["deleteByThreadId"] = (
    input,
  ) =>
    deleteProjectionThreadStatusEntryRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadStatusEntryRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    delete: remove,
    listByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadStatusEntryRepositoryShape;
});

export const ProjectionThreadStatusEntryRepositoryLive = Layer.effect(
  ProjectionThreadStatusEntryRepository,
  makeProjectionThreadStatusEntryRepository,
);
