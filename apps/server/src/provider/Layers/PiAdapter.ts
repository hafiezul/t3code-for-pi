/**
 * PiAdapter — per-thread `pi --mode rpc` session adapter.
 *
 * Protocol/design contract (wayfinder #44/#45/#47/#51/#52):
 *
 *   - One long-lived `pi --mode rpc` subprocess per thread, spawned lazily
 *     in the project cwd, kept alive across turns, torn down by
 *     `stopSession` / the idle reaper / adapter shutdown. Server restart
 *     kills the process; the next turn relaunches from the durable cursor —
 *     the JSONL session file makes resume instant.
 *   - Deterministic per-thread session files: `--session-dir
 *     <state>/pi/sessions/<projectKey>` + `--session-id <threadId>`
 *     (create-or-resume). After the first fork (#52), the file has a random
 *     session id that `--session-id` can never find, so launches switch to
 *     `--session <sessionFile>`.
 *   - Queue modes are pinned once at spawn (`one-at-a-time`) — the docs'
 *     own get_state example shows `steeringMode: "all"`, so defaults are
 *     not stable across versions.
 *   - Turn lifecycle: `turn.started` once per T3 turn in `sendTurn`;
 *     `turn.completed` only on pi's `agent_settled` (never per-assistant
 *     `turn_end`). A steer while a turn is active reuses the active turn id.
 *   - pi has no tool-permission prompts: `respondToRequest` is a documented
 *     no-op, no `request.opened`/`tool.denied` is ever emitted. Extension
 *     dialogs surface through the `extension_ui_request` sub-protocol:
 *     `select`/`confirm` map to `user-input.requested`; `input`/`editor`
 *     don't fit T3's options-only contract and are declined so extensions
 *     fall back to their defaults.
 *   - Thread restore rewinds by `fork` at the first user entry of the first
 *     discarded turn (#52); boundaries (session leaf ids at each
 *     `agent_settled`) are persisted in the resume cursor.
 *   - Model changes apply on the next turn via `set_model` — no session
 *     restart, no context loss.
 *
 * Event translation is table-driven with an ignore-by-default fallthrough:
 * unknown event types are dropped with a debug log, so the protocol can
 * grow across pi releases without breaking the adapter.
 *
 * @module provider/Layers/PiAdapter
 */
import {
  ApprovalRequestId,
  ChatAttachment,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  UserInputQuestion,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { makePiRpcClient, type PiRpcClient, type PiRpcEvent } from "../piRuntime.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { makeEventNdjsonLogger, type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import type { PiSettings } from "@t3tools/contracts";

const PROVIDER = ProviderDriverKind.make("pi");

export const PI_RESUME_SCHEMA_VERSION = 1 as const;

export const PiResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(PI_RESUME_SCHEMA_VERSION),
  sessionFile: Schema.String,
  sessionId: Schema.optional(Schema.String),
  turnBoundaries: Schema.optional(Schema.Array(Schema.String)),
});
export type PiResumeCursor = typeof PiResumeCursor.Type;

const isPiResumeCursorValue = Schema.is(PiResumeCursor);
const isPiRequestError = Schema.is(ProviderAdapterRequestError);
const isPiValidationError = Schema.is(ProviderAdapterValidationError);

export const isPiResumeCursor = (value: unknown): value is PiResumeCursor =>
  isPiResumeCursorValue(value);

/**
 * Launch argument contract (#45 + #52 amendment):
 *   - never forked (`--session-id` created the file, so the header id IS the
 *     thread id — or no file exists yet) → `--session-id <threadId>`;
 *   - after any fork the file carries a random session id → `--session
 *     <sessionFile>`;
 *   - `--model <slug>` verbatim (no provider derivation — pi's
 *     `provider/id` patterns are self-sufficient; the instance config has no
 *     provider field);
 *   - user `launchArgs` tokens appended last.
 */
export const resolvePiLaunchArgs = (input: {
  readonly threadId: ThreadId;
  readonly sessionDir: string;
  readonly resumeCursor: PiResumeCursor | undefined;
  readonly model: string | undefined;
  readonly launchArgs: string;
  /** Picked thinking tier (`off|minimal|low|medium|high|xhigh|max`); absent leaves pi's default. */
  readonly thinkingLevel?: string | undefined;
}): ReadonlyArray<string> => {
  const args = ["--mode", "rpc", "--session-dir", input.sessionDir];
  const cursor = input.resumeCursor;
  const neverForked =
    cursor === undefined || cursor.sessionId === undefined || cursor.sessionId === input.threadId;
  if (neverForked) {
    args.push("--session-id", input.threadId);
  } else if (cursor.sessionFile) {
    args.push("--session", cursor.sessionFile);
  } else {
    args.push("--session-id", input.threadId);
  }
  if (input.model !== undefined) {
    args.push("--model", input.model);
  }
  if (input.thinkingLevel !== undefined && input.thinkingLevel.length > 0) {
    args.push("--thinking", input.thinkingLevel);
  }
  args.push(...tokenizeCliArgs(input.launchArgs));
  return args;
};

/** First-`/` split of a pi model slug (`provider`/`modelId`; model ids may contain `/`). */
export function splitPiModelSlug(slug: string): {
  readonly provider?: string;
  readonly modelId: string;
} {
  const slashIndex = slug.indexOf("/");
  if (slashIndex === -1) {
    return { modelId: slug };
  }
  return {
    provider: slug.slice(0, slashIndex),
    modelId: slug.slice(slashIndex + 1),
  };
}

const PI_API_KEY_ENV: ReadonlyArray<{ readonly field: keyof PiSettings; readonly env: string }> = [
  { field: "anthropicApiKey", env: "ANTHROPIC_API_KEY" },
  { field: "openaiApiKey", env: "OPENAI_API_KEY" },
  { field: "geminiApiKey", env: "GEMINI_API_KEY" },
  { field: "groqApiKey", env: "GROQ_API_KEY" },
  { field: "xaiApiKey", env: "XAI_API_KEY" },
];

