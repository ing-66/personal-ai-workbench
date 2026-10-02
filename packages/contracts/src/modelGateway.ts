/**
 * Model Gateway - configuration: which upstreams exist, and which of them a route
 * sends a harness's requests to.
 *
 * The distinction this module exists to hold:
 *
 * - A **harness / provider instance** is *who works* (Codex, Claude Code, a
 *   generic ACP harness). Switching one for another is a handoff, and a handoff
 *   moves the baton.
 * - A **model provider profile** is *which upstream API answers* (DeepSeek,
 *   OpenRouter, a local OpenAI-compatible endpoint). Switching one for another is
 *   a failover, and a failover changes nothing about the thread: not the baton, not
 *   the native session, not the browser profile, not the knowledge scope.
 *
 * Ownership mirrors `knowledge.ts` and `browserSession.ts` deliberately: the
 * gateway, its provider profiles and its routes belong to the **Workbench**
 * (environment), never to a project, a thread, a harness, or a provider instance.
 * A provider instance only *refers* to a route by id, and credentials are never
 * copied down that reference.
 *
 * V1 routes are **protocol-preserving**: a request is forwarded to an upstream that
 * speaks the same protocol the harness spoke. No Anthropic <-> OpenAI translation
 * exists, so no tool call, reasoning block, image, or cache field can be lost in a
 * hop that never happens. A route therefore requires every upstream on it to speak
 * the same protocol, and `validateModelGatewayRoute` enforces that at save time
 * rather than at request time.
 *
 * @module ModelGateway
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The protocol families V1 can carry.
 *
 * These are the protocols real harnesses on this machine actually speak. Gemini is
 * deliberately absent: no configured harness needs it yet, and admitting a protocol
 * the gateway cannot be exercised against would be a claim without evidence.
 */
export const ModelGatewayProtocol = Schema.Literals([
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
]);
export type ModelGatewayProtocol = typeof ModelGatewayProtocol.Type;

export const MODEL_GATEWAY_PROTOCOL_LABELS: Readonly<Record<ModelGatewayProtocol, string>> = {
  "openai-chat": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
};

/**
 * The request paths each protocol serves, with and without its `/v1` prefix.
 *
 * Used to decide two things and nothing else: whether an inbound request is a model
 * call this gateway is willing to carry, and which upstream path it maps onto.
 * Anything else (a health probe, discovery, a stray GET) is refused rather than
 * forwarded, so the gateway cannot become an open relay to the upstream.
 */
export const MODEL_GATEWAY_PROTOCOL_PATHS: Readonly<
  Record<ModelGatewayProtocol, ReadonlyArray<string>>
> = {
  "openai-chat": ["/v1/chat/completions", "/chat/completions"],
  "openai-responses": ["/v1/responses", "/responses"],
  "anthropic-messages": ["/v1/messages", "/messages"],
};

/**
 * How the upstream expects its credential. A property of the protocol rather than
 * of a vendor: OpenRouter and DeepSeek both take a bearer token, Anthropic takes
 * `x-api-key`.
 */
export const modelGatewayProtocolCredentialHeader = (
  protocol: ModelGatewayProtocol,
): "authorization" | "x-api-key" =>
  protocol === "anthropic-messages" ? "x-api-key" : "authorization";

/**
 * The protocol a harness speaks when Workbench points it at the gateway.
 *
 * `null` means this harness cannot be pointed at the gateway at all. That is a
 * real answer, not a gap: an adapter this phase never verified gets `null`, the
 * gateway withholds its endpoint, and the harness keeps using its own provider
 * settings. Reporting `unsupported-by-harness` beats guessing an env var.
 */
export type ModelGatewayHarnessProtocol = ModelGatewayProtocol;

const PROVIDER_SLUG_MAX_CHARS = 64;
const PROVIDER_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const gatewaySlug = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_SLUG_MAX_CHARS),
  Schema.isPattern(PROVIDER_SLUG_PATTERN),
);

