import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Option from "effect/Option";
import { describe, expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  OmpSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import {
  isOmpResumeCursor,
  makeOmpAdapter,
  mapOmpEvent,
  ompApiKeyEnvironment,
  ompUiRequestToQuestions,
  resolveOmpApprovalMode,
  resolveOmpLaunchArgs,
  splitOmpModelSlug,
  type OmpResumeCursor,
} from "./OmpAdapter.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";

const PROVIDER = ProviderDriverKind.make("omp");
const instanceId = ProviderInstanceId.make("omp");

const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const decodeSettings = (overrides: Partial<OmpSettings> = {}): OmpSettings =>
  decodeOmpSettings(overrides);

const threadId = ThreadId.make("thread-1");
const turnId = (value: string) => TurnId.make(value);

// ── Pure helpers ────────────────────────────────────────────────────────

describe("resolveOmpApprovalMode", () => {
  it("maps runtime modes onto OMP approval flags", () => {
    expect(resolveOmpApprovalMode("full-access")).toBe("yolo");
    expect(resolveOmpApprovalMode("approval-required")).toBe("always-ask");
    expect(resolveOmpApprovalMode("auto-accept-edits")).toBe("write");
    expect(resolveOmpApprovalMode("auto")).toBeUndefined();
    expect(resolveOmpApprovalMode(undefined)).toBeUndefined();
  });
});

describe("resolveOmpLaunchArgs", () => {
  it("pins mode, session dir, cwd, model, and approval mode", () => {
    expect(
      resolveOmpLaunchArgs({
        cwd: "/tmp/project",
        sessionDir: "/tmp/t3/omp/sessions/x",
        resumeCursor: undefined,
        model: "opencode-go/deepseek-v4-flash",
        approvalMode: "yolo",
        profile: "",
        launchArgs: "",
      }),
    ).toEqual([
      "--mode",
      "rpc",
      "--session-dir",
      "/tmp/t3/omp/sessions/x",
      "--cwd",
      "/tmp/project",
      "--model",
      "opencode-go/deepseek-v4-flash",
      "--models",
      "opencode-go/*",
      "--approval-mode",
      "yolo",
    ]);
  });

  it("resumes a forked session file and adds profile, thinking, and user args", () => {
    expect(
      resolveOmpLaunchArgs({
        cwd: "/tmp/project",
        sessionDir: "/tmp/t3/omp/sessions/x",
        resumeCursor: {
          schemaVersion: 1,
          sessionFile: "/tmp/t3/omp/sessions/x/forked-123.jsonl",
          sessionId: "forked-123",
        },
        model: "anthropic/claude-opus-4-8",
        thinkingLevel: "max",
        approvalMode: "always-ask",
        profile: "work",
        launchArgs: "--no-lsp --no-title",
      }),
    ).toEqual([
      "--mode",
      "rpc",
      "--session-dir",
      "/tmp/t3/omp/sessions/x",
      "--cwd",
      "/tmp/project",
      "--resume",
      "/tmp/t3/omp/sessions/x/forked-123.jsonl",
      "--profile",
      "work",
      "--model",
      "anthropic/claude-opus-4-8",
      "--models",
      "anthropic/*",
      "--thinking",
      "max",
      "--approval-mode",
      "always-ask",
      "--no-lsp",
      "--no-title",
    ]);
  });

  it("does not scope --models without a provider prefix", () => {
    const args = resolveOmpLaunchArgs({
      cwd: "/tmp/project",
      sessionDir: "/tmp/t3/omp/sessions/x",
      resumeCursor: undefined,
      model: "bare-model",
      approvalMode: undefined,
      profile: "",
      launchArgs: "",
    });
    expect(args).toEqual([
      "--mode",
      "rpc",
      "--session-dir",
      "/tmp/t3/omp/sessions/x",
      "--cwd",
      "/tmp/project",
      "--model",
      "bare-model",
    ]);
  });

  it("passes a config overlay file when one is provided", () => {
    const args = resolveOmpLaunchArgs({
      cwd: "/tmp/project",
      sessionDir: "/tmp/t3/omp/sessions/x",
      resumeCursor: undefined,
      model: undefined,
      approvalMode: undefined,
      profile: "",
      configOverlay: "/tmp/t3/omp/overlays/x/session.yml",
      launchArgs: "",
    });
    expect(args).toEqual([
      "--mode",
      "rpc",
      "--session-dir",
      "/tmp/t3/omp/sessions/x",
      "--cwd",
      "/tmp/project",
      "--config",
      "/tmp/t3/omp/overlays/x/session.yml",
    ]);
  });
});

describe("splitOmpModelSlug", () => {
  it("splits at the first slash, keeping slashes in the model id", () => {
    expect(splitOmpModelSlug("opencode-go/deepseek-v4-flash")).toEqual({
      provider: "opencode-go",
      modelId: "deepseek-v4-flash",
    });
    expect(splitOmpModelSlug("provider/a/b/c")).toEqual({
      provider: "provider",
      modelId: "a/b/c",
    });
    expect(splitOmpModelSlug("bare")).toEqual({ modelId: "bare" });
  });
});

describe("ompApiKeyEnvironment", () => {
  it("injects only configured keys under OMP's env names", () => {
    expect(
      ompApiKeyEnvironment(
        decodeSettings({
          anthropicApiKey: "sk-ant-1",
          groqApiKey: "gsk-1",
        }),
      ),
    ).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-1",
      GROQ_API_KEY: "gsk-1",
    });
  });
});