export const piApiKeyEnvironment = (piSettings: PiSettings): Readonly<Record<string, string>> => {
  const env: Record<string, string> = {};
  for (const entry of PI_API_KEY_ENV) {
    const value = piSettings[entry.field];
    if (typeof value === "string" && value.trim().length > 0) {
      env[entry.env] = value;
    }
  }
  return env;
};

interface PiAdapterSessionContext {
  readonly threadId: ThreadId;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly client: PiRpcClient;
  /** Sole lifecycle handle for the session: closing it kills the child
   *  process and interrupts the pump/exit/stderr/boundary fibers. */
  readonly sessionScope: Scope.Closeable;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  /** Current assistant message item id, for message_start → message_end
   *  correlation (pi messages carry no ids of their own). */
  currentMessageItemId: string | undefined;
  readonly sessionFileRef: Ref.Ref<string | undefined>;
  readonly sessionIdRef: Ref.Ref<string | undefined>;
  readonly turnBoundariesRef: Ref.Ref<readonly string[]>;
  readonly lastBoundaryRef: Ref.Ref<string | undefined>;
  /** Extension dialogs awaiting a response (select/confirm). */
  readonly pendingUiRequests: Map<ApprovalRequestId, PiUiRequest>;
  /** One-shot: the next `agent_settled` follows an `abort` and must not
   *  close the turn or record a boundary. */
  readonly suppressNextSettled: Ref.Ref<boolean>;
  /** One-shot guard flipped by stop / unexpected exit. */
  readonly stopped: Ref.Ref<boolean>;
  /** Boundary-recording jobs, serialized by a single worker fiber. */
  readonly boundaryJobs: Queue.Queue<void>;
}

type PiUiRequest =
  | {
      readonly method: "select";
      readonly id: ApprovalRequestId;
      readonly options: ReadonlyArray<string>;
    }
  | { readonly method: "confirm"; readonly id: ApprovalRequestId };

export interface PiAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

interface PiEventTranslationInput {
  readonly threadId: ThreadId;
  readonly activeTurnId: TurnId | undefined;
  /** Current assistant message item id (set by message_start). */
  readonly messageItemId: string | undefined;
  /** `agent_settled` following an abort — swallow turn completion. */
  readonly suppressSettled: boolean;
}

export interface PiMappedEvent {
  readonly type: ProviderRuntimeEvent["type"];
  readonly payload: ProviderRuntimeEvent["payload"];
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
}

function piToolItemType(
  toolName: string,
): "command_execution" | "file_change" | "dynamic_tool_call" {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (normalized.includes("edit")) {
    return "file_change";
  }
  return "dynamic_tool_call";
}

function piTextContent(message: Record<string, unknown> | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: Array<string> = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) {
      continue;
    }
    const record = part as Record<string, unknown>;
    const text = record.type === "text" || record.type === "thinking" ? record.text : undefined;
    if (typeof text === "string" && text.length > 0) {
      parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Pure event translation: one parsed pi stdout event → T3 runtime-event
 * descriptors. Table-driven, ignore-by-default. `PiUiRequest` handling
 * (extension_ui_request) lives in the pump — it needs to write responses.
 */
export function mapPiEvent(
  event: PiRpcEvent,
  input: PiEventTranslationInput,
): ReadonlyArray<PiMappedEvent> {
  const base = {
    turnId: input.activeTurnId,
  } as const;

  switch (event.type) {
    case "agent_settled": {
      if (input.suppressSettled || input.activeTurnId === undefined) {
        return [];
      }
      return [
        {
          ...base,
          type: "turn.completed",
          payload: { state: "completed" },
        },
      ];
    }

    case "message_start": {
      const message = (event.message ?? {}) as Record<string, unknown>;
      // Only assistant-role messages become timeline items (user echoes and
      // toolResult messages are owned by their tool items).
      if (message.role !== "assistant") {
        return [];
      }
      return [
        {
          ...base,
          itemId: input.messageItemId,
          type: "item.started",
          payload: {
            itemType: "assistant_message",
            status: "inProgress",
            title: "Assistant message",
            ...(piTextContent(message) ? { detail: piTextContent(message) } : {}),
            data: event,
          },
        },
      ];
    }

    case "message_end": {
      const message = (event.message ?? {}) as Record<string, unknown>;
      if (message.role !== "assistant") {
        return [];
      }
      return [
        {
          ...base,
          itemId: input.messageItemId,
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            ...(piTextContent(message) ? { detail: piTextContent(message) } : {}),
            data: event,
          },
        },
      ];
    }

    case "message_update": {
      const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
      // Deltas outside an assistant-role message (toolResult echoes, user
      // echoes) have no timeline item to attach to.
      if (input.messageItemId === undefined) {
        return [];
      }
      if (!assistantEvent || typeof assistantEvent.type !== "string") {
        return [];
      }
      switch (assistantEvent.type) {
        case "text_delta": {
          const delta = assistantEvent.delta;
          if (typeof delta !== "string" || delta.length === 0) {
            return [];
          }
          return [
            {
              ...base,
              itemId: input.messageItemId,
              type: "content.delta",
              payload: { streamKind: "assistant_text", delta },
            },
          ];
        }
        case "thinking_delta": {
          const delta = assistantEvent.delta;
          if (typeof delta !== "string" || delta.length === 0) {
            return [];
          }
          return [
            {
              ...base,
              itemId: input.messageItemId,
              type: "content.delta",
              payload: { streamKind: "reasoning_text", delta },
            },
          ];
        }
        case "done": {
          return [
            {
              ...base,
              itemId: input.messageItemId,
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "completed",
                title: "Assistant message",
              },
            },
          ];
        }
        case "error": {
          const reason =
            typeof assistantEvent.reason === "string" ? assistantEvent.reason : "error";
          return [
            {
              ...base,
              itemId: input.messageItemId,
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "failed",
                title: "Assistant message",
                ...(reason.length > 0 ? { detail: reason } : {}),
              },
            },
          ];
        }
        default:
          // toolcall_start/delta/end deltas: `tool_execution_*` events own
          // the tool item lifecycle, so the deltas are dropped (#44).
          return [];
      }
    }

    case "tool_execution_start": {
      const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
      const args = event.args;
      return [
        {
          ...base,
          itemId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
          type: "item.started",
          payload: {
            itemType: piToolItemType(toolName),
            status: "inProgress",
            title: toolName,
            ...(typeof args === "object" &&
            args !== null &&
            "command" in args &&
            typeof (args as Record<string, unknown>).command === "string"
              ? { detail: String((args as Record<string, unknown>).command) }
              : {}),
            data: { tool: toolName, args },
          },
        },
      ];
    }

    case "tool_execution_update": {
      // pi's update events carry only toolCallId/toolName/args — the same
      // fields the start event already delivered, with no progress payload.
      // The item lifecycle is start → completed; emitting item.updated here
      // would spam the work log with empty "Tool updated" rows (#50).
      return [];
    }

    case "tool_execution_end": {
      const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
      const result = event.result as Record<string, unknown> | undefined;
      const resultText = piTextContent(result);
      return [
        {
          ...base,
          itemId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
          type: "item.completed",
          payload: {
            itemType: piToolItemType(toolName),
            status: event.isError === true ? "failed" : "completed",
            title: toolName,
            ...(resultText ? { detail: resultText } : {}),
            data: { tool: toolName, result },
          },
        },
      ];
    }

    case "compaction_start": {
      return [
        {
          ...base,
          type: "item.started",
          payload: {
            itemType: "context_compaction",
            status: "inProgress",
            title: "Compacting context",
            ...(typeof event.reason === "string" ? { detail: event.reason } : {}),
            data: event,
          },
        },
      ];
    }

    case "compaction_end": {
      const result = event.result as Record<string, unknown> | undefined;
      const summary = result?.summary;
      return [
        {
          ...base,
          type: "item.completed",
          payload: {
            itemType: "context_compaction",
            status: "completed",
            title: "Context compaction",
            ...(typeof summary === "string" && summary.length > 0 ? { detail: summary } : {}),
            data: event,
          },
        },
      ];
    }

    case "auto_retry_start": {
      const attempt = event.attempt;
      const delayMs = event.delayMs;
      const errorMessage = typeof event.errorMessage === "string" ? event.errorMessage : undefined;
      return [
        {
          ...base,
          type: "runtime.warning",
          payload: {
            message:
              `Pi auto-retry ${typeof attempt === "number" ? `#${attempt}` : ""}` +
              (typeof delayMs === "number" ? ` in ${delayMs}ms` : "") +
              (errorMessage ? `: ${errorMessage}` : "."),
          },
        },
      ];
    }

    case "auto_retry_end": {
      if (event.success === true) {
        return [];
      }
      const finalError = typeof event.finalError === "string" ? event.finalError : undefined;
      return [
        {
          ...base,
          type: "runtime.warning",
          payload: {
            message: `Pi auto-retry exhausted${finalError ? `: ${finalError}` : "."}`,
          },
        },
      ];
    }

    case "extension_error": {
      const error = typeof event.error === "string" ? event.error : "unknown error";
      const extensionPath =
        typeof event.extensionPath === "string" ? event.extensionPath : undefined;
      return [
        {
          ...base,
          type: "runtime.warning",
          payload: {
            message: `Pi extension error${extensionPath ? ` (${extensionPath})` : ""}: ${error}`,
          },
        },
      ];
    }

    default:
      return [];
  }
}

