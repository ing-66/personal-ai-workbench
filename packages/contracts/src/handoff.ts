import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId } from "./baseSchemas.ts";
import {
  CanonicalTaskStatus,
  type CanonicalThreadTaskState,
  HarnessCapabilityState,
  type ThreadArtifactMetadata,
} from "./coreState.ts";
import { BrowserProfileMode } from "./browserSession.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Workbench handoff: one Canonical Thread moving from the provider instance that
 * currently holds the baton to another configured instance of the same thread.
 *
 * The baton holder itself is not stored here. It stays
 * `provider_session_runtime.is_current`, which already allows one current binding
 * per thread. These schemas only describe the handoff briefing and the request
 * that carried it, so nothing on this path becomes a second current-provider
 * source of truth.
 */

export const HANDOFF_BRIEFING_VERSION = 1 as const;

/**
 * Budget for the composed briefing body, in characters.
 *
 * Basis rather than guesswork: `COMPOSER_CONTEXT_REVIEW_TEXT_MAX_CHARS` is the
 * existing ceiling for a single structured composer context payload (16k), and a
 * briefing is deliberately smaller than that because it is generated text the
 * user did not type, it is injected once per handoff, and it must stay far below
 * provider context limits when the same thread is handed off repeatedly. 8k
 * characters is roughly 2k tokens at a 4-chars-per-token estimate.
 */
export const HANDOFF_BRIEFING_MAX_CHARS = 8_000;

/** Per-message budget inside the briefing's recent-context section. */
export const HANDOFF_BRIEFING_MESSAGE_MAX_CHARS = 200;

/** How many recent thread messages the briefing may carry. */
export const HANDOFF_BRIEFING_MAX_MESSAGES = 8;

/** How many registered artifacts the briefing may carry. */
export const HANDOFF_BRIEFING_MAX_ARTIFACTS = 20;

export const HandoffBriefingMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type HandoffBriefingMessageRole = typeof HandoffBriefingMessageRole.Type;

export const HandoffBriefingMessage = Schema.Struct({
  role: HandoffBriefingMessageRole,
  text: Schema.String.check(Schema.isMaxLength(HANDOFF_BRIEFING_MESSAGE_MAX_CHARS)),
  createdAt: IsoDateTime,
});
export type HandoffBriefingMessage = typeof HandoffBriefingMessage.Type;

export const HandoffBriefingArtifact = Schema.Struct({
  artifactId: Schema.String,
  workspaceRelativePath: Schema.String,
  artifactType: Schema.String,
});
export type HandoffBriefingArtifact = typeof HandoffBriefingArtifact.Type;

/**
 * Where the briefing's one-line objective came from. The composer never invents
 * an objective: it either reads recorded Task State or quotes the thread title.
 */
export const HandoffObjectiveSource = Schema.Literals(["task-state", "thread-title", "none"]);
export type HandoffObjectiveSource = typeof HandoffObjectiveSource.Type;

export const HandoffBriefingTask = Schema.Struct({
  status: CanonicalTaskStatus,
  objective: Schema.String,
  /** Null when no Task State row exists; the objective is then the thread title. */
  updatedAt: Schema.NullOr(IsoDateTime),
  source: HandoffObjectiveSource,
});
export type HandoffBriefingTask = typeof HandoffBriefingTask.Type;

export const HandoffBriefingWorkspace = Schema.Struct({
  projectId: Schema.String,
  /** The resolved cwd rule: `thread.worktreePath ?? project.workspaceRoot`. */
  workingRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
});
export type HandoffBriefingWorkspace = typeof HandoffBriefingWorkspace.Type;

export const HandoffBriefingSession = Schema.Struct({
  /** The target instance already retains a resumable native session mapping. */
  resumable: Schema.Boolean,
  lastSeenAt: Schema.NullOr(IsoDateTime),
});
export type HandoffBriefingSession = typeof HandoffBriefingSession.Type;

