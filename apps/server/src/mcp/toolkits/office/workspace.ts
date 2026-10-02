import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { WorkspacePaths } from "../../../workspace/WorkspacePaths.ts";
import {
  OfficeFileTooLargeError,
  OfficeOutputInvalidError,
  OfficeOverwriteRefusedError,
  OfficeSaveFailedError,
  OfficeToolTargetNotFoundError,
  OfficeUnsupportedFormatError,
  OfficeWorkspaceViolationError,
} from "./errors.ts";

/** Read cap. Matches `PROJECT_READ_FILE_MAX_BYTES` (workspace read precedent). */
export const OFFICE_MAX_INSPECT_BYTES = 1024 * 1024;

/**
 * Workspace-bound file access for office tools.
 *
 * Containment has two layers on purpose:
 *
 * 1. `WorkspacePaths.resolveRelativePathWithinRoot` does the string-level check:
 *    absolute paths and every `..` escape are rejected, and the stored path is a
 *    normalized workspace-relative posix path.
 * 2. The realpath check below does the filesystem-level check: a symlink or
 *    Windows junction *inside* the workspace can point outside it, which no string
 *    comparison can detect. For reads we resolve the target's real path; for
 *    writes we resolve the nearest existing ancestor (the file may not exist yet)
 *    and verify each existing component from the workspace root down to it.
 *
 * A write is atomic: bytes land in a temporary file in the destination directory,
 * the temporary file is validated, and only then is it renamed onto the final
 * path. A crash or validation failure therefore leaves the previous file intact.
 */