/** Map a `select`/`confirm` extension dialog onto T3 user-input questions. */
export function piUiRequestToQuestions(
  request: Extract<PiUiRequest, { method: "select" }>,
): ReadonlyArray<UserInputQuestion> {
  return [
    {
      id: request.id,
      header: "Pi extension",
      question: request.options.length > 0 ? "Select an option" : "Pi extension request",
      options: request.options.map((option) => ({ label: option, description: option })),
      multiSelect: false,
    },
  ];
}

function mapPiRequestError(method: string, error: unknown): ProviderAdapterError {
  if (isPiRequestError(error) || isPiValidationError(error)) {
    return error;
  }
  const detail =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.trim()
      : "pi request failed.";
  return new ProviderAdapterRequestError({ provider: PROVIDER, method, detail, cause: error });
}

const maxStderrLine = (line: string): string =>
  line.length > 2000 ? `${line.slice(0, 2000)}…` : line;

/**
 * pi prints informational notices to stderr that are not session warnings:
 * the one-time "creating a new session" notice per thread, and the startup
 * catalog probe that warns about configured-but-unavailable model patterns
 * (the active `--model` is unaffected). Surface real failures, not these.
 */
const BENIGN_PI_STDERR_PREFIXES = [
  "Warning: No project session found with id ",
  "Warning: No models match pattern ",
] as const;

function isBenignPiStderrLine(line: string): boolean {
  return BENIGN_PI_STDERR_PREFIXES.some((prefix) => line.startsWith(prefix));
}