export const HandoffBriefingCapabilities = Schema.Struct({
  available: Schema.Boolean,
  nativeSessionResume: Schema.Literals(["supported", "unsupported", "unknown"]),
  mcpServers: Schema.Literals(["supported", "unsupported", "unknown"]),
  filesystemRead: Schema.Literals(["supported", "unsupported", "unknown"]),
  filesystemWrite: Schema.Literals(["supported", "unsupported", "unknown"]),
  terminal: Schema.Literals(["supported", "unsupported", "unknown"]),
  /**
   * Whether host Workbench tools are reachable for the target harness. Carried as
   * one derived fact rather than a tool catalog, so a briefing never grows with
   * the tool surface.
   */
  workspaceTools: Schema.Literals(["supported", "unsupported", "unknown"]),
  /**
   * Whether the target harness can reach this thread's browser session. One
   * derived fact; the briefing never enumerates the official `browser_*` tools,
   * because the target discovers them through normal MCP listing.
   */
  browser: HarnessCapabilityState,
  /**
   * Whether the target harness can reach this project's knowledge scope. One
   * derived fact; the SAG tool list is discovered over MCP and is never carried
   * in a briefing.
   */
  knowledge: HarnessCapabilityState,
});
export type HandoffBriefingCapabilities = typeof HandoffBriefingCapabilities.Type;

/**
 * The whole of what a briefing may say about the browser: whether it is
 * reachable, how its profile is kept, and whether a stored profile already
 * exists for this thread. Deliberately two facts plus a mode - no URL, no title,
 * no DOM, no screenshot, and no cookie ever reaches a briefing.
 */
export const HandoffBriefingBrowser = Schema.Struct({
  available: Schema.Boolean,
  profileMode: Schema.Union([BrowserProfileMode, Schema.Literal("unknown")]),
  /** A stored profile for this thread already exists on disk. */
  persistentSessionExists: Schema.Boolean,
});
export type HandoffBriefingBrowser = typeof HandoffBriefingBrowser.Type;

/**
 * The whole of what a briefing may say about knowledge: whether the target can
 * reach it and what the scope is called. Deliberately no endpoint, no token, no
 * tool list, no source list, and no retrieved content - the target discovers
 * SAG's tools through normal MCP listing.
 */
export const HandoffBriefingKnowledge = Schema.Struct({
  available: Schema.Boolean,
  /** Display label of the project's scope, or null when there is none. */
  scope: Schema.NullOr(Schema.String),
});
export type HandoffBriefingKnowledge = typeof HandoffBriefingKnowledge.Type;

/**
 * Everything the briefing is allowed to say, assembled from Canonical Thread
 * facts only. Fields are optional-or-null exactly where the underlying fact can
 * be absent, so the composer never has to invent a value.
 */
export const HandoffBriefing = Schema.Struct({
  version: Schema.Literal(HANDOFF_BRIEFING_VERSION),
  threadId: ThreadId,
  task: HandoffBriefingTask,
  workspace: HandoffBriefingWorkspace,
  sourceProviderInstanceId: ProviderInstanceId,
  targetProviderInstanceId: ProviderInstanceId,
  /** Observed provider/session status for the thread, when there is one. */
  currentState: Schema.NullOr(Schema.String),
  recentContext: Schema.Array(HandoffBriefingMessage),
  artifacts: Schema.Array(HandoffBriefingArtifact),
  session: HandoffBriefingSession,
  capabilities: HandoffBriefingCapabilities,
  browser: HandoffBriefingBrowser,
  /** Live knowledge facts for the thread's project, never read from the text. */
  knowledge: HandoffBriefingKnowledge,
  /** Deterministic continuation instruction; never an LLM summary. */
  continuationInstruction: Schema.String,
});
export type HandoffBriefing = typeof HandoffBriefing.Type;

export const HandoffResultState = Schema.Literals(["requested", "accepted", "failed"]);
export type HandoffResultState = typeof HandoffResultState.Type;

/**
 * Payload of the `handoff` thread activity: the lightweight history of
 * `Codex → Kimi → DSH` transitions, carried by the existing activity log rather
 * than a second history store. `briefing` is the exact text handed over, so what
 * crossed the boundary stays auditable after a restart.
 */
