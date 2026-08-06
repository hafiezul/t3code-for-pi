/**
 * ompRuntime — JSONL-over-stdio client machinery for the OMP provider.
 *
 * OMP's RPC mode is a strict JSONL protocol on the child process's
 * stdin/stdout: commands are JSON objects written to stdin (one per line,
 * LF-only framing), responses are `{type: "response", ...}` lines on
 * stdout that echo the command's `id`, and agent events stream as every
 * other stdout line. The process announces itself with a `ready` hello
 * frame before it accepts commands.
 *
 * Protocol notes that matter here (see the RPC inventory and the OMP e2e
 * prototype, `prototypes/omp-e2e/rpc.ts`):
 *   - LF (`\n`) is the only record delimiter; a trailing `\r` is tolerated
 *     and stripped. Node `readline` is NOT protocol-compliant (it splits on
 *     U+2028/U+2029, which are legal inside JSON strings), so the line
 *     splitter buffers on `\n` manually.
 *   - Commands may carry an `id`; the matching response echoes it. Without
 *     an id there is no correlation, so this client always stamps one.
 *   - `success: true` on `prompt`/`abort` means the message was accepted or
 *     queued — the work itself streams afterwards as events.
 *   - The `ready` hello precedes any response; commands sent before it are
 *     rejected by the child, so the client gates its first command on it.
 *
 * The client is process-scoped: one instance per spawned `omp --mode rpc-ui`
 * child. It owns the stdout reader fiber and the pending-command table;
 * the caller owns the process lifecycle (spawn scope, exit watcher) and
 * must call `failPending` when the process dies so in-flight commands
 * observe the death instead of hanging until their timeout.
 *
 * @module provider/ompRuntime
 */
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

/** Default ceiling for a command's response round trip. */
export const OMP_COMMAND_TIMEOUT_MS = 30_000;

/** Ceiling for the best-effort protocol-v2 negotiation round trip. */
const OMP_NEGOTIATE_TIMEOUT_MS = 5_000;

/** One parsed stdout line that is not a command response (an agent event). */
export type OmpRpcEvent = Record<string, unknown> & { readonly type: string };

export class OmpRpcCommandError extends Data.TaggedError("OmpRpcCommandError")<{
  readonly command: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  // This Effect build's Data.TaggedError leaves `message` empty (""), which
  // hides the real failure from every `error.message` consumer (adapter
  // error mapping, log lines). Surface the fields so the error is
  // diagnosable.
  override get message(): string {
    return `${this.detail} (command '${this.command}')`;
  }
}

export interface OmpRpcResponse {
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export interface OmpRpcClient {
  /**
   * Send one command and await its correlated `response` line. Always
   * stamps an `id`; the first command waits for the `ready` hello. Fails
   * with `OmpRpcCommandError` on a rejected command (`success: false`), a
   * timeout, or process death while the command is in flight.
   */
  readonly send: (
    command: Record<string, unknown>,
  ) => Effect.Effect<OmpRpcResponse, OmpRpcCommandError>;
  /**
   * Write one command verbatim, without stamping a correlation `id` and
   * without awaiting a `response` line. For OMP commands whose `id` field
   * is semantically meaningful to OMP and which OMP never answers — the
   * `extension_ui_response` dialog replies (fire-and-forget per the RPC
   * inventory; the e2e prototype writes them raw). Using `send` for these
   * is a bug: the stamped correlation id overwrites the dialog request id
   * OMP resolves against, and the awaited response line never arrives.
   */
  readonly sendFireAndForget: (
    command: Record<string, unknown>,
  ) => Effect.Effect<void, OmpRpcCommandError>;
  /**
   * Raw parsed OMP agent events (every non-response stdout line), in
   * arrival order. Shuts down when the client stops.
   */
  readonly events: Queue.Queue<OmpRpcEvent>;
  /**
   * Fail every pending command with the given detail — the process died
   * under them. No-op when nothing is pending.
   */
  readonly failPending: (detail: string) => Effect.Effect<void>;
  /**
   * Stop the reader fiber, fail every pending command, and shut down the
   * event queue. Idempotent.
   */
  readonly stop: Effect.Effect<void>;
}

function parseOmpStdoutLine(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Malformed JSONL lines are skipped with a logged warning (the
    // protocol grows across releases; never fatal). The warning is emitted
    // by the caller, which runs inside the reader fiber.
    return undefined;
  }
}

/**
 * Split a byte stream on `\n` into records. Strips a trailing `\r` per
 * record; never splits on U+2028/U+2029 (valid inside JSON strings).
 */
export const ompJsonlLines = <E>(stream: Stream.Stream<Uint8Array, E>): Stream.Stream<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.mapAccum(
      () => "",
      (carry, chunk) => {
        const combined = carry + chunk;
        const parts = combined.split("\n");
        const remainder = parts.pop() ?? "";
        const lines = parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
        return [remainder, lines] as [string, string[]];
      },
    ),
  );

