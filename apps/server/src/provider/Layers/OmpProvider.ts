import {
  type ModelCapabilities,
  type OmpSettings,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { createModelCapabilities } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

/**
 * Minimum omp version the adapter supports. 17.0.9 is the floor chosen by
 * the version-gate decision: the first release with protocol v2 +
 * `get_messages_page` (the readThread/paging dependency that a future
 * session-read slice may use). The adapter's own readThread mirrors Pi
 * (empty snapshot — T3's event store is the conversation truth), so the
 * gate is conservative headroom, not a live dependency.
 */
export const MINIMUM_OMP_VERSION = "17.0.9";

const OMP_PRESENTATION = {
  displayName: "OMP",
} as const;

const DEFAULT_OMP_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/** Bounded timeouts for the best-effort RPC catalog probes — cold catalog
 *  discovery can hang for minutes (prototype NOTES #1), so both probes are
 *  time-boxed and degrade instead of failing the provider. */
const OMP_MODELS_PROBE_TIMEOUT_MS = 90_000;
const OMP_COMMANDS_PROBE_TIMEOUT_MS = 30_000;

export const makePendingOmpProvider = (
  ompSettings: OmpSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = providerModelsFromSettings(
      [],
      ompSettings.customModels,
      DEFAULT_OMP_MODEL_CAPABILITIES,
    );
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: ompSettings.enabled
          ? "OMP provider status has not been checked in this session yet."
          : "OMP is disabled in T3 Code settings.",
      },
    });
  });

function formatOmpProbeFailure(input: { cause: unknown; version: string | null }): {
  readonly installed: boolean;
  readonly message: string;
} {
  if (isCommandMissingCause(input.cause)) {
    return {
      installed: false,
      message: "OMP CLI (`omp`) is not installed or not on PATH.",
    };
  }
  const detail =
    input.cause instanceof Error && input.cause.message.trim().length > 0
      ? input.cause.message.trim()
      : "Unknown error.";
  return {
    installed: true,
    message: `Failed to execute OMP CLI health check: ${detail}`,
  };
}

/** One row of the `get_available_models` response the probe cares about. */
export interface OmpModelRow {
  readonly provider: string;
  /** Selectable model id — the slug suffix OMP's `--model` accepts
   *  (`provider/id`). Falls back to the display name on protocol variants
   *  that only carry `name`. */
  readonly id: string;
  readonly name: string;
  readonly thinkingEffects: ReadonlyArray<string>;
}

function parseOmpModelRow(record: Record<string, unknown>): OmpModelRow | undefined {
  // The live response rows are flat (`{id, name, provider, thinking}` —
  // verified against omp 17.2.7); tolerate a nested `model` object for
  // protocol age variance.
  const modelRecord =
    typeof record.model === "object" && record.model !== null
      ? (record.model as Record<string, unknown>)
      : record;
  const provider = record.provider;
  if (typeof provider !== "string" || provider.trim().length === 0) {
    return undefined;
  }
  const id = modelRecord.id;
  const name = modelRecord.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return undefined;
  }
  const resolvedId = typeof id === "string" && id.trim().length > 0 ? id.trim() : name.trim();
  const thinking = modelRecord.thinking;
  const thinkingEffects: ReadonlyArray<string> =
    typeof thinking === "object" && thinking !== null
      ? (() => {
          // Live protocol key is `efforts` (verified against omp 17.2.7);
          // accept the spec-era `effects` spelling too.
          const thinkingRecord = thinking as Record<string, unknown>;
          const effects = thinkingRecord.efforts ?? thinkingRecord.effects;
          return Array.isArray(effects)
            ? effects.filter((effect): effect is string => typeof effect === "string")
            : [];
        })()
      : [];
  return {
    provider: provider.trim(),
    id: resolvedId,
    name: name.trim(),
    thinkingEffects,
  };
}

/** One JSONL line from a probe's stdout that names the response the probe
 *  asked for. `data` is either a bare array or an object carrying the
 *  entries under `key` (protocol age tolerance). */
