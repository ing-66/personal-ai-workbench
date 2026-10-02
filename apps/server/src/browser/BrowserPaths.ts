/**
 * Where a Canonical Thread's browser lives on disk.
 *
 * Everything here is a pure function of the thread id and the server's userdata
 * directory, which is what makes the profile stable: the same thread resolves to
 * the same directory across process restarts, harness handoffs, Workbench
 * restarts and crash recovery, and two different threads can never collide.
 *
 * The directory is deliberately *not* derived from the project workspace: a
 * project owns a workspace, never a browser identity, and a browser profile must
 * never turn up in `git status`.
 *
 * @module BrowserPaths
 */
import * as Path from "effect/Path";

/** Directory name under the userdata state dir that holds every thread browser. */
const BROWSER_DIR_NAME = "browser";

/**
 * Thread ids are free-form non-empty strings, so the on-disk segment cannot be
 * the raw id (it could carry a separator or a Windows-reserved name). A readable
 * sanitized prefix plus a stable 32-bit digest keeps the path debuggable and
 * collision-resistant without depending on a hash implementation.
 */
export function threadDirectorySegment(threadId: string): string {
  // Only characters that can never be a separator, a drive prefix, a trailing
  // dot, or a `..` component survive.
  const safe = threadId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return `${safe.length > 0 ? safe : "thread"}-${fnv1a32Hex(threadId)}`;
}

/** FNV-1a, 32-bit, hex. Stable across processes and platforms. */
function fnv1a32Hex(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** `<stateDir>/browser` - the root of all thread browser state. */
export const browserRootDir = (path: Path.Path, stateDir: string): string =>
  path.join(stateDir, BROWSER_DIR_NAME);

/** `<stateDir>/browser/<thread>` - one thread's browser state, and nothing else's. */
export const threadBrowserDir = (path: Path.Path, stateDir: string, threadId: string): string =>
  path.join(browserRootDir(path, stateDir), threadDirectorySegment(threadId));

/**
 * The persistent profile directory handed to Playwright MCP as
 * `--user-data-dir`. Chromium owns the contents; Workbench only creates, points
 * at, and (on explicit request) deletes the directory. It is never read,
 * parsed, copied into the database, or logged.
 */
export const threadProfileDir = (path: Path.Path, stateDir: string, threadId: string): string =>
  path.join(threadBrowserDir(path, stateDir, threadId), "profile");

/**
 * Directory for Playwright MCP's automatically named output files (an unnamed
 * screenshot, a trace). Keeping it under userdata is what stops agent browsing
 * from spraying untracked files into the project. Explicitly named files still
 * resolve against the workspace root, by upstream design.
 */
export const threadOutputDir = (path: Path.Path, stateDir: string, threadId: string): string =>
  path.join(threadBrowserDir(path, stateDir, threadId), "output");

/**
 * Crash-recovery record: the pid and endpoint of the Playwright MCP process this
 * server started for the thread. It is a hint for finding a leftover process, not
 * a source of truth - the live registry is the runtime's in-memory state.
 */
export const threadRuntimeStatePath = (
  path: Path.Path,
  stateDir: string,
  threadId: string,
): string => path.join(threadBrowserDir(path, stateDir, threadId), "runtime.json");
