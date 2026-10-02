/**
 * Pure logic for the composer's handoff affordance.
 *
 * Three decisions live here so they can be tested without React: which
 * configured instances may take the baton, the exact `thread.handoff` command
 * body, and the most recent handoff state read back from the thread's existing
 * activity log.
 *
 * @module handoff.logic
 */
import {
  type ClientOrchestrationCommand,
  type CommandId,
  describeHandoffActivity,
  type HandoffActivityPayload,
  type HandoffResultState,
  type ModelSelection,
  type OrchestrationThreadActivity,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";

export type ThreadHandoffCommand = Extract<ClientOrchestrationCommand, { type: "thread.handoff" }>;

export interface ThreadHandoffCommandInput {
  readonly threadId: ThreadId;
  readonly targetProviderInstanceId: ProviderInstanceId;
  /** Target instance's own model; omitted when the catalog has no default. */
  readonly modelSelection?: ModelSelection | undefined;
  /**
   * Instruction for the target's continuation turn. Absent (or blank) means a
   * switch-only handoff: the target takes the baton and waits.
   */
  readonly continuationText?: string | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface ThreadHandoffCommandMetadata {
  readonly commandId: CommandId;
  /** Wire timestamps are plain ISO strings (`IsoDateTime`). */
  readonly createdAt: string;
}

/** Build the wire command. `continuationText` is only present when non-blank. */
export function buildThreadHandoffCommand(
  input: ThreadHandoffCommandInput,
  metadata: ThreadHandoffCommandMetadata,
): ThreadHandoffCommand {
  const continuationText = input.continuationText?.trim();
  return {
    type: "thread.handoff",
    commandId: metadata.commandId,
    threadId: input.threadId,
    targetProviderInstanceId: input.targetProviderInstanceId,
    ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
    ...(continuationText ? { continuationText } : {}),
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    createdAt: metadata.createdAt,
  };
}

/**
 * The subset of a provider instance entry the handoff decision needs. Keeping it
 * structural lets tests describe instances without fabricating a wire snapshot.
 */
export interface HandoffTargetCandidate {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly isAvailable: boolean;
  readonly status: string;
}

export interface HandoffTarget<Entry extends HandoffTargetCandidate> {
  readonly entry: Entry;
  /** Null when the target can take the baton right now. */
  readonly unavailableReason: string | null;
}

/**
 * The composer's own readiness rule, kept in step with
 * `isProviderInstancePickerReady` (`enabled && isAvailable && status === "ready"`).
 */
export function handoffUnavailableReason(entry: HandoffTargetCandidate): string | null {
  if (!entry.enabled) return "Disabled in settings";
  if (!entry.isAvailable) return "Unavailable";
  if (entry.status !== "ready") return `Not ready: ${entry.status}`;
  return null;
}

/**
 * Every configured instance except the one currently holding the baton. An
 * unavailable instance is still listed so the composer can explain why it
 * cannot take over instead of silently hiding it.
 */
export function selectHandoffTargets<Entry extends HandoffTargetCandidate>(
  entries: ReadonlyArray<Entry>,
  currentInstanceId: ProviderInstanceId | null,
): ReadonlyArray<HandoffTarget<Entry>> {
  return entries
    .filter((entry) => entry.instanceId !== currentInstanceId)
    .map((entry) => ({ entry, unavailableReason: handoffUnavailableReason(entry) }));
}

/**
 * `handoff` activities carry an untyped payload on the wire, so the client
 * narrows it before trusting any field.
 */
export function isHandoffActivityPayload(value: unknown): value is HandoffActivityPayload {
  if (typeof value !== "object" || value === null) return false;
  const record: Record<string, unknown> = { ...value };
  return (
    typeof record.handoffId === "string" &&
    typeof record.fromProviderInstanceId === "string" &&
    typeof record.toProviderInstanceId === "string" &&
    (record.state === "requested" || record.state === "accepted" || record.state === "failed") &&
    typeof record.continued === "boolean" &&
    typeof record.briefing === "string" &&
    typeof record.briefingTruncated === "boolean" &&
    Array.isArray(record.violations)
  );
}

export interface LatestHandoff {
  readonly payload: HandoffActivityPayload;
  /** `describeHandoffActivity` output, so the UI never re-phrases it. */
  readonly summary: string;
  readonly createdAt: string;
}

/** Most recent well-formed `handoff` activity, in read-model order. */
export function deriveLatestHandoff(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): LatestHandoff | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities.at(index);
    if (activity === undefined || activity.kind !== "handoff") continue;
    if (!isHandoffActivityPayload(activity.payload)) continue;
    return {
      payload: activity.payload,
      summary: describeHandoffActivity(activity.payload),
      createdAt: activity.createdAt,
    };
  }
  return null;
}

/** Short label for the latest handoff's state. */
export function handoffStateLabel(state: HandoffResultState): string {
  switch (state) {
    case "requested":
      return "Requested";
    case "accepted":
      return "Accepted";
    case "failed":
      return "Failed";
  }
}

/**
 * Detail line for a failed handoff. `squashAtomCommandFailure` returns the
 * squashed cause, which is only sometimes printable.
 */
export function handoffFailureText(failure: unknown): string | undefined {
  if (failure instanceof Error) return failure.message;
  if (typeof failure === "string" && failure.trim().length > 0) return failure;
  return undefined;
}
