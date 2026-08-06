# OMP provider orchestration mapping

OMP (`omp`, Oh My Pi) is a pi-lineage CLI with a richer RPC protocol than pi: settle is
`agent_end` + `isTerminal` (no `agent_settled`), tool approvals surface as generic
`extension_ui_request` `select` dialogs with options `["Approve","Deny"]`, subagents are
observable read-only, and session rollback goes through `branch` — which, corrected by the
checkpoint-restore ticket ([Grilling: How T3 checkpoint restore rewinds an OMP session](https://github.com/hafiezul/t3code-for-pi/issues/70),
asset [checkpoint-restore.md](../internals/omp-provider/checkpoint-restore.md)), **forks to a
new session file** over RPC (the in-place leaf move is TUI/ACP-only). Resolved in wayfinder
ticket [Grilling: OMP to T3 orchestration mapping](https://github.com/hafiezul/t3code-for-pi/issues/65)
(map: [OMP as a first-class provider in T3 Code](https://github.com/hafiezul/t3code-for-pi/issues/62)):
the OMP adapter is written fresh from the protocol (never cloned from the Pi adapter, which is
reference-only and untouched), and it maps onto T3's existing orchestration surface with no
contract changes.

## Decisions

1. **Turn lifecycle.** `turn.completed` fires only on `agent_end` with `isTerminal !== false`
   (field absent = terminal) — never per-assistant `turn_end`, exactly as Pi keys on
   `agent_settled`. An `agent_end` with `isTerminal: false` (maintenance scheduled more work)
   keeps the turn open. On abort, a suppress flag is armed _before_ sending `abort` (OMP's
   `success:true` response lands after the stream winds down); the trailing `agent_end` is
   swallowed and the turn closes via `turn.aborted`, matching Pi's behavior.
2. **Message and tool translation.** Pi's table, verbatim: assistant-role `message_start`/`end`
   become `assistant_message` items with `message_update` deltas attaching live;
   `tool_execution_start`/`end` become tool items (failed on `isError`); user echoes and
   `role: "toolResult"` messages are skipped (tool output belongs to the tool item);
   `auto_compaction_*` becomes a `context_compaction` item; `agent_end.messages` snapshots are
   never re-rendered.
3. **Extension UI.** Pi's mapping: `select`/`confirm`/`input`/`editor` →
   `user-input.requested` (options/text/editor answer kinds); `notify`/`setStatus` →
   `extension.notice`/`extension.status`. OMP's additions are dropped by default:
   `setWidget`, `setTitle` (off unless `PI_RPC_EMIT_TITLE=1`), `set_editor_text`, `open_url`
   (RPC OAuth login is out of scope; auth comes from config/env). A `cancel` frame just drops
   the pending request from the map — T3's user-input contract has no cancel shape and turn
   interruption is the way out.
4. **Approvals.** A `select` dialog whose options are exactly `["Approve","Deny"]` is an
   approval: the adapter emits `request.opened` with `requestType: "dynamic_tool_call"` (the
   safety prompt rides in `detail`) and answers `thread.approval.respond` via
   `extension_ui_response` `{ value: "Approve" | "Deny" }`. T3's approval policy / runtime
   mode drives the launch flags: `full-access` → `--approval-mode yolo`, `approval-required` →
   `always-ask`, `auto-accept-edits` → `write`. `acceptForSession` has no OMP equivalent
   (approval mode is a launch flag, not runtime-switchable) and maps to a single `Approve`.
   This makes OMP the first T3 provider whose approval machinery is live, not inert.
5. **Mode.** T3 spawns OMP with `--mode rpc-ui`. `rpc-ui` is wire-identical to `rpc` (same
   `ready` hello, command surface, agent events, extension-UI frames — verified frame-by-frame
   on the 17.2.7 binary) but also exposes OMP's Ask tool, whose `select` dialogs flow through
   the decision-3 mapping into T3's user-input panel (an ask with free-text intent arrives with
   an "Other (type your own)" option; T3's panel accepts typed answers either way). Updated
   from the original `--mode rpc` choice: the two costs that motivated it did not survive
   verification against OMP 17.2.x. Deferred MCP discovery is a ~250 ms head-start either way
   (OMP races startup connects against a 250 ms bound and finishes slow servers in the
   background in both modes; rpc-ui merely starts discovery post-boot and registers pending
   tool stubs). Usage-reserve confirmation dialogs are never raised by RPC hosts: OMP installs
   the usage-fallback confirmer only in the interactive TUI and ACP, so both rpc and rpc-ui
   fall back silently (and the feature defaults off). Extension UI and approval dialogs flow in
   plain `rpc` too, but the Ask tool does not exist there — a headless agent that wanted to
   ask just wrote the question as text.
6. **Adapter shape.** Fresh `OmpDriver` (RPC client: `ready` handshake, JSONL framing,
   optional protocol-v2 negotiation for >1 MiB frames) + `OmpAdapter` + `OmpProvider`, reusing
   PiAdapter's T3-integration patterns (turn lifecycle, item table, pump, pending-request map,
   session-leaf boundaries persisted in the resume cursor) as architecture, not code. The
   adapter owns child teardown — OMP's RPC path registers no SIGTERM handler.

## Considered options (rejected)

- **Clone `PiAdapter.ts` → `OmpAdapter.ts` and adapt.** Faster start, but inherits pi-isms
  (`agent_settled` timing, `get_entries`-style cursors, inert approval plumbing) and 2000 lines
  of history to audit for wire mismatches.
- **Shared pi-family adapter base.** Cleanest long-term, but touches the never-modify Pi
  provider and builds abstraction for two consumers now.
- **Route approval dialogs as plain user-input questions.** Simpler, but leaves T3's approval
  chip, `notifyOnApproval`, and approval-policy settings inert; the destination names approval
  flows as a headline capability.
- **Keep `--mode rpc` (the original default).** Wire-identical for everything except the Ask
  tool, and the Ask tool was originally out of the destination's feature list. Retired when
  asking questions became a named capability: a model that needs input has no channel in rpc
  and falls back to writing the question as plain text, which T3 renders as a normal response.
  The original fear of mid-turn friction from rpc-ui (deferred MCP discovery, usage-reserve
  confirmation dialogs) did not survive verification against OMP 17.2.x — see decision 5.
- **`--mode rpc-ui` with the Ask tool stripped at the adapter.** Gets the same wire surface
  without model-visible questions; pays the same (non-)costs as rpc-ui and keeps the model
  without a question channel. Rejected: the Ask channel is the point.

## Consequences

- Approval recognition is a heuristic (exact option set `["Approve","Deny"]`); a user-facing
  extension using those exact options would be misclassified as an approval — an accepted,
  documentable rule.
- OMP's `write` approval tier semantics (what it prompts on) remain unverified; the
  `auto-accept-edits` → `--approval-mode write` mapping is the pinned design decision
  (`resolveOmpApprovalMode` in `OmpAdapter.ts`, covered by `OmpAdapter.test.ts`).
- `agent_end` with `isTerminal: false` keeps the T3 turn open; the boundary and resume-cursor
  mechanics key on terminal settles, which the checkpoint-restore ticket builds on.
- rpc-ui consequences: OMP's Ask tool is model-visible, and its dialogs surface as T3
  user-input questions (options plus OMP's literal "Other (type your own)" entry; typed
  answers ride the same `extension_ui_response` value). Custom tools and commands see
  `hasUI=true` in rpc-ui and may take interactive branches that plain rpc suppresses — all
  still flow through `extension_ui_request`, which the adapter maps. OMP's plan-mode
  enforcement (`ask` + `write` must both be registered) activates when plan mode is enabled,
  where it was skipped in rpc; T3 does not drive OMP plan mode, so this only matters for
  users who enable it through OMP config.
