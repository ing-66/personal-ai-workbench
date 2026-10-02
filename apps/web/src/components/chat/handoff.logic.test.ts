import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  CommandId,
  EventId,
  type HandoffActivityPayload,
  type OrchestrationThreadActivity,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadHandoffCommand,
  deriveLatestHandoff,
  handoffFailureText,
  handoffStateLabel,
  handoffUnavailableReason,
  selectHandoffTargets,
  type HandoffTargetCandidate,
  type ThreadHandoffCommandInput,
} from "./handoff.logic";

const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const OPENCODE = ProviderInstanceId.make("opencode");
const THREAD = ThreadId.make("thread-1");
const COMMAND_ID = CommandId.make("command-1");
const CREATED_AT = "2025-01-01T00:00:00.000Z";

function candidate(
  overrides: Partial<HandoffTargetCandidate> & { instanceId: ProviderInstanceId },
): HandoffTargetCandidate {
  return {
    displayName: overrides.instanceId,
    enabled: true,
    isAvailable: true,
    status: "ready",
    ...overrides,
  };
}

function commandInput(
  overrides: Partial<ThreadHandoffCommandInput> = {},
): ThreadHandoffCommandInput {
  return {
    threadId: THREAD,
    targetProviderInstanceId: CLAUDE,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    ...overrides,
  };
}

function handoffPayload(overrides: Partial<HandoffActivityPayload> = {}): HandoffActivityPayload {
  return {
    handoffId: "handoff-1",
    fromProviderInstanceId: CODEX,
    toProviderInstanceId: CLAUDE,
    state: "accepted",
    continued: true,
    briefing: "briefing",
    briefingTruncated: false,
    violations: [],
    ...overrides,
  };
}

function activity(
  id: string,
  kind: string,
  payload: unknown,
  createdAt = CREATED_AT,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    createdAt,
  };
}

describe("buildThreadHandoffCommand", () => {
  it("omits continuationText for a switch-only handoff", () => {
    const command = buildThreadHandoffCommand(commandInput(), {
      commandId: COMMAND_ID,
      createdAt: CREATED_AT,
    });

    expect(command).toEqual({
      type: "thread.handoff",
      commandId: COMMAND_ID,
      threadId: THREAD,
      targetProviderInstanceId: CLAUDE,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: CREATED_AT,
    });
    expect("continuationText" in command).toBe(false);
    expect("modelSelection" in command).toBe(false);
  });

  it("carries the target's model and trimmed continuation text", () => {
    const command = buildThreadHandoffCommand(
      commandInput({
        modelSelection: { instanceId: CLAUDE, model: "claude-opus-4-6" },
        continuationText: "  keep going  ",
      }),
      { commandId: COMMAND_ID, createdAt: CREATED_AT },
    );

    expect(command.modelSelection).toEqual({ instanceId: CLAUDE, model: "claude-opus-4-6" });
    expect(command.continuationText).toBe("keep going");
    expect(command.targetProviderInstanceId).toBe(CLAUDE);
  });

  it("treats blank continuation text as switch-only", () => {
    const command = buildThreadHandoffCommand(commandInput({ continuationText: "   " }), {
      commandId: COMMAND_ID,
      createdAt: CREATED_AT,
    });

    expect("continuationText" in command).toBe(false);
  });
});

describe("selectHandoffTargets", () => {
  const entries = [
    candidate({ instanceId: CODEX }),
    candidate({ instanceId: CLAUDE, displayName: "Claude" }),
    candidate({ instanceId: OPENCODE, enabled: false }),
  ];

  it("offers every configured instance except the current baton holder", () => {
    const targets = selectHandoffTargets(entries, CODEX);

    expect(targets.map((target) => target.entry.instanceId)).toEqual([CLAUDE, OPENCODE]);
    expect(targets[0]?.unavailableReason).toBeNull();
    expect(targets[1]?.unavailableReason).toBe("Disabled in settings");
  });

  it("offers every instance when no baton holder is known", () => {
    expect(selectHandoffTargets(entries, null)).toHaveLength(entries.length);
  });

  it("explains why an instance cannot take the baton", () => {
    expect(handoffUnavailableReason(candidate({ instanceId: CODEX }))).toBeNull();
    expect(handoffUnavailableReason(candidate({ instanceId: CODEX, isAvailable: false }))).toBe(
      "Unavailable",
    );
    expect(handoffUnavailableReason(candidate({ instanceId: CODEX, status: "error" }))).toBe(
      "Not ready: error",
    );
  });
});

describe("handoffFailureText", () => {
  it("keeps a printable cause and drops the rest", () => {
    expect(handoffFailureText(new Error("target rejected the handoff"))).toBe(
      "target rejected the handoff",
    );
    expect(handoffFailureText("already running")).toBe("already running");
    expect(handoffFailureText("   ")).toBeUndefined();
    expect(handoffFailureText({ cause: "object" })).toBeUndefined();
    expect(handoffFailureText(undefined)).toBeUndefined();
  });
});

describe("deriveLatestHandoff", () => {
  it("returns the most recent handoff with its canonical summary", () => {
    const latest = deriveLatestHandoff([
      activity("a", "handoff", handoffPayload({ state: "requested" })),
      activity("b", "provider.turn.start", { anything: true }),
      activity("c", "handoff", handoffPayload({ state: "failed", toProviderInstanceId: OPENCODE })),
    ]);

    expect(latest?.payload.state).toBe("failed");
    expect(latest?.summary).toBe(`Handoff failed: ${CODEX} → ${OPENCODE}`);
    expect(handoffStateLabel(latest?.payload.state ?? "requested")).toBe("Failed");
  });

  it("skips malformed handoff payloads and reports nothing when none are usable", () => {
    expect(deriveLatestHandoff([])).toBeNull();
    expect(
      deriveLatestHandoff([
        activity("a", "handoff", handoffPayload({ state: "accepted" })),
        activity("b", "handoff", { handoffId: "broken" }),
      ])?.payload.state,
    ).toBe("accepted");
    expect(deriveLatestHandoff([activity("a", "handoff", null)])).toBeNull();
    expect(
      deriveLatestHandoff([activity("a", "handoff", { ...handoffPayload(), state: "unknown" })]),
    ).toBeNull();
  });
});
