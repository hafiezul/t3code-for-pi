// Minimal OMP RPC-over-stdio client — prototype stand-in for the future OmpDriver.
//
// Protocol facts from the RPC inventory (wayfinder ticket "Research: OMP RPC protocol
// inventory", gist hafiezul/1e5c6aa5d0a1e6eb369ca902621c5355):
//   - JSONL on stdin/stdout, nothing else on stdout
//   - `ready` hello frame with protocolVersion / supportedProtocolVersions / frame caps
//   - commands carry an optional `id`; responses echo it (`success` + `data`|`error`)
//   - session events are forwarded verbatim; turn settle = `agent_end` with
//     `isTerminal !== false`
// This file is the bit worth lifting into the real driver; the scenario runner (index.ts)
// is throwaway.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export type Frame = Record<string, any> & { type: string };

export interface SpawnOpts {
  cwd: string;
  /** isolated HOME so ~/.omp lands in scratch, never the live home */
  home: string;
  sessionDir: string;
  extraArgs?: string[];
  env?: Record<string, string>;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
}

export class OmpClient {
  readonly child: ChildProcess;
  private rl: ReturnType<typeof createInterface>;
  private anyListeners = new Set<(f: Frame) => void>();
  private typeListeners = new Map<string, Set<(f: Frame) => void>>();
  private pending = new Map<
    string,
    { resolve: (f: Frame) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  /** ring of recent frames so waitFor() can resolve frames that already arrived */
  readonly frames: Frame[] = [];
  private seq = 0;
  readonly exited: Promise<ExitInfo>;
  private resolveExit!: (v: ExitInfo) => void;
  readonly parseErrors: string[] = [];

  constructor(opts: SpawnOpts) {
    const exitGate = Promise.withResolvers<ExitInfo>();
    this.exited = exitGate.promise;
    this.resolveExit = exitGate.resolve;

    this.child = spawn(
      "omp",
      ["--mode", "rpc", "--session-dir", opts.sessionDir, ...(opts.extraArgs ?? [])],
      {
        cwd: opts.cwd,
        env: { ...process.env, HOME: opts.home, ...(opts.env ?? {}) },
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    this.child.on("exit", (code, signal) => this.resolveExit({ code, signal }));
    this.child.on("error", (err) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.resolveExit({ code: null, signal: null });
    });

    this.rl = createInterface({ input: this.child.stdout!, crlfDelay: Infinity });
    this.rl.on("line", (line) => {
      let frame: Frame;
      try {
        frame = JSON.parse(line);
      } catch {
        this.parseErrors.push(line);
        return;
      }
      this.frames.push(frame);
      if (this.frames.length > 2000) this.frames.splice(0, this.frames.length - 2000);
      if (frame.type === "response" && typeof frame.id === "string" && this.pending.has(frame.id)) {
        const p = this.pending.get(frame.id)!;
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        p.resolve(frame);
        return;
      }
      this.dispatch(frame);
    });
  }

  on(type: string, cb: (f: Frame) => void): () => void {
    let set = this.typeListeners.get(type);
    if (!set) this.typeListeners.set(type, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  onAny(cb: (f: Frame) => void): () => void {
    this.anyListeners.add(cb);
    return () => this.anyListeners.delete(cb);
  }

  /** resolve with the next frame of `type` (scanning frames received since `from` first) */
  waitFor(
    type: string,
    pred?: (f: Frame) => boolean,
    timeoutMs = 60_000,
    from = 0,
  ): Promise<Frame> {
    for (let i = from; i < this.frames.length; i++) {
      const f = this.frames[i]!;
      if (f.type === type && (!pred || pred(f))) return Promise.resolve(f);
    }
    const gate = Promise.withResolvers<Frame>();
    const timer = setTimeout(
      () => gate.reject(new Error(`timeout waiting for frame ${type}`)),
      timeoutMs,
    );
    const off = this.on(type, (f) => {
      if (pred && !pred(f)) return;
      clearTimeout(timer);
      off();
      gate.resolve(f);
    });
    return gate.promise;
  }

  /** send a command and await its id-correlated response frame */
  command(type: string, payload?: Record<string, unknown>, timeoutMs = 30_000): Promise<Frame> {
    const id = `req_${++this.seq}`;
    const gate = Promise.withResolvers<Frame>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      gate.reject(new Error(`timeout waiting for response to ${type}`));
    }, timeoutMs);
    this.pending.set(id, { resolve: gate.resolve, reject: gate.reject, timer });
    this.write(payload ? { id, type, ...payload } : { id, type });
    return gate.promise;
  }

  /** send a raw frame with no id (used to probe un-correlated behavior) */
  write(frame: Record<string, unknown>): void {
    if (this.child.stdin!.destroyed) return;
    this.child.stdin!.write(JSON.stringify(frame) + "\n");
  }

  // RPC command surface (protocol command names are the durable contract here)
  prompt(message: string): Promise<Frame> {
    return this.command("prompt", { message }, 15_000);
  }
  abort(): Promise<Frame> {
    return this.command("abort", undefined, 15_000);
  }
  getState(): Promise<Frame> {
    return this.command("get_state");
  }
  getAvailableModels(): Promise<Frame> {
    return this.command("get_available_models", undefined, 180_000);
  }
  setModel(provider: string, modelId: string): Promise<Frame> {
    return this.command("set_model", { provider, modelId }, 120_000);
  }
  getMessages(): Promise<Frame> {
    return this.command("get_messages");
  }
  getBranchMessages(): Promise<Frame> {
    return this.command("get_branch_messages");
  }
  branch(entryId: string): Promise<Frame> {
    return this.command("branch", { entryId }, 15_000);
  }
  extensionUiResponse(id: string, value: string): void {
    this.write({ type: "extension_ui_response", id, value });
  }

  /** graceful shutdown: stdin EOF → omp disposes and exits 0 */
  close(): Promise<ExitInfo> {
    this.child.stdin!.end();
    return this.exited;
  }

  kill(signal: NodeJS.Signals): Promise<ExitInfo> {
    this.child.kill(signal);
    return this.exited;
  }

  private dispatch(f: Frame): void {
    for (const cb of this.anyListeners) cb(f);
    const set = this.typeListeners.get(f.type);
    if (set) for (const cb of [...set]) cb(f);
  }
}
