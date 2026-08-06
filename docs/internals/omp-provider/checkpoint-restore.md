# OMP checkpoint restore: how T3's rewind maps onto OMP sessions

Resolution asset for wayfinder ticket [Grilling: How T3 checkpoint restore rewinds an OMP
session](https://github.com/hafiezul/t3code-for-pi/issues/70) (map [OMP as a first-class
provider in T3 Code](https://github.com/hafiezul/t3code-for-pi/issues/62)).

Source-verified 2026-08-05 against `can1357/oh-my-pi` at tag `v17.2.7` (commit
`a5090f1f8`, the same build the e2e prototype ran) and cross-checked against the prototype's
live evidence (`prototypes/omp-e2e/`, commit 98aab23) and this repo's checkpoint machinery.

## Correction to the map's standing assumption

The inventory and the prototype NOTES both claimed `branch` is an **in-place leaf rewind in
the same session file**. Source says otherwise:

- The RPC `branch` command forks to a **new session file**. `handleRpcSessionChange`
  (`rpc-mode.ts:468-482`) → `agent-session.branch()` (`agent-session.ts:7622`): the target
  entry must be a **user message** (`selectedEntry.message.role !== "user"` throws
  "Invalid entry ID for branching"); a non-root user message calls
  `createBranchedSession(parentId)` (`session-manager.ts:2340-2455`) which writes a new file
  `<timestamp>_<newSessionId>.jsonl` in the same session dir containing only the kept path,
  mints a new session id, and records `parentSession: <old file>` in the header; branching to
  the **root** user message calls `newSession` — a fresh, empty session file.
- The true in-place leaf move exists (`navigateTree`, `agent-session.ts:7853` — "stays in
  the same file", plus `session-manager.branch`/`setLeaf`, `session-manager.ts:2303-2310`)
  but is exposed over **ACP and the interactive TUI only** — not over the RPC command
  surface. T3 drives `--mode rpc-ui` (ADR 0001), so it cannot reach it.
- The prototype's "same process, same session file" was an inference — it never checked
  `get_state.sessionFile`/`sessionId` after branching. Its observations (4 → 2 messages,
  continuation appends cleanly) are fully consistent with the fork reading: the new file
  contains the kept path, the process continues in it.

Consequences that stand: no process restart (the running process picks the fork up
immediately — prototype verified continuation live), and the abandoned path survives — in
the **old file**, untouched, reachable later via `switch_session` or the OMP TUI, exactly as
the OMP session-tree model intends.

## T3 side: the contract the adapter implements

- Command path: `thread.checkpoint.revert { turnCount }` → `CheckpointReactor.handleRevertRequested`
  (`apps/server/src/orchestration/Layers/CheckpointReactor.ts`): restores the workspace to the
  turn's git checkpoint ref (`refs/t3/checkpoints/<thread>/turn/<n>`, `fallbackToHead` for
  turn 0), deletes stale refs, then `providerService.rollbackConversation({ threadId,
numTurns })` with `numTurns = currentCheckpointTurnCount − targetTurnCount`. The reactor has
  **no session-state guard** — the adapter is the guard. `thread.reverted` prunes the read
  model (messages, activities, plans) to the kept turns.
- Adapter contract: `rollbackThread(threadId, numTurns)` (`ProviderService.rollbackConversation`
  → adapter `rollbackThread`). Pi's implementation (`PiAdapter.ts:1890-2047`) is the reference
  pattern: per-settle boundary bookkeeping, mid-turn guard, unmappable-target warning, cursor
  rebind after the rewind.

## Decisions

1. **Rewind mechanism: RPC `branch(entryId)`, fork accepted.** There is no in-place rewind
   over RPC; the fork is the mechanism. The adapter sends `branch(<entryId of the first
discarded turn's user prompt>)`, then re-reads `get_state` and refreshes
   `sessionFile`/`sessionId` in the resume cursor (mirroring Pi's post-fork rebind), then
   re-subscribes subagents (see 4). Rejected: driving ACP mode to reach `navigateTree`
   (violates ADR 0001's `--mode rpc-ui`; a second protocol adapter) and relaunching the process
   (unnecessary — the fork is live).
2. **Mid-turn guard: refuse while streaming.** `prompt` is fire-and-forget
   (`rpc-mode.ts:1029` — "Don't await - events will stream"), so `branch` can arrive
   mid-turn, and — unlike `newSession` — `branch` does **not** abort the agent
   (`agent-session.ts:7622-7718`); a mid-stream fork tears the session under the stream.
   `rollbackThread` refuses while a turn is in flight (adapter-local in-flight state, or
   `get_state.isStreaming`), with a clear error, exactly as Pi does.
3. **Boundary bookkeeping: per-settle recording, Pi pattern.** The `prompt` response carries
   no entry id (`{ agentInvoked: boolean }`, `rpc-types.ts:207`). After each terminal settle,
   the adapter calls `get_branch_messages` (in-memory; returns every user message with its
   `entryId`, `rpc-mode.ts:1311-1314`) and pushes the last entry id onto a `turnBoundaries`
   list; rollback targets `boundaries[keptCount]` where `keptCount = boundaries.length −
numTurns`; the list is truncated to `keptCount` on rollback and persisted in the resume
   cursor. Rewind to turn 0 = `branch(boundaries[0])` — OMP's own root handling turns that
   into a fresh empty session. Entry ids of the kept path survive the fork unchanged, so a
   truncated list stays valid. Unmappable target (list shorter than `numTurns`, e.g. a
   pre-feature session) → `runtime.warning` + no-op, mirroring Pi decision 7.
4. **Subagent state: re-subscribe only.** The session change clears OMP's subagent RPC
   subscription server-side (`subagentRegistry?.clear()`, `rpc-mode.ts:477-481`); the adapter
   re-issues `set_subagent_subscription` after every branch. Old transcripts stay orphaned in
   the old file's artifacts dir — `createBranchedSession` resets the artifact manager
   (`#artifactManager = null`, `session-manager.ts:2413-2414`), and the new session's dir is
   created lazily — and T3's read model keeps the subagent rows (ticket "Grilling: Subagent
   surfacing design" decided rows persist; they are historical work-log entries).
5. **Model/thinking state: keep current process state.** Model and thinking level are process
   state, not per-file; a branch leaves them unchanged. T3 restores no provider's model
   selection on revert, and mid-thread switching is already handled by the version-gate
   ticket's `set_model` flow — no per-checkpoint capture.

## Implementation checklist for `OmpAdapter.rollbackThread`

- [ ] Validate `numTurns` (integer ≥ 1); no session bound → no-op success.
- [ ] Refuse while a turn is in flight (mirror Pi's `get_state.isStreaming` guard message).
- [ ] `keptCount = boundaries.length − numTurns`; `keptCount < 0` → warning + no-op.
- [ ] `branch(boundaries[keptCount])` (uniform for turn 0 via OMP's root → `newSession`).
- [ ] On success: re-read `get_state`, rebind `sessionFile`/`sessionId` in the resume
      cursor; truncate `turnBoundaries` to `keptCount`; re-issue `set_subagent_subscription`.
- [ ] On `cancelled: true` (a `session_before_branch` extension veto): fail loudly, like Pi.
- [ ] Session-file semantics: `get_state.sessionFile` is the new file path; the old file
      remains on disk as the abandoned path (never delete it).
