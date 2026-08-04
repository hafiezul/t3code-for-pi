import {
  type ModelCapabilities,
  type PiSettings,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
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
 * Minimum pi version the adapter depends on. 0.80.5 is the first
 * installable release with `agent_settled` (the turn-complete signal,
 * shipped as 0.80.4 which was never published to npm) plus the
 * `--session-id` create-or-resume fix — see wayfinder #45/#51.
 */
export const MINIMUM_PI_VERSION = "0.80.5";

const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
} as const;

const DEFAULT_PI_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/** One row of `pi --list-models` output that the probe cares about. */
export interface PiModelTableRow {
  readonly provider: string;
  readonly model: string;
  /** `thinking` column: `yes`/`no`. */
  readonly thinking: boolean;
}

function parsePiModelTableRow(line: string): PiModelTableRow | undefined {
  const tokens = line
    .split(/\s{2,}/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  // Cells are single whitespace-free tokens; the header row's first cell is
  // the literal `provider`. Model ids may contain `/`, so the slug split at
  // the first `/` happens downstream — never split cells here.
  if (tokens.length < 2 || tokens[0] === "provider") {
    return undefined;
  }
  return {
    provider: tokens[0]!,
    model: tokens[1]!,
    thinking: tokens[4] === "yes",
  };
}

/**
 * Parse the fixed-width `pi --list-models` table. Skip the header row and
 * any non-matching line defensively (warnings live on stderr).
 */
export function parsePiModelTable(stdout: string): ReadonlyArray<PiModelTableRow> {
  const rows: Array<PiModelTableRow> = [];
  for (const line of stdout.split("\n")) {
    const row = parsePiModelTableRow(line);
    if (row) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * pi's universal thinking levels (`--thinking`). Models map unsupported
 * levels to their nearest supported one (pi clamps, e.g. `low` → `high` on
 * models whose `thinkingLevelMap` has no low tier), so the full set is safe
 * to offer. A picked level is applied at session spawn; pi's own default
 * applies when nothing is selected.
 */
const PI_THINKING_LEVELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
];

/**
 * Flatten `pi --list-models` rows into `ServerProviderModel`s. Slug is
 * `<provider>/<model>` split at the FIRST `/` only (model ids may contain
 * slashes, e.g. `@cf/moonshotai/kimi-k2.6`); name = model id (pi has no
 * display-name column); the `thinking` column becomes a thinking-level
 * select descriptor (the model's available tiers are per-model and only
 * visible through a live session, so the probe offers pi's universal set
 * and pi clamps per model).
 */ export function flattenPiModels(
  rows: ReadonlyArray<PiModelTableRow>,
): ReadonlyArray<ServerProviderModel> {
  return rows
    .map(
      (row): ServerProviderModel => ({
        slug: `${row.provider}/${row.model}`,
        name: row.model,
        subProvider: row.provider,
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: row.thinking
            ? [
                buildSelectOptionDescriptor({
                  id: "thinkingLevel",
                  label: "Thinking",
                  options: PI_THINKING_LEVELS,
                }),
              ]
            : [],
        }),
      }),
    )
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export const makePendingPiProvider = (piSettings: PiSettings): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings(
      [],
      piSettings.customModels,
      DEFAULT_PI_MODEL_CAPABILITIES,
    );

    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi provider status has not been checked in this session yet.",
      },
    });
  });

function formatPiProbeFailure(input: {
  readonly cause: unknown;
  readonly version: string | null;
}): { readonly installed: boolean; readonly message: string } {
  const cause = input.cause;
  if (isCommandMissingCause(cause)) {
    return {
      installed: false,
      message: "Pi CLI (`pi`) is not installed or not on PATH.",
    };
  }
  const detail =
    cause instanceof Error && typeof cause.message === "string" && cause.message.trim().length > 0
      ? cause.message.trim()
      : undefined;
  return {
    installed: true,
    message: detail
      ? `Failed to execute Pi CLI health check: ${detail}`
      : "Failed to execute Pi CLI health check.",
  };
}