/** Stable id of one configured upstream profile. User-chosen. */
export const ModelProviderId = gatewaySlug.pipe(Schema.brand("ModelProviderId"));
export type ModelProviderId = typeof ModelProviderId.Type;

/** Stable id of one configured route. User-chosen. */
export const ModelRouteId = gatewaySlug.pipe(Schema.brand("ModelRouteId"));
export type ModelRouteId = typeof ModelRouteId.Type;

/**
 * The marker `settings.json` stores in place of a provider API key once one is
 * held in the secret store.
 *
 * The same six-bullet marker the knowledge token and the usage-limit keys use, so
 * one "is this value redacted?" test covers every credential in the file.
 */
export const MODEL_GATEWAY_CREDENTIAL_REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022";

/** Secret-store key holding one provider's API key. */
export const modelProviderSecretName = (id: string): string =>
  `model-gateway-provider-${id.toLowerCase()}-api-key`;

/**
 * One configured upstream.
 *
 * `apiKey` is the redaction marker on disk; the value lives in the secret store
 * under `modelProviderSecretName(id)` and is materialized only when the gateway is
 * about to make a request.
 */
export const ModelGatewayProvider = Schema.Struct({
  id: ModelProviderId,
  name: TrimmedNonEmptyString,
  protocol: ModelGatewayProtocol,
  baseUrl: Schema.String,
  apiKey: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Sent as the upstream model when a request names no model and the route maps none. */
  defaultModel: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type ModelGatewayProvider = typeof ModelGatewayProvider.Type;

/**
 * One route: an ordered list of upstreams to try, plus the model aliases it
 * translates on the way out.
 *
 * `backupProviderIds` is an ordered, bounded list rather than a pool: failover is
 * deterministic and inspectable, and weighted or geographic selection is out of
 * scope by design.
 */
export const ModelGatewayRoute = Schema.Struct({
  id: ModelRouteId,
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  primaryProviderId: ModelProviderId,
  backupProviderIds: Schema.Array(ModelProviderId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Requested model -> upstream model. An unmapped name passes through. */
  modelMapping: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  failoverEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type ModelGatewayRoute = typeof ModelGatewayRoute.Type;

/**
 * The environment's gateway configuration.
 *
 * `usageRetentionDays` is the bound that keeps `model_gateway_usage` from growing
 * without limit; there is no unbounded mode.
 */
export const ModelGatewaySettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  providers: Schema.Record(ModelProviderId, ModelGatewayProvider).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  routes: Schema.Record(ModelRouteId, ModelGatewayRoute).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  usageRetentionDays: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(30))),
  /** How long an upstream stays out of rotation after its breaker opens, in ms. */
  cooldownMs: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(30_000))),
  /** Wall-clock ceiling on a single upstream attempt, in ms. */
  requestTimeoutMs: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(120_000))),
});
export type ModelGatewaySettings = typeof ModelGatewaySettings.Type;

export const DEFAULT_MODEL_GATEWAY_SETTINGS: ModelGatewaySettings = Schema.decodeSync(
  ModelGatewaySettings,
)({});

/**
 * Normalize a user-typed upstream base URL into the form the proxy builds request
 * URLs from: `http`/`https` only, no credentials, no query, no trailing slash.
 *
 * A base URL is exactly the origin (plus an optional path prefix), because the
 * inbound request path carries the API segment. Accepting a query or an embedded
 * `user:password` would let a pasted URL silently become something other than what
 * the user thought they configured.
 */
export const normalizeModelGatewayBaseUrl = (input: string): string | null => {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  if (url.search.length > 0 || url.hash.length > 0) return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
};

/**
 * Resolve which upstream model a request should ask for.
 *
 * A route maps *requested* names (what a harness asks for) onto *billing* names
 * (what an upstream charges for). An unmapped name passes through unchanged, which
 * is what makes a plain passthrough route work with no mapping at all.
 */
export const resolveModelGatewayUpstreamModel = (
  mapping: Readonly<Record<string, string>>,
  requestedModel: string,
): string => {
  const mapped = mapping[requestedModel];
  return mapped && mapped.length > 0 ? mapped : requestedModel;
};

