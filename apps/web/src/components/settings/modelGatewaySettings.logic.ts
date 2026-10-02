import {
  DEFAULT_MODEL_GATEWAY_SETTINGS,
  MODEL_GATEWAY_CREDENTIAL_REDACTED,
  MODEL_GATEWAY_DIAGNOSTIC_MESSAGES,
  MODEL_GATEWAY_FAILURE_MESSAGES,
  MODEL_GATEWAY_PROTOCOL_LABELS,
  MODEL_GATEWAY_ROUTE_PROBLEM_MESSAGES,
  ModelGatewaySettings,
  resolveModelGatewayAttempts,
  validateModelGatewayRoute,
  type ModelGatewayDiagnostic,
  type ModelGatewayLifecycleState,
  type ModelGatewayProvider,
  type ModelGatewayProviderHealth,
  type ModelGatewayProtocol,
  type ModelGatewayRoute,
  type ModelGatewayRouteProblem,
  type ModelGatewayStatus,
  type ModelGatewayUsageDimension,
  type ModelGatewayUsageGroup,
  type ModelGatewayUsageSummary,
  type UsageModelPriceOverride,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** The provider-instance form's "not routed" choice. */
export const MODEL_GATEWAY_ROUTE_NATIVE_VALUE = "native";

/** The window the usage panel reads. One day is what "today" means to a person. */
export const MODEL_GATEWAY_USAGE_HOURS = 24;

/**
 * The gateway slice of an environment's settings.
 *
 * `ServerSettings.modelGateway` is added to the contract by the server workstream
 * (Phase 7, Workstream B). Reading through this accessor keeps the section typed
 * against the frozen `ModelGatewaySettings` shape instead of `any`, and decoding
 * fills every field's decoding default, so a settings file written before the
 * field existed - or one written sparsely - reads as the defaults.
 */
export function readModelGatewaySettings(input: {
  readonly modelGateway?: unknown;
}): ModelGatewaySettings {
  try {
    return Schema.decodeUnknownSync(ModelGatewaySettings)(input.modelGateway ?? {});
  } catch {
    // A malformed value is not worth a broken page: the defaults say the gateway
    // is off, which is the safe reading of "this environment's config is unreadable".
    return DEFAULT_MODEL_GATEWAY_SETTINGS;
  }
}

/**
 * A settings patch carrying the gateway slice. The same accessor boundary as the
 * read side: this section can only ever write fields `ModelGatewaySettings`
 * declares, and object-valued keys merge per key server-side.
 */
export function modelGatewaySettingsPatch(next: Partial<ModelGatewaySettings>): {
  readonly modelGateway: Partial<ModelGatewaySettings>;
} {
  return { modelGateway: next };
}

/** The label for a protocol id the status DTO carries as a plain string. */
export function modelGatewayProtocolLabel(protocol: string): string {
  const label = (MODEL_GATEWAY_PROTOCOL_LABELS as Readonly<Record<string, string>>)[protocol];
  return label ?? protocol;
}

export function modelGatewayProtocolChoices(): ReadonlyArray<{
  readonly value: ModelGatewayProtocol;
  readonly label: string;
}> {
  return (Object.keys(MODEL_GATEWAY_PROTOCOL_LABELS) as ModelGatewayProtocol[]).map((value) => ({
    value,
    label: MODEL_GATEWAY_PROTOCOL_LABELS[value],
  }));
}

export function modelGatewayLifecycleLabel(lifecycle: ModelGatewayLifecycleState): string {
  switch (lifecycle) {
    case "stopped":
      return "Stopped";
    case "starting":
      return "Starting";
    case "ready":
      return "Running";
    case "error":
      return "Failed";
    case "stopping":
      return "Stopping";
  }
}

export interface ModelGatewayDisplay {
  /** `null` when nothing has answered: unknown is not one of the diagnostics. */
  readonly diagnostic: ModelGatewayDiagnostic | null;
  readonly message: string;
  readonly lifecycleLabel: string;
  readonly running: boolean;
  readonly endpoint: string | null;
}

/**
 * What the status block shows.
 *
 * Unlike a probe, a client re-reading the status cannot change the gateway's own
 * state, so a stale answer stays on screen while the next one is in flight; only
 * never having had an answer reads as pending.
 */
export function resolveModelGatewayDisplay(input: {
  readonly status: ModelGatewayStatus | null;
  readonly isPending: boolean;
  readonly isError: boolean;
}): ModelGatewayDisplay {
  if (input.status !== null) {
    return {
      diagnostic: input.status.diagnostic,
      message: MODEL_GATEWAY_DIAGNOSTIC_MESSAGES[input.status.diagnostic],
      lifecycleLabel: modelGatewayLifecycleLabel(input.status.lifecycle),
      running: input.status.lifecycle === "ready",
      endpoint: input.status.endpoint,
    };
  }
  return {
    diagnostic: null,
    message: input.isPending
      ? "Reading the gateway's state."
      : input.isError
        ? "This environment did not answer, so the gateway's state is unknown."
        : "The gateway has not reported its state yet.",
    lifecycleLabel: input.isPending ? "Reading" : "Unknown",
    running: false,
    endpoint: null,
  };
}

/**
 * One provider's live health as a single line, or `null` when the gateway has not
 * reported one. A breaker's remaining cooldown is rendered from `nowMs` so the
 * line counts down without the panel holding a timer.
 */
export function modelGatewayProviderHealthText(
  health: ModelGatewayProviderHealth | null,
  nowMs: number,
): string | null {
  if (health === null) return null;
  switch (health.state) {
    case "disabled":
      return "Disabled";
    case "healthy":
      return health.consecutiveFailures === 0
        ? "Healthy"
        : `Healthy; ${formatModelGatewayCount(health.consecutiveFailures)} recent failures`;
    case "cooling": {
      const remainingMs = health.coolingUntilMs === null ? 0 : health.coolingUntilMs - nowMs;
      const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));
      const reason =
        health.lastFailureClass === null
          ? ""
          : ` (${MODEL_GATEWAY_FAILURE_MESSAGES[health.lastFailureClass]})`;
      return `Cooling down for another ${seconds}s${reason}`;
    }
  }
}