describe("ompUiRequestToQuestions", () => {
  it("maps a select dialog onto user-input questions", () => {
    expect(
      ompUiRequestToQuestions({
        method: "select",
        id: ApprovalRequestId.make("d1"),
        options: ["A", "B"],
      }),
    ).toEqual([
      {
        id: ApprovalRequestId.make("d1"),
        header: "OMP extension",
        question: "Select an option",
        options: [
          { label: "A", description: "A" },
          { label: "B", description: "B" },
        ],
        multiSelect: false,
      },
    ]);
  });
});

describe("mapOmpEvent", () => {
  const baseInput = {
    threadId,
    activeTurnId: turnId("t1"),
    messageItemId: "msg-1",
  };

  it("translates assistant messages with live deltas", () => {
    expect(
      mapOmpEvent(
        { type: "message_start", message: { role: "assistant", content: "hi" } },
        baseInput,
      ),
    ).toEqual([
      {
        turnId: turnId("t1"),
        itemId: "msg-1",
        type: "item.started",
        payload: {
          itemType: "assistant_message",
          status: "inProgress",
          title: "Assistant message",
          detail: "hi",
          data: { type: "message_start", message: { role: "assistant", content: "hi" } },
        },
      },
    ]);
    expect(
      mapOmpEvent(
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hi" } },
        baseInput,
      ),
    ).toEqual([
      {
        turnId: turnId("t1"),
        itemId: "msg-1",
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: "Hi" },
      },
    ]);
  });

  it("drops user echoes and toolResult messages", () => {
    expect(
      mapOmpEvent({ type: "message_start", message: { role: "user", content: "hi" } }, baseInput),
    ).toEqual([]);
    expect(
      mapOmpEvent(
        { type: "message_start", message: { role: "toolResult", content: "out" } },
        baseInput,
      ),
    ).toEqual([]);
  });

  it("maps tool executions onto tool items, failed on isError", () => {
    const started = mapOmpEvent(
      {
        type: "tool_execution_start",
        toolName: "bash",
        toolCallId: "tc1",
        args: { command: "ls" },
      },
      baseInput,
    );
    expect(started).toEqual([
      {
        turnId: turnId("t1"),
        itemId: "tc1",
        type: "item.started",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "bash",
          detail: "ls",
          data: { tool: "bash", args: { command: "ls" } },
        },
      },
    ]);
    const completed = mapOmpEvent(
      { type: "tool_execution_end", toolName: "bash", toolCallId: "tc1", isError: true },
      baseInput,
    );
    expect(completed[0]?.payload).toMatchObject({ status: "failed" });
  });

  it("maps compactions and never settles on per-assistant turn_end", () => {
    expect(
      mapOmpEvent(
        { type: "auto_compaction_start", reason: "context full" },
        { ...baseInput, activeTurnId: undefined },
      ),
    ).toEqual([
      {
        type: "item.started",
        payload: {
          itemType: "context_compaction",
          status: "inProgress",
          title: "Compacting context",
          detail: "context full",
          data: { type: "auto_compaction_start", reason: "context full" },
        },
      },
    ]);
    expect(mapOmpEvent({ type: "turn_end" }, baseInput)).toEqual([]);
  });
});

// ── Integration: scripted omp process ──────────────────────────────────

