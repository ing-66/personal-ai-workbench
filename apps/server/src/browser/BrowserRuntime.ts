/**
 * The Workbench-owned Playwright MCP runtime for a Canonical Thread.
 *
 * This is the only place in the product that starts a browser-side process. It
 * does not implement browsing: it starts Microsoft's official Playwright MCP
 * server, waits for its MCP endpoint to answer, hands that endpoint to whichever
 * provider session currently holds the baton, and stops what it started. Every
 * `browser_*` tool belongs to upstream and is never restated here.
 *
 * Two invariants carry the whole design:
 *
 * - **One runtime per thread.** State is keyed by Canonical Thread id and every
 *   transition runs under one semaphore, so a handoff - which replaces the native
 *   session and not the thread - reuses the existing process instead of starting a
 *   second one. Two processes on one persistent profile is exactly the conflict
 *   upstream warns about, so it must be impossible by construction.
 * - **Process lifetime is not profile lifetime.** Stopping closes the process
 *   scope and leaves `<userdata>/browser/<thread>/profile` alone; the same thread
 *   always resolves to the same directory, so login state outlives crashes,
 *   restarts and handoffs.
 *
 * Diagnostics are state, not exceptions: `start` records why it failed on the
 * returned view instead of failing the caller, so a Settings panel and a handoff
 * briefing can both read one closed vocabulary.
 *
 * @module BrowserRuntime
 */
import {
  BROWSER_DIAGNOSTIC_MESSAGES,
  type BrowserChannel,
  type BrowserDiagnostic,
  type BrowserProfileMode,
  type BrowserSessionStatus,
  type BrowserSessionView,
  type ThreadId,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { createRequire } from "node:module";

import * as ServerConfig from "../config.ts";
import { threadOutputDir, threadProfileDir, threadRuntimeStatePath } from "./BrowserPaths.ts";

/** The pinned official server. Runtime resolution never consults `latest`. */
export const PLAYWRIGHT_MCP_PACKAGE = "@playwright/mcp";

/**
 * The name the thread browser is offered to a provider under. One spelling, used
 * by every adapter, so a provider config never drifts between harnesses.
 */
export const BROWSER_MCP_SERVER_NAME = "playwright";

/** How long the MCP endpoint gets to answer `initialize` after the spawn. */
const HANDSHAKE_TIMEOUT_MS = 20_000;
const HANDSHAKE_PROBE_TIMEOUT_MS = 2_000;
const HANDSHAKE_INTERVAL_MS = 200;

/** The MCP protocol revision this build announces. */
const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface BrowserStartInput {
  readonly threadId: ThreadId;
  readonly profileMode: BrowserProfileMode;
  readonly channel: BrowserChannel;
  readonly headless: boolean;
  /**
   * The thread's workspace (`thread.worktreePath ?? project.workspaceRoot`).
   * Passed as the child's cwd, which is what makes upstream's own file-access
   * boundary - "restricted to workspace root directories, or cwd if no roots are
   * configured" - land exactly on the thread workspace.
   */
  readonly workspaceRoot: string;
}

/** What a handoff briefing is allowed to know: two facts and a mode. */
export interface BrowserHandoffFacts {
  readonly available: boolean;
  /** `unknown` when this thread has no browser runtime, so nothing is invented. */
  readonly profileMode: BrowserProfileMode | "unknown";
  readonly persistentSessionExists: boolean;
}

interface RuntimeEntry {
  readonly input: BrowserStartInput;
  readonly status: BrowserSessionStatus;
  readonly diagnostic: BrowserDiagnostic;
  readonly endpoint: string | null;
  readonly pid: number | null;
  readonly scope: Scope.Closeable | null;
  readonly child: ChildProcessSpawner.ChildProcessHandle | null;
}

export interface BrowserRuntimeShape {
  /**
   * Ensure this thread has a browser runtime and return its view. Idempotent:
   * a ready runtime is returned as-is, and concurrent calls cannot produce two
   * processes. Never fails for an operational reason - the failure is recorded as
   * the view's status and diagnostic.
   */
  readonly start: (input: BrowserStartInput) => Effect.Effect<BrowserSessionView>;
  /** Stop this thread's runtime. The profile is kept. */
  readonly stop: (threadId: ThreadId) => Effect.Effect<BrowserSessionView>;
  /** The thread's current view, without starting anything. */
  readonly view: (input: BrowserStartInput) => Effect.Effect<BrowserSessionView>;
  /**
   * Delete this thread's stored profile and leave a clean stopped session.
   * Destructive by design and only reachable from an explicit user action.
   */
  readonly resetProfile: (input: BrowserStartInput) => Effect.Effect<BrowserSessionView>;
  /** Read-only facts for a handoff briefing. */
  readonly describeForHandoff: (threadId: ThreadId) => Effect.Effect<BrowserHandoffFacts>;
  /** Stop every runtime this server started. Used on shutdown. */
  readonly stopAll: Effect.Effect<void>;
}

export class BrowserRuntime extends Context.Service<BrowserRuntime, BrowserRuntimeShape>()(
  "t3/browser/BrowserRuntime",
) {}

const RuntimeStateFile = Schema.Struct({
  pid: Schema.Int,
  endpoint: Schema.String,
});
const decodeRuntimeStateFile = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeStateFile));
const encodeRuntimeStateFile = Schema.encodeUnknownEffect(Schema.fromJsonString(RuntimeStateFile));