/** Whether a key is held in the secret store: the status knows; the file says so. */
export function modelGatewayProviderHasCredential(
  provider: ModelGatewayProvider,
  status: ModelGatewayStatus | null,
): boolean {
  const reported = status?.providers.find((entry) => entry.id === provider.id);
  return reported?.hasCredential ?? provider.apiKey === MODEL_GATEWAY_CREDENTIAL_REDACTED;
}

/**
 * The problems a route has, from the client's own validation and from whatever the
 * gateway reported. Neither source is authoritative alone: the client knows the
 * providers it can see, the gateway knows what it actually refuses to serve.
 */
export function mergeModelGatewayRouteProblems(
  clientProblems: ReadonlyArray<ModelGatewayRouteProblem>,
  serverProblems: ReadonlyArray<string>,
): ReadonlyArray<ModelGatewayRouteProblem> {
  const known = new Set<string>(Object.keys(MODEL_GATEWAY_ROUTE_PROBLEM_MESSAGES));
  const merged: Array<ModelGatewayRouteProblem> = [...clientProblems];
  for (const problem of serverProblems) {
    if (!known.has(problem)) continue;
    merged.push(problem as ModelGatewayRouteProblem);
  }
  return [...new Set(merged)];
}

export function modelGatewayRouteProblemMessages(
  problems: ReadonlyArray<ModelGatewayRouteProblem>,
): ReadonlyArray<string> {
  return problems.map((problem) => MODEL_GATEWAY_ROUTE_PROBLEM_MESSAGES[problem]);
}

export interface ModelGatewayRouteDisplay {
  readonly name: string;
  readonly flagged: boolean;
  readonly problems: ReadonlyArray<ModelGatewayRouteProblem>;
  readonly problemMessages: ReadonlyArray<string>;
  /** The upstreams a request would actually try, in order. */
  readonly attemptChain: string;
}

