import { describe, expect, it } from "@effect/vitest";

import {
  makePiFamilyTokenUsageSnapshot,
  piFamilyContextWindowTable,
  piFamilyUsageFromEvent,
} from "./piFamilyUsage.ts";

// Wire fixtures captured from live probes (pi 0.83.0, omp 17.2.7).

const PI_MESSAGE_END = {
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "OK" }],
    api: "openai-responses",
    provider: "edag-openai",
    model: "gpt-5.6-terra-gwc",
    usage: {
      input: 3,
      output: 5,
      cacheRead: 0,
      cacheWrite: 14785,
      reasoning: 0,
      totalTokens: 14793,
      cost: {
        input: 0.000015,
        output: 0.00015,
        cacheRead: 0,
        cacheWrite: 0.09240625,
        total: 0.09257125,
      },
    },
    stopReason: "stop",
  },
} as const;

const OMP_MESSAGE_END = {
  type: "message_end",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "…" },
      { type: "text", text: "OK" },
    ],
    api: "openai-completions",
    provider: "opencode-go",
    model: "deepseek-v4-flash",
    usage: {
      input: 5772,
      output: 29,
      cacheRead: 17280,
      cacheWrite: 0,
      totalTokens: 23081,
      reasoningTokens: 27,
      cost: {
        input: 0.00080808,
        output: 0.00000812,
        cacheRead: 0.000048384,
        cacheWrite: 0,
        total: 0.000864584,
      },
    },
    stopReason: "stop",
  },
  duration: 3036.576917,
  ttft: 25,
} as const;

const ZEROED_MESSAGE_START = {
  type: "message_start",
  message: {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "edag-openai",
    model: "gpt-5.6-terra-gwc",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
  },
} as const;

describe("piFamilyUsageFromEvent", () => {
  it("extracts the final usage from a pi message_end", () => {
    expect(piFamilyUsageFromEvent(PI_MESSAGE_END)).toEqual({
      input: 3,
      output: 5,
      cacheRead: 0,
      reasoning: 0,
      totalTokens: 14793,
      costTotalUsd: 0.09257125,
      durationMs: undefined,
    });
  });

  it("extracts the final usage from an omp message_end (reasoningTokens + duration)", () => {
    expect(piFamilyUsageFromEvent(OMP_MESSAGE_END)).toEqual({
      input: 5772,
      output: 29,
      cacheRead: 17280,
      reasoning: 27,
      totalTokens: 23081,
      costTotalUsd: 0.000864584,
      durationMs: 3037,
    });
  });

  it("skips the zeroed pre-stream usage on message_start", () => {
    expect(piFamilyUsageFromEvent(ZEROED_MESSAGE_START)).toBeUndefined();
  });

  it("returns undefined for events without a message or usage", () => {
    expect(piFamilyUsageFromEvent({ type: "agent_settled" })).toBeUndefined();
    expect(
      piFamilyUsageFromEvent({ type: "message_end", message: { role: "assistant" } }),
    ).toBeUndefined();
    expect(piFamilyUsageFromEvent(null)).toBeUndefined();
    expect(piFamilyUsageFromEvent("nope")).toBeUndefined();
  });

  it("tolerates a missing cost block (cost 0)", () => {
    const event = structuredClone(PI_MESSAGE_END) as {
      message: { usage: Record<string, unknown> };
    };
    delete event.message.usage.cost;
    expect(piFamilyUsageFromEvent(event)?.costTotalUsd).toBe(0);
  });

  it("skips usage whose totals are not final (totalTokens 0)", () => {
    const event = structuredClone(OMP_MESSAGE_END) as {
      message: { usage: Record<string, unknown> };
    };
    event.message.usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      reasoningTokens: 0,
    };
    expect(piFamilyUsageFromEvent(event)).toBeUndefined();
  });
});

describe("piFamilyContextWindowTable", () => {
  it("maps provider/id → contextWindow from a get_available_models payload", () => {
    const table = piFamilyContextWindowTable({
      models: [
        { id: "gpt-5.6-terra-gwc", provider: "edag-openai", contextWindow: 372000 },
        { id: "claude-sonnet-5", provider: "anthropic", contextWindow: 1000000 },
      ],
    });
    expect(table.get("edag-openai/gpt-5.6-terra-gwc")).toBe(372000);
    expect(table.get("anthropic/claude-sonnet-5")).toBe(1000000);
    expect(table.size).toBe(2);
  });

  it("skips models without a contextWindow or id", () => {
    const table = piFamilyContextWindowTable({
      models: [
        { id: "no-window", provider: "p", contextWindow: 0 },
        { id: "no-window-2", provider: "p" },
        { provider: "p", contextWindow: 123 },
        "garbage",
      ],
    });
    expect(table.size).toBe(0);
  });

  it("returns an empty table for a malformed payload", () => {
    expect(piFamilyContextWindowTable(undefined).size).toBe(0);
    expect(piFamilyContextWindowTable({ models: "nope" }).size).toBe(0);
    expect(piFamilyContextWindowTable({}).size).toBe(0);
  });
});

describe("makePiFamilyTokenUsageSnapshot", () => {
  it("maps usage onto the snapshot with the context window and accumulated totals", () => {
    const snapshot = makePiFamilyTokenUsageSnapshot({
      usage: piFamilyUsageFromEvent(PI_MESSAGE_END)!,
      processedInputTokens: 1000,
      processedOutputTokens: 42,
      contextWindow: 372000,
    });
    expect(snapshot).toEqual({
      usedTokens: 14793,
      totalProcessedTokens: 1042,
      maxTokens: 372000,
      inputTokens: 3,
      cachedInputTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 0,
      costUsd: 0.09257125,
      compactsAutomatically: true,
    });
  });

  it("carries reasoning and duration from omp usage", () => {
    const snapshot = makePiFamilyTokenUsageSnapshot({
      usage: piFamilyUsageFromEvent(OMP_MESSAGE_END)!,
      processedInputTokens: 0,
      processedOutputTokens: 0,
      contextWindow: 1000000,
    });
    expect(snapshot).toMatchObject({
      reasoningOutputTokens: 27,
      durationMs: 3037,
      costUsd: 0.000864584,
    });
  });

  it("omits maxTokens when the model is not in the catalog", () => {
    const snapshot = makePiFamilyTokenUsageSnapshot({
      usage: piFamilyUsageFromEvent(PI_MESSAGE_END)!,
      processedInputTokens: 0,
      processedOutputTokens: 0,
      contextWindow: undefined,
    });
    expect(snapshot.maxTokens).toBeUndefined();
    expect(snapshot.usedTokens).toBe(14793);
  });

  it("omits costUsd when the request cost nothing", () => {
    const usage = piFamilyUsageFromEvent(structuredClone(PI_MESSAGE_END))!;
    const snapshot = makePiFamilyTokenUsageSnapshot({
      usage: { ...usage, costTotalUsd: 0 },
      processedInputTokens: 0,
      processedOutputTokens: 0,
      contextWindow: undefined,
    });
    expect(snapshot.costUsd).toBeUndefined();
  });
});
