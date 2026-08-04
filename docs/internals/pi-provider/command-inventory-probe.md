# The pi command inventory probe

Research asset for wayfinder ticket [Design the pi command inventory probe](https://github.com/hafiezul/t3code-for-pi/issues/54) (map [Pi provider v2](https://github.com/hafiezul/t3code-for-pi/issues/53)).

Everything below was verified against pi 0.83.0 source at
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/` (rpc-mode.js,
agent-session.js, resource-loader.js, main.js, project-trust.js), `docs/rpc.md` §793,
`CHANGELOG.md`, and a live probe run against the installed pi, unless a source is cited
inline.

## The question

Where does pi's `get_commands` probe run, and how do its results reach T3's composer
menu? Concretely: probe placement (per-instance snapshot with which cwd? per-active-project
on demand? live session vs probe subprocess?), mapping to `ServerProviderSlashCommand`
(including `input.hint`), grouping/tagging of the three sources, and refresh + dedupe +
staleness policy.

## Decision

1. **Placement: per-instance snapshot, probe subprocess, `serverConfig.cwd`.** Add a
   third step to `checkPiProviderStatus`: `pi --mode rpc --no-session` + one
   `get_commands` line on stdin, stdout parsed for the `get_commands` response. Same
   cwd as the models probe, same snapshot cadence, same failure posture (commands are
   enrichment — a failed probe degrades to an empty list, never a failed provider).
2. **Mapping:** pi `name`/`description` → `ServerProviderSlashCommand` `name`/`description`
   verbatim (names are already invocation-ready, `skill:` prefix included). `input` is
   **left unset** — pi 0.83.0's `get_commands` carries no argument-hint; map
   `argumentHint` → `input.hint` (the Claude mapping) if a future pi emits it.
3. **Grouping: yes, the contract grows one optional field** — `group?: string` on
   `ServerProviderSlashCommand`, set from pi's `source`
   (`extension` → "Extension", `prompt` → "Prompt", `skill` → "Skill"). Claude leaves it
   unset and stays in the flat "Provider" section. Web renders subgroups when present;
   mobile ignores it.
4. **Refresh: the managed snapshot cadence** (default 5 min, `providerHealthRefreshInterval`),
   plus the existing settings-change refresh and the manual `serverRefreshProviders`
   action. No file watching. Dedupe server-side by lowercase name, first occurrence
   wins, ordered by pi's execution precedence (extension → skill → prompt).
5. **Out of scope:** per-project inventories (a project whose cwd ≠ `serverConfig.cwd`
   shows user-level commands but not that project's `.pi` resources) — same limitation
   Claude already has; a future effort, not v2.

## Why a probe subprocess, not the live session

The per-thread `pi --mode rpc` session (PiAdapter, spawned in the _project_ cwd, kept
alive across turns) is the only view guaranteed to match what pi will actually execute —
same cwd, same trust state, same loaded extensions. But the composer needs the menu
**before the first turn**, when no session exists, and the snapshot is per-instance while
sessions are per-thread. Chasing session state into the snapshot couples two lifecycles
for a menu that must render instantly. The probe subprocess is the smallest model that
works everywhere a snapshot works, and it is exactly the Claude precedent: Claude's
slash commands come from a snapshot-time probe (a Claude SDK session that never yields a
prompt) and its skills from `discoverClaudeSkills(claudeSettings, cwd)` — both at
`ServerConfig.cwd` (ClaudeDriver.ts:124-170).

A future refinement could answer `get_commands` from an _existing_ per-thread session to
get the exact project view, falling back to the probe; that is a separate decision.

## The wire path

```
checkPiProviderStatus (PiProvider.ts §206)
  └─ probe subprocess: pi --mode rpc --no-session  →  get_commands response
  └─ buildServerProvider({ ..., slashCommands })   (snapshot, per instance)
  └─ managed snapshot → providerStatusCache → serverStatus message → clients
  └─ web: selectedProviderStatus.slashCommands (ChatComposer.tsx §1087)
       → ComposerCommandMenu → "/name " insertion (§1715)
  └─ mobile: ThreadComposer.tsx §400 (flat list, same contract)
```

`slashCommands` already rides `ServerProvider` (§191, decoding-defaults to `[]`), so the
whole path exists; only the probe side and the group field are new.

## Empirical probe

Verified against the installed pi 0.83.0 with no session state:

```
printf '{"type":"get_commands"}\n' | pi --mode rpc --no-session --session-dir /tmp/pi-probe-test
```

- Returns 26 extension commands, 7 prompt templates, 33 skills (`skill:`-prefixed) —
  every entry with a `description`.
- **Boot noise:** several `extension_ui_request` (setStatus/setWidget) lines arrive on
  stdout _before_ the response. The parser must select the `{"command":"get_commands"}`
  response, not the first JSON line.
- `--no-session` makes the session in-memory (main.js:246 `SessionManager.inMemory`):
  nothing written to the session dir, no stray session files. `--session-dir` is then
  unnecessary — the probe can omit it.
- No model/auth required: `get_commands` reads `extensionRunner` + `promptTemplates` +
  `resourceLoader` only (rpc-mode.js:538-565). No API calls.

## The response shape is version-mobile — parse defensively

rpc.md §793 documents `{name, description?, source, location?, path?}`, but 0.83.0 emits
`{name, description, source, sourceInfo}` — the docs lag the code. CHANGELOG: `get_commands`
landed in 0.77-era ("Headless clients can now list available commands programmatically",
#994), `"template"` was renamed to `"prompt"`, and #1734 replaced `location`/`path` with
`sourceInfo.path` / `sourceInfo.scope` / `sourceInfo.source`. All of this predates the
`MINIMUM_PI_VERSION = "0.80.5"` gate, but the mapper should still:

- treat `name` as required, `description` as optional;
- read `source` (`extension|prompt|skill`); tolerate `"template"` as `prompt`;
- use `sourceInfo.scope` / `sourceInfo.path` when present for display/debug (seen
  values: `user`, `project`, `temporary`), never require them;
- ignore unknown fields.

## Mapping table

| pi `get_commands` (0.83.0) | `ServerProviderSlashCommand` | Notes                                                                                                                                                                                                                          |
| -------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`                     | `name`                       | verbatim; `skill:` prefix kept so `/skill:name ` expands via pi's `_expandSkillCommand`                                                                                                                                        |
| `description`              | `description`                | optional both sides                                                                                                                                                                                                            |
| —                          | `input.hint`                 | **unset**; no argument-hint in 0.83.0's response (prompt templates do have `argument-hint` frontmatter, but it is not emitted). Future-proof: map `argumentHint` → `input.hint`, mirroring `parseClaudeInitializationCommands` |
| `source`                   | `group` (**new, optional**)  | `extension`→"Extension", `prompt`→"Prompt", `skill`→"Skill"; absent for other providers                                                                                                                                        |

The `group` field is an additive, optional contract change — old producers decode to
absent, web renders the flat "Provider" section when no item carries a group, so Claude
and Codex are pixel-identical.

## Refresh, dedupe, staleness

- **Refresh:** the managed snapshot cadence — `providerHealthRefreshInterval`
  (default 5 min, `DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL` in contracts/settings.ts) —
  exactly like models. Settings changes re-run the probe (existing
  `makeManagedServerProvider` machinery), and the manual refresh action
  (`serverRefreshProviders`, already exposed to the web) forces one.
- **Install/remove while T3 runs:** picked up on the next cadence. pi itself loads
  resources only at process spawn — a running pi session does not see new extensions
  until `/reload-runtime` — so T3's cadence is no worse than pi's own semantics.
- **Dedupe:** pi merges its three sources into one list; duplicate names across sources
  are possible (pathological, since skills are `skill:`-prefixed). Order the flattened
  list by pi's execution precedence — extension commands run first in `session.prompt`
  (`_tryExecuteExtensionCommand`), then skill expansion, then template expansion — then
  dedupe by lowercase name keeping the first, mirroring `dedupeSlashCommands`
  (ClaudeProvider.ts:646).
- **Staleness:** bounded by the cadence; the composer replaces the whole list per
  snapshot, so there is no partial-stale state. No client-side TTL needed.

## Trust semantics (why the probe is consistent with sessions)

Project `.pi` resources load only when pi's trust store / `defaultProjectTrust` allow —
in RPC mode with no UI, untrusted projects silently load nothing (project-trust.js:
`hasUI` is false → trust store lookup → `false`). The probe inherits exactly the same
resolution as the per-thread sessions (the adapter passes no trust override), so the
menu can never show a command the session would refuse to load, or vice versa. User-level
resources (`~/.pi/agent/`) always load.

## Implementation notes for the build tickets

- **Probe (#60):** third `runPi` step in `checkPiProviderStatus`:
  `["--mode", "rpc", "--no-session"]`, write one `{"type":"get_commands"}` line, close
  stdin, collect stdout; filter lines to the `get_commands` response; parse with a
  tolerant decoder. Failure or timeout → empty list (never fail the snapshot). Fixed
  args — do not append user `launchArgs` (consistent with the models probe).
  Extend `PiProvider.test.ts`'s scripted spawner with a get_commands fixture including
  noise lines; assert mapping, `"template"` tolerance, and dedupe precedence.
- **Contract (#60):** add `group: Schema.optional(TrimmedNonEmptyString)` to
  `ServerProviderSlashCommand` (contracts/server.ts §81).
- **Web (#61):** `ComposerCommandMenu.groupCommandItems` — when any
  provider-slash-command item carries a `group`, render the Provider section as
  subgroups labeled by it (flat fallback when none do). Mobile `ThreadComposer` stays
  flat; no group rendering needed.