/**
 * What one route's row shows.
 *
 * `flagged` is deliberately false for a switched-off route even when its
 * problems are known: a route nobody carries cannot be misconfigured in a way
 * that matters, and the gateway reports problems for every route regardless.
 * Warning about a route the user retired on purpose would present "off" as
 * "broken" - the one reading this section must never produce. The problems stay
 * in the payload, so switching the route back on surfaces them immediately.
 */
export function modelGatewayRouteDisplay(
  route: ModelGatewayRoute,
  providers: Readonly<Record<string, ModelGatewayProvider>>,
  serverProblems: ReadonlyArray<string> = [],
): ModelGatewayRouteDisplay {
  const problems = mergeModelGatewayRouteProblems(
    validateModelGatewayRoute(route, providers),
    serverProblems,
  );
  const attempts = resolveModelGatewayAttempts(route, providers);
  return {
    name: route.name.trim().length === 0 ? "Unnamed route" : route.name,
    flagged: route.enabled && problems.length > 0,
    problems,
    problemMessages: modelGatewayRouteProblemMessages(problems),
    attemptChain:
      attempts.length === 0
        ? "No enabled upstream to send requests to."
        : attempts.map((provider) => provider.name).join(" -> "),
  };
}

export function modelGatewayProviderChoices(
  providers: Readonly<Record<string, ModelGatewayProvider>>,
): ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly protocolLabel: string;
  readonly enabled: boolean;
}> {
  return Object.values(providers).map((provider) => ({
    id: provider.id,
    name: provider.name,
    protocolLabel: modelGatewayProtocolLabel(provider.protocol),
    enabled: provider.enabled,
  }));
}

/** Reorder one entry by one step. Out-of-range moves return the list unchanged. */
export function moveModelGatewayEntry<T>(
  entries: ReadonlyArray<T>,
  index: number,
  delta: number,
): ReadonlyArray<T> {
  const target = index + delta;
  if (index < 0 || index >= entries.length || target < 0 || target >= entries.length) {
    return entries;
  }
  const next = [...entries];
  const moved = next[index]!;
  next[index] = next[target]!;
  next[target] = moved;
  return next;
}

/**
 * The list with the first provider that is not already on the route appended.
 * Backups are ordered and bounded by what exists: there is no pool to draw from.
 * Generic over the id type so the caller's branded ids survive the append.
 */
export function appendModelGatewayBackup<T extends string>(
  backups: ReadonlyArray<T>,
  providers: Readonly<Record<string, ModelGatewayProvider>>,
  primaryProviderId: string,
): ReadonlyArray<T> {
  const taken = new Set<string>([...backups, primaryProviderId]);
  const candidate = Object.keys(providers).find((id) => !taken.has(id));
  // A provider record's key is a provider id by construction.
  return candidate === undefined ? backups : [...backups, candidate as T];
}

/** A slug-shaped id the contract accepts, unique among the ids already in use. */
export function uniqueModelGatewayId(prefix: string, existingIds: ReadonlyArray<string>): string {
  const taken = new Set(existingIds);
  for (let index = 1; index < 1_000; index += 1) {
    const candidate = `${prefix}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${prefix}-${taken.size + 1}`;
}

/**
 * A new upstream with nothing configured yet. The id and the name are branded
 * strings in the contract; both are replaced by the user's own edit, exactly as
 * the provider-instance card treats a typed display name.
 */
export function blankModelGatewayProvider(id: string): ModelGatewayProvider {
  return {
    id: id as ModelGatewayProvider["id"],
    name: "New provider" as ModelGatewayProvider["name"],
    protocol: "openai-chat",
    baseUrl: "",
    apiKey: "",
    defaultModel: "",
    enabled: true,
  };
}

/** A new route pointing at one existing provider. A route needs a primary. */
export function blankModelGatewayRoute(id: string, primaryProviderId: string): ModelGatewayRoute {
  return {
    id: id as ModelGatewayRoute["id"],
    name: "New route" as ModelGatewayRoute["name"],
    enabled: true,
    primaryProviderId: primaryProviderId as ModelGatewayRoute["primaryProviderId"],
    backupProviderIds: [],
    modelMapping: {},
    failoverEnabled: true,
  };
}

/** Thousands-separated whole counts, without depending on an ICU locale. */
export function formatModelGatewayCount(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const rounded = Math.round(value);
  const digits = Math.abs(rounded).toString();
  let grouped = "";
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) grouped += ",";
    grouped += digits[index];
  }
  return rounded < 0 ? `-${grouped}` : grouped;
}

