/**
 * Knowledge - the Workbench's connection to SAG, the environment's knowledge
 * engine.
 *
 * Ownership is the entire point of this module, and it mirrors
 * `browserSession.ts` deliberately:
 *
 * - The **connection** (endpoint + credential) belongs to the Workbench. It is
 *   configured once and never duplicated per project.
 * - The **scope** belongs to a Project, not to a thread, a harness, a provider
 *   instance, or a browser profile. Threads inherit it, so a handoff changes
 *   nothing about which knowledge a thread can reach.
 *
 * SAG owns retrieval, storage, chunking, embeddings and source tracing. Nothing
 * here models knowledge: no sources, documents, chunks, vectors, or entities are
 * persisted, and no SAG tool is mirrored into a native Workbench toolkit. SAG's
 * own MCP server is the only interface, discovered over MCP at runtime.
 *
 * @module Knowledge
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * The user-facing reason knowledge is not usable. A closed vocabulary, like
 * `BrowserDiagnostic`: a diagnostic can never carry a token, a URL, a source
 * name, a query, or any retrieved content.
 *
 * `authenticating` is the one client-side state - it exists only while a
 * connection test is in flight.
 */
export const KnowledgeDiagnostic = Schema.Literals([
  /** No endpoint configured for this environment. */
  "not-configured",
  /** Configured, but the user switched knowledge off. */
  "disabled",
  /** A connection test is running. Client-side only. */
  "authenticating",
  "ready",
  /** The credential was missing or rejected (401). Never falls back. */
  "unauthorized",
  /** The credential was refused by an upstream proxy (403). Never falls back. */
  "forbidden",
  /** The configured scope names a source SAG does not have. Never falls back to all. */
  "source-not-found",
  /** Nothing accepted the connection at that endpoint. */
  "connection-failed",
  "timeout",
  /** Something answered, but not as a usable MCP endpoint. */
  "mcp-handshake-failed",
]);
export type KnowledgeDiagnostic = typeof KnowledgeDiagnostic.Type;

/**
 * Client copy for each diagnostic, kept next to the vocabulary so Settings, a
 * project's diagnostics, and any future surface say the same thing - and so a
 * new diagnostic cannot ship without user-facing text.
 */
export const KNOWLEDGE_DIAGNOSTIC_MESSAGES: Readonly<Record<KnowledgeDiagnostic, string>> = {
  "not-configured": "No SAG endpoint is configured for this environment.",
  disabled: "Knowledge is switched off for this environment.",
  authenticating: "Testing the connection...",
  ready: "Connected to SAG.",
  unauthorized: "SAG rejected the token. Check the Knowledge connection settings.",
  forbidden: "SAG refused this token for the requested scope.",
  "source-not-found": "The knowledge source this project selects no longer exists in SAG.",
  "connection-failed": "SAG could not be reached at the configured endpoint.",
  timeout: "SAG did not answer in time.",
  "mcp-handshake-failed": "The endpoint answered, but not as a SAG MCP server.",
};

/**
 * How one project reaches knowledge.
 *
 * `all` is an explicit opt-in: a project that selects nothing searches nothing,
 * so knowledge from one project can never leak into another by default.
 */
export const KnowledgeScopeMode = Schema.Literals(["none", "source", "all"]);
export type KnowledgeScopeMode = typeof KnowledgeScopeMode.Type;

export const KnowledgeScope = Schema.Struct({
  mode: KnowledgeScopeMode,
  /** Stable SAG source identity. The display name is carried only as a label. */
  sourceId: Schema.optionalKey(Schema.String),
  /** What the user last saw this source called. Never the primary key. */
  displayName: Schema.optionalKey(Schema.String),
});
export type KnowledgeScope = typeof KnowledgeScope.Type;

export const KNOWLEDGE_SCOPE_NONE: KnowledgeScope = { mode: "none" };

/** The scope a project without a knowledge selection has. */
export function knowledgeScopeOrNone(scope: KnowledgeScope | undefined): KnowledgeScope {
  return scope ?? KNOWLEDGE_SCOPE_NONE;
}

