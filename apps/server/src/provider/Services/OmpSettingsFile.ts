import * as NodeOS from "node:os";

import {
  OMP_THINKING_LEVELS,
  OmpSettingsFileCurated,
  OmpSettingsFileError,
  OmpSettingsFileSnapshot,
  OmpSettingsFileWriteInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { parseDocument, stringify } from "yaml";

import { writeFileStringAtomically } from "../../atomicWrite.ts";

/**
 * Read/write service for omp's `config.yml` (wayfinder #64, ticket #76).
 *
 * File contract (verified against omp v17.2.7): one sparse YAML object at
 * `<agentDir>/config.yml` where agentDir = `PI_CODING_AGENT_DIR` env or
 * `~/.omp/agent` — or `~/.omp/profiles/<name>/agent` when the instance
 * targets a profile. Unknown keys must survive every write (read-modify-
 * write merge for curated fields). The file is read at omp process start;
 * there is no reload watcher, so edits take effect on the next session
 * launch. `--config <overlay>` files and `omp config set` are not used —
 * direct YAML read/write only.
 *
 * Write discipline mirrors pi's settings file: re-read immediately before
 * writing (no cache), and write via the repo's atomic temp-file+rename so
 * a torn file can never land on disk. A simultaneously-running interactive
 * omp holds `config.yml.lock` and may rewrite the file; the re-read
 * preserves their manual edits and last-writer-wins applies only to the
 * keys this editor touches.
 */

const OMP_CONFIG_FILE_NAME = "config.yml";

/** Role line format: `role=provider/model` (a `:param` suffix is allowed). */
const MODEL_ROLE_LINE_PATTERN = /^[^=\s]+=[^=\s]+\/[^=\s]+$/;

export interface OmpSettingsFileShape {
  readonly read: (input: {
    readonly profile: string;
  }) => Effect.Effect<OmpSettingsFileSnapshot, OmpSettingsFileError>;
  readonly write: (
    input: OmpSettingsFileWriteInput,
  ) => Effect.Effect<OmpSettingsFileSnapshot, OmpSettingsFileError>;
}

export class OmpSettingsFile extends Context.Service<OmpSettingsFile, OmpSettingsFileShape>()(
  "t3/provider/Services/OmpSettingsFile",
) {}

const resolveSettingsPath = (input: {
  readonly path: Path.Path;
  readonly environment: NodeJS.ProcessEnv;
  readonly profile: string;
}): string => {
  const profile = input.profile.trim();
  if (profile.length > 0) {
    return input.path.join(
      NodeOS.homedir(),
      ".omp",
      "profiles",
      profile,
      "agent",
      OMP_CONFIG_FILE_NAME,
    );
  }
  const agentDirOverride = input.environment.PI_CODING_AGENT_DIR?.trim();
  const agentDir =
    agentDirOverride && agentDirOverride.length > 0
      ? agentDirOverride.replace(/^~(?=\/|$)/, NodeOS.homedir())
      : input.path.join(NodeOS.homedir(), ".omp", "agent");
  return input.path.join(agentDir, OMP_CONFIG_FILE_NAME);
};

/** Strict YAML parse without throwing (pure — safe outside Effect). */
function tryParseYaml(content: string): { readonly parsed: unknown; readonly malformed: boolean } {
  const document = parseDocument(content);
  if (document.errors.length > 0) {
    return { parsed: null, malformed: true };
  }
  return { parsed: document.toJS(), malformed: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** modelRoles (a record) as `role=provider/model` lines, in file order. Null = key unset. */
function serializeModelRoles(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const lines = Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([role, model]) => `${role}=${model}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Parse the keyed-textarea `role=provider/model` lines into the record
 * `modelRoles` wants. Returns the error detail (one line per message) when
 * any line is malformed.
 */
function parseModelRoles(content: string): { readonly roles: Record<string, string> } | string {
  const roles: Record<string, string> = {};
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (line.length === 0) {
      continue;
    }
    if (!MODEL_ROLE_LINE_PATTERN.test(line)) {
      return `Line ${index + 1} is not "role=provider/model" (e.g. "default=anthropic/claude-sonnet-4-6").`;
    }
    const separator = line.indexOf("=");
    roles[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return { roles };
}

function extractCurated(parsed: unknown): OmpSettingsFileCurated {
  const record = isRecord(parsed) ? parsed : {};
  return {
    defaultThinkingLevel:
      typeof record.defaultThinkingLevel === "string" && record.defaultThinkingLevel.length > 0
        ? record.defaultThinkingLevel
        : null,
    modelRoles: serializeModelRoles(record.modelRoles),
  };
}

const toSettingsError = (operation: "read" | "write-curated" | "write-raw") => (cause: unknown) =>
  new OmpSettingsFileError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const makeOmpSettingsFile = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const read = (input: {
    readonly profile: string;
  }): Effect.Effect<OmpSettingsFileSnapshot, OmpSettingsFileError> =>
    Effect.gen(function* () {
      const settingsPath = resolveSettingsPath({
        path,
        environment: process.env,
        profile: input.profile,
      });
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
      const { parsed, malformed } = tryParseYaml(content);
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
    input: OmpSettingsFileWriteInput,
  ): Effect.Effect<OmpSettingsFileSnapshot, OmpSettingsFileError> =>
    Effect.gen(function* () {
      const settingsPath = resolveSettingsPath({
        path,
        environment: process.env,
        profile: input.profile,
      });
      const operation = input.mode === "curated" ? "write-curated" : "write-raw";

      // Re-read at write time, never cache: a running interactive omp can
      // rewrite the file under `config.yml.lock`.
      const exists = yield* fileSystem
        .exists(settingsPath)
        .pipe(Effect.mapError(toSettingsError(operation)));
      const currentContent = exists
        ? yield* fileSystem
            .readFileString(settingsPath)
            .pipe(Effect.mapError(toSettingsError(operation)))
        : "";
      const { parsed, malformed } = tryParseYaml(currentContent);

      let nextContent: string;
      if (input.mode === "curated") {
        // Curated merge can't preserve unknown keys on a malformed file —
        // refuse rather than silently resetting omp to defaults. Raw mode is
        // the way out (the user's corrected content replaces the file).
        if (malformed) {
          return yield* new OmpSettingsFileError({
            operation: "write-curated",
            detail:
              "The file on disk is malformed YAML. Fix it in the Raw YAML editor before saving curated fields.",
            path: settingsPath,
          });
        }
        // A valid-but-non-mapping file (list, scalar) would lose its content
        // on a merge — refuse the same way, raw mode is the way out.
        if (parsed !== null && !isRecord(parsed)) {
          return yield* new OmpSettingsFileError({
            operation: "write-curated",
            detail:
              "The file on disk is not a YAML mapping. Fix it in the Raw YAML editor before saving curated fields.",
            path: settingsPath,
          });
        }
        const record = isRecord(parsed) ? { ...parsed } : {};

        const thinkingLevel = input.curated.defaultThinkingLevel?.trim() ?? "";
        if (thinkingLevel.length > 0) {
          if (!(OMP_THINKING_LEVELS as ReadonlyArray<string>).includes(thinkingLevel)) {
            return yield* new OmpSettingsFileError({
              operation: "write-curated",
              detail: `defaultThinkingLevel must be one of: ${OMP_THINKING_LEVELS.join(", ")}.`,
              path: settingsPath,
            });
          }
          record.defaultThinkingLevel = thinkingLevel;
        } else {
          delete record.defaultThinkingLevel;
        }

        const modelRolesText = input.curated.modelRoles ?? "";
        if (modelRolesText.trim().length > 0) {
          const parsedRoles = parseModelRoles(modelRolesText);
          if (typeof parsedRoles === "string") {
            return yield* new OmpSettingsFileError({
              operation: "write-curated",
              detail: parsedRoles,
              path: settingsPath,
            });
          }
          record.modelRoles = parsedRoles.roles;
        } else {
          delete record.modelRoles;
        }

        nextContent = stringify(record);
      } else {
        // Raw whole-file replace: strict validation first — never write a
        // file omp would silently treat as "everything default".
        const validation = tryParseYaml(input.content);
        if (validation.malformed) {
          return yield* new OmpSettingsFileError({
            operation: "write-raw",
            detail: "The Raw YAML editor contains invalid YAML. Fix the errors before saving.",
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
      // server's view (two-way sync).
      return yield* read({ profile: input.profile });
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  return { read, write } satisfies OmpSettingsFileShape;
});

export const OmpSettingsFileLive = Layer.effect(OmpSettingsFile, makeOmpSettingsFile);
