# Personal AI Workbench

Personal AI Workbench is a Windows-first, local-first multi-agent workbench built on the open-source
T3 Code shell. It adds project-bound canonical threads, provider handoff, Office/PDF tools, a
per-thread browser, SAG knowledge access, a local model gateway, and a Simplified Chinese UI.

> **Release status:** the core application builds and its targeted V1 regression suites pass. Codex
> and other already-authenticated native providers can be used. Qwen Code and Kimi Code are included
> as provider integrations, but they are **not unlocked merely by installing their CLIs**. On the
> maintainer's current machine the real acceptance gate still fails because Qwen has no usable
> authentication and Kimi returns HTTP 403 for subscription/model entitlement. See
> [V1 acceptance](./docs/releases/V1_ACCEPTANCE.md).

## What is required to unlock the full feature set

| Feature                   | What you must provide                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| At least one coding agent | Install and authenticate a supported provider CLI (Codex, Claude, Cursor, Grok Build or OpenCode), or configure Antigravity. Workbench does not install providers or include their subscriptions.       |
| Qwen Code                 | Install `qwen`, configure a currently supported Qwen Coding Plan/provider credential in Qwen itself, and prove a real standalone model turn succeeds. A version check or ACP handshake is insufficient. |
| Kimi Code                 | Install `kimi`, sign in to an account/subscription entitled to Kimi Code and the selected model (or configure a compatible endpoint/model), then prove a real standalone model turn succeeds.           |
| DeepSeek Harness          | Install `dsh`, configure its profile/plugins and model credentials, then enable the DSH provider instance.                                                                                              |
| Agent browser             | Install system Chrome or Edge. No browser binary is bundled.                                                                                                                                            |
| Knowledge search          | Run a separate SAG service, then set its endpoint/token under **Settings → Integrations → Knowledge** and select a project knowledge scope before starting the session.                                 |
| Model gateway             | Supply an OpenAI-compatible base URL, API key and accessible model under **Settings → Integrations → Model Gateway**.                                                                                   |
| Office/PDF tools          | No Microsoft Office installation is required for the built-in V1 tool bus. Complex Office formatting is best handled on a copy; high-fidelity COM editing is not part of V1.                            |

For Qwen/Kimi, run the real ACP probes documented in the
[Workbench V1 user guide](./docs/user/workbench-v1.md#3-configure-a-harness) only after the vendor
CLI can complete a real turn. Workbench deliberately does not copy credentials between unrelated
CLIs or bypass a vendor's subscription controls.

## Upstream and license

This repository is a fork of [T3 Code](https://github.com/pingdotgg/t3code) and retains its MIT
license and copyright notice. Workbench-specific changes are distributed under the same license.

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, T3 Code can control them.

> **This repository is Personal AI Workbench V1**, a fork of T3 Code. It keeps the T3 Code shell and
> adds Project-bound Canonical Threads, automatic harness handoff, Office/PDF tools, an agent browser,
> SAG knowledge, and a local model gateway. Read the
> [V1 user guide](./docs/user/workbench-v1.md) to use it, the
> [V1 release notes](./docs/releases/V1_RELEASE_NOTES.md) for what shipped, and
> [V1 known limitations](./docs/releases/V1_KNOWN_LIMITATIONS.md) before relying on it.
> Validated platform for V1: **Windows 10+ x64**.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Try it out (install-free)

The easiest way to test T3 Code is to run the server in your terminal (requires Node.js 22.16+, 23.11+, or 24.10+):

```bash
npx t3@latest
```

This will launch T3 Code's backend on your machine as well as the local web app to control your agents.

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

Workbench V1:

- [Personal AI Workbench V1 user guide](./docs/user/workbench-v1.md)
- [V1 release notes](./docs/releases/V1_RELEASE_NOTES.md)
- [V1 architecture](./docs/releases/V1_ARCHITECTURE.md)
- [V1 known limitations](./docs/releases/V1_KNOWN_LIMITATIONS.md)
- [V1 acceptance report](./docs/releases/V1_ACCEPTANCE.md)

T3 Code:

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