/** The MCP `initialize` request, encoded through a schema rather than hand-built JSON. */
const McpInitializeRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Literal(1),
  method: Schema.Literal("initialize"),
  params: Schema.Struct({
    protocolVersion: Schema.String,
    capabilities: Schema.Struct({}),
    clientInfo: Schema.Struct({ name: Schema.String, version: Schema.String }),
  }),
});
const encodeMcpInitializeRequest = Schema.encodeSync(Schema.fromJsonString(McpInitializeRequest));

/**
 * Test seams, in the style of `ProviderServiceLiveOptions` and
 * `ClaudeAdapterLiveOptions`. Production never sets either: the CLI comes from
 * this build's packaged dependency and the channel probe is the real one.
 */
export interface BrowserRuntimeLiveOptions {
  /** How the pinned Playwright MCP CLI is located. */
  readonly resolveCli?: (path: Path.Path) => string | null;
  /** Whether the selected browser channel is installed on this machine. */
  readonly channelInstalled?: (channel: BrowserChannel) => boolean;
  /** How long the MCP handshake may take. Lowered by tests that expect a timeout. */
  readonly handshakeTimeoutMs?: number;
}

/**
 * Resolve the pinned Playwright MCP CLI from this build's own dependency tree.
 *
 * `@playwright/mcp`'s `exports` map exposes only `.` and `./package.json`, so the
 * CLI is found by resolving the package manifest and taking the sibling `cli.js`
 * its `bin` entry names. Never `npx`: an ephemeral cache would make the first
 * browser call after a cold start depend on the registry, and would resolve
 * `latest` rather than the version this build was audited against.
 */
export function resolvePlaywrightMcpCli(path: Path.Path): string | null {
  try {
    const resolve = createRequire(import.meta.url);
    const manifest = resolve.resolve(`${PLAYWRIGHT_MCP_PACKAGE}/package.json`);
    return path.join(path.dirname(manifest), "cli.js");
  } catch {
    return null;
  }
}

/**
 * Conventional install locations for a system browser channel.
 *
 * Windows-first by design: the product targets Windows, and a wrong "missing"
 * answer would be worse than no answer on platforms whose layout this does not
 * model. An empty list means "cannot be checked here", which is reported as
 * available and left to the launch to fail honestly. Nothing is ever downloaded
 * to satisfy this probe.
 */