/** The label a briefing or a diagnostic row may show for a scope. */
export function knowledgeScopeLabel(scope: KnowledgeScope): string | null {
  switch (scope.mode) {
    case "none":
      return null;
    case "all":
      return "All Sources";
    case "source": {
      const label = scope.displayName?.trim() || scope.sourceId?.trim();
      return label && label.length > 0 ? label : "SAG source";
    }
  }
}

/**
 * The Workbench-level connection. `token` holds the real secret only inside the
 * server: settings.json stores `KNOWLEDGE_SAG_TOKEN_REDACTED` in its place and a
 * client DTO never carries it.
 *
 * Every field carries a decoding default, and that is load-bearing rather than
 * cosmetic: `settings.json` is written sparsely, so a key equal to its default is
 * omitted entirely. Without a default here, a connection with no credential
 * would be written as `{ "knowledge": { "enabled": true } }` and the next write
 * would fail to encode a missing `token`.
 */
export const KnowledgeSagConnection = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  endpoint: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  token: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type KnowledgeSagConnection = typeof KnowledgeSagConnection.Type;

export const KNOWLEDGE_SAG_TOKEN_REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022";

/** One source SAG reports in the current scope. */
export const KnowledgeSourceSummary = Schema.Struct({
  sourceId: Schema.String,
  displayName: Schema.String,
});
export type KnowledgeSourceSummary = typeof KnowledgeSourceSummary.Type;

/**
 * The live answer to "can this environment, and this project, reach knowledge?".
 *
 * Derived on every read from the configured connection, a live MCP probe, and
 * the project's scope. Never persisted: there is no `knowledge=true` row
 * anywhere.
 */
export const KnowledgeStatus = Schema.Struct({
  diagnostic: KnowledgeDiagnostic,
  /** Normalized, token-free, scope-free endpoint. Empty when unconfigured. */
  endpoint: Schema.String,
  /** The exact MCP URL a provider is handed for this scope. Null when unusable. */
  mcpUrl: Schema.NullOr(Schema.String),
  scope: KnowledgeScope,
  /** Tool names discovered from the live server, never a hardcoded catalog. */
  tools: Schema.Array(Schema.String),
  /** Sources visible in this scope, as reported by the server. */
  sources: Schema.Array(KnowledgeSourceSummary),
  /** Whether a credential is stored. The value itself is never sent. */
  hasToken: Schema.Boolean,
});
export type KnowledgeStatus = typeof KnowledgeStatus.Type;

/**
 * Whether a status means a harness can actually reach knowledge. Both halves
 * matter: a ready connection with no scope resolves to nothing, and a scope with
 * an unreachable server resolves to nothing either.
 */
export function isKnowledgeStatusAvailable(status: KnowledgeStatus): boolean {
  return status.diagnostic === "ready" && status.mcpUrl !== null;
}

/**
 * Strip a pasted endpoint down to the base MCP endpoint.
 *
 * `http`, `https`, a missing or trailing-slash path, and a pasted query are all
 * handled here, so no caller ever builds `/mcp//?source...` by concatenation.
 * A `source_id` in the pasted URL is dropped on purpose: source scope belongs to
 * a project, and honouring a URL-scoped base would silently widen every other
 * project's scope.
 */
export function normalizeKnowledgeEndpoint(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname.length === 0) return undefined;
  if (url.username.length > 0 || url.password.length > 0) return undefined;
  url.search = "";
  url.hash = "";
  url.pathname =
    url.pathname === "" || url.pathname === "/" ? "/mcp/" : ensureTrailingSlash(url.pathname);
  return url.toString();
}

function ensureTrailingSlash(pathname: string): string {
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

/**
 * The MCP URL for one scope, or `undefined` when the scope reaches nothing
 * (no endpoint, or `none`). `all` yields the bare endpoint; a source scope adds
 * `source_id`, which SAG enforces per request - a tool argument can only narrow
 * that scope, never widen it.
 */
export function buildKnowledgeMcpUrl(endpoint: string, scope: KnowledgeScope): string | undefined {
  const base = normalizeKnowledgeEndpoint(endpoint);
  if (!base) return undefined;
  if (scope.mode === "none") return undefined;
  if (scope.mode === "all") return base;
  const sourceId = scope.sourceId?.trim() ?? "";
  if (sourceId.length === 0) return undefined;
  const url = new URL(base);
  url.searchParams.set("source_id", sourceId);
  return url.toString();
}
