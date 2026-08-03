# Provider architecture

> For maintainers. Using T3 Code? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. T3 Code supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with five entries:

| Driver kind   | Driver source                           |
| ------------- | --------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]       |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]     |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]     |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]         |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode] |
| `pi`          | [`Drivers/PiDriver.ts`][pi]             |

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

## Pi

Pi runs as a long-lived JSONL-over-stdio subprocess: `pi --mode rpc` in the project cwd. One
process per thread, spawned lazily and reaped when idle; the launch rule is decided in the wayfinder
map tickets ([launch surface][pi-launch], [adapter design][pi-adapter], [restore][pi-restore]), and
the protocol mapping is in [pi-provider/model-picker.md](./pi-provider/model-picker.md) and the RPC
contract research. Key points:

- **Sessions**: `--session-dir <state>/pi/sessions/<cwd-hash>` plus `--session-id <threadId>` for
  create-or-resume, switching to `--session <file>` after a fork. The resume cursor stores the
  session file plus the per-turn `leafId` boundaries recorded at each `agent_settled`.
- **Turn lifecycle**: `turn.completed` fires only on pi's `agent_settled` (never on per-assistant
  `turn_end`); `abort` suppresses the settle that follows it. Pi has no tool-permission prompts, so
  T3's approval machinery is inert: threads run full-access, `respondToRequest` is a no-op, and
  launch-time project trust is the only gate.
- **Events**: a table-driven translation maps `message_update` deltas, `tool_execution_*` items, and
  extension UI requests (`select`/`confirm` → `user-input.requested`, `input`/`editor` declined)
  onto orchestration events, with ignore-by-default fallthrough for unknown types.
- **Model picking**: the probe runs `pi --version` (gated at 0.80.5) then `pi --list-models`,
  flattened into `provider/model` slugs (first-`/` split; model ids may contain `/`) with a
  "Thinking" capability descriptor for rows pi marks `yes`. Mid-thread switches go through the RPC
  `set_model` command and apply on the next turn.
- **Maintenance**: npm-managed with full codex parity — version advisory against
  `@earendil-works/pi-coding-agent` on npm, inline "Update now" via the shared maintenance runner,
  and a copyable manual command.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

## How provider work is requested

Clients never call a provider directly. They dispatch orchestration commands over the RPC method
`orchestration.dispatchCommand`, defined with the rest of the orchestration surface in
[`orchestration.ts`][contracts]. The client-dispatchable provider-facing commands are
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, and `thread.session.stop`, plus the mode
setters `thread.runtime-mode.set` and `thread.interaction-mode.set`.

The engine persists an event for the command, and a server-side reactor performs the provider call.
Provider output comes back as internal commands such as `thread.message.assistant.delta` and
`thread.session.set`, which clients observe through `orchestration.subscribeThread`. See
[overview.md](./overview.md) for the command/event loop.

## Server-side workers

Provider work flows through three queue-backed workers. All three are built with
`makeDrainableWorker` from [`DrainableWorker.ts`][worker] and expose `drain` for deterministic test
synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

### Buffered assistant delivery

A thread in `buffered` assistant delivery mode accumulates assistant text instead of streaming each
delta. The buffer is not held until turn completion. In [`ProviderRuntimeIngestion`][ingest],
`MAX_BUFFERED_ASSISTANT_CHARS` is 24,000: the append that would exceed it invalidates the buffer and
spills the whole accumulated text as one delta. The buffer also flushes at interaction boundaries,
when a request opens (approval) or user input is requested, via
`flushBufferedAssistantMessagesForTurn`.

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[pi]: ../../apps/server/src/provider/Drivers/PiDriver.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[pi-launch]: https://github.com/hafiezul/t3code-for-pi/issues/45
[pi-adapter]: https://github.com/hafiezul/t3code-for-pi/issues/47
[pi-restore]: https://github.com/hafiezul/t3code-for-pi/issues/52