export function browserChannelExecutablePaths(
  channel: BrowserChannel,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ReadonlyArray<string> {
  // `chromium` is Playwright-managed; only Playwright can say whether it exists.
  if (channel === "chromium" || platform !== "win32") return [];
  if (channel === "chrome") {
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];
    if (environment.LOCALAPPDATA) {
      candidates.push(`${environment.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`);
    }
    return candidates;
  }
  return [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
}

/** A pid that is alive is not proof it is ours, so it is only ever a refusal. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const makeWith = (options?: BrowserRuntimeLiveOptions) =>
  Effect.gen(function* BrowserRuntimeMake() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const net = yield* NetService.NetService;
    const environment = yield* HostProcessEnvironment;
    const httpClient = yield* HttpClient.HttpClient;
    const platform = process.platform;

    const startLock = yield* Semaphore.make(1);
    const runtimes = yield* Ref.make(new Map<string, RuntimeEntry>());

    const resolveCli = () => (options?.resolveCli ?? resolvePlaywrightMcpCli)(path);

    const channelInstalled = (channel: BrowserChannel): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        if (options?.channelInstalled) return options.channelInstalled(channel);
        const candidates = browserChannelExecutablePaths(channel, environment, platform);
        for (const candidate of candidates) {
          if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return true;
        }
        return candidates.length === 0;
      });

    const childEnvironment = (): NodeJS.ProcessEnv => ({
      ...environment,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    });

    const readEntry = (threadId: ThreadId) =>
      Ref.get(runtimes).pipe(Effect.map((map) => map.get(threadId)));

    const writeEntry = (entry: RuntimeEntry) =>
      Ref.update(runtimes, (map) => new Map(map).set(entry.input.threadId, entry));

    const profileExists = (threadId: ThreadId) =>
      fs
        .exists(threadProfileDir(path, config.stateDir, threadId))
        .pipe(Effect.orElseSucceed(() => false));

    /**
     * A Chromium user-data-dir holds a lock entry while a browser owns it, so its
     * presence is the signal that this thread's profile is already taken. Reading
     * the directory (rather than opening or linking the lock) works for the
     * Windows `lockfile` and for the Unix `SingletonLock` symlink alike, and
     * Workbench never deletes either one.
     */
    const profileLockHeld = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const lockName = platform === "win32" ? "lockfile" : "SingletonLock";
        const entries = yield* fs
          .readDirectory(threadProfileDir(path, config.stateDir, threadId))
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
        return entries.includes(lockName);
      });

    const toView = (
      entry: RuntimeEntry | undefined,
      fallback: BrowserStartInput,
      persistentProfile: boolean,
    ): BrowserSessionView => {
      const input = entry?.input ?? fallback;
      return {
        threadId: input.threadId,
        status: entry?.status ?? "stopped",
        diagnostic: entry?.diagnostic ?? "stopped",
        profileMode: input.profileMode,
        channel: input.channel,
        endpoint: entry?.endpoint ?? null,
        // A stored profile only means something in persistent mode: isolated mode
        // writes nothing, so a leftover directory must not read as live state.
        persistentProfile: input.profileMode === "persistent" && persistentProfile,
      };
    };

    const view = (input: BrowserStartInput) =>
      Effect.gen(function* () {
        const [entry, persistentProfile] = yield* Effect.all([
          readEntry(input.threadId),
          profileExists(input.threadId),
        ]);
        return toView(entry, input, persistentProfile);
      });

    const record = (
      input: BrowserStartInput,
      status: BrowserSessionStatus,
      diagnostic: BrowserDiagnostic,
      endpoint: string | null = null,
      pid: number | null = null,
      scope: Scope.Closeable | null = null,
      child: ChildProcessSpawner.ChildProcessHandle | null = null,
    ) =>
      Effect.gen(function* () {
        const entry: RuntimeEntry = { input, status, diagnostic, endpoint, pid, scope, child };
        yield* writeEntry(entry);
        return toView(entry, input, yield* profileExists(input.threadId));
      });

    const recordFailure = (input: BrowserStartInput, diagnostic: BrowserDiagnostic) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("Browser session unavailable", {
          threadId: input.threadId,
          diagnostic,
          detail: BROWSER_DIAGNOSTIC_MESSAGES[diagnostic],
        });
        return yield* record(input, "error", diagnostic);
      });

    /**
     * Closing the scope interrupts the forked output-drain fiber and terminates
     * the spawned child. `Exit.void` matters: `Scope.close` takes an `Exit`, and
     * passing anything else leaves the scope unclosed and hangs the caller.
     */
    const closeScope = (scope: Scope.Closeable | null) =>
      scope ? Scope.close(scope, Exit.void).pipe(Effect.ignore) : Effect.void;

    /**
     * Stop a runtime's process, then release its scope.
     *
     * The order matters and is the point of this helper: closing the scope also has
     * to interrupt the fiber draining the process's stdout, and a browser that
     * never closes its streams leaves that interruption pending - which would hang
     * every stop, handoff and shutdown. Killing first makes the streams end, so the
     * scope has nothing left to wait for.
     */
    const terminate = (entry: RuntimeEntry | undefined) =>
      Effect.gen(function* () {
        if (entry?.child) yield* entry.child.kill().pipe(Effect.ignore);
        yield* closeScope(entry?.scope ?? null);
      });

    const clearRuntimeState = (threadId: ThreadId) =>
      fs
        .remove(threadRuntimeStatePath(path, config.stateDir, threadId), { force: true })
        .pipe(Effect.ignore);

    const stopEntry = (input: BrowserStartInput, entry: RuntimeEntry | undefined) =>
      Effect.gen(function* () {
        yield* terminate(entry);
        yield* clearRuntimeState(input.threadId);
        return yield* record(input, "stopped", "stopped");
      });

    /** A leftover record from a previous server: a refusal signal, never a kill list. */
    const staleRuntimeHoldsProfile = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const statePath = threadRuntimeStatePath(path, config.stateDir, threadId);
        const previous = yield* fs
          .readFileString(statePath)
          .pipe(Effect.flatMap(decodeRuntimeStateFile), Effect.option);
        if (previous._tag === "None") return false;
        if (!isProcessAlive(previous.value.pid)) {
          yield* fs.remove(statePath, { force: true }).pipe(Effect.ignore);
          return false;
        }
        // Deliberately not adopted: Workbench drives processes it started in this
        // run, and a recycled pid must never be promoted to "ours". The profile is
        // in use either way, so refusing is the honest answer.
        yield* Effect.logWarning("A previous browser runtime still holds this thread's profile", {
          threadId,
          pid: previous.value.pid,
        });
        return true;
      });

    /**
     * One real MCP `initialize` against the loopback endpoint. A TCP connect would
     * not prove the port speaks MCP, and `mcp-handshake-failed` is a diagnosis the
     * user is owed rather than an internal detail.
     *
     * Upstream serves the streamable-HTTP transport on every path except `/sse`,
     * so `/mcp` is the endpoint handed to providers.
     */
    const probeOnce = (endpoint: string) =>
      Effect.gen(function* () {
        const request = HttpClientRequest.post(endpoint).pipe(
          HttpClientRequest.setHeaders({
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          }),
          HttpClientRequest.bodyText(
            encodeMcpInitializeRequest({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: "t3-code", version: "0.0.0" },
              },
            }),
            "application/json",
          ),
        );
        const outcome = yield* httpClient
          .execute(request)
          .pipe(Effect.timeoutOption(Duration.millis(HANDSHAKE_PROBE_TIMEOUT_MS)));
        return outcome._tag === "Some" && outcome.value.status < 400;
      }).pipe(Effect.orElseSucceed(() => false));

    /** Bounded by an explicit deadline, so it always returns. */
    const awaitHandshake = (endpoint: string) =>
      Effect.gen(function* () {
        const timeoutMs = options?.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
        const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
        while ((yield* Clock.currentTimeMillis) < deadline) {
          if (yield* probeOnce(endpoint)) return true;
          yield* Effect.sleep(Duration.millis(HANDSHAKE_INTERVAL_MS));
        }
        return false;
      });

    const spawn = (input: BrowserStartInput, profileDir: string, outputDir: string, cli: string) =>
      Effect.gen(function* () {
        const port = yield* net.reserveLoopbackPort("127.0.0.1");
        const endpoint = `http://127.0.0.1:${port}/mcp`;
        const scope = yield* Scope.make("sequential");
        const args = [
          cli,
          "--port",
          String(port),
          "--host",
          "127.0.0.1",
          // Upstream advertises `localhost:<port>` and its DNS-rebinding guard
          // allows only that host, so a `127.0.0.1` client is refused with 403
          // unless the loopback spelling we actually hand providers is allowed
          // too. One comma-separated argument: the option is a list parser, and
          // the bare space-separated form leaves the list empty.
          `--allowed-hosts=127.0.0.1:${port},localhost:${port}`,
          "--browser",
          input.channel,
          // One thread, one browser, one context. Without this a reconnecting
          // harness would get a fresh context and lose the tabs a handoff is meant
          // to preserve.
          "--shared-browser-context",
          "--output-dir",
          outputDir,
          ...(input.headless ? ["--headless"] : []),
          ...(input.profileMode === "persistent"
            ? ["--user-data-dir", profileDir]
            : ["--isolated"]),
        ];
        const child = yield* spawner
          .spawn(
            ChildProcess.make(process.execPath, args, {
              // cwd is the thread workspace: it is what upstream's file-access
              // boundary defaults to, so upload/download stay inside the workspace
              // without Workbench adding a path policy of its own.
              cwd: input.workspaceRoot,
              detached: false,
              shell: false,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              env: childEnvironment(),
            }),
          )
          .pipe(Effect.provideService(Scope.Scope, scope));

        // Upstream output is process diagnostics, never chat. It is logged at
        // debug level and never forwarded to a client, an activity, or a briefing.
        yield* Effect.forkIn(
          child.all.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.filter((line) => line.trim().length > 0),
            Stream.runForEach((line) =>
              Effect.logDebug("Playwright MCP output", { threadId: input.threadId, output: line }),
            ),
            Effect.catchCause(() => Effect.void),
          ),
          scope,
        );

        return { scope, child, endpoint, pid: Number(child.pid) };
      });

    const start: BrowserRuntimeShape["start"] = (input) =>
      startLock
        .withPermits(1)(
          Effect.gen(function* () {
            const existing = yield* readEntry(input.threadId);
            if (existing?.status === "ready" && existing.endpoint !== null) {
              // Reuse is the handoff path: same thread, same process, same profile.
              yield* Effect.logDebug("Reusing the thread browser session", {
                threadId: input.threadId,
              });
              return toView(existing, input, yield* profileExists(input.threadId));
            }

            const cli = resolveCli();
            if (!cli) return yield* recordFailure(input, "not-configured");
            if (!(yield* channelInstalled(input.channel))) {
              return yield* recordFailure(input, "runtime-missing");
            }

            const profileDir = threadProfileDir(path, config.stateDir, input.threadId);
            const outputDir = threadOutputDir(path, config.stateDir, input.threadId);

            if (input.profileMode === "persistent") {
              if (yield* staleRuntimeHoldsProfile(input.threadId)) {
                return yield* recordFailure(input, "profile-locked");
              }
              if (yield* profileLockHeld(input.threadId)) {
                return yield* recordFailure(input, "profile-locked");
              }
            }

            yield* record(input, "starting", "starting");

            yield* Effect.all(
              [
                fs.makeDirectory(outputDir, { recursive: true }),
                ...(input.profileMode === "persistent"
                  ? [fs.makeDirectory(profileDir, { recursive: true })]
                  : []),
              ],
              { concurrency: "unbounded" },
            ).pipe(Effect.orElseSucceed(() => undefined));

            const spawned = yield* spawn(input, profileDir, outputDir, cli).pipe(Effect.option);
            if (spawned._tag === "None") {
              return yield* recordFailure(input, "browser-launch-failed");
            }

            const ready = yield* awaitHandshake(spawned.value.endpoint);
            if (!ready) {
              // A server that never answered still owns a process and a port.
              yield* spawned.value.child.kill().pipe(Effect.ignore);
              yield* closeScope(spawned.value.scope);
              yield* clearRuntimeState(input.threadId);
              return yield* recordFailure(input, "mcp-handshake-failed");
            }

            const view = yield* record(
              input,
              "ready",
              "ready",
              spawned.value.endpoint,
              spawned.value.pid,
              spawned.value.scope,
              spawned.value.child,
            );
            yield* encodeRuntimeStateFile({
              pid: spawned.value.pid ?? 0,
              endpoint: spawned.value.endpoint,
            }).pipe(
              Effect.flatMap((json) =>
                fs.writeFileString(
                  threadRuntimeStatePath(path, config.stateDir, input.threadId),
                  json,
                ),
              ),
              Effect.ignore,
            );
            yield* Effect.logInfo("Browser session started", {
              threadId: input.threadId,
              pid: spawned.value.pid,
              profileMode: input.profileMode,
              channel: input.channel,
            });
            return view;
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Browser start failed unexpectedly", {
              threadId: input.threadId,
              cause,
            }).pipe(Effect.andThen(recordFailure(input, "error"))),
          ),
        );

    const stop: BrowserRuntimeShape["stop"] = (threadId) =>
      startLock
        .withPermits(1)(
          Effect.gen(function* () {
            const entry = yield* readEntry(threadId);
            const input: BrowserStartInput = entry?.input ?? {
              threadId,
              profileMode: "persistent",
              channel: "chrome",
              headless: false,
              workspaceRoot: config.baseDir,
            };
            const stopped = yield* stopEntry(input, entry);
            yield* Effect.logInfo("Browser session stopped", { threadId });
            return stopped;
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Browser stop failed unexpectedly", { threadId, cause }).pipe(
              Effect.as({
                threadId,
                status: "error",
                diagnostic: "error",
                profileMode: "persistent",
                channel: "chrome",
                endpoint: null,
                persistentProfile: false,
              } satisfies BrowserSessionView),
            ),
          ),
        );

    const resetProfile: BrowserRuntimeShape["resetProfile"] = (input) =>
      startLock.withPermits(1)(
        Effect.gen(function* () {
          yield* stopEntry(input, yield* readEntry(input.threadId));
          yield* fs
            .remove(threadProfileDir(path, config.stateDir, input.threadId), {
              recursive: true,
              force: true,
            })
            .pipe(Effect.ignore);
          yield* Effect.logInfo("Browser profile reset", { threadId: input.threadId });
          return yield* record(input, "stopped", "stopped");
        }),
      );

    const describeForHandoff: BrowserRuntimeShape["describeForHandoff"] = (threadId) =>
      Effect.gen(function* () {
        const [entry, persistentProfile] = yield* Effect.all([
          readEntry(threadId),
          profileExists(threadId),
        ]);
        const profileMode = entry?.input.profileMode ?? "unknown";
        // Availability is derived, never persisted: the runtime must be ready and
        // its endpoint known for the target harness to reach it at all.
        return {
          available: entry?.status === "ready" && entry.endpoint !== null,
          profileMode,
          persistentSessionExists: profileMode === "persistent" && persistentProfile,
        } satisfies BrowserHandoffFacts;
      });

    const stopAll = Effect.gen(function* () {
      const entries = yield* Ref.get(runtimes);
      yield* Effect.all(
        Array.from(entries.values()).map((entry) => terminate(entry)),
        { concurrency: "unbounded" },
      );
      yield* Ref.set(runtimes, new Map());
    });

    return {
      start,
      stop,
      view,
      resetProfile,
      describeForHandoff,
      stopAll,
    } satisfies BrowserRuntimeShape;
  });

/**
 * Scoped through `Effect.acquireRelease` (the pattern `OpenCodeServerOwner`
 * uses), so an orderly layer teardown stops every process this server started.
 * An abnormal exit leaves the processes behind, and the next start refuses the
 * profile rather than deleting lock files or killing a pid it cannot prove is
 * its own.
 */
export const layerWith = (options?: BrowserRuntimeLiveOptions) =>
  Layer.effect(
    BrowserRuntime,
    Effect.acquireRelease(makeWith(options), (runtime) =>
      runtime.stopAll.pipe(
        Effect.timeoutOption(Duration.seconds(5)),
        Effect.orElseSucceed(() => undefined),
      ),
    ),
  );

export const layer = layerWith();
