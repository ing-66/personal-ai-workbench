/**
 * Smoke test against the real, pinned official Playwright MCP server.
 *
 * Everything else about the runtime is covered by `BrowserRuntime.test.ts` with a
 * fixture process. This file proves the part a fixture cannot: that the endpoint
 * Workbench hands a provider is a *real* MCP server, that it lists the official
 * `browser_*` tools, and that those tools actually drive a real browser against a
 * deterministic local page.
 *
 * No network and no real account: the page is served from a loopback fixture. If
 * the selected browser channel is not installed, the test asserts the
 * `runtime-missing` diagnostic instead - it never downloads a browser.
 */
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeOs from "node:os";
import { randomUUID } from "node:crypto";

import * as ServerConfig from "../config.ts";
import * as BrowserRuntime from "./BrowserRuntime.ts";
import { threadOutputDir } from "./BrowserPaths.ts";

const FIXTURE_PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Workbench browser fixture</title></head>
  <body>
    <h1>Deterministic fixture</h1>
    <p id="status">idle</p>
    <label for="field">Name</label>
    <input id="field" name="field" type="text" />
    <button id="go" type="button" onclick="document.getElementById('status').textContent = 'clicked:' + document.getElementById('field').value">Go</button>
  </body>
</html>`;

/**
 * A `data:` URL keeps the fixture self-contained: no server to start, no socket
 * for the browser to keep alive, and nothing on the network. `file://` is not an
 * option - upstream blocks it by default, which is the boundary we want to keep.
 */