export { isBenignPiStderrLine };

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  piSettings: PiSettings,
  options?: PiAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
      : undefined);
  const managedNativeEventLogger =
    options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
  const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, PiAdapterSessionContext>();
  const processEnv = options?.environment ?? process.env;
  const sessionEnvironment: NodeJS.ProcessEnv = {
    ...processEnv,
    ...piApiKeyEnvironment(piSettings),
  };

  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Pi runtime identifier.",
          cause,
        }),
    ),
  );

  const buildEventBase = (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId | undefined;
    readonly itemId?: string | undefined;
    readonly requestId?: string | undefined;
    readonly raw?: unknown;
  }) =>
    Effect.all({
      eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
      createdAt: nowIso,
    }).pipe(
      Effect.map(({ eventId, createdAt }) => ({
        eventId,
        provider: PROVIDER,
        ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : {}),
        threadId: input.threadId,
        createdAt,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
        ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
        ...(input.raw !== undefined
          ? {
              raw: {
                source: "pi.rpc.event" as const,
                method:
                  typeof input.raw === "object" &&
                  input.raw !== null &&
                  "type" in input.raw &&
                  typeof (input.raw as { type?: unknown }).type === "string"
                    ? String((input.raw as { type: string }).type)
                    : undefined,
                payload: input.raw,
              },
            }
          : {}),
      })),
    );

  const emit = (event: ProviderRuntimeEvent) =>
    Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

  const writeNativeEventBestEffort = (
    threadId: ThreadId,
    event: { readonly observedAt: string; readonly event: Record<string, unknown> },
  ) =>
    (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void).pipe(
      Effect.catchCause(() => Effect.void),
    );

  // Layer-level finalizer: adapter shutdown stops every session.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const contexts = [...sessions.values()];
      sessions.clear();
      yield* Effect.forEach(
        contexts,
        (context) => Effect.ignoreCause(stopSessionInternal(context)),
        { concurrency: "unbounded", discard: true },
      );
      if (managedNativeEventLogger !== undefined) {
        yield* managedNativeEventLogger.close();
      }
    }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
  );

  const updateSession = (
    context: PiAdapterSessionContext,
    patch: Partial<ProviderSession>,
    options?: { readonly clearActiveTurnId?: boolean; readonly clearLastError?: boolean },
  ): Effect.Effect<ProviderSession> =>
    Effect.gen(function* () {
      const updatedAt = yield* nowIso;
      const nextSession = { ...context.session, ...patch, updatedAt } as ProviderSession &
        Record<string, unknown>;
      const mutable = nextSession as Record<string, unknown>;
      if (options?.clearActiveTurnId) {
        delete mutable.activeTurnId;
      }
      if (options?.clearLastError) {
        delete mutable.lastError;
      }
      context.session = nextSession;
      return nextSession;
    });

  const buildResumeCursor = Effect.fn("buildResumeCursor")(function* (
    context: PiAdapterSessionContext,
  ): Effect.fn.Return<PiResumeCursor | undefined, never, never> {
    const sessionFile = yield* Ref.get(context.sessionFileRef);
    if (!sessionFile) {
      return undefined;
    }
    const [sessionId, turnBoundaries] = yield* Effect.all([
      Ref.get(context.sessionIdRef),
      Ref.get(context.turnBoundariesRef),
    ]);
    return {
      schemaVersion: PI_RESUME_SCHEMA_VERSION,
      sessionFile,
      ...(sessionId ? { sessionId } : {}),
      ...(turnBoundaries.length > 0 ? { turnBoundaries: [...turnBoundaries] } : {}),
    };
  });

  const syncSessionCursor = Effect.fn("syncSessionCursor")(function* (
    context: PiAdapterSessionContext,
  ) {
    const cursor = yield* buildResumeCursor(context);
    if (cursor === undefined) {
      return;
    }
    context.session = { ...context.session, resumeCursor: cursor };
  });

  const recordTurnBoundary = Effect.fn("recordTurnBoundary")(function* (
    context: PiAdapterSessionContext,
  ) {
    // One bounded round trip per settled turn (#52): the new leaf id is the
    // durable cursor for the entries scan of the NEXT boundary — and the
    // fork target scan of rollback.
    const since = yield* Ref.get(context.lastBoundaryRef);
    const response = yield* context.client
      .send({ type: "get_entries", ...(since ? { since } : {}) })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "get_entries",
              detail: cause.detail,
              cause,
            }),
        ),
      );
    const data = response.data as { readonly leafId?: unknown } | undefined;
    const leafId = typeof data?.leafId === "string" ? data.leafId : undefined;
    if (!leafId || leafId === since) {
      return;
    }
    yield* Ref.set(context.lastBoundaryRef, leafId);
    yield* Ref.update(context.turnBoundariesRef, (boundaries) => [...boundaries, leafId]);
    yield* syncSessionCursor(context);
  });

  const startBoundaryRecorder = Effect.fn("startBoundaryRecorder")(function* (
    context: PiAdapterSessionContext,
  ) {
    yield* Stream.fromQueue(context.boundaryJobs).pipe(
      Stream.runForEach(() =>
        recordTurnBoundary(context).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to record pi turn boundary", {
              threadId: context.threadId,
              detail: error.message,
            }),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  });

  const handleUiRequest = Effect.fn("handleUiRequest")(function* (
    context: PiAdapterSessionContext,
    event: PiRpcEvent,
  ) {
    const id = typeof event.id === "string" ? event.id : undefined;
    if (!id) {
      return;
    }
    const requestId = ApprovalRequestId.make(id);
    const method = event.method;
    const writeResponse = (payload: Record<string, unknown>) =>
      context.client.send({ type: "extension_ui_response", id, ...payload }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "extension_ui_response",
              detail: cause.detail,
              cause,
            }),
        ),
      );

    if (method === "select") {
      const options = Array.isArray(event.options)
        ? event.options.filter((option): option is string => typeof option === "string")
        : [];
      const request: Extract<PiUiRequest, { method: "select" }> = {
        method: "select",
        id: requestId,
        options,
      };
      context.pendingUiRequests.set(requestId, request);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.threadId,
          turnId: context.activeTurnId,
          requestId,
          raw: event,
        })),
        type: "user-input.requested",
        payload: {
          questions: piUiRequestToQuestions(request),
        },
      });
      return;
    }

    if (method === "confirm") {
      const request: Extract<PiUiRequest, { method: "confirm" }> = {
        method: "confirm",
        id: requestId,
      };
      context.pendingUiRequests.set(requestId, request);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.threadId,
          turnId: context.activeTurnId,
          requestId,
          raw: event,
        })),
        type: "user-input.requested",
        payload: {
          questions: [
            {
              id: requestId,
              header: "Pi extension",
              question: typeof event.title === "string" ? event.title : "Confirm",
              options: [
                { label: "Yes", description: "Confirm" },
                { label: "No", description: "Cancel" },
              ],
              multiSelect: false,
            },
          ],
        },
      });
      return;
    }

    if (method === "input" || method === "editor") {
      // Free-form dialogs don't fit T3's options-only user-input contract
      // (#44): decline so the extension falls back to its default value.
      yield* writeResponse({ cancelled: true }).pipe(Effect.ignore);
      yield* Effect.logDebug("Declined pi extension dialog", { method, id });
      return;
    }

    // Fire-and-forget UI methods (notify, setStatus, setWidget, setTitle,
    // set_editor_text): nothing to render in T3's chat — drop.
    yield* Effect.logDebug("Ignoring pi extension UI request", { method, id });
  });

  const handlePiEvent = Effect.fn("handlePiEvent")(function* (
    context: PiAdapterSessionContext,
    event: PiRpcEvent,
  ) {
    yield* writeNativeEventBestEffort(context.threadId, {
      observedAt: yield* nowIso,
      event,
    });

    if (event.type === "extension_ui_request") {
      yield* handleUiRequest(context, event);
      return;
    }

    if (event.type === "message_start") {
      // pi messages carry no ids of their own; mint one so message_start →
      // message_end items correlate as one T3 item. The id stays until the
      // next message_start overwrites it. Only assistant-role messages become
      // timeline items: user echoes and `role: "toolResult"` messages (tool
      // outputs) belong to the tool item the `tool_execution_*` events own.
      const role =
        event.message !== null && typeof event.message === "object"
          ? (event.message as Record<string, unknown>).role
          : undefined;
      if (role !== "assistant") {
        context.currentMessageItemId = undefined;
      } else {
        context.currentMessageItemId = yield* randomUUIDv4;
      }
    }

    if (event.type === "agent_settled") {
      const suppressed = yield* Ref.getAndSet(context.suppressNextSettled, false);
      if (!suppressed && context.activeTurnId !== undefined) {
        const turnId = context.activeTurnId;
        context.activeTurnId = undefined;
        yield* emit({
          ...(yield* buildEventBase({ threadId: context.threadId, turnId, raw: event })),
          type: "turn.completed",
          payload: { state: "completed" },
        });
        yield* Queue.offer(context.boundaryJobs, void 0);
      }
      return;
    }

    const mapped = mapPiEvent(event, {
      threadId: context.threadId,
      activeTurnId: context.activeTurnId,
      messageItemId: context.currentMessageItemId,
      suppressSettled: false,
    });
    for (const mappedEvent of mapped) {
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.threadId,
          ...(mappedEvent.turnId ? { turnId: mappedEvent.turnId } : {}),
          ...(mappedEvent.itemId ? { itemId: mappedEvent.itemId } : {}),
          ...(mappedEvent.requestId ? { requestId: mappedEvent.requestId } : {}),
          raw: event,
        })),
        type: mappedEvent.type,
        payload: mappedEvent.payload,
      } as ProviderRuntimeEvent);
    }
    if (mapped.length === 0) {
      yield* Effect.logDebug("Ignoring unhandled pi event", {
        type: event.type,
        threadId: context.threadId,
      });
    }
  });

  const startSessionPump = Effect.fn("startSessionPump")(function* (
    context: PiAdapterSessionContext,
  ) {
    yield* Stream.fromQueue(context.client.events).pipe(
      Stream.runForEach((event) =>
        handlePiEvent(context, event).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Pi event handling failed", {
              threadId: context.threadId,
              detail: error.message,
            }),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  });

  const startExitWatcher = Effect.fn("startExitWatcher")(function* (
    context: PiAdapterSessionContext,
  ) {
    // The exit watcher observes the child's exit code. Intentional stops
    // flip `stopped` before closing the scope, so the watcher no-ops.
    yield* context.child.exitCode
      .pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            if (yield* Ref.getAndSet(context.stopped, true)) {
              return;
            }
            sessions.delete(context.threadId);
            const turnId = context.activeTurnId;
            context.activeTurnId = undefined;
            const message = `Pi process exited unexpectedly (code ${Number(code)}).`;
            if (turnId !== undefined) {
              yield* emit({
                ...(yield* buildEventBase({ threadId: context.threadId, turnId })),
                type: "runtime.error",
                payload: {
                  message,
                  class: "transport_error",
                },
              }).pipe(Effect.ignore);
              yield* emit({
                ...(yield* buildEventBase({ threadId: context.threadId, turnId })),
                type: "turn.completed",
                payload: {
                  state: "failed",
                  errorMessage: "Pi exited mid-turn.",
                },
              }).pipe(Effect.ignore);
            }
            yield* emit({
              ...(yield* buildEventBase({ threadId: context.threadId })),
              type: "session.exited",
              payload: {
                reason: message,
                recoverable: true,
                exitKind: "error",
              },
            }).pipe(Effect.ignore);
            // Fail any command in flight so its caller observes the death
            // instead of hanging until the command timeout.
            yield* context.client.failPending("Pi process exited.").pipe(Effect.ignore);
            yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
          }),
        ),
      )
      .pipe(Effect.forkScoped);
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    context: PiAdapterSessionContext,
  ) {
    if (yield* Ref.getAndSet(context.stopped, true)) {
      return;
    }
    sessions.delete(context.threadId);
    // Best-effort remote abort, then local teardown. Scope close kills the
    // child and interrupts the pump/exit/stderr/boundary fibers; the RPC
    // client's own scope finalizer fails any command still pending.
    yield* context.client.send({ type: "abort" }).pipe(Effect.ignore({ log: true }));
    yield* context.client.stop.pipe(Effect.ignore);
    yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
  });

  const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const context = sessions.get(threadId);
      if (!context) {
        return;
      }
      yield* stopSessionInternal(context);
    });

  const requireSession = Effect.fn("requireSession")(function* (threadId: ThreadId) {
    const context = sessions.get(threadId);
    if (!context) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "requireSession",
        issue: `No active pi session for thread '${threadId}'.`,
      });
    }
    if (yield* Ref.get(context.stopped)) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "requireSession",
        issue: `Pi session for thread '${threadId}' is closed.`,
      });
    }
    return context;
  });

  const piSessionDirectory = Effect.fn("piSessionDirectory")(function* (cwd: string) {
    const digest = yield* crypto.digest("SHA-1", new TextEncoder().encode(cwd)).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: "unknown",
            detail: `Failed to hash pi session directory for '${cwd}'.`,
            cause,
          }),
      ),
    );
    const hash = Buffer.from(digest).toString("hex").slice(0, 12);
    const sessionDir = path.join(serverConfig.stateDir, "pi", "sessions", hash);
    yield* fileSystem.makeDirectory(sessionDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: "unknown",
            detail: `Failed to create pi session directory '${sessionDir}'.`,
            cause,
          }),
      ),
    );
    return sessionDir;
  });

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.logInfo("pi adapter startSession enter", {
          threadId: input.threadId,
          hasCursor: input.resumeCursor !== undefined,
          model: input.modelSelection?.model,
        });
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        if (
          input.modelSelection !== undefined &&
          input.modelSelection.instanceId !== boundInstanceId
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Pi model selection is bound to instance '${input.modelSelection.instanceId}', expected '${boundInstanceId}'.`,
          });
        }

        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopSessionInternal(existing);
        }

        const cwd = input.cwd ?? serverConfig.cwd;
        const resumeCursor = isPiResumeCursor(input.resumeCursor) ? input.resumeCursor : undefined;
        const modelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const sessionDir = yield* piSessionDirectory(cwd);
        yield* Effect.logInfo("pi adapter session dir ready", {
          threadId: input.threadId,
          sessionDir,
        });
        const launchArgs = resolvePiLaunchArgs({
          threadId: input.threadId,
          sessionDir,
          resumeCursor,
          model: modelSelection?.model,
          thinkingLevel: getModelSelectionStringOptionValue(modelSelection, "thinkingLevel"),
          launchArgs: piSettings.launchArgs,
        });

        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );

        const spawnFailure = (detail: string, cause: unknown) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail,
            cause,
          });

        const child = yield* childProcessSpawner
          .spawn(
            ChildProcess.make(piSettings.binaryPath, [...launchArgs], {
              cwd,
              env: sessionEnvironment,
              extendEnv: false,
              // Commands are written with per-command `Stream.run` into the
              // stdin sink; the spawner's default `endOnDone: true` would end
              // stdin after the first write, and pi exits on stdin EOF.
              stdin: { stream: "pipe", endOnDone: false },
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError((cause) =>
              spawnFailure(
                `Failed to spawn pi process '${piSettings.binaryPath}': ${cause.message}`,
                cause,
              ),
            ),
          );
        yield* Effect.logInfo("pi adapter spawned", { threadId: input.threadId });

        const client = yield* makePiRpcClient({ child }).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.provideService(Crypto.Crypto, crypto),
        );

        const teardown = Effect.gen(function* () {
          yield* client.stop.pipe(Effect.ignore);
          yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
        });

        // Queue modes pinned once at spawn (#47): the defaults are not stable
        // across pi versions. Best-effort — a failed pin only changes queue
        // semantics, never the session's viability.
        yield* client
          .send({ type: "set_steering_mode", mode: "one-at-a-time" })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Failed to pin pi steering mode", { detail: cause.detail }),
            ),
          );
        yield* client
          .send({ type: "set_follow_up_mode", mode: "one-at-a-time" })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Failed to pin pi follow-up mode", { detail: cause.detail }),
            ),
          );

        const state = yield* client.send({ type: "get_state" }).pipe(
          Effect.mapError((cause) =>
            spawnFailure(`Failed to query pi session state: ${cause.detail}`, cause),
          ),
          Effect.onError(() => teardown),
        );
        const stateData = (state.data ?? {}) as Record<string, unknown>;
        const stateSessionFile =
          typeof stateData.sessionFile === "string" ? stateData.sessionFile : undefined;
        const stateSessionId =
          typeof stateData.sessionId === "string" ? stateData.sessionId : undefined;
        const initialBoundaries = resumeCursor?.turnBoundaries ?? [];
        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : {}),
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(cwd ? { cwd } : {}),
          ...(modelSelection ? { model: modelSelection.model } : {}),
          threadId: input.threadId,
          createdAt,
          updatedAt: createdAt,
        };

        const boundaryJobs = yield* Queue.unbounded<void>();
        const context: PiAdapterSessionContext = {
          threadId: input.threadId,
          child,
          client,
          sessionScope,
          session,
          activeTurnId: undefined,
          currentMessageItemId: undefined,
          sessionFileRef: yield* Ref.make(stateSessionFile ?? resumeCursor?.sessionFile),
          sessionIdRef: yield* Ref.make(stateSessionId ?? resumeCursor?.sessionId),
          turnBoundariesRef: yield* Ref.make<readonly string[]>([...initialBoundaries]),
          lastBoundaryRef: yield* Ref.make(
            initialBoundaries.length > 0
              ? initialBoundaries[initialBoundaries.length - 1]
              : undefined,
          ),
          pendingUiRequests: new Map(),
          suppressNextSettled: yield* Ref.make(false),
          stopped: yield* Ref.make(false),
          boundaryJobs,
        };
        yield* syncSessionCursor(context);

        yield* startSessionPump(context).pipe(Effect.provideService(Scope.Scope, sessionScope));
        yield* startBoundaryRecorder(context).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
        );
        yield* startExitWatcher(context).pipe(Effect.provideService(Scope.Scope, sessionScope));
        yield* startStderrWatcher(context).pipe(Effect.provideService(Scope.Scope, sessionScope));

        sessions.set(input.threadId, context);
        sessionScopeTransferred = true;

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "Pi session started",
            ...(stateSessionFile
              ? {
                  resume: {
                    sessionFile: stateSessionFile,
                    ...(stateSessionId ? { sessionId: stateSessionId } : {}),
                  },
                }
              : {}),
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: stateSessionId ? { providerThreadId: stateSessionId } : {},
        });

        return context.session;
      }),
    );

  const startStderrWatcher = Effect.fn("startStderrWatcher")(function* (
    context: PiAdapterSessionContext,
  ) {
    yield* context.child.stderr.pipe(
      Stream.decodeText(),
      Stream.mapAccum(
        () => "",
        (carry, chunk) => {
          const combined = carry + chunk;
          const parts = combined.split("\n");
          const remainder = parts.pop() ?? "";
          return [remainder, parts] as [string, string[]];
        },
      ),
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          const trimmed = line.trim();
          if (trimmed.length === 0 || isBenignPiStderrLine(trimmed)) {
            return;
          }
          yield* emit({
            ...(yield* buildEventBase({ threadId: context.threadId })),
            type: "runtime.warning",
            payload: { message: maxStderrLine(trimmed) },
          }).pipe(Effect.ignore);
        }),
      ),
      Effect.forkScoped,
    );
  });

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = Effect.fn("sendTurn")(
    function* (input: ProviderSendTurnInput) {
      const context = yield* requireSession(input.threadId);
      // A sendTurn while a turn is active is a steer: pi queues the message
      // into the busy session and the work continues as one turn, so the
      // active turn id is reused instead of opening a new one.
      const steeringTurnId = context.activeTurnId;
      const turnId = steeringTurnId ?? TurnId.make(`pi-turn-${yield* randomUUIDv4}`);
      const modelSelection =
        input.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Pi model selection is bound to instance '${modelSelection.instanceId}', expected '${boundInstanceId}'.`,
        });
      }

      const text = input.input?.trim();
      const images = yield* Effect.forEach(
        input.attachments ?? [],
        (attachment) => resolvePiImage(input, attachment),
        { concurrency: 1 },
      );
      if ((!text || text.length === 0) && images.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Pi turns require text input or at least one attachment.",
        });
      }

      // Mid-thread model switch: `set_model` applies on the next turn with
      // no session restart (#46/#48). A rejected switch surfaces a notice
      // and the turn proceeds on the old model.
      if (
        modelSelection !== undefined &&
        context.session.model !== undefined &&
        modelSelection.model !== context.session.model
      ) {
        const parsed = splitPiModelSlug(modelSelection.model);
        yield* context.client
          .send({
            type: "set_model",
            ...(parsed.provider ? { provider: parsed.provider } : {}),
            modelId: parsed.modelId,
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.gen(function* () {
                yield* emit({
                  ...(yield* buildEventBase({
                    threadId: input.threadId,
                    turnId,
                  })),
                  type: "runtime.warning",
                  payload: {
                    message: `Pi could not switch to model '${modelSelection.model}': ${cause.detail}. The previous model stays active.`,
                  },
                }).pipe(Effect.ignore);
              }),
            ),
          );
      }

      context.activeTurnId = turnId;
      yield* updateSession(
        context,
        {
          status: "running",
          activeTurnId: turnId,
          ...(modelSelection ? { model: modelSelection.model } : {}),
        },
        { clearLastError: true },
      );

      if (steeringTurnId === undefined) {
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
          type: "turn.started",
          payload: modelSelection ? { model: modelSelection.model } : {},
        });
      }

      const command = {
        type: steeringTurnId === undefined ? ("prompt" as const) : ("steer" as const),
        ...(text ? { message: text } : {}),
        ...(images.length > 0 ? { images } : {}),
      };
      yield* context.client.send(command).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: command.type,
              detail: cause.detail,
              cause,
            }),
        ),
        // On failure of a fresh turn: clear active-turn state, flip the
        // session back to ready with lastError set, emit turn.aborted, then
        // propagate the typed error. A failed steer leaves the still-running
        // original turn untouched.
        Effect.tapError((requestError) =>
          steeringTurnId !== undefined
            ? Effect.void
            : Effect.gen(function* () {
                context.activeTurnId = undefined;
                yield* updateSession(
                  context,
                  {
                    status: "ready",
                    ...(modelSelection ? { model: modelSelection.model } : {}),
                    lastError: requestError.detail,
                  },
                  { clearActiveTurnId: true },
                );
                yield* emit({
                  ...(yield* buildEventBase({
                    threadId: input.threadId,
                    turnId,
                  })),
                  type: "turn.aborted",
                  payload: { reason: requestError.detail },
                });
              }),
        ),
      );

      const cursor = yield* buildResumeCursor(context);
      return {
        threadId: input.threadId,
        turnId,
        ...(cursor ? { resumeCursor: cursor } : {}),
      } satisfies ProviderTurnStartResult;
    },
  );

  const resolvePiImage = Effect.fn("resolvePiImage")(function* (
    input: ProviderSendTurnInput,
    attachment: ChatAttachment,
  ) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }
    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: `Failed to read attachment file: ${cause.message}.`,
            cause,
          }),
      ),
    );
    return {
      type: "image" as const,
      data: Buffer.from(bytes).toString("base64"),
      mimeType: attachment.mimeType,
    };
  });

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
    threadId,
    turnId,
  ) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const activeTurnId = turnId ?? context.activeTurnId;
      // pi's `abort` handler is `agent.abort() + waitForIdle()`, and pi
      // emits `agent_settled` BEFORE the idle-wait resolves, so the settle
      // line always precedes the abort response line. The flag must be
      // armed up front — arming it after the response is always too late.
      if (activeTurnId !== undefined) {
        yield* Ref.set(context.suppressNextSettled, true);
      }
      yield* context.client.send({ type: "abort" }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "abort",
              detail: cause.detail,
              cause,
            }),
        ),
        // If the abort round trip fails (timeout, dead process), a settle
        // that still arrives must be allowed to close the turn again.
        Effect.tapError(() => Ref.set(context.suppressNextSettled, false)),
      );
      if (activeTurnId !== undefined) {
        context.activeTurnId = undefined;
        yield* updateSession(context, { status: "ready" }, { clearActiveTurnId: true });
        // The only turn-end event the orchestration layer consumes is
        // turn.completed — turn.aborted alone would leave the thread stuck
        // in "running". `thread.turn-interrupt-requested` (with the turn id
        // the web client always sends) already marked the turn row
        // interrupted; this closes the session side.
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId: activeTurnId })),
          type: "turn.completed",
          payload: { state: "interrupted", errorMessage: "Interrupted by user." },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId: activeTurnId })),
          type: "turn.aborted",
          payload: { reason: "Interrupted by user." },
        });
      }
    });

  const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
    _threadId,
    _requestId,
    _decision,
  ) =>
    // pi has no tool-permission prompts (#44): the approval machinery is
    // inert for Pi, so there is nothing to respond to. Documented no-op.
    Effect.void;

  const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const request = context.pendingUiRequests.get(requestId);
      if (!request) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "extension_ui_response",
          detail: `Unknown pending pi user-input request: ${requestId}`,
        });
      }
      context.pendingUiRequests.delete(requestId);
      const answer = answers[requestId];
      const selected = Array.isArray(answer) ? answer[0] : answer;
      if (request.method === "select") {
        if (typeof selected !== "string") {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: "Pi select dialogs require exactly one answer.",
          });
        }
        yield* context.client
          .send({ type: "extension_ui_response", id: requestId, value: selected })
          .pipe(Effect.mapError((cause) => mapPiRequestError("extension_ui_response", cause)));
        return;
      }
      const confirmed = selected === "Yes";
      yield* context.client
        .send({ type: "extension_ui_response", id: requestId, confirmed })
        .pipe(Effect.mapError((cause) => mapPiRequestError("extension_ui_response", cause)));
    });

  const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
    Effect.gen(function* () {
      // Pi's session is a resumable model-state cache; T3's event store is
      // the conversation truth (#52 decision 8). No T3 turn structure maps
      // onto the JSONL file, so the snapshot is deliberately empty.
      yield* requireSession(threadId);
      return { threadId, turns: [] };
    });

  const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = Effect.fn(
    "rollbackThread",
  )(function* (threadId: ThreadId, numTurns: number) {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "rollbackThread",
        issue: "numTurns must be an integer >= 1.",
      });
    }

    const context = sessions.get(threadId);
    if (!context) {
      // No pi session bound — nothing to rewind; no-op success (#52
      // decision 8).
      return { threadId, turns: [] };
    }

    const state = yield* context.client
      .send({ type: "get_state" })
      .pipe(Effect.mapError((cause) => mapPiRequestError("thread/rollback", cause)));
    const stateData = (state.data ?? {}) as Record<string, unknown>;
    if (stateData.isStreaming === true) {
      // Mid-turn restore guard (#52 decision 5): fork would silently abort
      // the streaming turn, orphaning the adapter's in-flight translation.
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail: "Pi is still working on a turn. Wait for it to settle before reverting.",
      });
    }

    const boundaries = yield* Ref.get(context.turnBoundariesRef);
    const keptCount = boundaries.length - numTurns;
    if (keptCount < 0) {
      // Unmappable target (#52 decision 7): no boundary list (pre-feature
      // session) or fewer recorded turns than requested. Keep the pi file,
      // complete the revert, warn — the model keeps the discarded turns in
      // context.
      yield* emit({
        ...(yield* buildEventBase({ threadId })),
        type: "runtime.warning",
        payload: {
          message:
            "Pi session was not rewound — the model still has the discarded turns in context.",
        },
      }).pipe(Effect.ignore);
      return { threadId, turns: [] };
    }

    const targetBoundary = keptCount === 0 ? undefined : boundaries[keptCount - 1];
    const entriesResponse = yield* context.client
      .send({
        type: "get_entries",
        ...(targetBoundary ? { since: targetBoundary } : {}),
      })
      .pipe(Effect.mapError((cause) => mapPiRequestError("thread/rollback", cause)));
    const entries = ((entriesResponse.data as { readonly entries?: unknown } | undefined)
      ?.entries ?? []) as ReadonlyArray<Record<string, unknown>>;
    const forkTarget = entries.find(
      (entry) =>
        entry.type === "message" &&
        typeof entry.message === "object" &&
        entry.message !== null &&
        (entry.message as Record<string, unknown>).role === "user",
    );
    if (!forkTarget || typeof forkTarget.id !== "string") {
      // The session leaf is already at the restore point — nothing to
      // rewind.
      return { threadId, turns: [] };
    }

    const forkResponse = yield* context.client
      .send({ type: "fork", entryId: forkTarget.id })
      .pipe(Effect.mapError((cause) => mapPiRequestError("thread/rollback", cause)));
    const forkData = (forkResponse.data ?? {}) as Record<string, unknown>;
    if (forkData.cancelled === true) {
      // Fail loudly (#52 decision 6): a session_before_fork extension
      // handler vetoed the fork — never silently continue.
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail: "Pi refused to rewind: a session_before_fork extension handler cancelled the fork.",
      });
    }

    // Fork rebinds the RPC session in-process to the new file; re-read the
    // durable identity so the cursor points at the forked file from now on.
    const afterFork = yield* context.client
      .send({ type: "get_state" })
      .pipe(Effect.mapError((cause) => mapPiRequestError("thread/rollback", cause)));
    const afterForkData = (afterFork.data ?? {}) as Record<string, unknown>;
    const forkedSessionFile =
      typeof afterForkData.sessionFile === "string" ? afterForkData.sessionFile : undefined;
    if (!forkedSessionFile) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail: "Pi rewound the session but did not report the forked session file.",
      });
    }
    const forkedSessionId =
      typeof afterForkData.sessionId === "string" ? afterForkData.sessionId : undefined;

    yield* Ref.set(context.sessionFileRef, forkedSessionFile);
    yield* Ref.set(context.sessionIdRef, forkedSessionId);
    yield* Ref.set(context.lastBoundaryRef, targetBoundary);
    yield* Ref.set(context.turnBoundariesRef, boundaries.slice(0, keptCount));
    yield* syncSessionCursor(context);

    yield* Effect.logInfo("Rewound pi session via fork", {
      threadId,
      numTurns,
      forkedSessionFile,
    });
    return { threadId, turns: [] };
  });

  const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
    Effect.gen(function* () {
      const result: Array<ProviderSession> = [];
      for (const context of sessions.values()) {
        if (yield* Ref.get(context.stopped)) {
          continue;
        }
        result.push(context.session);
      }
      return result;
    });

  const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (threadId) =>
    Effect.gen(function* () {
      const context = sessions.get(threadId);
      if (!context) {
        return false;
      }
      return !(yield* Ref.get(context.stopped));
    });

  const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), stopSessionInternal, {
      concurrency: 1,
      discard: true,
    }).pipe(Effect.asVoid);

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEvents);
    },
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
