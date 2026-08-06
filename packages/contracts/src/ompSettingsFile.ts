import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas.ts";

/**
 * Contracts for T3's OMP config editor: reads and writes the OMP agent's
 * `config.yml` — `~/.omp/profiles/<name>/agent/config.yml` when the
 * instance targets a profile, else the agent home's `config.yml`
 * (`PI_CODING_AGENT_DIR` or `~/.omp/agent`). See the config/auth/profiles
 * research asset for the file contract (verified against omp v17.2.7).
 *
 * Read returns the whole file plus a curated view of the two editable
 * keys (`defaultThinkingLevel` and `modelRoles`, the latter as
 * `role=provider/model` lines). Write accepts either a curated patch
 * (read-modify-write merge of exactly those two keys) or a raw whole-file
 * YAML replace; both return the merged read-back so the form can re-render
 * from the server's view. Config changes apply on the next omp session
 * launch — the file is read at process start and there is no reload path.
 */

/**
 * The default thinking level enum OMP accepts for `defaultThinkingLevel`
 * (verified in the config research asset). Empty = key unset.
 */
export const OMP_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type OmpThinkingLevel = (typeof OMP_THINKING_LEVELS)[number];

export const OmpSettingsFileCurated = Schema.Struct({
  // Null (or empty string on input) = key unset / omitted from the file.
  defaultThinkingLevel: Schema.NullOr(TrimmedString),
  // Keyed textarea: one `role=provider/model` line per model role. Null (or
  // empty string on input) = modelRoles key unset / omitted.
  modelRoles: Schema.NullOr(TrimmedString),
});
export type OmpSettingsFileCurated = typeof OmpSettingsFileCurated.Type;

export const OmpSettingsFileGetInput = Schema.Struct({
  /** OMP profile whose config file to target. Empty = default profile. */
  profile: TrimmedString,
});
export type OmpSettingsFileGetInput = typeof OmpSettingsFileGetInput.Type;

export const OmpSettingsFileSnapshot = Schema.Struct({
  /** Resolved config.yml path, for display. */
  path: TrimmedString,
  exists: Schema.Boolean,
  /** Raw file content; "" when the file does not exist. */
  content: Schema.String,
  /** File exists but YAML parsing failed — omp runs on defaults until fixed. */
  malformed: Schema.Boolean,
  curated: OmpSettingsFileCurated,
});
export type OmpSettingsFileSnapshot = typeof OmpSettingsFileSnapshot.Type;

export const OmpSettingsFileWriteInput = Schema.Union([
  Schema.Struct({
    profile: TrimmedString,
    mode: Schema.Literal("curated"),
    curated: OmpSettingsFileCurated,
  }),
  Schema.Struct({
    profile: TrimmedString,
    mode: Schema.Literal("raw"),
    /** Whole-file content; valid YAML, validated before writing. */
    content: Schema.String,
  }),
]);
export type OmpSettingsFileWriteInput = typeof OmpSettingsFileWriteInput.Type;

export class OmpSettingsFileError extends Schema.TaggedErrorClass<OmpSettingsFileError>()(
  "OmpSettingsFileError",
  {
    operation: Schema.Literals(["read", "write-curated", "write-raw"]),
    detail: Schema.String,
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.path === undefined
      ? `OMP settings file ${this.operation} failed: ${this.detail}`
      : `OMP settings file ${this.operation} failed at ${this.path}: ${this.detail}`;
  }
}