function scanOmpRpcResponseRows(
  stdout: string,
  commandName: string,
  key: string,
  parseRow: (record: Record<string, unknown>) => unknown | undefined,
): Array<unknown> {
  const rows: Array<unknown> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type !== "response" || record.command !== commandName) {
      continue;
    }
    const data = record.data;
    const entries = Array.isArray(data)
      ? data
      : typeof data === "object" &&
          data !== null &&
          Array.isArray((data as Record<string, unknown>)[key])
        ? ((data as Record<string, unknown>)[key] as ReadonlyArray<unknown>)
        : [];
    for (const entry of entries) {
      if (typeof entry === "object" && entry !== null) {
        const row = parseRow(entry as Record<string, unknown>);
        if (row !== undefined) {
          rows.push(row);
        }
      }
    }
  }
  return rows;
}

/**
 * Parse the `get_available_models` RPC response from OMP's stdout. The
 * probe pipes one command line into a `--no-session` RPC process and
 * selects the response among boot noise.
 */
export function parseOmpModels(stdout: string): ReadonlyArray<OmpModelRow> {
  return scanOmpRpcResponseRows(stdout, "get_available_models", "models", (record) =>
    parseOmpModelRow(record),
  ) as ReadonlyArray<OmpModelRow>;
}

/**
 * Flatten `get_available_models` rows into `ServerProviderModel`s. Slug is
 * `provider/id` (the wire form OMP's `--model` accepts; display names can
 * differ from ids — e.g. `anthropic/claude-3-7-sonnet-20250219` vs
 * "Claude Sonnet 3.7"), name is the display name; a thinking-tier
 * descriptor is built from the model's own `thinking.efforts` (observed
 * `["high","max"]`), absent when the model has none.
 */
export function flattenOmpModels(
  rows: ReadonlyArray<OmpModelRow>,
): ReadonlyArray<ServerProviderModel> {
  return rows.map((row) => ({
    slug: `${row.provider}/${row.id}`,
    name: row.name,
    subProvider: row.provider,
    isCustom: false,
    capabilities:
      row.thinkingEffects.length > 0
        ? createModelCapabilities({
            optionDescriptors: [
              buildSelectOptionDescriptor({
                id: "thinkingLevel",
                label: "Thinking",
                options: row.thinkingEffects.map((effect) => ({ value: effect, label: effect })),
              }),
            ],
          })
        : DEFAULT_OMP_MODEL_CAPABILITIES,
  }));
}

/** One row of the `get_available_commands` response that the probe cares
 *  about. The response shape is version-mobile — parse only stable fields. */
export interface OmpCommandRow {
  readonly name: string;
  readonly description: string | undefined;
  readonly hint: string | undefined;
  readonly group: string | undefined;
}

const OMP_COMMAND_SOURCE_GROUPS: ReadonlyArray<{
  readonly source: string;
  readonly group: string;
}> = [
  { source: "builtin", group: "Builtin" },
  { source: "extension", group: "Extension" },
  { source: "custom", group: "Custom" },
  { source: "file", group: "Prompt" },
  { source: "skill", group: "Skill" },
];

function parseOmpCommandRow(record: Record<string, unknown>): OmpCommandRow | undefined {
  const name = record.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return undefined;
  }
  const description =
    typeof record.description === "string" && record.description.trim().length > 0
      ? record.description.trim()
      : undefined;
  const input = record.input;
  const hint =
    typeof input === "object" && input !== null
      ? (() => {
          const hintValue = (input as Record<string, unknown>).hint;
          return typeof hintValue === "string" && hintValue.trim().length > 0
            ? hintValue.trim()
            : undefined;
        })()
      : undefined;
  const rawSource = record.source;
  const source =
    typeof rawSource === "string" && rawSource.trim().length > 0 ? rawSource.trim() : undefined;
  const group =
    source === undefined
      ? undefined
      : OMP_COMMAND_SOURCE_GROUPS.find((entry) => entry.source === source)?.group;
  return { name: name.trim(), description, hint, group };
}

/**
 * Parse the `get_available_commands` RPC response from OMP's stdout. The
 * probe pipes one command line into a `--no-session` RPC process and
 * selects the response among boot noise; the data is either a bare array
 * or an object carrying a `commands` array (protocol age tolerance).
 */
