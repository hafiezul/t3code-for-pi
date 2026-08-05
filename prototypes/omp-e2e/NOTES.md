# NOTES — findings of the OMP end-to-end prototype

Wayfinder ticket: [Prototype: OMP end-to-end session under T3](https://github.com/hafiezul/t3code-for-pi/issues/67)
(map: [OMP as a first-class provider in T3 Code](https://github.com/hafiezul/t3code-for-pi/issues/62)).
Ran 2026-08-05 against `omp` 17.2.7 (Homebrew, `~/.local/bin/omp`), provider
`opencode-go/deepseek-v4-flash`, sandboxed under `/tmp/omp-e2e-*` (isolated HOME, scratch
`--session-dir`, git-initialized worktree with `.t3/userdata` seeded via `VACUUM INTO` from
`~/.t3/userdata`). Live `~/.t3/userdata`, `~/.omp`, `~/.pi` never written.

**Result: 24/24 checks passed.** The orchestration mapping in
`docs/adr/0001-omp-orchestration-mapping.md` holds against the real binary, with the
corrections and new facts below.

## What the design conversations got right (now verified live)

- **Settle** (ADR 1): `agent_end` + `isTerminal !== false` closes a turn — confirmed across
  repeated turns; every settle carried exactly the 2 messages of its turn, and
  `get_messages` persisted all turns.
- **Abort** (ADR 1): the `abort` response arrives _after_ the stream winds down and _before_
  the trailing `agent_end` — exactly the ordering the suppress-flag design assumes. The
  aborted assistant message has `stopReason: "aborted"`, `errorMessage: "Interrupted by user"`;
  the in-flight tool ends `isError: true` with `[Command cancelled]`.
- **Approvals** (ADR 4): `--approval-mode always-ask` surfaces a generic
  `extension_ui_request` `select` dialog with options exactly `["Approve","Deny"]` and a
  human-readable title (`Allow tool: bash\nCommand: echo approved-ok`). Approve runs the tool
  (`isError: false`); Deny fails it (`isError: true`) and the turn still settles.
- **Extension frames in plain `--mode rpc`** (ADR 5): startup `setWidget(autoresearch)` and
  the full `available_commands_update` (38 commands: builtin=34, extension=1, custom=2,
  file=1) flow without `rpc-ui`.
- **Model switch**: `set_model` mid-thread succeeds and `get_state.model` reflects it
  immediately; subsequent turns run under the new model.
- **v2 negotiation** and unknown-command recovery (`get_commands` → `Unknown command:
get_commands`, `success: false`) work as inventoried.
- **Graceful reap**: stdin EOF → clean exit 0.

## Headline for the checkpoint-restore ticket

**`branch` rewinds in place and the _running_ RPC process picks it up — no restart.**

- `get_branch_messages` returns message-level entries with `entryId` (`{entryId, text}`); the
  `branch` command takes one and responds `{ cancelled: false }`.
- After `branch(entry-of-turn-2)`, `get_messages` immediately returned only turn 1
  (4 → 2 messages) — same process, same session file.
- The next `prompt` appended to the rewound leaf (`done | rewound`, no `again` anywhere in
  `get_messages`), and the JSONL file is append-only: the abandoned path survives as
  unreachable entries, which is exactly the "abandoned path survives as a branch" model the
  grilling ticket assumed.
- So T3's `REVERT_TO_CHECKPOINT` maps to `branch(<entryId of the checkpoint boundary>)` with
  **no process restart**, and the session file stays a single file.

## What the design conversations got wrong / missed

1. **Cold catalog discovery can hang for minutes.** `get_available_models` across all
   providers (inherited `ANTHROPIC_API_KEY` + gateway env included) returned nothing within
   180s in one run (2 × 180s timeouts). The adapter must not block the critical path on it:
   lazy-load, cache, or restrict discovery with `--models <patterns>`. `set_model` also
   awaits background discovery on a cold start. **This feeds the version-gate ticket**
   (model catalog decision): treat the catalog as optional/best-effort.
2. **Deterministic model pinning needs spawn flags, not just env.** With both
   `ANTHROPIC_API_KEY` and `OPENCODE_API_KEY` in the environment, the default model was
   `anthropic/claude-opus-4-8` even though the adapter injected the opencode key. Spawning
   with `--model provider/model` (plus `--models provider/*` to scope discovery) is the
   deterministic path. **Feeds the settings-surface ticket** (launch args + model picking).
3. **Delta streaming is provider-dependent.** The opencode-go turns streamed 36–40
   `message_update` deltas; the earlier anthropic-gateway turns streamed **zero** (start/end
   only). The adapter's delta translation must tolerate non-streaming providers.
4. **Node reports omp's SIGTERM death as `code 143, signal null` on macOS** — not
   `(null, "SIGTERM")`. The adapter's teardown logic must treat non-zero exit (143) as
   signal death, not graceful exit.
5. **`get_state.sessionFile` is a planned path; the file doesn't exist until the first
   write.** Killing a process that never completed a turn yields `ENOENT` on the reported
   path. The adapter must not stat/read the session file before the first turn.
6. **Deny-path settle latency is variable.** One run stalled >120s after a Deny before
   `agent_end` (this run settled in seconds, no retry dialog). The adapter should auto-answer
   (or time out) any _additional_ `select` dialogs after a deny — the model may retry — and
   use a generous settle timeout.

## Harness notes (for whoever re-runs)

- `rpc.ts` is the liftable part (JSONL framing, id-correlated responses, `ready` gate,
  watermark-based settle so stale `agent_end` frames from previous turns are never consumed).
  `index.ts` is throwaway.
- The agent home is reused at `/tmp/omp-e2e-seed/home` so the `models.db` catalog cache
  survives runs; a stale-PID guard (`/tmp/omp-e2e.pid`) reaps leftover `omp --mode rpc`
  children on startup (they would otherwise hold `config.yml.lock` and deadlock the next
  run). Output is also appended to `/tmp/omp-e2e-run.log`.
- The `.t3` seed is cached at `/tmp/omp-e2e-seed/state.sqlite` (1.09 GB) so re-runs skip the
  `VACUUM INTO`.
