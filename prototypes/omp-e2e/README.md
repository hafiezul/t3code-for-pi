# Prototype: OMP end-to-end session under T3

Wayfinder ticket: [Prototype: OMP end-to-end session under T3](https://github.com/hafiezul/t3code-for-pi/issues/67)
(map: [OMP as a first-class provider in T3 Code](https://github.com/hafiezul/t3code-for-pi/issues/62)).

## The question

Does the orchestration mapping in `docs/adr/0001-omp-orchestration-mapping.md` hold against
the real `omp` binary? Concretely: session spawn/reap, turn settle (`agent_end` +
`isTerminal !== false`), abort wire ordering, approval dialogs (`select` with
`["Approve", "Deny"]`), mid-thread model switch, and the **in-place `branch` rewind** that the
"checkpoint restore" grilling ticket builds on — including whether the running RPC process
picks up the rewound leaf without a restart.

## Run

```sh
npm run prototype:omp-e2e
```

Prerequisites: `omp` on `PATH` (v17.2.7 observed), and a credential for the model provider —
`OPENCODE_API_KEY` in the environment, or a stored credential readable via
`omp token opencode-go` (the runner falls back to that automatically). The runner needs a
provider key because it drives real model turns.

The run is fully sandboxed under a fresh `/tmp/omp-e2e-*` dir (printed at start): an isolated
`HOME` so OMP's agent dir never touches `~/.omp`, a scratch `--session-dir`, and a
git-initialized worktree carrying a `.t3/userdata/state.sqlite` seeded via `VACUUM INTO` from
`~/.t3/userdata` (AGENTS.md rules: live `~/.t3/userdata`, `~/.omp`, `~/.pi` are never written).
The seed is cached at `/tmp/omp-e2e-seed/state.sqlite` so re-runs don't re-copy the live DB.

## What it does

| #       | Scenario                                                                                                   | Validates                                                  |
| ------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| S1      | spawn `--mode rpc`, `ready` handshake, startup frames (`available_commands_update`, extension `setWidget`) | ADR 6: `ready` gate; extension frames in plain `rpc` mode  |
| S2      | `negotiate_protocol` v2                                                                                    | inventory §1: v2 opt-in                                    |
| S3      | unknown command (`get_commands`) error shape                                                               | recoverability: `success:false` + `Unknown command`        |
| S4      | `get_state` on a fresh session                                                                             | session file/id shape                                      |
| S5      | model catalog + `set_model` mid-session                                                                    | inventory §6 model surface                                 |
| S6–S7   | two real model turns, settle on `agent_end` + `isTerminal`                                                 | ADR 1: turn lifecycle                                      |
| S8      | `branch` rewind to an earlier entry, then continue in the same process                                     | in-place rewind picked up live (checkpoint-restore ticket) |
| S9      | abort mid-tool; ordering of abort response vs trailing `agent_end`                                         | ADR 1: abort wiring                                        |
| S10     | graceful reap via stdin EOF                                                                                | inventory §2: exit 0                                       |
| S11–S12 | `--approval-mode always-ask`: `select` dialog, Approve and Deny paths                                      | ADR 4: approvals as `["Approve","Deny"]` select dialogs    |
| S13     | SIGTERM reap + session-file integrity                                                                      | inventory §2: no SIGTERM handler, file stays consistent    |

The liftable part is `rpc.ts` (JSONL framing, id-correlated responses, `ready` gate, settle
rule) — the future `OmpDriver` should take its shape. `index.ts` is throwaway harness.

## Findings

See `NOTES.md` for the verdict per scenario and what broke.
