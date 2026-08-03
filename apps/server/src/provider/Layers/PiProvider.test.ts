import * as PlatformError from "effect/PlatformError";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "@effect/vitest";
import { PiSettings } from "@t3tools/contracts";

import {
  checkPiProviderStatus,
  flattenPiModels,
  MINIMUM_PI_VERSION,
  parsePiModelTable,
} from "./PiProvider.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const decodeSettings = (overrides: Partial<PiSettings> = {}): PiSettings =>
  decodePiSettings(overrides);

const makeScriptedSpawner = (script: {
  readonly onArgs: (args: ReadonlyArray<string>) => ChildProcessSpawner.ChildProcessHandle;
}) =>
  ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (!ChildProcess.isStandardCommand(command)) {
        throw new Error("expected a standard pi command");
      }
      return script.onArgs(command.args);
    }),
  );

const makeStdoutHandle = (stdout: string, exitCode = 0) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.encodeText(Stream.make(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const runProbe = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  settings: PiSettings = decodeSettings(),
) =>
  Effect.gen(function* () {
    const result = yield* checkPiProviderStatus(settings, "/tmp/pi-probe-test", undefined);
    return result;
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.runPromise,
  );

describe("parsePiModelTable", () => {
  it("parses the fixed-width table, skipping the header row", () => {
    const stdout = [
      "provider        model                       context  max-out  thinking  images",
      "anthropic       claude-sonnet-4-6           1M       128K     yes       yes   ",
      "anthropic       claude-haiku-4-5            200K     64K      yes       yes   ",
      "cloudflare-workers-ai  @cf/moonshotai/kimi-k2.6  1M    128K     no        no   ",
      "",
      "not a table row",
    ].join("\n");

    const rows = parsePiModelTable(stdout);
    expect(rows).toEqual([
      { provider: "anthropic", model: "claude-sonnet-4-6", thinking: true },
      { provider: "anthropic", model: "claude-haiku-4-5", thinking: true },
      { provider: "cloudflare-workers-ai", model: "@cf/moonshotai/kimi-k2.6", thinking: false },
    ]);
  });

  it("flattens rows into provider/model slugs split at the FIRST slash only", () => {
    const models = flattenPiModels([
      { provider: "anthropic", model: "claude-sonnet-4-6", thinking: true },
      { provider: "cloudflare-workers-ai", model: "@cf/moonshotai/kimi-k2.6", thinking: false },
    ]);

    expect(models).toHaveLength(2);
    // Rows sort by model name; "@cf/..." sorts before "claude-sonnet-4-6".
    expect(models[0]).toMatchObject({
      slug: "cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6",
      name: "@cf/moonshotai/kimi-k2.6",
      subProvider: "cloudflare-workers-ai",
      isCustom: false,
      capabilities: { optionDescriptors: [] },
    });
    expect(models[1]).toMatchObject({
      slug: "anthropic/claude-sonnet-4-6",
      capabilities: {
        optionDescriptors: [{ id: "thinking", label: "Thinking", type: "boolean" }],
      },
    });
  });
});

describe("checkPiProviderStatus", () => {
  it("reports ready with probe-reported models and thinking descriptors", async () => {
    const spawner = makeScriptedSpawner({
      onArgs: (args) => {
        if (args.includes("--version")) {
          return makeStdoutHandle("0.83.0\n");
        }
        if (args.includes("--list-models")) {
          return makeStdoutHandle(
            [
              "provider  model            context  max-out  thinking  images",
              "anthropic  claude-sonnet-4-6  1M      128K     yes       yes",
              "openai     gpt-5.6          1M      128K     no        no",
            ].join("\n") + "\n",
          );
        }
        throw new Error(`unexpected args: ${args.join(" ")}`);
      },
    });

    const snapshot = await runProbe(spawner);
    expect(snapshot.installed).toBe(true);
    expect(snapshot.version).toBe("0.83.0");
    expect(snapshot.status).toBe("ready");
    expect(snapshot.auth).toEqual({ status: "unknown" });
    expect((snapshot.models ?? []).map((model) => model.slug)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.6",
    ]);
  });

  it("gates on the minimum pi version", async () => {
    const spawner = makeScriptedSpawner({
      onArgs: () => makeStdoutHandle("0.80.3\n"),
    });

    const snapshot = await runProbe(spawner);
    expect(snapshot.installed).toBe(true);
    expect(snapshot.version).toBe("0.80.3");
    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toBe(
      `Pi v0.80.3 is too old. Upgrade to v${MINIMUM_PI_VERSION} or newer.`,
    );
  });

  it("reports not installed when the binary is missing", async () => {
    const spawner = ChildProcessSpawner.make((_command) =>
      Effect.fail(
        new PlatformError.PlatformError(
          new PlatformError.SystemError({
            _tag: "NotFound",
            module: "test",
            method: "spawn",
          }),
        ),
      ),
    );

    const snapshot = await runProbe(spawner);
    expect(snapshot.installed).toBe(false);
    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toBe("Pi CLI (`pi`) is not installed or not on PATH.");
  });

  it("warns on a zero-model table (pi already auth-filters)", async () => {
    const spawner = makeScriptedSpawner({
      onArgs: (args) =>
        args.includes("--version")
          ? makeStdoutHandle("0.83.0\n")
          : makeStdoutHandle("provider  model  context  max-out  thinking  images\n"),
    });

    const snapshot = await runProbe(spawner);
    expect(snapshot.installed).toBe(true);
    expect(snapshot.status).toBe("warning");
    expect(snapshot.message).toMatch(/did not report any available models/);
  });

  it("reports disabled without spawning", async () => {
    let spawnCount = 0;
    const spawner = ChildProcessSpawner.make((_command) => {
      spawnCount++;
      return Effect.sync(() => makeStdoutHandle("0.83.0\n"));
    });

    const snapshot = await runProbe(spawner, decodeSettings({ enabled: false }));
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.status).toBe("disabled");
    expect(spawnCount).toBe(0);
  });
});
