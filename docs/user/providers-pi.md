# Pi

[Pi](https://pi.dev) is a local coding agent harness. T3 Code drives it in RPC mode: sessions run
under T3 Code, and pi's skills, templates, and extensions work through your prompts as usual.

For Codex, see [Codex](./providers-codex.md). For Claude, see [Claude](./providers-claude.md). For
first-time setup, see [Install T3 Code](./install.md).

Common reasons to add a Pi provider:

- use pi as your coding agent instead of (or alongside) Codex or Claude
- run a second pi configuration — a different model catalog, or different API keys
- point T3 Code at a pi binary that is not on the default `PATH`

## Installing Pi

T3 Code does not ship pi; it drives the CLI you install. Install it on the machine running the
T3 Code server:

```bash
npm install -g @earendil-works/pi-coding-agent
```

Pi needs at least version 0.80.5 — T3 Code checks the version when it probes the provider and tells
you if pi is too old.

Authenticate the providers you want to use. Pi reads credentials from your `~/.pi` directory, your
environment, or the API key fields in T3 Code Settings:

- run the pi TUI once and use `/login` to store credentials in `~/.pi/agent/auth.json`
- set provider API keys in your shell environment
- set one of the five API key fields below in T3 Code Settings

## I Only Use One Pi Setup

Use the default provider.

In Settings, your Pi provider can stay like this:

```text
Display name: Pi
Binary path: pi
Launch arguments: empty
API key fields: empty
```

An empty `Binary path` means T3 Code uses the `pi` binary on the server's `PATH`. If pi is installed
somewhere unusual, set the full path instead.

## The Settings Fields

- **Display name** — how the provider appears in the model picker.
- **Binary path** — the `pi` executable. Defaults to `pi` on the `PATH`.
- **Launch arguments** — extra CLI flags passed to pi when a session starts, e.g. `--no-extensions`.
- **API key fields** — optional password fields for the five mainstream keys. Each is injected as
  an environment variable into pi sessions when set:
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`.
- **Environment variables** — for any other pi-accepted keys (DeepSeek, Mistral, OpenRouter, ...),
  use the provider instance's Environment variables section. Sensitive values are stored as server
  secrets.

Pi's own configuration stays in `~/.pi` (config, `auth.json`, `models.json`). There is no pi
configuration UI inside T3 Code; edit `~/.pi` with the pi TUI or directly.

## Picking Models

The model picker is driven by what pi reports as available. Pi only lists models it can actually
use, so the picker reflects your `~/.pi` credentials, `models.json`, and extensions.

Models appear as `provider/model` slugs (for example `anthropic/claude-sonnet-4-6`). Models that
support thinking get a **Thinking** tier selector (Off, Minimal, Low, Medium, High, XHigh, Max);
the level applies when the session starts, and pi maps it onto what the model actually supports.
When nothing is picked, pi's own default thinking level applies.

You can also add custom models by typing a slug in the provider's model section in Settings, the
same way as other providers.

### Switching Models Mid-Thread

You can change the picked model while a thread is running. The change applies on the **next turn**
— the current pi session keeps its context and continues on the new model. No restart, no context
loss. If pi rejects the new model, T3 Code shows a notice and the session continues on the previous
model.

## Permissions

Pi has no per-tool permission prompts: when it wants to run a command or edit a file, it does so.
T3 Code therefore runs pi sessions in **Full access** mode, and T3 Code's approval prompts do not
appear for pi sessions. The one gate is pi's own project trust, which you accept when you first use
pi in a project directory. T3 Code's other safety features — checkpoints, turn diffs, and revert —
still work as usual.

## Updating Pi

T3 Code checks the installed pi version against `@earendil-works/pi-coding-agent` on npm and shows
an advisory when pi is behind, with an **Update now** button that runs the update for you. You can
also update manually:

```bash
npm install -g @earendil-works/pi-coding-agent@latest
```

## What Is Not In T3 Code (v1)

- **Slash-command picker** — pi slash commands are typed as text (e.g. `/compact`) in the prompt;
  pi expands them. T3 Code's own `/` menu is untouched.
- **Extension command palette** — pi extensions' commands and tools surface through prompts and pi's
  own dialogs, not a T3 Code palette.
- **Pi configuration UI** — pi config stays in `~/.pi`; use the pi TUI or edit the files directly.
