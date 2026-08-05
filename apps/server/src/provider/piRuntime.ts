/**
 * piRuntime — JSONL-over-stdio client machinery for the Pi provider.
 *
 * pi's RPC mode is a strict JSONL protocol on the child process's
 * stdin/stdout: commands are JSON objects written to stdin (one per line,
 * LF-only framing), responses are `{type: "response", ...}` lines on
 * stdout, and agent events stream as every other stdout line.
 *
 * Protocol notes that matter here (see pi docs/rpc.md):
 *   - LF (`\n`) is the only record delimiter; a trailing `\r` is tolerated
 *     and stripped. Node `readline` is NOT protocol-compliant (it splits on
 *     U+2028/U+2029, which are legal inside JSON strings), so the line
 *     splitter buffers on `\n` manually.
 *   - Commands may carry an `id`; the matching response echoes it. Without
 *     an id there is no correlation, so this client always stamps one.
 *   - `success: true` on `prompt`/`steer` means the message was accepted or
 *     queued — the work itself streams afterwards as events.
 *
 * The client is process-scoped: one instance per spawned `pi --mode rpc`
 * child. It owns the stdout reader fiber and the pending-command table;
 * the caller owns the process lifecycle (spawn scope, exit watcher) and
 * must call `failPending` when the process dies so in-flight commands
 * observe the death instead of hanging until their timeout.
 *
 * @module provider/piRuntime
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
export const PI_COMMAND_TIMEOUT_MS = 30_000;

/** One parsed stdout line that is not a command response (an agent event). */
export type PiRpcEvent = Record<string, unknown> & { readonly type: string };

