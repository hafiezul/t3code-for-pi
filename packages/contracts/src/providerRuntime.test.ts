import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderRuntimeEvent } from "./providerRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("accepts fork-provided driver kinds as branded slugs", () => {
    const parsed = decodeRuntimeEvent({
      type: "session.started",
      eventId: "event-ollama-session",
      provider: "ollama",
      providerInstanceId: "ollama_local",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      payload: {
        message: "started",
      },
    });

    expect(parsed.provider).toBe("ollama");
    expect(parsed.providerInstanceId).toBe("ollama_local");
  });

  it("decodes turn.plan.updated for plan rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.plan.updated",
      eventId: "event-1",
      provider: "claudeAgent",
      sessionId: "runtime-session-1",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        explanation: "Implement schema updates",
        plan: [
          { step: "Define event union", status: "completed" },
          { step: "Wire adapter mapping", status: "inProgress" },
        ],
      },
    });

    expect(parsed.type).toBe("turn.plan.updated");
    if (parsed.type !== "turn.plan.updated") {
      throw new Error("expected turn.plan.updated");
    }
    expect(parsed.payload.plan).toHaveLength(2);
    expect(parsed.payload.plan[1]?.status).toBe("inProgress");
  });

  it("decodes proposed-plan completion events", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: "event-proposed-plan-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        planMarkdown: "# Ship it",
      },
    });

    expect(parsed.type).toBe("turn.proposed.completed");
    if (parsed.type !== "turn.proposed.completed") {
      throw new Error("expected turn.proposed.completed");
    }
    expect(parsed.payload.planMarkdown).toBe("# Ship it");
  });

  it("decodes user-input.requested with structured questions", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-2",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow edits in workspace only",
              },
              {
                label: "danger-full-access",
                description: "Allow unrestricted access",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.id).toBe("sandbox_mode");
    expect(parsed.payload.questions[0]?.options).toHaveLength(2);
    // Options-only questions default to the options answer kind — existing
    // emitters are untouched by the text-kind contract extension (#57).
    expect(parsed.payload.questions[0]?.answerKind).toBe("options");
  });

  it("decodes text-kind user-input questions with placeholder and prefill", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-text-input",
      provider: "pi",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-text",
      payload: {
        questions: [
          {
            id: "request-text",
            header: "Pi extension",
            question: "Enter a value",
            options: [],
            answerKind: "text",
            placeholder: "type something...",
          },
          {
            id: "request-editor",
            header: "Pi extension",
            question: "Edit some text",
            options: [],
            answerKind: "editor",
            initialValue: "Line 1\nLine 2",
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.answerKind).toBe("text");
    expect(parsed.payload.questions[0]?.placeholder).toBe("type something...");
    expect(parsed.payload.questions[1]?.answerKind).toBe("editor");
    expect(parsed.payload.questions[1]?.initialValue).toBe("Line 1\nLine 2");
  });

  it("decodes extension.notice and extension.status events", () => {
    const notice = decodeRuntimeEvent({
      type: "extension.notice",
      eventId: "event-notice",
      provider: "pi",
      createdAt: "2026-02-28T00:00:02.000Z",
      threadId: "thread-2",
      payload: { message: "Command blocked by user", noticeType: "warning" },
    });
    expect(notice.type).toBe("extension.notice");
    if (notice.type !== "extension.notice") {
      throw new Error("expected extension.notice");
    }
    expect(notice.payload.message).toBe("Command blocked by user");
    expect(notice.payload.noticeType).toBe("warning");

    const status = decodeRuntimeEvent({
      type: "extension.status",
      eventId: "event-status",
      provider: "pi",
      createdAt: "2026-02-28T00:00:03.000Z",
      threadId: "thread-2",
      payload: { statusKey: "my-ext", statusText: "Turn 3 running..." },
    });
    expect(status.type).toBe("extension.status");
    if (status.type !== "extension.status") {
      throw new Error("expected extension.status");
    }
    expect(status.payload.statusKey).toBe("my-ext");
    expect(status.payload.statusText).toBe("Turn 3 running...");

    // Explicit null = clear; the adapter normalizes pi's omitted statusText.
    const cleared = decodeRuntimeEvent({
      type: "extension.status",
      eventId: "event-status-clear",
      provider: "pi",
      createdAt: "2026-02-28T00:00:04.000Z",
      threadId: "thread-2",
      payload: { statusKey: "my-ext", statusText: null },
    });
    expect(cleared.type).toBe("extension.status");
    if (cleared.type !== "extension.status") {
      throw new Error("expected extension.status");
    }
    expect(cleared.payload.statusText).toBeNull();
  });

  it("decodes user-input.resolved with answer map", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.resolved",
      eventId: "event-3",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:02.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(parsed.type).toBe("user-input.resolved");
    if (parsed.type !== "user-input.resolved") {
      throw new Error("expected user-input.resolved");
    }
    expect(parsed.payload.answers.sandbox_mode).toBe("workspace-write");
  });

  it("rejects legacy message.delta type", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "message.delta",
        eventId: "event-4",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        payload: { delta: "legacy" },
      }),
    ).toThrow();
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });

  it("decodes normalized thread token usage snapshots", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: "event-token-usage-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:04.000Z",
      threadId: "thread-1",
      payload: {
        usage: {
          usedTokens: 31251,
          maxTokens: 200000,
          toolUses: 25,
          durationMs: 43567,
        },
      },
    });

    expect(parsed.type).toBe("thread.token-usage.updated");
    if (parsed.type !== "thread.token-usage.updated") {
      throw new Error("expected thread.token-usage.updated");
    }
    expect(parsed.payload.usage.maxTokens).toBe(200000);
    expect(parsed.payload.usage.usedTokens).toBe(31251);
  });
});
