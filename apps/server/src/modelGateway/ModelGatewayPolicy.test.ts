import { assert, it } from "@effect/vitest";
import {
  ModelGatewayProvider,
  ModelGatewayRoute,
  ModelProviderId,
  type ModelGatewayProtocol,
  type ModelProviderId as ModelProviderIdType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  classifyModelGatewayHttpStatus,
  countsTowardCircuitBreaker,
  modelGatewayAttemptLabel,
  planModelGatewayAttempts,
  resolveModelGatewayRouteProtocol,
  shouldFailoverForFailureClass,
} from "./ModelGatewayPolicy.ts";
import { resolveModelGatewayUpstreamPath } from "./ModelGatewayProxy.ts";

const decodeProvider = Schema.decodeSync(ModelGatewayProvider);
const decodeRoute = Schema.decodeSync(ModelGatewayRoute);

const provider = (
  id: string,
  enabled = true,
  protocol: ModelGatewayProtocol = "openai-responses",
) => decodeProvider({ id, name: id, protocol, baseUrl: "https://upstream.example", enabled });

const providers = (...list: ReadonlyArray<ReturnType<typeof provider>>) =>
  Object.fromEntries(list.map((entry) => [entry.id, entry]));

const alwaysAvailable = () => true;

it("plans one pass over the route's upstreams in order", () => {
  const route = decodeRoute({
    id: "route-1",
    name: "route",
    primaryProviderId: "primary",
    backupProviderIds: ["backup-a", "backup-b"],
  });
  const plan = planModelGatewayAttempts({
    route,
    providers: providers(provider("primary"), provider("backup-a"), provider("backup-b")),
    isAvailable: alwaysAvailable,
  });
  assert.deepStrictEqual(
    plan.attempts.map((entry) => entry.id),
    ["primary", "backup-a", "backup-b"],
  );
  assert.strictEqual(plan.ordered.length, 3);
  assert.ok(plan.ordered.every((entry) => entry.kind === "upstream"));
});

it("skips a cooling upstream without retrying it later in the same request", () => {
  const route = decodeRoute({
    id: "route-1",
    name: "route",
    primaryProviderId: "primary",
    backupProviderIds: ["backup-a"],
  });
  const plan = planModelGatewayAttempts({
    route,
    providers: providers(provider("primary"), provider("backup-a")),
    isAvailable: (id: ModelProviderIdType) => id !== ModelProviderId.make("primary"),
  });
  assert.deepStrictEqual(
    plan.attempts.map((entry) => entry.id),
    ["backup-a"],
  );
  // The usage story keeps the skipped upstream in its real position.
  assert.deepStrictEqual(
    plan.ordered.map((entry) => entry.kind),
    ["breaker-open", "upstream"],
  );
  assert.strictEqual(modelGatewayAttemptLabel("primary", "breaker-open"), "primary:breaker-open");
});

it("never names the same upstream twice, and drops disabled ones entirely", () => {
  const route = decodeRoute({
    id: "route-1",
    name: "route",
    primaryProviderId: "primary",
    backupProviderIds: ["primary", "backup-a", "backup-b"],
  });
  const plan = planModelGatewayAttempts({
    route,
    providers: providers(provider("primary"), provider("backup-a"), provider("backup-b", false)),
    isAvailable: alwaysAvailable,
  });
  assert.deepStrictEqual(
    plan.attempts.map((entry) => entry.id),
    ["primary", "backup-a"],
  );
});

it("truncates to the primary when failover is switched off", () => {
  const route = decodeRoute({
    id: "route-1",
    name: "route",
    primaryProviderId: "primary",
    backupProviderIds: ["backup-a"],
    failoverEnabled: false,
  });
  const plan = planModelGatewayAttempts({
    route,
    providers: providers(provider("primary"), provider("backup-a")),
    isAvailable: alwaysAvailable,
  });
  assert.deepStrictEqual(
    plan.attempts.map((entry) => entry.id),
    ["primary"],
  );
});

it("takes the route's protocol from its primary upstream", () => {
  const route = decodeRoute({
    id: "route-1",
    name: "route",
    primaryProviderId: "primary",
    backupProviderIds: ["backup-a"],
  });
  const anthropic = providers(
    provider("primary", true, "anthropic-messages"),
    provider("backup-a", true, "anthropic-messages"),
  );
  assert.strictEqual(resolveModelGatewayRouteProtocol(route, anthropic), "anthropic-messages");
  // A route whose upstreams disagree is rejected at save time, so an undefined
  // answer here only ever means the primary is gone.
  assert.strictEqual(resolveModelGatewayRouteProtocol(route, {}), undefined);
});

it("excludes an upstream whose protocol is not the route's, and records why", () => {
  const route = decodeRoute({
    id: "route-1",
    name: "route",
    primaryProviderId: "primary",
    backupProviderIds: ["backup-a", "backup-b"],
  });
  const plan = planModelGatewayAttempts({
    route,
    providers: providers(
      provider("primary", true, "openai-responses"),
      provider("backup-a", true, "anthropic-messages"),
      provider("backup-b", true, "openai-responses"),
    ),
    isAvailable: alwaysAvailable,
  });
  // V1 converts nothing, so the Anthropic backup cannot be carried at all - and
  // it is skipped rather than silently dropped: `ordered` keeps it in place with
  // the reason, so the usage row tells the truth.
  assert.deepStrictEqual(
    plan.attempts.map((entry) => entry.id),
    ["primary", "backup-b"],
  );
  assert.deepStrictEqual(
    plan.ordered.map((entry) => entry.kind),
    ["upstream", "protocol-mismatch", "upstream"],
  );
  const excluded = plan.ordered[1];
  assert.strictEqual(
    excluded?.kind === "protocol-mismatch" ? excluded.providerId : undefined,
    "backup-a",
  );
  assert.strictEqual(
    modelGatewayAttemptLabel("backup-a", "protocol-mismatch"),
    "backup-a:protocol-mismatch",
  );
});

