import { describe, expect, it } from "@effect/vitest";

import {
  modelGatewayCredentialEnvVar,
  withModelGatewayCredential,
  withModelGatewayEnvironment,
} from "./McpProviderSession.ts";

const base = { PATH: "/usr/bin", HOME: "/home/dev" } as NodeJS.ProcessEnv;

describe("withModelGatewayEnvironment", () => {
  it("returns the base environment untouched when the gateway carries nothing", () => {
    expect(withModelGatewayEnvironment(base, undefined)).toBe(base);
    expect(withModelGatewayEnvironment(base, {})).toBe(base);
  });

  it("merges the overlay over the inherited environment instead of replacing it", () => {
    const merged = withModelGatewayEnvironment(base, {
      modelGatewayEnvironment: {
        OPENAI_BASE_URL: "http://127.0.0.1:41234/v1",
        OPENAI_API_KEY: "session-bearer",
      },
    });
    expect(merged.PATH).toBe("/usr/bin");
    expect(merged.HOME).toBe("/home/dev");
    expect(merged.OPENAI_BASE_URL).toBe("http://127.0.0.1:41234/v1");
    expect(merged.OPENAI_API_KEY).toBe("session-bearer");
    // The base object itself is never mutated.
    expect(base.OPENAI_BASE_URL).toBeUndefined();
  });

  it("lets the overlay win only for the variables it actually names", () => {
    const merged = withModelGatewayEnvironment(
      { ...base, ANTHROPIC_API_KEY: "inherited-key" },
      {
        modelGatewayEnvironment: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:41234",
          ANTHROPIC_AUTH_TOKEN: "session-bearer",
          ANTHROPIC_API_KEY: "",
        },
      },
    );
    expect(merged.ANTHROPIC_API_KEY).toBe("");
    expect(merged.ANTHROPIC_AUTH_TOKEN).toBe("session-bearer");
  });
});

describe("modelGatewayCredentialEnvVar", () => {
  it("picks the variable the overlay itself declares", () => {
    expect(modelGatewayCredentialEnvVar({ OPENAI_BASE_URL: "x", OPENAI_API_KEY: "" })).toBe(
      "OPENAI_API_KEY",
    );
    expect(
      modelGatewayCredentialEnvVar({ ANTHROPIC_BASE_URL: "x", ANTHROPIC_AUTH_TOKEN: "" }),
    ).toBe("ANTHROPIC_AUTH_TOKEN");
    expect(modelGatewayCredentialEnvVar({ UNRELATED: "x" })).toBeUndefined();
  });
});

describe("withModelGatewayCredential", () => {
  it("substitutes the minted bearer into the overlay's own credential variable", () => {
    expect(
      withModelGatewayCredential(
        { OPENAI_BASE_URL: "http://127.0.0.1:1/v1", OPENAI_API_KEY: "" },
        "minted-bearer",
      ),
    ).toEqual({ OPENAI_BASE_URL: "http://127.0.0.1:1/v1", OPENAI_API_KEY: "minted-bearer" });
    expect(
      withModelGatewayCredential(
        { ANTHROPIC_BASE_URL: "http://127.0.0.1:1", ANTHROPIC_AUTH_TOKEN: "" },
        "minted-bearer",
      ),
    ).toEqual({ ANTHROPIC_BASE_URL: "http://127.0.0.1:1", ANTHROPIC_AUTH_TOKEN: "minted-bearer" });
  });

  it("returns the overlay unchanged when no credential was minted", () => {
    const overlay = { OPENAI_BASE_URL: "http://127.0.0.1:1/v1", OPENAI_API_KEY: "" };
    expect(withModelGatewayCredential(overlay, undefined)).toBe(overlay);
    expect(withModelGatewayCredential(overlay, "")).toBe(overlay);
  });

  it("leaves an overlay that names no credential variable alone", () => {
    const overlay = { SOME_BASE_URL: "http://127.0.0.1:1" };
    expect(withModelGatewayCredential(overlay, "minted-bearer")).toBe(overlay);
  });
});
