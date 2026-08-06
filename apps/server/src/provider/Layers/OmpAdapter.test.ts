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
import * as TestClock from "effect/testing/TestClock";
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
  OmpResumeCursor,
  type OmpResumeCursor as OmpResumeCursorType,
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

  it("tolerates start/end-only assistant streams (zero deltas)", () => {
    // opencode-go streams 36–40 deltas per turn; the anthropic gateway
    // streams zero — the item must still open and complete (prototype
    // NOTES #3).
    expect(
      mapOmpEvent({ type: "message_start", message: { role: "assistant" } }, baseInput),
    ).toEqual([
      {
        turnId: turnId("t1"),
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
    expect(
      mapOmpEvent(
        { type: "message_end", message: { role: "assistant", content: "done" } },
        baseInput,
      ),
    ).toEqual([
      {
        turnId: turnId("t1"),
        itemId: "msg-1",
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: "completed",
          title: "Assistant message",
          detail: "done",
          data: { type: "message_end", message: { role: "assistant", content: "done" } },
        },
      },
    ]);
  });

  it("never re-renders the agent_end.messages snapshot", () => {
    expect(
      mapOmpEvent(
        {
          type: "agent_end",
          isTerminal: true,
          messages: [{ role: "assistant", content: [{ type: "text", text: "already rendered" }] }],
        },
        baseInput,
      ),
    ).toEqual([]);
  });
});

