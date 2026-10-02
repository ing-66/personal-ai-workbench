import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";

import {
  WorkspacePaths,
  WorkspacePathOutsideRootError,
} from "../../../workspace/WorkspacePaths.ts";
import { OfficeOutputInvalidError, OfficeOverwriteRefusedError } from "./errors.ts";
import { OfficeToolkit } from "./tools.ts";
import { makeOfficeFileAccess, OFFICE_MAX_INSPECT_BYTES } from "./workspace.ts";

/**
 * Workspace-boundary tests for the office toolkit.
 *
 * The boundary belongs to every office tool, so it is exercised directly against
 * a real temp directory (including a real symlink) rather than through one
 * document format. String containment alone cannot catch a link inside the
 * workspace whose target lives outside it, which is what the symlink case
 * asserts.
 */

const isAbsolutePath = (value: string): boolean =>
  value.startsWith("/") ||
  value.startsWith("\\\\") ||
  /^[a-zA-Z]:[\\/]/.test(value) ||
  /^[a-zA-Z]:$/.test(value);

/**
 * Pure path math for the stand-in below. `Path.Path` is a service tag rather than
 * a value, and the guard under test does its own realpath work against the real
 * filesystem, so this only has to answer "is this escape visible as a string".
 */
const normalizeSegments = (segments: ReadonlyArray<string>): string => {
  const parts: string[] = [];
  for (const segment of segments) {
    for (const piece of segment.replaceAll("\\", "/").split("/")) {
      if (piece === "" || piece === ".") continue;
      if (piece === "..") {
        parts.pop();
        continue;
      }
      parts.push(piece);
    }
  }
  return `/${parts.join("/")}`;
};

/**
 * The path service is exercised through its real contract: reject absolute paths
 * and any `..` escape, and hand back a normalized workspace-relative path. What
 * matters here is the guard's own realpath walk, which runs against real temp
 * directories.
 */
const TestWorkspacePaths = Layer.succeed(WorkspacePaths, {
  normalizeWorkspaceRoot: (workspaceRoot: string) => Effect.succeed(workspaceRoot.trim()),
  resolveRelativePathWithinRoot: (input: {
    readonly workspaceRoot: string;
    readonly relativePath: string;
  }) => {
    const { workspaceRoot, relativePath } = input;
    const trimmed = relativePath.trim();
    if (isAbsolutePath(trimmed)) {
      return Effect.fail(new WorkspacePathOutsideRootError({ workspaceRoot, relativePath }));
    }
    return Effect.gen(function* () {
      const absolutePath = normalizeSegments([workspaceRoot, trimmed]);
      const root = normalizeSegments([workspaceRoot]);
      const relativeToRoot =
        absolutePath === root
          ? ""
          : absolutePath.startsWith(`${root}/`)
            ? absolutePath.slice(root.length + 1)
            : `../${absolutePath.replace(/^\//, "")}`;
      if (
        relativeToRoot.length === 0 ||
        relativeToRoot === "." ||
        relativeToRoot === ".." ||
        relativeToRoot.startsWith("../") ||
        isAbsolutePath(relativeToRoot)
      ) {
        return yield* new WorkspacePathOutsideRootError({ workspaceRoot, relativePath });
      }
      return { absolutePath: `${workspaceRoot}/${relativeToRoot}`, relativePath: relativeToRoot };
    });
  },
});

const TestLayer = Layer.mergeAll(TestWorkspacePaths, NodeServices.layer);

it.effect("exposes stable office tool identities with truthful risk annotations", () =>
  Effect.sync(() => {
    const tools = OfficeToolkit.tools as Record<string, Tool.Any>;
    const names = Object.keys(tools).toSorted();
    expect(names).toEqual([
      "office_document_write",
      "office_inspect",
      "office_pdf_create",
      "office_presentation_add_slide",
      "office_presentation_create",
      "office_read_range",
      "office_spreadsheet_write",
    ]);

    const readOnly = (name: string) => Context.get(tools[name]!.annotations, Tool.Readonly);
    const world = (name: string) => Context.get(tools[name]!.annotations, Tool.OpenWorld);

    // Reads are read-only; every writer reports that it writes; nothing on this
    // surface reaches outside the host.
    expect(readOnly("office_inspect")).toBe(true);
    expect(readOnly("office_read_range")).toBe(true);
    expect(readOnly("office_document_write")).toBe(false);
    expect(readOnly("office_spreadsheet_write")).toBe(false);
    expect(readOnly("office_presentation_create")).toBe(false);
    expect(readOnly("office_presentation_add_slide")).toBe(false);
    expect(readOnly("office_pdf_create")).toBe(false);
    for (const name of names) expect(world(name)).toBe(false);
  }),
);

