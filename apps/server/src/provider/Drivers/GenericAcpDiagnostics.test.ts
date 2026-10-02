// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { GenericAcpDriver, QwenAcpDriver } from "./GenericAcpDriver.ts";

it.effect("reports a missing custom executable without attempting installation", () =>
  Effect.gen(function* () {
    const command = "t3-generic-acp-command-that-does-not-exist";
    const instance = yield* GenericAcpDriver.create({
      instanceId: ProviderInstanceId.make("generic_missing"),
      displayName: "Missing ACP",
      environment: [],
      enabled: true,
      config: { command, args: [], capabilityOverrides: {} },
    });
    const snapshot = yield* instance.snapshot.refresh;
    assert.isFalse(snapshot.installed);
    assert.equal(snapshot.status, "error");
    assert.include(snapshot.message ?? "", "was not found on this computer");
    assert.include(snapshot.message ?? "", command);
    assert.notInclude(snapshot.message ?? "", "automatically");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3code-generic-acp-diagnostics-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("rejects a branded ACP preset that is configured to launch Codex", () =>
  Effect.gen(function* () {
    const instance = yield* QwenAcpDriver.create({
      instanceId: ProviderInstanceId.make("qwenAcp"),
      displayName: "Qwen Code",
      environment: [],
      enabled: true,
      config: { command: "codex", args: ["--acp"], capabilityOverrides: {} },
    });
    const snapshot = yield* instance.snapshot.refresh;
    assert.equal(snapshot.status, "error");
    assert.include(snapshot.message ?? "", "must launch the real 'qwen' executable");
    assert.include(snapshot.message ?? "", "'codex' is not accepted");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3code-branded-acp-diagnostics-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
