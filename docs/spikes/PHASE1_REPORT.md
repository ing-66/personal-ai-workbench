# Phase 1 Report

## 1. Result

PASS

Phase 1 delivers a configurable Generic ACP Provider on T3's existing ACP runtime. No ACP protocol/JSON-RPC/stdio implementation was copied, and no third-party agent was installed.

## 2. Implemented

- Added a validated Generic ACP config with command, argument array, existing provider-instance environment variables, and optional client/MCP capability overrides.
- Added one Generic ACP driver factory and thin adapter. Qwen Code, Kimi Code, DeepSeek Harness, and Custom ACP all use it.
- Added executable availability diagnostics and clear missing-command guidance. No installer, PATH mutation, or shell-profile mutation exists.
- Added minimal provider Settings UI entries and structured JSON editors for arguments/capability overrides. Existing environment rows remain the environment-variable editor and retain sensitive-value redaction.
- Added fixture integration and preset/config/diagnostic tests.

## 3. Architecture

```text
ServerSettings.providerInstances
  -> GenericAcpSettings
  -> Generic ACP driver factory
  -> GenericAcpAdapter (provider identity + launch config only)
  -> existing ACP adapter lifecycle
  -> AcpSessionRuntime
  -> effect-acp JSON-RPC/stdio client
  -> configured ACP process
```

The process cwd is not configurable. `ProviderCommandReactor` resolves the Thread's Project and supplies `thread.worktreePath ?? project.workspaceRoot`; the adapter requires a non-empty cwd and overwrites any static spawn cwd with that value.

## 4. Reuse

Reused from T3:

- `ProviderDriver`, provider instance registry and scoped lifecycle.
- `ServerSettings.providerInstances`, environment persistence/redaction and provider Settings cards.
- Existing Project → Thread → cwd orchestration constraint.
- `AcpSessionRuntime`, `effect-acp`, ACP permissions, events, session persistence, cancellation and child cleanup.
- Existing ACP adapter event normalization and user-facing orchestration error path.

Adopted from Paseo as design guidance:

- command/args/env configuration;
- presets represented through the generic path;
- explicit MCP/filesystem/terminal capability overrides;
- executable resolution and actionable diagnostics.

Not copied: Paseo's ACP client, stdio transport, provider registry, daemon tool catalog, settings store, UI, or inheritance framework.

## 5. Presets

- Qwen Code: `qwen --acp`
- Kimi Code: `kimi acp`
- DeepSeek Harness: `dsh --profile acp`

The three preset driver entries are metadata/default-config wrappers produced by the same Generic ACP driver factory; they contain no protocol or launcher implementation of their own.

## 6. Custom Provider

Custom ACP supports:

- display name through the existing provider-instance envelope;
- executable command or absolute path;
- ordered argument array;
- environment variables through the existing environment editor;
- optional `supportsMcpServers`, filesystem read/write and terminal client-capability overrides.

Omitted override fields mean automatic/default behavior. No cwd field is exposed.

## 7. Workspace Behavior

The unchanged canonical flow is:

```text
Project -> workspaceRoot -> Thread -> ProviderCommandReactor cwd -> ACP process
```

T3's contracts require `ProjectCreateCommand.workspaceRoot` and `ThreadCreateCommand.projectId`; Generic ACP does not add a folderless entry point or hidden workspace. The fixture integration asserts that `session/new.cwd` equals the Project workspace supplied to the adapter.

## 8. Diagnostics

Supported observable states:

- configured / executable found: provider snapshot is ready with a confirmation message;
- executable missing: unavailable/error snapshot names the provider and expected command;
- spawn or handshake failure: typed provider process/request/session error through the existing orchestration error UI;
- connected: existing `session.started`, `session.state.changed(ready)` and `thread.started` events;
- exited: existing ACP connection termination and `session.exited` lifecycle.

Environment values are never included in diagnostic messages. Tests verify missing commands do not trigger installation and broken ACP processes fail cleanly.

