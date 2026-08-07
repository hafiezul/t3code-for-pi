# T3 Code

T3 Code coordinates coding agents across web, desktop, and mobile clients.

## Language

**User-input request**:
A provider-originated interaction that carries one or more User-input questions and completes once as a whole.
_Avoid_: dialog, approval

**User-input question**:
One prompt within a User-input request, requesting one human response. It is either a Selection question or a Text question.
_Avoid_: prompt

**Selection question**:
A User-input question primarily answered by choosing one or more provided options. It may offer a custom-text fallback, but each answer is either option selections or custom text, never both.
_Avoid_: option question

**Text question**:
A User-input question answered with user-authored text. It may present initial text for the user to keep or amend and a single-line or multi-line editing mode; an empty text answer remains an answer.
_Avoid_: free-form dialog

**User-input outcome**:
The terminal disposition of a User-input request: an answer map or explicit cancellation. An empty Text answer remains an answer.
_Avoid_: empty response

**Provider**:
An agent runtime T3 Code drives. This fork supports: codex, claudeAgent, cursor, grok, opencode, pi, omp.
_Avoid_: model, backend

**OMP (provider)**:
Oh My Pi — the `omp` CLI (npm `@oh-my-pi/pi-coding-agent`, a fork of Pi). T3 drives it over its newline-delimited JSON RPC on stdio (`omp --mode rpc-ui`). Distinct from the OpenCode provider.
_Avoid_: opencode

**Driver**:
The server-side integration unit for one provider kind.
_Avoid_: provider plugin

**Adapter**:
The per-session translator between a provider's protocol events and T3 runtime events. Provider-shaped behavior lives at this boundary.
_Avoid_: bridge, connector

**Composer**:
The message input surface (web, mobile) where the user composes a turn.
_Avoid_: input box, prompt field

**Composer trigger**:
A token at the caret that opens a selection menu: `/` slash commands, `$` skills, `@` path mentions, `#` prompt actions (OMP only).
_Avoid_: autocomplete

**Prompt action**:
An editor-local action offered by the OMP `#` picker (Copy current line, Copy whole prompt, Undo, cursor moves). Executes against the draft only — never sent to the agent; selecting one removes the `#` token. Distinct from slash commands, which act on the session.
_Avoid_: quick action, command

**Provider snapshot**:
The per-instance capability payload the server sends clients (driver kind, display name, models, slash commands, skills, capabilities). What a provider can do is declared here; clients render it generically.
_Avoid_: provider metadata

**Pi-lineage provider**:
pi or omp (Oh My Pi) — the two providers driven over the pi-family JSONL RPC protocol, which both stream per-request usage data on assistant messages.
_Avoid_: pi family, pi-style provider

**Token usage snapshot**:
The per-request accounting a provider emits during a turn — input, output, cached, and reasoning tokens, plus cost. T3 renders the latest one as context usage.
_Avoid_: usage event, token stats

**Context usage**:
The share of the model's context window a request consumed, shown as used tokens over the window total.
_Avoid_: context percentage, context %
