#!/usr/bin/env node
// Prototype: drives a real OMP session through a minimal RPC adapter stand-in.
//
// Question being answered (see README.md): does the orchestration mapping in
// docs/adr/0001-omp-orchestration-mapping.md hold against the real `omp` binary —
// spawn/reap, turn settle, abort ordering, approval dialogs, model switch, and the
// in-place `branch` rewind (which the "checkpoint restore" grilling ticket builds on)?
//
// Throwaway harness. The liftable bit is rpc.ts. Runs entirely in a /tmp sandbox:
// isolated HOME, scratch session-dir, a git-initialized worktree with a seeded
// .t3/userdata (VACUUM INTO from ~/.t3/userdata per AGENTS.md — live state never touched).
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OmpClient, type Frame } from "./rpc.ts";

// Every line lands in the run log too, so a killed run leaves its partial transcript.
const RUN_LOG = "/tmp/omp-e2e-run.log";
const PID_FILE = "/tmp/omp-e2e.pid"; // child PIDs from previous runs — reaped on startup

function log(line: string): void {
  console.log(line);
  appendFileSync(RUN_LOG, line + "\n");
}
function err(line: string): void {
  console.error(line);
  appendFileSync(RUN_LOG, line + "\n");
}

/** Kill only PIDs this runner previously recorded, after verifying they are omp RPC
 *  children (AGENTS.md rule: no pattern kills). Prevents a stale child from holding
 *  the shared agent home's config.yml.lock and deadlocking the next spawn. */
function reapStaleChildren(): void {
  let stale: string[];
  try {
    stale = readFileSync(PID_FILE, "utf8").trim().split(/\s+/).filter(Boolean);
  } catch {
    return; // no pid file yet
  }
  for (const pid of stale) {
    let cmd = "";
    try {
      cmd = execFileSync("ps", ["-p", pid, "-o", "command="], { encoding: "utf8" }).trim();
    } catch {
      continue; // already gone
    }
    if (cmd.includes("--mode rpc") && cmd.includes("omp")) {
      try {
        process.kill(Number(pid), "SIGKILL");
        log(`reaped stale omp child ${pid} (${cmd.slice(0, 90)}…)`);
      } catch {
        // raced with exit
      }
    }
  }
  writeFileSync(PID_FILE, "");
}

interface AgentMessage {
  role: string;
  content: Array<{ type: string; text?: string; thinking?: string }>;
  stopReason?: string;
  errorMessage?: string;
}
interface AgentEnd extends Frame {
  isTerminal?: boolean;
  messages: AgentMessage[];
}
interface SelectRequest extends Frame {
  method: string;
  id: string;
  title: string;
  options: string[];
}

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  ok ? passed++ : failed++;
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function info(name: string, detail: string): void {
  log(`INFO  ${name} — ${detail}`);
}
function textOf(m: AgentMessage): string {
  return m.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join(" ");
}
/** the settle rule from ADR 0001 decision 1: agent_end with isTerminal !== false.
 *  Frames received before the caller's prompt are never eligible (watermark = current length). */
function settle(c: OmpClient): Promise<Frame> {
  return c.waitFor(
    "agent_end",
    (f) => (f as AgentEnd).isTerminal !== false,
    120_000,
    c.frames.length,
  );
}

function seedT3(worktree: string): string {
  const cacheFile = "/tmp/omp-e2e-seed/state.sqlite";
  const dest = join(worktree, ".t3", "userdata", "state.sqlite");
  try {
    if (!existsSync(cacheFile)) {
      mkdirSync(join(cacheFile, ".."), { recursive: true });
      const db = new DatabaseSync(join(homedir(), ".t3", "userdata", "state.sqlite"), {
        readOnly: true,
      });
      db.exec(`VACUUM INTO '${cacheFile}'`);
      db.close();
    }
    copyFileSync(cacheFile, dest);
    return `${statSync(dest).size} bytes -> ${dest}`;
  } catch (err) {
    return `skipped (${(err as Error).message})`;
  }
}

function initGit(worktree: string): void {
  execFileSync("git", ["init", "-q"], { cwd: worktree });
  execFileSync("git", ["config", "user.email", "prototype@local"], { cwd: worktree });
  execFileSync("git", ["config", "user.name", "prototype"], { cwd: worktree });
  writeFileSync(join(worktree, "README.md"), "prototype sandbox worktree\n");
  execFileSync("git", ["add", "-A"], { cwd: worktree });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: worktree });
}

/** one full turn: prompt ack, then settle; returns the terminal agent_end frame */
async function runTurn(c: OmpClient, message: string): Promise<AgentEnd | null> {
  const ack = await c.prompt(message);
  if (ack.success !== true) {
    info("turn-ack", `prompt failed: ${JSON.stringify(ack.error)}`);
    return null;
  }
  return (await settle(c)) as AgentEnd;
}

