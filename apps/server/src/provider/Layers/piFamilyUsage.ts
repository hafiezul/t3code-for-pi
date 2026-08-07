/**
 * Shared pi-family (pi + omp) token-usage extraction and snapshot mapping.
 *
 * Both providers stream a `usage` object on assistant messages — zeroed
 * while the request is in flight, final on `message_end` (and repeated on
 * `turn_end` / `agent_end.messages`). The field names differ in one spot
 * (pi: `usage.reasoning`, omp: `usage.reasoningTokens`) and OMP adds a
 * message-level `duration`. See ADR-0002 for the mapping decisions.
 */
import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";

export interface PiFamilyUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly reasoning: number;
  readonly totalTokens: number;
  readonly costTotalUsd: number;
  readonly durationMs: number | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Pull the per-request usage off a pi/omp RPC event (an assistant
 * `message_end`, `turn_end`, or an `agent_end` message entry). Returns
 * undefined when the message carries no usage, or when the usage is not
 * final (all-zero, as streamed on `message_start` / `message_update`).
 */
export function piFamilyUsageFromEvent(event: unknown): PiFamilyUsage | undefined {
  const record = asRecord(event);
  if (!record) {
    return undefined;
  }
  const message = asRecord(record.message);
  const usage = message ? asRecord(message.usage) : null;
  if (!usage) {
    return undefined;
  }
  const totalTokens = asFiniteNonNegative(usage.totalTokens);
  const input = asFiniteNonNegative(usage.input);
  const output = asFiniteNonNegative(usage.output);
  if (
    totalTokens === undefined ||
    totalTokens <= 0 ||
    input === undefined ||
    output === undefined
  ) {
    return undefined;
  }
  const cost = asRecord(usage.cost);
  const costTotalUsd = asFiniteNonNegative(cost?.total);
  const reasoning =
    asFiniteNonNegative(usage.reasoning) ?? asFiniteNonNegative(usage.reasoningTokens);
  const durationMs = asFiniteNonNegative(record.duration);
  return {
    input,
    output,
    cacheRead: asFiniteNonNegative(usage.cacheRead) ?? 0,
    reasoning: reasoning ?? 0,
    totalTokens,
    costTotalUsd: costTotalUsd ?? 0,
    // The wire duration is a float; the snapshot schema is integer ms.
    durationMs: durationMs !== undefined ? Math.round(durationMs) : undefined,
  };
}

/**
 * Build a `provider/model → contextWindow` table from a
 * `get_available_models` command response (`{data: {models: [...]}}`).
 * Entries without a contextWindow are skipped, so the table degrades to
 * empty (meter without a ring %) instead of guessing.
 */
export function piFamilyContextWindowTable(data: unknown): ReadonlyMap<string, number> {
  const table = new Map<string, number>();
  const payload = asRecord(data);
  if (!payload) {
    return table;
  }
  const models = payload.models;
  if (!Array.isArray(models)) {
    return table;
  }
  for (const entry of models) {
    const model = asRecord(entry);
    if (!model) {
      continue;
    }
    const provider = typeof model.provider === "string" ? model.provider : undefined;
    const id = typeof model.id === "string" ? model.id : undefined;
    const contextWindow = asFiniteNonNegative(model.contextWindow);
    if (
      provider !== undefined &&
      id !== undefined &&
      contextWindow !== undefined &&
      contextWindow > 0
    ) {
      table.set(`${provider}/${id}`, contextWindow);
    }
  }
  return table;
}

/**
 * Map one final pi-family usage onto the T3 token-usage snapshot (ADR-0002):
 * `usedTokens` is the request's `totalTokens` (includes the cached context,
 * matching Codex's `usage.last.totalTokens`); `totalProcessedTokens`
 * accumulates the session's new input+output tokens (per-request totals
 * would double-count the cache); the context window comes from the model
 * catalog lookup, omitted when unknown.
 */
export function makePiFamilyTokenUsageSnapshot(input: {
  readonly usage: PiFamilyUsage;
  readonly processedInputTokens: number;
  readonly processedOutputTokens: number;
  readonly contextWindow: number | undefined;
}): ThreadTokenUsageSnapshot {
  const { usage, processedInputTokens, processedOutputTokens, contextWindow } = input;
  return {
    usedTokens: usage.totalTokens,
    totalProcessedTokens: processedInputTokens + processedOutputTokens,
    ...(contextWindow !== undefined && contextWindow > 0 ? { maxTokens: contextWindow } : {}),
    inputTokens: usage.input,
    cachedInputTokens: usage.cacheRead,
    outputTokens: usage.output,
    reasoningOutputTokens: usage.reasoning,
    ...(usage.durationMs !== undefined ? { durationMs: usage.durationMs } : {}),
    ...(usage.costTotalUsd > 0 ? { costUsd: usage.costTotalUsd } : {}),
    compactsAutomatically: true,
  };
}