export function parseOmpCommands(stdout: string): ReadonlyArray<OmpCommandRow> {
  return scanOmpRpcResponseRows(stdout, "get_available_commands", "commands", (record) =>
    parseOmpCommandRow(record),
  ) as ReadonlyArray<OmpCommandRow>;
}

/**
 * Flatten get_available_commands rows into `ServerProviderSlashCommand`s,
 * ordered builtin → extension → custom → file, deduped by lowercase name.
 */
export function flattenOmpCommands(
  rows: ReadonlyArray<OmpCommandRow>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  const commands: Array<ServerProviderSlashCommand> = [];
  for (const group of OMP_COMMAND_SOURCE_GROUPS) {
    for (const row of rows) {
      if (row.group !== group.group) {
        continue;
      }
      const key = row.name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      commands.push({
        name: row.name,
        ...(row.description ? { description: row.description } : {}),
        ...(row.hint ? { input: { hint: row.hint } } : {}),
        group: group.group,
      });
    }
  }
  // Rows without a recognized source group ride the builtin bucket so
  // ungrouped commands still surface.
  for (const row of rows) {
    if (row.group !== undefined) {
      continue;
    }
    const key = row.name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    commands.push({
      name: row.name,
      ...(row.description ? { description: row.description } : {}),
      ...(row.hint ? { input: { hint: row.hint } } : {}),
    });
  }
  return commands;
}

/** Why a bounded RPC catalog probe did not deliver a response. `timeout`
 *  means the probe was still running when its budget expired; `failed`
 *  means it could not spawn, errored, or exited abnormally. */
class OmpRpcProbeError extends Data.TaggedError("OmpRpcProbeError")<{
  readonly reason: "timeout" | "failed";
  readonly detail: string;
}> {}

const asOmpRpcProbeError = (cause: unknown): OmpRpcProbeError => {
  if (cause instanceof OmpRpcProbeError) {
    return cause;
  }
  const detail =
    cause instanceof Error && cause.message.trim().length > 0
      ? cause.message.trim()
      : "Unknown error.";
  return new OmpRpcProbeError({ reason: "failed", detail });
};

/** One JSONL command piped into a `--no-session` RPC probe process; the
 *  child answers then exits on stdin EOF. Fixed args only, never user
 *  launchArgs. Bounded — cold discovery can hang minutes. */
const runOmpRpcProbe = (input: {
  binaryPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  commandLine: string;
  timeoutMs: number;
}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(input.binaryPath, ["--mode", "rpc-ui", "--no-session"], {
        cwd: input.cwd,
        env: input.env,
        extendEnv: false,
        stdin: {
          stream: Stream.encodeText(Stream.make(`${input.commandLine}\n`)),
          endOnDone: true,
        },
      }),
    );
    const [stdout, exitCode] = yield* Effect.all(
      [collectStreamAsString(child.stdout), child.exitCode.pipe(Effect.map(Number))],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* Effect.fail(
        new OmpRpcProbeError({
          reason: "failed",
          detail: `OMP RPC probe exited with status ${exitCode}.`,
        }),
      );
    }
    return stdout;
  }).pipe(
    Effect.scoped,
    Effect.mapError(asOmpRpcProbeError),
    Effect.timeout(Duration.millis(input.timeoutMs)),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new OmpRpcProbeError({
          reason: "timeout",
          detail: `OMP RPC probe timed out after ${input.timeoutMs}ms.`,
        }),
      ),
    ),
  );

/**
 * Snapshot probe for an OMP instance — OpenCode-shaped:
 *  1. version gate: `omp --version`, floor MINIMUM_OMP_VERSION (the only
 *     gate — no feature probes);
 *  2. model catalog: best-effort RPC probe (`get_available_models`),
 *     bounded; empty/failed inventory → warning status;
 *  3. command inventory: best-effort RPC probe (`get_available_commands`),
 *     bounded; failure degrades to an empty list, never a failed provider.
 */
