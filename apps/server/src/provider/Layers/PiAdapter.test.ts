import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Option from "effect/Option";
import { describe, expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import {
  isBenignPiStderrLine,
  isPiResumeCursor,
  makePiAdapter,
  mapPiEvent,
  piApiKeyEnvironment,
  piUiRequestToQuestions,
  resolvePiLaunchArgs,
  splitPiModelSlug,
  type PiResumeCursor,
} from "./PiAdapter.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const instanceId = ProviderInstanceId.make("pi");

const decodePiSettings = Schema.decodeSync(PiSettings);
const decodeSettings = (overrides: Partial<PiSettings> = {}): PiSettings =>
  decodePiSettings(overrides);

const threadId = ThreadId.make("thread-1");
const turnId = (value: string) => TurnId.make(value);

// ── Pure helpers ────────────────────────────────────────────────────────

describe("isBenignPiStderrLine", () => {
  it("filters pi's informational stderr notices", () => {
    expect(
      isBenignPiStderrLine(
        "Warning: No project session found with id 'abc'; creating a new session with that id.",
      ),
    ).toBe(true);
    expect(
      isBenignPiStderrLine('Warning: No models match pattern "openai-codex/gpt-5.6-sol"'),
    ).toBe(true);
  });

  it("keeps real pi errors", () => {
    expect(isBenignPiStderrLine("Error: Failed to connect to provider: connection refused")).toBe(
      false,
    );
    expect(isBenignPiStderrLine("TypeError: Cannot read properties of undefined")).toBe(false);
  });
});

describe("resolvePiLaunchArgs", () => {
  const sessionDir = "/tmp/t3/pi/sessions/abc";
  const cursor = (patch: Partial<PiResumeCursor>): PiResumeCursor => ({
    schemaVersion: 1,
    sessionFile: "/tmp/pi/sessions/x.jsonl",
    ...patch,
  });

  it("launches fresh with --session-id and the model", () => {
    expect(
      resolvePiLaunchArgs({
        threadId,
        sessionDir,
        resumeCursor: undefined,
        model: "anthropic/claude-sonnet-4-6",
        launchArgs: "",
      }),
    ).toEqual([
      "--mode",
      "rpc",
      "--session-dir",
      sessionDir,
      "--session-id",
      "thread-1",
      "--model",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("pins the picked thinking tier when one is selected", () => {
    expect(
      resolvePiLaunchArgs({
        threadId,
        sessionDir,
        resumeCursor: undefined,
        model: "anthropic/claude-sonnet-4-6",
        thinkingLevel: "low",
        launchArgs: "",
      }),
    ).toEqual([
      "--mode",
      "rpc",
      "--session-dir",
      sessionDir,
      "--session-id",
      "thread-1",
      "--model",
      "anthropic/claude-sonnet-4-6",
      "--thinking",
      "low",
    ]);
  });

  it("resumes a never-forked session with --session-id", () => {
    expect(
      resolvePiLaunchArgs({
        threadId,
        sessionDir,
        resumeCursor: cursor({ sessionId: "thread-1" }),
        model: undefined,
        launchArgs: "",
      }),
    ).toEqual(["--mode", "rpc", "--session-dir", sessionDir, "--session-id", "thread-1"]);
  });

  it("resumes a forked session with --session <file>", () => {
    expect(
      resolvePiLaunchArgs({
        threadId,
        sessionDir,
        resumeCursor: cursor({ sessionId: "a-random-fork-id" }),
        model: "openai/gpt-5.6",
        launchArgs: "",
      }),
    ).toEqual([
      "--mode",
      "rpc",
      "--session-dir",
      sessionDir,
      "--session",
      "/tmp/pi/sessions/x.jsonl",
      "--model",
      "openai/gpt-5.6",
    ]);
  });

  it("appends user launch args last", () => {
    const args = resolvePiLaunchArgs({
      threadId,
      sessionDir,
      resumeCursor: undefined,
      model: undefined,
      launchArgs: '--no-extensions "--name=my session"',
    });
    expect(args.slice(-2)).toEqual(["--no-extensions", "--name=my session"]);
  });
});

describe("splitPiModelSlug", () => {
  it("splits at the first slash only", () => {
    expect(splitPiModelSlug("anthropic/claude-sonnet-4-6")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    expect(splitPiModelSlug("cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6")).toEqual({
      provider: "cloudflare-workers-ai",
      modelId: "@cf/moonshotai/kimi-k2.6",
    });
  });

  it("keeps bare ids as-is", () => {
    expect(splitPiModelSlug("my-local-model")).toEqual({ modelId: "my-local-model" });
  });
});

describe("piApiKeyEnvironment", () => {
  it("maps the five key fields to env vars when set", () => {
    const env = piApiKeyEnvironment(
      decodeSettings({
        anthropicApiKey: "sk-ant",
        openaiApiKey: "sk-openai",
        xaiApiKey: "xai-1",
      }),
    );
    expect(env).toEqual({
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-openai",
      XAI_API_KEY: "xai-1",
    });
  });

  it("omits unset keys", () => {
    expect(piApiKeyEnvironment(decodeSettings({}))).toEqual({});
  });
});

describe("piUiRequestToQuestions", () => {
  it("maps select options onto T3 user-input options", () => {
    const questions = piUiRequestToQuestions({
      method: "select",
      id: ApprovalRequestId.make("req-1"),
      options: ["Allow", "Block"],
    });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toEqual({
      id: "req-1",
      header: "Pi extension",
      question: "Select an option",
      options: [
        { label: "Allow", description: "Allow" },
        { label: "Block", description: "Block" },
      ],
      multiSelect: false,
    });
  });
});

describe("PiResumeCursor schema", () => {
  it("round-trips the cursor shape", () => {
    const cursor: PiResumeCursor = {
      schemaVersion: 1,
      sessionFile: "/tmp/x.jsonl",
      sessionId: "thread-1",
      turnBoundaries: ["a", "b"],
    };
    expect(isPiResumeCursor(cursor)).toBe(true);
    expect(isPiResumeCursor({ schemaVersion: 2, sessionFile: "/tmp/x.jsonl" })).toBe(false);
    expect(isPiResumeCursor({ sessionFile: "/tmp/x.jsonl" })).toBe(false);
    expect(isPiResumeCursor({ schemaVersion: 1, sessionFile: "/tmp/x.jsonl" })).toBe(true);
  });
});

// ── Event translation ───────────────────────────────────────────────────

describe("mapPiEvent", () => {
  const baseInput = {
    threadId,
    activeTurnId: turnId("pi-turn-1"),
    messageItemId: "item-1",
    suppressSettled: false,
  };

  it("maps text deltas to assistant_text content deltas", () => {
    const mapped = mapPiEvent(
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " },
      },
      baseInput,
    );
    expect(mapped).toEqual([
      {
        turnId: "pi-turn-1",
        itemId: "item-1",
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: "Hello " },
      },
    ]);
  });

  it("drops deltas that arrive outside an assistant-role message", () => {
    expect(
      mapPiEvent(
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " },
        },
        { ...baseInput, messageItemId: undefined },
      ),
    ).toEqual([]);
  });

  it("skips user echoes and toolResult messages", () => {
    for (const role of ["user", "toolResult"]) {
      expect(
        mapPiEvent(
          {
            type: "message_start",
            message: {
              role,
              content: [{ type: "text", text: "ls output or user text" }],
            },
          },
          baseInput,
        ),
      ).toEqual([]);
      expect(
        mapPiEvent(
          {
            type: "message_end",
            message: { role, content: [{ type: "text", text: "ls output or user text" }] },
          },
          baseInput,
        ),
      ).toEqual([]);
    }
  });

  it("maps thinking deltas to reasoning_text content deltas", () => {
    const mapped = mapPiEvent(
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
      },
      baseInput,
    );
    expect(mapped).toEqual([
      {
        turnId: "pi-turn-1",
        itemId: "item-1",
        type: "content.delta",
        payload: { streamKind: "reasoning_text", delta: "hmm" },
      },
    ]);
  });

  it("maps message_start/end to assistant_message items sharing the item id", () => {
    const started = mapPiEvent(
      { type: "message_start", message: { role: "assistant" } },
      {
        ...baseInput,
        messageItemId: "msg-1",
      },
    );
    expect(started).toEqual([
      {
        turnId: "pi-turn-1",
        itemId: "msg-1",
        type: "item.started",
        payload: {
          itemType: "assistant_message",
          status: "inProgress",
          title: "Assistant message",
          data: { type: "message_start", message: { role: "assistant" } },
        },
      },
    ]);

    const completed = mapPiEvent(
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      },
      { ...baseInput, messageItemId: "msg-1" },
    );
    expect(completed[0]!.type).toBe("item.completed");
    expect(completed[0]!.payload).toMatchObject({
      itemType: "assistant_message",
      status: "completed",
      detail: "Hi",
    });
  });

  it("keeps thinking blocks out of assistant message detail", () => {
    const completed = mapPiEvent(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", text: "secret reasoning here" },
            { type: "text", text: "Final answer" },
          ],
        },
      },
      { ...baseInput, messageItemId: "msg-1" },
    );
    expect(completed[0]!.payload).toMatchObject({
      itemType: "assistant_message",
      status: "completed",
      detail: "Final answer",
    });

    const started = mapPiEvent(
      {
        type: "message_start",
        message: {
          role: "assistant",
          content: [{ type: "thinking", text: "secret reasoning here" }],
        },
      },
      { ...baseInput, messageItemId: "msg-2" },
    );
    expect(started[0]!.payload).toMatchObject({
      itemType: "assistant_message",
      status: "inProgress",
      title: "Assistant message",
    });
    expect((started[0]!.payload as { detail?: unknown }).detail).toBeUndefined();
  });

  it("keeps thinking blocks in custom_message extension output", () => {
    const mapped = mapPiEvent(
      {
        type: "custom_message",
        display: true,
        content: [
          { type: "thinking", text: "reasoning" },
          { type: "text", text: "done" },
        ],
      },
      baseInput,
    );
    expect(mapped).toEqual([
      {
        turnId: "pi-turn-1",
        type: "extension.notice",
        payload: { message: "reasoning\ndone", noticeType: "info" },
      },
    ]);
  });

  it("maps bash tool execution to command_execution items keyed by toolCallId", () => {
    const started = mapPiEvent(
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "ls -la" },
      },
      baseInput,
    );
    expect(started).toEqual([
      {
        turnId: "pi-turn-1",
        itemId: "call-1",
        type: "item.started",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "bash",
          detail: "ls -la",
          data: { tool: "bash", args: { command: "ls -la" } },
        },
      },
    ]);

    const failed = mapPiEvent(
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        isError: true,
        result: { content: [{ type: "text", text: "boom" }] },
      },
      baseInput,
    );
    expect(failed[0]!.payload).toMatchObject({
      itemType: "command_execution",
      status: "failed",
      detail: "boom",
    });
  });

  it("maps edit tools to file_change items and everything else to dynamic_tool_call", () => {
    expect(
      mapPiEvent(
        { type: "tool_execution_start", toolCallId: "c2", toolName: "edit-diff", args: {} },
        baseInput,
      )[0]!.payload,
    ).toMatchObject({ itemType: "file_change" });
    expect(
      mapPiEvent(
        { type: "tool_execution_start", toolCallId: "c3", toolName: "brave-search", args: {} },
        baseInput,
      )[0]!.payload,
    ).toMatchObject({ itemType: "dynamic_tool_call" });
  });

  it("maps compaction and auto-retry events", () => {
    const compaction = mapPiEvent({ type: "compaction_start", reason: "threshold" }, baseInput);
    expect(compaction[0]!.payload).toMatchObject({
      itemType: "context_compaction",
      status: "inProgress",
    });

    const retry = mapPiEvent(
      { type: "auto_retry_start", attempt: 1, delayMs: 2000, errorMessage: "529 overloaded" },
      baseInput,
    );
    expect(retry[0]!.type).toBe("runtime.warning");
    expect(retry[0]!.payload).toMatchObject({ message: expect.stringContaining("529 overloaded") });

    expect(mapPiEvent({ type: "auto_retry_end", success: true }, baseInput)).toEqual([]);
    expect(
      mapPiEvent({ type: "auto_retry_end", success: false, finalError: "kaput" }, baseInput)[0]!
        .payload,
    ).toMatchObject({ message: expect.stringContaining("kaput") });
  });

  it("emits turn.completed only on agent_settled for an active, unsuppressed turn", () => {
    expect(mapPiEvent({ type: "agent_settled" }, baseInput)).toEqual([
      { turnId: "pi-turn-1", type: "turn.completed", payload: { state: "completed" } },
    ]);
    expect(
      mapPiEvent({ type: "agent_settled" }, { ...baseInput, activeTurnId: undefined }),
    ).toEqual([]);
    expect(mapPiEvent({ type: "agent_settled" }, { ...baseInput, suppressSettled: true })).toEqual(
      [],
    );
  });

  it("surfaces visible custom messages as info notice rows and drops hidden ones", () => {
    expect(
      mapPiEvent(
        {
          type: "custom_message",
          customType: "pi-quota-status",
          content: "No tracked quota data yet.",
          display: true,
        },
        baseInput,
      ),
    ).toEqual([
      {
        turnId: "pi-turn-1",
        type: "extension.notice",
        payload: { message: "No tracked quota data yet.", noticeType: "info" },
      },
    ]);
    expect(
      mapPiEvent(
        { type: "custom_message", customType: "quota", content: "hidden", display: false },
        baseInput,
      ),
    ).toEqual([]);
  });

  it("surfaces custom-role message_start rows (pi's live form of sendMessage output)", () => {
    expect(
      mapPiEvent(
        {
          type: "message_start",
          message: { role: "custom", content: "No tracked quota data yet." },
        },
        baseInput,
      ),
    ).toEqual([
      {
        turnId: "pi-turn-1",
        type: "extension.notice",
        payload: { message: "No tracked quota data yet.", noticeType: "info" },
      },
    ]);
    expect(
      mapPiEvent({ type: "message_start", message: { role: "custom", content: "" } }, baseInput),
    ).toEqual([]);
  });

  it("ignores unknown and bookkeeping events by default", () => {
    for (const type of [
      "queue_update",
      "turn_start",
      "turn_end",
      "agent_start",
      "agent_end",
      "bash_execution_update",
      "some_future_event",
    ]) {
      expect(mapPiEvent({ type }, baseInput)).toEqual([]);
    }
  });

  it("drops toolcall deltas (tool_execution_* owns the item lifecycle)", () => {
    expect(
      mapPiEvent(
        { type: "message_update", assistantMessageEvent: { type: "toolcall_start" } },
        baseInput,
      ),
    ).toEqual([]);
  });
});

