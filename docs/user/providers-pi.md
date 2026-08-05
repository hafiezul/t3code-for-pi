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

Pi's own configuration stays in `~/.pi` (config, `auth.json`, `models.json`), and T3 Code adds a
Pi environment config editor for the main settings file — see [Pi Environment Config](#pi-environment-config)
below. For anything else, edit `~/.pi` with the pi TUI or directly.

## Extension UI

Pi extensions can ask the running session for attention, and T3 Code renders that on the thread:

- **Notices** — when an extension calls `notify`, T3 Code shows a timeline row with the message.
  Info notices render as a regular row; warning and error notices get the same warning/destructive
  styling as T3 Code's own runtime warnings and errors.
- **Status chips** — when an extension calls `setStatus`, a small read-only pill appears in the
  composer control row (up to three, then a `+N more` pill). Chips disappear when the session ends
  or the extension clears the status.
- **Dialogs** — extension `select` and `confirm` prompts render as option buttons. `input` and
  `editor` prompts render as a text field or a multiline editor inside the same panel — the editor
  comes prefilled with the extension's starting text. Type your answer and press Enter (Cmd/Ctrl+Enter
  in the multiline editor) to submit; a submitted answer can't be cancelled, so interrupt the turn
  instead if you want out.

Widgets (`setWidget`), titles (`setTitle`), and TUI-style editor requests (`set_editor_text`) are
not rendered; those stay in the pi TUI.

## Pi Environment Config

In Settings → Pi → expand the instance, the **Pi environment config** section at the bottom edits
pi's global `settings.json` (e.g. `~/.pi/agent/settings.json`). The file is shared by all pi
instances on this machine, and changes apply to **new** pi sessions — running sessions keep their
current settings.

- **Curated fields** — default thinking level (Off through Max, or unset), default provider, and
  default model. Empty fields are left out of the file, so pi's own defaults apply.
- **Raw JSON** — a whole-file editor for anything else. It must stay strict JSON; the save button
  stays disabled while the file wouldn't parse. If pi currently can't read the file (it was edited
  by hand and broke), T3 Code shows a warning and lets you fix it right there. Saving never
  overwrites pi-managed keys like `lastChangelogVersion`.

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

### Thinking in the Timeline

When a model reasons before answering, the thinking shows in the chat as a
collapsible **Thinking** row above the response — muted, with a chevron to
open and close it. While the model is actively thinking the row stays open so
you can watch it stream; once the answer lands, it collapses to a single
**Thinking** line so the response text reads cleanly. The same applies to any
provider that streams reasoning (pi, Claude, Codex, and OpenCode).

## Commands in the Composer

Type `/` in the prompt to open the command menu. Pi's commands are listed there, grouped the way
pi organizes them — **Extension**, **Skill**, and **Prompt** — alongside T3 Code's built-in
commands (`/model`, `/plan`, `/default`). Pick one to insert it, or type `/name` and the rest of
your prompt as usual; pi expands the command when the turn runs. Skills insert as a chip in the
composer (icon + name, description on hover) and send as the `/skill:name` invocation pi
understands. Skills also stay available through their own search (type `/` and filter).

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

## What Is Not In T3 Code

- **Per-project pi commands** — the `/` menu lists pi's commands from the user-level install. A
  project's own `.pi` resources only show up when that project is the server's working directory.
- **Project-level settings editing** — per-repo `.pi/settings.json` stays a CLI/file concern.
- **Package management UI** — `pi install` / `pi remove` / `pi config` stay in the pi TUI.
- **Pi TUI embedding** — the interactive TUI stays a terminal app.
- **Authoring commands and skills from T3** — write those in the pi TUI or by hand.