export const HandoffActivityPayload = Schema.Struct({
  handoffId: Schema.String,
  fromProviderInstanceId: ProviderInstanceId,
  toProviderInstanceId: ProviderInstanceId,
  state: HandoffResultState,
  /** True when the handoff also started the target's continuation turn. */
  continued: Schema.Boolean,
  briefing: Schema.String,
  briefingTruncated: Schema.Boolean,
  violations: Schema.Array(Schema.String),
});
export type HandoffActivityPayload = typeof HandoffActivityPayload.Type;

/** Summary line for the handoff activity, deterministic so tests can assert it. */
export function describeHandoffActivity(payload: {
  readonly fromProviderInstanceId: string;
  readonly toProviderInstanceId: string;
  readonly state: HandoffResultState;
}): string {
  const transition = `${payload.fromProviderInstanceId} → ${payload.toProviderInstanceId}`;
  switch (payload.state) {
    case "requested":
      return `Handoff requested: ${transition}`;
    case "accepted":
      return `Handoff complete: ${transition}`;
    case "failed":
      return `Handoff failed: ${transition}`;
  }
}

export const HandoffBriefingInput = Schema.Struct({
  threadId: ThreadId,
  /** Canonical Thread title. Used only when no Task State objective was recorded. */
  threadTitle: Schema.optional(Schema.String),
  projectId: Schema.String,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  sourceProviderInstanceId: ProviderInstanceId,
  targetProviderInstanceId: ProviderInstanceId,
  taskState: Schema.NullOr(
    Schema.Struct({
      status: CanonicalTaskStatus,
      objective: Schema.String,
      updatedAt: IsoDateTime,
    }),
  ),
  sessionStatus: Schema.NullOr(Schema.String),
  messages: Schema.Array(HandoffBriefingMessage),
  artifacts: Schema.Array(HandoffBriefingArtifact),
  sessionResumable: Schema.Boolean,
  sessionLastSeenAt: Schema.NullOr(IsoDateTime),
  capabilities: HandoffBriefingCapabilities,
  /**
   * Live browser facts for the thread. Never derived from the briefing text:
   * the caller reads them from the thread's browser runtime.
   */
  browser: HandoffBriefingBrowser,
  /**
   * Live knowledge facts for the thread's project. Absent means "unavailable",
   * which is also what a caller without a knowledge service reports.
   */
  knowledge: Schema.optional(HandoffBriefingKnowledge),
});
export type HandoffBriefingInput = typeof HandoffBriefingInput.Type;

const SECRET_MARKERS = ["api key", "apikey", "access token", "auth token", "password", "passwd"];

/** Assignment discovered anywhere in a line: `KEY=value`, `KEY: value`, `KEY value`. */
const ASSIGNMENT_PATTERN =
  /(^|[\s"'`([{<,;])([A-Za-z0-9_.-]{0,64}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Za-z0-9_.-]{0,64})(\s*(?:=|:)\s*|\s+)(\S+)/gi;
/** Provider-shaped credentials that carry no key name at all. */
const VALUE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\bsk-proj-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, "[redacted]"],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, "Bearer [redacted]"],
  [/-----BEGIN[^-]{0,64}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,64}PRIVATE KEY-----/g, "[redacted]"],
];

/**
 * Redact credentials from briefing text without degrading ordinary engineering
 * content. Paths, symbol names, error names, provider names, task text, and
 * artifact names all survive on purpose: a briefing that cannot name a file is
 * useless to the harness receiving it.
 */