export const makeOmpRpcClient = Effect.fn("makeOmpRpcClient")(function* (input: {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly timeoutMs?: number;
}): Effect.fn.Return<OmpRpcClient, never, Crypto.Crypto | Scope.Scope> {
  const timeoutMs = input.timeoutMs ?? OMP_COMMAND_TIMEOUT_MS;
  const crypto = yield* Crypto.Crypto;
  const pendingRef = yield* Ref.make(
    new Map<string, Deferred.Deferred<OmpRpcResponse, OmpRpcCommandError>>(),
  );
  const stoppedRef = yield* Ref.make(false);
  const readyGate = yield* Deferred.make<undefined>();
  /** Protocol facts from the `ready` hello, captured the moment it lands. */
  const readyRef = yield* Ref.make<
    | {
        readonly protocolVersion: number | undefined;
        readonly supportedProtocolVersions: ReadonlyArray<number> | undefined;
      }
    | undefined
  >(undefined);
  /** One-shot: protocol-v2 negotiation attempted (or ruled out) at most once. */
  const negotiatedRef = yield* Ref.make(false);
  const events = yield* Queue.unbounded<OmpRpcEvent>();
  const writePermit = yield* Semaphore.make(1);

  const failAllPending = Effect.fn("failAllPending")(function* (detail: string) {
    const pending = yield* Ref.getAndSet(pendingRef, new Map());
    yield* Effect.forEach(
      pending,
      ([, deferred]) =>
        Deferred.fail(new OmpRpcCommandError({ command: "rpc", detail, cause: undefined }))(
          deferred,
        ).pipe(Effect.ignore),
      { concurrency: "unbounded", discard: true },
    );
  });

  const dropPending = (id: string) =>
    Ref.update(pendingRef, (pending) => {
      const next = new Map(pending);
      next.delete(id);
      return next;
    });

  /**
   * Stamp a correlation id and register the awaiting deferred — the shared
   * bookkeeping behind every correlated write (`send` and the protocol
   * negotiation). Callers own the id's cleanup (`dropPending`).
   */
  const registerPendingCommand = (commandName: string) =>
    Effect.gen(function* () {
      const id = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new OmpRpcCommandError({
              command: commandName,
              detail: "Failed to generate omp RPC request id.",
              cause,
            }),
        ),
      );
      const deferred = yield* Deferred.make<OmpRpcResponse, OmpRpcCommandError>();
      yield* Ref.update(pendingRef, (pending) => {
        const next = new Map(pending);
        next.set(id, deferred);
        return next;
      });
      return { id, deferred } as const;
    });

  const writeCommand = (payload: Record<string, unknown>) =>
    Stream.run(
      Stream.encodeText(Stream.make(`${JSON.stringify(payload)}\n`)),
      input.child.stdin,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new OmpRpcCommandError({
            command: String(payload.type ?? "rpc"),
            detail: `Failed to write ${String(payload.type ?? "rpc")} command to omp process.`,
            cause,
          }),
      ),
    );

  /**
   * Best-effort protocol-v2 opt-in (ADR 0001 d.6). When the `ready` hello
   * reports a v1 server that advertises protocol 2, negotiate once before
   * the first command so OMP may emit >1 MiB frames (v2 reassembly). Our
   * JSONL splitter is unbounded, so v1 framing already handles any line
   * size — this is a polite opt-in, never a requirement. Rejected,
   * unanswered, or unadvertised negotiations fall back to v1 silently.
   * Runs inside the caller's `writePermit`, so write ordering stays
   * deterministic: the negotiation always precedes the first command.
   */
  const negotiateProtocolV2 = Effect.gen(function* () {
    if (yield* Ref.get(negotiatedRef)) {
      return;
    }
    yield* Ref.set(negotiatedRef, true);
    const ready = yield* Ref.get(readyRef);
    if (ready === undefined || (ready.protocolVersion ?? 1) >= 2) {
      return;
    }
    const supported = ready.supportedProtocolVersions;
    if (supported === undefined || !supported.includes(2)) {
      return;
    }
    const { id, deferred } = yield* registerPendingCommand("negotiate_protocol");
    yield* writeCommand({ type: "negotiate_protocol", protocolVersion: 2, id }).pipe(
      Effect.andThen(
        Deferred.await(deferred).pipe(
          Effect.timeoutOption(Duration.millis(OMP_NEGOTIATE_TIMEOUT_MS)),
          Effect.flatMap((option) =>
            Option.match(option, {
              onNone: () => Effect.logDebug("omp protocol-v2 negotiation timed out; staying on v1"),
              onSome: (response) =>
                response.success
                  ? Effect.logDebug("omp protocol-v2 negotiated")
                  : Effect.logDebug("omp declined protocol-v2 negotiation; staying on v1", {
                      error: response.error,
                    }),
            }).pipe(Effect.andThen(dropPending(id))),
          ),
        ),
      ),
      Effect.onInterrupt(() => dropPending(id)),
      Effect.onError(() => dropPending(id)),
      // Best-effort: a rejected or failed negotiation must never fail the
      // caller's command — v1 framing already handles any line size.
      Effect.ignoreCause,
    );
  });

  // Reader fiber: stdout lines → responses resolve pending commands,
  // everything else is an agent event. Runs for the client's lifetime.
  const readerFiber = yield* ompJsonlLines(input.child.stdout).pipe(
    Stream.runForEach((line) =>
      Effect.gen(function* () {
        const parsed = parseOmpStdoutLine(line);
        if (parsed === undefined && line.trim().length > 0) {
          yield* Effect.logWarning("Skipping malformed omp RPC stdout line");
          return;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return;
        }
        const record = parsed as Record<string, unknown>;
        if (record.type === "ready") {
          yield* Ref.set(readyRef, {
            ...(typeof record.protocolVersion === "number"
              ? { protocolVersion: record.protocolVersion }
              : { protocolVersion: undefined }),
            ...(Array.isArray(record.supportedProtocolVersions)
              ? {
                  supportedProtocolVersions: record.supportedProtocolVersions.filter(
                    (value): value is number => typeof value === "number",
                  ),
                }
              : { supportedProtocolVersions: undefined }),
          });
          yield* Deferred.succeed(undefined)(readyGate).pipe(Effect.ignore);
          return;
        }
        if (record.type !== "response") {
          yield* Queue.offer(events, record as OmpRpcEvent);
          return;
        }
        const id = typeof record.id === "string" ? record.id : undefined;
        const response: OmpRpcResponse = {
          command: typeof record.command === "string" ? record.command : "unknown",
          success: record.success === true,
          ...(record.data !== undefined ? { data: record.data } : {}),
          ...(typeof record.error === "string" && record.error.length > 0
            ? { error: record.error }
            : {}),
        };
        if (id === undefined) {
          yield* Effect.logDebug("Uncorrelated omp RPC response", {
            command: response.command,
          });
          return;
        }
        const pending = yield* Ref.get(pendingRef);
        const deferred = pending.get(id);
        if (!deferred) {
          yield* Effect.logDebug("Unmatched omp RPC response id", { id });
          return;
        }
        yield* dropPending(id);
        yield* Deferred.succeed(response)(deferred);
      }),
    ),
    Effect.forkScoped,
  );

  // Safety net: when the caller's scope closes (process teardown), fail any
  // command still pending and shut down the event queue. `addFinalizer`
  // binds to the Scope.Scope service, which the caller provides (the
  // per-session scope).
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (yield* Ref.getAndSet(stoppedRef, true)) {
        return;
      }
      yield* failAllPending("omp process stopped.");
      yield* Queue.shutdown(events);
    }),
  );

  const send: OmpRpcClient["send"] = (command) =>
    Effect.gen(function* () {
      if (yield* Ref.get(stoppedRef)) {
        return yield* new OmpRpcCommandError({
          command: String(command.type ?? "rpc"),
          detail: "omp process is stopped.",
        });
      }
      const name = String(command.type ?? "rpc");
      const { id, deferred } = yield* registerPendingCommand(name);
      const result = yield* writePermit
        .withPermit(
          // OMP rejects commands sent before its `ready` hello — gate the
          // first write on it. The gate also fails the command if the
          // process dies without ever greeting (scope close resolves it
          // as a failed read: the reader fiber dies with the process).
          Deferred.await(readyGate).pipe(
            Effect.andThen(negotiateProtocolV2),
            Effect.andThen(
              writeCommand({ ...command, id }).pipe(
                Effect.andThen(
                  Deferred.await(deferred).pipe(
                    Effect.timeoutOption(Duration.millis(timeoutMs)),
                    Effect.flatMap(
                      Option.match({
                        onNone: () =>
                          Effect.fail(
                            new OmpRpcCommandError({
                              command: name,
                              detail: `omp command '${name}' timed out after ${timeoutMs}ms.`,
                            }),
                          ),
                        onSome: (response) => Effect.succeed(response),
                      }),
                    ),
                  ),
                ),
              ),
            ),
          ),
        )
        .pipe(
          Effect.onInterrupt(() => dropPending(id)),
          Effect.onError(() => dropPending(id)),
        );
      if (!result.success) {
        return yield* new OmpRpcCommandError({
          command: name,
          detail: result.error ?? `omp command '${name}' was rejected.`,
        });
      }
      return result;
    });

  const sendFireAndForget: OmpRpcClient["sendFireAndForget"] = (command) =>
    Effect.gen(function* () {
      if (yield* Ref.get(stoppedRef)) {
        return yield* new OmpRpcCommandError({
          command: String(command.type ?? "rpc"),
          detail: "omp process is stopped.",
        });
      }
      // No correlation id, no pending entry, no await — the command goes on
      // the wire exactly as given (its `id` field belongs to OMP's dialog
      // bookkeeping, not ours). Writes stay serialized with `send` via the
      // shared permit, and the `ready` gate applies here too: no command
      // (correlated or not) may precede the hello.
      yield* writePermit.withPermit(
        Deferred.await(readyGate).pipe(
          Effect.andThen(negotiateProtocolV2),
          Effect.andThen(writeCommand(command)),
        ),
      );
    });

  return {
    send,
    sendFireAndForget,
    events,
    failPending: failAllPending,
    stop: Effect.gen(function* () {
      if (yield* Ref.getAndSet(stoppedRef, true)) {
        return;
      }
      yield* failAllPending("omp process stopped.");
      yield* Fiber.interrupt(readerFiber).pipe(Effect.ignore);
      yield* Queue.shutdown(events);
    }),
  };
});
