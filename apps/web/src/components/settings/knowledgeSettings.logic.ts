import {
  KNOWLEDGE_DIAGNOSTIC_MESSAGES,
  type KnowledgeDiagnostic,
  type KnowledgeScope,
  type KnowledgeSourceSummary,
  type KnowledgeStatus,
} from "@t3tools/contracts";

/** The three settings-row values that are not a source id. */
export const KNOWLEDGE_SCOPE_NONE_VALUE = "none";
export const KNOWLEDGE_SCOPE_ALL_VALUE = "all";
const SOURCE_VALUE_PREFIX = "source:";

/**
 * What one knowledge row shows, resolved from the live status. UI renders this;
 * the mapping itself is what the tests pin down.
 */
export interface KnowledgeDisplay {
  readonly diagnostic: KnowledgeDiagnostic;
  readonly message: string;
  readonly sources: readonly KnowledgeSourceSummary[];
  readonly hasToken: boolean;
}

/**
 * The diagnostic a row should report. A request in flight outranks a previous
 * answer: a stale `ready` while the user retests would say the connection is
 * fine at the exact moment they asked again.
 */
export function resolveKnowledgeDiagnostic(input: {
  readonly status: KnowledgeStatus | null;
  readonly isPending: boolean;
  readonly isError: boolean;
}): KnowledgeDiagnostic {
  if (input.isPending) return "authenticating";
  if (input.status !== null) return input.status.diagnostic;
  // No payload at all: either the environment refused the question or its
  // settings have not arrived yet. A missing connection is the honest reading.
  return input.isError ? "connection-failed" : "not-configured";
}

export function resolveKnowledgeDisplay(input: {
  readonly status: KnowledgeStatus | null;
  readonly isPending: boolean;
  readonly isError: boolean;
}): KnowledgeDisplay {
  const diagnostic = resolveKnowledgeDiagnostic(input);
  return {
    diagnostic,
    message: KNOWLEDGE_DIAGNOSTIC_MESSAGES[diagnostic],
    sources: input.status?.sources ?? [],
    hasToken: input.status?.hasToken ?? false,
  };
}

/**
 * The line a project's knowledge row shows about its environment.
 *
 * `disabled` and `not-configured` are the environment's own state and are left
 * to the environment's settings section: repeating them on every project would
 * say "knowledge is off" on rows that are behaving exactly as configured.
 * Every other diagnostic is about *this* project's scope, so it is named here.
 */
export function projectKnowledgeStatusText(input: {
  readonly status: KnowledgeStatus | null;
  readonly isPending: boolean;
}): string | null {
  if (input.status === null) {
    return input.isPending ? KNOWLEDGE_DIAGNOSTIC_MESSAGES.authenticating : null;
  }
  switch (input.status.diagnostic) {
    case "disabled":
    case "not-configured":
      return null;
    default:
      return KNOWLEDGE_DIAGNOSTIC_MESSAGES[input.status.diagnostic];
  }
}

/**
 * The picker's options: the sources SAG reports, plus the source this project
 * selects when SAG no longer lists it. Dropping that option would leave the row
 * unable to show what the project asks for while `source-not-found` explains it.
 */
export function knowledgeSourceChoices(
  sources: readonly KnowledgeSourceSummary[],
  scope: KnowledgeScope,
): readonly KnowledgeSourceSummary[] {
  if (scope.mode !== "source") return sources;
  const sourceId = scope.sourceId?.trim() ?? "";
  if (sourceId.length === 0) return sources;
  if (sources.some((source) => source.sourceId === sourceId)) return sources;
  return [...sources, { sourceId, displayName: scope.displayName?.trim() || sourceId }];
}

/** The value the scope picker shows for a stored scope. */
export function knowledgeScopeSelectValue(scope: KnowledgeScope): string {
  switch (scope.mode) {
    case "none":
      return KNOWLEDGE_SCOPE_NONE_VALUE;
    case "all":
      return KNOWLEDGE_SCOPE_ALL_VALUE;
    case "source": {
      const sourceId = scope.sourceId?.trim() ?? "";
      // A source-scoped entry with no id reaches nothing, so it reads as none
      // rather than as a broken option the picker cannot render a label for.
      return sourceId.length === 0
        ? KNOWLEDGE_SCOPE_NONE_VALUE
        : `${SOURCE_VALUE_PREFIX}${sourceId}`;
    }
  }
}

/**
 * The scope a picker value means, or `null` when the value names a source that
 * is not among the options. The caller writes nothing in that case: a stale
 * selection must never turn into a different scope, and least of all into
 * `all`, which would silently widen what the project searches.
 */
export function knowledgeScopeFromSelectValue(
  value: string,
  sources: readonly KnowledgeSourceSummary[],
): KnowledgeScope | null {
  if (value === KNOWLEDGE_SCOPE_NONE_VALUE) return { mode: "none" };
  if (value === KNOWLEDGE_SCOPE_ALL_VALUE) return { mode: "all" };
  if (!value.startsWith(SOURCE_VALUE_PREFIX)) return null;
  const sourceId = value.slice(SOURCE_VALUE_PREFIX.length);
  const source = sources.find((candidate) => candidate.sourceId === sourceId);
  return source === undefined
    ? null
    : { mode: "source", sourceId: source.sourceId, displayName: source.displayName };
}
