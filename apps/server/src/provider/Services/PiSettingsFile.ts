import * as NodeOS from "node:os";

import {
  PiSettingsFileCurated,
  PiSettingsFileError,
  PiSettingsFileSnapshot,
  PiSettingsFileWriteInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { writeFileStringAtomically } from "../../atomicWrite.ts";

/**
 * Read/write service for pi's global `settings.json` (wayfinder #56/#60).
 *
 * File contract (verified against pi 0.83.0): one strict-JSON object at
 * `<agentDir>/settings.json` where agentDir = `PI_CODING_AGENT_DIR` env or
 * `~/.pi/agent`. Unknown keys and pi-managed keys must survive every write
 * (read-modify-write merge for curated fields). Edits take effect on the
 * next pi process start — RPC sessions have no reload path.
 *
 * Write discipline: re-read the file immediately before writing (pi's
 * startup migrations can rewrite it without a lock), and write via the
 * repo's atomic temp-file+rename so a torn file can never land on disk.
 * pi itself locks with proper-lockfile; the atomic rename gives the same
 * "never a partial file" guarantee on the T3 side, and T3-spawned RPC
 * sessions never write the file (verified), so in practice T3 is the only
 * writer. A simultaneously-running interactive pi is the one writer pair
 * the rename doesn't serialize with — their manual edits are preserved by
 * the re-read, and last-writer-wins applies only to the same key.
 */

const CURATED_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel"] as const;

const PI_SETTINGS_FILE_NAME = "settings.json";

export interface PiSettingsFileShape {
  readonly read: () => Effect.Effect<PiSettingsFileSnapshot, PiSettingsFileError>;
  readonly write: (
    input: PiSettingsFileWriteInput,
  ) => Effect.Effect<PiSettingsFileSnapshot, PiSettingsFileError>;
}

export class PiSettingsFile extends Context.Service<PiSettingsFile, PiSettingsFileShape>()(
  "t3/provider/Services/PiSettingsFile",
) {}

const resolveSettingsPath = (input: {
  readonly path: Path.Path;
  readonly environment: NodeJS.ProcessEnv;
}): string => {
  const agentDirOverride = input.environment.PI_CODING_AGENT_DIR?.trim();
  const agentDir =
    agentDirOverride && agentDirOverride.length > 0
      ? agentDirOverride.replace(/^~(?=\/|$)/, NodeOS.homedir())
      : input.path.join(NodeOS.homedir(), ".pi", "agent");
  return input.path.join(agentDir, PI_SETTINGS_FILE_NAME);
};

/** Strict JSON parse without throwing (pure — safe outside Effect). */
function tryParseJson(content: string): { readonly parsed: unknown; readonly malformed: boolean } {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { parsed: null, malformed: false };
  }
  try {
    return { parsed: JSON.parse(trimmed), malformed: false };
  } catch {
    return { parsed: null, malformed: true };
  }
}

function extractCurated(parsed: unknown): PiSettingsFileCurated {
  const record =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return {
    defaultProvider:
      typeof record.defaultProvider === "string" && record.defaultProvider.length > 0
        ? record.defaultProvider
        : null,
    defaultModel:
      typeof record.defaultModel === "string" && record.defaultModel.length > 0
        ? record.defaultModel
        : null,
    defaultThinkingLevel:
      typeof record.defaultThinkingLevel === "string" && record.defaultThinkingLevel.length > 0
        ? record.defaultThinkingLevel
        : null,
  };
}

function serializeRecord(record: Record<string, unknown>): string {
  return JSON.stringify(record, null, 2);
}

const toSettingsError = (operation: "read" | "write-curated" | "write-raw") => (cause: unknown) =>
  new PiSettingsFileError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const makePiSettingsFile = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const read = (): Effect.Effect<PiSettingsFileSnapshot, PiSettingsFileError> =>
    Effect.gen(function* () {
      const settingsPath = resolveSettingsPath({ path, environment: process.env });
      const exists = yield* fileSystem
        .exists(settingsPath)
        .pipe(Effect.mapError(toSettingsError("read")));
      if (!exists) {
        return {
          path: settingsPath,
          exists: false,
          content: "",
          malformed: false,
          curated: extractCurated(null),
        };
      }
      const content = yield* fileSystem
        .readFileString(settingsPath)
        .pipe(Effect.mapError(toSettingsError("read")));
      const { parsed, malformed } = tryParseJson(content);
      return {
        path: settingsPath,
        exists: true,
        content,
        malformed,
        curated: extractCurated(parsed),
      };
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const write = (
    input: PiSettingsFileWriteInput,
  ): Effect.Effect<PiSettingsFileSnapshot, PiSettingsFileError> =>
    Effect.gen(function* () {
      const settingsPath = resolveSettingsPath({ path, environment: process.env });
      const operation = input.mode === "curated" ? "write-curated" : "write-raw";

      // Re-read at write time, never cache: pi's startup migrations can
      // rewrite the file without the lock (#56).
      const exists = yield* fileSystem
        .exists(settingsPath)
        .pipe(Effect.mapError(toSettingsError(operation)));
      const currentContent = exists
        ? yield* fileSystem
            .readFileString(settingsPath)
            .pipe(Effect.mapError(toSettingsError(operation)))
        : "";
      const { parsed, malformed } = tryParseJson(currentContent);

      let nextContent: string;
      if (input.mode === "curated") {
        // Curated merge can't preserve unknown keys on a malformed file —
        // refuse rather than silently resetting pi to defaults. Raw mode is
        // the way out (the user's corrected content replaces the file).
        if (malformed) {
          return yield* new PiSettingsFileError({
            operation: "write-curated",
            detail:
              "The file on disk is malformed JSON. Fix it in the Raw JSON editor before saving curated fields.",
            path: settingsPath,
          });
        }
        const record =
          typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? { ...(parsed as Record<string, unknown>) }
            : {};
        for (const key of CURATED_KEYS) {
          const value = input.curated[key];
          if (value === null || value.trim().length === 0) {
            delete record[key];
          } else {
            record[key] = value.trim();
          }
        }
        nextContent = serializeRecord(record);
      } else {
        // Raw whole-file replace: strict validation first — never write a
        // file pi would silently treat as "everything default" (#56).
        const validation = tryParseJson(input.content);
        if (validation.malformed) {
          return yield* new PiSettingsFileError({
            operation: "write-raw",
            detail: "The Raw JSON editor contains invalid JSON. Fix the errors before saving.",
            path: settingsPath,
          });
        }
        nextContent = input.content;
      }

      yield* writeFileStringAtomically({
        filePath: settingsPath,
        contents: nextContent,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(toSettingsError(operation)),
      );

      // Return the merged read-back so the form re-renders from the
      // server's view (two-way sync, #59).
      return yield* read();
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  return { read, write } satisfies PiSettingsFileShape;
});

export const PiSettingsFileLive = Layer.effect(PiSettingsFile, makePiSettingsFile);