interface ScriptedOmpState {
  readonly output: Queue.Queue<Uint8Array>;
  readonly observed: Queue.Queue<{
    readonly type: string;
    readonly command: Record<string, unknown>;
  }>;
  readonly handler: (command: Record<string, unknown>) => ReadonlyArray<Record<string, unknown>>;
  /** Resolve to simulate an unexpected process exit (e.g. 143 = signal death). */
  readonly exitSignal: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
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

const makeScriptedState = (handler: ScriptedOmpState["handler"]): Effect.Effect<ScriptedOmpState> =>
  Effect.gen(function* () {
    const output = yield* Queue.unbounded<Uint8Array>();
    const observed = yield* Queue.unbounded<{
      readonly type: string;
      readonly command: Record<string, unknown>;
    }>();
    const exitSignal = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    return { output, observed, handler, exitSignal };
  });

/**
 * Fake ChildProcessSpawner that answers `omp --mode rpc` with a JSONL
 * round-trip: every command written to stdin is recorded on `observed` and
 * the handler's replies are streamed back on stdout. The `ready` hello is
 * offered at spawn (the client gates its first command on it).
 */
const makeScriptedSpawner = (
  state: ScriptedOmpState,
  onSpawn?: (args: ReadonlyArray<string>, options: ChildProcess.CommandOptions) => void,
) =>
  ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) {
        return yield* Effect.die(new Error("expected a standard omp command"));
      }
      onSpawn?.(command.args, command.options);
      yield* Queue.offer(state.output, Buffer.from(`{"type":"ready","protocolVersion":2}\n`));
      const stdin = Sink.forEach((chunk: Uint8Array) =>
        Effect.gen(function* () {
          const text = Buffer.from(chunk).toString("utf8").trim();
          if (!text) {
            return;
          }
          const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text);
          if (Option.isNone(parsed)) {
            return;
          }
          const record = parsed.value as Record<string, unknown>;
          yield* Queue.offer(state.observed, { type: String(record.type), command: record });
          const replies = state.handler(record);
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
        exitCode: Deferred.await(state.exitSignal).pipe(Effect.map((code) => code)),
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

const nextCommand = (state: ScriptedOmpState) =>
  Queue.take(state.observed).pipe(Effect.map((entry) => entry.command));

const testLayer = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  ServerConfig.layerTest(process.cwd(), { prefix: "omp-adapter-test" }).pipe(
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

describe("makeOmpAdapter — scripted RPC process", () => {
  it.effect("runs a full turn, records the boundary, and rewinds via branch", () =>
    Effect.gen(function* () {
      let getStateCalls = 0;
      const state = yield* makeScriptedState((command) => {
        switch (command.type) {
          case "set_subagent_subscription":
            return [reply(command)];
          case "get_state": {
            getStateCalls += 1;
            return [
              reply(command, {
                data:
                  getStateCalls === 1
                    ? {
                        sessionFile: "/tmp/t3/omp/sessions/x/thread-1.jsonl",
                        sessionId: "thread-1",
                        isStreaming: false,
                      }
                    : {
                        sessionFile: "/tmp/t3/omp/sessions/x/forked-123.jsonl",
                        sessionId: "forked-123",
                        isStreaming: false,
                      },
              }),
            ];
          }
          case "prompt":
            return [
              reply(command, { data: { agentInvoked: true } }),
              { type: "message_start", message: { role: "assistant" } },
              {
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "Hi" },
              },
              {
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
              },
              { type: "agent_end", isTerminal: true },
            ];
          case "get_branch_messages":
            return [
              reply(command, {
                data: {
                  entries: [{ entryId: "u1", text: "hi" }],
                },
              }),
            ];
          case "branch":
            return [reply(command, { data: { cancelled: false } })];
          case "abort":
            return [reply(command)];
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

      const adapter = yield* makeOmpAdapter(decodeSettings(), { instanceId }).pipe(
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
        cwd: "/tmp/omp-project",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
        runtimeMode: "full-access",
      });
      expect(session.status).toBe("ready");
      expect(spawnArgs[0]).toEqual([
        "--mode",
        "rpc",
        "--session-dir",
        expect.stringContaining("omp/sessions/"),
        "--cwd",
        "/tmp/omp-project",
        "--model",
        "opencode-go/deepseek-v4-flash",
        "--models",
        "opencode-go/*",
        "--approval-mode",
        "yolo",
      ]);
      // stdin must stay open across per-command writes (endOnDone: true would
      // EOF it after the first command, and omp exits on stdin EOF).
      expect(spawnOptions[0]?.stdin).toMatchObject({ endOnDone: false });
      expect(isOmpResumeCursor(session.resumeCursor)).toBe(true);

      // State sync first, then the subagent subscription.
      expect((yield* nextCommand(state)).type).toBe("get_state");
      const subscription = yield* nextCommand(state);
      expect(subscription.type).toBe("set_subagent_subscription");
      expect(subscription.level).toBe("progress");

      const started = yield* adapter.sendTurn({
        threadId,
        input: "hi",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
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

      // Boundary recording: one get_branch_messages round trip after settling.
      expect((yield* nextCommand(state)).type).toBe("get_branch_messages");

      // Streaming guard + branch + post-branch state rebind + re-subscribe.
      yield* adapter.rollbackThread(threadId, 1);
      expect((yield* nextCommand(state)).type).toBe("get_state");
      const branchCommand = yield* nextCommand(state);
      expect(branchCommand.type).toBe("branch");
      expect(branchCommand.entryId).toBe("u1");
      expect((yield* nextCommand(state)).type).toBe("get_state");
      const resubscribe = yield* nextCommand(state);
      expect(resubscribe.type).toBe("set_subagent_subscription");

      // The live session now points at the forked file, with the boundary
      // list truncated (all turns discarded).
      const sessions = yield* adapter.listSessions();
      const live = sessions.find((sessionEntry) => sessionEntry.threadId === threadId);
      expect(live?.resumeCursor).toMatchObject({
        schemaVersion: 1,
        sessionFile: "/tmp/t3/omp/sessions/x/forked-123.jsonl",
        sessionId: "forked-123",
      });
      expect((live?.resumeCursor as OmpResumeCursor | undefined)?.turnBoundaries).toBeUndefined();

      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
    }),
  );

  it.effect("keeps the turn open while agent_end reports isTerminal false", () =>
    Effect.gen(function* () {
      const state = yield* makeScriptedState((command) => {
        switch (command.type) {
          case "set_subagent_subscription":
            return [reply(command)];
          case "get_state":
            return [
              reply(command, {
                data: {
                  sessionFile: "/tmp/t3/omp/sessions/x/thread-1.jsonl",
                  sessionId: "thread-1",
                  isStreaming: false,
                },
              }),
            ];
          case "prompt":
            return [
              reply(command, { data: { agentInvoked: true } }),
              { type: "agent_end", isTerminal: false },
              { type: "message_start", message: { role: "assistant", content: "still going" } },
              { type: "agent_end", isTerminal: true },
            ];
          case "get_branch_messages":
            return [
              reply(command, {
                data: { entries: [{ entryId: "u1", text: "hi" }] },
              }),
            ];
          case "abort":
            return [reply(command)];
          default:
            throw new Error(`unexpected command: ${command.type}`);
        }
      });
      const spawner = makeScriptedSpawner(state);

      const adapter = yield* makeOmpAdapter(decodeSettings(), { instanceId }).pipe(
        Effect.provide(testLayer(spawner)),
      );

      const settledDeferred = yield* Deferred.make<undefined>();
      const collector = yield* collectEventsUntil({
        stream: adapter.streamEvents,
        signals: { settled: settledDeferred },
        matches: (event) => (event.type === "turn.completed" ? "settled" : undefined),
      });

      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        providerInstanceId: instanceId,
        cwd: "/tmp/omp-project",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
        runtimeMode: "full-access",
      });
      yield* nextCommand(state);
      yield* nextCommand(state);

      yield* adapter.sendTurn({
        threadId,
        input: "hi",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
      });
      yield* nextCommand(state);

      yield* Deferred.await(settledDeferred);
      const events = yield* Ref.get(collector.events);
      const completedEvents = events.filter((event) => event.type === "turn.completed");
      // Only the terminal agent_end settles; the isTerminal: false one does not.
      expect(completedEvents).toHaveLength(1);

      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
    }),
  );

  it.effect("interrupts an active turn and swallows the trailing settle", () =>
    Effect.gen(function* () {
      const state = yield* makeScriptedState((command) => {
        switch (command.type) {
          case "set_subagent_subscription":
            return [reply(command)];
          case "get_state":
            return [
              reply(command, {
                data: {
                  sessionFile: "/tmp/t3/omp/sessions/x/thread-1.jsonl",
                  sessionId: "thread-1",
                  isStreaming: false,
                },
              }),
            ];
          case "prompt":
            return [
              reply(command, { data: { agentInvoked: true } }),
              { type: "message_start", message: { role: "assistant" } },
            ];
          case "abort":
            // OMP winds the stream down before answering: the trailing
            // agent_end lands BEFORE the abort response line.
            return [{ type: "agent_end", isTerminal: true }, reply(command)];
          case "abort":
            return [reply(command)];
          default:
            throw new Error(`unexpected command: ${command.type}`);
        }
      });
      const spawner = makeScriptedSpawner(state);

      const adapter = yield* makeOmpAdapter(decodeSettings(), { instanceId }).pipe(
        Effect.provide(testLayer(spawner)),
      );

      const interrupted = yield* Deferred.make<undefined>();
      const collector = yield* collectEventsUntil({
        stream: adapter.streamEvents,
        signals: { interrupted },
        matches: (event) => (event.type === "turn.aborted" ? "interrupted" : undefined),
      });

      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        providerInstanceId: instanceId,
        cwd: "/tmp/omp-project",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
        runtimeMode: "full-access",
      });
      yield* nextCommand(state);
      yield* nextCommand(state);

      const started = yield* adapter.sendTurn({
        threadId,
        input: "hi",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
      });
      yield* nextCommand(state);

      yield* adapter.interruptTurn(threadId, started.turnId);
      // The abort response round trip completed.
      expect((yield* nextCommand(state)).type).toBe("abort");

      yield* Deferred.await(interrupted);
      const events = yield* Ref.get(collector.events);
      const types = events.map((event) => event.type);
      expect(types).toContain("turn.aborted");
      // The trailing agent_end was suppressed: no boundary recording.
      expect(
        events
          .filter((event) => event.type === "turn.completed")
          .map((event) => event.payload.state),
      ).toEqual(["interrupted"]);

      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
    }),
  );

  it.effect("surfaces approval dialogs and answers them without a response round trip", () =>
    Effect.gen(function* () {
      const state = yield* makeScriptedState((command) => {
        switch (command.type) {
          case "set_subagent_subscription":
            return [reply(command)];
          case "get_state":
            return [
              reply(command, {
                data: {
                  sessionFile: "/tmp/t3/omp/sessions/x/thread-1.jsonl",
                  sessionId: "thread-1",
                  isStreaming: false,
                },
              }),
            ];
          case "prompt":
            return [
              reply(command, { data: { agentInvoked: true } }),
              {
                type: "extension_ui_request",
                id: "approval-1",
                method: "select",
                title: "Allow tool: bash\nCommand: rm -rf",
                options: ["Approve", "Deny"],
              },
            ];
          case "get_branch_messages":
            return [
              reply(command, {
                data: { entries: [{ entryId: "u1", text: "hi" }] },
              }),
            ];
          case "extension_ui_response":
            // Fire-and-forget: no response line is ever sent back.
            return [];
          case "abort":
            return [reply(command)];
          default:
            throw new Error(`unexpected command: ${command.type}`);
        }
      });
      const spawner = makeScriptedSpawner(state);

      const adapter = yield* makeOmpAdapter(decodeSettings(), { instanceId }).pipe(
        Effect.provide(testLayer(spawner)),
      );

      const opened = yield* Deferred.make<undefined>();
      const resolved = yield* Deferred.make<undefined>();
      const collector = yield* collectEventsUntil({
        stream: adapter.streamEvents,
        signals: { opened, resolved },
        matches: (event) =>
          event.type === "request.opened"
            ? "opened"
            : event.type === "request.resolved"
              ? "resolved"
              : undefined,
      });

      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        providerInstanceId: instanceId,
        cwd: "/tmp/omp-project",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
        runtimeMode: "approval-required",
      });
      yield* nextCommand(state);
      yield* nextCommand(state);

      yield* adapter.sendTurn({
        threadId,
        input: "hi",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
      });
      yield* nextCommand(state);

      yield* Deferred.await(opened);
      const events = yield* Ref.get(collector.events);
      const openedEvent = events.find((event) => event.type === "request.opened");
      expect(openedEvent?.payload).toMatchObject({
        requestType: "dynamic_tool_call",
        detail: "Allow tool: bash\nCommand: rm -rf",
      });

      // Responding resolves without any child reply (fire-and-forget).
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("approval-1"), "accept");
      const uiResponse = yield* nextCommand(state);
      expect(uiResponse.type).toBe("extension_ui_response");
      // The dialog id survives the write — no correlation stamp overwrote it.
      expect(uiResponse.id).toBe("approval-1");
      expect(uiResponse.value).toBe("Approve");

      yield* Deferred.await(resolved);
      const resolvedEvent = yield* Ref.get(collector.events).pipe(
        Effect.map((list) => list.find((event) => event.type === "request.resolved")),
      );
      expect(resolvedEvent?.payload).toMatchObject({
        requestType: "dynamic_tool_call",
        decision: "accept",
      });

      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
    }),
  );

  it.effect("auto-denies subsequent approval dialogs after a decline", () =>
    Effect.gen(function* () {
      let dialogCount = 0;
      const state = yield* makeScriptedState((command) => {
        switch (command.type) {
          case "set_subagent_subscription":
            return [reply(command)];
          case "get_state":
            return [
              reply(command, {
                data: {
                  sessionFile: "/tmp/t3/omp/sessions/x/thread-1.jsonl",
                  sessionId: "thread-1",
                  isStreaming: false,
                },
              }),
            ];
          case "prompt":
            return [
              reply(command, { data: { agentInvoked: true } }),
              {
                type: "extension_ui_request",
                id: "approval-1",
                method: "select",
                title: "Allow tool: bash",
                options: ["Approve", "Deny"],
              },
            ];
          case "extension_ui_response":
            dialogCount += 1;
            if (dialogCount === 1) {
              // First answer is the user's Deny.
              return [];
            }
            // The retry dialog is auto-answered — assert the write later.
            return [];
          case "abort":
            return [reply(command)];
          default:
            throw new Error(`unexpected command: ${command.type}`);
        }
      });
      const spawner = makeScriptedSpawner(state);

      const adapter = yield* makeOmpAdapter(decodeSettings(), { instanceId }).pipe(
        Effect.provide(testLayer(spawner)),
      );

      const opened = yield* Deferred.make<undefined>();
      const collector = yield* collectEventsUntil({
        stream: adapter.streamEvents,
        signals: { opened },
        matches: (event) => (event.type === "request.opened" ? "opened" : undefined),
      });

      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        providerInstanceId: instanceId,
        cwd: "/tmp/omp-project",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
        runtimeMode: "approval-required",
      });
      yield* nextCommand(state);
      yield* nextCommand(state);

      yield* adapter.sendTurn({
        threadId,
        input: "hi",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
      });
      yield* nextCommand(state);

      // Wait for the first dialog to land in the adapter's pending map.
      yield* Deferred.await(opened);

      // Decline the first dialog; a second approval dialog follows (the
      // model retries) and must be auto-answered with Deny.
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("approval-1"), "decline");
      const firstResponse = yield* nextCommand(state);
      expect(firstResponse.value).toBe("Deny");

      yield* Queue.offer(
        state.output,
        Buffer.from(
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({
            type: "extension_ui_request",
            id: "approval-2",
            method: "select",
            title: "Allow tool: bash",
            options: ["Approve", "Deny"],
          }) + "\n",
        ),
      );
      const autoResponse = yield* nextCommand(state);
      expect(autoResponse.type).toBe("extension_ui_response");
      expect(autoResponse.id).toBe("approval-2");
      expect(autoResponse.value).toBe("Deny");

      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
    }),
  );

  it.effect("renders extension dialogs as user-input questions", () =>
    Effect.gen(function* () {
      const state = yield* makeScriptedState((command) => {
        switch (command.type) {
          case "set_subagent_subscription":
            return [reply(command)];
          case "get_state":
            return [
              reply(command, {
                data: {
                  sessionFile: "/tmp/t3/omp/sessions/x/thread-1.jsonl",
                  sessionId: "thread-1",
                  isStreaming: false,
                },
              }),
            ];
          case "prompt":
            return [
              reply(command, { data: { agentInvoked: true } }),
              {
                type: "extension_ui_request",
                id: "dialog-1",
                method: "select",
                title: "Pick one",
                options: ["A", "B"],
              },
            ];
          case "extension_ui_response":
            return [];
          case "abort":
            return [reply(command)];
          default:
            throw new Error(`unexpected command: ${command.type}`);
        }
      });
      const spawner = makeScriptedSpawner(state);

      const adapter = yield* makeOmpAdapter(decodeSettings(), { instanceId }).pipe(
        Effect.provide(testLayer(spawner)),
      );

      const uiRequested = yield* Deferred.make<undefined>();
      const collector = yield* collectEventsUntil({
        stream: adapter.streamEvents,
        signals: { uiRequested },
        matches: (event) => (event.type === "user-input.requested" ? "uiRequested" : undefined),
      });

      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        providerInstanceId: instanceId,
        cwd: "/tmp/omp-project",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
        runtimeMode: "full-access",
      });
      yield* nextCommand(state);
      yield* nextCommand(state);

      yield* adapter.sendTurn({
        threadId,
        input: "do the thing",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
      });
      yield* nextCommand(state);

      yield* Deferred.await(uiRequested);
      const uiRequestedEvent = yield* Ref.get(collector.events).pipe(
        Effect.map((events) => events.find((event) => event.type === "user-input.requested")),
      );
      expect(uiRequestedEvent).toBeDefined();
      const uiPayload = uiRequestedEvent!.payload as {
        questions: ReadonlyArray<{ id: string }>;
      };
      expect(uiPayload.questions[0]!.id).toBe("dialog-1");

      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("dialog-1"), {
        "dialog-1": "A",
      });
      const uiResponse = yield* nextCommand(state);
      expect(uiResponse.type).toBe("extension_ui_response");
      expect(uiResponse.id).toBe("dialog-1");
      expect(uiResponse.value).toBe("A");

      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
    }),
  );

  it.effect("surfaces subagents as stable activity rows with scrubbed output", () =>
    Effect.gen(function* () {
      const state = yield* makeScriptedState((command) => {
        switch (command.type) {
          case "set_subagent_subscription":
            return [reply(command)];
          case "get_state":
            return [
              reply(command, {
                data: {
                  sessionFile: "/tmp/t3/omp/sessions/x/thread-1.jsonl",
                  sessionId: "thread-1",
                  isStreaming: false,
                },
              }),
            ];
          case "prompt":
            return [
              reply(command, { data: { agentInvoked: true } }),
              { type: "subagent_lifecycle", id: "sa-1", state: "started", name: "tester" },
              {
                type: "subagent_progress",
                id: "sa-1",
                status: "running step 2",
                recentOutput: `${"file contents ".repeat(500)}` + "tail",
              },
              { type: "subagent_lifecycle", id: "sa-1", state: "completed", description: "done" },
            ];
          case "get_branch_messages":
            return [
              reply(command, {
                data: { entries: [{ entryId: "u1", text: "hi" }] },
              }),
            ];
          case "abort":
            return [reply(command)];
          default:
            throw new Error(`unexpected command: ${command.type}`);
        }
      });
      const spawner = makeScriptedSpawner(state);

      const adapter = yield* makeOmpAdapter(decodeSettings(), { instanceId }).pipe(
        Effect.provide(testLayer(spawner)),
      );

      const completed = yield* Deferred.make<undefined>();
      const collector = yield* collectEventsUntil({
        stream: adapter.streamEvents,
        signals: { completed },
        matches: (event) => (event.type === "task.completed" ? "completed" : undefined),
      });

      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        providerInstanceId: instanceId,
        cwd: "/tmp/omp-project",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
        runtimeMode: "full-access",
      });
      yield* nextCommand(state);
      yield* nextCommand(state);

      yield* adapter.sendTurn({
        threadId,
        input: "hi",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
      });
      yield* nextCommand(state);

      yield* Deferred.await(completed);
      const events = yield* Ref.get(collector.events);
      const startedEvent = events.find((event) => event.type === "task.started");
      const progressEvent = events.find((event) => event.type === "task.progress");
      const completedEvent = events.find((event) => event.type === "task.completed");

      expect(startedEvent?.payload).toMatchObject({
        taskId: "subagent:sa-1",
        taskType: "subagent",
        description: "tester",
      });
      // One stable row per subagent: every frame upserts the SAME id.
      expect(progressEvent?.eventId).toBe(startedEvent?.eventId);
      expect(completedEvent?.eventId).toBe(startedEvent?.eventId);
      expect(completedEvent?.payload).toMatchObject({
        taskId: "subagent:sa-1",
        status: "completed",
      });
      // recentOutput is scrubbed: whitespace-collapsed and truncated.
      const progressPayload = progressEvent?.payload as { description: string; summary?: string };
      expect(progressPayload.description).toBe("running step 2");
      expect(progressPayload.summary?.length).toBeLessThan(2500);
      expect(progressPayload.summary?.endsWith("…")).toBe(true);

      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
    }),
  );

  it.effect("refuses rollback while the session is streaming", () =>
    Effect.gen(function* () {
      const state = yield* makeScriptedState((command) => {
        switch (command.type) {
          case "set_subagent_subscription":
            return [reply(command)];
          case "get_state":
            return [
              reply(command, {
                data: {
                  sessionFile: "/tmp/t3/omp/sessions/x/thread-1.jsonl",
                  sessionId: "thread-1",
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

      const adapter = yield* makeOmpAdapter(decodeSettings(), { instanceId }).pipe(
        Effect.provide(testLayer(spawner)),
      );

      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        providerInstanceId: instanceId,
        cwd: "/tmp/omp-project",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
        runtimeMode: "full-access",
      });
      yield* nextCommand(state);
      yield* nextCommand(state);

      const outcome = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.exit);
      expect(outcome._tag).toBe("Failure");
      const failure = Option.getOrUndefined(
        Option.flatMap(Exit.getCause(outcome), (cause) => Cause.findErrorOption(cause)),
      );
      expect(failure).toBeInstanceOf(ProviderAdapterRequestError);

      yield* adapter.stopAll();
    }),
  );

  it.effect("completes command turns that never enter the agent loop", () =>
    Effect.gen(function* () {
      const state = yield* makeScriptedState((command) => {
        switch (command.type) {
          case "set_subagent_subscription":
            return [reply(command)];
          case "get_state":
            return [
              reply(command, {
                data: {
                  sessionFile: "/tmp/t3/omp/sessions/x/thread-1.jsonl",
                  sessionId: "thread-1",
                  isStreaming: false,
                },
              }),
            ];
          case "prompt":
            return [reply(command, { data: { agentInvoked: false } })];
          case "get_branch_messages":
            return [
              reply(command, {
                data: { entries: [{ entryId: "u1", text: "/quota" }] },
              }),
            ];
          case "abort":
            return [reply(command)];
          default:
            throw new Error(`unexpected command: ${command.type}`);
        }
      });
      const spawner = makeScriptedSpawner(state);

      const adapter = yield* makeOmpAdapter(decodeSettings(), { instanceId }).pipe(
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
        cwd: "/tmp/omp-project",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
        runtimeMode: "full-access",
      });
      yield* nextCommand(state);
      yield* nextCommand(state);

      const started = yield* adapter.sendTurn({
        threadId,
        input: "/quota",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
      });
      const promptCommand = yield* nextCommand(state);
      expect(promptCommand.type).toBe("prompt");

      // agentInvoked: false → the command turn never settles on its own; the
      // adapter synthesizes completion after the grace window + probe.
      yield* Deferred.await(settled);
      const probe = yield* nextCommand(state);
      expect(probe.type).toBe("get_state");
      expect(started.turnId).toBeDefined();
      const completedEvents = (yield* Ref.get(collector.events)).filter(
        (event) => event.type === "turn.completed",
      );
      expect(completedEvents).toHaveLength(1);

      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
    }),
  );

  it.effect("reports an unexpected process exit as a failed session", () =>
    Effect.gen(function* () {
      const state = yield* makeScriptedState((command) => {
        switch (command.type) {
          case "set_subagent_subscription":
            return [reply(command)];
          case "get_state":
            return [
              reply(command, {
                data: {
                  sessionFile: "/tmp/t3/omp/sessions/x/thread-1.jsonl",
                  sessionId: "thread-1",
                  isStreaming: false,
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

      const adapter = yield* makeOmpAdapter(decodeSettings(), { instanceId }).pipe(
        Effect.provide(testLayer(spawner)),
      );

      const exited = yield* Deferred.make<undefined>();
      const collector = yield* collectEventsUntil({
        stream: adapter.streamEvents,
        signals: { exited },
        matches: (event) => (event.type === "session.exited" ? "exited" : undefined),
      });

      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        providerInstanceId: instanceId,
        cwd: "/tmp/omp-project",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
        runtimeMode: "full-access",
      });
      yield* nextCommand(state);
      yield* nextCommand(state);

      // 143 = signal death on macOS (prototype NOTES #4).
      yield* Deferred.succeed(ChildProcessSpawner.ExitCode(143))(state.exitSignal);

      yield* Deferred.await(exited);
      const events = yield* Ref.get(collector.events);
      const exitedEvent = events.find((event) => event.type === "session.exited");
      expect(exitedEvent?.payload).toMatchObject({ exitKind: "error", recoverable: true });

      // The session is gone from the adapter's view.
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
    }),
  );
});