it("leaves a fully homogeneous route completely unaffected", () => {
  const route = decodeRoute({
    id: "route-1",
    name: "route",
    primaryProviderId: "primary",
    backupProviderIds: ["backup-a", "backup-b"],
  });
  const plan = planModelGatewayAttempts({
    route,
    providers: providers(
      provider("primary", true, "anthropic-messages"),
      provider("backup-a", true, "anthropic-messages"),
      provider("backup-b", true, "anthropic-messages"),
    ),
    isAvailable: alwaysAvailable,
  });
  assert.deepStrictEqual(
    plan.attempts.map((entry) => entry.id),
    ["primary", "backup-a", "backup-b"],
  );
  assert.ok(plan.ordered.every((entry) => entry.kind === "upstream"));
});

it("yields the primary alone when every backup speaks another protocol", () => {
  const route = decodeRoute({
    id: "route-1",
    name: "route",
    primaryProviderId: "primary",
    backupProviderIds: ["backup-a", "backup-b"],
  });
  const plan = planModelGatewayAttempts({
    route,
    providers: providers(
      provider("primary", true, "openai-responses"),
      provider("backup-a", true, "anthropic-messages"),
      provider("backup-b", true, "openai-chat"),
    ),
    isAvailable: alwaysAvailable,
  });
  assert.deepStrictEqual(
    plan.attempts.map((entry) => entry.id),
    ["primary"],
    "excluded, never reordered and never resolved by picking a winner",
  );
  assert.deepStrictEqual(
    plan.ordered.map((entry) => entry.kind),
    ["upstream", "protocol-mismatch", "protocol-mismatch"],
  );
});

it("compares against nothing when the route's primary is missing", () => {
  // A route whose primary is gone has no protocol to be homogeneous with; it is
  // unresolvable rather than re-based on a backup, and the rest of the system
  // refuses it: `resolveModelGatewayRouteProtocol` answers undefined, so no
  // harness is pointed at it and the proxy refuses every request for it.
  const route = decodeRoute({
    id: "route-1",
    name: "route",
    primaryProviderId: "gone",
    backupProviderIds: ["backup-a"],
  });
  const plan = planModelGatewayAttempts({
    route,
    providers: providers(provider("backup-a", true, "anthropic-messages")),
    isAvailable: alwaysAvailable,
  });
  assert.strictEqual(resolveModelGatewayRouteProtocol(route, {}), undefined);
  assert.deepStrictEqual(
    plan.ordered.map((entry) => entry.kind),
    ["upstream"],
  );
});

it("re-exports the frozen failover policy rather than re-deriving it", () => {
  assert.isFalse(shouldFailoverForFailureClass("auth"));
  assert.isFalse(shouldFailoverForFailureClass("invalid-request"));
  assert.isFalse(shouldFailoverForFailureClass("not-found"));
  assert.isFalse(shouldFailoverForFailureClass("response-committed"));
  assert.isTrue(shouldFailoverForFailureClass("rate-limited"));
  assert.isTrue(shouldFailoverForFailureClass("timeout"));
  assert.isTrue(shouldFailoverForFailureClass("connection"));
  assert.isTrue(shouldFailoverForFailureClass("server-error"));

  assert.strictEqual(classifyModelGatewayHttpStatus(401), "auth");
  assert.strictEqual(classifyModelGatewayHttpStatus(403), "auth");
  assert.strictEqual(classifyModelGatewayHttpStatus(402), "quota-exhausted");
  assert.strictEqual(classifyModelGatewayHttpStatus(408), "timeout");
  assert.strictEqual(classifyModelGatewayHttpStatus(429), "rate-limited");
  assert.strictEqual(classifyModelGatewayHttpStatus(500), "server-error");
  assert.strictEqual(classifyModelGatewayHttpStatus(529), "overloaded");
  assert.strictEqual(classifyModelGatewayHttpStatus(400), "invalid-request");
  assert.strictEqual(classifyModelGatewayHttpStatus(422), "invalid-request");

  // A 400 or a caller who hung up says nothing about the upstream's health.
  assert.isFalse(countsTowardCircuitBreaker("invalid-request"));
  assert.isFalse(countsTowardCircuitBreaker("auth"));
  assert.isFalse(countsTowardCircuitBreaker("client-aborted"));
  assert.isTrue(countsTowardCircuitBreaker("server-error"));
});

it("resolves the upstream path without doubling the API version segment", () => {
  // A Codex harness pointed at `<endpoint>/v1` asks for `/v1/responses`, while a
  // base URL like `https://api.deepseek.com/v1` already carries that segment.
  assert.strictEqual(
    resolveModelGatewayUpstreamPath("https://api.deepseek.com/v1", "/v1/responses"),
    "/responses",
  );
  assert.strictEqual(
    resolveModelGatewayUpstreamPath("https://api.deepseek.com", "/v1/responses"),
    "/v1/responses",
  );
  assert.strictEqual(
    resolveModelGatewayUpstreamPath("https://host.example/openai/v1/", "/v1/messages"),
    "/messages",
  );
  assert.strictEqual(
    resolveModelGatewayUpstreamPath("https://api.anthropic.com", "/v1/messages"),
    "/v1/messages",
  );
});