export function formatModelGatewayLatency(latencyMs: number | null): string {
  if (latencyMs === null || !Number.isFinite(latencyMs)) return "-";
  if (latencyMs < 1_000) return `${Math.round(latencyMs)} ms`;
  return `${(latencyMs / 1_000).toFixed(1)} s`;
}

export function formatModelGatewayCostUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

export function modelGatewaySuccessRate(summary: ModelGatewayUsageSummary): number | null {
  return summary.requests === 0 ? null : summary.succeeded / summary.requests;
}

export function formatModelGatewayPercent(rate: number | null): string {
  return rate === null || !Number.isFinite(rate) ? "-" : `${(rate * 100).toFixed(1)}%`;
}

export function modelGatewayTotalTokens(summary: ModelGatewayUsageSummary): number {
  return summary.inputTokens + summary.outputTokens;
}

/**
 * The totals the usage panel shows, in reading order. Tokens are shown split
 * because "in" and "out" are the two numbers a bill is made of.
 */
export function modelGatewayUsageSummaryRows(
  summary: ModelGatewayUsageSummary,
): ReadonlyArray<{ readonly id: string; readonly label: string; readonly value: string }> {
  return [
    { id: "requests", label: "Requests", value: formatModelGatewayCount(summary.requests) },
    {
      id: "tokens",
      label: "Tokens",
      value: `${formatModelGatewayCount(summary.inputTokens)} in / ${formatModelGatewayCount(summary.outputTokens)} out`,
    },
    {
      id: "success-rate",
      label: "Success rate",
      value: `${formatModelGatewayPercent(modelGatewaySuccessRate(summary))} of ${formatModelGatewayCount(summary.requests)}`,
    },
    { id: "failovers", label: "Failovers", value: formatModelGatewayCount(summary.failovers) },
    {
      id: "median-latency",
      label: "Median latency",
      value: formatModelGatewayLatency(summary.medianLatencyMs),
    },
  ];
}

export function modelGatewayUsageDimensionLabel(dimension: ModelGatewayUsageDimension): string {
  switch (dimension) {
    case "provider":
      return "Provider";
    case "model":
      return "Model";
    case "route":
      return "Route";
    case "protocol":
      return "Protocol";
  }
}

/** A group key as a person reads it: a name if one is configured, the key otherwise. */
export function modelGatewayUsageGroupLabel(input: {
  readonly dimension: ModelGatewayUsageDimension;
  readonly key: string;
  readonly providerNames: Readonly<Record<string, string>>;
  readonly routeNames: Readonly<Record<string, string>>;
}): string {
  switch (input.dimension) {
    case "provider":
      return input.providerNames[input.key] ?? input.key;
    case "route":
      return input.routeNames[input.key] ?? input.key;
    case "protocol":
      return modelGatewayProtocolLabel(input.key);
    case "model":
      return input.key;
  }
}

/**
 * An estimated cost for a usage window, or `null` when it is not computable.
 *
 * Only the model dimension can be priced here: `usagePriceOverrides` is keyed by
 * exact model id, and a provider, route or protocol group is not a model. Token
 * counts the upstream never reported are `null` in the contract and contribute
 * nothing rather than being guessed.
 */
