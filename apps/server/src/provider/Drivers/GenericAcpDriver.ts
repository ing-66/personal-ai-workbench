import { GenericAcpSettings, ProviderDriverKind, TextGenerationError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { ServerConfig } from "../../config.ts";

import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { ACP_HARNESS_DEFAULT_MODEL, makeGenericAcpAdapter } from "../Layers/GenericAcpAdapter.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";

const decodeSettings = Schema.decodeSync(GenericAcpSettings);

export const GENERIC_ACP_PRESETS = {
  qwen: { name: "Qwen Code", command: "qwen", args: ["--acp"] },
  kimi: { name: "Kimi Code", command: "kimi", args: ["acp"] },
  deepseek: { name: "DeepSeek Harness", command: "dsh", args: ["--profile", "acp"] },
} as const;

export type GenericAcpDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig;

const unsupportedTextGeneration = {
  generateCommitMessage: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Generic ACP does not expose out-of-thread text generation.",
      }),
    ),
  generatePrContent: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generatePrContent",
        detail: "Generic ACP does not expose out-of-thread text generation.",
      }),
    ),
  generateBranchName: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateBranchName",
        detail: "Generic ACP does not expose out-of-thread text generation.",
      }),
    ),
  generateThreadTitle: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Generic ACP does not expose out-of-thread text generation.",
      }),
    ),
};

function makeGenericAcpDriver(input: {
  readonly driverKind: string;
  readonly displayName: string;
  readonly defaultConfig: GenericAcpSettings;
  readonly canonicalCommand?: string;
}): ProviderDriver<GenericAcpSettings, GenericAcpDriverEnv> {
  const driverKind = ProviderDriverKind.make(input.driverKind);
  return {
    driverKind,
    metadata: { displayName: input.displayName, supportsMultipleInstances: true },
    configSchema: GenericAcpSettings,
    defaultConfig: () => input.defaultConfig,
    create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const processEnv = mergeProviderInstanceEnvironment(environment);
        const continuationIdentity = defaultProviderContinuationIdentity({
          driverKind,
          instanceId,
        });
        const stamp = withInstanceIdentity({
          instanceId,
          driverKind,
          displayName,
          accentColor,
          continuationGroupKey: continuationIdentity.continuationKey,
        });
        const name = displayName ?? input.displayName;
        const configuredExecutable = config.command
          .replaceAll("\\", "/")
          .split("/")
          .at(-1)
          ?.replace(/\.(?:exe|cmd|bat)$/i, "")
          .toLowerCase();
        const commandMatchesPreset =
          input.canonicalCommand === undefined ||
          configuredExecutable === input.canonicalCommand.toLowerCase();
        // A branded preset may use an absolute path, but it may not launch a
        // different executable while retaining the preset's product name.
        const runtimeConfig = commandMatchesPreset ? config : input.defaultConfig;
        const models = [
          {
            slug: ACP_HARNESS_DEFAULT_MODEL,
            name: "Harness default (managed by CLI)",
            isDefault: true,
            isCustom: false,
            capabilities: null,
          },
        ];

        const check = Effect.gen(function* () {
          const checkedAt = DateTime.formatIso(yield* DateTime.now);
          if (!enabled) {
            return stamp(
              buildServerProvider({
                presentation: { displayName: name, supportsConversationRollback: false },
                enabled: false,
                checkedAt,
                models,
                probe: {
                  installed: false,
                  version: null,
                  status: "warning",
                  auth: { status: "unknown" },
                  message: `${name} is disabled.`,
                },
              }),
            );
          }
          if (!commandMatchesPreset) {
            return stamp(
              buildServerProvider({
                presentation: { displayName: name, supportsConversationRollback: false },
                enabled: true,
                checkedAt,
                models,
                probe: {
                  installed: false,
                  version: null,
                  status: "error",
                  auth: { status: "unknown" },
                  message: `${name} must launch the real '${input.canonicalCommand}' executable; '${config.command}' is not accepted for this preset. Use Custom ACP for other commands.`,
                },
              }),
            );
          }
          const resolved = yield* resolveSpawnCommand(config.command, ["--version"], {
            env: processEnv,
            extendEnv: true,
          });
          const result = yield* Effect.result(
            spawnAndCollect(
              config.command,
              ChildProcess.make(resolved.command, resolved.args, {
                env: processEnv,
                extendEnv: true,
                shell: resolved.shell,
              }),
            ),
          );
          if (result._tag === "Failure") {
            const missing = isCommandMissingCause(result.failure);
            return stamp(
              buildServerProvider({
                presentation: { displayName: name, supportsConversationRollback: false },
                enabled: true,
                checkedAt,
                models,
                probe: {
                  installed: !missing,
                  version: null,
                  status: "error",
                  auth: { status: "unknown" },
                  message: missing
                    ? `${name} was not found on this computer. Expected command: ${config.command}. Install or configure the CLI first, then retry.`
                    : `${name} availability check failed. The configured command could not be started.`,
                },
              }),
            );
          }
          return stamp(
            buildServerProvider({
              presentation: { displayName: name, supportsConversationRollback: false },
              enabled: true,
              checkedAt,
              models,
              probe: {
                installed: true,
                version: null,
                status: "ready",
                auth: { status: "unknown" },
                message: `${name} is configured and its executable was found.`,
              },
            }),
          );
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        const initial = yield* check;
        const snapshot = {
          resolveMaintenance: () =>
            Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({
                provider: driverKind,
                packageName: null,
              }),
            ),
          getSnapshot: Effect.succeed(initial),
          refresh: check,
          streamChanges: Stream.empty,
          applyUsageLimits: () => Effect.void,
        };
        const adapter = yield* makeGenericAcpAdapter(runtimeConfig, {
          environment: processEnv,
          instanceId,
          displayName: name,
          driverKind,
        });
        return {
          instanceId,
          driverKind,
          continuationIdentity,
          displayName,
          accentColor,
          enabled,
          snapshot,
          adapter,
          textGeneration: unsupportedTextGeneration,
        } satisfies ProviderInstance;
      }),
  };
}

export const GenericAcpDriver = makeGenericAcpDriver({
  driverKind: "genericAcp",
  displayName: "Custom ACP",
  defaultConfig: decodeSettings({ command: "acp-agent" }),
});
export const QwenAcpDriver = makeGenericAcpDriver({
  driverKind: "qwenAcp",
  displayName: GENERIC_ACP_PRESETS.qwen.name,
  defaultConfig: decodeSettings(GENERIC_ACP_PRESETS.qwen),
  canonicalCommand: GENERIC_ACP_PRESETS.qwen.command,
});
export const KimiAcpDriver = makeGenericAcpDriver({
  driverKind: "kimiAcp",
  displayName: GENERIC_ACP_PRESETS.kimi.name,
  defaultConfig: decodeSettings(GENERIC_ACP_PRESETS.kimi),
  canonicalCommand: GENERIC_ACP_PRESETS.kimi.command,
});
export const DeepSeekAcpDriver = makeGenericAcpDriver({
  driverKind: "deepseekAcp",
  displayName: GENERIC_ACP_PRESETS.deepseek.name,
  defaultConfig: decodeSettings(GENERIC_ACP_PRESETS.deepseek),
  canonicalCommand: GENERIC_ACP_PRESETS.deepseek.command,
});
