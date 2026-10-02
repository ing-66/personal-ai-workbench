import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as NodeOs from "node:os";
import { randomUUID } from "node:crypto";

import * as ServerConfig from "../config.ts";
import {
  browserRootDir,
  threadBrowserDir,
  threadProfileDir,
  threadRuntimeStatePath,
} from "./BrowserPaths.ts";
import * as BrowserRuntime from "./BrowserRuntime.ts";

/**
 * A stand-in for the official Playwright MCP server: it records how it was
 * launched, binds the loopback port it was given, and answers an MCP
 * `initialize` POST. Everything else about the runtime - the process, the port,
 * the profile directory, the handshake - is real, so these tests exercise the
 * actual lifecycle rather than a mock of it.
 */
const FIXTURE_SOURCE = `
const fs = require("node:fs");
const http = require("node:http");

const args = process.argv.slice(2);
const logPath = process.env.BROWSER_TEST_LOG;
if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify({ pid: process.pid, cwd: process.cwd(), args }) + "\\n");
}

if (process.env.BROWSER_TEST_IDLE === "1") {
  // Bound to nothing on purpose: the MCP endpoint must stay unreachable so the
  // handshake diagnosis can be observed.
  setInterval(() => {}, 1000);
} else {
  const portIndex = args.indexOf("--port");
  const port = portIndex === -1 ? 0 : Number(args[portIndex + 1]);
  http
    .createServer((req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 400;
        res.end("Invalid request");
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.setHeader("mcp-session-id", "fixture");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "fixture-playwright-mcp", version: "0.0.0" },
            },
          }),
        );
      });
    })
    .listen(port, "127.0.0.1");
}
`;

const SpawnRecord = Schema.Struct({
  pid: Schema.Int,
  cwd: Schema.String,
  args: Schema.Array(Schema.String),
});
type SpawnRecord = typeof SpawnRecord.Type;
const decodeSpawnRecordLine = Schema.decodeUnknownOption(Schema.fromJsonString(SpawnRecord));

/** The runtime's on-disk crash-recovery record, written here to stage stale state. */
const encodeBrowserRuntimeState = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Int, endpoint: Schema.String })),
);

interface Sandbox {
  readonly runtime: BrowserRuntime.BrowserRuntimeShape;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly baseDir: string;
  readonly stateDir: string;
  readonly workspaceRoot: string;
  readonly logPath: string;
  readonly fixture: string;
}

type SetupOptions = Partial<BrowserRuntime.BrowserRuntimeLiveOptions> & {
  readonly extraEnvironment?: Readonly<Record<string, string>>;
};

const setup = (options?: SetupOptions) => {
  const { extraEnvironment, ...runtimeOptions } = options ?? {};
  // A plain template path keeps this helper free of a `path` module import; every
  // path the runtime itself uses comes from `Path.Path`.
  const baseDir = `${NodeOs.tmpdir()}/t3-browser-${randomUUID()}`;

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const workspaceRoot = path.join(baseDir, "workspace");
    const logPath = path.join(baseDir, "spawns.log");
    const fixture = path.join(baseDir, "fixture.cjs");
    yield* fs.makeDirectory(workspaceRoot, { recursive: true });
    yield* fs.writeFileString(fixture, FIXTURE_SOURCE);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      BROWSER_TEST_LOG: logPath,
      ...extraEnvironment,
    };
    const runtime = yield* BrowserRuntime.makeWith({
      resolveCli: () => fixture,
      channelInstalled: () => true,
      handshakeTimeoutMs: 5_000,
      ...runtimeOptions,
    }).pipe(Effect.provideService(HostProcessEnvironment, environment));
    return {
      runtime,
      fs,
      path,
      baseDir,
      stateDir: config.stateDir,
      workspaceRoot,
      logPath,
      fixture,
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        FetchHttpClient.layer,
        NetService.layer,
        ServerConfig.layerTest(baseDir, baseDir).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
};

