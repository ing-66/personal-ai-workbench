import { CommandId, ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import { request } from "@t3tools/client-runtime/rpc";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";
import { randomUUID } from "../lib/utils";
import {
  buildThreadHandoffCommand,
  type ThreadHandoffCommandInput,
} from "../components/chat/handoff.logic";

const handoffScheduler = createAtomCommandScheduler();

/**
 * Web-side dispatch for `thread.handoff`.
 *
 * It uses the same transport as every other orchestration command — the
 * `dispatchCommand` RPC, scoped to the thread's own environment — because
 * client-runtime owns the typed thread command atoms and has no handoff
 * operation yet. Serializing per thread matches `thread.turn.start` so a
 * handoff cannot interleave with the turn that is finishing.
 */
export const handoffThread = createEnvironmentCommand(connectionAtomRuntime, {
  label: "web:environment-data:commands:thread:handoff",
  scheduler: handoffScheduler,
  concurrency: {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  },
  execute: (input: ThreadHandoffCommandInput) =>
    request(
      ORCHESTRATION_WS_METHODS.dispatchCommand,
      buildThreadHandoffCommand(input, {
        commandId: CommandId.make(randomUUID()),
        createdAt: new Date().toISOString(),
      }),
    ),
});
