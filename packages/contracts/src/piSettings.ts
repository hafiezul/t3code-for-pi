import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas.ts";

/**
 * Contracts for T3's pi environment config editor: reads and writes the
 * single `<agentDir>/settings.json` file (pi's global settings, see the
 * settings-surface research asset for the file contract).
 *
 * Read returns the whole file plus a curated view of the three editable
 * keys. Write accepts either a curated patch (read-modify-write merge of
 * exactly defaultProvider / defaultModel / defaultThinkingLevel) or a raw
 * whole-file replace; both return the merged read-back so the form can
 * re-render from the server's view (the file is re-read at write time and
 * may have been touched by pi or another editor).
 */

export const PiSettingsFileCurated = Schema.Struct({
  // Null (or empty string on input) = key unset / omitted from the file.
  defaultProvider: Schema.NullOr(TrimmedString),
  defaultModel: Schema.NullOr(TrimmedString),
  defaultThinkingLevel: Schema.NullOr(TrimmedString),
});
export type PiSettingsFileCurated = typeof PiSettingsFileCurated.Type;

export const PiSettingsFileSnapshot = Schema.Struct({
  /** Resolved settings.json path, for display. */
  path: TrimmedString,
  exists: Schema.Boolean,
  /** Raw file content; "" when the file does not exist. */
  content: Schema.String,
  /** File exists but strict JSON.parse failed — pi runs on defaults until fixed. */
  malformed: Schema.Boolean,
  curated: PiSettingsFileCurated,
});
export type PiSettingsFileSnapshot = typeof PiSettingsFileSnapshot.Type;

export const PiSettingsFileWriteInput = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("curated"),
    curated: PiSettingsFileCurated,
  }),
  Schema.Struct({
    mode: Schema.Literal("raw"),
    /** Whole-file content; strict JSON, validated before writing. */
    content: Schema.String,
  }),
]);
export type PiSettingsFileWriteInput = typeof PiSettingsFileWriteInput.Type;

export class PiSettingsFileError extends Schema.TaggedErrorClass<PiSettingsFileError>()(
  "PiSettingsFileError",
  {
    operation: Schema.Literals(["read", "write-curated", "write-raw"]),
    detail: Schema.String,
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.path === undefined
      ? `Pi settings file ${this.operation} failed: ${this.detail}`
      : `Pi settings file ${this.operation} failed at ${this.path}: ${this.detail}`;
  }
}