const withSandbox = <A, E>(
  options: SetupOptions | undefined,
  body: (sandbox: Sandbox) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E | PlatformError.PlatformError, never> =>
  Effect.scoped(
    Effect.flatMap(
      Effect.acquireRelease(setup(options), (sandbox) =>
        sandbox.runtime.stopAll.pipe(
          Effect.andThen(sandbox.fs.remove(sandbox.baseDir, { recursive: true, force: true })),
          Effect.ignore,
        ),
      ),
      (sandbox) => body(sandbox),
    ),
  );

const startInput = (
  sandbox: Sandbox,
  threadId: string,
  overrides?: Partial<BrowserRuntime.BrowserStartInput>,
): BrowserRuntime.BrowserStartInput => ({
  threadId: ThreadId.make(threadId),
  profileMode: "persistent",
  channel: "chrome",
  headless: false,
  workspaceRoot: sandbox.workspaceRoot,
  ...overrides,
});

const spawnRecords = (sandbox: Sandbox) =>
  sandbox.fs.readFileString(sandbox.logPath).pipe(
    Effect.map((text) =>
      text
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => Option.toArray(decodeSpawnRecordLine(line))),
    ),
    Effect.orElseSucceed(() => [] as ReadonlyArray<SpawnRecord>),
  );

const argValue = (record: SpawnRecord, flag: string): string | undefined => {
  const index = record.args.indexOf(flag);
  return index === -1 ? undefined : record.args[index + 1];
};

const profileDirs = (records: ReadonlyArray<SpawnRecord>) =>
  records.map((record) => argValue(record, "--user-data-dir"));

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const awaitExit = (pid: number): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!isAlive(pid)) return true;
      yield* Effect.sleep(Duration.millis(50));
    }
    return false;
  });

