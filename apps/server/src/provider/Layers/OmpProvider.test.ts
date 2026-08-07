import * as PlatformError from "effect/PlatformError";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "@effect/vitest";
import { OmpSettings } from "@t3tools/contracts";

import {
  checkOmpProviderStatus,
  flattenOmpCommands,
  flattenOmpModels,
  MINIMUM_OMP_VERSION,
  parseOmpCommands,
  parseOmpModels,
} from "./OmpProvider.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const decodeSettings = (overrides: Partial<OmpSettings> = {}): OmpSettings =>
  decodeOmpSettings(overrides);

const makeScriptedSpawner = (script: {
  readonly onArgs: (args: ReadonlyArray<string>) => ChildProcessSpawner.ChildProcessHandle;
}) =>
  ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (!ChildProcess.isStandardCommand(command)) {
        throw new Error("expected a standard omp command");
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

/** A probe child that never emits and never exits — used to drive the
 *  bounded probe timeout under `TestClock`. */
const makeHangingHandle = () =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.fromEffect(Effect.never),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const runProbe = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  settings: OmpSettings = decodeSettings(),
) =>
  Effect.gen(function* () {
    const result = yield* checkOmpProviderStatus(settings, "/tmp/omp-probe-test", undefined);
    return result;
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.runPromise,
  );

describe("parseOmpModels", () => {
  it("parses flat response rows into provider/id/name triples with thinking effects", () => {
    const stdout = [
      JSON.stringify({ type: "ready", protocolVersion: 2 }),
      JSON.stringify({
        type: "response",
        command: "get_available_models",
        success: true,
        data: {
          models: [
            {
              provider: "opencode-go",
              id: "deepseek-v4-flash",
              name: "DeepSeek V4 Flash",
              thinking: { mode: "effort", efforts: ["high", "max"] },
            },
            {
              provider: "anthropic",
              id: "claude-opus-4-8",
              name: "Claude Opus 4.8",
            },
            {
              provider: "openai-codex",
              id: "gpt-5.4",
              name: "GPT-5.4",
              thinking: { efforts: [] },
            },
          ],
        },
      }),
      JSON.stringify({ type: "response", command: "get_available_commands", success: true }),
    ].join("\n");

    const rows = parseOmpModels(stdout);
    expect(rows).toEqual([
      {
        provider: "opencode-go",
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        thinkingEffects: ["high", "max"],
      },
      {
        provider: "anthropic",
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        thinkingEffects: [],
      },
      { provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4", thinkingEffects: [] },
    ]);
  });

  it("tolerates a bare-array data shape and non-model boot noise", () => {
    const stdout = JSON.stringify({
      type: "response",
      command: "get_available_models",
      success: true,
      data: [{ provider: "ollama", id: "llama3.3", name: "Llama 3.3" }],
    });
    expect(parseOmpModels(stdout)).toEqual([
      { provider: "ollama", id: "llama3.3", name: "Llama 3.3", thinkingEffects: [] },
    ]);
  });

  it("tolerates nested model objects and name-only rows", () => {
    const stdout = JSON.stringify({
      type: "response",
      command: "get_available_models",
      success: true,
      data: {
        models: [
          { provider: "ollama", model: { name: "llama3.3" } },
          { provider: "ollama", id: "llama3.3:70b", name: "Llama 3.3 70B" },
          {
            provider: "ollama",
            id: "llama3.3:8b",
            name: "Llama 3.3 8B",
            thinking: { effects: ["high"] },
          },
        ],
      },
    });
    expect(parseOmpModels(stdout)).toEqual([
      { provider: "ollama", id: "llama3.3", name: "llama3.3", thinkingEffects: [] },
      { provider: "ollama", id: "llama3.3:70b", name: "Llama 3.3 70B", thinkingEffects: [] },
      { provider: "ollama", id: "llama3.3:8b", name: "Llama 3.3 8B", thinkingEffects: ["high"] },
    ]);
  });

  it("ignores malformed lines", () => {
    expect(parseOmpModels("not json\n{ bad json")).toEqual([]);
  });
});

describe("parseOmpCommands", () => {
  it("parses command rows with source groups and input hints", () => {
    const stdout = JSON.stringify({
      type: "response",
      command: "get_available_commands",
      success: true,
      data: {
        commands: [
          { name: "compact", description: "Compact the conversation", source: "builtin" },
          {
            name: "quota",
            description: "Show usage",
            input: { hint: "provider" },
            source: "builtin",
          },
          { name: "fix", source: "extension", description: "Run the fixer" },
          { name: "review", source: "custom", description: "Review the diff" },
          { name: "my-prompt", source: "file", description: "Prompt file" },
          { name: "ungrouped", description: "No source" },
        ],
      },
    });

    const rows = parseOmpCommands(stdout);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({
      name: "compact",
      description: "Compact the conversation",
      hint: undefined,
      group: "Builtin",
    });
    expect(rows[1]?.hint).toBe("provider");
    expect(rows[2]?.group).toBe("Extension");
    expect(rows[3]?.group).toBe("Custom");
    expect(rows[4]?.group).toBe("Prompt");
    expect(rows[5]?.group).toBeUndefined();
  });

  it("tolerates a bare-array data shape", () => {
    const stdout = JSON.stringify({
      type: "response",
      command: "get_available_commands",
      success: true,
      data: [{ name: "compact", source: "builtin" }],
    });
    expect(parseOmpCommands(stdout)).toEqual([
      { name: "compact", description: undefined, hint: undefined, group: "Builtin" },
    ]);
  });
});

describe("flattenOmpModels", () => {
  it("builds provider/id slugs with display names and thinking tier descriptors", () => {
    const models = flattenOmpModels([
      {
        provider: "opencode-go",
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        thinkingEffects: ["high", "max"],
      },
      {
        provider: "anthropic",
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        thinkingEffects: [],
      },
    ]);

    expect(models[0]?.slug).toBe("opencode-go/deepseek-v4-flash");
    expect(models[0]?.name).toBe("DeepSeek V4 Flash");
    expect(models[0]?.isCustom).toBe(false);
    expect(models[0]?.capabilities?.optionDescriptors).toEqual([
      {
        id: "thinkingLevel",
        label: "Thinking",
        type: "select",
        options: [
          { id: "high", label: "high" },
          { id: "max", label: "max" },
        ],
      },
    ]);
    expect(models[1]?.slug).toBe("anthropic/claude-opus-4-8");
    expect(models[1]?.name).toBe("Claude Opus 4.8");
    expect(models[1]?.capabilities?.optionDescriptors).toEqual([]);
  });
});

describe("flattenOmpCommands", () => {
  it("orders by group, dedupes by lowercase name, and keeps ungrouped commands", () => {
    const commands = flattenOmpCommands([
      { name: "fix", description: undefined, hint: undefined, group: "Extension" },
      { name: "Compact", description: undefined, hint: undefined, group: "Builtin" },
      { name: "compact", description: "dup", hint: undefined, group: "Builtin" },
      { name: "review", description: undefined, hint: undefined, group: "Custom" },
      { name: "my-prompt", description: undefined, hint: undefined, group: "Prompt" },
      { name: "orphan", description: undefined, hint: undefined, group: undefined },
    ]);

    expect(commands.map((command) => command.name)).toEqual([
      "Compact",
      "fix",
      "review",
      "my-prompt",
      "orphan",
    ]);
    expect(commands.map((command) => command.group)).toEqual([
      "Builtin",
      "Extension",
      "Custom",
      "Prompt",
      undefined,
    ]);
    expect(commands[1]?.name).toBe("fix");
  });

  it("carries hints into the input contract", () => {
    const commands = flattenOmpCommands([
      { name: "quota", description: "Show usage", hint: "provider", group: "Builtin" },
    ]);
    expect(commands[0]?.input).toEqual({ hint: "provider" });
  });
});

describe("checkOmpProviderStatus", () => {
  it("reports ready with models from the RPC catalog", async () => {
    const spawner = makeScriptedSpawner({
      onArgs: (args) => {
        if (args[0] === "--version") {
          return makeStdoutHandle(`omp ${MINIMUM_OMP_VERSION}\n`);
        }
        expect(args).toEqual(["--mode", "rpc-ui", "--no-session"]);
        return makeStdoutHandle(
          JSON.stringify({
            type: "response",
            command: "get_available_models",
            success: true,
            data: {
              models: [
                {
                  provider: "opencode-go",
                  id: "deepseek-v4-flash",
                  name: "DeepSeek V4 Flash",
                  thinking: { efforts: ["high", "max"] },
                },
              ],
            },
          }) + "\n",
        );
      },
    });

    const snapshot = await runProbe(spawner);
    expect(snapshot.installed).toBe(true);
    expect(snapshot.version).toBe(MINIMUM_OMP_VERSION);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.message).toContain("1 model available");
    expect(snapshot.models).toHaveLength(1);
    expect(snapshot.models[0]?.slug).toBe("opencode-go/deepseek-v4-flash");
  });

  it("gates on the minimum version", async () => {
    const spawner = makeScriptedSpawner({
      onArgs: (args) => {
        if (args[0] === "--version") {
          return makeStdoutHandle("omp 17.0.8\n");
        }
        throw new Error("version gate must stop the probe");
      },
    });

    const snapshot = await runProbe(spawner);
    expect(snapshot.installed).toBe(true);
    expect(snapshot.version).toBe("17.0.8");
    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toBe(
      `OMP v17.0.8 is too old. Upgrade to v${MINIMUM_OMP_VERSION} or newer.`,
    );
  });

  it("reports a model catalog probe that exits abnormally as a probe failure", async () => {
    let rpcCalls = 0;
    const spawner = makeScriptedSpawner({
      onArgs: (args) => {
        if (args[0] === "--version") {
          return makeStdoutHandle(`omp ${MINIMUM_OMP_VERSION}\n`);
        }
        rpcCalls += 1;
        return makeStdoutHandle("", 1);
      },
    });

    const snapshot = await runProbe(spawner);
    expect(snapshot.status).toBe("warning");
    expect(snapshot.message).toContain("model catalog probe did not complete");
    expect(snapshot.message).not.toContain("API keys");
    expect(snapshot.models).toHaveLength(0);
    // A failed catalog probe must still leave a usable provider snapshot —
    // installed, versioned, and with the command inventory still attempted.
    expect(snapshot.installed).toBe(true);
    expect(snapshot.version).toBe(MINIMUM_OMP_VERSION);
    expect(rpcCalls).toBe(2);
    expect(snapshot.slashCommands).toEqual([]);
  });

  it("reports a model catalog probe that fails to spawn as a probe failure", async () => {
    const spawner = ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command)) {
        return Effect.die(new Error("expected a standard omp command"));
      }
      return command.args[0] === "--version"
        ? Effect.sync(() => makeStdoutHandle(`omp ${MINIMUM_OMP_VERSION}\n`))
        : Effect.fail(
            new PlatformError.PlatformError(
              new PlatformError.SystemError({
                _tag: "PermissionDenied",
                module: "test",
                method: "spawn",
              }),
            ),
          );
    });

    const snapshot = await runProbe(spawner);
    expect(snapshot.status).toBe("warning");
    expect(snapshot.message).toContain("model catalog probe did not complete");
    expect(snapshot.message).not.toContain("API keys");
    expect(snapshot.installed).toBe(true);
    expect(snapshot.version).toBe(MINIMUM_OMP_VERSION);
  });

  it("reports a timed-out model catalog probe as a timeout, not missing API keys", () =>
    Effect.gen(function* () {
      let rpcCalls = 0;
      const spawner = makeScriptedSpawner({
        onArgs: (args) => {
          if (args[0] === "--version") {
            return makeStdoutHandle(`omp ${MINIMUM_OMP_VERSION}\n`);
          }
          rpcCalls += 1;
          // Only the models probe hangs; the commands probe answers at once.
          return rpcCalls === 1 ? makeHangingHandle() : makeStdoutHandle("", 0);
        },
      });

      const fiber = yield* checkOmpProviderStatus(
        decodeSettings(),
        "/tmp/omp-probe-test",
        undefined,
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.minutes(5));
      const snapshot = yield* Fiber.join(fiber);

      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toContain("model catalog probe timed out");
      expect(snapshot.message).not.toContain("API keys");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe(MINIMUM_OMP_VERSION);
      expect(snapshot.models).toHaveLength(0);
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise));

  it("keeps the API-key advice when the catalog probe succeeds with zero models", async () => {
    const spawner = makeScriptedSpawner({
      onArgs: (args) => {
        if (args[0] === "--version") {
          return makeStdoutHandle(`omp ${MINIMUM_OMP_VERSION}\n`);
        }
        return makeStdoutHandle(
          JSON.stringify({
            type: "response",
            command: "get_available_models",
            success: true,
            data: { models: [] },
          }) + "\n",
        );
      },
    });

    const snapshot = await runProbe(spawner);
    expect(snapshot.status).toBe("warning");
    expect(snapshot.message).toContain("did not report any available models");
    expect(snapshot.message).toContain("API keys");
    expect(snapshot.models).toHaveLength(0);
  });

  it("reports a missing binary as not installed", async () => {
    const spawner = ChildProcessSpawner.make((command) =>
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
    expect(snapshot.message).toContain("not installed or not on PATH");
  });

  it("skips probing entirely when disabled", async () => {
    let spawnCount = 0;
    const spawner = makeScriptedSpawner({
      onArgs: () => {
        spawnCount += 1;
        throw new Error("disabled provider must not spawn");
      },
    });

    const snapshot = await runProbe(spawner, decodeSettings({ enabled: false }));
    expect(spawnCount).toBe(0);
    expect(snapshot.status).toBe("disabled");
    expect(snapshot.message).toContain("disabled");
  });

  it("degrades a failed command inventory to an empty list without failing the provider", async () => {
    // The models probe runs before the commands probe; script by call order.
    let rpcCalls = 0;
    const spawner = makeScriptedSpawner({
      onArgs: (args) => {
        if (args[0] === "--version") {
          return makeStdoutHandle(`omp ${MINIMUM_OMP_VERSION}\n`);
        }
        rpcCalls += 1;
        if (rpcCalls === 1) {
          return makeStdoutHandle(
            JSON.stringify({
              type: "response",
              command: "get_available_models",
              success: true,
              data: {
                models: [
                  { provider: "opencode-go", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
                ],
              },
            }) + "\n",
          );
        }
        return makeStdoutHandle("", 1);
      },
    });

    const snapshot = await runProbe(spawner);
    expect(snapshot.models).toHaveLength(1);
    expect(snapshot.slashCommands).toEqual([]);
    expect(snapshot.status).toBe("ready");
  });

  it("exposes the command inventory when the probe succeeds", async () => {
    // Both RPC probes share `--mode rpc-ui --no-session`; the models probe
    // runs first, then the commands probe.
    let rpcCalls = 0;
    const spawner = makeScriptedSpawner({
      onArgs: (args) => {
        if (args[0] === "--version") {
          return makeStdoutHandle(`omp ${MINIMUM_OMP_VERSION}\n`);
        }
        rpcCalls += 1;
        if (rpcCalls === 1) {
          return makeStdoutHandle(
            JSON.stringify({
              type: "response",
              command: "get_available_models",
              success: true,
              data: {
                models: [
                  { provider: "opencode-go", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
                ],
              },
            }) + "\n",
          );
        }
        expect(args).toEqual(["--mode", "rpc-ui", "--no-session"]);
        return makeStdoutHandle(
          JSON.stringify({
            type: "response",
            command: "get_available_commands",
            success: true,
            data: {
              commands: [
                { name: "compact", source: "builtin", description: "Compact" },
                { name: "quota", source: "builtin", description: "Usage", input: { hint: "x" } },
              ],
            },
          }) + "\n",
        );
      },
    });

    const snapshot = await runProbe(spawner);
    expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["compact", "quota"]);
    expect(snapshot.slashCommands[1]?.input).toEqual({ hint: "x" });
    expect(snapshot.status).toBe("ready");
  });
});
