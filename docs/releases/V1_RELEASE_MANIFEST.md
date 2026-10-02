# Personal AI Workbench V1 — Release Manifest

The final artifact record. Every value below was read from the machine that produced it; nothing is
carried over from an earlier build.

| Field                           | Value                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Version                         | **1.0.0**                                                                                                                                                          |
| Tag                             | `v1.0.0` (annotated)                                                                                                                                               |
| Commit SHA                      | `0e24b8a008c0fb9e41d7cf249e4daff6763cb7ab`                                                                                                                         |
| Commit message                  | `feat: release personal ai workbench v1.0.0`                                                                                                                       |
| Base commit before finalization | `c1b2210411da79350a3f9f5a65a4a64971e4acad`                                                                                                                         |
| Platform                        | Windows x64                                                                                                                                                        |
| Installer filename              | `T3-Code-1.0.0-x64.exe`                                                                                                                                            |
| Installer path                  | `D:\personal-ai-workbench\release\T3-Code-1.0.0-x64.exe` (repo-relative `release/T3-Code-1.0.0-x64.exe`, gitignored)                                               |
| Installer size                  | 133,910,816 bytes                                                                                                                                                  |
| Installer SHA-256               | `7ECE640B2846351AFA8FA95E0737D3761A7BADF0323B083D5DB38956D252ACC0`                                                                                                 |
| Blockmap                        | `release/T3-Code-1.0.0-x64.exe.blockmap`, 140,178 bytes                                                                                                            |
| Blockmap SHA-256                | `3F13E8981078F18AF30ABCF7A12FBA2CF8BE0AD42C18F909D5602CA6803A56C5`                                                                                                 |
| Build command                   | `node scripts/build-desktop-artifact.ts --platform win --target nsis --arch x64` (env `T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true`, `node_modules\.bin` on `PATH`) |
| Build result                    | **PASS** — exit 0; `Building win/nsis (arch=x64, version=1.0.0)`; `Validated Windows payload (48 files, 18 sidecar natives)`                                       |
| Smoke result                    | **PASS** — see below                                                                                                                                               |
| Release notes                   | `docs/releases/V1_RELEASE_NOTES.md`                                                                                                                                |
| Acceptance record               | `docs/releases/V1_ACCEPTANCE.md`                                                                                                                                   |
| Known limitations               | `docs/releases/V1_KNOWN_LIMITATIONS.md`                                                                                                                            |
| Architecture                    | `docs/releases/V1_ARCHITECTURE.md`                                                                                                                                 |
| Phase 8 report                  | `docs/spikes/PHASE8_REPORT.md`                                                                                                                                     |

## Version sources

`apps/server/package.json` is the version source the packaging pipeline reads
(`appVersion = options.version ?? serverPackageJson.version`), and it is what both the installer's
metadata and the packaged app's reported version derive from. Finalization set four manifests to
`1.0.0`, replacing the inherited upstream T3 Code `0.0.40`:

| File                              | Field     | Before   | After   |
| --------------------------------- | --------- | -------- | ------- |
| `apps/server/package.json`        | `version` | `0.0.40` | `1.0.0` |
| `apps/desktop/package.json`       | `version` | `0.0.40` | `1.0.0` |
| `apps/web/package.json`           | `version` | `0.0.40` | `1.0.0` |
| `packages/contracts/package.json` | `version` | `0.0.40` | `1.0.0` |

Dependency versions, protocol versions, migration versions and test-fixture strings were not touched.

## Branding (recorded, not changed)

The installer name and the packaged application identity are still inherited from upstream T3 Code.
Finalization deliberately did **not** restructure application identity; that is a separate task.

| Field                            | Value                               | Source                                               |
| -------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| Installer filename pattern       | `T3-Code-${version}-${arch}.${ext}` | `scripts/build-desktop-artifact.ts` (`artifactName`) |
| `productName`                    | `T3 Code (Alpha)`                   | `apps/desktop/package.json`                          |
| Installer `ProductName` resource | `T3 Code (Alpha)`                   | installer metadata                                   |
| Installed app executable         | `T3 Code (Alpha).exe`               | installer payload                                    |
| Internal app version             | `1.0.0`                             | `app.asar/package.json`, `server.asar/package.json`  |

## Version verification

