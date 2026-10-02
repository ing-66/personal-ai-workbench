# Personal AI Workbench V1 user guide

Workbench is a local-first desktop app for working with coding agents. It is built on the T3 Code
shell, so most of the interface is familiar if you have used T3 Code. This page covers what V1 adds:
Project-bound threads, harness handoff, Office files, the agent browser, knowledge, and the model
gateway. The web and desktop interface can be displayed in English or Simplified Chinese.

Unlike the rest of the interfaces, everything Workbench adds is optional except the Project. Nothing
here needs to be configured to start the app.

## 1. Install

**Desktop app (recommended).** Run the Windows installer from the release artifact and launch
**Personal AI Workbench**. The installer bundles the server; no separate Node install is needed.

**From source.** From the repository root, `vp run dev` starts the server and the web app. Desktop
development is `vp run dev:desktop`.

Requirements:

- Windows 10 or later, x64. Windows is the validated V1 platform.
- A harness CLI you intend to use. Workbench never installs one for you.
- A Chromium-family browser (Chrome or Edge) if you want the agent browser.
- A running SAG service if you want knowledge search.

No model API key is required to install, launch, or configure. A harness that signs in natively works
without one.

## Interface language

Open **Settings → General → Behavior → Interface language** and choose **English** or
**Simplified Chinese**. The change takes effect immediately and is saved with the rest of the client
settings. Content returned by agents, provider names, model names, file paths, and external service
responses are not translated.

## 2. Open a Project folder

Workbench has no folderless chat. A thread must belong to a Project, and the Project's folder is the
only place file work is allowed.

1. Open the app and choose **Open folder** (or add a project from the sidebar).
2. Pick the folder you want the agent to work in.
3. That folder is now the working directory for every thread in the project. If a thread uses a git
   worktree, the worktree path is used instead.

## 3. Configure a harness

Settings → **Providers** → **Add provider instance**.

Native kinds (Codex, Claude, Cursor, Grok, OpenCode, Antigravity) use the CLI's own configuration.
The generic ACP kinds connect any agent that speaks the Agent Client Protocol over stdio:

| Kind             | Default command               |
| ---------------- | ----------------------------- |
| Qwen Code        | `qwen --acp`                  |
| Kimi Code        | `kimi acp`                    |
| DeepSeek Harness | `dsh --profile acp`           |
| Custom ACP       | none — you supply the command |

A generic ACP instance takes:

- **Command** — an executable name or absolute path. Workbench never installs it; if it is missing,
  the instance reports that it was not found rather than failing the app.
- **Args** — a JSON array, e.g. `["--acp"]`.
- **Capability overrides** — optional JSON booleans for `supportsMcpServers`, `fsReadTextFile`,
  `fsWriteTextFile`, `terminal`, for agents that under- or over-report.

There is no environment-variable field on a provider instance. A harness that needs an API key reads
it from its own configuration or its own environment.

Installing a CLI is not enough. Before enabling one of these providers, prove that the CLI can
complete a real non-interactive model turn in the same Windows account that runs Workbench. A
successful `--version`, ACP handshake or Mock test does not prove authentication, subscription
entitlement or model access.

After the vendor CLI succeeds on its own, run the matching Workbench ACP acceptance probe from the
repository root:

```powershell
$env:T3_GENERIC_ACP_PROBE = "qwen"
.\node_modules\.bin\vp.CMD test run apps/server/src/provider/Layers/GenericAcpCliProbe.test.ts

$env:T3_GENERIC_ACP_PROBE = "kimi"
.\node_modules\.bin\vp.CMD test run apps/server/src/provider/Layers/GenericAcpCliProbe.test.ts
```

The provider is ready only when the probe creates a real ACP session, sends a model prompt and
receives the expected marker. If it reports authentication, subscription or model-access failure,
fix that in the vendor CLI first; Workbench does not copy credentials between unrelated CLIs.

## 4. Create a thread

With a Project open, create a thread from the sidebar. The thread is the Canonical Thread: it owns
the conversation, the task state, the artifacts and the browser profile, and it outlives any harness.
Switching or losing a harness never loses the thread.

## 5. Hand off between harnesses

The composer's **Handoff** control shows who currently holds the baton and the latest handoff.

- **Handoff** — the target harness takes the baton and waits for your next message.
- **Handoff & Continue** — the target takes the baton and is told to continue the task immediately.
  This requires a continuation instruction, and it is what makes a mid-task switch seamless. The
  briefing is composed for you from the task state, recent messages, artifacts and workspace state;
  you do not restate the task.

A handoff is refused while a turn is running: Workbench will tell you the thread is busy. Finish or
stop the turn first. Two harnesses never hold the baton at once.

## 6. Office files