export function estimateModelGatewayUsageCostUsd(input: {
  readonly groups: ReadonlyArray<ModelGatewayUsageGroup>;
  readonly dimension: ModelGatewayUsageDimension;
  readonly priceOverrides: Readonly<Record<string, UsageModelPriceOverride>>;
}): { readonly usd: number; readonly pricedGroups: number; readonly totalGroups: number } | null {
  if (input.dimension !== "model") return null;
  let usd = 0;
  let pricedGroups = 0;
  for (const group of input.groups) {
    const rate = input.priceOverrides[group.key];
    if (rate === undefined) continue;
    pricedGroups += 1;
    const summary = group.summary;
    usd +=
      (summary.inputTokens / 1_000_000) * rate.inputCostPerMillionTokens +
      (summary.outputTokens / 1_000_000) * rate.outputCostPerMillionTokens +
      (summary.cacheReadTokens / 1_000_000) *
        (rate.cacheReadCostPerMillionTokens ?? rate.inputCostPerMillionTokens) +
      (summary.cacheWriteTokens / 1_000_000) *
        (rate.cacheWriteCostPerMillionTokens ?? rate.inputCostPerMillionTokens);
  }
  return pricedGroups === 0 ? null : { usd, pricedGroups, totalGroups: input.groups.length };
}

/** The picker value for a harness instance's stored route selection. */
export function modelGatewayRouteSelectValue(routeId: string | undefined): string {
  const trimmed = routeId?.trim() ?? "";
  return trimmed.length === 0 ? MODEL_GATEWAY_ROUTE_NATIVE_VALUE : trimmed;
}

export function modelGatewayRouteIdFromSelectValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed === MODEL_GATEWAY_ROUTE_NATIVE_VALUE ? undefined : trimmed;
}

/**
 * Why a route is not carrying traffic, or `null` while it is.
 *
 * A switched-off route is not carried at all, so a harness that names it keeps
 * its own provider settings. The row says so instead of showing the upstream
 * chain it would only try if it were on.
 */
export function modelGatewayRouteStatusText(route: ModelGatewayRoute): string | null {
  return route.enabled
    ? null
    : "This route is switched off, so a harness that names it keeps its own provider settings.";
}

/**
 * The options a provider instance's route picker offers.
 *
 * Only routes that are switched on are offered: the gateway does not carry a
 * switched-off route, so offering one would be a control that lies. The route
 * this harness already names is the exception - it stays visible, marked off and
 * unselectable, because dropping it would silently rewrite the user's selection
 * to Native instead of showing them why their traffic stopped.
 *
 * The control is offered even when it can do nothing - the gateway is off, or
 * every route is off - because hiding it would hide the concept. `message` says
 * which of those it is.
 */
export function modelGatewayRouteChoices(input: {
  readonly enabled: boolean;
  readonly routes: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly enabled?: boolean | undefined;
  }>;
  readonly selectedRouteId?: string | undefined;
}): {
  readonly available: boolean;
  readonly message: string;
  readonly options: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
    readonly disabled: boolean;
  }>;
} {
  const selectedRouteId = input.selectedRouteId?.trim() ?? "";
  const options: Array<{ value: string; label: string; disabled: boolean }> = input.routes
    .filter((route) => route.enabled !== false)
    .map((route) => ({ value: route.id, label: route.name, disabled: false }));
  const selected = input.routes.find((route) => route.id === selectedRouteId);
  if (selected !== undefined && selected.enabled === false) {
    options.push({ value: selected.id, label: `${selected.name} (switched off)`, disabled: true });
  }

  if (!input.enabled) {
    return {
      available: false,
      message:
        "The model gateway is off. Turn it on in Settings -> Model Gateway to route this harness.",
      options,
    };
  }
  if (options.length === 0) {
    return {
      available: false,
      message:
        input.routes.length === 0
          ? "No gateway routes are configured yet. Add one in Settings -> Model Gateway."
          : "Every gateway route is switched off. Turn one on in Settings -> Model Gateway.",
      options,
    };
  }
  return { available: true, message: "", options };
}