| Check                                          | Result   | Evidence                                                                              |
| ---------------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| Package metadata = 1.0.0                       | **PASS** | all four manifests read back `1.0.0`                                                  |
| Installer metadata = 1.0.0                     | **PASS** | `T3-Code-1.0.0-x64.exe` → `FileVersion 1.0.0`, `ProductVersion 1.0.0`                 |
| Packaged app metadata = 1.0.0                  | **PASS** | `resources/app.asar/package.json` → `version 1.0.0`, `buildVersion 1.0.0`             |
| Packaged server reports = 1.0.0                | **PASS** | installed sidecar `bin.mjs --version` → `t3 v1.0.0` (exit 0)                          |
| `server.asar` metadata = 1.0.0                 | **PASS** | `resources/server.asar/package.json` → `{"name":"t3code-server","version":"1.0.0",…}` |
| Artifact built from the tagged commit          | **PASS** | `app.asar/package.json` → `t3codeCommitHash: 0e24b8a008c0`, the `v1.0.0` commit       |
| No `app = 1.0.0 / installer = 0.0.40` mismatch | **PASS** | no `0.0.40` remains outside `docs/`                                                   |

## Installer smoke

Run against the payload installed from the final installer, on a fresh temporary base directory and
port `45123`, with every process captured by PID at spawn.

| Step                                     | Result   | Evidence                                                                                                                                                                               |
| ---------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Silent install                           | **PASS** | `T3-Code-1.0.0-x64.exe /S /D=<temp>` → exit 0                                                                                                                                          |
| Payload present                          | **PASS** | `T3 Code (Alpha).exe` 245,335,552 bytes; `resources/app.asar` 18,051,013 bytes; `resources/server.asar` 70,567,879 bytes; `resources/resource-monitor/t3-resource-monitor.exe` present |
| First launch, fresh base dir             | **PASS** | HTTP 200 in **2 s**, 20,143 bytes, `<title>T3 Code (Alpha)</title>`; stdout `Listening on http://127.0.0.1:45123`                                                                      |
| State isolated to the temporary base dir | **PASS** | base dir created with `caches`, `userdata`, `worktrees`; `userdata/state.sqlite` present; nothing written to a Project folder                                                          |
| Migrations run once                      | **PASS** | launch 1 stdout: one `Migrations ran` line including `53_CanonicalThreadCoreState` and `54_ModelGatewayUsage`                                                                          |
| Normal shutdown                          | **PASS** | captured PID stopped; port `45123` released; process gone                                                                                                                              |
| Second launch, same base dir and port    | **PASS** | HTTP 200 in **2 s**, same page; `Migrations ran` occurrences = **0** (no re-migration, no port conflict)                                                                               |
| Clean shutdown and no leftovers          | **PASS** | port released; 0 processes referencing the smoke install; 0 referencing the worktree server                                                                                            |

### Smoke method note

The installed **desktop shell** does not forward `--base-dir`/`--port` to its embedded server in this
headless session: launching `T3 Code (Alpha).exe` with those flags created no base directory and
opened no listener. The smoke above therefore drives the installed payload's own bundled server
(`resources/server.asar`) under `ELECTRON_RUN_AS_NODE`, which is the artifact that actually serves
HTTP and the UI, and which is how the Phase 8 acceptance record describes the packaged runtime. The
desktop shell itself was exercised only to the extent of starting and exiting cleanly.

A first smoke attempt was run while a stale Workbench server from an earlier session still held port
`45123`; its HTTP responses came from that stale process and are **discarded**. The stale instance was
identified by its command line (this worktree's `apps/server/dist/bin.mjs`, base dir
`.t3/gatec-final`), stopped by its verified owner PID, and the port was confirmed released before the
smoke above was re-run from scratch.

## Security

| Check                                                                                     | Result   | Evidence                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No secret in the committed tree                                                           | **PASS** | structural scan for key-shaped and PEM material over tracked files found hits only in `.repos/alchemy-effect/**` — upstream-vendored read-only fixtures that are byte-identical to the base commit and are not part of the V1 change |
| No userdata, SQLite, screenshot, Office fixture, log, browser profile or installer staged | **PASS** | `git status --porcelain --untracked-files=all` reported only files under `apps/`, `packages/` and `docs/`                                                                                                                            |
| Installer not tracked by Git                                                              | **PASS** | `release/` is gitignored (`.gitignore:16`)                                                                                                                                                                                           |
| Smoke used a temporary base dir                                                           | **PASS** | state written under the temporary base dir only                                                                                                                                                                                      |

## Scope of finalization

Finalization changed **version numbers, release documentation and release metadata only**. No runtime
logic was modified: the four version fields are the only source-file change, and the release suite
result is identical to the Phase 8 baseline. Nothing was pushed, published or released remotely.

## Concurrent documentation change

`docs/releases/V1_ACCEPTANCE.md` was expanded after the `v1.0.0` commit was tagged by a concurrent
writer in this same workspace (+28 KB: a release-commit note in the environment header, two recorded
gate observations, and a corrected Gate C verdict). It is a **documentation-only** change — no source,
build input or artifact input — so the installer, its size and its SHA-256 above remain exactly those
of the tagged commit. The change is folded into the manifest commit so the working tree ends clean;
the tag `v1.0.0` itself is unchanged and still points at `0e24b8a0`.
