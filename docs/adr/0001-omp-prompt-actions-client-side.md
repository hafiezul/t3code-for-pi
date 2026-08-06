# ADR-0001: OMP prompt actions are client-side composer features, not provider-declared capabilities

The OMP (Oh My Pi) TUI offers a `#` prompt-action picker — editor-local
actions (copy line/prompt, undo, cursor moves) that never cross the agent
boundary. T3 Code's composer menus (`/` slash commands, `$` skills, `@` path
mentions) are provider-declared in the server snapshot and rendered
generically by clients. We decided to replicate the `#` picker for the OMP
provider as a **client-side feature**: trigger detection lives in the shared
composer-trigger module (new `prompt-action` kind), the action list (Copy
whole prompt, Copy current line, Undo) is hardcoded client-side keyed by
provider driver kind `omp`, gated to OMP only, and actions execute locally
against the Lexical composer — nothing crosses the wire, no contract changes.
Trigger grammar mirrors OMP exactly: a `#` token with no whitespace after it;
selecting an action strips the token and executes.

## Considered Options

- **Provider-declared `promptActions`** in the OMP driver snapshot (the
  `slashCommands`/`skills` pattern) — rejected: the server has no data to
  contribute and cannot execute editor ops; the list would be pure plumbing
  through contracts.
- **Full 7-action parity** — rejected: the four cursor-move actions are
  keyboard-TUI affordances with native equivalents in a mouse-driven web
  editor; menu noise without value.
- **GitHub `#<number>` ref completion** — rejected for v1: no client-side
  backend, and the literal text already passes through to the agent unchanged.

## Consequences

- Other providers do not get a `#` picker until one declares the need.
- The hardcoded action list must be kept in sync with OMP's own picker when
  OMP adds or renames actions.
- Mobile (React Native) shares the trigger detection but has no handler for
  the new kind; `#` stays free text there for now.