Word, Excel, PowerPoint and PDF work through the Workbench tool bus, so every harness uses the same
implementation and the same artifact registry. The tools are:

`office_inspect`, `office_read_range`, `office_document_write`, `office_spreadsheet_write`,
`office_presentation_create`, `office_presentation_add_slide`, `office_pdf_create`.

There is no Office settings page: the tools are attached to every session. Every write is
workspace-relative, so an agent cannot use them to reach outside the Project folder. Files produced
this way appear in the thread's artifact registry.

## 7. Agent browser

Settings → **Integrations** → **Browser** enables agent browser access and selects the browser
channel, headless mode and profile mode. With access off, the browser tools are withheld entirely
rather than failing at call time.

Each thread gets its own Chromium profile at `<stateDir>/browser/<thread>/profile`:

- The profile is persistent, so a login survives a restart and a harness handoff.
- Two threads never share a profile.
- Profiles are never stored inside a Project folder.
- If the profile is already held by a running browser, Workbench reports the lock. It never deletes
  the lock and never kills a browser it did not start.
- To discard a login, use the profile reset; closing the browser deliberately keeps the profile.

The browser starts on first use for a thread, not when Workbench starts.

## 8. Knowledge (SAG)

Knowledge is an **external service**. Workbench does not install, bundle or start SAG, and it does
not store documents, chunks or embeddings itself.

Settings → **Integrations** → **Knowledge**: enable knowledge, set the SAG endpoint and token, and
test the connection. The token is stored in the secret store, never in `settings.json`.

Scope is per Project: Settings → **Projects** (or the project's Knowledge row) chooses
**none / all / one source**. The scope becomes the MCP URL a harness is given, with a bearer token
only when one is stored. If SAG is unreachable or unconfigured, no knowledge server is attached and
the thread works without it — there is no silent fallback and no retrieval behind your back.

## 9. Model Gateway

Settings → **Model Gateway** runs a loopback-only proxy that carries a harness's model traffic to a
provider you configure. It is off by default and starts lazily.

- **Providers** — id, name, protocol (`openai-chat`, `openai-responses`, `anthropic-messages`), base
  URL, API key, default model, enabled.
- **Routes** — a primary provider plus ordered backups, optional model mapping, and a failover switch.
  A route's upstreams must share a protocol; a mismatch is refused when you save.
- **Usage** — requests, tokens, success rate, failovers and median latency over the last 24 hours.
  Token counts come from the upstream's own reporting; a missing count is shown as unknown.

To route a harness through the gateway, open its card in Settings → **Providers** and set
**Model gateway route**. Leaving it on **Native** means the harness keeps its own provider settings.

The gateway never reads or writes a global CLI configuration file; it injects a per-session
environment into the harness process Workbench already spawned, with a short-lived session token
instead of your API key. Failover never replays a request whose response the harness has already
started receiving.

## 10. Diagnostics

Settings → **General** → **Diagnostics** → **View diagnostics** opens the diagnostics page: live
processes, resource history, trace diagnostics, recent and most common failures, and slow spans.

Optional subsystems report their own state where they are configured: the browser shows
not-configured / ready / runtime-missing / profile-locked / launch-failed; knowledge shows
not-configured / disabled / ready / unauthorized / connection-failed; the gateway shows stopped /
starting / ready / failed plus a per-provider health line; a generic ACP harness reports whether its
executable was found and whether the handshake succeeded.

## 11. Where data lives

Everything Workbench owns is under the T3 base directory — `%USERPROFILE%\.t3` on Windows — in the
`userdata` state directory:

| What                                         | Path                                    |
| -------------------------------------------- | --------------------------------------- |
| Database (threads, events, artifacts, usage) | `userdata/state.sqlite`                 |
| Settings                                     | `userdata/settings.json`                |
| Credentials                                  | `userdata/secrets/` (OS keyring-backed) |
| Logs                                         | `userdata/logs/`                        |
| Thread browser profile                       | `userdata/browser/<thread>/profile`     |
| Browser screenshots you keep                 | `userdata/browser-artifacts/`           |
| Worktrees                                    | `worktrees/` (beside `userdata`)        |

Nothing here is written into a Project folder, and no secret is written into `settings.json`.

## 12. Uninstall and cleanup

Uninstalling the app removes the program. It does **not** remove your data: the `userdata` directory
above is left in place so a reinstall keeps your projects, threads and logins.

To remove everything, quit Workbench and delete `%USERPROFILE%\.t3\userdata`. That deletes the
database, settings, stored credentials, logs and every per-thread browser profile. To remove only
browser logins, delete the `userdata/browser` directory.

Workbench does not manage the harness CLIs or SAG: uninstall those separately if you no longer want
them.