describe("OmpResumeCursor round-trip", () => {
  it("survives schema encode/decode with optional fields preserved", () => {
    const cursor: OmpResumeCursorType = {
      schemaVersion: 1,
      sessionFile: "/tmp/t3/omp/sessions/x/thread-1.jsonl",
      sessionId: "thread-1",
      turnBoundaries: ["u1", "u2"],
    };
    const encoded = Schema.encodeSync(OmpResumeCursor)(cursor);
    const decoded = Schema.decodeSync(OmpResumeCursor)(encoded);
    expect(decoded).toEqual(cursor);
  });

  it("round-trips a minimal cursor and omits absent optional fields", () => {
    const cursor: OmpResumeCursorType = { schemaVersion: 1, sessionFile: "/tmp/x.jsonl" };
    const encoded = Schema.encodeSync(OmpResumeCursor)(cursor);
    expect("sessionId" in encoded).toBe(false);
    expect("turnBoundaries" in encoded).toBe(false);
    expect(Schema.decodeSync(OmpResumeCursor)(encoded)).toEqual(cursor);
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
 * offered at spawn (the client gates its first command on it); a custom
 * frame can be supplied to exercise protocol negotiation paths.
 */
const makeScriptedSpawner = (
  state: ScriptedOmpState,
  onSpawn?: (args: ReadonlyArray<string>, options: ChildProcess.CommandOptions) => void,
  readyFrame: Record<string, unknown> = { type: "ready", protocolVersion: 2 },
) =>
  ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) {
        return yield* Effect.die(new Error("expected a standard omp command"));
      }
      onSpawn?.(command.args, command.options);
      yield* Queue.offer(state.output, Buffer.from(`${JSON.stringify(readyFrame)}\n`));
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
      expect(
        (live?.resumeCursor as OmpResumeCursorType | undefined)?.turnBoundaries,
      ).toBeUndefined();

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

  it.effect(
    "renders confirm/input/editor dialogs as questions and notify/setStatus as extension events",
    () =>
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
              // One turn that fires every non-approval extension-UI kind,
              // plus the unsupported ones that must stay dropped.
              return [
                reply(command, { data: { agentInvoked: true } }),
                {
                  type: "extension_ui_request",
                  id: "ui-confirm-1",
                  method: "confirm",
                  title: "Run dangerous command?",
                },
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
                {
                  type: "extension_ui_request",
                  id: "ui-title-1",
                  method: "setTitle",
                  title: "Session title",
                },
                {
                  type: "extension_ui_request",
                  id: "ui-editor-text-1",
                  method: "set_editor_text",
                  text: "replacement",
                },
                {
                  type: "extension_ui_request",
                  id: "ui-url-1",
                  method: "open_url",
                  url: "https://example.test",
                },
                { type: "agent_end", isTerminal: true },
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

        const settled = yield* Deferred.make<undefined>();
        const uiRequested = yield* Deferred.make<undefined>();
        const noticeSeen = yield* Deferred.make<undefined>();
        const statusSeen = yield* Deferred.make<undefined>();
        const resolved1 = yield* Deferred.make<undefined>();
        const resolved2 = yield* Deferred.make<undefined>();
        const resolved3 = yield* Deferred.make<undefined>();
        const collector = yield* collectEventsUntil({
          stream: adapter.streamEvents,
          signals: {
            settled,
            uiRequested,
            noticeSeen,
            statusSeen,
            resolved1,
            resolved2,
            resolved3,
          },
          matches: (event) => {
            switch (event.type) {
              case "turn.completed":
              case "session.exited":
                return "settled";
              case "user-input.requested":
                return "uiRequested";
              case "extension.notice":
                return "noticeSeen";
              case "extension.status":
                return "statusSeen";
              case "user-input.resolved":
                return event.requestId === "ui-confirm-1"
                  ? "resolved1"
                  : event.requestId === "ui-input-1"
                    ? "resolved2"
                    : "resolved3";
              default:
                return undefined;
            }
          },
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
        expect((yield* nextCommand(state)).type).toBe("prompt");

        yield* Deferred.await(uiRequested);
        yield* Deferred.await(noticeSeen);
        yield* Deferred.await(statusSeen);
        // agent_end lands after every extension_ui_request in the script,
        // so awaiting it guarantees all frames reached the collector.
        yield* Deferred.await(settled);
        const events = yield* Ref.get(collector.events);

        const inputEvents = events.filter((event) => event.type === "user-input.requested");
        expect(inputEvents).toHaveLength(3);
        const questions = inputEvents.flatMap((event) =>
          event.type === "user-input.requested" ? event.payload.questions : [],
        );
        expect(questions).toHaveLength(3);
        expect(questions[0]).toMatchObject({
          header: "OMP extension",
          question: "Run dangerous command?",
          options: [
            { label: "Yes", description: "Confirm" },
            { label: "No", description: "Cancel" },
          ],
          multiSelect: false,
        });
        expect(questions[1]).toMatchObject({
          question: "Enter a value",
          answerKind: "text",
          placeholder: "type something...",
          options: [],
        });
        expect(questions[2]).toMatchObject({
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

        // setWidget / setTitle / set_editor_text / open_url stay dropped:
        // no event for them, and nothing was written back for any of them.
        expect(events.some((event) => event.type === "request.opened")).toBe(false);
        expect(events.some((event) => event.type === "extension.notice")).toBe(true);

        // Answer the confirm dialog: Yes/No maps onto {confirmed}.
        const confirmRequestId = ApprovalRequestId.make(questions[0]!.id);
        yield* adapter.respondToUserInput(threadId, confirmRequestId, {
          [confirmRequestId]: "No",
        });
        let uiResponse = yield* nextCommand(state);
        if (uiResponse.type === "get_branch_messages") {
          uiResponse = yield* nextCommand(state);
        }
        expect(uiResponse.type).toBe("extension_ui_response");
        expect(uiResponse.id).toBe("ui-confirm-1");
        expect(uiResponse.confirmed).toBe(false);
        yield* Deferred.await(resolved1);

        // Answer the input dialog: a non-empty value is sent as {value}.
        const inputRequestId = ApprovalRequestId.make(questions[1]!.id);
        yield* adapter.respondToUserInput(threadId, inputRequestId, {
          [inputRequestId]: "typed answer",
        });
        uiResponse = yield* nextCommand(state);
        if (uiResponse.type === "get_branch_messages") {
          uiResponse = yield* nextCommand(state);
        }
        expect(uiResponse.type).toBe("extension_ui_response");
        expect(uiResponse.id).toBe("ui-input-1");
        expect(uiResponse.value).toBe("typed answer");
        expect(uiResponse.cancelled).toBeUndefined();
        yield* Deferred.await(resolved2);

        // Answer the editor dialog the same way.
        const editorRequestId = ApprovalRequestId.make(questions[2]!.id);
        yield* adapter.respondToUserInput(threadId, editorRequestId, {
          [editorRequestId]: "edited text",
        });
        uiResponse = yield* nextCommand(state);
        if (uiResponse.type === "get_branch_messages") {
          uiResponse = yield* nextCommand(state);
        }
        expect(uiResponse.type).toBe("extension_ui_response");
        expect(uiResponse.id).toBe("ui-editor-1");
        expect(uiResponse.value).toBe("edited text");
        yield* Deferred.await(resolved3);

        // Every answer closed its T3-side card.
        const resolvedEvents = (yield* Ref.get(collector.events)).filter(
          (event) => event.type === "user-input.resolved",
        );
        expect(resolvedEvents).toHaveLength(3);
        expect(resolvedEvents.map((event) => event.requestId)).toEqual([
          "ui-confirm-1",
          "ui-input-1",
          "ui-editor-1",
        ]);

        yield* adapter.stopAll();
        yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
      }),
  );

  it.effect("a cancel frame drops the pending request silently", () =>
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
                title: "Allow tool: bash",
                options: ["Approve", "Deny"],
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

      const opened = yield* Deferred.make<undefined>();
      const dialog2Seen = yield* Deferred.make<undefined>();
      const dialog3Seen = yield* Deferred.make<undefined>();
      const collector = yield* collectEventsUntil({
        stream: adapter.streamEvents,
        signals: { opened, dialog2Seen, dialog3Seen },
        matches: (event) => {
          if (event.type === "request.opened") {
            return "opened";
          }
          if (event.type === "user-input.requested") {
            // The FIFO markers: a marker dialog landing proves every
            // earlier frame (including the cancels) was already handled by
            // the pump.
            const questionId = event.payload.questions[0]?.id;
            return questionId === "dialog-3"
              ? "dialog3Seen"
              : questionId === "dialog-2"
                ? "dialog2Seen"
                : undefined;
          }
          return undefined;
        },
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

      // Cancel the pending approval, then a fresh user-input dialog as the
      // FIFO marker.
      yield* Queue.offer(
        state.output,
        Buffer.from(
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({
            type: "extension_ui_request",
            id: "approval-1",
            method: "cancel",
          }) + "\n",
        ),
      );
      yield* Queue.offer(
        state.output,
        Buffer.from(
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({
            type: "extension_ui_request",
            id: "dialog-2",
            method: "select",
            title: "Pick one",
            options: ["A", "B"],
          }) + "\n",
        ),
      );
      yield* Deferred.await(dialog2Seen);

      // The cancelled approval is gone: responding fails instead of
      // approving, and nothing was ever written for it.
      const respondExit = yield* adapter
        .respondToRequest(threadId, ApprovalRequestId.make("approval-1"), "accept")
        .pipe(Effect.exit);
      expect(Exit.isFailure(respondExit)).toBe(true);
      if (Exit.isFailure(respondExit)) {
        const error = Cause.squash(respondExit.cause) as ProviderAdapterRequestError;
        expect(error.message).toMatch(/Unknown pending omp approval/);
      }

      // Cancel the STILL-PENDING user-input dialog the same way; dialog-3
      // is the FIFO marker. (Order matters: cancelling an already-answered
      // dialog would be a no-op on a non-pending id and prove nothing.)
      yield* Queue.offer(
        state.output,
        Buffer.from(
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({
            type: "extension_ui_request",
            id: "dialog-2",
            method: "cancel",
          }) + "\n",
        ),
      );
      yield* Queue.offer(
        state.output,
        Buffer.from(
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({
            type: "extension_ui_request",
            id: "dialog-3",
            method: "select",
            title: "Pick one",
            options: ["A", "B"],
          }) + "\n",
        ),
      );
      yield* Deferred.await(dialog3Seen);

      const inputExit = yield* adapter
        .respondToUserInput(threadId, ApprovalRequestId.make("dialog-2"), { "dialog-2": "A" })
        .pipe(Effect.exit);
      expect(Exit.isFailure(inputExit)).toBe(true);
      if (Exit.isFailure(inputExit)) {
        const error = Cause.squash(inputExit.cause) as ProviderAdapterRequestError;
        expect(error.message).toMatch(/Unknown pending omp user-input request/);
      }

      // The marker dialog is still answerable — and nothing was ever
      // written for either cancelled request (the first write on the wire
      // is dialog-3's answer).
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("dialog-3"), {
        "dialog-3": "B",
      });
      const uiResponse = yield* nextCommand(state);
      expect(uiResponse.type).toBe("extension_ui_response");
      expect(uiResponse.id).toBe("dialog-3");
      expect(uiResponse.value).toBe("B");

      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
    }),
  );

  it.effect("treats only the exact Approve/Deny option set as an approval", () =>
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
                title: "How should I proceed?",
                // A near-miss approval set: extra option, so NOT an
                // approval dialog.
                options: ["Approve", "Deny", "Ask again later"],
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

      yield* Deferred.await(uiRequested);
      const events = yield* Ref.get(collector.events);

      // Not an approval: no request.opened, and every option surfaces as a
      // user-input question option.
      expect(events.some((event) => event.type === "request.opened")).toBe(false);
      const uiRequestedEvent = events.find((event) => event.type === "user-input.requested");
      expect(uiRequestedEvent).toBeDefined();
      if (uiRequestedEvent?.type !== "user-input.requested") {
        throw new Error("expected user-input.requested");
      }
      expect(uiRequestedEvent.payload.questions[0]).toMatchObject({
        // Same generic question text as the pi adapter's select mapping.
        question: "Select an option",
        options: [
          { label: "Approve", description: "Approve" },
          { label: "Deny", description: "Deny" },
          { label: "Ask again later", description: "Ask again later" },
        ],
      });

      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
    }),
  );

  it.effect("maps acceptForSession and cancel onto single Approve/Deny writes", () =>
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
                title: "Allow tool: bash",
                options: ["Approve", "Deny"],
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

      const opened1 = yield* Deferred.make<undefined>();
      const opened2 = yield* Deferred.make<undefined>();
      const resolved1 = yield* Deferred.make<undefined>();
      const resolved2 = yield* Deferred.make<undefined>();
      const collector = yield* collectEventsUntil({
        stream: adapter.streamEvents,
        signals: { opened1, opened2, resolved1, resolved2 },
        matches: (event) => {
          if (event.type === "request.opened") {
            return String(event.requestId) === "approval-2" ? "opened2" : "opened1";
          }
          if (event.type === "request.resolved") {
            return String(event.requestId) === "approval-2" ? "resolved2" : "resolved1";
          }
          return undefined;
        },
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

      // acceptForSession has no OMP equivalent: one Approve write.
      yield* Deferred.await(opened1);
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make("approval-1"),
        "acceptForSession",
      );
      const first = yield* nextCommand(state);
      expect(first.type).toBe("extension_ui_response");
      expect(first.id).toBe("approval-1");
      expect(first.value).toBe("Approve");
      yield* Deferred.await(resolved1);
      const resolved1Event = (yield* Ref.get(collector.events)).find(
        (event) => event.type === "request.resolved" && String(event.requestId) === "approval-1",
      );
      expect(resolved1Event?.type === "request.resolved" && resolved1Event.payload).toMatchObject({
        requestType: "dynamic_tool_call",
        decision: "acceptForSession",
      });

      // A second approval dialog: cancel must never grant the tool.
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
      yield* Deferred.await(opened2);
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("approval-2"), "cancel");
      const second = yield* nextCommand(state);
      expect(second.type).toBe("extension_ui_response");
      expect(second.id).toBe("approval-2");
      expect(second.value).toBe("Deny");
      yield* Deferred.await(resolved2);
      const resolved2Event = (yield* Ref.get(collector.events)).find(
        (event) => event.type === "request.resolved" && String(event.requestId) === "approval-2",
      );
      expect(resolved2Event?.type === "request.resolved" && resolved2Event.payload).toMatchObject({
        requestType: "dynamic_tool_call",
        decision: "cancel",
      });

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
              { type: "subagent_lifecycle", id: "sa-2", state: "started", name: "runner" },
              {
                type: "subagent_lifecycle",
                id: "sa-2",
                state: "failed",
                description: "hit an upstream timeout",
              },
              { type: "subagent_lifecycle", id: "sa-3", state: "started", name: "helper" },
              {
                type: "subagent_lifecycle",
                id: "sa-3",
                state: "aborted",
                description: "cancelled",
              },
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
      const failed = yield* Deferred.make<undefined>();
      const aborted = yield* Deferred.make<undefined>();
      const collector = yield* collectEventsUntil({
        stream: adapter.streamEvents,
        signals: { completed, failed, aborted },
        matches: (event) => {
          if (event.type !== "task.completed") {
            return undefined;
          }
          const taskId = event.payload.taskId;
          if (taskId === "subagent:sa-1") return "completed";
          if (taskId === "subagent:sa-2") return "failed";
          if (taskId === "subagent:sa-3") return "aborted";
          return undefined;
        },
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
      yield* Deferred.await(failed);
      yield* Deferred.await(aborted);
      const events = yield* Ref.get(collector.events);
      const startedEvent = events.find((event) => event.type === "task.started");
      const progressEvent = events.find((event) => event.type === "task.progress");
      const completedEvents = events.filter((event) => event.type === "task.completed");
      const completedEvent = completedEvents.find(
        (event) => event.payload.taskId === "subagent:sa-1",
      );
      const failedEvent = completedEvents.find((event) => event.payload.taskId === "subagent:sa-2");
      const abortedEvent = completedEvents.find(
        (event) => event.payload.taskId === "subagent:sa-3",
      );

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
      // Terminal tone inputs: failed stays failed, aborted maps to stopped
      // (the projection tones failed → error and everything else → info).
      expect(failedEvent?.payload).toMatchObject({
        taskId: "subagent:sa-2",
        status: "failed",
        summary: "hit an upstream timeout",
      });
      expect(failedEvent?.eventId).toBe(
        events.find(
          (event) => event.type === "task.started" && event.payload.taskId === "subagent:sa-2",
        )?.eventId,
      );
      expect(abortedEvent?.payload).toMatchObject({
        taskId: "subagent:sa-3",
        status: "stopped",
        summary: "cancelled",
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

  it.effect("reports a code-0 self-exit as a graceful session end", () =>
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

      // Exit 0 = the stdin-EOF graceful path (prototype NOTES #10).
      yield* Deferred.succeed(ChildProcessSpawner.ExitCode(0))(state.exitSignal);

      yield* Deferred.await(exited);
      const events = yield* Ref.get(collector.events);
      const exitedEvent = events.find((event) => event.type === "session.exited");
      expect(exitedEvent?.payload).toMatchObject({
        reason: "OMP process exited (code 0).",
        recoverable: true,
        exitKind: "graceful",
      });

      expect(yield* adapter.hasSession(threadId)).toBe(false);
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
    }),
  );

  it.effect(
    "negotiates protocol v2 before the first command when the ready hello advertises it",
    () =>
      Effect.gen(function* () {
        const state = yield* makeScriptedState((command) => {
          switch (command.type) {
            case "negotiate_protocol":
              return [reply(command, { data: { protocolVersion: 2 } })];
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
        const spawner = makeScriptedSpawner(state, undefined, {
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
        });

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
        // The negotiation lands before the adapter's own first command.
        const negotiation = yield* nextCommand(state);
        expect(negotiation.type).toBe("negotiate_protocol");
        expect(negotiation.protocolVersion).toBe(2);
        expect((yield* nextCommand(state)).type).toBe("get_state");

        yield* adapter.stopAll();
      }),
  );

  it.effect("degrades to v1 when protocol-v2 negotiation is rejected", () =>
    Effect.gen(function* () {
      const state = yield* makeScriptedState((command) => {
        switch (command.type) {
          case "negotiate_protocol":
            // A v1-only binary answers `success: false`; the session must
            // proceed on v1 framing regardless.
            return [
              reply(command, { success: false, error: "Unknown command: negotiate_protocol" }),
            ];
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
      const spawner = makeScriptedSpawner(state, undefined, {
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });

      const adapter = yield* makeOmpAdapter(decodeSettings(), { instanceId }).pipe(
        Effect.provide(testLayer(spawner)),
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        providerInstanceId: instanceId,
        cwd: "/tmp/omp-project",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
        runtimeMode: "full-access",
      });
      expect(session.status).toBe("ready");
      const negotiation = yield* nextCommand(state);
      expect(negotiation.type).toBe("negotiate_protocol");
      expect((yield* nextCommand(state)).type).toBe("get_state");

      yield* adapter.stopAll();
    }),
  );

  it.effect("falls back to v1 when protocol-v2 negotiation never answers", () =>
    Effect.gen(function* () {
      const state = yield* makeScriptedState((command) => {
        switch (command.type) {
          case "negotiate_protocol":
            // No response line, ever: the negotiation must time out and the
            // first command must proceed on v1 (and the timed-out pending
            // entry must not block later commands).
            return [];
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
      const spawner = makeScriptedSpawner(state, undefined, {
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });

      const adapter = yield* makeOmpAdapter(decodeSettings(), { instanceId }).pipe(
        Effect.provide(testLayer(spawner)),
      );

      const startFiber = yield* adapter
        .startSession({
          threadId,
          provider: PROVIDER,
          providerInstanceId: instanceId,
          cwd: "/tmp/omp-project",
          modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkScoped);
      // Deterministic signal that the negotiation is in flight: the command
      // is on the wire, and its 5s response timeout is now a clock sleep.
      expect((yield* nextCommand(state)).type).toBe("negotiate_protocol");
      // Advance the TestClock (with scheduler hops so the racing timeout
      // fiber registers its wakeup) until the negotiation timeout fires and
      // the gated first command proceeds.
      for (let attempt = 0; attempt < 600; attempt += 1) {
        yield* TestClock.adjust("10 millis");
        yield* Effect.yieldNow;
      }
      const session = yield* Fiber.join(startFiber).pipe(
        Effect.timeoutOption("1 seconds"),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.die(
                new Error("omp session did not start after the protocol-v2 negotiation timeout"),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );
      expect(session.status).toBe("ready");
      expect((yield* nextCommand(state)).type).toBe("get_state");

      yield* adapter.stopAll();
    }),
  );

  it.effect("round-trips a >1 MiB agent event through the full pipeline", () =>
    Effect.gen(function* () {
      const delta = "x".repeat(1024 * 1024 + 64);
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
              { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } },
              { type: "message_end", message: { role: "assistant", content: "done" } },
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

      yield* adapter.sendTurn({
        threadId,
        input: "hi",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
      });
      yield* nextCommand(state);

      yield* Deferred.await(settled);
      const events = yield* Ref.get(collector.events);
      const deltaEvent = events.find((event) => event.type === "content.delta");
      const deltaPayload = deltaEvent?.payload as { delta: string } | undefined;
      // The whole >1 MiB record survives framing, splitting, and parsing.
      expect(deltaPayload?.delta.length).toBe(1024 * 1024 + 64);
      expect(deltaPayload?.delta).toBe(delta);
      expect(events.filter((event) => event.type === "item.started")).toHaveLength(1);

      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
    }),
  );

  it.effect("never re-renders the agent_end.messages snapshot", () =>
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
              {
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "Hi" },
              },
              { type: "message_end", message: { role: "assistant", content: "Hi" } },
              {
                type: "agent_end",
                isTerminal: true,
                messages: [{ role: "assistant", content: [{ type: "text", text: "Hi" }] }],
              },
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

      yield* adapter.sendTurn({
        threadId,
        input: "hi",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
      });
      yield* nextCommand(state);

      yield* Deferred.await(settled);
      const events = yield* Ref.get(collector.events);
      // Exactly the live stream rendered: one item, one delta, one
      // completion — the agent_end.messages snapshot is never replayed.
      expect(events.filter((event) => event.type === "item.started")).toHaveLength(1);
      expect(events.filter((event) => event.type === "content.delta")).toHaveLength(1);
      expect(events.filter((event) => event.type === "item.completed")).toHaveLength(1);

      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
    }),
  );

  it.effect("resumes a session across restarts via the resume cursor", () =>
    Effect.gen(function* () {
      const handler = (command: Record<string, unknown>) => {
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
              {
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "Hi" },
              },
              { type: "message_end", message: { role: "assistant", content: "Hi" } },
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
      };
      const state = yield* makeScriptedState(handler);
      const spawnArgs: Array<ReadonlyArray<string>> = [];
      const startInput = {
        threadId,
        provider: PROVIDER,
        providerInstanceId: instanceId,
        cwd: "/tmp/omp-project",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
        runtimeMode: "full-access",
      } as const;

      // Adapter A: fresh launch (no cursor), one settled turn.
      const adapterA = yield* makeOmpAdapter(decodeSettings(), { instanceId }).pipe(
        Effect.provide(testLayer(makeScriptedSpawner(state, (args) => spawnArgs.push(args)))),
      );
      const settledA = yield* Deferred.make<undefined>();
      const collectorA = yield* collectEventsUntil({
        stream: adapterA.streamEvents,
        signals: { settledA },
        matches: (event) => (event.type === "turn.completed" ? "settledA" : undefined),
      });

      yield* adapterA.startSession(startInput);
      yield* nextCommand(state);
      yield* nextCommand(state);
      yield* adapterA.sendTurn({
        threadId,
        input: "hi",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
      });
      yield* nextCommand(state);
      yield* Deferred.await(settledA);
      // Boundary recorded after the settle.
      expect((yield* nextCommand(state)).type).toBe("get_branch_messages");
      // The recorder updates the cursor ref after its response round trip —
      // bounded yield-now poll for the durable boundary to land.
      let cursor: OmpResumeCursorType | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const sessions = yield* adapterA.listSessions();
        const live = sessions.find((entry) => entry.threadId === threadId);
        cursor = live?.resumeCursor as OmpResumeCursorType | undefined;
        if (cursor?.turnBoundaries?.length === 1) {
          break;
        }
        yield* Effect.yieldNow;
      }
      expect(cursor?.sessionFile).toBe("/tmp/t3/omp/sessions/x/thread-1.jsonl");
      expect(cursor?.turnBoundaries).toEqual(["u1"]);
      // Fresh launch: no --resume flag.
      expect(spawnArgs[0]).not.toContain("--resume");

      yield* adapterA.stopAll();
      yield* Fiber.interrupt(collectorA.fiber).pipe(Effect.ignore);
      // A's stop path best-effort aborts the child; drain it so B's
      // command stream starts clean.
      expect((yield* nextCommand(state)).type).toBe("abort");

      // Adapter B: same thread, resumed from the persisted cursor.
      const adapterB = yield* makeOmpAdapter(decodeSettings(), { instanceId }).pipe(
        Effect.provide(testLayer(makeScriptedSpawner(state, (args) => spawnArgs.push(args)))),
      );
      const settledB = yield* Deferred.make<undefined>();
      const collectorB = yield* collectEventsUntil({
        stream: adapterB.streamEvents,
        signals: { settledB },
        matches: (event) => (event.type === "turn.completed" ? "settledB" : undefined),
      });

      yield* adapterB.startSession({ ...startInput, resumeCursor: cursor });
      const resumedArgs = spawnArgs[1]!;
      expect(resumedArgs[resumedArgs.indexOf("--resume") + 1]).toBe(cursor!.sessionFile);
      yield* nextCommand(state);
      yield* nextCommand(state);
      yield* adapterB.sendTurn({
        threadId,
        input: "again",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
      });
      const promptCommand = yield* nextCommand(state);
      expect(promptCommand.type).toBe("prompt");
      expect(promptCommand.message).toBe("again");
      yield* Deferred.await(settledB);

      yield* adapterB.stopAll();
      yield* Fiber.interrupt(collectorB.fiber).pipe(Effect.ignore);
    }),
  );

  it.effect(
    "applies a mid-thread model change via set_model on the next turn without restarting",
    () =>
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
            case "set_model":
              return [reply(command)];
            case "prompt":
              return [
                reply(command, { data: { agentInvoked: true } }),
                { type: "message_start", message: { role: "assistant" } },
                { type: "message_end", message: { role: "assistant", content: "Hi" } },
                { type: "agent_end", isTerminal: true },
              ];
            case "get_branch_messages":
              return [reply(command, { data: { entries: [] } })];
            case "abort":
              return [reply(command)];
            default:
              throw new Error(`unexpected command: ${command.type}`);
          }
        });
        let spawnCount = 0;
        const spawner = makeScriptedSpawner(state, () => {
          spawnCount += 1;
        });

        const adapter = yield* makeOmpAdapter(decodeSettings(), { instanceId }).pipe(
          Effect.provide(testLayer(spawner)),
        );
        let completedTurns = 0;
        const settled = yield* Deferred.make<undefined>();
        const settledAgain = yield* Deferred.make<undefined>();
        const collector = yield* collectEventsUntil({
          stream: adapter.streamEvents,
          signals: { settled, settledAgain },
          matches: (event) => {
            if (event.type === "turn.completed") {
              completedTurns += 1;
              return completedTurns === 1
                ? "settled"
                : completedTurns === 2
                  ? "settledAgain"
                  : undefined;
            }
            return undefined;
          },
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

        // The picker change lands as set_model on the next turn, before the
        // prompt — same process, no restart.
        yield* adapter.sendTurn({
          threadId,
          input: "switch me",
          modelSelection: { instanceId, model: "anthropic/claude-opus-4-8" },
        });
        const setModel = yield* nextCommand(state);
        expect(setModel).toMatchObject({
          type: "set_model",
          provider: "anthropic",
          modelId: "claude-opus-4-8",
        });
        expect((yield* nextCommand(state)).type).toBe("prompt");
        yield* Deferred.await(settled);
        expect((yield* nextCommand(state)).type).toBe("get_branch_messages");

        const events = yield* Ref.get(collector.events);
        const started = events.find((event) => event.type === "turn.started");
        expect(started?.payload).toMatchObject({ model: "anthropic/claude-opus-4-8" });
        expect(events.some((event) => event.type === "runtime.warning")).toBe(false);
        const sessions = yield* adapter.listSessions();
        expect(sessions.find((entry) => entry.threadId === threadId)?.model).toBe(
          "anthropic/claude-opus-4-8",
        );
        expect(spawnCount).toBe(1);

        // A turn on the already-applied model sends no set_model.
        yield* adapter.sendTurn({
          threadId,
          input: "again",
          modelSelection: { instanceId, model: "anthropic/claude-opus-4-8" },
        });
        expect((yield* nextCommand(state)).type).toBe("prompt");
        yield* Deferred.await(settledAgain);

        yield* adapter.stopAll();
        yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
      }),
  );

  it.effect(
    "surfaces a rejected model switch, keeps the old model, and retries on the next turn",
    () =>
      Effect.gen(function* () {
        let setModelCalls = 0;
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
            case "set_model":
              setModelCalls += 1;
              return setModelCalls === 1
                ? [
                    reply(command, {
                      success: false,
                      error: "model 'anthropic/claude-opus-4-8' is not configured",
                    }),
                  ]
                : [reply(command)];
            case "prompt":
              return [
                reply(command, { data: { agentInvoked: true } }),
                { type: "agent_end", isTerminal: true },
              ];
            case "get_branch_messages":
              return [reply(command, { data: { entries: [] } })];
            case "abort":
              return [reply(command)];
            default:
              throw new Error(`unexpected command: ${command.type}`);
          }
        });

        const adapter = yield* makeOmpAdapter(decodeSettings(), { instanceId }).pipe(
          Effect.provide(testLayer(makeScriptedSpawner(state))),
        );
        let completedTurns = 0;
        const settled = yield* Deferred.make<undefined>();
        const settledAgain = yield* Deferred.make<undefined>();
        const collector = yield* collectEventsUntil({
          stream: adapter.streamEvents,
          signals: { settled, settledAgain },
          matches: (event) => {
            if (event.type === "turn.completed") {
              completedTurns += 1;
              return completedTurns === 1
                ? "settled"
                : completedTurns === 2
                  ? "settledAgain"
                  : undefined;
            }
            return undefined;
          },
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

        // Turn 1: OMP rejects the switch — notice surfaces, the turn proceeds
        // on the old model, and the session bookkeeping keeps the old model.
        yield* adapter.sendTurn({
          threadId,
          input: "keep going",
          modelSelection: { instanceId, model: "anthropic/claude-opus-4-8" },
        });
        expect((yield* nextCommand(state)).type).toBe("set_model");
        expect((yield* nextCommand(state)).type).toBe("prompt");
        yield* Deferred.await(settled);
        expect((yield* nextCommand(state)).type).toBe("get_branch_messages");

        let events = yield* Ref.get(collector.events);
        const warning = events.find((event) => event.type === "runtime.warning");
        expect(warning?.payload).toMatchObject({
          message: expect.stringContaining("could not switch to model 'anthropic/claude-opus-4-8'"),
        });
        expect(warning?.payload).toMatchObject({
          message: expect.stringContaining("The previous model stays active."),
        });
        // Neither the session nor turn.started may claim the rejected model.
        let sessions = yield* adapter.listSessions();
        expect(sessions.find((entry) => entry.threadId === threadId)?.model).toBe(
          "opencode-go/deepseek-v4-flash",
        );
        const started = events.find((event) => event.type === "turn.started");
        expect(started?.payload).toEqual({});

        // Turn 2: picker still on the rejected model — the switch is retried
        // instead of being silently dropped, and now lands.
        yield* adapter.sendTurn({
          threadId,
          input: "try again",
          modelSelection: { instanceId, model: "anthropic/claude-opus-4-8" },
        });
        expect((yield* nextCommand(state)).type).toBe("set_model");
        expect((yield* nextCommand(state)).type).toBe("prompt");
        yield* Deferred.await(settledAgain);
        expect((yield* nextCommand(state)).type).toBe("get_branch_messages");

        sessions = yield* adapter.listSessions();
        expect(sessions.find((entry) => entry.threadId === threadId)?.model).toBe(
          "anthropic/claude-opus-4-8",
        );
        expect(setModelCalls).toBe(2);

        yield* adapter.stopAll();
        yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
      }),
  );

  it.effect("applies a thinking-tier change via set_thinking_level on the next turn", () =>
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
          case "set_thinking_level":
            return [reply(command)];
          case "prompt":
            return [
              reply(command, { data: { agentInvoked: true } }),
              { type: "agent_end", isTerminal: true },
            ];
          case "get_branch_messages":
            return [reply(command, { data: { entries: [] } })];
          case "abort":
            return [reply(command)];
          default:
            throw new Error(`unexpected command: ${command.type}`);
        }
      });

      const adapter = yield* makeOmpAdapter(decodeSettings(), { instanceId }).pipe(
        Effect.provide(testLayer(makeScriptedSpawner(state))),
      );
      let completedTurns = 0;
      const settled = yield* Deferred.make<undefined>();
      const settledAgain = yield* Deferred.make<undefined>();
      const settledThird = yield* Deferred.make<undefined>();
      const collector = yield* collectEventsUntil({
        stream: adapter.streamEvents,
        signals: { settled, settledAgain, settledThird },
        matches: (event) => {
          if (event.type === "turn.completed") {
            completedTurns += 1;
            return completedTurns === 1
              ? "settled"
              : completedTurns === 2
                ? "settledAgain"
                : completedTurns === 3
                  ? "settledThird"
                  : undefined;
          }
          return undefined;
        },
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

      // Tier picked for the first time — set_thinking_level lands before the prompt.
      yield* adapter.sendTurn({
        threadId,
        input: "think hard",
        modelSelection: {
          instanceId,
          model: "opencode-go/deepseek-v4-flash",
          options: [{ id: "thinkingLevel", value: "high" }],
        },
      });
      const levelCommand = yield* nextCommand(state);
      expect(levelCommand).toMatchObject({ type: "set_thinking_level", level: "high" });
      expect((yield* nextCommand(state)).type).toBe("prompt");
      yield* Deferred.await(settled);
      expect((yield* nextCommand(state)).type).toBe("get_branch_messages");

      // Same tier on the next turn — no set_thinking_level.
      yield* adapter.sendTurn({
        threadId,
        input: "still high",
        modelSelection: {
          instanceId,
          model: "opencode-go/deepseek-v4-flash",
          options: [{ id: "thinkingLevel", value: "high" }],
        },
      });
      expect((yield* nextCommand(state)).type).toBe("prompt");
      yield* Deferred.await(settledAgain);
      expect((yield* nextCommand(state)).type).toBe("get_branch_messages");

      // New tier — set_thinking_level again.
      yield* adapter.sendTurn({
        threadId,
        input: "max it",
        modelSelection: {
          instanceId,
          model: "opencode-go/deepseek-v4-flash",
          options: [{ id: "thinkingLevel", value: "max" }],
        },
      });
      expect(yield* nextCommand(state)).toMatchObject({
        type: "set_thinking_level",
        level: "max",
      });
      expect((yield* nextCommand(state)).type).toBe("prompt");
      yield* Deferred.await(settledThird);

      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
    }),
  );

  it.effect("keeps the applied thinking tier across turns without a tier selection", () =>
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
          case "set_thinking_level":
            return [reply(command)];
          case "prompt":
            return [
              reply(command, { data: { agentInvoked: true } }),
              { type: "agent_end", isTerminal: true },
            ];
          case "get_branch_messages":
            return [reply(command, { data: { entries: [] } })];
          case "abort":
            return [reply(command)];
          default:
            throw new Error(`unexpected command: ${command.type}`);
        }
      });

      const adapter = yield* makeOmpAdapter(decodeSettings(), { instanceId }).pipe(
        Effect.provide(testLayer(makeScriptedSpawner(state))),
      );
      let completedTurns = 0;
      const settled = yield* Deferred.make<undefined>();
      const settledAgain = yield* Deferred.make<undefined>();
      const settledThird = yield* Deferred.make<undefined>();
      const collector = yield* collectEventsUntil({
        stream: adapter.streamEvents,
        signals: { settled, settledAgain, settledThird },
        matches: (event) => {
          if (event.type === "turn.completed") {
            completedTurns += 1;
            return completedTurns === 1
              ? "settled"
              : completedTurns === 2
                ? "settledAgain"
                : completedTurns === 3
                  ? "settledThird"
                  : undefined;
          }
          return undefined;
        },
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

      // Turn 1: tier applied.
      yield* adapter.sendTurn({
        threadId,
        input: "think",
        modelSelection: {
          instanceId,
          model: "opencode-go/deepseek-v4-flash",
          options: [{ id: "thinkingLevel", value: "high" }],
        },
      });
      expect(yield* nextCommand(state)).toMatchObject({
        type: "set_thinking_level",
        level: "high",
      });
      expect((yield* nextCommand(state)).type).toBe("prompt");
      yield* Deferred.await(settled);
      expect((yield* nextCommand(state)).type).toBe("get_branch_messages");

      // Turn 2: no tier in the selection (e.g. a model without a tier) —
      // must not clear the applied tier.
      yield* adapter.sendTurn({
        threadId,
        input: "no tier here",
        modelSelection: { instanceId, model: "opencode-go/deepseek-v4-flash" },
      });
      expect((yield* nextCommand(state)).type).toBe("prompt");
      yield* Deferred.await(settledAgain);
      expect((yield* nextCommand(state)).type).toBe("get_branch_messages");

      // Turn 3: same tier as turn 1 — still applied, no re-send.
      yield* adapter.sendTurn({
        threadId,
        input: "think again",
        modelSelection: {
          instanceId,
          model: "opencode-go/deepseek-v4-flash",
          options: [{ id: "thinkingLevel", value: "high" }],
        },
      });
      expect((yield* nextCommand(state)).type).toBe("prompt");
      yield* Deferred.await(settledThird);

      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
    }),
  );

  it.effect("surfaces a rejected thinking-tier change and retries it on the next turn", () =>
    Effect.gen(function* () {
      let levelCalls = 0;
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
          case "set_thinking_level":
            levelCalls += 1;
            return levelCalls === 1
              ? [
                  reply(command, {
                    success: false,
                    error: "level 'max' is unsupported by the current model",
                  }),
                ]
              : [reply(command)];
          case "prompt":
            return [
              reply(command, { data: { agentInvoked: true } }),
              { type: "agent_end", isTerminal: true },
            ];
          case "get_branch_messages":
            return [reply(command, { data: { entries: [] } })];
          case "abort":
            return [reply(command)];
          default:
            throw new Error(`unexpected command: ${command.type}`);
        }
      });

      const adapter = yield* makeOmpAdapter(decodeSettings(), { instanceId }).pipe(
        Effect.provide(testLayer(makeScriptedSpawner(state))),
      );
      let completedTurns = 0;
      const settled = yield* Deferred.make<undefined>();
      const settledAgain = yield* Deferred.make<undefined>();
      const collector = yield* collectEventsUntil({
        stream: adapter.streamEvents,
        signals: { settled, settledAgain },
        matches: (event) => {
          if (event.type === "turn.completed") {
            completedTurns += 1;
            return completedTurns === 1
              ? "settled"
              : completedTurns === 2
                ? "settledAgain"
                : undefined;
          }
          return undefined;
        },
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

      // Turn 1: rejected — notice surfaces, the turn proceeds on the old tier.
      yield* adapter.sendTurn({
        threadId,
        input: "think",
        modelSelection: {
          instanceId,
          model: "opencode-go/deepseek-v4-flash",
          options: [{ id: "thinkingLevel", value: "max" }],
        },
      });
      expect((yield* nextCommand(state)).type).toBe("set_thinking_level");
      expect((yield* nextCommand(state)).type).toBe("prompt");
      yield* Deferred.await(settled);
      expect((yield* nextCommand(state)).type).toBe("get_branch_messages");

      const events = yield* Ref.get(collector.events);
      const warning = events.find((event) => event.type === "runtime.warning");
      expect(warning?.payload).toMatchObject({
        message: expect.stringContaining("could not set thinking level 'max'"),
      });
      expect(warning?.payload).toMatchObject({
        message: expect.stringContaining("The previous level stays active."),
      });

      // Turn 2: same tier — retried, and now accepted.
      yield* adapter.sendTurn({
        threadId,
        input: "think again",
        modelSelection: {
          instanceId,
          model: "opencode-go/deepseek-v4-flash",
          options: [{ id: "thinkingLevel", value: "max" }],
        },
      });
      expect((yield* nextCommand(state)).type).toBe("set_thinking_level");
      expect((yield* nextCommand(state)).type).toBe("prompt");
      yield* Deferred.await(settledAgain);
      expect(levelCalls).toBe(2);

      yield* adapter.stopAll();
      yield* Fiber.interrupt(collector.fiber).pipe(Effect.ignore);
    }),
  );
});