async function main(): Promise<void> {
  log("== Prototype: OMP end-to-end session under T3 ==");
  reapStaleChildren();
  const scratch = mkdtempSync(join(tmpdir(), "omp-e2e-"));
  const worktree = join(scratch, "worktree");
  const home = "/tmp/omp-e2e-seed/home"; // reused so models.db catalog cache survives runs
  const sessions = join(scratch, "sessions");
  mkdirSync(join(worktree, ".t3", "userdata"), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  info("scratch", scratch);
  info("agent-home", `${home} (reused across runs for the model catalog cache)`);

  const seed = seedT3(worktree);
  info("t3-seed", seed);
  initGit(worktree);

  const apiKey =
    process.env.OPENCODE_API_KEY ??
    execFileSync("omp", ["token", "opencode-go"], { encoding: "utf8" }).trim();
  if (!apiKey) {
    err("no OPENCODE_API_KEY in env and `omp token opencode-go` came back empty");
    process.exitCode = 1;
    return;
  }
  info(
    "api-key",
    process.env.OPENCODE_API_KEY
      ? "from env"
      : `from \`omp token opencode-go\` (${apiKey.length} chars)`,
  );

  const clients: OmpClient[] = [];
  const spawnClient = (extraArgs: string[] = []): OmpClient => {
    const c = new OmpClient({
      cwd: worktree,
      home,
      sessionDir: sessions,
      extraArgs,
      env: { OPENCODE_API_KEY: apiKey },
    });
    clients.push(c);
    appendFileSync(PID_FILE, `${c.child.pid}\n`);
    return c;
  };
  process.on("exit", () => {
    for (const c of clients) c.child.kill("SIGKILL");
  });

  // ---- S1: spawn, ready handshake, startup frames
  // --models + --model restrict catalog discovery to the opencode-go provider: a cold
  // get_available_models across all providers (incl. the inherited anthropic env) was
  // observed to hang for minutes (see NOTES.md).
  const a = spawnClient(["--models", "opencode-go/*", "--model", "opencode-go/deepseek-v4-flash"]);
  const ready = await a.waitFor("ready", undefined, 15_000);
  check(
    "spawn+ready",
    ready.protocolVersion === 1 &&
      Array.isArray(ready.supportedProtocolVersions) &&
      ready.supportedProtocolVersions.includes(2),
    `protocolVersion ${ready.protocolVersion}, supports [${ready.supportedProtocolVersions}], caps ${ready.maxFrameBytes}/${ready.maxReassembledFrameBytes}`,
  );
  const cmds = await a.waitFor("available_commands_update", undefined, 15_000);
  const bySource = new Map<string, number>();
  for (const cmd of cmds.commands ?? [])
    bySource.set(cmd.source, (bySource.get(cmd.source) ?? 0) + 1);
  info(
    "startup-frames",
    `available_commands_update: ${(cmds.commands ?? []).length} commands [${[...bySource.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}]; setWidget(autoresearch): ${a.frames.some(
      (f) => f.type === "extension_ui_request" && f.method === "setWidget",
    )}`,
  );

  // ---- S2: protocol v2 negotiation
  const v2 = await a.command("negotiate_protocol", { protocolVersion: 2 });
  check("v2-negotiation", v2.success === true, JSON.stringify(v2.data ?? v2.error));

  // ---- S3: unknown command shape
  a.write({ type: "get_commands" });
  const unknown = await a.waitFor("response", (f) => f.command === "get_commands", 10_000);
  check(
    "unknown-command",
    unknown.success === false && String(unknown.error).includes("Unknown command"),
    `get_commands -> ${unknown.error}`,
  );

  // ---- S4: fresh session state
  const st0 = (await a.command("get_state")).data;
  check(
    "get_state-fresh",
    typeof st0.sessionId === "string" &&
      typeof st0.sessionFile === "string" &&
      st0.sessionFile.endsWith(".jsonl") &&
      st0.messageCount === 0,
    `sessionFile=${String(st0.sessionFile).split("/").pop()}, messageCount=${st0.messageCount}`,
  );

  // ---- S5: model switch via set_model (catalog discovery skipped — cold
  // get_available_models across all providers hung for minutes; see NOTES.md)
  const set = await a.setModel("opencode-go", "deepseek-v4-flash");
  const st1 = (await a.getState()).data;
  check(
    "model-switch",
    set.success === true && st1.model?.id === "deepseek-v4-flash",
    `set_model opencode-go/deepseek-v4-flash; get_state.model = ${st1.model?.provider}/${st1.model?.id}`,
  );

  // ---- S6/S7: two model turns, settle semantics
  const t1 = await runTurn(a, "Reply with exactly the word: done");
  check(
    "turn-1-settle",
    t1 !== null && t1.isTerminal === true && (t1.messages ?? []).length === 2,
    `agent_end isTerminal=${t1?.isTerminal}, messages=${t1?.messages.length}`,
  );
  const t2 = await runTurn(a, "Reply with exactly the word: again");
  check(
    "turn-2-settle",
    t2 !== null && t2.isTerminal === true && (t2.messages ?? []).length === 2,
    `agent_end isTerminal=${t2?.isTerminal}, messages=${t2?.messages.length}`,
  );
  const deltas = a.frames.filter(
    (f) => f.type === "message_update" && f.assistantMessageEvent,
  ).length;
  const toolFrames = a.frames.filter((f) => f.type.startsWith("tool_execution")).length;
  const maintenance = a.frames.filter(
    (f) => f.type.startsWith("auto_retry") || f.type.startsWith("auto_compaction"),
  ).length;
  info(
    "turn-events",
    `message_update deltas: ${deltas}, tool_execution frames: ${toolFrames}, auto_retry/auto_compaction: ${maintenance}`,
  );
  const msgs = ((await a.getMessages()).data?.messages ?? []) as AgentMessage[];
  check("two-turns-persisted", msgs.length === 4, `get_messages messageCount=${msgs.length}`);
  check(
    "turn-texts",
    textOf(msgs[1]).trim() === "done" && textOf(msgs[3]).trim() === "again",
    `[${msgs.map(textOf).join(" | ")}]`,
  );

  // ---- S8: in-place branch rewind (feeds the checkpoint-restore ticket)
  const branchEntries = ((await a.getBranchMessages()).data?.messages ?? []) as Array<{
    entryId: string;
    text: string;
  }>;
  info(
    "branch-entries",
    branchEntries
      .map((e) => `${String(e.entryId).slice(0, 8)}: ${String(e.text).slice(0, 60)}`)
      .join(" | "),
  );
  const rewindTo = branchEntries.find((e) => String(e.text).includes("again"));
  if (rewindTo) {
    const br = await a.branch(String(rewindTo.entryId));
    check(
      "branch-command",
      br.success === true,
      `branch(${String(rewindTo.entryId).slice(0, 8)}…) cancelled=${br.data?.cancelled}`,
    );
    const rewound = ((await a.getMessages()).data?.messages ?? []) as AgentMessage[];
    info("after-branch", `${rewound.length} messages: [${rewound.map(textOf).join(" | ")}]`);
    const t3 = await runTurn(a, "Reply with exactly the word: rewound");
    const final = ((await a.getMessages()).data?.messages ?? []) as AgentMessage[];
    const againGone = !final.some((m) => textOf(m).trim() === "again");
    check(
      "branch-in-place",
      t3 !== null && againGone,
      `rewound in same process/file, then continued: final ${final.length} messages [${final
        .map(textOf)
        .join(" | ")}], 'again' pruned: ${againGone}`,
    );
  } else {
    check("branch-command", false, "no entry containing 'again' in get_branch_messages");
    check("branch-in-place", false, "rewind target unavailable");
  }

  // ---- S9: abort wire ordering
  const ackA = await a.prompt("Use the bash tool to run `sleep 60`, then report back.");
  check("abort-prompt-ack", ackA.success === true);
  const toolStart = await a.waitFor("tool_execution_start", (f) => f.toolName === "bash", 60_000);
  const abortResp = await a.abort();
  const end = await settle(a);
  const abortedMsg = end.messages?.find(
    (m) => m.role === "assistant" && m.stopReason === "aborted",
  );
  const abortRespBeforeEnd = a.frames.indexOf(abortResp) < a.frames.indexOf(end);
  const toolEnd = a.frames.find(
    (f) => f.type === "tool_execution_end" && f.toolCallId === toolStart.toolCallId,
  );
  check(
    "abort-wire",
    abortResp.success === true && abortRespBeforeEnd && abortedMsg !== undefined,
    `abort response before agent_end: ${abortRespBeforeEnd}; stopReason=${abortedMsg?.stopReason}, errorMessage=${abortedMsg?.errorMessage ?? ""}`,
  );
  check(
    "abort-tool",
    toolEnd?.isError === true && JSON.stringify(toolEnd.result).includes("cancelled"),
    `tool_execution_end isError=${toolEnd?.isError}, result=${JSON.stringify(toolEnd?.result).slice(0, 80)}`,
  );

  // ---- S10: graceful reap via stdin EOF
  const exitA = await a.close();
  check(
    "graceful-reap",
    exitA.code === 0 && exitA.signal === null,
    `stdin EOF -> exit ${exitA.code}`,
  );

  // ---- S11/S12: approvals as select dialogs (always-ask)
  const b = spawnClient([
    "--approval-mode",
    "always-ask",
    "--models",
    "opencode-go/*",
    "--model",
    "opencode-go/deepseek-v4-flash",
  ]);
  await b.waitFor("ready", undefined, 15_000);
  info("approval-model", "opencode-go/deepseek-v4-flash (spawn flags)");
  const ack1 = await b.prompt("Use the bash tool to run `echo approved-ok`");
  check("approval-prompt-ack", ack1.success === true);
  const sel = (await b.waitFor(
    "extension_ui_request",
    (f) => f.method === "select",
    60_000,
  )) as SelectRequest;
  check(
    "approval-dialog",
    Array.isArray(sel.options) &&
      sel.options.length === 2 &&
      sel.options[0] === "Approve" &&
      sel.options[1] === "Deny",
    `options=[${sel.options}] title="${String(sel.title).slice(0, 70)}"`,
  );
  b.extensionUiResponse(sel.id, "Approve");
  const end1 = await settle(b);
  const tee1 = b.frames.find((f) => f.type === "tool_execution_end" && f.toolName === "bash");
  check(
    "approval-approve",
    end1.isTerminal !== false && tee1?.isError === false,
    `tool ran after Approve (isError=${tee1?.isError})`,
  );
  const ack2 = await b.prompt("Use the bash tool to run `echo denied-ok`");
  check("denial-prompt-ack", ack2.success === true);
  const sel2 = (await b.waitFor(
    "extension_ui_request",
    (f) => f.method === "select",
    60_000,
    b.frames.length,
  )) as SelectRequest;
  info("denial-dialog", `options=[${sel2.options}] title="${String(sel2.title).slice(0, 70)}"`);
  b.extensionUiResponse(sel2.id, "Deny");
  // A denied tool feeds an error back to the model, which may retry -> more dialogs.
  // Auto-deny extras so the turn can settle; the count is evidence for the adapter design.
  let extraDialogs = 0;
  const autoDeny = b.on("extension_ui_request", (f) => {
    if (f.method === "select" && f.id !== sel2.id) {
      extraDialogs++;
      info(
        "denial-retry-dialog",
        `#${extraDialogs} auto-deny ${String(f.id).slice(0, 8)}… options=[${f.options}]`,
      );
      b.extensionUiResponse(String(f.id), "Deny");
    }
  });
  const end2 = await settle(b);
  autoDeny();
  const tee2 = [...b.frames].reverse().find((f) => f.type === "tool_execution_end");
  check(
    "approval-deny",
    end2.isTerminal !== false && tee2?.isError === true,
    `tool denied (isError=${tee2?.isError}); retry dialogs seen: ${extraDialogs}`,
  );
  const exitB = await b.close();
  check("graceful-reap-b", exitB.code === 0, `stdin EOF -> exit ${exitB.code}`);

  // ---- S13: SIGTERM reaping + session file integrity
  const c3 = spawnClient(["--models", "opencode-go/*", "--model", "opencode-go/deepseek-v4-flash"]);
  await c3.waitFor("ready", undefined, 15_000);
  const tC = await runTurn(c3, "Reply with exactly the word: sigterm");
  check("sigterm-session", tC !== null, "one turn persisted before the kill");
  const stC = (await c3.getState()).data;
  const exitC = await c3.kill("SIGTERM");
  // Node reports omp's signal death on macOS as code 143 with signal null — either shape
  // means the process died by SIGTERM, not a graceful stdin-EOF exit.
  check(
    "sigterm-reap",
    exitC.code === 143 || exitC.signal === "SIGTERM",
    `code=${exitC.code}, signal=${exitC.signal}`,
  );
  let lastLine = "";
  let tailParses = false;
  try {
    lastLine = readFileSync(stC.sessionFile, "utf8").trimEnd().split("\n").at(-1) ?? "";
    JSON.parse(lastLine);
    tailParses = true;
  } catch (readErr) {
    info("sigterm-file", `could not verify: ${(readErr as Error).message}`);
  }
  check(
    "sigterm-file-consistent",
    tailParses,
    `session file ${String(stC.sessionFile).split("/").pop()} tail line parses (${lastLine.length} bytes)`,
  );

  log(`\n== Summary: ${passed} passed, ${failed} failed ==`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((caught) => {
  err("prototype crashed: " + String(caught));
  process.exitCode = 1;
});
