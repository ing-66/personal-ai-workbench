import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  BROWSER_DIAGNOSTIC_MESSAGES,
  BrowserDiagnostic,
  BrowserSessionView,
  isBrowserSessionUsable,
  type BrowserSessionView as BrowserSessionViewType,
} from "./browserSession.ts";

const view = (overrides: Partial<BrowserSessionViewType> = {}): BrowserSessionViewType => ({
  threadId: "thread-a" as BrowserSessionViewType["threadId"],
  status: "ready",
  diagnostic: "ready",
  profileMode: "persistent",
  channel: "chrome",
  endpoint: "http://127.0.0.1:1234/mcp",
  persistentProfile: true,
  ...overrides,
});

describe("browser session view", () => {
  it("round-trips through its schema", () => {
    const decoded = Schema.decodeUnknownSync(BrowserSessionView)(view());
    expect(decoded).toEqual(view());
  });

  it("is usable only when the runtime is ready and the endpoint is known", () => {
    expect(isBrowserSessionUsable(view())).toBe(true);
    expect(isBrowserSessionUsable(view({ status: "starting" }))).toBe(false);
    expect(isBrowserSessionUsable(view({ status: "stopping" }))).toBe(false);
    expect(isBrowserSessionUsable(view({ status: "error", endpoint: null }))).toBe(false);
    // A ready runtime without an endpoint would mean a harness with nothing to
    // connect to, so it must never count as usable.
    expect(isBrowserSessionUsable(view({ endpoint: null }))).toBe(false);
  });

  it("has a complete, credential-free diagnostic vocabulary", () => {
    const diagnostics = Schema.decodeUnknownSync(Schema.Array(BrowserDiagnostic))([
      "not-configured",
      "runtime-missing",
      "starting",
      "ready",
      "browser-launch-failed",
      "mcp-handshake-failed",
      "profile-locked",
      "stopped",
      "error",
    ]);
    // Every diagnostic carries user-facing copy and nothing else: the view has no
    // free-form field that a URL, a page title, a cookie, or a profile path could
    // be smuggled through.
    for (const diagnostic of diagnostics) {
      expect(BROWSER_DIAGNOSTIC_MESSAGES[diagnostic].length).toBeGreaterThan(0);
    }
    expect(Object.keys(BROWSER_DIAGNOSTIC_MESSAGES).sort()).toEqual([...diagnostics].sort());
    expect(Object.keys(BrowserSessionView.fields)).toEqual([
      "threadId",
      "status",
      "diagnostic",
      "profileMode",
      "channel",
      "endpoint",
      "persistentProfile",
    ]);
  });

  it.effect("rejects an unknown diagnostic or profile mode", () =>
    Effect.sync(() => {
      expect(Schema.is(BrowserSessionView)({ ...view(), diagnostic: "browser-exploded" })).toBe(
        false,
      );
      expect(Schema.is(BrowserSessionView)({ ...view(), profileMode: "shared" })).toBe(false);
    }),
  );
});