/**
 * The ordered upstream list a route attempts: primary first, then backups, each at
 * most once.
 *
 * A disabled provider is absent from the list entirely - that is the whole of what
 * "disable an upstream" means here. `failoverEnabled: false` truncates the list to
 * the primary; it never reorders it, and it never empties a list whose primary is
 * usable.
 */
export const resolveModelGatewayAttempts = (
  route: ModelGatewayRoute,
  providers: Readonly<Record<string, ModelGatewayProvider>>,
): ReadonlyArray<ModelGatewayProvider> => {
  const primary = providers[route.primaryProviderId];
  const attempts: Array<ModelGatewayProvider> = [];
  if (primary && primary.enabled) attempts.push(primary);
  if (!route.failoverEnabled) return attempts;
  for (const id of route.backupProviderIds) {
    const backup = providers[id];
    if (!backup || !backup.enabled) continue;
    if (backup.id === primary?.id) continue;
    attempts.push(backup);
  }
  return attempts;
};

/**
 * Why a route cannot be saved. A closed vocabulary so the settings surface and any
 * future diagnostic say the same thing, and so a new reason cannot ship without
 * user-facing text.
 */
export const ModelGatewayRouteProblem = Schema.Literals([
  "name-required",
  "primary-missing",
  "primary-disabled",
  "backup-missing",
  "backup-protocol-mismatch",
  "duplicate-upstream",
  "invalid-base-url",
  "no-backup",
]);
export type ModelGatewayRouteProblem = typeof ModelGatewayRouteProblem.Type;

export const MODEL_GATEWAY_ROUTE_PROBLEM_MESSAGES: Readonly<
  Record<ModelGatewayRouteProblem, string>
> = {
  "name-required": "Give the route a name.",
  "primary-missing": "Select a primary provider.",
  "primary-disabled": "The primary provider is disabled.",
  "backup-missing": "A backup provider no longer exists.",
  "backup-protocol-mismatch":
    "Every provider on a route must speak the same protocol; V1 does not convert between protocols.",
  "duplicate-upstream": "A provider is listed twice on this route.",
  "invalid-base-url": "A provider's base URL must be an http(s) URL with no credentials or query.",
  "no-backup": "Failover is on but this route lists no usable backup provider.",
};

/**
 * Validate one route against the providers it names.
 *
 * The protocol check is the one that matters: a route whose upstreams disagree
 * about protocol would silently need conversion, and V1 has none. Rejecting that at
 * save time keeps the request path honest - the proxy never has to decide what to
 * do with a route it cannot carry.
 */
export const validateModelGatewayRoute = (
  route: ModelGatewayRoute,
  providers: Readonly<Record<string, ModelGatewayProvider>>,
): ReadonlyArray<ModelGatewayRouteProblem> => {
  const problems: Array<ModelGatewayRouteProblem> = [];
  if (route.name.trim().length === 0) problems.push("name-required");
  const primary = providers[route.primaryProviderId];
  if (!primary) {
    problems.push("primary-missing");
    return problems;
  }
  if (!primary.enabled) problems.push("primary-disabled");
  const seen = new Set<string>([primary.id]);
  const named: Array<ModelGatewayProvider> = [primary];
  for (const id of route.backupProviderIds) {
    const backup = providers[id];
    if (!backup) {
      problems.push("backup-missing");
      continue;
    }
    if (seen.has(backup.id)) {
      problems.push("duplicate-upstream");
      continue;
    }
    seen.add(backup.id);
    named.push(backup);
    if (backup.protocol !== primary.protocol) problems.push("backup-protocol-mismatch");
  }
  if (route.failoverEnabled && named.length < 2) problems.push("no-backup");
  for (const provider of named) {
    if (normalizeModelGatewayBaseUrl(provider.baseUrl) === null) {
      problems.push("invalid-base-url");
    }
  }
  return [...new Set(problems)];
};
