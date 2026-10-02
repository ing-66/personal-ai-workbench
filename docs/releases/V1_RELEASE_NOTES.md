# Personal AI Workbench V1 — Release Notes

**Version: 1.0.0.** Tagged `v1.0.0` on the V1 release commit. The version now lives in the product's
own package manifests (`apps/server`, `apps/desktop`, `apps/web`, `packages/contracts`), replacing the
inherited upstream T3 Code `0.0.40` that identified the fork's lineage rather than this product.
`apps/server/package.json` is the manifest the packaging pipeline reads (`appVersion = options.version
?? serverPackageJson.version`), so it is the single source for both the installer name and the version
the packaged app reports at runtime.

**Status: CORE RELEASE READY; QWEN/KIMI REAL PROVIDER GATE OPEN.** **Platform: Windows x64.**
**Gate C: PASS.** Packaging and core runtime acceptance do not replace an authenticated real model
turn; see `V1_ACCEPTANCE.md`.

**Validated platform: Windows 10+ x64.** macOS and Linux packaging exist upstream but were not
validated for V1.

## Highlights

- **One thread, many harnesses.** A Canonical Thread belongs to a Project and can be worked by
  different agent harnesses in turn, with the baton moving automatically and the incoming harness
  briefed from task state instead of being re-told the task.
- **Generic ACP.** Any agent that speaks the Agent Client Protocol over stdio connects without a
  dedicated adapter. Qwen Code, Kimi Code and DeepSeek Harness ship as presets.
- **Office as a first-class citizen.** Word, Excel, PowerPoint and PDF are created, read and modified
  through one tool bus shared by every harness.
- **A real browser per thread.** The agent drives a persistent Chromium profile scoped to its thread,
  so logins survive a restart and a handoff.
- **Knowledge without a second product.** Workbench connects to the SAG service you run and scopes it
  per Project; it stores no documents, chunks or embeddings itself.
- **Model routing that cannot break the thread.** A loopback gateway routes a harness's model traffic
  with bounded failover, per-session credentials and metadata-only usage.

## Core architecture

`Project → workspace → Canonical Thread`. The thread owns task state, the conversation, the artifacts
and the browser profile; a harness is an interchangeable executor whose native session is disposable
cache. Full ownership map in `V1_ARCHITECTURE.md`.

Two schema additions land in this release: migration **053** adds Canonical Thread core state (task
state, artifacts, one resumable native-session mapping per provider instance), and migration **054**
adds Model Gateway usage telemetry.

## Supported harnesses

| Harness                   | How it connects                   | Model Gateway routing         |
| ------------------------- | --------------------------------- | ----------------------------- |
| Codex                     | native                            | yes (OpenAI Responses)        |
| Claude                    | native                            | yes (Anthropic Messages)      |
| OpenCode                  | native                            | no — `unsupported-by-harness` |
| Cursor, Grok, Antigravity | native                            | no — `unsupported-by-harness` |
| Qwen Code                 | Generic ACP (`qwen --acp`)        | no — `unsupported-by-harness` |
| Kimi Code                 | Generic ACP (`kimi acp`)          | no — `unsupported-by-harness` |
| DeepSeek Harness          | Generic ACP (`dsh --profile acp`) | no — `unsupported-by-harness` |
| Any ACP agent             | Generic ACP (custom command)      | no — `unsupported-by-harness` |

No harness is installed by Workbench; a missing CLI is reported as unavailable and does not affect the
rest of the app.

## Office

Seven tools, shared by every harness:
`office_inspect`, `office_read_range`, `office_document_write`, `office_spreadsheet_write`,
`office_presentation_create`, `office_presentation_add_slide`, `office_pdf_create`.

DOCX, XLSX, PPTX and PDF are all covered for inspect/read/write, workspace-relative by construction,
and a produced file is registered as a thread artifact.

## Browser

`@playwright/mcp` **pinned to `0.0.81`**, driving the system Chrome or Edge channel. Workbench ships
no browser binary and downloads none during install. One process and one persistent profile per
thread, started lazily on first use. A missing browser runtime, a locked profile and a failed launch
are reported as diagnostics rather than crashes. Closing the browser keeps the profile.

## Knowledge

The SAG service is an external integration and is neither bundled nor configured to auto-install.
Workbench owns the connection and a per-Project scope (`none` / `all` / one source); the scope
becomes the MCP URL the harness is given. If SAG is unreachable the thread simply has no knowledge
server — no silent fallback, no retrieval without an explicit scope.

## Model Gateway

Off by default, loopback only, in-process, started lazily. Provider profiles and routes live in
`settings.json`; API keys live in the OS keyring-backed secret store; usage rows live in SQLite with
a 30-day bounded retention. Failover is bounded, protocol-preserving and never replays a response the
harness has already begun receiving. The gateway never reads or writes a user-global CLI
configuration file.

## Data and privacy

Everything Workbench owns lives under the T3 base directory's `userdata` state directory: database,
settings, secrets, logs, per-thread browser profiles, attachments and browser artifacts. Secrets are
stored through the OS keyring-backed store and appear in client-visible surfaces only as a redaction
marker. Usage rows carry no prompt, completion, header, tool argument or key. `state.sqlite` and the
browser profiles are never written into a Project folder.

## Upgrade notes

- The schema upgrades automatically on first launch. Migrations **053** and **054** run in order and
  are additive; a database from any earlier release upgrades in one pass with its rows preserved.
- Running the application twice on the same database applies nothing the second time.
- A migration that cannot complete fails the launch and leaves the database untouched: nothing is
  recreated, truncated or deleted to force it through.
- **No backup is taken automatically before the upgrade.** Copy `userdata` before upgrading a
  database you care about.
- Per-thread browser profiles are new; the first browser use in an existing thread creates one.

## Known limitations

See `V1_KNOWN_LIMITATIONS.md`. The ones worth knowing before you install:

- The Model Gateway routes two harnesses (Codex, Claude). Every other harness runs natively.
- There is no protocol conversion in the gateway; a route's upstreams must share a protocol.
- A harness switch while a turn is running is refused — stop or finish the turn first. There is no
  "finish the turn, then hand off" queueing option.
- Estimated cost is shown only where the environment already knows prices.
- Knowledge requires a SAG service you install and run yourself.
