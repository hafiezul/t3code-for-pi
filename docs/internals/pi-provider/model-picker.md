# Pi provider: model picker contract

Research resolution for [Map pi --list-models onto T3's model picker](https://github.com/hafiezul/t3code-for-pi/issues/46) (wayfinder map: [Add Pi.dev as a first-class provider in T3 Code](https://github.com/hafiezul/t3code-for-pi/issues/43)).

This is the contract the Pi driver's model probe and the picker follow. It mirrors the OpenCode provider end to end — the closest existing analog (CLI-inventoried models flattened into `provider/model` slugs) — with pi-specific parsing and gating.

## Facts about pi's model surface (v0.83.0)

- `pi --list-models [search]` prints a fixed-width table to **stdout**; warnings (e.g. `Warning: No models match pattern ...`) go to **stderr**. There is no JSON mode.
- Columns, in order: `provider`, `model`, `context`, `max-out`, `thinking`, `images`. Cells are single whitespace-free tokens separated by 2+ spaces; the header row's first cell is the literal `provider`.
- The list covers built-in catalogs, anything the user declared in `~/.pi/agent/models.json`, and extension-registered providers — but **only models pi considers available**. `models.md`: without auth (env key, `apiKey`, or `~/.pi/auth.json` OAuth), custom models "stay unavailable in `/model` and `--list-models`". pi does the auth filtering; the probe sees the final, selectable list. Keyless local servers use the dummy-`apiKey` convention ("ollama") on the user's side.
- `provider` and `model` ids never contain whitespace, but **model ids may contain `/`** (e.g. `@cf/moonshotai/kimi-k2.6`). Split slugs at the **first** `/` only.
- `pi --model <pattern>` accepts `provider/id` verbatim, bare ids (fuzzy-matched across providers), and an optional `:<thinking>` suffix (`--thinking <level>` is the separate explicit flag; levels: `off|minimal|low|medium|high|xhigh|max`).
- Mid-session, the RPC layer has `set_model` (`provider` + `modelId` as separate fields) and `get_available_models` (full `Model` objects: `contextWindow`, `maxTokens`, `reasoning`, `input`, `cost`). `get_available_models` needs a live session, so it does not replace `--list-models` as the picker probe; it is a cross-check for the protocol mapping (ticket #44).

## Probe contract (server side)

Shape: `checkPiProviderStatus(settings, cwd, env)`, following `checkOpenCodeProviderStatus` in `apps/server/src/provider/Layers/OpenCodeProvider.ts`.

1. **Version**: spawn `pi --version` (same `--version` flag as opencode), parse with `parseGenericCliVersion`. Gate on `MINIMUM_PI_VERSION = 0.80.4` (decided in ticket #45). Too old → `status: "error"`, message mirrors opencode's "is too old" wording.
2. **Inventory**: spawn `pi --list-models` via `spawnAndCollect` with the instance env (ambient env + per-instance key env vars; `~/.pi` config is inherited). Parse stdout lines matching the 6-token shape (skip the `provider` header row; skip non-matching lines defensively). Parse `thinking` as `yes`/`no`; ignore `context`, `max-out`, `images` (see Picker metadata).
3. **Missing binary**: ENOENT/`not found` failure → `installed: false`, `status: "error"`, message "Pi CLI (`pi`) is not installed or not on PATH." (opencode's `formatOpenCodeProbeError` pattern).
4. **Auth/status**: pi gives no auth signal in the table. ≥1 model → `status: "ready"`, `auth: { status: "unknown" }` (the auth probe design is ticket #47's). 0 models → `status: "warning"` with a message pointing at `~/.pi/agent/models.json` auth, mirroring opencode's "no connected upstream providers" wording.
5. **Caching/TTL**: none beyond the existing managed-snapshot cadence — the driver's `checkProvider` runs on `makeManagedServerProvider`'s schedule, exactly like OpenCode/Codex. pi reloads `models.json` per `/model` open, so the periodic re-probe picks up edits; no extra cache layer.
6. **Custom slugs**: merge via `providerModelsFromSettings([], customModels, DEFAULT_PI_MODEL_CAPABILITIES)` — the existing trim-only `normalizeCustomModelSlug` path, deduped against probe-reported slugs. No per-provider alias expansion for pi (`MODEL_SLUG_ALIASES_BY_PROVIDER[pi]` stays empty): pi's own pattern matching handles aliases at spawn time, and T3 custom slugs pass through verbatim — including bare ids without a provider prefix.

## Slug mapping

- Probe row → `ServerProviderModel`: `slug: "<provider>/<model>"` (e.g. `anthropic/claude-sonnet-5`, `cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6`), `name: "<model>"` (pi has no display-name column; its own UI shows the model id, so name = id, slug === name), `subProvider: "<provider>"`, `isCustom: false`, no `isDefault` (pi has no default marker; the picker's fallback chain — `isDefault` → first listed — lands on pi's first row, which is fine since pi sorts its table).
- Split at the **first** `/` (`parseOpenCodeModelSlug` already implements this shape); the remainder may itself contain `/`.
- Slugs never carry the `:<thinking>` suffix. A thinking level, when one exists, rides `modelSelection.options` and is applied at spawn (see Selection → spawn). Storing it in the slug would desync the picker from the probe output and turn a built-in into a custom-looking entry.
- Duplicate ids across providers cannot collide (`anthropic/claude-sonnet-5` vs `vibeproxy/claude-sonnet-5` are distinct slugs), and one row per (provider, model) pair means no intra-provider duplicates.

## Picker metadata

Only `thinking` survives; the rest of pi's table is dropped because `ServerProviderModel` cannot carry it:

| pi column  | mapping                                                                                                 | rationale                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thinking` | `yes` → select descriptor `thinkingLevel` (Off/Minimal/Low/Medium/High/XHigh/Max); `no` → no descriptor | The model's available tiers are per-model and only visible through a live session (`get_state`'s `thinkingLevelMap`), so the probe offers pi's universal level set and pi clamps per model (e.g. `low` → `high` on models without a low tier). Renders as a tier selector (the codex `effort` pattern); the adapter applies it at spawn via `--thinking <level>`. |
| `context`  | dropped                                                                                                 | No field on `ServerProviderModel`. (Claude's `contextWindow` _select_ descriptor is a user choice mapped to Claude Code flags — pi has no such choice, the window is fixed by the provider, so it is display-only data with nowhere to live)                                                                                                                      |
| `max-out`  | dropped                                                                                                 | Same — not representable                                                                                                                                                                                                                                                                                                                                          |
| `images`   | dropped                                                                                                 | No image-support field; attachment gating is ticket #47's (adapter) concern                                                                                                                                                                                                                                                                                       |

Custom slugs get `DEFAULT_PI_MODEL_CAPABILITIES` (empty descriptors), matching `DEFAULT_OPENCODE_MODEL_CAPABILITIES`.

The picker itself needs no changes: `getAppModelOptionsForInstance` → `sortModelsForProviderInstance` with `providerModelPreferences[instanceId]` (`hiddenModels`, `modelOrder`) and favorites all key by `ProviderInstanceId`, and pi models are ordinary probe-reported rows. Hiding works on stable `provider/model` slugs; a hidden slug that pi later drops is stale but harmless.

## Selection → spawn

- Fresh spawn: `--model <slug>` verbatim (e.g. `pi --mode rpc --model anthropic/claude-sonnet-5`). `provider/id` patterns are self-sufficient, so no provider flag is _derived_; per #45's launch contract the spawn also passes `--provider` when the instance config declares one (the case for bare model ids).
- Thinking: the picked tier flows `modelSelection.options` → adapter → `--thinking <level>` at spawn (`off|minimal|low|medium|high|xhigh|max`). No selection → pi's own `defaultThinkingLevel` applies. pi clamps per model, so offering the universal set is safe. The contract fixed here: **the slug is always exactly `provider/model`, the level is always a separate option**.
- Mid-thread change: T3 sends `modelSelection` per turn; a model switch routes through the RPC `set_model { provider, modelId }` — a pure first-`/` split of the same slug, lossless even for model ids containing `/`. Fresh sessions that never switch just carry the `--model` spawn arg. `set_model` carries no thinking field, so a tier change applies at the next fresh session.

## Edge cases

- **Local models with no API key**: filtered by pi itself before the table is printed; nothing to do T3-side.
- **Duplicate ids across providers**: impossible by slug construction (see above).
- **Hidden models**: standard `providerModelPreferences` mechanism; works unchanged.
- **Model changed mid-thread**: `set_model` per turn; see above.
- **Binary missing**: probe reports `installed: false`; the picker then shows only custom slugs (existing behavior for unavailable providers).
- **0-model table** (header only): `status: "warning"`, auth-unknown message — the honest signal, since pi's table is already auth-filtered.