/** One row of the pi `get_commands` response that the probe cares about.
 *  The response shape is version-mobile (`sourceInfo` in 0.83.0 vs
 *  `location`/`path` in older docs) — parse only the stable fields. */
export interface PiCommandRow {
  readonly name: string;
  readonly description: string | undefined;
  readonly source: "extension" | "prompt" | "skill";
}

const PI_COMMAND_SOURCE_GROUPS: ReadonlyArray<{
  readonly source: PiCommandRow["source"];
  readonly group: string;
}> = [
  { source: "extension", group: "Extension" },
  { source: "skill", group: "Skill" },
  { source: "prompt", group: "Prompt" },
];

// Hoisted decoder for the probe's stdout lines (the parser selects the
// get_commands response among pi's boot noise).
const parseJsonLine = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

function parsePiCommandRow(record: Record<string, unknown>): PiCommandRow | undefined {
  const name = typeof record.name === "string" ? record.name.trim() : undefined;
  if (!name || name.length === 0) {
    return undefined;
  }
  const description = typeof record.description === "string" ? record.description : undefined;
  let source: PiCommandRow["source"];
  switch (record.source) {
    case "extension":
      source = "extension";
      break;
    case "skill":
      source = "skill";
      break;
    // pi renamed "template" to "prompt" across releases — tolerate both.
    case "prompt":
    case "template":
      source = "prompt";
      break;
    default:
      return undefined;
  }
  return { name, description, source };
}

/**
 * Parse the `get_commands` RPC response from pi's stdout. The probe
 * subprocess emits `extension_ui_request` boot noise BEFORE the response,
 * so only the line whose record is a `get_commands` response is selected.
 * Malformed lines are skipped defensively.
 */
export function parsePiCommands(stdout: string): ReadonlyArray<PiCommandRow> {
  const rows: Array<PiCommandRow> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let record: unknown;
    try {
      record = parseJsonLine(trimmed);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      continue;
    }
    const parsed = record as Record<string, unknown>;
    if (parsed.type !== "response" || parsed.command !== "get_commands") {
      continue;
    }
    // pi 0.83.0 nests the rows under `data.commands`; older builds/docs
    // put the array directly on `data` — tolerate both.
    const data = parsed.data;
    const entries = Array.isArray(data)
      ? data
      : typeof data === "object" &&
          data !== null &&
          Array.isArray((data as Record<string, unknown>).commands)
        ? ((data as Record<string, unknown>).commands as Array<unknown>)
        : null;
    if (entries === null) {
      continue;
    }
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const row = parsePiCommandRow(entry as Record<string, unknown>);
      if (row) {
        rows.push(row);
      }
    }
  }
  return rows;
}

/**
 * Flatten get_commands rows into `ServerProviderSlashCommand`s, ordered by
 * pi's execution precedence (extension → skill → prompt) and deduped by
 * lowercase name keeping the first occurrence (mirrors `dedupeSlashCommands`
 * on the Claude side). Names are invocation-ready (`skill:` prefix kept);
 * `input.hint` is left unset — pi 0.83.0's response carries no argument
 * hint (map a future `argumentHint` to `input.hint`).
 */
export function flattenPiCommands(
  rows: ReadonlyArray<PiCommandRow>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const groupBySource = new Map<PiCommandRow["source"], string>(
    PI_COMMAND_SOURCE_GROUPS.map(({ source, group }) => [source, group]),
  );
  const seen = new Set<string>();
  const commands: Array<ServerProviderSlashCommand> = [];
  for (const source of PI_COMMAND_SOURCE_GROUPS.map(({ source }) => source)) {
    for (const row of rows) {
      if (row.source !== source) {
        continue;
      }
      const key = row.name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      commands.push({
        name: row.name,
        ...(row.description !== undefined && row.description.length > 0
          ? { description: row.description }
          : {}),
        group: groupBySource.get(source),
      });
    }
  }
  return commands;
}
/**
 * Snapshot probe for a Pi instance — OpenCode-shaped:
 *   1. `pi --version` gated on `MINIMUM_PI_VERSION` (the only gate; no
 *      runtime feature probes — see wayfinder #51).
 *   2. `pi --list-models` inventory; the table is already auth-filtered by
 *      pi, so a 0-model table is the honest "no connected upstream" signal.
 *   3. `pi --mode rpc --no-session` + one `get_commands` line — the command
 *      inventory for the composer menu. Enrichment only: a failed or empty
 *      probe degrades to an empty list, never a failed provider. Same cwd
 *      and snapshot cadence as the models probe (wayfinder #54).
 *
 * Missing binary → `installed: false`. No extra TTL beyond the managed
 * snapshot cadence (pi reloads `models.json` per `/model` open).
 */