// ── Integration: scripted pi process ────────────────────────────────────

interface ScriptedPiState {
  readonly output: Queue.Queue<Uint8Array>;
  readonly observed: Queue.Queue<{
    readonly type: string;
    readonly command: Record<string, unknown>;
  }>;
  readonly handler: (command: Record<string, unknown>) => ReadonlyArray<Record<string, unknown>>;
}

const reply = (
  command: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: command.id,
  type: "response",
  command: command.type,
  success: true,
  ...extra,
});

const makeScriptedState = (handler: ScriptedPiState["handler"]): Effect.Effect<ScriptedPiState> =>
  Effect.gen(function* () {
    const output = yield* Queue.unbounded<Uint8Array>();
    const observed = yield* Queue.unbounded<{
      readonly type: string;
      readonly command: Record<string, unknown>;
    }>();
    return { output, observed, handler };
  });

/**
 * Fake ChildProcessSpawner that answers `pi --mode rpc` with a JSONL
 * round-trip: every command written to stdin is recorded on `observed` and
 * the handler's replies are streamed back on stdout.
 */
const makeScriptedSpawner = (
  state: ScriptedPiState,
  onSpawn?: (args: ReadonlyArray<string>, options: ChildProcess.CommandOptions) => void,
) =>
  ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) {
        return yield* Effect.die(new Error("expected a standard pi command"));
      }
      onSpawn?.(command.args, command.options);
      const exitNever = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const stdin = Sink.forEach((chunk: Uint8Array) =>
        Effect.gen(function* () {
          const text = Buffer.from(chunk).toString("utf8").trim();
          if (!text) {
            return;
          }
          let parsed: Record<string, unknown>;
          try {
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            parsed = JSON.parse(text) as Record<string, unknown>;
          } catch {
            return;
          }
          yield* Queue.offer(state.observed, { type: String(parsed.type), command: parsed });
          const replies = state.handler(parsed);
          for (const replyLine of replies) {
            yield* Queue.offer(
              state.output,
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              Buffer.from(JSON.stringify(replyLine) + "\n"),
            );
          }
        }),
      );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Deferred.await(exitNever).pipe(Effect.map(() => ChildProcessSpawner.ExitCode(0))),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin,
        stdout: Stream.fromQueue(state.output),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

