// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { ACP_HARNESS_DEFAULT_MODEL, makeGenericAcpAdapter } from "./GenericAcpAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

it.effect("launches configured ACP through the existing runtime with the project cwd and env", () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "generic-acp-workspace-")),
    );
    const requestLogPath = NodePath.join(workspace, "requests.ndjson");
    const argvLogPath = NodePath.join(workspace, "argv.txt");
    yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
    const wrapperPath = yield* Effect.sync(() =>
      writeFakeCli({
        directory: workspace,
        name: "generic-acp-fixture",
        source: execScriptSource({ scriptPath: mockAgentPath, argvLogPath }),
      }),
    );
    const instanceId = ProviderInstanceId.make("deepseek_fixture");
    const adapter = yield* makeGenericAcpAdapter(
      {
        command: wrapperPath,
        args: ["--configured", "acp"],
        capabilityOverrides: { terminal: false, supportsMcpServers: false },
      },
      {
        instanceId,
        driverKind: ProviderDriverKind.make("deepseekAcp"),
        displayName: "Fixture ACP",
        environment: {
          ...process.env,
          GENERIC_ACP_TEST_VALUE: "present",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        },
      },
    );
    const threadId = ThreadId.make("generic-acp-runtime");
    const session = yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("deepseekAcp"),
      cwd: workspace,
      runtimeMode: "full-access",
      modelSelection: { instanceId, model: ACP_HARNESS_DEFAULT_MODEL },
      resumeCursor: { schemaVersion: 1, sessionId: "unsupported-old-session" },
    });
    assert.equal(session.cwd, workspace);
    assert.equal(session.provider, "deepseekAcp");
    assert.equal(session.model, ACP_HARNESS_DEFAULT_MODEL);

    yield* adapter.sendTurn({
      threadId,
      input: "hello generic ACP",
      attachments: [],
      modelSelection: { instanceId, model: ACP_HARNESS_DEFAULT_MODEL },
    });
    yield* adapter.sendTurn({
      threadId,
      input: "hello generic ACP with legacy default",
      attachments: [],
      modelSelection: { instanceId, model: "default" },
    });
    assert.equal((yield* adapter.listSessions())[0]?.model, ACP_HARNESS_DEFAULT_MODEL);
    yield* adapter.stopSession(threadId);

    const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
    const sessionNew = requests.find((entry) => entry.method === "session/new");
    const initialize = requests.find((entry) => entry.method === "initialize");
    assert.equal((sessionNew?.params as Record<string, unknown>)?.cwd, workspace);
    assert.deepInclude(
      (initialize?.params as Record<string, unknown>)?.clientCapabilities as object,
      { terminal: false },
    );
    assert.isTrue(requests.some((entry) => entry.method === "session/prompt"));
    assert.isFalse(requests.some((entry) => entry.method === "session/set_model"));
    assert.isFalse(requests.some((entry) => entry.method === "session/load"));

    const argv = yield* Effect.promise(() => NodeFSP.readFile(argvLogPath, "utf8"));
    assert.include(argv, "--configured");
    assert.include(argv, "acp");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3code-generic-acp-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("surfaces spawn/handshake failure instead of crashing or installing anything", () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "generic-acp-broken-")),
    );
    const wrapperPath = yield* Effect.sync(() =>
      writeFakeCli({
        directory: workspace,
        name: "broken-acp-fixture",
        source: "process.stderr.write('not an ACP server\\n'); process.exit(7);",
      }),
    );
    const adapter = yield* makeGenericAcpAdapter(
      { command: wrapperPath, args: [], capabilityOverrides: {} },
      {
        instanceId: ProviderInstanceId.make("generic_broken"),
        driverKind: ProviderDriverKind.make("genericAcp"),
        displayName: "Broken ACP",
      },
    );
    const error = yield* adapter
      .startSession({
        threadId: ThreadId.make("generic-acp-broken-runtime"),
        provider: ProviderDriverKind.make("genericAcp"),
        cwd: workspace,
        runtimeMode: "full-access",
      })
      .pipe(Effect.flip);
    assert.match(error._tag, /ProviderAdapter(Process|Request|SessionClosed)Error/);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3code-generic-acp-broken-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
