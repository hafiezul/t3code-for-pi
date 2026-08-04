# Pi's settings.json surface, for the T3 config editor

Research asset for wayfinder ticket [Map pi's settings.json surface for the T3 config editor](https://github.com/hafiezul/t3code-for-pi/issues/56) (map [Pi provider v2](https://github.com/hafiezul/t3code-for-pi/issues/53)).

Everything below was verified against pi 0.83.0 source at
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/` (settings-manager.js,
config.js, migrations.js, agent-session.js, resource-loader.js) and
`docs/settings.md`, unless a source is cited inline.

## Where the file lives

```
<agentDir>/settings.json
```

`agentDir` resolution (config.js `getAgentDir`), in order:

1. `PI_CODING_AGENT_DIR` env var (the var name is `${APP_NAME}_CODING_AGENT_DIR`; `~` is expanded) — per-process override,
2. otherwise `join(homedir(), ".pi", "agent")` — i.e. `~/.pi/agent` on Unix, `%USERPROFILE%\.pi\agent` on Windows.

The `.pi` component is `CONFIG_DIR_NAME`, which a package can override via its `piConfig.configDir`.
T3 should read the same env var the pi subprocess will see (its own env; launchArgs could alter the
subprocess env — treat an unset env var as `~/.pi/agent`).

The file is plain strict JSON (no comments, no trailing commas — JSON5 is not supported). A missing
file is fine: everything falls back to defaults. Permissions observed on a real install: `0644`.

Project override `.pi/settings.json` (relative to the pi cwd) merges on top of global; editing it
is out of scope for the T3 editor (map decision), but the merge semantics below define what pi
actually _uses_.

### Adjacent files the editor must never touch

| File                                                       | Content                     | Note                                       |
| ---------------------------------------------------------- | --------------------------- | ------------------------------------------ |
| `auth.json`                                                | provider credentials (0600) | migrated out of settings.json; never touch |
| `models.json`                                              | custom model definitions    | separate CLI-managed surface               |
| `trust.json`                                               | project trust decisions     | out of scope (map)                         |
| `mcp.json`, `mcp-cache.json`                               | MCP config/cache            | CLI-managed                                |
| `fast-mode.json`, `run-history.jsonl`, `models-store.json` | package/state files         | package-owned                              |

## Full key inventory

The file is a flat JSON object; the "sections" in the docs are organizational. Keys are exactly the
top-level fields below. Types/defaults from docs/settings.md; setters verified in settings-manager.js.

### Model & thinking

| Key                    | Type                                                                                        | Default | pi-managed?                                 |
| ---------------------- | ------------------------------------------------------------------------------------------- | ------- | ------------------------------------------- |
| `defaultProvider`      | string                                                                                      | —       | settable (`setDefaultProvider`)             |
| `defaultModel`         | string                                                                                      | —       | settable (`setDefaultModel`)                |
| `defaultThinkingLevel` | string: `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"` | —       | settable                                    |
| `hideThinkingBlock`    | boolean                                                                                     | `false` | settable                                    |
| `showCacheMissNotices` | boolean                                                                                     | `false` | settable                                    |
| `thinkingBudgets`      | object of number per level                                                                  | —       | read-only (`getThinkingBudgets`), no setter |

### UI & display

| Key                      | Type                                                                        | Default                                  | pi-managed?                                         |
| ------------------------ | --------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------- |
| `theme`                  | string                                                                      | `"dark"`                                 | settable                                            |
| `externalEditor`         | string (shell command)                                                      | `$VISUAL` → `$EDITOR` → `notepad`/`nano` | read-only                                           |
| `quietStartup`           | boolean                                                                     | `false`                                  | settable                                            |
| `defaultProjectTrust`    | `"ask"` \| `"always"` \| `"never"`                                          | `"ask"`                                  | settable; **global only**                           |
| `collapseChangelog`      | boolean                                                                     | `false`                                  | settable                                            |
| `enableInstallTelemetry` | boolean                                                                     | `true`                                   | settable                                            |
| `enableAnalytics`        | boolean                                                                     | `false`                                  | settable                                            |
| `trackingId`             | string (uuid)                                                               | —                                        | **pi-generated** on analytics opt-in (`randomUUID`) |
| `doubleEscapeAction`     | `"tree"` \| `"fork"` \| `"none"`                                            | `"tree"`                                 | settable                                            |
| `treeFilterMode`         | `"default"` \| `"no-tools"` \| `"user-only"` \| `"labeled-only"` \| `"all"` | `"default"`                              | settable                                            |
| `editorPaddingX`         | number 0–3                                                                  | `0`                                      | settable                                            |
| `outputPad`              | 0 \| 1                                                                      | `1`                                      | settable                                            |
| `autocompleteMaxVisible` | number 3–20                                                                 | `5`                                      | settable                                            |
| `showHardwareCursor`     | boolean                                                                     | `false`                                  | settable                                            |

### Network

| Key         | Type       | Default | pi-managed?                |
| ----------- | ---------- | ------- | -------------------------- |
| `httpProxy` | string URL | —       | read-only; **global only** |

### Warnings / compaction / branch summary / retry

| Key                              | Type    | Default     |
| -------------------------------- | ------- | ----------- |
| `warnings.anthropicExtraUsage`   | boolean | `true`      |
| `compaction.enabled`             | boolean | `true`      |
| `compaction.reserveTokens`       | number  | `16384`     |
| `compaction.keepRecentTokens`    | number  | `20000`     |
| `branchSummary.reserveTokens`    | number  | `16384`     |
| `branchSummary.skipPrompt`       | boolean | `false`     |
| `retry.enabled`                  | boolean | `true`      |
| `retry.maxRetries`               | number  | `3`         |
| `retry.baseDelayMs`              | number  | `2000`      |
| `retry.provider.timeoutMs`       | number  | SDK default |
| `retry.provider.maxRetries`      | number  | `0`         |
| `retry.provider.maxRetryDelayMs` | number  | `60000`     |

All nested setters exist (`setCompactionEnabled`, `setRetryEnabled`, …). The merge (below) means a
project override of `compaction.reserveTokens` replaces just that nested key.

### Message delivery / terminal / images / shell / sessions / cycling / markdown

| Key                             | Type                                                         | Default           |
| ------------------------------- | ------------------------------------------------------------ | ----------------- |
| `steeringMode`                  | `"all"` \| `"one-at-a-time"`                                 | `"one-at-a-time"` |
| `followUpMode`                  | `"all"` \| `"one-at-a-time"`                                 | `"one-at-a-time"` |
| `transport`                     | `"sse"` \| `"websocket"` \| `"websocket-cached"` \| `"auto"` | `"auto"`          |
| `httpIdleTimeoutMs`             | number                                                       | `300000`          |
| `websocketConnectTimeoutMs`     | number                                                       | `15000`           |
| `terminal.showImages`           | boolean                                                      | `true`            |
| `terminal.imageWidthCells`      | number                                                       | `60`              |
| `terminal.clearOnShrink`        | boolean                                                      | `false`           |
| `terminal.showTerminalProgress` | boolean                                                      | `false`           |
| `images.autoResize`             | boolean                                                      | `true`            |
| `images.blockImages`            | boolean                                                      | `false`           |
| `shellPath`                     | string                                                       | —                 |
| `shellCommandPrefix`            | string                                                       | —                 |
| `npmCommand`                    | string[] (argv)                                              | —                 |
| `sessionDir`                    | string (path, `~` ok)                                        | —                 |
| `enabledModels`                 | string[] (patterns)                                          | —                 |
| `markdown.codeBlockIndent`      | string                                                       | `"  "`            |

### Resources

| Key                   | Type                      | Default | Note                                                                                        |
| --------------------- | ------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `packages`            | array of string \| object | `[]`    | string form loads all; object form filters `{source, extensions, skills}` (see packages.md) |
| `extensions`          | string[]                  | `[]`    | glob/exclusion patterns (`+`/`-` prefixes)                                                  |
| `skills`              | string[]                  | `[]`    | same pattern language                                                                       |
| `prompts`             | string[]                  | `[]`    | same                                                                                        |
| `themes`              | string[]                  | `[]`    | same                                                                                        |
| `enableSkillCommands` | boolean                   | `true`  |                                                                                             |

Paths in global settings resolve relative to the agent dir; in project settings, relative to `.pi`.
Absolute paths and `~` are supported. The `packages` array on a real install mixes strings and
objects (e.g. `"npm:pi-subagents"` and `{"source": "npm:pi-lens@3.8.47", "extensions": ["-index.ts"], "skills": [...]}`).

### pi-managed keys (not user settings)

- `lastChangelogVersion` — written by pi on update/changelog display. Present on every real install.
- `trackingId` — generated when analytics is enabled.
- Legacy `apiKeys` — consumed by a one-time startup migration into `auth.json` and deleted from
  settings.json (see below). The editor should not resurrect it.

## Load & merge semantics (verified)

- Settings are read **once per process**, at session construction (`SettingsManager.create` in
  agent-session-services.js / sdk.js / main.js). No `fs.watch` on settings.json exists anywhere in
  the dist (the only watchers are git-head/ref-table files in footer-data-provider.js and theme files in theme.js).
- Global and project files are each parsed independently; then
  `settings = deepMergeSettings(global, project)`:
  - top-level: for each key present in the override, the override value wins;
  - nested: if **both** sides' value for a key is a plain non-array object, they merge one level
    (`{...base, ...override}`) — _exactly_ one level, not deep-recursive;
  - arrays and primitives: override replaces entirely.
- Malformed JSON in either file is caught at load: that scope loads as `{}` and an error is
  recorded (`globalSettingsLoadError` / `projectSettingsLoadError`). pi **does not crash** — it runs
  on defaults. Recovery is manual: fix the file, restart.
- Migrations rewrite settings in memory and on write: `queueMode`→`steeringMode`,
  `websockets` boolean→`transport`, old `skills` object→array + `enableSkillCommands`,
  `retry.maxDelayMs`→`retry.provider.maxRetryDelayMs`.

## When do edits take effect? (verified)

- **Next pi process start.** There is no hot reload: a session reads settings once at construction.
- A running _interactive_ TUI session re-reads on `/reload` (interactive-mode.js → `session.reload()`
  → `settingsManager.reload()` + resource reload). Extensions can trigger the same via `ctx.reload()`.
- RPC-mode sessions (what T3 spawns) have **no reload path** — no RPC settings commands exist
  (rpc.md documents only that `/settings` is interactive-mode-only). So for T3: **changes take
  effect on the next session** (a fresh pi subprocess). T3 must not tell the user "applied" while
  the current session still runs old values — restart the pi session or label the change "takes
  effect on new sessions".

## Write safety

### pi's own write path (the contract T3 should mirror)

`SettingsManager.save()` → `persistScopedSettings()`:

1. Take `proper-lockfile` lock on the settings file (`lockSync(path, { realpath: false })`, lock
   sibling `<path>.lock`, retry 10 × 20 ms on `ELOCKED`). Reads take the lock too.
2. **Re-read the file from disk**, parse (migrating), and merge **only the fields modified this
   session** over the current content. Unknown keys — anything pi doesn't know — survive untouched.
3. Write the whole file with `JSON.stringify(merged, null, 2)` (2-space indent, no trailing
   newline).
4. Release the lock.

Consequences:

- pi never clobbers unknown keys; the file on disk is the union of pi's writes and anything else.
- Two pi processes (or pi + T3) can't tear the file: all writers use the same lockfile protocol.
  T3 must use `proper-lockfile` with the same path and options to actually participate — a lock
  under a different name is no lock at all.
- If the file was malformed at load, `save()` returns early: pi **refuses to write** to a file it
  couldn't parse, so a bad file persists until fixed by hand. It never self-repairs.
- Startup migrations (`migrations.js`) rewrite settings.json with a raw `writeFileSync` **without
  the lock**, once, only when a legacy `apiKeys` field exists and `auth.json` is absent. Rare and
  one-time, but it means pi can touch the file at process start — T3 should re-read before writing
  rather than trusting a cached copy.

### T3's recommended contract

- **Curated keys** (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`): read-modify-write —
  read the file, set/replace exactly those keys, write. This preserves unknown and pi-managed keys
  and mirrors `setDefaultModelAndProvider`-style semantics. Missing file → start from `{}`.
- **Raw JSON field**: full-file editor — the user's edit _is_ the content. Validate with strict
  `JSON.parse` before writing; **never write malformed JSON**. Because pi treats a malformed file
  as "everything default" and refuses further writes, a T3-caused malformed file would silently
  reset the user's pi config — the worst kind of failure. On parse error: block the save, show the
  error, keep the editor open.
- Write discipline (both modes): take the same lock (`proper-lockfile`, `{ realpath: false }` on
  the resolved settings path), re-read immediately before writing, write with 2-space indent.
- Env/trust nuance: pi's own writes only happen from interactive sessions (`/settings`, `pi config`,
  model selector) — T3-spawned RPC sessions never write settings.json, so in practice T3 is the
  only writer; the lock still matters for a user who has both T3 and a TUI session open.

## Curated key set (recommendation)

Per the map's charting decision: `defaultProvider`, `defaultModel`, `defaultThinkingLevel` only.

- `defaultProvider` — string, provider id (e.g. `"anthropic"`, `"opencode-go"`); no validation in
  pi beyond being a string; invalid values fall through to defaults at session start.
- `defaultModel` — string, model id; same.
- `defaultThinkingLevel` — enum `off | minimal | low | medium | high | xhigh | max`; invalid
  strings are not rejected at load (no validation in `getDefaultThinkingLevel`) but the TUI treats
  them as unset — the form should constrain to the enum.

All three have no default and no pi-managed side effects. `theme` is the tempting fourth; it is
already surfaced elsewhere in pi's UI and charting excluded it — keep the curated set at three.

## Windows notes

- File: `%USERPROFILE%\.pi\agent\settings.json` (`homedir()` + `.pi` + `agent`; Node's `homedir`
  honors `USERPROFILE`).
- `PI_CODING_AGENT_DIR` override works identically on Windows (path separators via `path.join`).
- Path-valued settings (`shellPath`, `sessionDir`, resource paths) accept `~` and absolute paths;
  docs show `"shellPath": "C:\\cygwin64\\bin\\bash.exe"`. Pi requires bash on Windows (Git Bash,
  Cygwin, MSYS2, or WSL); `npmCommand` argv exists for package-manager wrappers.
- Nothing Windows-specific in the merge or write path — the lockfile protocol and JSON rules are
  identical. On-Windows end-to-end verification of the T3 editor lands with the implementation
  tickets.

## Facts the config editor design (#59) should assume

1. Editor targets exactly one file: `~/.pi/agent/settings.json` (env-overridable).
2. Strict JSON, no comments; 2-space indent convention; missing file = all defaults.
3. No hot reload: apply = next pi session (T3 restarts the session or says so).
4. Never write malformed JSON; never write without re-reading; lock with proper-lockfile
   (`realpath: false`) on the same path pi locks.
5. Curated keys write by merge; raw JSON writes the whole file the user sees.
6. Unknown keys and `lastChangelogVersion`/`trackingId` must survive every write.
7. `auth.json`, `models.json`, `trust.json`, `mcp.json` are different surfaces — never in the editor.