export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  ompSettings: OmpSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const customModels = ompSettings.customModels;

  const fallback = (cause: unknown, version: string | null = null) => {
    const failure = formatOmpProbeFailure({ cause, version });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_OMP_MODEL_CAPABILITIES),
      probe: {
        installed: failure.installed,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: failure.message,
      },
    });
  };

  if (!ompSettings.enabled) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: false,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_OMP_MODEL_CAPABILITIES),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OMP is disabled in T3 Code settings.",
      },
    });
  }

  const runOmp = (args: ReadonlyArray<string>) =>
    spawnAndCollect(
      ompSettings.binaryPath,
      ChildProcess.make(ompSettings.binaryPath, [...args], {
        cwd,
        env: resolvedEnvironment,
        extendEnv: false,
      }),
    );

  const runModelProbe = () =>
    runOmpRpcProbe({
      binaryPath: ompSettings.binaryPath,
      cwd,
      env: resolvedEnvironment,
      commandLine: `{"type":"get_available_models"}`,
      timeoutMs: OMP_MODELS_PROBE_TIMEOUT_MS,
    });

  const runCommandProbe = () =>
    runOmpRpcProbe({
      binaryPath: ompSettings.binaryPath,
      cwd,
      env: resolvedEnvironment,
      commandLine: `{"type":"get_available_commands"}`,
      timeoutMs: OMP_COMMANDS_PROBE_TIMEOUT_MS,
    });

  const versionExit = yield* Effect.exit(runOmp(["--version"]));
  if (versionExit._tag === "Failure") {
    return fallback(Cause.squash(versionExit.cause));
  }
  const version = parseGenericCliVersion(versionExit.value.stdout) ?? null;

  if (!version) {
    return fallback(
      new Error(
        `Unable to determine OMP version from \`omp --version\` output. T3 Code requires OMP v${MINIMUM_OMP_VERSION} or newer.`,
      ),
      null,
    );
  }
  if (compareSemverVersions(version, MINIMUM_OMP_VERSION) < 0) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_OMP_MODEL_CAPABILITIES),
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `OMP v${version} is too old. Upgrade to v${MINIMUM_OMP_VERSION} or newer.`,
      },
    });
  }

  // Model catalog: best-effort. A failed or timed-out probe degrades to a
  // warning snapshot — never a failed provider (cold discovery can hang).
  // The failure reason is kept so the card can name the probe outcome
  // instead of misdiagnosing it as missing API keys.
  const modelsExit = yield* Effect.exit(runModelProbe());
  const modelProbeFailure =
    modelsExit._tag === "Failure" ? asOmpRpcProbeError(Cause.squash(modelsExit.cause)) : undefined;
  if (modelProbeFailure) {
    yield* Effect.logWarning("OMP model catalog probe did not complete.", {
      reason: modelProbeFailure.reason,
      detail: modelProbeFailure.detail,
      version,
    });
  }
  const modelRows = modelsExit._tag === "Success" ? parseOmpModels(modelsExit.value) : [];
  const models = providerModelsFromSettings(
    flattenOmpModels(modelRows),
    customModels,
    DEFAULT_OMP_MODEL_CAPABILITIES,
  );
  const availableCount = models.filter((model) => !model.isCustom).length;

  const catalogMessage = modelProbeFailure
    ? modelProbeFailure.reason === "timeout"
      ? "OMP is available, but the model catalog probe timed out. Models appear once a later probe completes."
      : "OMP is available, but the model catalog probe did not complete. Models appear once a later probe succeeds."
    : availableCount > 0
      ? `${availableCount} model${availableCount === 1 ? "" : "s"} available through OMP.`
      : "OMP is available, but it did not report any available models. Check your API keys in the OMP settings card.";

  // Command inventory: enrichment. Any failure or timeout degrades to an
  // empty list — the snapshot stays at the models probe's status.
  const commandsExit = yield* Effect.exit(runCommandProbe());
  const slashCommands =
    commandsExit._tag === "Success" ? flattenOmpCommands(parseOmpCommands(commandsExit.value)) : [];

  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    slashCommands,
    probe: {
      installed: true,
      version,
      status: availableCount > 0 ? "ready" : "warning",
      auth: { status: "unknown" },
      message: catalogMessage,
    },
  });
});
