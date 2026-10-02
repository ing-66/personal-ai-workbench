import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  browserRootDir,
  threadBrowserDir,
  threadDirectorySegment,
  threadOutputDir,
  threadProfileDir,
  threadRuntimeStatePath,
} from "./BrowserPaths.ts";

const withPath = <A, E>(body: (path: Path.Path) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    return yield* body(yield* Path.Path);
  }).pipe(Effect.provide(NodePath.layer));

describe("thread browser paths", () => {
  it.effect("derives one stable directory per Canonical Thread", () =>
    withPath((path) =>
      Effect.sync(() => {
        const stateDir = path.join("/home/me", "userdata");
        const first = threadBrowserDir(path, stateDir, "thread-a");
        expect(threadBrowserDir(path, stateDir, "thread-a")).toBe(first);
        expect(threadBrowserDir(path, stateDir, "thread-b")).not.toBe(first);
      }),
    ),
  );

  it.effect("keeps every thread's state under the userdata directory", () =>
    withPath((path) =>
      Effect.sync(() => {
        const stateDir = path.join("/home/me", "userdata");
        const expectedRoot = path.join(stateDir, "browser");
        expect(browserRootDir(path, stateDir)).toBe(expectedRoot);
        for (const id of ["a", "b", "c"]) {
          expect(
            threadBrowserDir(path, stateDir, id).startsWith(`${expectedRoot}${path.sep}`),
          ).toBe(true);
          expect(threadProfileDir(path, stateDir, id).startsWith(expectedRoot)).toBe(true);
          expect(threadOutputDir(path, stateDir, id).startsWith(expectedRoot)).toBe(true);
          expect(threadRuntimeStatePath(path, stateDir, id).startsWith(expectedRoot)).toBe(true);
        }
      }),
    ),
  );

  it.effect("segments a safe directory name from any thread id", () =>
    withPath((path) =>
      Effect.sync(() => {
        // A thread id is a free-form non-empty string, so a separator or a
        // Windows-reserved spelling must not become a path separator.
        const hostile = "../../etc/passwd";
        const segment = threadDirectorySegment(hostile);
        expect(segment).not.toContain("/");
        expect(segment).not.toContain("\\");
        expect(segment).not.toContain("..");
        expect(threadProfileDir(path, "/s", hostile)).toBe(
          path.join("/s", "browser", segment, "profile"),
        );

        // Distinct ids stay distinct, including ones that sanitize identically.
        expect(threadDirectorySegment("a/b")).not.toBe(threadDirectorySegment("a_b"));
        expect(threadDirectorySegment("")).toBe(threadDirectorySegment(""));
      }),
    ),
  );
});
