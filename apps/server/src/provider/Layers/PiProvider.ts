import {
  type ModelCapabilities,
  type PiSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { createModelCapabilities } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  buildBooleanOptionDescriptor,
  buildServerProvider,
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
 * Flatten `pi --list-models` rows into `ServerProviderModel`s. Slug is
 * `<provider>/<model>` split at the FIRST `/` only (model ids may contain
 * slashes, e.g. `@cf/moonshotai/kimi-k2.6`); name = model id (pi has no
 * display-name column); only the `thinking` column survives as a boolean
 * option descriptor (the Claude `claude-haiku-4-5` convention).
 */
export function flattenPiModels(
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
            ? [buildBooleanOptionDescriptor({ id: "thinking", label: "Thinking" })]
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

/**
 * Snapshot probe for a Pi instance — OpenCode-shaped:
 *   1. `pi --version` gated on `MINIMUM_PI_VERSION` (the only gate; no
 *      runtime feature probes — see wayfinder #51).
 *   2. `pi --list-models` inventory; the table is already auth-filtered by
 *      pi, so a 0-model table is the honest "no connected upstream" signal.
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
  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
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