export class PiRpcCommandError extends Data.TaggedError("PiRpcCommandError")<{
  readonly command: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export interface PiRpcResponse {
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export interface PiRpcClient {
  /**
   * Send one command and await its correlated `response` line. Always
   * stamps an `id`. Fails with `PiRpcCommandError` on a rejected command
   * (`success: false`), a timeout, or process death while the command is
   * in flight.
   */
  readonly send: (
    command: Record<string, unknown>,
  ) => Effect.Effect<PiRpcResponse, PiRpcCommandError>;
  /**
   * Write one command without correlation or awaiting a response line.
   * The command goes on the wire exactly as given — its `id` field belongs
   * to the receiver's bookkeeping (e.g. pi's extension dialog ids), not to
   * this client's request/response table. pi never answers these lines
   * (extension_ui_response is fire-and-forget in rpc-mode.js), so awaiting
   * one would time out. Writes stay serialized with `send` via the shared
   * permit.
   */
  readonly sendFireAndForget: (
    command: Record<string, unknown>,
  ) => Effect.Effect<void, PiRpcCommandError>;
  /**
   * Raw parsed pi agent events (every non-response stdout line), in
   * arrival order. Shuts down when the client stops.
   */
  readonly events: Queue.Queue<PiRpcEvent>;
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

function parsePiStdoutLine(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Malformed JSONL lines are skipped with a logged warning (#47 design:
    // protocol grows across releases, never fatal). The warning is emitted
    // by the caller, which runs inside the reader fiber.
    return undefined;
  }
}

/**
 * Split a byte stream on `\n` into records. Strips a trailing `\r` per
 * record; never splits on U+2028/U+2029 (valid inside JSON strings).
 */
export const piJsonlLines = <E>(stream: Stream.Stream<Uint8Array, E>): Stream.Stream<string, E> =>
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

export const makePiRpcClient = Effect.fn("makePiRpcClient")(function* (input: {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly timeoutMs?: number;
}): Effect.fn.Return<PiRpcClient, never, Crypto.Crypto | Scope.Scope> {
  const timeoutMs = input.timeoutMs ?? PI_COMMAND_TIMEOUT_MS;
  const crypto = yield* Crypto.Crypto;
  const pendingRef = yield* Ref.make(
    new Map<string, Deferred.Deferred<PiRpcResponse, PiRpcCommandError>>(),
  );
  const stoppedRef = yield* Ref.make(false);
  const events = yield* Queue.unbounded<PiRpcEvent>();
  const writePermit = yield* Semaphore.make(1);

  const failAllPending = Effect.fn("failAllPending")(function* (detail: string) {
    const pending = yield* Ref.getAndSet(pendingRef, new Map());
    yield* Effect.forEach(
      pending,
      ([, deferred]) =>
        Deferred.fail(new PiRpcCommandError({ command: "rpc", detail, cause: undefined }))(
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

  const writeCommand = (payload: Record<string, unknown>) =>
    Stream.run(
      Stream.encodeText(Stream.make(`${JSON.stringify(payload)}\n`)),
      input.child.stdin,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new PiRpcCommandError({
            command: String(payload.type ?? "rpc"),
            detail: `Failed to write ${String(payload.type ?? "rpc")} command to pi process.`,
            cause,
          }),
      ),
    );

  // Reader fiber: stdout lines → responses resolve pending commands,
  // everything else is an agent event. Runs for the client's lifetime.
  const readerFiber = yield* piJsonlLines(input.child.stdout)
    .pipe(
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          const parsed = parsePiStdoutLine(line);
          if (parsed === undefined && line.trim().length > 0) {
            yield* Effect.logWarning("Skipping malformed pi RPC stdout line");
            return;
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return;
          }
          const record = parsed as Record<string, unknown>;
          if (record.type !== "response") {
            yield* Queue.offer(events, record as PiRpcEvent);
            return;
          }
          const id = typeof record.id === "string" ? record.id : undefined;
          const response: PiRpcResponse = {
            command: typeof record.command === "string" ? record.command : "unknown",
            success: record.success === true,
            ...(record.data !== undefined ? { data: record.data } : {}),
            ...(typeof record.error === "string" && record.error.length > 0
              ? { error: record.error }
              : {}),
          };
          if (id === undefined) {
            yield* Effect.logDebug("Uncorrelated pi RPC response", {
              command: response.command,
            });
            return;
          }
          const pending = yield* Ref.get(pendingRef);
          const deferred = pending.get(id);
          if (!deferred) {
            yield* Effect.logDebug("Unmatched pi RPC response id", { id });
            return;
          }
          yield* dropPending(id);
          yield* Deferred.succeed(response)(deferred);
        }),
      ),
    )
    .pipe(Effect.forkScoped);

  // Safety net: when the caller's scope closes (process teardown), fail any
  // command still pending and shut down the event queue. `addFinalizer`
  // binds to the Scope.Scope service, which the caller provides (the
  // per-session scope).
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (yield* Ref.getAndSet(stoppedRef, true)) {
        return;
      }
      yield* failAllPending("pi process stopped.");
      yield* Queue.shutdown(events);
    }),
  );

  const send: PiRpcClient["send"] = (command) =>
    Effect.gen(function* () {
      if (yield* Ref.get(stoppedRef)) {
        return yield* new PiRpcCommandError({
          command: String(command.type ?? "rpc"),
          detail: "pi process is stopped.",
        });
      }
      const id = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new PiRpcCommandError({
              command: String(command.type ?? "rpc"),
              detail: "Failed to generate pi RPC request id.",
              cause,
            }),
        ),
      );
      const deferred = yield* Deferred.make<PiRpcResponse, PiRpcCommandError>();
      yield* Ref.update(pendingRef, (pending) => {
        const next = new Map(pending);
        next.set(id, deferred);
        return next;
      });
      const name = String(command.type ?? "rpc");
      const result = yield* writePermit
        .withPermit(
          writeCommand({ ...command, id }).pipe(
            Effect.andThen(
              Deferred.await(deferred).pipe(
                Effect.timeoutOption(Duration.millis(timeoutMs)),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(
                        new PiRpcCommandError({
                          command: name,
                          detail: `pi command '${name}' timed out after ${timeoutMs}ms.`,
                        }),
                      ),
                    onSome: (response) => Effect.succeed(response),
                  }),
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
        return yield* new PiRpcCommandError({
          command: name,
          detail: result.error ?? `pi command '${name}' was rejected.`,
        });
      }
      return result;
    });

  const sendFireAndForget: PiRpcClient["sendFireAndForget"] = (command) =>
    Effect.gen(function* () {
      if (yield* Ref.get(stoppedRef)) {
        return yield* new PiRpcCommandError({
          command: String(command.type ?? "rpc"),
          detail: "pi process is stopped.",
        });
      }
      // No correlation id, no pending entry, no await — the command goes on
      // the wire exactly as given (its `id` field belongs to pi's dialog
      // bookkeeping, not ours). Writes stay serialized with `send` via the
      // shared permit.
      yield* writePermit.withPermit(writeCommand(command));
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
      yield* failAllPending("pi process stopped.");
      yield* Fiber.interrupt(readerFiber).pipe(Effect.ignore);
      yield* Queue.shutdown(events);
    }),
  };
});
