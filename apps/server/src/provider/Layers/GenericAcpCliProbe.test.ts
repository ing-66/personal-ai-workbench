// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { makeGenericAcpAdapter } from "./GenericAcpAdapter.ts";

const probe = process.env.T3_GENERIC_ACP_PROBE;
const preset =
  probe === "qwen"
    ? {
        driverKind: ProviderDriverKind.make("qwenAcp"),
        instanceId: ProviderInstanceId.make("qwenAcp"),
        displayName: "Qwen Code",
        command: "qwen",
        args: ["--acp"],
        marker: "QWEN_T3_OK",
      }
    : probe === "kimi"
      ? {
          driverKind: ProviderDriverKind.make("kimiAcp"),
          instanceId: ProviderInstanceId.make("kimiAcp"),
          displayName: "Kimi Code",
          command: "kimi",
          args: ["acp"],
          marker: "KIMI_T3_OK",
        }
      : undefined;

describe.runIf(preset !== undefined)("Generic ACP real CLI probe", () => {
  it.effect(
    "creates a real session and completes one model turn",
    () =>
      Effect.gen(function* () {
        assert.exists(preset);
        const adapter = yield* makeGenericAcpAdapter(
          { command: preset.command, args: preset.args, capabilityOverrides: {} },
          {
            instanceId: preset.instanceId,
            driverKind: preset.driverKind,
            displayName: preset.displayName,
            environment: process.env,
          },
        );
        const threadId = ThreadId.make(`real-${probe}-acp-probe`);
        const workspace = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), `t3-${probe}-acp-probe-`)),
        );
        const chunks: string[] = [];
        const events = yield* Stream.runForEach(adapter.streamEvents, (event) => {
          if (event._tag === "ContentDelta") chunks.push(event.text);
          return Effect.void;
        }).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: preset.driverKind,
          cwd: workspace,
          runtimeMode: "read-only",
        });
        yield* adapter.sendTurn({
          threadId,
          input: `Reply exactly ${preset.marker}. Do not use tools.`,
          attachments: [],
        });
        yield* adapter.stopSession(threadId);
        yield* Fiber.interrupt(events);

        assert.include(chunks.join(""), preset.marker);
      }).pipe(
        Effect.scoped,
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: `t3-${probe}-probe-` })),
        Effect.provide(NodeServices.layer),
      ),
    120_000,
  );
});
