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
    messageItemId: undefined,
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
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: "Hello " },
      },
    ]);
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
  onSpawn?: (args: ReadonlyArray<string>) => void,
) =>
  ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) {
        return yield* Effect.die(new Error("expected a standard pi command"));
      }
      onSpawn?.(command.args);
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
      const spawner = makeScriptedSpawner(state, (args) => spawnArgs.push(args));

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
              // The turn stays active: no agent_settled yet.
              return [reply(command)];
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
              return [reply(command), { type: "agent_settled" }];
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
        // order; the boundary job is queued at agent_settled, so it lands first.
        expect((yield* nextCommand(state)).type).toBe("get_entries");
        const uiResponse = yield* nextCommand(state);
        expect(uiResponse.type).toBe("extension_ui_response");
        expect(uiResponse.value).toBe("Allow");

        // The steer's turn completes on agent_settled.
        yield* Deferred.await(settled);
        const turnEvents = yield* Ref.get(collector.events);
        expect(turnEvents.filter((event) => event.type === "turn.started")).toHaveLength(1);
        expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);

        // Interrupt: abort is sent while a turn is active; the settle that
        // follows the abort is suppressed — no second turn.completed, no
        // boundary recording.
        yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
        yield* adapter.sendTurn({
          threadId,
          input: "one more thing",
          modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
        });
        expect((yield* nextCommand(state)).type).toBe("prompt");

        const aborted = yield* Deferred.make<undefined>();
        const abortCollector = yield* collectEventsUntil({
          stream: adapter.streamEvents,
          signals: { aborted },
          matches: (event) => (event.type === "turn.aborted" ? "aborted" : undefined),
        });
        yield* adapter.interruptTurn(threadId);
        yield* Deferred.await(aborted);
        expect((yield* nextCommand(state)).type).toBe("abort");

        // Wait for the suppressed settle to be consumed, then assert nothing
        // closed the (already aborted) turn and no boundary was recorded.
        yield* Effect.yieldNow;
        yield* TestClock.adjust("50 millis");
        yield* Effect.yieldNow;
        const abortEvents = yield* Ref.get(abortCollector.events);
        expect(abortEvents.filter((event) => event.type === "turn.aborted")).toHaveLength(1);
        expect(abortEvents.filter((event) => event.type === "turn.completed")).toHaveLength(0);
        // No boundary recording follows the aborted turn.
        expect(yield* Queue.poll(state.observed)).toEqual(Option.none());

        yield* adapter.stopAll();
        yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
        yield* Fiber.interrupt(abortCollector.fiber).pipe(Effect.ignore);
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
});
