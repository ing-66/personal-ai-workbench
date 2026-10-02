import {
  ProviderDriverKind,
  type GenericAcpSettings,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { makeCursorAdapter, type CursorAdapterLiveOptions } from "./CursorAdapter.ts";

/** UI routing sentinel: the ACP child keeps control of its own model choice. */
export const ACP_HARNESS_DEFAULT_MODEL = "harness-default";

const withoutHarnessDefaultModel = <T extends ProviderSessionStartInput | ProviderSendTurnInput>(
  input: T,
): T => ({
  ...input,
  modelSelection:
    input.modelSelection?.model === ACP_HARNESS_DEFAULT_MODEL ||
    input.modelSelection?.model === "default" ||
    input.modelSelection?.model === "auto"
      ? undefined
      : input.modelSelection,
});

/**
 * Thin Generic ACP adapter. It reuses T3's production ACP adapter lifecycle and
 * swaps only launch configuration and provider identity; protocol and transport
 * remain owned by AcpSessionRuntime/effect-acp.
 */
export const makeGenericAcpAdapter = (
  config: GenericAcpSettings,
  options: Omit<CursorAdapterLiveOptions, "acpRuntime"> & {
    readonly displayName: string;
    readonly driverKind: ProviderDriverKind;
  },
): ReturnType<typeof makeCursorAdapter> =>
  makeCursorAdapter(
    { enabled: true, binaryPath: config.command, apiEndpoint: "", customModels: [] },
    {
      ...options,
      acpRuntime: {
        spawn: {
          command: config.command,
          args: config.args,
          ...(options.environment ? { env: options.environment } : {}),
        },
        harnessName: options.displayName,
        authMethodId: "",
        supportsMcpServers: config.capabilityOverrides.supportsMcpServers ?? true,
        clientCapabilities: {
          fs: {
            readTextFile: config.capabilityOverrides.fsReadTextFile ?? true,
            writeTextFile: config.capabilityOverrides.fsWriteTextFile ?? true,
          },
          terminal: config.capabilityOverrides.terminal ?? true,
        },
      },
    },
  ).pipe(
    Effect.map((adapter) => ({
      ...adapter,
      provider: options.driverKind,
      startSession: (input: ProviderSessionStartInput) => {
        const prepared = withoutHarnessDefaultModel(input);
        // DeepSeek Harness currently implements session/new but not session/load.
        // Never turn a server restart into a hard failure by replaying its old ACP id.
        const resumable =
          options.driverKind === "deepseekAcp"
            ? { ...prepared, resumeCursor: undefined }
            : prepared;
        return adapter
          .startSession({
            ...resumable,
            provider: ProviderDriverKind.make("cursor"),
          })
          .pipe(
            Effect.map((session): ProviderSession => ({
              ...session,
              provider: options.driverKind,
              model: ACP_HARNESS_DEFAULT_MODEL,
            })),
          );
      },
      sendTurn: (input: ProviderSendTurnInput) =>
        adapter.sendTurn(withoutHarnessDefaultModel(input)),
      listSessions: () =>
        adapter.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.map((session) => ({
              ...session,
              provider: options.driverKind,
              model: ACP_HARNESS_DEFAULT_MODEL,
            })),
          ),
        ),
      streamEvents: Stream.map(adapter.streamEvents, (event): ProviderRuntimeEvent => ({
        ...event,
        provider: options.driverKind,
      })),
    })),
  );
