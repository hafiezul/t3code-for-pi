/**
 * OmpAdapter — per-thread `omp --mode rpc` session adapter.
 *
 * Mirrors the Pi adapter's T3-integration architecture (per-thread RPC
 * subprocess, table-driven event translation, session-leaf boundaries in
 * the resume cursor) against OMP's RPC protocol. OMP is pi-lineage but its
 * own protocol surface, per the orchestration mapping ADR (0001):
 *
 *   - settle is `agent_end` with `isTerminal !== false` (no `agent_settled`),
 *     and `prompt` responses carry `data.agentInvoked` (command turns never
 *     enter the agent loop, so they never settle);
 *   - tool approvals surface as `extension_ui_request` `select` dialogs
 *     whose options are exactly `["Approve","Deny"]` — the only live
 *     approval machinery in the repo;
 *   - subagents are observable read-only over `set_subagent_subscription`
 *     and ride T3's generic task activity slot;
 *   - rollback goes through `branch(entryId)`, which forks the session to
 *     a new session file (see docs/internals/omp-provider/checkpoint-restore.md).
 *
 * @module provider/Layers/OmpAdapter
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
  RuntimeTaskId,
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
import { makeOmpRpcClient, type OmpRpcClient, type OmpRpcEvent } from "../ompRuntime.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { makeEventNdjsonLogger, type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import type { OmpSettings } from "@t3tools/contracts";
import type { RuntimeMode } from "@t3tools/contracts";

const PROVIDER = ProviderDriverKind.make("omp");

export const OMP_RESUME_SCHEMA_VERSION = 1 as const;

export const OmpResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(OMP_RESUME_SCHEMA_VERSION),
  sessionFile: Schema.String,
  sessionId: Schema.optional(Schema.String),
  turnBoundaries: Schema.optional(Schema.Array(Schema.String)),
});
export type OmpResumeCursor = typeof OmpResumeCursor.Type;

const isOmpResumeCursorValue = Schema.is(OmpResumeCursor);
const isOmpRequestError = Schema.is(ProviderAdapterRequestError);
const isOmpValidationError = Schema.is(ProviderAdapterValidationError);

export const isOmpResumeCursor = (value: unknown): value is OmpResumeCursor =>
  isOmpResumeCursorValue(value);

/** T3 runtime mode → OMP `--approval-mode` flag (ADR 0001 decision 4). */
export type OmpApprovalMode = "yolo" | "always-ask" | "write";

export function resolveOmpApprovalMode(
  runtimeMode: RuntimeMode | undefined,
): OmpApprovalMode | undefined {
  switch (runtimeMode) {
    case "full-access":
      return "yolo";
    case "approval-required":
      return "always-ask";
    case "auto-accept-edits":
      // The `write` tier's exact prompt surface is unverified (ADR 0001
      // consequences) — the mapping is the design decision, pinned here.
      return "write";
    default:
      // `auto` (and anything unknown): OMP's own default approval mode.
      return undefined;
  }
}

/**
 * Launch argument contract:
 *   - always `--mode rpc --session-dir <dir>` (OMP has no `--session-id`;
 *     a fresh session is created in the session dir);
 *   - resuming a forked session passes `--resume <sessionFile>`;
 *   - `--profile <name>` when the instance has one (per-instance isolation
 *     of auth/sessions/settings/caches);
 *   - deterministic model pinning: `--model provider/model` plus
 *     `--models provider/*` scoped to the chosen provider (a bare
 *     `--model` lets env-var key leaks pick the default model — prototype
 *     NOTES #2);
 *   - `--thinking <level>` for a picked thinking tier;
 *   - `--approval-mode <mode>` from the thread's runtime mode;
 *   - user `launchArgs` tokens appended last.
 */
export const resolveOmpLaunchArgs = (input: {
  readonly cwd: string;
  readonly sessionDir: string;
  readonly resumeCursor: OmpResumeCursor | undefined;
  readonly model: string | undefined;
  /** Picked thinking tier (`off|minimal|low|medium|high|xhigh|max`); absent leaves OMP's default. */
  readonly thinkingLevel?: string | undefined;
  readonly approvalMode: OmpApprovalMode | undefined;
  readonly profile: string;
  /** Path to a `--config` overlay file (per-session overrides, leaving the
   *  user's `config.yml` untouched). Written by the settings-editor slice;
   *  absent until then. */
  readonly configOverlay?: string | undefined;
  readonly launchArgs: string;
}): ReadonlyArray<string> => {
  const args = ["--mode", "rpc", "--session-dir", input.sessionDir, "--cwd", input.cwd];
  const cursor = input.resumeCursor;
  if (cursor?.sessionFile) {
    args.push("--resume", cursor.sessionFile);
  }
  if (input.profile.trim().length > 0) {
    args.push("--profile", input.profile.trim());
  }
  if (input.configOverlay !== undefined && input.configOverlay.length > 0) {
    args.push("--config", input.configOverlay);
  }
  if (input.model !== undefined && input.model.trim().length > 0) {
    args.push("--model", input.model.trim());
    const provider = splitOmpModelSlug(input.model).provider;
    if (provider) {
      args.push("--models", `${provider}/*`);
    }
  }
  if (input.thinkingLevel !== undefined && input.thinkingLevel.length > 0) {
    args.push("--thinking", input.thinkingLevel);
  }
  if (input.approvalMode !== undefined) {
    args.push("--approval-mode", input.approvalMode);
  }
  args.push(...tokenizeCliArgs(input.launchArgs));
  return args;
};

