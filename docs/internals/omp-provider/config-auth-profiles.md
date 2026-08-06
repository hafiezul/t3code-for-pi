# OMP's config, auth, and profile surfaces, for the T3 settings surface

Research asset for wayfinder ticket [Research: OMP config, auth, and profile surfaces](https://github.com/hafiezul/t3code-for-pi/issues/64) (map [OMP as a first-class provider in T3 Code](https://github.com/hafiezul/t3code-for-pi/issues/62)).

Verified 2026-08-04 against the installed omp v17.2.7 binary (`~/.local/bin/omp` → `/opt/homebrew/bin/omp`, Homebrew) — `--help`, `config --help/list/path`, `token --help`, `models --help`, `update --help`, `auth-broker --help`, `auth-gateway --help` — and the live home `~/.omp`, read-only (SQLite opened with `mode=ro`). The npm package `@oh-my-pi/pi-coding-agent` is not installed on this machine; its layout is
unverified. The package name itself is pinned by the OMP driver's maintenance resolver
(`OmpDriver.ts` — npm-only distribution, no Homebrew formula, no native updater), so Homebrew
installs get the version advisory without an inline update.

## Where things live

`PI_CODING_AGENT_DIR` env var selects the agent home (default `~/.omp/agent`). Observed layout:

| Path                                                    | Content                                                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<agent>/config.yml`                                    | Settings (see below). Sparse YAML — most settings stay at defaults                                                                                                              |
| `<agent>/config.yml.lock`                               | Lock file held while a session runs                                                                                                                                             |
| `<agent>/models.yml`                                    | User custom providers / model overrides. **Plaintext `apiKey` values — treat as a secret file**                                                                                 |
| `<agent>/agent.db`                                      | SQLite: `auth_credentials`, `settings`, usage, cache, clients. Snapshots itself before auth/migration changes (`agent.db.bak-auth-json-*`, `agent.db.bak-codex-api-key-*`, ...) |
| `<agent>/models.db`                                     | Model catalog cache (table `model_cache`)                                                                                                                                       |
| `<agent>/history.db`, `stats.db`, `autoqa.db`, `cache/` | History/usage/cache                                                                                                                                                             |
| `<agent>/sessions/`                                     | One directory per workspace (path-mangled name, e.g. `Workspace-personal-PiLot`), holding `*.jsonl` session files; `-` is anonymous                                             |
| `<agent>/extensions/`                                   | `.ts` hook/extension files (herdr installs one here); `omp install` / `omp plugin` manage packages                                                                              |
| `<agent>/terminal-sessions/`                            | Per-tty shell-session tracking                                                                                                                                                  |
| `<agent>/blobs/`                                        | Content-addressed blobs (images, artifacts)                                                                                                                                     |
| `~/.omp/profiles/<name>/agent`                          | Per-profile agent home (see Profiles)                                                                                                                                           |
| `~/.omp/logs/`, `~/.omp/run/daemons/`                   | Logs; per-project daemon broker (LSP sharing: `lsp.shared` config)                                                                                                              |
| `~/.omp/natives/<version>/`                             | Versioned native addons                                                                                                                                                         |

## config.yml and the settings surface

- Path: `<agentDir>/config.yml` (`omp config path` prints the agent dir). Plain YAML, no comments. A real install had 741 bytes: `symbolPreset`, `theme.dark`, `setupVersion`, `modelRoles`, `compaction.enabled/strategy`, `snapcompact.shape`, `colorBlindMode`, `retry.fallbackChains`, `dev.autoqaConsent`.
- The **full editable surface is `omp config list --json`**: 461 keys, each with `type` (`string`/`number`/`boolean`/`enum`/`array`/`record`), current `value`, and a `description`; enums carry their allowed values in descriptions. This is the authoritative inventory a config editor should render from. Edit via `omp config get/set/reset <key> [value]` (set/reset validate and write the YAML); `omp config init-xdg` exists as an action.
- **Curated families relevant to a T3 editor:**
  - Model selection: `modelRoles` (record of roles `default|smol|slow|vision|designer|commit|tiny|task|advisor|plan` → `provider/model[:param]` strings, e.g. `opencode-go/deepseek-v4-flash:max`), `modelTags`, `modelProviderOrder`, `cycleOrder`, `enabledModels`, `disabledProviders`, `modelRoleStorage` (`global`).
  - Thinking: `defaultThinkingLevel` (enum `off|minimal|low|medium|high|xhigh|max`), `hideThinkingBlock`, `proseOnlyThinking`, `omitThinking`.
  - Look & feel: `theme.dark`/`theme.light`, `symbolPreset`, `colorBlindMode`, `statusLine.*`, `display.*`, `tui.*`, `terminal.showImages`, `images.*`.
  - Extensions/skills: `extensions`, `disabledExtensions`.
  - Per-run behavior: `tools.artifact*`, `tools.outputMaxColumns`, `workspace.additionalDirectories`, `providers.maxInFlightRequests`.
  - Resilience: `retry.*` (maxRetries, modelFallback, `fallbackChains`), `compaction.*`, `snapcompact.*`, `model.loopGuard.*`.
  - Credential vault: `auth.broker.url`, `auth.broker.token`.
- **How changes apply:** config is a static YAML file read at process start; no reload watcher is shipped (`config.yml.lock` is held while a session runs). Edits take effect on subsequently launched omp processes; already-running sessions keep their startup config — [INFERENCE] from the absence of reload machinery, not verified in source. `--config <file>` loads an extra config.yml-style overlay for one run (repeatable) — the clean way for T3 to inject per-session settings without editing the user's file.

## Model catalog (models.yml + models.db)

- `models.db` table `model_cache` caches one JSON blob of models per `provider_id` (columns: `version`, `updated_at`, `authoritative`, `models`). Observed providers: `anthropic`, `openai-codex`, `google-vertex`, `zenmux`, `opencode-go:models-v1:<fingerprint>`, local inference (`ollama`, `llama.cpp`, `lm-studio`), and models.yml custom providers (`edag-openai`/`edag-anthropic` via `openai-models-list-context-v2` discovery).
- `omp models ls|find <pattern>|<provider>|refresh`; `refresh` refetches the catalog (help: "replaces rm -rf ~/.omp/models.db").
- `models.yml` is the **user custom-provider surface**: `providers.<name>` with `baseUrl`, `apiKey` (plaintext), `auth: apiKey`, `api: openai-responses|anthropic-messages|openai-completions`, optional `discovery: {type: openai-models-list}`, `models[]` (id, name, reasoning, `thinking.mode`/`effortMap`, input modalities, `contextWindow`, `maxTokens`, `cost`, `compat`), plus `modelOverrides` for built-in models (e.g. context-window bumps). Custom models come from here.
- Model selector format is `provider/model` or `provider/model:param` (`:max`, `:high` observed) — the suffix is a model parameter, not a level name.

## Auth

- Precedence: `--api-key` flag (help: "defaults to env vars"), then environment, then stored credentials; `ANTHROPIC_OAUTH_TOKEN` takes precedence over `ANTHROPIC_API_KEY`.
- **Exact env vars from `omp --help`:** core providers — `ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN`, `CLAUDE_CODE_USE_FOUNDRY`, `FOUNDRY_BASE_URL`, `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY`, `NODE_EXTRA_CA_CERTS`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `COPILOT_GITHUB_TOKEN`; additional LLM providers — `AZURE_OPENAI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `KILO_API_KEY`, `MISTRAL_API_KEY`, `ZAI_API_KEY`, `UMANS_AI_CODING_PLAN_API_KEY`, `UMANS_WEBSEARCH_PROVIDER`, `MINIMAX_API_KEY`, `OPENCODE_API_KEY`, `CURSOR_ACCESS_TOKEN`, `AI_GATEWAY_API_KEY`, `WAFER_SERVERLESS_API_KEY`; cloud — `AWS_PROFILE` (or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`), `GOOGLE_CLOUD_PROJECT` (+ `GOOGLE_CLOUD_LOCATION`), `GOOGLE_APPLICATION_CREDENTIALS`; search — `EXA_API_KEY`, `BRAVE_API_KEY`, `PERPLEXITY_API_KEY`, `PERPLEXITY_COOKIES`, `TAVILY_API_KEY`, `TINYFISH_API_KEY`, `FIRECRAWL_API_KEY`, `ANTHROPIC_SEARCH_API_KEY`, `ANTHROPIC_SEARCH_BASE_URL`; config — `OMP_PROFILE`, `PI_CODING_AGENT_DIR`, `PI_PACKAGE_DIR`, `PI_SMOL_MODEL`, `PI_SLOW_MODEL`, `PI_PLAN_MODEL`, `PI_NO_PTY`. (`--help` also references a bundled `docs/environment-variables.md`, not shipped in the brew install.)
- **Stored credentials:** `<agent>/agent.db` table `auth_credentials` (`provider`, `credential_type` = `api_key`|`oauth`, JSON `data`, `identity_key`, `disabled_cause`, timestamps; mutations bump `auth_change_revision`). Observed rows: `github-copilot|oauth`, `openai-codex|api_key`, `opencode-go|api_key`.
- `omp token <provider>` prints a stored key/token: `--raw` for nested JSON credentials, `--force-refresh` for OAuth, `-l/--list` lists OAuth accounts, `--account N` selects one (round-robin default).
- **Credential vault (opt-in):** `auth.broker.url` + `auth.broker.token` config keys; `omp auth-broker serve|token|login|logout|import|migrate|status|list` runs a broker (local SQLite is the default store; `migrate --from-local --include-env` moves local creds + env keys into it), and `omp auth-gateway serve` exposes a bearer-token forward proxy backed by the broker. Relevant if T3 wants central credential management across machines.
- OMP snapshots `agent.db` before auth mutations (backups named `agent.db.bak-auth-json-*`, `bak-codex-api-key-*`, `bak-auth-refresh-*`, ...).

## Profiles

- `--profile <name>` or `OMP_PROFILE` env: "an isolated profile for auth, sessions, settings, and caches".
- Layout: `~/.omp/profiles/<name>/agent/` — a per-profile agent home. A fresh profile contained only `agent.db` (+ wal/shm); `config.yml` and the rest are created lazily, so a new profile starts from defaults until written. (Observed; also `gpu_cache.json`, `logs/` at profile root.)
- `omp --profile <name> --alias <cmd>` creates a shell shortcut for the profile.
- T3: per-instance profiles = launch with `--profile <name>`; each instance gets isolated auth/sessions/settings.

## Launch surface a T3 session needs (from `--help`)

- Mode: `--mode rpc|rpc-ui|json` (protocol detail is the sibling RPC ticket's territory).
- Session targeting: `--session-dir <dir>`, `-c/--continue`, `-r/--resume <id|path>`, `--no-session` (ephemeral). (`--session-id` from the map notes does not appear in v17.2.7 `--help`; only `--session-dir` does.)
- Workspace: `--cwd <dir>`, `--add-dir <path>` (repeatable), `--allow-home`.
- Model/thinking: `--model <fuzzy|provider/model>`, `--smol`/`--slow`/`--plan`, `--thinking <off|minimal|low|medium|high|xhigh|max|auto>`, `--models <patterns>`, `--provider` (legacy).
- Approval: `--approval-mode always-ask|write|yolo`, `--auto-approve` (the flag help names the underlying setting `tools.approvalMode`).
- Extensions/skills/rules: `--no-extensions`, `-e/--extension <file>`, `--no-skills`, `--skills <globs>`, `--no-rules`, `--hook <file>`, `--plugin-dir <path>`.
- Guardrails: `--max-time`, `--no-pty`, `--no-tools`, `--tools <list>`, `--no-lsp`, `--no-title`.
- Config injection: `--config <file>` overlay (repeatable) — recommended for per-session settings without touching the user's `config.yml`.
- Auth: `--api-key <value>`.
- Updates: `omp update` self-updates (`-c/--check`, `-l/--plugins`; `GITHUB_TOKEN`/`GH_TOKEN` avoid release rate limits). This install is Homebrew; the distribution pinned by the driver's maintenance resolver is npm `@oh-my-pi/pi-coding-agent` (no Homebrew formula), and its tarball layout remains unverified.

## What a T3 settings surface needs

1. Launch OMP with `--mode rpc-ui` (ADR 0001 decision 5 — exposes OMP's Ask tool; wire-identical
   to `rpc` otherwise), `--profile <name>` (per instance), `--session-dir`, and a `--config`
   overlay file carrying per-session overrides (modelRoles, thinking, approval, extensions) —
   leaving the user's `config.yml` untouched.
2. Model picking: read the catalog via `omp models ls --json` (cache-backed) or `models.db`; write `models.yml` for custom providers (and treat its plaintext `apiKey` fields as secret, `0600`-grade).
3. Auth: forward provider keys through `process.env` (exact names above) or read stored keys with `omp token <provider>`; per-profile isolation comes free with `--profile`.
4. Config editing: render the 461-key `omp config list --json` inventory, or the curated subset above; write through `omp config set` or direct YAML; changes apply on next launch.