export const makeOfficeFileAccess = Effect.fn("OfficeToolkit.makeFileAccess")(function* () {
  const workspacePaths = yield* WorkspacePaths;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  /**
   * Platform faults (permissions, a vanished directory, a transient handle error)
   * are infrastructure defects, not document outcomes. Collapsing them here keeps
   * every failure this module can return a modelled, readable tool error.
   */
  const fs = {
    stat: (target: string) => fileSystem.stat(target).pipe(Effect.orDie),
    realPath: (target: string) => fileSystem.realPath(target).pipe(Effect.orDie),
    readFile: (target: string) => fileSystem.readFile(target).pipe(Effect.orDie),
    writeFile: (target: string, bytes: Uint8Array) =>
      fileSystem.writeFile(target, bytes).pipe(Effect.orDie),
    makeDirectory: (target: string, options: { readonly recursive: boolean }) =>
      fileSystem.makeDirectory(target, options).pipe(Effect.orDie),
    makeTempDirectoryScoped: (options: { readonly directory: string; readonly prefix: string }) =>
      fileSystem.makeTempDirectoryScoped(options).pipe(Effect.orDie),
    rename: (from: string, to: string) => fileSystem.rename(from, to).pipe(Effect.orDie),
  };

  const resolvedRelative = (workspaceRoot: string, requestedPath: string, toolLabel: string) =>
    workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot, relativePath: requestedPath })
      .pipe(
        Effect.mapError(
          () =>
            new OfficeWorkspaceViolationError({
              path: requestedPath,
              reason: "the path is absolute or escapes the workspace root.",
            }),
        ),
        Effect.tap(() => Effect.annotateCurrentSpan({ "office.tool": toolLabel })),
      );

  /** Real path of the workspace root, so a symlinked root still compares equal. */
  const canonicalRoot = (workspaceRoot: string) =>
    fs.realPath(workspaceRoot).pipe(Effect.orElseSucceed(() => workspaceRoot));

  /**
   * Verifies that every existing path component from `root` down to `target`
   * resolves inside `root`, and returns the target's real path when it exists.
   */
  const verifyCanonicalContainment = (input: {
    readonly root: string;
    readonly target: string;
    readonly requestedPath: string;
  }) =>
    Effect.gen(function* () {
      const realRoot = yield* canonicalRoot(input.root);
      const relativeToRoot = path.relative(realRoot, input.target);
      if (
        relativeToRoot.length === 0 ||
        relativeToRoot === ".." ||
        relativeToRoot.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeToRoot)
      ) {
        return yield* new OfficeWorkspaceViolationError({
          path: input.requestedPath,
          reason: "the resolved location is outside the workspace root.",
        });
      }

      const segments = relativeToRoot.split(path.sep).filter((segment) => segment.length > 0);
      const lastIndex = segments.length - 1;
      let current = realRoot;
      for (let index = 0; index < segments.length; index += 1) {
        current = path.join(current, segments[index]!);
        const info = yield* fileSystem.stat(current).pipe(
          Effect.map((value) => ({ exists: true, type: value.type })),
          Effect.orElseSucceed(() => ({ exists: false, type: "File" as const })),
        );
        if (!info.exists) {
          // Nothing below a missing component can exist, so containment is
          // settled: the write will create the directory inside the root.
          if (index === lastIndex) return null;
          continue;
        }
        const realComponent = yield* fileSystem
          .realPath(current)
          .pipe(Effect.orElseSucceed(() => current));
        const componentRelative = path.relative(realRoot, realComponent);
        if (
          componentRelative === ".." ||
          componentRelative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(componentRelative)
        ) {
          return yield* new OfficeWorkspaceViolationError({
            path: input.requestedPath,
            reason: `the existing path component ${segments[index]!} is a link that points outside the workspace root.`,
            cause: `${current} resolves to ${realComponent}`,
          });
        }
      }
      return current;
    });

  const requireRelativeInput = (requestedPath: string) =>
    path.isAbsolute(requestedPath) || /^[a-zA-Z]:/.test(requestedPath)
      ? Effect.fail(
          new OfficeWorkspaceViolationError({
            path: requestedPath,
            reason: "absolute paths are not accepted; pass a path relative to the workspace root.",
          }),
        )
      : Effect.void;

  const requireExtension = (requestedPath: string, supported: ReadonlyArray<string>) => {
    const extension = path.extname(requestedPath).toLowerCase();
    return supported.includes(extension)
      ? Effect.succeed(extension)
      : Effect.fail(
          new OfficeUnsupportedFormatError({
            path: requestedPath,
            supportedExtensions: [...supported],
          }),
        );
  };

  const readBytes = (input: {
    readonly workspaceRoot: string;
    readonly requestedPath: string;
    readonly supportedExtensions?: ReadonlyArray<string>;
    readonly maxBytes?: number;
  }) =>
    Effect.gen(function* () {
      yield* requireRelativeInput(input.requestedPath);
      if (input.supportedExtensions !== undefined) {
        yield* requireExtension(input.requestedPath, input.supportedExtensions);
      }
      const resolved = yield* resolvedRelative(input.workspaceRoot, input.requestedPath, "read");
      const exists = yield* fileSystem.stat(resolved.absolutePath).pipe(
        Effect.map((value) => value.type === "File"),
        Effect.orElseSucceed(() => false),
      );
      if (!exists) {
        return yield* new OfficeToolTargetNotFoundError({ path: resolved.relativePath });
      }
      const realTarget = yield* fileSystem
        .realPath(resolved.absolutePath)
        .pipe(Effect.orElseSucceed(() => resolved.absolutePath));
      yield* verifyCanonicalContainment({
        root: input.workspaceRoot,
        target: resolved.absolutePath,
        requestedPath: resolved.relativePath,
      });
      const size = yield* fs.stat(realTarget).pipe(
        Effect.map((value) => Number(value.size)),
        Effect.orElseSucceed(() => 0),
      );
      const maxBytes = input.maxBytes ?? OFFICE_MAX_INSPECT_BYTES;
      if (size > maxBytes) {
        return yield* new OfficeFileTooLargeError({
          path: resolved.relativePath,
          sizeBytes: size,
          maxBytes,
        });
      }
      const bytes = yield* fs.readFile(realTarget);
      return { bytes, relativePath: resolved.relativePath, absolutePath: realTarget };
    });

  /**
   * Writes bytes atomically, refusing to replace an existing file unless the
   * caller explicitly asked for it. `validate` runs against the written temp file
   * before the rename, so a bad document never reaches the destination path.
   */
  const writeBytes = (input: {
    readonly workspaceRoot: string;
    readonly requestedPath: string;
    readonly bytes: Uint8Array;
    readonly overwrite: boolean;
    readonly validate?: (
      bytes: Uint8Array,
      relativePath: string,
    ) => Effect.Effect<void, OfficeOutputInvalidError>;
    readonly supportedExtensions?: ReadonlyArray<string>;
  }) =>
    Effect.gen(function* () {
      yield* requireRelativeInput(input.requestedPath);
      if (input.supportedExtensions !== undefined) {
        yield* requireExtension(input.requestedPath, input.supportedExtensions);
      }
      const resolved = yield* resolvedRelative(input.workspaceRoot, input.requestedPath, "write");
      const targetExists = yield* fileSystem.stat(resolved.absolutePath).pipe(
        Effect.map(() => true),
        Effect.orElseSucceed(() => false),
      );
      if (targetExists && !input.overwrite) {
        return yield* new OfficeOverwriteRefusedError({ path: resolved.relativePath });
      }

      yield* verifyCanonicalContainment({
        root: input.workspaceRoot,
        target: resolved.absolutePath,
        requestedPath: resolved.relativePath,
      });

      const directory = path.dirname(resolved.absolutePath);
      yield* fs.makeDirectory(directory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory,
        prefix: `${path.basename(resolved.absolutePath)}.`,
      });
      const tempPath = path.join(tempDirectory, "contents.tmp");
      yield* fs.writeFile(tempPath, input.bytes);
      if (input.validate !== undefined) {
        yield* input.validate(input.bytes, resolved.relativePath);
      }
      // Rename is the commit point: the previous file is either fully intact or
      // fully replaced, never truncated.
      yield* fileSystem
        .rename(tempPath, resolved.absolutePath)
        .pipe(
          Effect.mapError(
            (cause) => new OfficeSaveFailedError({ path: resolved.relativePath, cause }),
          ),
        );
      return { relativePath: resolved.relativePath, absolutePath: resolved.absolutePath };
    }).pipe(Effect.scoped);

  return { readBytes, writeBytes, requireExtension, verifyCanonicalContainment };
});

export type OfficeFileAccess = Effect.Success<ReturnType<typeof makeOfficeFileAccess>>;