const FIXTURE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(FIXTURE_PAGE)}`;

/** Request bodies are literal JSON or schema-encoded, never hand-built strings. */
const INITIALIZE_BODY =
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t3-code-smoke","version":"0.0.0"}}}';
const INITIALIZED_BODY = '{"jsonrpc":"2.0","method":"notifications/initialized"}';
const TOOLS_LIST_BODY = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}';

const ToolCallBody = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Literal(1),
  method: Schema.Literal("tools/call"),
  params: Schema.Struct({
    name: Schema.String,
    arguments: Schema.Record(Schema.String, Schema.String),
  }),
});
const encodeToolCallBody = Schema.encodeSync(Schema.fromJsonString(ToolCallBody));

const JsonRpcResponse = Schema.Struct({
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
});
const ToolsResult = Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) });
const ToolCallResult = Schema.Struct({
  content: Schema.optionalKey(
    Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })),
  ),
  isError: Schema.optionalKey(Schema.Boolean),
});
type ToolCallResult = typeof ToolCallResult.Type;

/** Streamable HTTP may answer either as JSON or as a one-event SSE frame. */
const decodeJsonRpc = (text: string) => {
  const candidates = [text, ...text.split("\n").map((line) => line.replace(/^data:\s*/, ""))];
  for (const candidate of candidates) {
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRpcResponse))(
      candidate.trim(),
    );
    if (Option.isSome(decoded)) return decoded.value;
  }
  return undefined;
};

interface McpSession {
  readonly toolNames: Effect.Effect<ReadonlyArray<string>>;
  readonly callTool: (
    name: string,
    args: Record<string, string>,
  ) => Effect.Effect<Option.Option<ToolCallResult>>;
}

/** A deliberately minimal MCP client: enough to prove the endpoint speaks MCP. */
const connectMcp = (endpoint: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    let sessionId: string | undefined;

    const post = (body: string) =>
      Effect.gen(function* () {
        const request = HttpClientRequest.post(endpoint).pipe(
          HttpClientRequest.setHeaders({
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
          }),
          HttpClientRequest.bodyText(body, "application/json"),
        );
        const outcome = yield* client.execute(request).pipe(Effect.timeoutOption("30 seconds"));
        if (outcome._tag === "None") return undefined;
        const header = outcome.value.headers["mcp-session-id"];
        if (sessionId === undefined && typeof header === "string") sessionId = header;
        const text = yield* outcome.value.text;
        return decodeJsonRpc(text)?.result;
      });

    const initialized = yield* post(INITIALIZE_BODY);
    if (sessionId === undefined) return undefined;
    yield* post(INITIALIZED_BODY);
    void initialized;

    const toolNames = post(TOOLS_LIST_BODY).pipe(
      Effect.map((result) =>
        Option.getOrElse(Schema.decodeUnknownOption(ToolsResult)(result), () => ({
          tools: [] as ReadonlyArray<{ name: string }>,
        })).tools.map((tool) => tool.name),
      ),
      Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
    );

    const callTool = (name: string, args: Record<string, string>) =>
      post(
        encodeToolCallBody({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      ).pipe(
        Effect.map((result) => Schema.decodeUnknownOption(ToolCallResult)(result)),
        Effect.orElseSucceed(() => Option.none<ToolCallResult>()),
      );

    return { toolNames, callTool } satisfies McpSession;
  });

const toolText = (result: Option.Option<ToolCallResult>): string =>
  Option.isSome(result)
    ? (result.value.content ?? []).map((part) => part.text ?? "").join("\n")
    : "";

/**
 * Upstream writes an auto-named snapshot into the output directory and returns a
 * link to it rather than inlining the page tree. That directory is the thread's
 * userdata output dir, so the page text is read from there - never from the
 * project workspace.
 */
const readLatestSnapshot = (outputDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = yield* fs
      .readDirectory(outputDir)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
    const pages = names.filter((name) => name.startsWith("page-") && name.endsWith(".yml")).sort();
    const latest = pages.at(-1);
    if (latest === undefined) return "";
    return yield* fs
      .readFileString(path.join(outputDir, latest))
      .pipe(Effect.orElseSucceed(() => ""));
  });

/** Accessible-name refs are the snapshot's own output, so they are read, not guessed. */
const refForLabel = (snapshotText: string, label: string): string | undefined => {
  for (const line of snapshotText.split("\n")) {
    if (!line.includes(`"${label}"`)) continue;
    const match = /\[ref=([^\]]+)\]/.exec(line);
    if (match) return match[1];
  }
  return undefined;
};

describe("official Playwright MCP smoke", () => {
  it.live("drives a real browser against a local fixture and shuts down cleanly", () => {
    const baseDir = `${NodeOs.tmpdir()}/t3-browser-smoke-${randomUUID()}`;
    const workspaceRoot = `${baseDir}/workspace`;
    const environment: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(workspaceRoot, { recursive: true });

      // The real resolver and the real channel probe: no seams, so this covers
      // the packaged dependency path production uses.
      const runtime = yield* BrowserRuntime.makeWith().pipe(
        Effect.provideService(HostProcessEnvironment, environment),
      );
      const input = {
        threadId: ThreadId.make("smoke-thread"),
        profileMode: "persistent" as const,
        channel: "chrome" as const,
        // Headless keeps the smoke run from stealing focus; headed is the product
        // default and its launch contract is asserted by the unit suite.
        headless: true,
        workspaceRoot,
      };

      const view = yield* runtime.start(input);
      if (view.status !== "ready" || view.endpoint === null) {
        // No browser on this machine is a supported outcome: it has to be
        // diagnosed, never downloaded on the sly.
        expect(["runtime-missing", "not-configured"]).toContain(view.diagnostic);
        return;
      }

      const session = yield* connectMcp(view.endpoint);
      expect(session).toBeDefined();
      if (!session) return;

      const tools = yield* session.toolNames;
      // Tool definitions are upstream's, not ours: Workbench never restates them.
      expect(tools).toContain("browser_navigate");
      expect(tools).toContain("browser_snapshot");
      expect(tools).toContain("browser_click");
      expect(tools).toContain("browser_type");
      expect(tools.length).toBeGreaterThan(5);

      const navigated = yield* session.callTool("browser_navigate", { url: FIXTURE_URL });
      expect(toolText(navigated)).not.toContain("### Error");
      yield* session.callTool("browser_snapshot", {});

      const outputDir = threadOutputDir(path, config.stateDir, input.threadId);
      const snapshotText = yield* readLatestSnapshot(outputDir);
      expect(snapshotText).toContain("Deterministic fixture");
      expect(snapshotText).toContain("idle");

      const fieldRef = refForLabel(snapshotText, "Name");
      const buttonRef = refForLabel(snapshotText, "Go");
      expect(fieldRef).toBeDefined();
      expect(buttonRef).toBeDefined();
      if (!fieldRef || !buttonRef) return;

      // `target` is a locator, not a description: upstream resolves it against the
      // page and errors when it matches nothing, so both it and the snapshot
      // `ref` have to be supplied.
      const typed = yield* session.callTool("browser_type", {
        target: "#field",
        ref: fieldRef,
        text: "workbench",
      });
      expect(Option.isSome(typed) && typed.value.isError === true).toBe(false);
      const clicked = yield* session.callTool("browser_click", { target: "#go", ref: buttonRef });
      expect(Option.isSome(clicked) && clicked.value.isError === true).toBe(false);

      yield* session.callTool("browser_snapshot", {});
      const afterClick = yield* readLatestSnapshot(outputDir);
      // The real browser really reacted to the real click.
      expect(afterClick).toContain("clicked:workbench");

      // The stored profile lives under userdata for this thread, never in the
      // workspace the agent was pointed at.
      expect(
        yield* fs
          .exists(path.join(config.stateDir, "browser"))
          .pipe(Effect.orElseSucceed(() => false)),
      ).toBe(true);
      const workspaceEntries = yield* fs
        .readDirectory(workspaceRoot)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      expect(workspaceEntries).toHaveLength(0);

      const stopped = yield* runtime.stop(input.threadId);
      expect(stopped.status).toBe("stopped");
      // Stopping the process must not touch the stored profile.
      expect(stopped.persistentProfile).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          FetchHttpClient.layer,
          NetService.layer,
          ServerConfig.layerTest(baseDir, baseDir).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
      Effect.scoped,
    );
  });
});
