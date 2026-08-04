# T3's notice/status machinery, for pi extension UI

Research for wayfinder ticket #55: which existing T3 event/rendering machinery can
carry pi's fire-and-forget `notify` and `setStatus` extension UI requests, or are
new event types required?

Source pi docs: `rpc.md` "Extension UI Protocol" (§1145) — installed pi 0.83.0.

## The one universal channel: orchestration activities

Every provider runtime event that surfaces in the UI flows through the same pipe:

```
providerRuntime event (packages/contracts/src/providerRuntime.ts)
  → runtimeEventToActivities (apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:310)
  → thread.activity.append command
  → thread.activity-appended event (decider.ts:1169)
  → projection: thread.activities (projector.ts:725, capped at 500, deduped by id)
  → client reducer: thread.activity-appended (packages/client-runtime/src/state/threadReducer.ts:511)
  → web work log (session-logic.ts deriveWorkLogEntries:633 → MessagesTimeline rows)
  → mobile work log (apps/mobile/src/lib/threadActivity.ts)
```

The activity shape is `OrchestrationThreadActivity` (contracts/orchestration.ts:311):
`{id, tone: "info"|"tool"|"approval"|"error", kind: <free string>, summary, payload,
turnId, sequence?, createdAt}`. `kind` is a free string — a new kind needs **no
contract change** to the activity itself; adapters already emit kinds like
`runtime.warning`, `tool.denied`, `user-input.requested`.

The activity _channel_ is therefore open to any provider. The adapter boundary is
the only place where a decision is required: pick a runtime event type, map it in
`runtimeEventToActivities`, and the row appears on web and mobile with zero further
work (unknown kinds render as generic rows; web and mobile both add per-kind chrome).

## Existing fire-and-forget precedents

| Event type             | Emitters                                                     | Ingestion mapping                                                                     | Rendering                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.warning`      | ClaudeAdapter:1720, CodexAdapter:1256+, OpenCodeAdapter:1050 | tone `info`, kind `runtime.warning`, summary = message (ProviderRuntimeIngestion:413) | Web: warning-styled row — x icon, `text-warning` heading, keyed on `sourceActivityKind === "runtime.warning"` (MessagesTimeline.tsx:1932); Mobile: "warning" icon (threadActivity.ts:519) |
| `runtime.error`        | PiAdapter:1013 (session crash), CodexAdapter                 | tone `error`, kind `runtime.error` (:376)                                             | Web: destructive row; Mobile: alert icon                                                                                                                                                  |
| `tool.denied`          | ClaudeAdapter                                                | tone `error` (:393)                                                                   | destructive row                                                                                                                                                                           |
| `user-input.requested` | PiAdapter (select/confirm dialogs, PiAdapter.ts:850)         | tone `info`, kind `user-input.requested` (:453)                                       | pending panel derived from activities; wakes settled threads                                                                                                                              |
| `deprecation.notice`   | CodexAdapter:1081                                            | **no ingestion case → silently dropped**                                              | nothing — proof that a contract type alone surfaces nothing                                                                                                                               |

`runtime.warning` is the closest precedent to `notify`: an adapter-emitted,
fire-and-forget informational event that lands as a timeline row with per-kind
chrome, on both clients. `deprecation.notice` is the cautionary tale: it exists in
the runtime contract and is emitted, but was never wired through ingestion, so it
has never rendered anywhere.

## Delivery constraints (thread state)

- **Thread-bound**: runtime events carry a `threadId`; ingestion appends to that
  thread regardless of settled/snoozed state. The projector has no gate.
- **Settled/snoozed threads do not wake**: the decider's wake list is exactly
  `approval.requested` and `user-input.requested` (decider.ts:1184). Any other
  activity lands silently on a parked thread. For a _notice_ this is the correct
  behavior — a parked thread should not pop for an info row.
- **Settled turns fold**: settled turns fold all non-terminal entries (work rows
  and commentary) behind a "Worked for …" row (MessagesTimeline.logic.ts:281).
  A notify that lands mid-turn is visible while the turn runs and folds once the
  turn settles — identical to how `runtime.warning` behaves today. An activity
  with `turnId: null` (no active turn) is never folded.
- **Activity cap**: the projector keeps the last 500 activities per thread
  (projector.ts:748). Bounded — fine for notices, wrong for status _state_.

## Recommendation: notify rides the activity channel

**New runtime event type, one ingestion case, no new orchestration machinery.**

`notify` cannot ride `runtime.warning`/`runtime.error` alone: the tone and chrome
are keyed to the event type at ingestion, and `notifyType` has three values
(`info`/`warning`/`error`) while there is no "info severity" runtime event. Three
event types for one pi method is noise; one new type maps cleanly.

Proposed shape (names and payloads are the #58 design ticket's to finalize):

```ts
// packages/contracts/src/providerRuntime.ts
// type: "extension.notice"  (new; "extension." is a fresh namespace — pi is the
// only provider with an extension UI today)
{
  message: string,
  noticeType: "info" | "warning" | "error",
}