export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const customModels = piSettings.customModels;

  const fallback = (cause: unknown, version: string | null = null) => {
    const failure = formatPiProbeFailure({ cause, version });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_PI_MODEL_CAPABILITIES),
      probe: {
        installed: failure.installed,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: failure.message,
      },
    });
  };

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_PI_MODEL_CAPABILITIES),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  const runPi = (args: ReadonlyArray<string>) =>
    spawnAndCollect(
      piSettings.binaryPath,
      ChildProcess.make(piSettings.binaryPath, [...args], {
        cwd,
        env: resolvedEnvironment,
        extendEnv: false,
      }),
    );

  // The get_commands probe pipes one JSON line into stdin (closed on done
  // — pi answers then exits on EOF) and collects stdout. Fixed args only,
  // never user launchArgs (consistent with the models probe).
  const runGetCommandsProbe = () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(piSettings.binaryPath, ["--mode", "rpc", "--no-session"], {
          cwd,
          env: resolvedEnvironment,
          extendEnv: false,
          stdin: {
            // One fixed get_commands line; closing stdin (endOnDone) makes
            // pi answer and exit — the empirical probe pipes exactly this.
            stream: Stream.encodeText(Stream.make(`{"type":"get_commands"}\n`)),
            endOnDone: true,
          },
        }),
      );
      const [stdout] = yield* Effect.all(
        [collectStreamAsString(child.stdout), child.exitCode.pipe(Effect.map(Number))],
        { concurrency: "unbounded" },
      );
      return stdout;
    }).pipe(Effect.scoped);

  const versionExit = yield* Effect.exit(runPi(["--version"]));
  if (versionExit._tag === "Failure") {
    return fallback(Cause.squash(versionExit.cause));
  }
  const version = parseGenericCliVersion(versionExit.value.stdout) ?? null;

  if (!version) {
    return fallback(
      new Error(
        `Unable to determine Pi version from \`pi --version\` output. T3 Code requires Pi v${MINIMUM_PI_VERSION} or newer.`,
      ),
      null,
    );
  }
  if (compareSemverVersions(version, MINIMUM_PI_VERSION) < 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_PI_MODEL_CAPABILITIES),
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Pi v${version} is too old. Upgrade to v${MINIMUM_PI_VERSION} or newer.`,
      },
    });
  }

  const inventoryExit = yield* Effect.exit(runPi(["--list-models"]));
  if (inventoryExit._tag === "Failure") {
    return fallback(Cause.squash(inventoryExit.cause), version);
  }

  const models = providerModelsFromSettings(
    flattenPiModels(parsePiModelTable(inventoryExit.value.stdout)),
    customModels,
    DEFAULT_PI_MODEL_CAPABILITIES,
  );
  const availableCount = models.filter((model) => !model.isCustom).length;

  // Command inventory: enrichment. Any failure or timeout degrades to an
  // empty list — the snapshot stays "ready" from the models probe above.
  const commandsExit = yield* Effect.exit(runGetCommandsProbe());
  const slashCommands =
    commandsExit._tag === "Success" ? flattenPiCommands(parsePiCommands(commandsExit.value)) : [];

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    slashCommands,
    probe: {
      installed: true,
      version,
      status: availableCount > 0 ? "ready" : "warning",
      auth: { status: "unknown" },
      message:
        availableCount > 0
          ? `${availableCount} model${availableCount === 1 ? "" : "s"} available through Pi.`
          : "Pi is available, but it did not report any available models. Check your API keys in `~/.pi/agent/models.json`.",
    },
  });
});