it.effect("rejects absolute paths, traversal and platform-absolute forms", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const access = yield* makeOfficeFileAccess();
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "office-boundary-" });

    const cases = [
      "../outside.xlsx",
      "nested/../../outside.xlsx",
      "nested\\..\\..\\outside.xlsx",
      "/etc/passwd",
      "C:\\Windows\\win.ini",
      "\\\\server\\share\\file.docx",
    ];
    for (const requestedPath of cases) {
      const failure = yield* access
        .readBytes({ workspaceRoot: root, requestedPath })
        .pipe(Effect.flip);
      expect(failure._tag).toBe("OfficeWorkspaceViolationError");
    }
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("reads and writes inside the workspace and reports workspace-relative paths", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const access = yield* makeOfficeFileAccess();
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "office-inside-" });

    const written = yield* access.writeBytes({
      workspaceRoot: root,
      requestedPath: "reports/summary.txt",
      bytes: new Uint8Array([1, 2, 3]),
      overwrite: false,
    });
    // The stored path is normalized and relative, never absolute.
    expect(written.relativePath).toBe("reports/summary.txt");
    expect(written.absolutePath.startsWith(root)).toBe(true);

    const read = yield* access.readBytes({
      workspaceRoot: root,
      requestedPath: "reports/summary.txt",
    });
    expect([...read.bytes]).toEqual([1, 2, 3]);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("refuses to replace an existing file unless overwrite was requested", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const access = yield* makeOfficeFileAccess();
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "office-overwrite-" });

    yield* access.writeBytes({
      workspaceRoot: root,
      requestedPath: "deck.pptx",
      bytes: new Uint8Array([1]),
      overwrite: false,
    });

    const refused = yield* access
      .writeBytes({
        workspaceRoot: root,
        requestedPath: "deck.pptx",
        bytes: new Uint8Array([2]),
        overwrite: false,
      })
      .pipe(Effect.flip);
    expect(refused._tag).toBe("OfficeOverwriteRefusedError");
    expect(refused).toBeInstanceOf(OfficeOverwriteRefusedError);
    // The original bytes are untouched after a refusal.
    const unchanged = yield* fs.readFile(path.join(root, "deck.pptx"));
    expect([...unchanged]).toEqual([1]);

    const replaced = yield* access.writeBytes({
      workspaceRoot: root,
      requestedPath: "deck.pptx",
      bytes: new Uint8Array([2]),
      overwrite: true,
    });
    expect(replaced.relativePath).toBe("deck.pptx");
    const updated = yield* fs.readFile(path.join(root, "deck.pptx"));
    expect([...updated]).toEqual([2]);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("leaves the existing file intact and cleans up when validation fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const access = yield* makeOfficeFileAccess();
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "office-atomic-" });

    yield* access.writeBytes({
      workspaceRoot: root,
      requestedPath: "report.docx",
      bytes: new Uint8Array([9, 9, 9]),
      overwrite: false,
    });

    const failure = yield* access
      .writeBytes({
        workspaceRoot: root,
        requestedPath: "report.docx",
        bytes: new Uint8Array([7]),
        overwrite: true,
        validate: (_bytes, relativePath) =>
          Effect.fail(
            new OfficeOutputInvalidError({
              path: relativePath,
              detail: "simulated validation failure",
            }),
          ),
      })
      .pipe(Effect.flip);
    expect(failure._tag).toBe("OfficeOutputInvalidError");
    expect(failure._tag === "OfficeOutputInvalidError" ? failure.detail : "").toBe(
      "simulated validation failure",
    );

    // The commit point is the rename, so a failed validation cannot have touched
    // the previous file.
    const unchanged = yield* fs.readFile(path.join(root, "report.docx"));
    expect([...unchanged]).toEqual([9, 9, 9]);
    // And the temp directory from the failed attempt is gone.
    const entries = yield* fs.readDirectory(root);
    expect(entries.filter((entry) => entry.startsWith("report.docx."))).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("refuses a symlink inside the workspace that points outside it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const access = yield* makeOfficeFileAccess();
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "office-link-root-" });
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "office-link-outside-" });

    yield* fs.writeFileString(path.join(outside, "secret.xlsx"), "not really a workbook");
    // Only meaningful where the platform permits symlinks (Windows needs
    // developer mode or elevation). When it is unavailable the escape case is
    // skipped rather than asserted falsely.
    const linked = yield* fs.symlink(outside, path.join(root, "linked")).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!linked) return;

    const readFailure = yield* access
      .readBytes({ workspaceRoot: root, requestedPath: "linked/secret.xlsx" })
      .pipe(Effect.flip);
    expect(readFailure._tag).toBe("OfficeWorkspaceViolationError");

    const writeFailure = yield* access
      .writeBytes({
        workspaceRoot: root,
        requestedPath: "linked/planted.xlsx",
        bytes: new Uint8Array([1]),
        overwrite: false,
      })
      .pipe(Effect.flip);
    expect(writeFailure._tag).toBe("OfficeWorkspaceViolationError");
    // Nothing was created through the link.
    const outsideEntries = yield* fs.readDirectory(outside);
    expect(outsideEntries).toEqual(["secret.xlsx"]);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("refuses files above the inspection size limit with an actionable error", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const access = yield* makeOfficeFileAccess();
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "office-large-" });

    yield* fs.writeFile(path.join(root, "big.xlsx"), new Uint8Array(OFFICE_MAX_INSPECT_BYTES + 1));

    const failure = yield* access
      .readBytes({ workspaceRoot: root, requestedPath: "big.xlsx" })
      .pipe(Effect.flip);
    expect(failure._tag).toBe("OfficeFileTooLargeError");
    expect(failure.message).toContain("above the");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("rejects unsupported extensions before any filesystem work", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const access = yield* makeOfficeFileAccess();
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "office-ext-" });

    const failure = yield* access
      .readBytes({
        workspaceRoot: root,
        requestedPath: "notes.txt",
        supportedExtensions: [".docx"],
      })
      .pipe(Effect.flip);
    expect(failure._tag).toBe("OfficeUnsupportedFormatError");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
