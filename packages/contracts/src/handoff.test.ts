import { describe, expect, it } from "@effect/vitest";

import {
  HANDOFF_BRIEFING_MAX_CHARS,
  HANDOFF_BRIEFING_MESSAGE_MAX_CHARS,
  HANDOFF_CONTINUATION_INSTRUCTION,
  applyHandoffBriefingBudget,
  composeHandoffBriefing,
  describeHandoffActivity,
  frameHandoffBriefing,
  redactHandoffText,
  serializeHandoffBriefing,
  validateHandoffBriefing,
  type HandoffBriefingInput,
} from "./handoff.ts";
import type { ProviderInstanceId } from "./providerInstance.ts";
import { ThreadId } from "./baseSchemas.ts";

const threadId = ThreadId.make("thread-handoff-1");
/** `ProviderInstanceId` is a branded string with no `.make`; tests only need the value. */
const instanceId = (value: string): ProviderInstanceId => value as ProviderInstanceId;

function baseInput(overrides: Partial<HandoffBriefingInput> = {}): HandoffBriefingInput {
  return {
    threadId,
    threadTitle: "Fix the checkout race",
    projectId: "project-1",
    workspaceRoot: "/workspace/project",
    worktreePath: null,
    sourceProviderInstanceId: instanceId("codex"),
    targetProviderInstanceId: instanceId("kimi-acp"),
    taskState: {
      status: "blocked",
      objective: "Ship the checkout race fix",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    sessionStatus: "running",
    messages: [
      { role: "user", text: "start", createdAt: "2026-01-01T00:00:00.000Z" },
      { role: "assistant", text: "done part one", createdAt: "2026-01-01T00:01:00.000Z" },
    ],
    artifacts: [
      {
        artifactId: "artifact-1",
        workspaceRelativePath: "src/checkout.ts",
        artifactType: "source",
      },
    ],
    sessionResumable: true,
    sessionLastSeenAt: null,
    capabilities: {
      available: true,
      nativeSessionResume: "supported",
      mcpServers: "unknown",
      filesystemRead: "supported",
      filesystemWrite: "supported",
      terminal: "unknown",
      workspaceTools: "supported",
      browser: "unknown",
      knowledge: "unknown",
    },
    browser: {
      available: false,
      profileMode: "persistent",
      persistentSessionExists: false,
    },
    knowledge: {
      available: true,
      scope: "Product Documentation",
    },
    ...overrides,
  };
}

describe("composeHandoffBriefing", () => {
  it("is deterministic for the same core state", () => {
    const first = serializeHandoffBriefing(composeHandoffBriefing(baseInput()));
    const second = serializeHandoffBriefing(composeHandoffBriefing(baseInput()));
    expect(first).toBe(second);
  });

  it("carries objective, status, source, target, workspace, artifacts and recent context", () => {
    const text = serializeHandoffBriefing(composeHandoffBriefing(baseInput()));
    expect(text).toContain("Objective: Ship the checkout race fix");
    expect(text).toContain("Status: blocked");
    expect(text).toContain("Working root: /workspace/project");
    expect(text).toContain("- codex");
    expect(text).toContain("- kimi-acp");
    expect(text).toContain("src/checkout.ts (source)");
    expect(text).toContain("user: start");
    expect(text).toContain("assistant: done part one");
    expect(text).toContain(HANDOFF_CONTINUATION_INSTRUCTION);
  });

  it("uses the worktree path as the working root when the thread has one", () => {
    const briefing = composeHandoffBriefing(
      baseInput({ worktreePath: "/workspace/project/.worktrees/thread-1" }),
    );
    expect(briefing.workspace.workingRoot).toBe("/workspace/project/.worktrees/thread-1");
    expect(serializeHandoffBriefing(briefing)).toContain(
      "Working root: /workspace/project/.worktrees/thread-1",
    );
  });

  it("never invents an objective: it quotes the thread title when no task state exists", () => {
    const briefing = composeHandoffBriefing(baseInput({ taskState: null }));
    expect(briefing.task.source).toBe("thread-title");
    expect(briefing.task.objective).toBe("Fix the checkout race");
  });

  it("reports a missing objective instead of fabricating one", () => {
    const briefing = composeHandoffBriefing(baseInput({ taskState: null, threadTitle: undefined }));
    expect(briefing.task.source).toBe("none");
    expect(serializeHandoffBriefing(briefing)).toContain("Objective: not recorded for this thread");
  });

  it("keeps the continuation instruction separate from the briefing body", () => {
    const briefing = composeHandoffBriefing(baseInput());
    // Context and action are distinct fields; the instruction is not a summary.
    expect(briefing.continuationInstruction).toBe(HANDOFF_CONTINUATION_INSTRUCTION);
    expect(
      briefing.recentContext.every(
        (message) => !message.text.includes("Continue the current task"),
      ),
    ).toBe(true);
  });

  it("caps how many recent messages and artifacts it carries", () => {
    const briefing = composeHandoffBriefing(
      baseInput({
        messages: Array.from({ length: 30 }, (_, index) => ({
          role: "user" as const,
          text: `message ${index}`,
          createdAt: "2026-01-01T00:00:00.000Z",
        })),
        artifacts: Array.from({ length: 40 }, (_, index) => ({
          artifactId: `artifact-${index}`,
          workspaceRelativePath: `src/file-${index}.ts`,
          artifactType: "source",
        })),
      }),
    );
    expect(briefing.recentContext).toHaveLength(8);
    expect(briefing.artifacts).toHaveLength(20);
    // Oldest context is dropped; the most recent message survives.
    expect(briefing.recentContext.at(-1)?.text).toBe("message 29");
  });
});

describe("applyHandoffBriefingBudget", () => {
  it("keeps a long thread within the budget while preserving the high-priority facts", () => {
    const briefing = composeHandoffBriefing(
      baseInput({
        messages: Array.from({ length: 8 }, (_, index) => ({
          role: "assistant" as const,
          text: `long context ${index} `.repeat(200),
          createdAt: "2026-01-01T00:00:00.000Z",
        })),
        artifacts: Array.from({ length: 20 }, (_, index) => ({
          artifactId: `artifact-${index}`,
          workspaceRelativePath: `src/${"deep/".repeat(20)}file-${index}.ts`,
          artifactType: "source",
        })),
      }),
    );
    const budgeted = applyHandoffBriefingBudget(briefing, 3_000);
    expect(budgeted.text.length).toBeLessThanOrEqual(3_000);
    expect(budgeted.truncated).toBe(true);
    // Priority order: task, status, workspace survive; older chat is what shrinks.
    expect(budgeted.text).toContain("Objective: Ship the checkout race fix");
    expect(budgeted.text).toContain("Status: blocked");
    expect(budgeted.text).toContain("Working root: /workspace/project");
  });

  it("leaves a small briefing untouched", () => {
    const briefing = composeHandoffBriefing(
      baseInput({
        messages: [{ role: "user", text: "hi", createdAt: "2026-01-01T00:00:00.000Z" }],
        artifacts: [],
      }),
    );
    const budgeted = applyHandoffBriefingBudget(briefing, HANDOFF_BRIEFING_MAX_CHARS);
    expect(budgeted.truncated).toBe(false);
    expect(budgeted.briefing).toEqual(briefing);
  });
});

describe("redactHandoffText", () => {
  it("removes assigned secret values", () => {
    expect(redactHandoffText("OPENAI_API_KEY=sk-abcdefghijklmnop")).not.toContain(
      "abcdefghijklmnop",
    );
    expect(redactHandoffText("password: hunter2hunter2")).not.toContain("hunter2hunter2");
  });

  it("removes provider-shaped tokens with no key name", () => {
    expect(redactHandoffText("use sk-proj-abcdefghijklmnopqrst next")).toBe("use [redacted] next");
    expect(redactHandoffText("token ghp_abcdefghijklmnopqrstuv")).not.toContain("ghp_");
    expect(redactHandoffText("Authorization: Bearer abcdefghijklmnop")).not.toContain(
      "abcdefghijklmnop",
    );
  });

  it("removes an entire private key block", () => {
    const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEsecret\n-----END RSA PRIVATE KEY-----";
    expect(redactHandoffText(text)).toBe("[redacted]");
  });

  it("keeps ordinary engineering content readable", () => {
    const text = [
      "src/checkout.ts:120 throws CheckoutRaceError",
      "Provider kimi-acp reported EBUSY",
      "Artifact docs/spec.md is registered",
      "Task objective: ship the checkout race fix",
    ].join("\n");
    expect(redactHandoffText(text)).toBe(text);
  });
});

describe("handoff knowledge context", () => {
  it("states availability and the scope label, never a tool list or any content", () => {
    const text = serializeHandoffBriefing(
      composeHandoffBriefing(
        baseInput({ knowledge: { available: true, scope: "Product Documentation" } }),
      ),
    );
    expect(text).toContain("Knowledge");
    expect(text).toContain("- Available to this harness: yes");
    expect(text).toContain("- Scope: Product Documentation");
    expect(text).toContain("- Knowledge: unknown");
  });

  it("says so plainly when there is no knowledge, rather than omitting the section", () => {
    const briefing = composeHandoffBriefing(
      baseInput({ knowledge: { available: false, scope: null } }),
    );
    const text = serializeHandoffBriefing(briefing);
    expect(text).toContain("- Available to this harness: no");
    expect(text).toContain("- Scope: none configured for this project");
  });

  it("defaults to unavailable for a caller that has no knowledge service", () => {
    const briefing = composeHandoffBriefing(baseInput({ knowledge: undefined }));
    expect(briefing.knowledge).toEqual({ available: false, scope: null });
  });
});

describe("validateHandoffBriefing", () => {
  it("accepts a complete briefing", () => {
    const briefing = composeHandoffBriefing(baseInput());
    expect(
      validateHandoffBriefing({
        briefing,
        text: serializeHandoffBriefing(briefing),
        threadExists: true,
        targetProviderInstanceExists: true,
        sourceProviderInstanceId: "codex",
      }),
    ).toEqual([]);
  });

  it("reports the target instance as missing when it does not exist", () => {
    const briefing = composeHandoffBriefing(baseInput());
    expect(
      validateHandoffBriefing({
        briefing,
        text: serializeHandoffBriefing(briefing),
        threadExists: true,
        targetProviderInstanceExists: false,
        sourceProviderInstanceId: "codex",
      }),
    ).toContain("missing-target");
  });

  it("refuses handing a thread to the instance that already holds it", () => {
    const briefing = composeHandoffBriefing(baseInput());
    expect(
      validateHandoffBriefing({
        briefing,
        text: serializeHandoffBriefing(briefing),
        threadExists: true,
        targetProviderInstanceExists: true,
        sourceProviderInstanceId: "kimi-acp",
      }),
    ).toContain("same-provider-instance");
  });

  it("reports an over-budget briefing", () => {
    const briefing = composeHandoffBriefing(baseInput());
    expect(
      validateHandoffBriefing({
        briefing,
        text: "x".repeat(HANDOFF_BRIEFING_MAX_CHARS + 1),
        threadExists: true,
        targetProviderInstanceExists: true,
        sourceProviderInstanceId: "codex",
      }),
    ).toContain("over-budget");
  });
});

describe("handoff framing and activity summary", () => {
  it("frames the briefing as an authoritative delimited block", () => {
    const framed = frameHandoffBriefing("HANDOFF BRIEFING\nTask");
    expect(framed.startsWith("===== WORKBENCH HANDOFF BRIEFING")).toBe(true);
    expect(framed.endsWith("===== end workbench handoff briefing =====")).toBe(true);
    expect(framed).toContain("read this first; it is authoritative");
  });

  it("summarizes each handoff state with the from → to transition", () => {
    expect(
      describeHandoffActivity({
        fromProviderInstanceId: "codex",
        toProviderInstanceId: "kimi-acp",
        state: "accepted",
      }),
    ).toBe("Handoff complete: codex → kimi-acp");
    expect(
      describeHandoffActivity({
        fromProviderInstanceId: "codex",
        toProviderInstanceId: "kimi-acp",
        state: "failed",
      }),
    ).toBe("Handoff failed: codex → kimi-acp");
    expect(
      describeHandoffActivity({
        fromProviderInstanceId: "codex",
        toProviderInstanceId: "kimi-acp",
        state: "requested",
      }),
    ).toBe("Handoff requested: codex → kimi-acp");
  });

  it("truncates a single over-long recent message to the message budget", () => {
    const briefing = composeHandoffBriefing(
      baseInput({
        messages: [
          { role: "user", text: "y".repeat(5_000), createdAt: "2026-01-01T00:00:00.000Z" },
        ],
      }),
    );
    expect(briefing.recentContext[0]?.text.length).toBeLessThanOrEqual(
      HANDOFF_BRIEFING_MESSAGE_MAX_CHARS,
    );
  });
});