// ProviderRuntimeIngestion: runtimeEventToActivities case:
// kind "extension.notice", tone "error" when noticeType is "error" else "info",
// summary = message (truncated like runtime.warning: 120/180), payload keeps
// {message, noticeType} for chrome.
```

Delivery rules:

- Always appended when the event carries a threadId; never added to the
  `wakesSettledThread` list.
- No queue/persistence for "no thread active": pi sessions in T3 are spawned per
  thread, so an `extension_ui_request` always arrives bound to a session; if the
  adapter has no bound thread it drops defensively, exactly as today.
- Render as a work-log row on web and mobile; `noticeType`-aware chrome
  (info/warning/error icon + color) is the #58 design call, following the
  `runtime.warning` precedent. The raw request keeps riding `raw.source =
"pi.rpc.event"` for the event log.

## Recommendation: setStatus needs new thread-level state

**There is no existing per-thread, keyed, server-driven status surface.**

Inventoried status-adjacent surfaces, none of which fit:

- `OrchestrationThread` fields: `settledAt`, `snoozedUntil`, `latestTurn`,
  `session` — lifecycle state, not extension status.
- `ComposerBannerStack` — purely client-derived in ChatView (system banners
  :1901, parked-thread banner :4171); there is no server banner channel.
- `ProviderStatusBanner`, `ThreadSyncStatusPill` — provider auth and sync state.
- The activity channel — **rejected**: it is an append-only log, so a status
  clear would need a tombstone row, live status would be hidden by settled-turn
  folding, the 500-row cap would evict old entries, and a status is _state_, not
  an event.

setStatus is a state registry (`statusKey` → `statusText`, set or cleared) — it
needs a small amount of new machinery, all following existing patterns:

```ts
// providerRuntime: type "extension.status"
{ statusKey: string, statusText: string | null }   // null = clear

// orchestration command: thread.status.set (ingestion dispatches, like
// thread.activity.append at ProviderRuntimeIngestion:1768)
// orchestration event: thread.status.updated
// projection: thread.statusEntries: Array<{ key, text, updatedAt }>
//   (array for stable order; upsert by key; null text removes)
// web: status chips in the composer/header area; mobile: events-only (map decision)
```

Delivery rules:

- Per-thread scope: T3 runs one pi session per thread, so a statusKey belongs to
  that thread's session — not per-instance.
- Not turn-scoped: survives turn settles (unlike activity rows).
- Lifetime: cleared on explicit clear; clear all entries when the pi session
  exits (the extension is gone; stale chips must not linger). Whether session
  exit clearing is immediate or on next open is a #58 detail.
- Same "drop defensively if unbound" rule as notify; no queue.

## What this feeds

- #58 (Design extension UI event types and rendering, blocked by #55): takes the
  shape names, chrome decisions, and the status-chip lifetime detail.
- #60 (Implement Pi v2 server side and contracts): new runtime event types
  `extension.notice` / `extension.status`, ingestion cases, `thread.status.set`
  command + `thread.status.updated` event + projection field, PiAdapter
  `notify`/`setStatus` handling replacing the current silent drop (PiAdapter.ts:898).
