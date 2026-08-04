import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadStatusEntry = Schema.Struct({
  threadId: ThreadId,
  statusKey: TrimmedNonEmptyString,
  statusText: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadStatusEntry = typeof ProjectionThreadStatusEntry.Type;

export const UpsertProjectionThreadStatusEntryInput = ProjectionThreadStatusEntry;
export type UpsertProjectionThreadStatusEntryInput =
  typeof UpsertProjectionThreadStatusEntryInput.Type;

export const DeleteProjectionThreadStatusEntryInput = Schema.Struct({
  threadId: ThreadId,
  statusKey: TrimmedNonEmptyString,
});
export type DeleteProjectionThreadStatusEntryInput =
  typeof DeleteProjectionThreadStatusEntryInput.Type;

export const ListProjectionThreadStatusEntriesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadStatusEntriesInput =
  typeof ListProjectionThreadStatusEntriesInput.Type;

export const DeleteProjectionThreadStatusEntriesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadStatusEntriesInput =
  typeof DeleteProjectionThreadStatusEntriesInput.Type;

export interface ProjectionThreadStatusEntryRepositoryShape {
  readonly upsert: (
    entry: UpsertProjectionThreadStatusEntryInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly delete: (
    input: DeleteProjectionThreadStatusEntryInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadStatusEntriesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadStatusEntry>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadStatusEntriesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadStatusEntryRepository extends Context.Service<
  ProjectionThreadStatusEntryRepository,
  ProjectionThreadStatusEntryRepositoryShape
>()(
  "t3/persistence/Services/ProjectionThreadStatusEntries/ProjectionThreadStatusEntryRepository",
) {}