## 9. Tests

Executed successfully outside the filesystem sandbox because the existing Vitest module returns EPERM inside it:

1. `vp test run` for Generic ACP adapter/driver/diagnostics, contracts settings, provider settings form, `packages/effect-acp/src`, and `apps/server/src/provider/acp`: **23 passed files, 2 skipped; 416 passed tests, 8 skipped**.
2. Provider registry/settings regression selection: **5 passed files; 126 passed tests**.
3. Final Generic ACP fixture integration after adding env/capability and handshake-failure assertions: **1 passed file; 2 passed tests**.
4. Missing-executable diagnostics plus settings form: **2 passed files; 12 passed tests**.

Targeted TypeScript checks found no new errors in Generic ACP/server files or settings contracts. Web changed files have only the pre-existing missing `react/jsx-runtime` dependency-tree error.

No browser/computer-use verification was run because project instructions require explicit permission. The UI behavior is covered by focused logic/schema tests.

## 10. Baseline Issues

- The normal `pnpm ... typecheck` scripts cannot start because the Vite+ `current` shim points to a missing executable. Tests used the known installed `0.3.2` executable directly.
- Full TypeScript checks remain blocked by the Phase 0 incomplete dependency tree, including missing/incorrect Node `Buffer` types and missing `react/jsx-runtime`.
- Running Vitest inside the sandbox still fails with EPERM while reading the installed Vitest module; the same targeted commands pass outside the sandbox.
- These are recorded Phase 0 environment/dependency issues. No business source was changed to bypass them.

## 11. Files Changed

- `packages/contracts/src/settings.ts` and test: Generic ACP config and JSON form-control annotation.
- `apps/server/src/provider/Drivers/GenericAcpDriver.ts` and tests: shared driver factory, presets, availability diagnostics.
- `apps/server/src/provider/Layers/GenericAcpAdapter.ts` and test: thin identity/launch wrapper and end-to-end fake ACP coverage.
- `apps/server/src/provider/acp/CursorAcpSupport.ts`: parameterized spawn/client capability hooks over the existing runtime.
- `apps/server/src/provider/Layers/CursorAdapter.ts`: uses the parameterized launch config while preserving Cursor defaults.
- `apps/server/src/provider/builtInDrivers.ts`: registers preset and custom Generic ACP entries.
- `apps/web/src/components/settings/providerDriverMeta.ts`: minimal provider choices and preset defaults.
- `apps/web/src/components/settings/AddProviderInstanceDialog.tsx`: persists preset defaults.
- `apps/web/src/components/settings/ProviderSettingsForm.tsx` and test: structured JSON editing for args/overrides.
- `docs/spikes/PHASE1_IMPLEMENTATION_AUDIT.md`: pre-implementation reuse audit.
- `docs/spikes/PHASE1_REPORT.md`: this report.

## 12. Git Diff Summary

The change is limited to Generic ACP contracts, server driver/adapter/runtime parameterization, provider Settings UI, focused tests, and the two Phase 1 reports. Existing user-owned `docs/project-specs/` files remain untouched. No commit, push, tag, reset, clean, or stash was performed.

## 13. Known Limitations

- Qwen/Kimi/DSH are absent on this machine, so their real authentication and vendor-specific ACP conformance were not tested; the preset commands and missing-executable behavior are covered.
- Generic ACP does not provide out-of-thread text generation for automatic titles/commit/PR copy; those operations return an explicit unsupported error. Conversation operation is fully ACP-backed.
- Capability overrides intentionally cover only the ACP/T3 capability vocabulary currently relevant to client filesystem, terminal and MCP injection.
- UI visual verification awaits explicit browser/computer-use permission.

## 14. Phase 2 Readiness

The Generic ACP boundary is ready for Phase 2 planning: future ACP harnesses can be added as configuration/default metadata without another protocol implementation. Phase 2 has not been started.