const nextCommand = (state: ScriptedPiState) =>
  Queue.take(state.observed).pipe(Effect.map((entry) => entry.command));

const testLayer = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-test" }).pipe(
    Layer.provideMerge(
      Layer.merge(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    ),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  );

const collectEventsUntil = (input: {
  readonly stream: Stream.Stream<ProviderRuntimeEvent, never>;
  readonly signals: Readonly<Record<string, Deferred.Deferred<undefined>>>;
  readonly matches: (event: ProviderRuntimeEvent) => string | undefined;
}) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
    const fiber = yield* Stream.runForEach(input.stream, (event) =>
      Effect.gen(function* () {
        yield* Ref.update(events, (list) => [...list, event]);
        const signal = input.matches(event);
        if (signal !== undefined && input.signals[signal] !== undefined) {
          yield* Deferred.succeed(void 0)(input.signals[signal]!).pipe(Effect.ignore);
        }
      }),
    ).pipe(Effect.forkChild);
    return { events, fiber };
  });
describe("makePiAdapter — scripted RPC process", () => {
  it.effect("runs a full turn, records the boundary, and rewinds via fork", () =>
    Effect.gen(function* () {
      let getStateCalls = 0;
      const state = yield* makeScriptedState((command) => {
        switch (command.type) {
          case "set_steering_mode":
          case "set_follow_up_mode":
            return [reply(command)];
          case "get_state": {
            getStateCalls += 1;
            return [
              reply(command, {
                data:
                  getStateCalls === 1
                    ? {
                        sessionFile: "/tmp/t3/pi/sessions/x/thread-1.jsonl",
                        sessionId: "thread-1",
                        isStreaming: false,
                      }
                    : {
                        sessionFile: "/tmp/t3/pi/sessions/x/forked-123.jsonl",
                        sessionId: "forked-123",
                        isStreaming: false,
                      },
              }),
            ];
          }
          case "prompt":
            return [
              reply(command),
              { type: "message_start", message: { role: "assistant" } },
              {
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "Hi" },
              },
              {
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
              },
              { type: "agent_settled" },
            ];
          case "get_entries":
            return [
              reply(command, {
                data: {
                  entries: [
                    {
                      type: "message",
                      id: "u1",
                      parentId: "leaf-0",
                      message: { role: "user", content: "hi" },
                    },
                  ],
                  leafId: "leaf-1",
                },
              }),
            ];
          case "fork":
            return [reply(command, { data: { text: "hi", cancelled: false } })];
          case "abort":
            return [reply(command)];
          default:
            throw new Error(`unexpected command: ${command.type}`);
        }
      });
      const spawnArgs: Array<ReadonlyArray<string>> = [];
      const spawnOptions: Array<ChildProcess.CommandOptions> = [];
      const spawner = makeScriptedSpawner(state, (args, options) => {
        spawnArgs.push(args);
        spawnOptions.push(options);
      });

      const adapter = yield* makePiAdapter(decodeSettings(), { instanceId }).pipe(
        Effect.provide(testLayer(spawner)),
      );

      const settled = yield* Deferred.make<undefined>();
      const collector = yield* collectEventsUntil({
        stream: adapter.streamEvents,
        signals: { settled },
        matches: (event) =>
          event.type === "turn.completed" || event.type === "session.exited"
            ? "settled"
            : undefined,
      });

      const session = yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        providerInstanceId: instanceId,
        cwd: "/tmp/pi-project",
        modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
        runtimeMode: "full-access",
      });
      expect(session.status).toBe("ready");
      expect(spawnArgs[0]).toEqual([
        "--mode",
        "rpc",
        "--session-dir",
        expect.stringContaining("pi/sessions/"),
        "--session-id",
        "thread-1",
        "--model",
        "anthropic/claude-sonnet-4-6",
      ]);
      // stdin must stay open across per-command writes (endOnDone: true would
      // EOF it after the first command, and pi exits on stdin EOF).
      expect(spawnOptions[0]?.stdin).toMatchObject({ endOnDone: false });
      expect(isPiResumeCursor(session.resumeCursor)).toBe(true);

      // Queue-mode pins, then the get_state sync.
      expect((yield* nextCommand(state)).type).toBe("set_steering_mode");
      expect((yield* nextCommand(state)).type).toBe("set_follow_up_mode");
      expect((yield* nextCommand(state)).type).toBe("get_state");

      const started = yield* adapter.sendTurn({
        threadId,
        input: "hi",
        modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
      });
      expect(started.turnId).toBeDefined();
      const promptCommand = yield* nextCommand(state);
      expect(promptCommand.type).toBe("prompt");
      expect(promptCommand.message).toBe("hi");

      yield* Deferred.await(settled);
      const events = yield* Ref.get(collector.events);
      const types = events.map((event) => event.type);
      expect(types).toContain("turn.started");
      expect(types).toContain("content.delta");
      expect(types).toContain("turn.completed");

      // The assistant message item is one correlated item across
      // message_start → deltas → message_end.
      const messageStarted = events.find((event) => event.type === "item.started");
      const messageCompleted = events.find((event) => event.type === "item.completed");
      const delta = events.find((event) => event.type === "content.delta");
      expect(messageStarted?.itemId).toBeDefined();
      expect(messageStarted?.itemId).toBe(messageCompleted?.itemId);
      expect(delta?.itemId).toBe(messageStarted?.itemId);

      // Boundary recording: one get_entries round trip after settling.
      expect((yield* nextCommand(state)).type).toBe("get_entries");

      // Streaming guard + fork-target scan + fork + post-fork state.
      yield* adapter.rollbackThread(threadId, 1);
      expect((yield* nextCommand(state)).type).toBe("get_state");
      const scan = yield* nextCommand(state);
      expect(scan.type).toBe("get_entries");
      expect(scan.since).toBeUndefined();
      const forkCommand = yield* nextCommand(state);
      expect(forkCommand.type).toBe("fork");
      expect(forkCommand.entryId).toBe("u1");
      expect((yield* nextCommand(state)).type).toBe("get_state");

      // The live session now points at the forked file.
      const sessions = yield* adapter.listSessions();
      const live = sessions.find((sessionEntry) => sessionEntry.threadId === threadId);
      expect(live?.resumeCursor).toMatchObject({
        schemaVersion: 1,
        sessionFile: "/tmp/t3/pi/sessions/x/forked-123.jsonl",
        sessionId: "forked-123",
      });
      // All turns were discarded, so no boundaries remain in the cursor.
      expect((live?.resumeCursor as PiResumeCursor | undefined)?.turnBoundaries).toBeUndefined();

      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
    }),
  );

  it.effect(
    "completes extension-command turns that pi never settles, surfacing command output",
    () =>
      Effect.gen(function* () {
        const state = yield* makeScriptedState((command) => {
          switch (command.type) {
            case "set_steering_mode":
            case "set_follow_up_mode":
              return [reply(command)];
            case "get_state":
              return [
                reply(command, {
                  data: {
                    sessionFile: "/tmp/t3/pi/sessions/x/thread-1.jsonl",
                    sessionId: "thread-1",
                    isStreaming: false,
                  },
                }),
              ];
            case "prompt":
              // Command-only turn: pi runs the extension handler and returns
              // without agent events or agent_settled (upstream behavior).
              // `sendMessage({display:true})` streams live as a custom-role
              // message_start (the `custom_message` form is session-log only).
              return [
                reply(command),
                {
                  type: "message_start",
                  message: { role: "custom", content: "No tracked quota data yet." },
                },
                { type: "message_end", message: { role: "custom" } },
              ];
            case "get_entries":
              return [reply(command, { data: { entries: [], leafId: "leaf-1" } })];
            case "abort":
              return [{ type: "agent_settled" }, reply(command)];
            default:
              throw new Error(`unexpected command: ${command.type}`);
          }
        });
        const spawner = makeScriptedSpawner(state);

        const adapter = yield* makePiAdapter(decodeSettings(), { instanceId }).pipe(
          Effect.provide(testLayer(spawner)),
        );

        const settled = yield* Deferred.make<undefined>();
        const collector = yield* collectEventsUntil({
          stream: adapter.streamEvents,
          signals: { settled },
          matches: (event) => (event.type === "turn.completed" ? "settled" : undefined),
        });

        yield* adapter.startSession({
          threadId,
          provider: PROVIDER,
          providerInstanceId: instanceId,
          cwd: "/tmp/pi-project",
          modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
          runtimeMode: "full-access",
        });
        yield* nextCommand(state);
        yield* nextCommand(state);
        yield* nextCommand(state);

        yield* adapter.sendTurn({
          threadId,
          input: "/quota",
          modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
        });
        expect((yield* nextCommand(state)).type).toBe("prompt");

        // The turn completes without any agent_settled: after the grace
        // window the adapter probes get_state, sees isStreaming: false (a
        // true command turn), and synthesizes completion.
        yield* Deferred.await(settled);
        const events = yield* Ref.get(collector.events);
        const types = events.map((event) => event.type);
        expect(types).toContain("turn.started");
        expect(types).toContain("extension.notice");
        expect(types.filter((type) => type === "turn.completed")).toHaveLength(1);
        const notice = events.find((event) => event.type === "extension.notice");
        expect(notice?.payload).toMatchObject({
          message: "No tracked quota data yet.",
          noticeType: "info",
        });

        // The grace-window get_state probe fires before the synthesized
        // completion's boundary recording.
        expect((yield* nextCommand(state)).type).toBe("get_state");
        expect((yield* nextCommand(state)).type).toBe("get_entries");

        yield* adapter.stopAll();
        yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
      }),
  );

  it.effect("fails the turn when the assistant stream errors and pi settles with no content", () =>
    Effect.gen(function* () {
      // Reproduces the reported bug: upstream throttle/timeout makes pi's
      // assistant stream end with `stopReason: "error"` and zero content,
      // then pi emits `agent_settled`. The turn must close as failed (so
      // the session surfaces the error and the composer shows stop), not
      // as a silent "completed" that leaves the thread looking done.
      const state = yield* makeScriptedState((command) => {
        switch (command.type) {
          case "set_steering_mode":
          case "set_follow_up_mode":
            return [reply(command)];
          case "get_state":
            return [
              reply(command, {
                data: {
                  sessionFile: "/tmp/t3/pi/sessions/x/thread-1.jsonl",
                  sessionId: "thread-1",
                  isStreaming: false,
                },
              }),
            ];
          case "prompt":
            return [
              reply(command),
              { type: "message_start", message: { role: "assistant" } },
              {
                type: "message_update",
                assistantMessageEvent: {
                  type: "error",
                  reason: "error",
                  error: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "Request timed out.",
                    content: [],
                  },
                },
              },
              {
                type: "message_end",
                message: {
                  role: "assistant",
                  stopReason: "error",
                  errorMessage: "Request timed out.",
                  content: [],
                },
              },
              { type: "agent_settled" },
            ];
          case "get_entries":
            return [reply(command, { data: { entries: [], leafId: "leaf-1" } })];
          case "abort":
            return [reply(command)];
          default:
            throw new Error(`unexpected command: ${command.type}`);
        }
      });
      const spawner = makeScriptedSpawner(state);

      const adapter = yield* makePiAdapter(decodeSettings(), { instanceId }).pipe(
        Effect.provide(testLayer(spawner)),
      );

      const settled = yield* Deferred.make<undefined>();
      const collector = yield* collectEventsUntil({
        stream: adapter.streamEvents,
        signals: { settled },
        matches: (event) => (event.type === "turn.completed" ? "settled" : undefined),
      });

      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        providerInstanceId: instanceId,
        cwd: "/tmp/pi-project",
        modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
        runtimeMode: "full-access",
      });
      yield* nextCommand(state);
      yield* nextCommand(state);
      yield* nextCommand(state);

      yield* adapter.sendTurn({
        threadId,
        input: "hi",
        modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
      });
      expect((yield* nextCommand(state)).type).toBe("prompt");

      yield* Deferred.await(settled);
      const events = yield* Ref.get(collector.events);
      const completed = events.find((event) => event.type === "turn.completed");
      expect(completed?.payload).toMatchObject({
        state: "failed",
        errorMessage: "Request timed out.",
      });

      const sessions = yield* adapter.listSessions();
      const live = sessions.find((sessionEntry) => sessionEntry.threadId === threadId);
      expect(live?.status).toBe("error");
      expect(live?.lastError).toBe("Request timed out.");

      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
    }),
  );

  it.effect("keeps a slow agent turn open instead of synthesizing command-turn completion", () =>
    Effect.gen(function* () {
      // Regression: kimi-k3 took >2s to emit its first message_start, so
      // the grace window fired, assumed an extension-command turn, and
      // synthesized turn.completed — closing the session to "ready" while
      // pi kept streaming for minutes. The adapter must ask pi whether the
      // agent is still streaming before concluding it's a command turn.
      let getStateCalls = 0;
      const state = yield* makeScriptedState((command) => {
        switch (command.type) {
          case "set_steering_mode":
          case "set_follow_up_mode":
            return [reply(command)];
          case "get_state": {
            getStateCalls += 1;
            if (getStateCalls === 1) {
              // Startup probe: session idle.
              return [
                reply(command, {
                  data: {
                    sessionFile: "/tmp/t3/pi/sessions/x/thread-1.jsonl",
                    sessionId: "thread-1",
                    isStreaming: false,
                  },
                }),
              ];
            }
            // Grace-window probe (after a slow prompt): pi reports it is
            // still streaming, then the delayed agent work streams in and
            // the turn settles for real.
            return [
              reply(command, {
                data: {
                  sessionFile: "/tmp/t3/pi/sessions/x/thread-1.jsonl",
                  sessionId: "thread-1",
                  isStreaming: true,
                },
              }),
              { type: "message_start", message: { role: "assistant" } },
              {
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" },
              },
              {
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
              },
              { type: "agent_settled" },
            ];
          }
          case "prompt":
            // Slow agent turn: ack arrives immediately, but no
            // message_start / agent activity within the 2s grace window.
            return [reply(command)];
          case "get_entries":
            return [reply(command, { data: { entries: [], leafId: "leaf-1" } })];
          case "abort":
            return [reply(command)];
          default:
            throw new Error(`unexpected command: ${command.type}`);
        }
      });
      const spawner = makeScriptedSpawner(state);

      const adapter = yield* makePiAdapter(decodeSettings(), { instanceId }).pipe(
        Effect.provide(testLayer(spawner)),
      );

      const settled = yield* Deferred.make<undefined>();
      const collector = yield* collectEventsUntil({
        stream: adapter.streamEvents,
        signals: { settled },
        matches: (event) => (event.type === "turn.completed" ? "settled" : undefined),
      });

      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        providerInstanceId: instanceId,
        cwd: "/tmp/pi-project",
        modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
        runtimeMode: "full-access",
      });
      yield* nextCommand(state);
      yield* nextCommand(state);
      yield* nextCommand(state);

      yield* adapter.sendTurn({
        threadId,
        input: "hi",
        modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
      });
      expect((yield* nextCommand(state)).type).toBe("prompt");

      // The grace window elapses with no agent activity. With the bug, a
      // synthetic turn.completed fires; with the fix the adapter instead
      // probes get_state, learns pi is still streaming, and waits. Consume
      // that probe so the scripted agent stream + settle can flow.
      const probe = yield* nextCommand(state);
      expect(probe.type).toBe("get_state");

      // No synthetic completion before the real settle.
      yield* Deferred.await(settled);
      const events = yield* Ref.get(collector.events);
      const completions = events.filter((event) => event.type === "turn.completed");
      expect(completions).toHaveLength(1);
      expect(completions[0]?.payload).toMatchObject({ state: "completed" });
      // The completion carries real streamed content (not the empty
      // synthetic close): the assistant message item completed first.
      const messageCompleted = events.find((event) => event.type === "item.completed");
      expect(messageCompleted).toBeDefined();
      const settleIndex = events.findIndex((event) => event.type === "turn.completed");
      const messageIndex = events.findIndex((event) => event.type === "item.completed");
      expect(messageIndex).toBeGreaterThan(-1);
      expect(settleIndex).toBeGreaterThan(messageIndex);

      // Session ends ready after the real settle.
      const sessions = yield* adapter.listSessions();
      const live = sessions.find((s) => s.threadId === threadId);
      expect(live?.status).toBe("ready");

      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
    }),
  );

  it.effect(
    "steers into the active turn, surfaces extension selects, and suppresses the post-abort settle",
    () =>
      Effect.gen(function* () {
        const state = yield* makeScriptedState((command) => {
          switch (command.type) {
            case "set_steering_mode":
            case "set_follow_up_mode":
              return [reply(command)];
            case "get_state":
              return [
                reply(command, {
                  data: {
                    sessionFile: "/tmp/t3/pi/sessions/x/thread-1.jsonl",
                    sessionId: "thread-1",
                    isStreaming: false,
                  },
                }),
              ];
            case "prompt":
              // A live turn: assistant work started (blocks the adapter's
              // synthetic command-turn completion), no agent_settled yet.
              return [
                reply(command),
                { type: "message_start", message: { role: "assistant" } },
                {
                  type: "message_end",
                  message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
                },
              ];
            case "steer":
              return [
                reply(command),
                {
                  type: "extension_ui_request",
                  id: "ui-1",
                  method: "select",
                  title: "Allow dangerous command?",
                  options: ["Allow", "Block"],
                },
                {
                  type: "message_update",
                  assistantMessageEvent: { type: "text_delta", delta: "ok" },
                },
                { type: "agent_settled" },
              ];
            case "get_entries":
              return [
                reply(command, {
                  data: { entries: [], leafId: "leaf-1" },
                }),
              ];
            case "extension_ui_response":
              return [reply(command)];
            case "abort":
              // Real pi emits the settle before the abort response.
              return [{ type: "agent_settled" }, reply(command)];
            default:
              throw new Error(`unexpected command: ${command.type}`);
          }
        });
        const spawner = makeScriptedSpawner(state);

        const adapter = yield* makePiAdapter(decodeSettings(), { instanceId }).pipe(
          Effect.provide(testLayer(spawner)),
        );

        const settled = yield* Deferred.make<undefined>();
        const uiRequested = yield* Deferred.make<undefined>();
        const collector = yield* collectEventsUntil({
          stream: adapter.streamEvents,
          signals: { settled, uiRequested },
          matches: (event) =>
            event.type === "turn.completed" || event.type === "session.exited"
              ? "settled"
              : event.type === "user-input.requested"
                ? "uiRequested"
                : undefined,
        });

        yield* adapter.startSession({
          threadId,
          provider: PROVIDER,
          providerInstanceId: instanceId,
          cwd: "/tmp/pi-project",
          modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
          runtimeMode: "full-access",
        });
        // Queue-mode pins + state sync.
        yield* nextCommand(state);
        yield* nextCommand(state);
        yield* nextCommand(state);

        const first = yield* adapter.sendTurn({
          threadId,
          input: "do the thing",
          modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
        });
        expect((yield* nextCommand(state)).type).toBe("prompt");

        // A second sendTurn while the turn is active is a steer that reuses
        // the active turn id (#47).
        const second = yield* adapter.sendTurn({
          threadId,
          input: "wait, do this instead",
          modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
        });
        expect(second.turnId).toBe(first.turnId);
        expect((yield* nextCommand(state)).type).toBe("steer");

        // The steer response carried an extension select dialog: surfaced as
        // user-input.requested and answered with an extension_ui_response.
        yield* Deferred.await(uiRequested);
        const uiRequestedEvent = yield* Ref.get(collector.events).pipe(
          Effect.map((events) => events.find((event) => event.type === "user-input.requested")),
        );
        expect(uiRequestedEvent).toBeDefined();
        const uiPayload = uiRequestedEvent!.payload as { questions: ReadonlyArray<{ id: string }> };
        const questionId = uiPayload.questions[0]!.id;
        const answerRequestId = ApprovalRequestId.make(questionId);
        yield* adapter.respondToUserInput(threadId, answerRequestId, {
          [answerRequestId]: "Allow",
        });
        // Boundary recording (get_entries) and the UI response race the drain
        // order; accept either ordering.
        const firstAfterResponse = yield* nextCommand(state);
        const secondAfterResponse = yield* nextCommand(state);
        const drained = [firstAfterResponse, secondAfterResponse];
        const boundaryCommand = drained.find((command) => command.type === "get_entries");
        expect(boundaryCommand).toBeDefined();
        const uiResponse = drained.find((command) => command.type === "extension_ui_response");
        expect(uiResponse).toBeDefined();
        expect(uiResponse!.value).toBe("Allow");

        // The steer's turn completes on agent_settled.
        yield* Deferred.await(settled);
        const turnEvents = yield* Ref.get(collector.events);
        expect(turnEvents.filter((event) => event.type === "turn.started")).toHaveLength(1);
        expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);

        // Interrupt: abort is sent while a turn is active; the settle that
        // follows the abort is suppressed, and the adapter itself closes the
        // turn as interrupted — no boundary recording.
        yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
        yield* adapter.sendTurn({
          threadId,
          input: "one more thing",
          modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
        });
        expect((yield* nextCommand(state)).type).toBe("prompt");

        // The second turn also stays active (assistant work, no settle).
        yield* Effect.yieldNow;
        yield* TestClock.adjust("2 seconds");
        yield* Effect.yieldNow;

        const aborted = yield* Deferred.make<undefined>();
        const abortCollector = yield* collectEventsUntil({
          stream: adapter.streamEvents,
          signals: { aborted },
          matches: (event) => (event.type === "turn.aborted" ? "aborted" : undefined),
        });
        yield* adapter.interruptTurn(threadId);
        yield* Deferred.await(aborted);
        expect((yield* nextCommand(state)).type).toBe("abort");

        // The turn closes exactly once, as interrupted (never "completed"),
        // and no boundary is recorded.
        yield* Effect.yieldNow;
        yield* TestClock.adjust("50 millis");
        yield* Effect.yieldNow;
        const abortEvents = yield* Ref.get(abortCollector.events);
        expect(abortEvents.filter((event) => event.type === "turn.aborted")).toHaveLength(1);
        const abortCompletions = abortEvents.filter((event) => event.type === "turn.completed");
        expect(abortCompletions).toHaveLength(1);
        expect(abortCompletions[0]!.payload).toEqual({
          state: "interrupted",
          errorMessage: "Interrupted by user.",
        });
        // No boundary recording follows the aborted turn.
        expect(yield* Queue.poll(state.observed)).toEqual(Option.none());

        yield* adapter.stopAll();
        yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
        yield* Fiber.interrupt(abortCollector.fiber).pipe(Effect.ignore);
      }),
  );

  it.effect(
    "answers a select dialog without awaiting a reply line, matching real pi's extension_ui_response handling",
    () =>
      Effect.gen(function* () {
        // Real pi (dist/modes/rpc/rpc-mode.js handleInputLine) resolves its
        // pending extension dialog and emits NO response line for
        // extension_ui_response — the turn simply continues on stdout. The
        // scripted process mirrors that: no `reply(command)`, just the
        // settle that the resolved dialog lets through.
        const state = yield* makeScriptedState((command) => {
          switch (command.type) {
            case "set_steering_mode":
            case "set_follow_up_mode":
              return [reply(command)];
            case "get_state":
              return [
                reply(command, {
                  data: {
                    sessionFile: "/tmp/t3/pi/sessions/x/thread-1.jsonl",
                    sessionId: "thread-1",
                    isStreaming: false,
                  },
                }),
              ];
            case "prompt":
              // A live turn: assistant work started (blocks the adapter's
              // synthetic command-turn completion), no agent_settled yet.
              return [
                reply(command),
                { type: "message_start", message: { role: "assistant" } },
                {
                  type: "message_end",
                  message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
                },
              ];
            case "steer":
              return [
                reply(command),
                {
                  type: "extension_ui_request",
                  id: "ui-1",
                  method: "select",
                  title: "Allow dangerous command?",
                  options: ["Allow", "Block"],
                },
              ];
            case "get_entries":
              return [
                reply(command, {
                  data: { entries: [], leafId: "leaf-1" },
                }),
              ];
            case "extension_ui_response":
              // Real pi resolves the dialog and writes nothing back; the
              // unanswered dialog was blocking the agent, so the settle
              // flows now.
              return [{ type: "agent_settled" }];
            case "abort":
              // Real pi emits the settle before the abort response.
              return [{ type: "agent_settled" }, reply(command)];
            default:
              throw new Error(`unexpected command: ${command.type}`);
          }
        });
        const spawner = makeScriptedSpawner(state);

        const adapter = yield* makePiAdapter(decodeSettings(), { instanceId }).pipe(
          Effect.provide(testLayer(spawner)),
        );

        const settled = yield* Deferred.make<undefined>();
        const uiRequested = yield* Deferred.make<undefined>();
        const collector = yield* collectEventsUntil({
          stream: adapter.streamEvents,
          signals: { settled, uiRequested },
          matches: (event) =>
            event.type === "turn.completed" || event.type === "session.exited"
              ? "settled"
              : event.type === "user-input.requested"
                ? "uiRequested"
                : undefined,
        });

        yield* adapter.startSession({
          threadId,
          provider: PROVIDER,
          providerInstanceId: instanceId,
          cwd: "/tmp/pi-project",
          modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
          runtimeMode: "full-access",
        });
        // Queue-mode pins + state sync.
        yield* nextCommand(state);
        yield* nextCommand(state);
        yield* nextCommand(state);

        const first = yield* adapter.sendTurn({
          threadId,
          input: "do the thing",
          modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
        });
        expect((yield* nextCommand(state)).type).toBe("prompt");

        const second = yield* adapter.sendTurn({
          threadId,
          input: "wait, do this instead",
          modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
        });
        expect(second.turnId).toBe(first.turnId);
        expect((yield* nextCommand(state)).type).toBe("steer");

        // The steer response carried an extension select dialog: surfaced as
        // user-input.requested and answered with an extension_ui_response.
        yield* Deferred.await(uiRequested);
        const answering = yield* adapter
          .respondToUserInput(threadId, ApprovalRequestId.make("ui-1"), { "ui-1": "Allow" })
          .pipe(Effect.forkChild);
        // The old transport awaited a response line pi never sends; fast-
        // forward past its 30s timeout so the failure surfaces quickly.
        yield* TestClock.adjust("31 seconds");
        const outcome = yield* Fiber.join(answering).pipe(Effect.exit);
        expect(Exit.isSuccess(outcome)).toBe(true);

        // The command on the wire keeps pi's dialog id (not a transport
        // correlation uuid), so pi can match it to the pending dialog.
        const uiResponse = yield* nextCommand(state);
        expect(uiResponse.type).toBe("extension_ui_response");
        expect(uiResponse.id).toBe("ui-1");
        expect(uiResponse.value).toBe("Allow");

        // With the dialog resolved, pi's turn completes normally.
        yield* Deferred.await(settled);
        yield* adapter.stopAll();
        yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
      }),
  );

  it.effect(
    "interrupts an active turn as 'interrupted' even though real pi settles before the abort response",
    () =>
      Effect.gen(function* () {
        // Real pi emits `agent_settled` to stdout BEFORE the `abort` response
        // (session.abort() = agent.abort() + waitForIdle(), and the settle
        // fires before the idle-wait resolves). The scripted process mirrors
        // that ordering: settle line first, response line second.
        const state = yield* makeScriptedState((command) => {
          switch (command.type) {
            case "set_steering_mode":
            case "set_follow_up_mode":
              return [reply(command)];
            case "get_state":
              return [
                reply(command, {
                  data: {
                    sessionFile: "/tmp/t3/pi/sessions/x/thread-1.jsonl",
                    sessionId: "thread-1",
                    isStreaming: false,
                  },
                }),
              ];
            case "prompt":
              // A live turn: assistant work started (blocks the adapter's
              // synthetic command-turn completion), no agent_settled yet.
              return [
                reply(command),
                { type: "message_start", message: { role: "assistant" } },
                {
                  type: "message_end",
                  message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
                },
              ];
            case "abort":
              return [{ type: "agent_settled" }, reply(command)];
            default:
              throw new Error(`unexpected command: ${command.type}`);
          }
        });
        const spawner = makeScriptedSpawner(state);

        const adapter = yield* makePiAdapter(decodeSettings(), { instanceId }).pipe(
          Effect.provide(testLayer(spawner)),
        );

        const turnEnded = yield* Deferred.make<undefined>();
        const collector = yield* collectEventsUntil({
          stream: adapter.streamEvents,
          signals: { turnEnded },
          matches: (event) =>
            event.type === "turn.completed" || event.type === "turn.aborted"
              ? "turnEnded"
              : undefined,
        });

        yield* adapter.startSession({
          threadId,
          provider: PROVIDER,
          providerInstanceId: instanceId,
          cwd: "/tmp/pi-project",
          modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
          runtimeMode: "full-access",
        });
        // Queue-mode pins + state sync.
        yield* nextCommand(state);
        yield* nextCommand(state);
        yield* nextCommand(state);

        yield* adapter.sendTurn({
          threadId,
          input: "do the thing",
          modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
        });
        expect((yield* nextCommand(state)).type).toBe("prompt");

        yield* adapter.interruptTurn(threadId);
        expect((yield* nextCommand(state)).type).toBe("abort");

        // The turn must end exactly once, as interrupted — the state the
        // orchestration layer consumes to settle the session. The unsuppressed
        // settle must not leak a lying "completed" turn end.
        yield* Deferred.await(turnEnded);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("50 millis");
        yield* Effect.yieldNow;
        const events = yield* Ref.get(collector.events);
        const completions = events.filter((event) => event.type === "turn.completed");
        expect(completions).toHaveLength(1);
        expect(completions[0]!.payload).toMatchObject({ state: "interrupted" });
        expect(events.filter((event) => event.type === "turn.aborted")).toHaveLength(1);
        // No boundary recording follows the aborted turn.
        expect(yield* Queue.poll(state.observed)).toEqual(Option.none());

        yield* adapter.stopAll();
        yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
      }),
  );

  it.effect("an interrupt on an idle session does not suppress the next turn's settle", () =>
    Effect.gen(function* () {
      const state = yield* makeScriptedState((command) => {
        switch (command.type) {
          case "set_steering_mode":
          case "set_follow_up_mode":
            return [reply(command)];
          case "get_state":
            return [
              reply(command, {
                data: {
                  sessionFile: "/tmp/t3/pi/sessions/x/thread-1.jsonl",
                  sessionId: "thread-1",
                  isStreaming: false,
                },
              }),
            ];
          case "prompt":
            // A complete turn: work then settle.
            return [reply(command), { type: "agent_settled" }];
          case "abort":
            return [{ type: "agent_settled" }, reply(command)];
          default:
            throw new Error(`unexpected command: ${command.type}`);
        }
      });
      const spawner = makeScriptedSpawner(state);

      const adapter = yield* makePiAdapter(decodeSettings({}), { instanceId }).pipe(
        Effect.provide(testLayer(spawner)),
      );

      const settled = yield* Deferred.make<undefined>();
      const collector = yield* collectEventsUntil({
        stream: adapter.streamEvents,
        signals: { settled },
        matches: (event) =>
          event.type === "turn.completed" || event.type === "session.exited"
            ? "settled"
            : undefined,
      });

      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        providerInstanceId: instanceId,
        cwd: "/tmp/pi-project",
        modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
        runtimeMode: "full-access",
      });
      // Queue-mode pins + state sync.
      yield* nextCommand(state);
      yield* nextCommand(state);
      yield* nextCommand(state);

      // First turn completes normally.
      yield* adapter.sendTurn({
        threadId,
        input: "first",
        modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
      });
      expect((yield* nextCommand(state)).type).toBe("prompt");
      yield* Deferred.await(settled);
      // Boundary recording after the natural settle.
      expect((yield* nextCommand(state)).type).toBe("get_entries");

      // Stop on the now-idle session: must not arm the suppress flag.
      yield* adapter.interruptTurn(threadId);
      expect((yield* nextCommand(state)).type).toBe("abort");
      yield* Effect.yieldNow;

      // The next turn must complete normally — its settle is not suppressed.
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
      const settledAgain = yield* Deferred.make<undefined>();
      const collector2 = yield* collectEventsUntil({
        stream: adapter.streamEvents,
        signals: { settledAgain },
        matches: (event) =>
          event.type === "turn.completed" || event.type === "session.exited"
            ? "settledAgain"
            : undefined,
      });
      yield* adapter.sendTurn({
        threadId,
        input: "second",
        modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
      });
      expect((yield* nextCommand(state)).type).toBe("prompt");
      yield* Deferred.await(settledAgain);
      const events = yield* Ref.get(collector2.events);
      const completions = events.filter((event) => event.type === "turn.completed");
      expect(completions).toHaveLength(1);
      expect(completions[0]!.payload).toMatchObject({ state: "completed" });

      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
      yield* Fiber.interrupt(collector2.fiber).pipe(Effect.ignore);
    }),
  );

  it.effect("refuses to rewind while a turn is streaming", () =>
    Effect.gen(function* () {
      const state = yield* makeScriptedState((command) => {
        switch (command.type) {
          case "set_steering_mode":
          case "set_follow_up_mode":
            return [reply(command)];
          case "get_state":
            return [
              reply(command, {
                data: {
                  sessionFile: "/tmp/t3/pi/sessions/x/thread-1.jsonl",
                  sessionId: "thread-1",
                  // The turn is active — the rollback guard must trip.
                  isStreaming: true,
                },
              }),
            ];
          case "abort":
            return [reply(command)];
          default:
            throw new Error(`unexpected command: ${command.type}`);
        }
      });
      const spawner = makeScriptedSpawner(state);

      const adapter = yield* makePiAdapter(decodeSettings(), { instanceId }).pipe(
        Effect.provide(testLayer(spawner)),
      );

      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        providerInstanceId: instanceId,
        cwd: "/tmp/pi-project",
        runtimeMode: "full-access",
      });
      // Queue-mode pins + state sync.
      yield* nextCommand(state);
      yield* nextCommand(state);
      yield* nextCommand(state);

      const exit = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause) as ProviderAdapterRequestError;
        expect(error.message).toMatch(/still working on a turn/);
      }

      yield* adapter.stopAll();
    }),
  );

  it.effect(
    "surfaces input/editor dialogs as text kinds and notify/setStatus as extension events",
    () =>
      Effect.gen(function* () {
        const state = yield* makeScriptedState((command) => {
          switch (command.type) {
            case "set_steering_mode":
            case "set_follow_up_mode":
              return [reply(command)];
            case "get_state":
              return [
                reply(command, {
                  data: {
                    sessionFile: "/tmp/t3/pi/sessions/x/thread-1.jsonl",
                    sessionId: "thread-1",
                    isStreaming: false,
                  },
                }),
              ];
            case "prompt":
              // One turn that fires every extension-UI request kind.
              return [
                reply(command),
                {
                  type: "extension_ui_request",
                  id: "ui-input-1",
                  method: "input",
                  title: "Enter a value",
                  placeholder: "type something...",
                },
                {
                  type: "extension_ui_request",
                  id: "ui-editor-1",
                  method: "editor",
                  title: "Edit some text",
                  prefill: "Line 1\nLine 2",
                },
                {
                  type: "extension_ui_request",
                  id: "ui-notify-1",
                  method: "notify",
                  message: "Command blocked by user",
                  notifyType: "warning",
                },
                {
                  type: "extension_ui_request",
                  id: "ui-status-1",
                  method: "setStatus",
                  statusKey: "my-ext",
                  statusText: "Turn 3 running...",
                },
                {
                  type: "extension_ui_request",
                  id: "ui-status-2",
                  method: "setStatus",
                  statusKey: "my-ext",
                  // Omitted statusText = clear; the adapter normalizes to null.
                },
                {
                  type: "extension_ui_request",
                  id: "ui-widget-1",
                  method: "setWidget",
                  widgetKey: "w",
                },
                { type: "agent_settled" },
              ];
            case "get_entries":
              return [
                reply(command, {
                  data: { entries: [], leafId: "leaf-1" },
                }),
              ];
            case "extension_ui_response":
              return [reply(command)];
            case "abort":
              return [reply(command)];
            default:
              throw new Error(`unexpected command: ${command.type}`);
          }
        });
        const spawner = makeScriptedSpawner(state);

        const adapter = yield* makePiAdapter(decodeSettings(), { instanceId }).pipe(
          Effect.provide(testLayer(spawner)),
        );

        const settled = yield* Deferred.make<undefined>();
        const uiRequested = yield* Deferred.make<undefined>();
        const noticeSeen = yield* Deferred.make<undefined>();
        const statusSeen = yield* Deferred.make<undefined>();
        const collector = yield* collectEventsUntil({
          stream: adapter.streamEvents,
          signals: { settled, uiRequested, noticeSeen, statusSeen },
          matches: (event) =>
            event.type === "turn.completed" || event.type === "session.exited"
              ? "settled"
              : event.type === "user-input.requested"
                ? "uiRequested"
                : event.type === "extension.notice"
                  ? "noticeSeen"
                  : event.type === "extension.status"
                    ? "statusSeen"
                    : undefined,
        });

        yield* adapter.startSession({
          threadId,
          provider: PROVIDER,
          providerInstanceId: instanceId,
          cwd: "/tmp/pi-project",
          modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
          runtimeMode: "full-access",
        });
        yield* nextCommand(state);
        yield* nextCommand(state);
        yield* nextCommand(state);

        yield* adapter.sendTurn({
          threadId,
          input: "do the thing",
          modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
        });
        expect((yield* nextCommand(state)).type).toBe("prompt");

        yield* Deferred.await(uiRequested);
        yield* Deferred.await(noticeSeen);
        yield* Deferred.await(statusSeen);
        // agent_settled lands after every extension_ui_request in the script,
        // so awaiting it guarantees all events reached the collector.
        yield* Deferred.await(settled);
        const events = yield* Ref.get(collector.events);

        const inputEvents = events.filter((event) => event.type === "user-input.requested");
        expect(inputEvents).toHaveLength(2);
        const questions = inputEvents.flatMap((event) =>
          event.type === "user-input.requested" ? event.payload.questions : [],
        );
        expect(questions).toHaveLength(2);
        expect(questions[0]).toMatchObject({
          header: "Pi extension",
          question: "Enter a value",
          answerKind: "text",
          placeholder: "type something...",
          options: [],
        });
        expect(questions[1]).toMatchObject({
          question: "Edit some text",
          answerKind: "editor",
          initialValue: "Line 1\nLine 2",
          options: [],
        });

        const notice = events.find((event) => event.type === "extension.notice");
        expect(notice).toBeDefined();
        if (notice?.type !== "extension.notice") {
          throw new Error("expected extension.notice");
        }
        expect(notice.payload).toEqual({
          message: "Command blocked by user",
          noticeType: "warning",
        });

        const statuses = events.filter((event) => event.type === "extension.status");
        expect(statuses).toHaveLength(2);
        if (statuses[0]?.type !== "extension.status" || statuses[1]?.type !== "extension.status") {
          throw new Error("expected extension.status events");
        }
        expect(statuses[0].payload).toEqual({
          statusKey: "my-ext",
          statusText: "Turn 3 running...",
        });
        // Omitted statusText normalizes to an explicit null clear.
        expect(statuses[1].payload).toEqual({ statusKey: "my-ext", statusText: null });

        // setWidget stays dropped: no event, no response.
        expect(events.some((event) => event.type === "extension.notice")).toBe(true);

        // Answer the input dialog: a non-empty value is sent as {value}.
        const answerRequestId = ApprovalRequestId.make(questions[0]!.id);
        yield* adapter.respondToUserInput(threadId, answerRequestId, {
          [answerRequestId]: "typed answer",
        });
        let uiResponse = yield* nextCommand(state);
        if (uiResponse.type === "get_entries") {
          uiResponse = yield* nextCommand(state);
        }
        expect(uiResponse.type).toBe("extension_ui_response");
        expect(uiResponse.value).toBe("typed answer");
        expect(uiResponse.cancelled).toBeUndefined();

        yield* adapter.stopAll();
      }),
  );

  it.effect("rejects empty answers to text dialogs", () =>
    Effect.gen(function* () {
      const state = yield* makeScriptedState((command) => {
        switch (command.type) {
          case "set_steering_mode":
          case "set_follow_up_mode":
            return [reply(command)];
          case "get_state":
            return [
              reply(command, {
                data: {
                  sessionFile: "/tmp/t3/pi/sessions/x/thread-1.jsonl",
                  sessionId: "thread-1",
                  isStreaming: false,
                },
              }),
            ];
          case "prompt":
            return [
              reply(command),
              {
                type: "extension_ui_request",
                id: "ui-input-1",
                method: "input",
                title: "Enter a value",
              },
            ];
          case "abort":
            return [reply(command)];
          default:
            throw new Error(`unexpected command: ${command.type}`);
        }
      });
      const spawner = makeScriptedSpawner(state);

      const adapter = yield* makePiAdapter(decodeSettings(), { instanceId }).pipe(
        Effect.provide(testLayer(spawner)),
      );
      const settled = yield* Deferred.make<undefined>();
      const uiRequested = yield* Deferred.make<undefined>();
      const collector = yield* collectEventsUntil({
        stream: adapter.streamEvents,
        signals: { settled, uiRequested },
        matches: (event) =>
          event.type === "turn.completed" || event.type === "session.exited"
            ? "settled"
            : event.type === "user-input.requested"
              ? "uiRequested"
              : undefined,
      });
      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        providerInstanceId: instanceId,
        cwd: "/tmp/pi-project",
        modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
        runtimeMode: "full-access",
      });
      yield* nextCommand(state);
      yield* nextCommand(state);
      yield* nextCommand(state);
      yield* adapter.sendTurn({
        threadId,
        input: "do the thing",
        modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
      });
      expect((yield* nextCommand(state)).type).toBe("prompt");

      // The dialog must be registered before responding (the reader fiber
      // processes extension_ui_request asynchronously).
      yield* Deferred.await(uiRequested);
      const answerRequestId = ApprovalRequestId.make("ui-input-1");
      const exit = yield* adapter
        .respondToUserInput(threadId, answerRequestId, { [answerRequestId]: "   " })
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause) as ProviderAdapterRequestError;
        expect(error.message).toMatch(/non-empty answer/);
      }
      // The pending request stays pending: no response was written.
      yield* adapter.stopAll();
    }),
  );
});