describe("thread browser runtime", () => {
  it.live("starts one browser session per thread and reuses it", () =>
    withSandbox(undefined, (sandbox) =>
      Effect.gen(function* () {
        const input = startInput(sandbox, "thread-a");
        const first = yield* sandbox.runtime.start(input);
        expect(first.status).toBe("ready");
        expect(first.diagnostic).toBe("ready");
        expect(first.endpoint).not.toBeNull();

        const second = yield* sandbox.runtime.start(input);
        expect(second.endpoint).toBe(first.endpoint);
        expect(yield* spawnRecords(sandbox)).toHaveLength(1);
      }),
    ),
  );

  it.live("reuses the same browser when the baton changes harness", () =>
    withSandbox(undefined, (sandbox) =>
      Effect.gen(function* () {
        // A handoff replaces the provider session and never the Canonical Thread,
        // so the runtime is asked for the same thread a second time.
        const input = startInput(sandbox, "thread-a");
        const asCodex = yield* sandbox.runtime.start(input);
        const asKimi = yield* sandbox.runtime.start(input);

        expect(asKimi.status).toBe("ready");
        expect(asKimi.endpoint).toBe(asCodex.endpoint);
        expect(asKimi.profileMode).toBe("persistent");
        expect(yield* spawnRecords(sandbox)).toHaveLength(1);
      }),
    ),
  );

  it.live("launches inside the thread workspace with the thread's own profile", () =>
    withSandbox(undefined, (sandbox) =>
      Effect.gen(function* () {
        yield* sandbox.runtime.start(startInput(sandbox, "thread-a"));
        const [record] = yield* spawnRecords(sandbox);
        expect(record).toBeDefined();

        // cwd is the thread workspace: upstream bounds file access to it, so
        // uploads and named downloads cannot leave the workspace.
        expect(record!.cwd.endsWith("workspace")).toBe(true);
        // One context for every client of this endpoint, so a reconnecting
        // harness keeps its tabs.
        expect(record!.args).toContain("--shared-browser-context");
        expect(argValue(record!, "--browser")).toBe("chrome");
        expect(argValue(record!, "--host")).toBe("127.0.0.1");
        expect(argValue(record!, "--port")).toBeDefined();
        expect(record!.args).not.toContain("--isolated");

        const stateDir = sandbox.path.join(sandbox.stateDir);
        const expectedProfile = threadProfileDir(sandbox.path, stateDir, "thread-a");
        expect(argValue(record!, "--user-data-dir")).toBe(expectedProfile);
        expect(expectedProfile.startsWith(browserRootDir(sandbox.path, stateDir))).toBe(true);
        // Auto-named output (an unnamed screenshot, a trace) lands under userdata,
        // never in the project.
        expect(argValue(record!, "--output-dir")).toBe(
          sandbox.path.join(threadBrowserDir(sandbox.path, stateDir, "thread-a"), "output"),
        );
      }),
    ),
  );

  it.live("keeps thread profiles disjoint, so one thread cannot inherit another's", () =>
    withSandbox(undefined, (sandbox) =>
      Effect.gen(function* () {
        yield* sandbox.runtime.start(startInput(sandbox, "thread-a"));
        yield* sandbox.runtime.start(startInput(sandbox, "thread-b"));
        const dirs = profileDirs(yield* spawnRecords(sandbox));
        expect(dirs).toHaveLength(2);
        expect(dirs[0]).not.toBe(dirs[1]);
        for (const dir of dirs) expect(dir).toBeDefined();
      }),
    ),
  );

  it.live("stopping keeps the stored profile and restarting reuses it", () =>
    withSandbox(undefined, (sandbox) =>
      Effect.gen(function* () {
        const input = startInput(sandbox, "thread-a");
        const started = yield* sandbox.runtime.start(input);
        const profileDir = threadProfileDir(sandbox.path, sandbox.stateDir, "thread-a");
        const firstPid = (yield* spawnRecords(sandbox))[0]!.pid;

        const stopped = yield* sandbox.runtime.stop(input.threadId);
        expect(stopped.status).toBe("stopped");
        expect(stopped.endpoint).toBeNull();
        // Process lifetime is not profile lifetime.
        expect(stopped.persistentProfile).toBe(true);
        expect(yield* sandbox.fs.exists(profileDir)).toBe(true);
        expect(yield* awaitExit(firstPid)).toBe(true);

        const restarted = yield* sandbox.runtime.start(input);
        expect(restarted.status).toBe("ready");
        expect(restarted.endpoint).not.toBe(started.endpoint);
        const records = yield* spawnRecords(sandbox);
        expect(records).toHaveLength(2);
        const dirs = profileDirs(records);
        expect(dirs[0]).toBe(dirs[1]);
        expect(dirs[1]).toBe(profileDir);
      }),
    ),
  );

  it.live("isolated mode uses no stored profile and reports none", () =>
    withSandbox(undefined, (sandbox) =>
      Effect.gen(function* () {
        const view = yield* sandbox.runtime.start(
          startInput(sandbox, "thread-a", { profileMode: "isolated" }),
        );
        expect(view.status).toBe("ready");
        expect(view.persistentProfile).toBe(false);
        const [record] = yield* spawnRecords(sandbox);
        expect(record!.args).toContain("--isolated");
        expect(argValue(record!, "--user-data-dir")).toBeUndefined();
      }),
    ),
  );

  it.live("refuses a profile another process holds instead of repairing it", () =>
    withSandbox(undefined, (sandbox) =>
      Effect.gen(function* () {
        const statePath = threadRuntimeStatePath(sandbox.path, sandbox.stateDir, "thread-a");
        yield* sandbox.fs.makeDirectory(sandbox.path.dirname(statePath), { recursive: true });
        // Our own pid is alive, so the record must be treated as a live owner.
        yield* sandbox.fs.writeFileString(
          statePath,
          encodeBrowserRuntimeState({ pid: process.pid, endpoint: "http://127.0.0.1:1/mcp" }),
        );

        const view = yield* sandbox.runtime.start(startInput(sandbox, "thread-a"));
        expect(view.status).toBe("error");
        expect(view.diagnostic).toBe("profile-locked");
        // Nothing was started, nothing was deleted, and no lock file was touched.
        expect(yield* spawnRecords(sandbox)).toHaveLength(0);
        expect(yield* sandbox.fs.exists(statePath)).toBe(true);
      }),
    ),
  );

  it.live("reaps a record whose process is gone and reuses the profile", () =>
    withSandbox(undefined, (sandbox) =>
      Effect.gen(function* () {
        const statePath = threadRuntimeStatePath(sandbox.path, sandbox.stateDir, "thread-a");
        yield* sandbox.fs.makeDirectory(sandbox.path.dirname(statePath), { recursive: true });
        yield* sandbox.fs.writeFileString(
          statePath,
          encodeBrowserRuntimeState({ pid: 2_147_483_600, endpoint: "http://127.0.0.1:1/mcp" }),
        );

        const view = yield* sandbox.runtime.start(startInput(sandbox, "thread-a"));
        expect(view.status).toBe("ready");
        expect(yield* spawnRecords(sandbox)).toHaveLength(1);
      }),
    ),
  );

  it.live("reports a missing runtime rather than downloading one", () =>
    withSandbox({ channelInstalled: () => false }, (sandbox) =>
      Effect.gen(function* () {
        const view = yield* sandbox.runtime.start(startInput(sandbox, "thread-a"));
        expect(view.status).toBe("error");
        expect(view.diagnostic).toBe("runtime-missing");
        expect(yield* spawnRecords(sandbox)).toHaveLength(0);
      }),
    ),
  );

  it.live("reports a missing packaged server rather than falling back to npx", () =>
    withSandbox({ resolveCli: () => null }, (sandbox) =>
      Effect.gen(function* () {
        const view = yield* sandbox.runtime.start(startInput(sandbox, "thread-a"));
        expect(view.diagnostic).toBe("not-configured");
        expect(yield* spawnRecords(sandbox)).toHaveLength(0);
      }),
    ),
  );

  it.live("reports a failed MCP handshake and leaves no endpoint behind", () =>
    withSandbox(
      { handshakeTimeoutMs: 1_200, extraEnvironment: { BROWSER_TEST_IDLE: "1" } },
      (sandbox) =>
        Effect.gen(function* () {
          const view = yield* sandbox.runtime.start(startInput(sandbox, "thread-a"));
          expect(view.status).toBe("error");
          expect(view.diagnostic).toBe("mcp-handshake-failed");
          expect(view.endpoint).toBeNull();
          const pid = (yield* spawnRecords(sandbox))[0]!.pid;
          expect(yield* awaitExit(pid)).toBe(true);
          expect(
            yield* sandbox.fs.exists(
              threadRuntimeStatePath(sandbox.path, sandbox.stateDir, "thread-a"),
            ),
          ).toBe(false);
        }),
    ),
  );

  it.live("reset deletes the stored profile only when explicitly asked", () =>
    withSandbox(undefined, (sandbox) =>
      Effect.gen(function* () {
        const input = startInput(sandbox, "thread-a");
        yield* sandbox.runtime.start(input);
        const profileDir = threadProfileDir(sandbox.path, sandbox.stateDir, "thread-a");
        yield* sandbox.fs.writeFileString(sandbox.path.join(profileDir, "Cookies"), "stored login");
        expect(yield* sandbox.fs.exists(profileDir)).toBe(true);

        const reset = yield* sandbox.runtime.resetProfile(input);
        expect(reset.status).toBe("stopped");
        expect(reset.persistentProfile).toBe(false);
        expect(yield* sandbox.fs.exists(profileDir)).toBe(false);
      }),
    ),
  );

  it.live("describes handoff facts without reading the profile", () =>
    withSandbox(undefined, (sandbox) =>
      Effect.gen(function* () {
        const input = startInput(sandbox, "thread-a");
        expect(yield* sandbox.runtime.describeForHandoff(input.threadId)).toEqual({
          available: false,
          profileMode: "unknown",
          persistentSessionExists: false,
        });

        yield* sandbox.runtime.start(input);
        expect(yield* sandbox.runtime.describeForHandoff(input.threadId)).toEqual({
          available: true,
          profileMode: "persistent",
          persistentSessionExists: true,
        });
      }),
    ),
  );

  it.live("leaves no browser state in the project workspace", () =>
    withSandbox(undefined, (sandbox) =>
      Effect.gen(function* () {
        const view = yield* sandbox.runtime.start(startInput(sandbox, "thread-a"));
        expect(view.status).toBe("ready");
        const entries = yield* sandbox.fs.readDirectory(sandbox.workspaceRoot);
        expect(entries).toHaveLength(0);
      }),
    ),
  );
});
