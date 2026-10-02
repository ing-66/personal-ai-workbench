# Phase 1 Implementation Audit

## Scope and frozen constraints

Phase 1 adds one configurable Generic ACP driver on top of T3's existing ACP stack. A thread remains owned by a Project and the provider process receives the resolved thread cwd (`thread.worktreePath ?? project.workspaceRoot`). There is no managed/folderless workspace fallback. Qwen Code, Kimi Code, and DeepSeek Harness are presets only; their CLIs are not installed or invoked by this change.

## T3 boundaries to reuse

- `ProviderDriver` and `ProviderInstanceRegistryLive` already decode opaque per-instance config, merge instance environment variables, own scoped lifecycle, and surface invalid configs as unavailable provider snapshots.
- `ServerSettings.providerInstances` already persists custom instances; its environment rows support sensitive-value redaction. No database or second settings store is needed.
- `ProviderCommandReactor` already resolves a thread's Project and passes its workspace/worktree cwd to the adapter. Generic ACP must reject an empty cwd and must not introduce another cwd setting.
- `AcpSessionRuntime` already owns executable spawning, stdio JSON-RPC, initialize/auth/session new/load/resume, prompt streaming, cancellation, process-exit detection, and scoped cleanup.
- `AcpCoreRuntimeEvents`, permission mapping, provider session persistence, and the existing provider settings/status UI remain the canonical normalization and presentation paths.
- Cursor's ACP adapter contains the reusable T3 adapter lifecycle above `AcpSessionRuntime`. The Generic ACP adapter should parameterize that path rather than copy the ACP protocol or stdio implementation.

## Existing provider behavior

- Registration is the static `BUILT_IN_DRIVERS` list; instance configuration is an open driver envelope in `ServerSettings.providerInstances`.
- Environment is merged by `mergeProviderInstanceEnvironment` and passed directly to the child without logging values.
- Availability probes use `resolveSpawnCommand`/`ChildProcessSpawner`, classify command-not-found separately, and publish a `ServerProvider` snapshot consumed by the existing Settings cards.
- Adapter/session scopes close child processes and event consumers. Adapter failures are mapped to typed process/request/session errors displayed by the existing orchestration UI.
- ACP capabilities are negotiated by `AcpSessionRuntime`; T3 model capabilities use the existing `ModelCapabilities` vocabulary. Generic overrides therefore cover ACP client capabilities (filesystem, terminal, MCP injection) and adapter session behavior only, not a new vocabulary.

## Paseo findings

Paseo models a custom ACP provider as label + command array + env + params, resolves the executable before launch, dynamically probes `initialize`/`session/new`, and allows explicit overrides for MCP server injection and client filesystem/terminal capabilities. Its presets create the same generic config as custom providers. Diagnostics distinguish the configured command, resolved executable, initialize/session failures, and final availability.

We reuse those design decisions, not its source: T3 already has the stronger protocol/runtime, provider registry, settings persistence, event normalization, permissions, and UI status primitives. Paseo's provider inheritance system, daemon tool catalog, protocol client, and UI are not copied.

## Minimal design

`GenericAcpSettings -> GenericAcpDriver -> GenericAcpAdapter -> AcpSessionRuntime -> ACP process`

The config contains `command`, `args`, and `capabilityOverrides`; display name and environment stay in the existing provider-instance envelope. The launcher always uses the adapter-supplied Project cwd. Built-in Qwen/Kimi/DSH choices seed that same config. Diagnostics use an executable-resolution probe and the real ACP initialize path where appropriate, with bounded timeouts and no installation side effects.

## Code that must not be copied

- ACP JSON-RPC schemas/client/stdio transport.
- Session streaming, cancellation, permission, filesystem/terminal RPC, or process cleanup.
- Three preset-specific drivers/adapters/launchers.
- A second settings database, provider registry, capability vocabulary, or workspace abstraction.