/** First-`/` split of an OMP model slug (`provider`/`modelId`; model ids may contain `/`). */
export function splitOmpModelSlug(slug: string): {
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

const OMP_API_KEY_ENV: ReadonlyArray<{ readonly field: keyof OmpSettings; readonly env: string }> =
  [
    { field: "anthropicApiKey", env: "ANTHROPIC_API_KEY" },
    { field: "openaiApiKey", env: "OPENAI_API_KEY" },
    { field: "geminiApiKey", env: "GEMINI_API_KEY" },
    { field: "groqApiKey", env: "GROQ_API_KEY" },
    { field: "xaiApiKey", env: "XAI_API_KEY" },
  ];

export const ompApiKeyEnvironment = (
  ompSettings: OmpSettings,
): Readonly<Record<string, string>> => {
  const env: Record<string, string> = {};
  for (const entry of OMP_API_KEY_ENV) {
    const value = ompSettings[entry.field];
    if (typeof value === "string" && value.trim().length > 0) {
      env[entry.env] = value;
    }
  }
  return env;
};

interface OmpAdapterSessionContext {
  readonly threadId: ThreadId;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly client: OmpRpcClient;
  /** Sole lifecycle handle for the session: closing it kills the child
   *  process and interrupts the pump/exit/stderr/boundary fibers. */
  readonly sessionScope: Scope.Closeable;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  /** The assistant stream failed during the active turn (OMP's
   *  `message_update` `error`, e.g. an upstream timeout). `agent_end`
   *  carries no outcome, so the turn's terminal state is decided here:
   *  settled + error ⇒ `turn.completed` "failed", never a silent "completed". */
  activeTurnError: string | undefined;
  /** Current assistant message item id, for message_start → message_end
   *  correlation (OMP messages carry no ids of their own). */
  currentMessageItemId: string | undefined;
  readonly sessionFileRef: Ref.Ref<string | undefined>;
  readonly sessionIdRef: Ref.Ref<string | undefined>;
  readonly turnBoundariesRef: Ref.Ref<readonly string[]>;
  /** Extension dialogs awaiting a response (select/confirm/input/editor). */
  readonly pendingUiRequests: Map<ApprovalRequestId, OmpUiRequest>;
  /** Approval dialogs (`select` with exactly ["Approve","Deny"]) awaiting
   *  `thread.approval.respond`. */
  readonly pendingApprovals: Map<ApprovalRequestId, { readonly detail: string }>;
  /** One-shot: the next terminal `agent_end` follows an `abort` and must
   *  not close the turn or record a boundary. */
  readonly suppressNextSettled: Ref.Ref<boolean>;
  /** While true, approval-shaped `select` dialogs are auto-answered
   *  "Deny" without surfacing — the model retries after a Deny, and the
   *  deny-path settle can stall (prototype NOTES #6). Reset per turn. */
  readonly denyPendingSelects: Ref.Ref<boolean>;
  /** Set when the agent loop shows activity after a command prompt's
   *  response — blocks the synthetic command-turn completion. */
  readonly agentActivitySincePromptRef: Ref.Ref<boolean>;
  /** Last thinking level sent to the session, for mid-thread tier switches. */
  readonly lastThinkingLevelRef: Ref.Ref<string | undefined>;
  /** One-shot guard flipped by stop / unexpected exit. */
  readonly stopped: Ref.Ref<boolean>;
  /** Boundary-recording jobs, serialized by a single worker fiber. */
  readonly boundaryJobs: Queue.Queue<void>;
}

type OmpUiRequest =
  | {
      readonly method: "select";
      readonly id: ApprovalRequestId;
      readonly options: ReadonlyArray<string>;
    }
  | { readonly method: "confirm"; readonly id: ApprovalRequestId }
  | { readonly method: "input"; readonly id: ApprovalRequestId }
  | { readonly method: "editor"; readonly id: ApprovalRequestId };

export interface OmpAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  /** Path to a `--config` overlay file for per-session settings (written
   *  by the settings-editor slice; the user's `config.yml` stays
   *  untouched). Absent until then. */
  readonly configOverlay?: string;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

interface OmpEventTranslationInput {
  readonly threadId: ThreadId;
  readonly activeTurnId: TurnId | undefined;
  /** Current assistant message item id (set by message_start). */
  readonly messageItemId: string | undefined;
}

export interface OmpMappedEvent {
  readonly type: ProviderRuntimeEvent["type"];
  readonly payload: ProviderRuntimeEvent["payload"];
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
}

function ompToolItemType(
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

function ompTextContent(
  message: Record<string, unknown> | undefined,
  options?: { readonly includeThinking?: boolean },
): string | undefined {
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
  const includeThinking = options?.includeThinking !== false;
  const parts: Array<string> = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) {
      continue;
    }
    const record = part as Record<string, unknown>;
    if (record.type !== "text" && record.type !== "thinking") {
      continue;
    }
    if (record.type === "thinking" && !includeThinking) {
      continue;
    }
    const text = record.text;
    if (typeof text === "string" && text.length > 0) {
      parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Human-readable cause of an OMP `message_update` `error`. OMP puts the
 * real reason on the failed assistant message (`error.errorMessage`); the
 * event's own `reason` is only the stop category ("error" | "aborted").
 */
function ompAssistantEventErrorMessage(assistantEvent: Record<string, unknown>): string {
  const failedMessage = assistantEvent.error;
  if (typeof failedMessage === "object" && failedMessage !== null) {
    const errorMessage = (failedMessage as Record<string, unknown>).errorMessage;
    if (typeof errorMessage === "string" && errorMessage.trim().length > 0) {
      return errorMessage.trim();
    }
  }
  const reason = assistantEvent.reason;
  return typeof reason === "string" && reason.length > 0 ? reason : "OMP turn failed.";
}

/** Truncate potentially file-content-bearing payload text (subagent
 *  `recentOutput` can hold file contents). */
const scrubSubagentText = (value: unknown, maxLength = 2000): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
};

/**
 * Pure event translation: one parsed OMP stdout event → T3 runtime-event
 * descriptors. Table-driven, ignore-by-default. `agent_end` settle logic,
 * `extension_ui_request` handling, and subagent frames live in the pump —
 * they need mutable session state.
 */
export function mapOmpEvent(
  event: OmpRpcEvent,
  input: OmpEventTranslationInput,
): ReadonlyArray<OmpMappedEvent> {
  const base = {
    turnId: input.activeTurnId,
  } as const;

  switch (event.type) {
    case "message_start": {
      const message = (event.message ?? {}) as Record<string, unknown>;
      // Only assistant-role messages become timeline items (user echoes and
      // toolResult messages are owned by their tool items).
      if (message.role !== "assistant") {
        return [];
      }
      const startedDetail = ompTextContent(message, { includeThinking: false });
      return [
        {
          ...base,
          itemId: input.messageItemId,
          type: "item.started",
          payload: {
            itemType: "assistant_message",
            status: "inProgress",
            title: "Assistant message",
            ...(startedDetail ? { detail: startedDetail } : {}),
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
      const completedDetail = ompTextContent(message, { includeThinking: false });
      return [
        {
          ...base,
          itemId: input.messageItemId,
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            ...(completedDetail ? { detail: completedDetail } : {}),
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
          const reason = ompAssistantEventErrorMessage(assistantEvent);
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
          // the tool item lifecycle, so the deltas are dropped.
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
            itemType: ompToolItemType(toolName),
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

    case "tool_execution_end": {
      const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
      const result = event.result as Record<string, unknown> | undefined;
      const resultText = ompTextContent(result);
      return [
        {
          ...base,
          itemId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
          type: "item.completed",
          payload: {
            itemType: ompToolItemType(toolName),
            status: event.isError === true ? "failed" : "completed",
            title: toolName,
            ...(resultText ? { detail: resultText } : {}),
            data: { tool: toolName, result },
          },
        },
      ];
    }

    case "auto_compaction_start": {
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

    case "auto_compaction_end": {
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

    // Per-assistant turn end is NOT a settle (ADR 0001 decision 1) — the
    // turn stays open until `agent_end` with `isTerminal !== false`.
    case "turn_end": {
      return [];
    }

    default:
      return [];
  }
}

const APPROVAL_OPTIONS: ReadonlyArray<string> = ["Approve", "Deny"];

function isApprovalDialog(options: ReadonlyArray<string>): boolean {
  return (
    options.length === APPROVAL_OPTIONS.length &&
    options.every((option, index) => option === APPROVAL_OPTIONS[index])
  );
}

/** Map a `select`/`confirm` extension dialog onto T3 user-input questions. */
export function ompUiRequestToQuestions(
  request: Extract<OmpUiRequest, { method: "select" }>,
): ReadonlyArray<UserInputQuestion> {
  return [
    {
      id: request.id,
      header: "OMP extension",
      question: request.options.length > 0 ? "Select an option" : "OMP extension request",
      options: request.options.map((option) => ({ label: option, description: option })),
      multiSelect: false,
    },
  ];
}

function mapOmpRequestError(method: string, error: unknown): ProviderAdapterError {
  if (isOmpRequestError(error) || isOmpValidationError(error)) {
    return error;
  }
  const detail =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.trim()
      : "omp request failed.";
  return new ProviderAdapterRequestError({ provider: PROVIDER, method, detail, cause: error });
}

const maxStderrLine = (line: string): string =>
  line.length > 2000 ? `${line.slice(0, 2000)}…` : line;

export const makeOmpAdapter = Effect.fn("makeOmpAdapter")(function* (
  ompSettings: OmpSettings,
  options?: OmpAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("omp");
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
  const sessions = new Map<ThreadId, OmpAdapterSessionContext>();
  const processEnv = options?.environment ?? process.env;
  const sessionEnvironment: NodeJS.ProcessEnv = {
    ...processEnv,
    ...ompApiKeyEnvironment(ompSettings),
  };

  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate OMP runtime identifier.",
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
                source: "omp.rpc.event" as const,
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
    context: OmpAdapterSessionContext,
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
    context: OmpAdapterSessionContext,
  ): Effect.fn.Return<OmpResumeCursor | undefined, never, never> {
    const sessionFile = yield* Ref.get(context.sessionFileRef);
    if (!sessionFile) {
      return undefined;
    }
    const [sessionId, turnBoundaries] = yield* Effect.all([
      Ref.get(context.sessionIdRef),
      Ref.get(context.turnBoundariesRef),
    ]);
    return {
      schemaVersion: OMP_RESUME_SCHEMA_VERSION,
      sessionFile,
      ...(sessionId ? { sessionId } : {}),
      ...(turnBoundaries.length > 0 ? { turnBoundaries: [...turnBoundaries] } : {}),
    };
  });

  const syncSessionCursor = Effect.fn("syncSessionCursor")(function* (
    context: OmpAdapterSessionContext,
  ) {
    const cursor = yield* buildResumeCursor(context);
    if (cursor === undefined) {
      return;
    }
    context.session = { ...context.session, resumeCursor: cursor };
  });

  const recordTurnBoundary = Effect.fn("recordTurnBoundary")(function* (
    context: OmpAdapterSessionContext,
  ) {
    // One bounded round trip per settled turn (checkpoint-restore doc,
    // decision 3): the last user-message entry id of the current branch is
    // the durable restore point for the NEXT rollback.
    const response = yield* context.client.send({ type: "get_branch_messages" }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "get_branch_messages",
            detail: cause.detail,
            cause,
          }),
      ),
    );
    const entries = (response.data as { readonly entries?: unknown } | undefined)?.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      return;
    }
    const lastEntry = entries[entries.length - 1] as Record<string, unknown> | undefined;
    const entryId = typeof lastEntry?.entryId === "string" ? lastEntry.entryId : undefined;
    if (!entryId) {
      return;
    }
    const boundaries = yield* Ref.get(context.turnBoundariesRef);
    if (boundaries[boundaries.length - 1] === entryId) {
      return;
    }
    yield* Ref.set(context.turnBoundariesRef, [...boundaries, entryId]);
    yield* syncSessionCursor(context);
  });

  const startBoundaryRecorder = Effect.fn("startBoundaryRecorder")(function* (
    context: OmpAdapterSessionContext,
  ) {
    yield* Stream.fromQueue(context.boundaryJobs).pipe(
      Stream.runForEach(() =>
        recordTurnBoundary(context).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to record OMP turn boundary", {
              threadId: context.threadId,
              detail: error.message,
            }),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  });

  const answerExtensionUi = (context: OmpAdapterSessionContext, id: string, value: string) =>
    context.client
      .sendFireAndForget({ type: "extension_ui_response", id, value })
      .pipe(Effect.mapError((cause) => mapOmpRequestError("extension_ui_response", cause)));

  const handleUiRequest = Effect.fn("handleUiRequest")(function* (
    context: OmpAdapterSessionContext,
    event: OmpRpcEvent,
  ) {
    const id = typeof event.id === "string" ? event.id : undefined;
    if (!id) {
      return;
    }
    const method = event.method;
    if (method === "cancel") {
      // A cancel frame drops the pending request silently (ADR 0001
      // decision 3): T3's user-input contract has no cancel shape and turn
      // interruption is the way out.
      for (const map of [context.pendingUiRequests, context.pendingApprovals]) {
        for (const requestId of map.keys()) {
          if (requestId === id) {
            map.delete(requestId);
          }
        }
      }
      yield* Effect.logDebug("OMP extension UI request cancelled", { id });
      return;
    }

    if (method === "select") {
      const options = Array.isArray(event.options)
        ? event.options.filter((option): option is string => typeof option === "string")
        : [];
      const requestId = ApprovalRequestId.make(id);
      // ADR 0001 decision 4: a `select` with exactly ["Approve","Deny"] is
      // an approval, not a user-input question.
      if (isApprovalDialog(options)) {
        const detail =
          typeof event.title === "string" && event.title.trim().length > 0
            ? event.title.trim()
            : "Approve tool execution";
        if (yield* Ref.get(context.denyPendingSelects)) {
          // The model retries after a Deny; keep the turn moving instead of
          // surfacing a dialog the user already answered.
          yield* answerExtensionUi(context, id, "Deny").pipe(Effect.ignore);
          return;
        }
        context.pendingApprovals.set(requestId, { detail });
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.threadId,
            turnId: context.activeTurnId,
            requestId,
            raw: event,
          })),
          type: "request.opened",
          payload: {
            requestType: "dynamic_tool_call",
            detail,
          },
        });
        return;
      }
      const request: Extract<OmpUiRequest, { method: "select" }> = {
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
          questions: ompUiRequestToQuestions(request),
        },
      });
      return;
    }

    if (method === "confirm") {
      const requestId = ApprovalRequestId.make(id);
      const request: Extract<OmpUiRequest, { method: "confirm" }> = {
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
              header: "OMP extension",
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
      const requestId = ApprovalRequestId.make(id);
      const request: Extract<OmpUiRequest, { method: "input" | "editor" }> = {
        method,
        id: requestId,
      };
      context.pendingUiRequests.set(requestId, request);
      const title =
        typeof event.title === "string" && event.title.trim().length > 0
          ? event.title.trim()
          : "OMP extension request";
      const placeholder =
        typeof event.placeholder === "string" && event.placeholder.trim().length > 0
          ? event.placeholder.trim()
          : undefined;
      const prefill =
        typeof event.prefill === "string" && event.prefill.trim().length > 0
          ? event.prefill.trim()
          : undefined;
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
              header: "OMP extension",
              question: title,
              options: [],
              multiSelect: false,
              answerKind: method === "input" ? "text" : "editor",
              ...(placeholder !== undefined ? { placeholder } : {}),
              ...(prefill !== undefined ? { initialValue: prefill } : {}),
            },
          ],
        },
      });
      return;
    }

    if (method === "notify") {
      const message =
        typeof event.message === "string" && event.message.trim().length > 0
          ? event.message.trim()
          : "OMP extension notification";
      const noticeType =
        event.notifyType === "warning" || event.notifyType === "error" ? event.notifyType : "info";
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.threadId,
          turnId: context.activeTurnId,
          raw: event,
        })),
        type: "extension.notice",
        payload: { message, noticeType },
      });
      return;
    }

    if (method === "setStatus") {
      const statusKey =
        typeof event.statusKey === "string" && event.statusKey.trim().length > 0
          ? event.statusKey.trim()
          : undefined;
      if (!statusKey) {
        return;
      }
      const statusText =
        typeof event.statusText === "string" && event.statusText.length > 0
          ? event.statusText
          : null;
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.threadId,
          turnId: context.activeTurnId,
          raw: event,
        })),
        type: "extension.status",
        payload: { statusKey, statusText },
      });
      return;
    }

    // Remaining fire-and-forget UI methods (setWidget, setTitle,
    // set_editor_text, open_url): nothing to render in T3's chat — drop
    // (ADR 0001 decision 3; open_url = RPC OAuth login, out of scope).
    yield* Effect.logDebug("Ignoring OMP extension UI request", { method, id });
  });

  const handleSubagentEvent = Effect.fn("handleSubagentEvent")(function* (
    context: OmpAdapterSessionContext,
    event: OmpRpcEvent,
  ) {
    const subagentId = typeof event.id === "string" ? event.id : undefined;
    if (!subagentId) {
      return;
    }
    // Stable task + activity ids per subagent: every progress frame and the
    // terminal frame upsert the SAME row in place.
    const taskIdValue = `subagent:${subagentId}`;
    const taskId = RuntimeTaskId.make(taskIdValue);
    const eventId = EventId.make(taskIdValue);

    if (event.type === "subagent_lifecycle") {
      const state = typeof event.state === "string" ? event.state : undefined;
      if (state === "started") {
        const name = scrubSubagentText(event.name, 120);
        const base = yield* buildEventBase({
          threadId: context.threadId,
          turnId: context.activeTurnId,
        });
        yield* emit({
          ...base,
          eventId,
          type: "task.started",
          payload: {
            taskId,
            taskType: "subagent",
            ...(name ? { description: name } : {}),
          },
        });
        return;
      }
      if (state === "completed" || state === "failed" || state === "aborted") {
        const summary = scrubSubagentText(event.description ?? event.summary, 200);
        const base = yield* buildEventBase({
          threadId: context.threadId,
          turnId: context.activeTurnId,
        });
        yield* emit({
          ...base,
          eventId,
          type: "task.completed",
          payload: {
            taskId,
            taskType: "subagent",
            status: state === "aborted" ? "stopped" : state,
            ...(summary ? { summary } : {}),
          },
        });
        return;
      }
      yield* Effect.logDebug("Ignoring OMP subagent lifecycle state", { subagentId, state });
      return;
    }

    if (event.type === "subagent_progress") {
      // `recentOutput` can hold file contents — scrub before it reaches the
      // activity projection path (spec: subagent surfacing).
      const description = scrubSubagentText(
        event.status ?? event.description ?? "Subagent working",
      );
      const summary = scrubSubagentText(event.recentOutput, 2000);
      const base = yield* buildEventBase({
        threadId: context.threadId,
        turnId: context.activeTurnId,
      });
      yield* emit({
        ...base,
        eventId,
        type: "task.progress",
        payload: {
          taskId,
          taskType: "subagent",
          description: description ?? "Subagent working",
          ...(summary ? { summary } : {}),
        },
      });
      return;
    }
  });

  const handleOmpEvent = Effect.fn("handleOmpEvent")(function* (
    context: OmpAdapterSessionContext,
    event: OmpRpcEvent,
  ) {
    yield* writeNativeEventBestEffort(context.threadId, {
      observedAt: yield* nowIso,
      event,
    });

    // Agent-loop activity after a command prompt's response means the turn
    // is doing real model work — the synthetic command-turn completion in
    // `sendTurn` must not fire.
    if (
      event.type === "agent_end" ||
      (event.type === "message_start" &&
        typeof event.message === "object" &&
        event.message !== null &&
        (event.message as Record<string, unknown>).role === "assistant")
    ) {
      yield* Ref.set(context.agentActivitySincePromptRef, true);
    }

    if (event.type === "extension_ui_request") {
      yield* handleUiRequest(context, event);
      return;
    }

    if (event.type === "subagent_lifecycle" || event.type === "subagent_progress") {
      yield* handleSubagentEvent(context, event);
      return;
    }

    if (event.type === "message_start") {
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

    // Track an assistant-stream failure for the active turn: OMP surfaces
    // it as `message_update` `error` and the terminal `agent_end` carries
    // no outcome, so this is the only place the turn's real result is
    // knowable.
    if (event.type === "message_update") {
      const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
      if (assistantEvent?.type === "error" && context.activeTurnId !== undefined) {
        context.activeTurnError = ompAssistantEventErrorMessage(assistantEvent);
      }
    }

    if (event.type === "agent_end") {
      // `isTerminal: false` (maintenance scheduled more work) keeps the
      // turn open — only `isTerminal !== false` settles (ADR 0001 d.1).
      if (event.isTerminal === false) {
        return;
      }
      const suppressed = yield* Ref.getAndSet(context.suppressNextSettled, false);
      if (!suppressed && context.activeTurnId !== undefined) {
        const turnId = context.activeTurnId;
        context.activeTurnId = undefined;
        const turnError = context.activeTurnError;
        context.activeTurnError = undefined;
        yield* Ref.set(context.denyPendingSelects, false);
        // Reflect the turn outcome on the session: a failed turn leaves
        // status "error" with lastError; a clean settle returns to "ready".
        yield* updateSession(
          context,
          turnError !== undefined ? { status: "error", lastError: turnError } : { status: "ready" },
          turnError !== undefined
            ? { clearActiveTurnId: true }
            : { clearActiveTurnId: true, clearLastError: true },
        );
        yield* emit({
          ...(yield* buildEventBase({ threadId: context.threadId, turnId, raw: event })),
          type: "turn.completed",
          payload:
            turnError !== undefined
              ? { state: "failed", errorMessage: turnError }
              : { state: "completed" },
        });
        yield* Queue.offer(context.boundaryJobs, void 0);
      }
      return;
    }

    const mapped = mapOmpEvent(event, {
      threadId: context.threadId,
      activeTurnId: context.activeTurnId,
      messageItemId: context.currentMessageItemId,
    });
    for (const mappedEvent of mapped) {
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.threadId,
          ...(mappedEvent.turnId ? { turnId: mappedEvent.turnId } : {}),
          ...(mappedEvent.itemId ? { itemId: mappedEvent.itemId } : {}),
          raw: event,
        })),
        type: mappedEvent.type,
        payload: mappedEvent.payload,
      } as ProviderRuntimeEvent);
    }
    if (mapped.length === 0) {
      yield* Effect.logDebug("Ignoring unhandled OMP event", {
        type: event.type,
        threadId: context.threadId,
      });
    }
  });

  const startSessionPump = Effect.fn("startSessionPump")(function* (
    context: OmpAdapterSessionContext,
  ) {
    yield* Stream.fromQueue(context.client.events).pipe(
      Stream.runForEach((event) =>
        handleOmpEvent(context, event).pipe(
          Effect.catch((error) =>
            Effect.logWarning("OMP event handling failed", {
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
    context: OmpAdapterSessionContext,
  ) {
    // The exit watcher observes the child's exit code. Intentional stops
    // flip `stopped` before closing the scope, so the watcher no-ops.
    yield* context.child.exitCode.pipe(
      Effect.flatMap((code) =>
        Effect.gen(function* () {
          if (yield* Ref.getAndSet(context.stopped, true)) {
            return;
          }
          sessions.delete(context.threadId);
          const turnId = context.activeTurnId;
          context.activeTurnId = undefined;
          context.activeTurnError = undefined;
          // Exit 0 is the stdin-EOF graceful path (prototype NOTES #10):
          // omp disposed and exited cleanly on its own. Anything else —
          // 143 is signal death on macOS, other codes are crashes — is an
          // error exit. Either way the live turn is dead and must fail.
          const graceful = Number(code) === 0;
          const message = graceful
            ? "OMP process exited (code 0)."
            : `OMP process exited unexpectedly (code ${Number(code)}).`;
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
                errorMessage: "OMP exited mid-turn.",
              },
            }).pipe(Effect.ignore);
          }
          yield* emit({
            ...(yield* buildEventBase({ threadId: context.threadId })),
            type: "session.exited",
            payload: {
              reason: message,
              recoverable: true,
              exitKind: graceful ? "graceful" : "error",
            },
          }).pipe(Effect.ignore);
          // Fail any command in flight so its caller observes the death
          // instead of hanging until the command timeout.
          yield* context.client.failPending("OMP process exited.").pipe(Effect.ignore);
          yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
        }),
      ),
      Effect.forkScoped,
    );
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    context: OmpAdapterSessionContext,
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
        issue: `No active omp session for thread '${threadId}'.`,
      });
    }
    if (yield* Ref.get(context.stopped)) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "requireSession",
        issue: `OMP session for thread '${threadId}' is closed.`,
      });
    }
    return context;
  });

  const ompSessionDirectory = Effect.fn("ompSessionDirectory")(function* (cwd: string) {
    const digest = yield* crypto.digest("SHA-1", new TextEncoder().encode(cwd)).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: "unknown",
            detail: `Failed to hash omp session directory for '${cwd}'.`,
            cause,
          }),
      ),
    );
    const hash = Buffer.from(digest).toString("hex").slice(0, 12);
    const sessionDir = path.join(serverConfig.stateDir, "omp", "sessions", hash);
    yield* fileSystem.makeDirectory(sessionDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: "unknown",
            detail: `Failed to create omp session directory '${sessionDir}'.`,
            cause,
          }),
      ),
    );
    return sessionDir;
  });

  const setSubagentSubscription = Effect.fn("setSubagentSubscription")(function* (
    context: OmpAdapterSessionContext,
  ) {
    // Best-effort: the subscription only gates subagent visibility, never
    // the session's viability.
    yield* context.client.send({ type: "set_subagent_subscription", level: "progress" }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to subscribe to omp subagents", {
          threadId: context.threadId,
          detail: cause.detail,
        }),
      ),
    );
  });

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.logInfo("omp adapter startSession enter", {
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
            issue: `OMP model selection is bound to instance '${input.modelSelection.instanceId}', expected '${boundInstanceId}'.`,
          });
        }

        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopSessionInternal(existing);
        }

        const cwd = input.cwd ?? serverConfig.cwd;
        const resumeCursor = isOmpResumeCursor(input.resumeCursor) ? input.resumeCursor : undefined;
        const modelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const sessionDir = yield* ompSessionDirectory(cwd);
        yield* Effect.logInfo("omp adapter session dir ready", {
          threadId: input.threadId,
          sessionDir,
        });
        const launchArgs = resolveOmpLaunchArgs({
          cwd,
          sessionDir,
          resumeCursor,
          model: modelSelection?.model,
          thinkingLevel: getModelSelectionStringOptionValue(modelSelection, "thinkingLevel"),
          approvalMode: resolveOmpApprovalMode(input.runtimeMode),
          profile: ompSettings.profile,
          configOverlay: options?.configOverlay,
          launchArgs: ompSettings.launchArgs,
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
            ChildProcess.make(ompSettings.binaryPath, [...launchArgs], {
              cwd,
              env: sessionEnvironment,
              extendEnv: false,
              // Commands are written with per-command `Stream.run` into the
              // stdin sink; the spawner's default `endOnDone: true` would end
              // stdin after the first write, and omp exits on stdin EOF.
              stdin: { stream: "pipe", endOnDone: false },
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError((cause) =>
              spawnFailure(
                `Failed to spawn omp process '${ompSettings.binaryPath}': ${cause.message}`,
                cause,
              ),
            ),
          );
        yield* Effect.logInfo("omp adapter spawned", { threadId: input.threadId });

        const client = yield* makeOmpRpcClient({ child }).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.provideService(Crypto.Crypto, crypto),
        );

        const teardown = Effect.gen(function* () {
          yield* client.stop.pipe(Effect.ignore);
          yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
        });

        const state = yield* client.send({ type: "get_state" }).pipe(
          Effect.mapError((cause) =>
            spawnFailure(`Failed to query omp session state: ${cause.detail}`, cause),
          ),
          Effect.onError(() => teardown),
        );
        const stateData = (state.data ?? {}) as Record<string, unknown>;
        const stateSessionFile =
          typeof stateData.sessionFile === "string" ? stateData.sessionFile : undefined;
        const stateSessionId =
          typeof stateData.sessionId === "string" ? stateData.sessionId : undefined;
        // NOTE: `get_state.sessionFile` is a planned path — the file does
        // not exist until the first write (prototype NOTES #5). Never
        // stat/read it here.
        const initialBoundaries = resumeCursor?.turnBoundaries ?? [];
        const initialThinkingLevel = getModelSelectionStringOptionValue(
          modelSelection,
          "thinkingLevel",
        );
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
        const context: OmpAdapterSessionContext = {
          threadId: input.threadId,
          child,
          client,
          sessionScope,
          session,
          activeTurnId: undefined,
          activeTurnError: undefined,
          currentMessageItemId: undefined,
          sessionFileRef: yield* Ref.make(stateSessionFile ?? resumeCursor?.sessionFile),
          sessionIdRef: yield* Ref.make(stateSessionId ?? resumeCursor?.sessionId),
          turnBoundariesRef: yield* Ref.make<readonly string[]>([...initialBoundaries]),
          pendingUiRequests: new Map(),
          pendingApprovals: new Map(),
          suppressNextSettled: yield* Ref.make(false),
          denyPendingSelects: yield* Ref.make(false),
          agentActivitySincePromptRef: yield* Ref.make(false),
          lastThinkingLevelRef: yield* Ref.make(initialThinkingLevel),
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

        yield* setSubagentSubscription(context);

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "OMP session started",
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
    context: OmpAdapterSessionContext,
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
          if (trimmed.length === 0) {
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
      // A sendTurn while a turn is active is a steer: OMP queues the
      // message into the busy session and the work continues as one turn,
      // so the active turn id is reused instead of opening a new one.
      const steeringTurnId = context.activeTurnId;
      const turnId = steeringTurnId ?? TurnId.make(`omp-turn-${yield* randomUUIDv4}`);
      const modelSelection =
        input.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `OMP model selection is bound to instance '${modelSelection.instanceId}', expected '${boundInstanceId}'.`,
        });
      }

      const text = input.input?.trim();
      const images = yield* Effect.forEach(
        input.attachments ?? [],
        (attachment) => resolveOmpImage(input, attachment),
        { concurrency: 1 },
      );
      if ((!text || text.length === 0) && images.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OMP turns require text input or at least one attachment.",
        });
      }

      // Mid-thread model switch: `set_model` applies on the next turn with
      // no session restart. A rejected switch surfaces a notice and the
      // turn proceeds on the old model — the session keeps the old model
      // (and the turn claims it), so the next turn with the picker still on
      // the new model retries the switch instead of silently dropping it.
      const previousModel = context.session.model;
      let modelSwitchApplied = true;
      if (
        modelSelection !== undefined &&
        previousModel !== undefined &&
        modelSelection.model !== previousModel
      ) {
        const parsed = splitOmpModelSlug(modelSelection.model);
        yield* context.client
          .send({
            type: "set_model",
            ...(parsed.provider ? { provider: parsed.provider } : {}),
            modelId: parsed.modelId,
          })
          .pipe(
            Effect.matchEffect({
              onSuccess: () => Effect.void,
              onFailure: (error) => {
                modelSwitchApplied = false;
                return buildEventBase({
                  threadId: input.threadId,
                  turnId,
                }).pipe(
                  Effect.flatMap((base) =>
                    emit({
                      ...base,
                      type: "runtime.warning",
                      payload: {
                        message: `OMP could not switch to model '${modelSelection.model}': ${error.detail}. The previous model stays active.`,
                      },
                    }),
                  ),
                  Effect.ignore,
                );
              },
            }),
          );
      }

      // Thinking-tier switch: `set_thinking_level` applies on the next turn.
      // On rejection the previous level stays recorded, so a later turn with
      // the same picker tier retries the switch.
      const thinkingLevel = getModelSelectionStringOptionValue(modelSelection, "thinkingLevel");
      const previousThinkingLevel = yield* Ref.get(context.lastThinkingLevelRef);
      let thinkingSwitchApplied = true;
      if (thinkingLevel !== undefined && thinkingLevel !== previousThinkingLevel) {
        yield* context.client.send({ type: "set_thinking_level", level: thinkingLevel }).pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.void,
            onFailure: (error) => {
              thinkingSwitchApplied = false;
              return buildEventBase({
                threadId: input.threadId,
                turnId,
              }).pipe(
                Effect.flatMap((base) =>
                  emit({
                    ...base,
                    type: "runtime.warning",
                    payload: {
                      message: `OMP could not set thinking level '${thinkingLevel}': ${error.detail}. The previous level stays active.`,
                    },
                  }),
                ),
                Effect.ignore,
              );
            },
          }),
        );
      }
      if (thinkingSwitchApplied && thinkingLevel !== undefined) {
        yield* Ref.set(context.lastThinkingLevelRef, thinkingLevel);
      }

      context.activeTurnId = turnId;
      context.activeTurnError = undefined;
      yield* Ref.set(context.denyPendingSelects, false);
      yield* updateSession(
        context,
        {
          status: "running",
          activeTurnId: turnId,
          ...(modelSelection && modelSwitchApplied ? { model: modelSelection.model } : {}),
        },
        { clearLastError: true },
      );

      if (steeringTurnId === undefined) {
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
          type: "turn.started",
          payload: modelSelection && modelSwitchApplied ? { model: modelSelection.model } : {},
        });
      }

      const command = {
        type: steeringTurnId === undefined ? ("prompt" as const) : ("steer" as const),
        ...(text ? { message: text } : {}),
        ...(images.length > 0 ? { images } : {}),
      };
      const promptResponse = yield* context.client.send(command).pipe(
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
                    ...(modelSelection && modelSwitchApplied
                      ? { model: modelSelection.model }
                      : {}),
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

      // Command turns never settle: OMP's `prompt` response carries
      // `data.agentInvoked` — false means the command handler ran instead
      // of the agent loop, and no `agent_end` will come. Synthesize the
      // completion. A missing flag (unknown protocol age) errs on keeping
      // the turn open — `agent_end` or the exit watcher will close it.
      const promptData = (promptResponse.data ?? {}) as Record<string, unknown>;
      if (steeringTurnId === undefined && promptData.agentInvoked === false) {
        yield* Ref.set(context.agentActivitySincePromptRef, false);
        // Node timer, not `Effect.sleep`: the adapter's tests run under a
        // TestClock where Effect.sleep never resumes, and production time is
        // real wall-clock anyway. The grace window absorbs command output
        // events that stream right after the response; the get_state probe
        // below then distinguishes a true command turn from a slow agent
        // turn that reported a false `agentInvoked`.
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              // Real wall-clock grace window; Effect.sleep parks forever
              // under the tests' TestClock.
              // @effect-diagnostics-next-line globalTimers:off -- real wall-clock
              setTimeout(resolve, 2000);
            }),
        );
        const sawAgentActivity = yield* Ref.get(context.agentActivitySincePromptRef);
        const stopped = yield* Ref.get(context.stopped);
        if (!sawAgentActivity && !stopped && context.activeTurnId === turnId) {
          // No agent activity within the window: either a true extension-command
          // turn (OMP never settles it) or a slow agent turn whose first
          // message_start simply hasn't streamed yet (throttled model, cold
          // upstream). Ask OMP which it is before concluding — synthesizing
          // completion for a live turn would close the session to "ready"
          // while OMP keeps working, orphaning the streamed output.
          const stillStreaming = yield* context.client.send({ type: "get_state" }).pipe(
            Effect.map((response) => {
              const data = (response.data ?? {}) as Record<string, unknown>;
              return data.isStreaming === true;
            }),
            // A failed probe can't prove it's a command turn — err on keeping
            // the turn open.
            Effect.catch((cause) =>
              Effect.logWarning("OMP get_state probe failed during command-turn grace window", {
                detail: cause.detail,
              }).pipe(Effect.as(true)),
            ),
          );
          if (!stillStreaming && context.activeTurnId === turnId) {
            context.activeTurnId = undefined;
            context.activeTurnError = undefined;
            yield* Ref.set(context.denyPendingSelects, false);
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
              type: "turn.completed",
              payload: { state: "completed" },
            });
            yield* Queue.offer(context.boundaryJobs, void 0);
          }
        }
      }

      const cursor = yield* buildResumeCursor(context);
      return {
        threadId: input.threadId,
        turnId,
        ...(cursor ? { resumeCursor: cursor } : {}),
      } satisfies ProviderTurnStartResult;
    },
  );

  const resolveOmpImage = Effect.fn("resolveOmpImage")(function* (
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
      // OMP's `abort` response lands after the stream winds down, and the
      // trailing `agent_end` follows — the suppress flag must be armed up
      // front, arming it after the response is always too late.
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
        context.activeTurnError = undefined;
        yield* Ref.set(context.denyPendingSelects, false);
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
    threadId,
    requestId,
    decision,
  ) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/approval",
          detail: `Unknown pending omp approval: ${requestId}`,
        });
      }
      context.pendingApprovals.delete(requestId);
      // ADR 0001 decision 4: `acceptForSession` has no OMP equivalent
      // (approval mode is a launch flag) and maps to a single Approve.
      // `cancel` (the web "Cancel turn" button) must never grant the tool:
      // OMP's dialog only speaks Approve/Deny, so it maps to Deny and the
      // original decision still rides the `request.resolved` payload.
      const value = decision === "accept" || decision === "acceptForSession" ? "Approve" : "Deny";
      yield* answerExtensionUi(context, String(requestId), value).pipe(
        Effect.mapError((cause) => mapOmpRequestError("thread/approval", cause)),
      );
      if (decision === "decline" || decision === "cancel") {
        // The model may retry the tool after a Deny (or a cancel, which
        // also denies) — auto-answer any further approval dialogs this
        // turn instead of stalling the turn on more dialogs (prototype
        // NOTES #6).
        yield* Ref.set(context.denyPendingSelects, true);
      }
      yield* emit({
        ...(yield* buildEventBase({
          threadId,
          turnId: context.activeTurnId,
          requestId,
        })),
        type: "request.resolved",
        payload: {
          requestType: "dynamic_tool_call",
          decision,
        },
      });
    });

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
          detail: `Unknown pending omp user-input request: ${requestId}`,
        });
      }
      context.pendingUiRequests.delete(requestId);
      const answer = answers[requestId];
      const selected = Array.isArray(answer) ? answer[0] : answer;
      // extension_ui_response is fire-and-forget on OMP's side (the dialog
      // resolves and no response line ever comes), and the id must stay
      // OMP's dialog id — so this cannot go through `send`, which stamps
      // its own correlation id and awaits a reply that never arrives.
      const sendResponse = (payload: Record<string, unknown>) =>
        context.client
          .sendFireAndForget({ type: "extension_ui_response", id: String(requestId), ...payload })
          .pipe(Effect.mapError((cause) => mapOmpRequestError("extension_ui_response", cause)));

      if (request.method === "select") {
        if (typeof selected !== "string") {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: "OMP select dialogs require exactly one answer.",
          });
        }
        yield* sendResponse({ value: selected });
      } else if (request.method === "confirm") {
        yield* sendResponse({ confirmed: selected === "Yes" });
      } else {
        // input / editor: non-empty value answers only (empty = unanswered,
        // matches the custom-answer machinery — the client blocks empty
        // submits; this is the server-side backstop).
        if (typeof selected !== "string" || selected.trim().length === 0) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: "OMP text dialogs require a non-empty answer.",
          });
        }
        yield* sendResponse({ value: selected });
      }

      // Close the T3-side question card: web and mobile derive open cards
      // from activities, and the projected pending count reads the same
      // stream, so a successful answer must resolve the request exactly
      // like the other adapters do.
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.threadId,
          turnId: context.activeTurnId,
          requestId,
        })),
        type: "user-input.resolved",
        payload: { answers },
      });
    });

  const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
    Effect.gen(function* () {
      // OMP's session is a resumable model-state cache; T3's event store is
      // the conversation truth (same decision as Pi, #52 decision 8). No T3
      // turn structure maps onto the JSONL file, so the snapshot is
      // deliberately empty.
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
      // No OMP session bound — nothing to rewind; no-op success.
      return { threadId, turns: [] };
    }

    const state = yield* context.client
      .send({ type: "get_state" })
      .pipe(Effect.mapError((cause) => mapOmpRequestError("thread/rollback", cause)));
    const stateData = (state.data ?? {}) as Record<string, unknown>;
    if (stateData.isStreaming === true) {
      // Mid-turn restore guard (checkpoint-restore doc, decision 2): a
      // mid-stream branch tears the session under the stream.
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail: "OMP is still working on a turn. Wait for it to settle before reverting.",
      });
    }

    const boundaries = yield* Ref.get(context.turnBoundariesRef);
    const keptCount = boundaries.length - numTurns;
    if (keptCount < 0) {
      // Unmappable target (checkpoint-restore doc, decision 3): no boundary
      // list (pre-feature session) or fewer recorded turns than requested.
      // Keep the session, complete the revert, warn.
      yield* emit({
        ...(yield* buildEventBase({ threadId })),
        type: "runtime.warning",
        payload: {
          message:
            "OMP session was not rewound — the model still has the discarded turns in context.",
        },
      }).pipe(Effect.ignore);
      return { threadId, turns: [] };
    }

    const targetBoundary = boundaries[keptCount];
    if (!targetBoundary) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail: "OMP session has no recorded restore point for this rewind.",
      });
    }

    const branchResponse = yield* context.client
      .send({ type: "branch", entryId: targetBoundary })
      .pipe(Effect.mapError((cause) => mapOmpRequestError("thread/rollback", cause)));
    const branchData = (branchResponse.data ?? {}) as Record<string, unknown>;
    if (branchData.cancelled === true) {
      // Fail loudly (checkpoint-restore doc, decision 1): a
      // session_before_branch extension handler vetoed the branch — never
      // silently continue.
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail:
          "OMP refused to rewind: a session_before_branch extension handler cancelled the branch.",
      });
    }

    // Branch forks the RPC session in-process to a new session file
    // (checkpoint-restore doc): re-read the durable identity so the cursor
    // points at the forked file from now on. The old file survives untouched
    // as the abandoned path — never delete it.
    const afterBranch = yield* context.client
      .send({ type: "get_state" })
      .pipe(Effect.mapError((cause) => mapOmpRequestError("thread/rollback", cause)));
    const afterBranchData = (afterBranch.data ?? {}) as Record<string, unknown>;
    const forkedSessionFile =
      typeof afterBranchData.sessionFile === "string" ? afterBranchData.sessionFile : undefined;
    if (!forkedSessionFile) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail: "OMP rewound the session but did not report the forked session file.",
      });
    }
    const forkedSessionId =
      typeof afterBranchData.sessionId === "string" ? afterBranchData.sessionId : undefined;

    yield* Ref.set(context.sessionFileRef, forkedSessionFile);
    yield* Ref.set(context.sessionIdRef, forkedSessionId);
    yield* Ref.set(context.turnBoundariesRef, boundaries.slice(0, keptCount));
    yield* syncSessionCursor(context);

    // The branch clears OMP's subagent subscription server-side — re-issue
    // it (checkpoint-restore doc, decision 4).
    yield* setSubagentSubscription(context);

    yield* Effect.logInfo("Rewound omp session via branch", {
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
