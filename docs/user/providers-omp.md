# OMP

OMP (the Oh My Pi coding agent, npm `@oh-my-pi/pi-coding-agent`) is a local coding agent harness.
T3 Code drives it over OMP's RPC mode: sessions run under T3 Code, and OMP's profiles,
extensions, skills, and model thinking tiers work through your prompts as usual.

For Codex, see [Codex](./providers-codex.md). For Claude, see [Claude](./providers-claude.md). For
Pi, see [Pi](./providers-pi.md). For first-time setup, see [Install T3 Code](./install.md).

Common reasons to add an OMP provider:

- use OMP as your coding agent instead of (or alongside) Codex or Claude
- run a second OMP identity with its own profile — separate auth, sessions, settings, and caches
- point T3 Code at an OMP binary that is not on the default `PATH`

## Installing OMP

T3 Code does not ship OMP; it drives the CLI you install. Install it on the machine running the
T3 Code server:

```bash
npm install -g @oh-my-pi/pi-coding-agent
```

OMP needs at least version 17.0.9 — T3 Code checks the version when it probes the provider and
tells you if OMP is too old.

Authenticate the providers you want to use. OMP reads credentials from your `~/.omp` directory,
your environment, or the API key fields in T3 Code Settings:

- run the OMP TUI once and sign in to store credentials in `~/.omp/agent`
- set provider API keys in your shell environment
- set one of the five API key fields below in T3 Code Settings

## The Settings Fields

- **Display name** — how the provider appears in the model picker.
- **Binary path** — the `omp` executable. Defaults to `omp` on the `PATH`.
- **Launch arguments** — extra CLI flags passed to omp when a session starts, e.g. `--no-lsp`.
- **Profile** — an OMP profile to launch with (empty = OMP's default profile). Each profile is an
  isolated agent home (`~/.omp/profiles/<name>/agent`): separate auth, sessions, settings, and
  caches. Give each of your OMP instances its own profile to keep identities apart.
- **API key fields** — optional password fields for the five mainstream keys. Each is injected as
  an environment variable into omp sessions when set: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GEMINI_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`.
- **Environment variables** — for any other omp-accepted keys (OAuth tokens, Copilot,
  OpenRouter, ...), use the provider instance's Environment variables section. Sensitive values
  are stored as server secrets.

## OMP Config

In Settings → OMP → expand the instance, the **OMP config** section at the bottom edits the
instance's `config.yml` — `~/.omp/profiles/<name>/agent/config.yml` when the instance sets a
profile, otherwise the agent home's file (`~/.omp/agent/config.yml`). Changes apply to **new** omp
sessions — running sessions keep the settings they started with.

The editor has two tabs:

- **Curated** — default thinking level (Off through Max, or unset) and model roles: one
  `role=provider/model` line per role, e.g. `default=anthropic/claude-sonnet-4-6`. Empty fields
  are left out of the file, so omp's own defaults apply.
- **Raw YAML** — a whole-file editor for anything else. It must stay valid YAML; the server
  validates before writing. If omp currently can't read the file (it was edited by hand and
  broke), T3 Code shows a warning and lets you fix it right there. Saving curated fields never
  overwrites keys the editor doesn't know about.

## Picking Models

The model picker is driven by what OMP reports as available, and reflects your `~/.omp`
credentials and custom `models.yml` providers. Models appear as `provider/model` slugs; models
that support thinking get a tier selector for the tiers OMP actually exposes for them.

You can change the picked model while a thread is running — the change applies on the **next
turn**, no restart, no context loss. If OMP rejects the new model, T3 Code shows a notice and the
session continues on the previous model. The thinking-tier selector works the same way: pick a new
tier mid-thread and it applies on the next turn.

## Permissions

OMP's tool-approval prompts map onto T3 Code's approval flow:

- **Full access** runs omp with approvals off.
- **Approval required** asks before every tool.
- **Auto-accept edits** approves file edits automatically while other tools still ask.

Use T3 Code's normal permission-mode controls; the mode applies when the session launches.

## Updating OMP

T3 Code checks the installed omp version against `@oh-my-pi/pi-coding-agent` on npm and shows an
advisory when OMP is behind, with an **Update now** button that runs the update for you. You can
also update manually:

```bash
npm install -g @oh-my-pi/pi-coding-agent@latest
```

## What Is Not In T3 Code

- **OMP TUI embedding** — the interactive TUI stays a terminal app.
- **Authoring extensions, skills, or commands from T3** — write those in the OMP TUI or by hand.
- **RPC OAuth login** — sign in through the OMP TUI or your environment instead.
