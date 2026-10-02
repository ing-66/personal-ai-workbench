/**
 * Thread browser session - the Workbench-managed Playwright MCP runtime that a
 * Canonical Thread owns.
 *
 * Ownership is the entire point of this module. The runtime and its persistent
 * profile are keyed by Canonical Thread id, so a harness handoff - which
 * replaces the native session and never the thread - reuses the same browser
 * instead of starting a second one. A profile is therefore never derived from a
 * harness, a provider, a native session, or a project.
 *
 * This is deliberately not `browserProfile.ts`, which describes named identities
 * for the in-app preview browser (client-local Electron session partitions).
 * Preview keeps its own model; the two are not merged.
 *
 * @module BrowserSession
 */
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

/**
 * Reuses T3's existing lifecycle vocabulary. `stopping` is observable because a
 * stop is asynchronous (the process scope may still be closing), unlike the
 * device hub whose stop is fire-and-forget.
 */
export const BrowserSessionStatus = Schema.Literals([
  "stopped",
  "starting",
  "ready",
  "error",
  "stopping",
]);
export type BrowserSessionStatus = typeof BrowserSessionStatus.Type;

/**
 * `persistent` keeps the thread's cookies and storage on disk across process
 * restarts, which is what makes a handoff continuity-preserving. `isolated`
 * keeps the profile in memory and is for throwaway or test sessions.
 */
export const BrowserProfileMode = Schema.Literals(["persistent", "isolated"]);
export type BrowserProfileMode = typeof BrowserProfileMode.Type;

/** The channel values upstream Playwright accepts that this build offers. */
export const BrowserChannel = Schema.Literals(["chrome", "msedge", "chromium"]);
export type BrowserChannel = typeof BrowserChannel.Type;

/**
 * The user-facing reason a browser session is not usable. This is the error
 * channel: it is a closed vocabulary so a diagnostic can never carry page
 * content, a URL, a cookie, a profile path, or any other scraped value.
 */
export const BrowserDiagnostic = Schema.Literals([
  /** No Playwright MCP package resolved in this build. */
  "not-configured",
  /** The package is present but the selected browser channel is not installed. */
  "runtime-missing",
  "starting",
  "ready",
  /** The browser process or the MCP server failed to come up. */
  "browser-launch-failed",
  /** The server answered on the port but not as a usable MCP endpoint. */
  "mcp-handshake-failed",
  /** Another process already holds this thread's persistent profile. */
  "profile-locked",
  "stopped",
  /** An unexpected failure the runtime could not classify further. */
  "error",
]);
export type BrowserDiagnostic = typeof BrowserDiagnostic.Type;

/**
 * Client copy for each diagnostic. Kept next to the vocabulary so every surface
 * (Settings, thread indicator, diagnostics panel) says the same thing, and so a
 * new diagnostic cannot ship without user-facing text.
 */
export const BROWSER_DIAGNOSTIC_MESSAGES: Readonly<Record<BrowserDiagnostic, string>> = {
  "not-configured": "The bundled Playwright MCP server was not found.",
  "runtime-missing": "Browser runtime missing: install the selected browser, then start again.",
  starting: "Starting the browser session…",
  ready: "Browser session is ready.",
  "browser-launch-failed": "The browser failed to launch.",
  "mcp-handshake-failed": "The Playwright MCP server did not answer.",
  "profile-locked": "Browser profile is already in use.",
  stopped: "Browser session is stopped. The stored profile is kept.",
  error: "The browser session stopped unexpectedly.",
};

/**
 * What a caller may know about a thread's browser. Everything here is either the
 * thread's own identity, a decision the user made in settings, or a live runtime
 * fact. Nothing is read out of the browser, and nothing is persisted.
 */
export const BrowserSessionView = Schema.Struct({
  threadId: ThreadId,
  status: BrowserSessionStatus,
  diagnostic: BrowserDiagnostic,
  profileMode: BrowserProfileMode,
  channel: BrowserChannel,
  /** Loopback MCP endpoint while the session is ready; null otherwise. */
  endpoint: Schema.NullOr(Schema.String),
  /**
   * Whether a stored profile already exists for this thread. This is the
   * "a persistent session exists" fact a handoff briefing is allowed to state;
   * its contents are never inspected.
   */
  persistentProfile: Schema.Boolean,
});
export type BrowserSessionView = typeof BrowserSessionView.Type;

/**
 * A session is usable exactly when the runtime is ready and the MCP endpoint is
 * known. Every consumer derives "browser available" from this rather than
 * persisting an availability bit.
 */
export function isBrowserSessionUsable(view: BrowserSessionView): boolean {
  return view.status === "ready" && view.endpoint !== null;
}