export function redactHandoffText(text: string): string {
  let output = text;
  for (const [pattern, replacement] of VALUE_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  output = output.replace(
    ASSIGNMENT_PATTERN,
    (match, prefix: string, name: string, separator: string, value: string) => {
      const lowered = name.toLowerCase();
      const isMarker = SECRET_MARKERS.some((marker) => lowered.includes(marker.replace(" ", "")));
      if (!isMarker) return match;
      // A reference, not a value: `OPENAI_API_KEY=sk-...` in prose stays readable.
      if (value.startsWith("[redacted]") || value.startsWith("$") || value.startsWith("<")) {
        return `${prefix}${name}${separator}${value}`;
      }
      return `${prefix}${name}${separator}[redacted]`;
    },
  );
  return output;
}

function collapse(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  const collapsed = collapse(value);
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 3))}...`;
}

export const HANDOFF_CONTINUATION_INSTRUCTION =
  "Continue the current task using the handoff briefing above. Respect the existing workspace state. Do not redo completed work unnecessarily. Inspect the actual current files and state before making changes.";

/**
 * The action line for a handoff the user did not ask to continue. The briefing
 * still has to reach the target's session, but nothing may start on the user's
 * behalf, so the message is context-only and the next real turn stays theirs.
 */
export const HANDOFF_CONTEXT_ONLY_INSTRUCTION =
  "You have taken over this thread through a workbench handoff. The briefing below is context only: do not start work yet. Wait for the user's next message, then continue from the briefing.";

/**
 * Objective line for the briefing. Task State is authoritative when it exists;
 * otherwise the thread title is used verbatim rather than an invented summary.
 */
function briefingObjective(input: HandoffBriefingInput): {
  readonly objective: string;
  readonly status: HandoffBriefingTask["status"];
  readonly updatedAt: string | null;
  readonly source: "task-state" | "thread-title" | "none";
} {
  if (input.taskState) {
    return {
      objective: redactHandoffText(collapse(input.taskState.objective)),
      status: input.taskState.status,
      updatedAt: input.taskState.updatedAt,
      source: "task-state",
    };
  }
  const title = input.threadTitle ? redactHandoffText(collapse(input.threadTitle)) : "";
  if (title.length > 0) {
    return { objective: title, status: "active", updatedAt: null, source: "thread-title" };
  }
  return { objective: "", status: "active", updatedAt: null, source: "none" };
}

/**
 * Deterministic, budget-bounded briefing assembly. Priority order is fixed and
 * load-bearing: task identity, task status, workspace identity, explicit current
 * state, artifacts, session/capability facts, then recent context, then older
 * context. Older chat is the first thing dropped, never the objective.
 */
export function composeHandoffBriefing(input: HandoffBriefingInput): HandoffBriefing {
  const objective = briefingObjective(input);
  const task: HandoffBriefingTask = {
    status: objective.status,
    objective: objective.objective,
    updatedAt: objective.updatedAt,
    source: objective.source,
  };
  const messages = input.messages
    .slice(-HANDOFF_BRIEFING_MAX_MESSAGES)
    .map((message) => ({
      role: message.role,
      text: redactHandoffText(truncate(message.text, HANDOFF_BRIEFING_MESSAGE_MAX_CHARS)),
      createdAt: message.createdAt,
    }))
    .filter((message) => message.text.length > 0);
  const artifacts = input.artifacts.slice(0, HANDOFF_BRIEFING_MAX_ARTIFACTS).map((artifact) => ({
    artifactId: artifact.artifactId,
    workspaceRelativePath: artifact.workspaceRelativePath,
    artifactType: artifact.artifactType,
  }));

  return {
    version: HANDOFF_BRIEFING_VERSION,
    threadId: input.threadId,
    task,
    workspace: {
      projectId: input.projectId,
      workingRoot: input.worktreePath ?? input.workspaceRoot,
      worktreePath: input.worktreePath,
    },
    sourceProviderInstanceId: input.sourceProviderInstanceId,
    targetProviderInstanceId: input.targetProviderInstanceId,
    currentState: input.sessionStatus
      ? redactHandoffText(truncate(input.sessionStatus, 400))
      : null,
    recentContext: messages,
    artifacts,
    session: {
      resumable: input.sessionResumable,
      lastSeenAt: input.sessionLastSeenAt,
    },
    capabilities: input.capabilities,
    browser: input.browser,
    knowledge: input.knowledge ?? { available: false, scope: null },
    continuationInstruction: HANDOFF_CONTINUATION_INSTRUCTION,
  };
}

/**
 * The text the target harness receives. Section order mirrors the composition
 * priority so a truncated briefing still leads with the task.
 */
export function serializeHandoffBriefing(briefing: HandoffBriefing): string {
  const lines: string[] = [];
  lines.push("HANDOFF BRIEFING");
  lines.push("");
  lines.push("Task");
  if (briefing.task.source === "none") {
    lines.push("- Objective: not recorded for this thread");
    lines.push("- Status: unknown");
  } else {
    lines.push(`- Objective: ${briefing.task.objective}`);
    lines.push(`- Status: ${briefing.task.status}`);
    lines.push(`- Objective source: ${briefing.task.source}`);
    if (briefing.task.updatedAt !== null) {
      lines.push(`- Task state updated: ${briefing.task.updatedAt}`);
    }
  }
  lines.push("");
  lines.push("Workspace");
  lines.push(`- Project: ${briefing.workspace.projectId}`);
  lines.push(`- Working root: ${briefing.workspace.workingRoot}`);
  lines.push(
    `- Worktree: ${briefing.workspace.worktreePath ?? "none (project root is the working directory)"}`,
  );
  lines.push("");
  lines.push("From");
  lines.push(`- ${briefing.sourceProviderInstanceId}`);
  lines.push("");
  lines.push("To");
  lines.push(`- ${briefing.targetProviderInstanceId}`);
  lines.push("");
  lines.push("Current State");
  lines.push(`- Provider session: ${briefing.currentState ?? "no active session recorded"}`);
  lines.push(
    `- Target native session: ${
      briefing.session.resumable
        ? "a resumable session mapping already exists and will be resumed"
        : "none retained; a new native session will be created"
    }`,
  );
  lines.push(
    `- Registered artifacts: ${briefing.artifacts.length === 0 ? "none" : String(briefing.artifacts.length)}`,
  );
  lines.push("");
  lines.push("Browser");
  lines.push(`- Available to this harness: ${briefing.browser.available ? "yes" : "no"}`);
  lines.push(`- Profile: ${briefing.browser.profileMode}`);
  lines.push(
    `- Stored session for this thread: ${
      briefing.browser.persistentSessionExists
        ? "yes, it continues where the previous harness left off"
        : "none yet"
    }`,
  );
  lines.push("");
  lines.push("Knowledge");
  lines.push(`- Available to this harness: ${briefing.knowledge.available ? "yes" : "no"}`);
  lines.push(`- Scope: ${briefing.knowledge.scope ?? "none configured for this project"}`);
  lines.push("");
  lines.push("Relevant Recent Context");
  if (briefing.recentContext.length === 0) {
    lines.push("- No recent thread messages available.");
  } else {
    for (const message of briefing.recentContext) {
      lines.push(`- ${message.role}: ${message.text}`);
    }
  }
  if (briefing.artifacts.length > 0) {
    lines.push("");
    lines.push("Artifacts");
    for (const artifact of briefing.artifacts) {
      lines.push(`- ${artifact.workspaceRelativePath} (${artifact.artifactType})`);
    }
  }
  lines.push("");
  lines.push("Native Session");
  lines.push(
    `- Resume support reported by this harness: ${briefing.capabilities.nativeSessionResume}`,
  );
  lines.push("");
  lines.push("Capabilities");
  lines.push(`- Available: ${briefing.capabilities.available ? "yes" : "no"}`);
  lines.push(`- MCP servers: ${briefing.capabilities.mcpServers}`);
  lines.push(`- Filesystem read: ${briefing.capabilities.filesystemRead}`);
  lines.push(`- Filesystem write: ${briefing.capabilities.filesystemWrite}`);
  lines.push(`- Terminal: ${briefing.capabilities.terminal}`);
  lines.push(`- Workbench tools: ${briefing.capabilities.workspaceTools}`);
  lines.push(`- Browser: ${briefing.capabilities.browser}`);
  lines.push(`- Knowledge: ${briefing.capabilities.knowledge}`);
  lines.push("");
  lines.push("Continuation");
  lines.push(`- ${briefing.continuationInstruction}`);
  return lines.join("\n");
}

/**
 * Hard budget enforcement. Low-priority sections (recent context, artifacts)
 * shrink first; the task/workspace/identity sections are never dropped.
 */
export function applyHandoffBriefingBudget(
  briefing: HandoffBriefing,
  maxChars: number = HANDOFF_BRIEFING_MAX_CHARS,
): { readonly briefing: HandoffBriefing; readonly text: string; readonly truncated: boolean } {
  let current = briefing;
  let text = serializeHandoffBriefing(current);
  if (text.length <= maxChars) return { briefing: current, text, truncated: false };

  let truncated = false;
  while (current.recentContext.length > 0 && text.length > maxChars) {
    current = { ...current, recentContext: current.recentContext.slice(0, -1) };
    text = serializeHandoffBriefing(current);
    truncated = true;
  }
  while (current.artifacts.length > 0 && text.length > maxChars) {
    current = { ...current, artifacts: current.artifacts.slice(0, -1) };
    text = serializeHandoffBriefing(current);
    truncated = true;
  }
  if (text.length > maxChars) {
    // Identity, workspace and the task line carry the handoff. Degrade the
    // free-text fields rather than dropping them so the briefing stays usable.
    current = {
      ...current,
      task: { ...current.task, objective: truncate(current.task.objective, 200) },
      currentState: current.currentState ? truncate(current.currentState, 120) : null,
    };
    text = serializeHandoffBriefing(current);
    truncated = true;
  }
  if (text.length > maxChars) {
    text = `${text.slice(0, Math.max(0, maxChars - 3))}...`;
    truncated = true;
  }
  return { briefing: current, text, truncated };
}

export const HandoffBriefingViolation = Schema.Literals([
  "empty-briefing",
  "over-budget",
  "missing-thread",
  "missing-target",
  "same-provider-instance",
  "missing-task-objective",
]);
export type HandoffBriefingViolation = typeof HandoffBriefingViolation.Type;

/**
 * Lightweight structural check. This is not a quality gate: it only refuses
 * briefings that would reach a harness with no usable task context, or that try
 * to hand a thread to the instance that already holds it.
 */
export function validateHandoffBriefing(input: {
  readonly briefing: HandoffBriefing;
  readonly text: string;
  readonly threadExists: boolean;
  readonly targetProviderInstanceExists: boolean;
  readonly sourceProviderInstanceId: string;
  readonly maxChars?: number;
}): ReadonlyArray<HandoffBriefingViolation> {
  const violations: HandoffBriefingViolation[] = [];
  if (!input.threadExists) violations.push("missing-thread");
  if (!input.targetProviderInstanceExists) violations.push("missing-target");
  if (
    input.sourceProviderInstanceId.length > 0 &&
    input.sourceProviderInstanceId === input.briefing.targetProviderInstanceId
  ) {
    violations.push("same-provider-instance");
  }
  if (input.text.trim().length === 0) violations.push("empty-briefing");
  if (input.text.length > (input.maxChars ?? HANDOFF_BRIEFING_MAX_CHARS)) {
    violations.push("over-budget");
  }
  if (input.briefing.task.objective.trim().length === 0) {
    violations.push("missing-task-objective");
  }
  return violations;
}

/**
 * Framing for transports without a real system/developer channel. The delimiters
 * and the authoritative framing are deliberate: the block has to sit above the
 * continuation instruction and be honoured as ground truth rather than
 * background chatter the harness may skip.
 */
export function frameHandoffBriefing(text: string): string {
  return [
    "===== WORKBENCH HANDOFF BRIEFING - read this first; it is authoritative =====",
    text,
    "===== end workbench handoff briefing =====",
  ].join("\n");
}

export type CoreStateTaskState = CanonicalThreadTaskState;
export type CoreStateArtifact = ThreadArtifactMetadata;
