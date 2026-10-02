import {
  type EnvironmentId,
  type OrchestrationThreadActivity,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ArrowLeftRightIcon } from "lucide-react";
import { type ComponentProps, useMemo, useState } from "react";

import {
  getDefaultProviderInstanceModel,
  type ProviderInstanceEntry,
  shouldShowInstanceBadge,
} from "../../providerInstances";
import { handoffThread } from "../../state/handoff";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import {
  deriveLatestHandoff,
  handoffFailureText,
  handoffStateLabel,
  selectHandoffTargets,
} from "./handoff.logic";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { useI18n } from "../../i18n";

export interface HandoffControlsProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  /** The instance that currently holds the baton, from the thread's session. */
  currentInstanceId: ProviderInstanceId | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /** Raw provider snapshots, for the target instance's own default model. */
  providerStatuses: ReadonlyArray<ServerProvider>;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  /** Existing per-model diagnostics, reused instead of a second availability UI. */
  getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  size?: ComposerControlSize;
}

/**
 * Composer control that hands the thread's baton to another configured provider
 * instance: "Handoff" switches only, "Handoff & Continue" also sends one
 * continuation instruction to the target.
 */
export function HandoffControls(props: HandoffControlsProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [continuationText, setContinuationText] = useState("");
  const [pendingInstanceId, setPendingInstanceId] = useState<ProviderInstanceId | null>(null);
  const runHandoff = useAtomCommand(handoffThread, { reportFailure: false });

  const { activities, currentInstanceId, instanceEntries, providerStatuses, size = "sm" } = props;
  const targets = useMemo(
    () =>
      currentInstanceId === null ? [] : selectHandoffTargets(instanceEntries, currentInstanceId),
    [currentInstanceId, instanceEntries],
  );
  const latest = useMemo(() => deriveLatestHandoff(activities), [activities]);

  if (currentInstanceId === null || targets.length === 0) return null;

  const currentDisplayName =
    instanceEntries.find((entry) => entry.instanceId === currentInstanceId)?.displayName ??
    currentInstanceId;
  const continuationReady = continuationText.trim().length > 0;

  const translateUnavailableReason = (reason: string) => {
    if (reason === "Disabled in settings" || reason === "Unavailable") return t(reason);
    if (reason.startsWith("Not ready: ")) {
      return t("Not ready: {status}", { status: t(reason.slice("Not ready: ".length)) });
    }
    return reason;
  };

  const handleContinuationChange: NonNullable<ComponentProps<"input">["onChange"]> = (event) => {
    setContinuationText(event.target.value);
  };

  const dispatch = async (target: ProviderInstanceEntry, continueTurn: boolean) => {
    setPendingInstanceId(target.instanceId);
    const model = getDefaultProviderInstanceModel(providerStatuses, target.instanceId);
    const result = await runHandoff({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        targetProviderInstanceId: target.instanceId,
        ...(model ? { modelSelection: { instanceId: target.instanceId, model } } : {}),
        ...(continueTurn ? { continuationText } : {}),
        runtimeMode: props.runtimeMode,
        interactionMode: props.interactionMode,
      },
    });
    setPendingInstanceId(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: continueTurn
          ? `Could not hand off to ${target.displayName}`
          : `Could not switch to ${target.displayName}`,
        description: handoffFailureText(squashAtomCommandFailure(result)),
      });
      return;
    }
    setContinuationText("");
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <ComposerControl
            size={size}
            aria-label={t("Switch this thread to another CLI harness")}
            data-chat-handoff-trigger="true"
          />
        }
      >
        <ComposerControlIcon icon={ArrowLeftRightIcon} size={size} />
        <span className="hidden sm:inline">{t("Switch CLI")}</span>
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80">
        <div className="flex flex-col gap-2.5 p-3" data-chat-handoff-content="true">
          <div className="text-xs text-secondary-label" data-chat-handoff-baton={currentInstanceId}>
            {t("Baton holder")}: <span className="text-foreground">{currentDisplayName}</span>
          </div>
          <div
            className="text-xs text-secondary-label"
            data-chat-handoff-state={latest?.payload.state ?? "none"}
          >
            {latest === null
              ? t("No handoffs yet.")
              : `${handoffStateLabel(latest.payload.state)} · ${latest.summary}`}
          </div>
          <Input
            nativeInput
            size="compact"
            value={continuationText}
            aria-label={t("Handoff continuation instruction")}
            placeholder={t("Continuation instruction")}
            onChange={handleContinuationChange}
          />
          <div className="flex flex-col gap-1.5">
            {targets.map(({ entry, unavailableReason }) => {
              const model = getDefaultProviderInstanceModel(providerStatuses, entry.instanceId);
              const reason =
                unavailableReason === null
                  ? null
                  : (props.getModelDisabledReason(entry.instanceId, model ?? "") ??
                    unavailableReason);
              const displayReason = reason === null ? null : translateUnavailableReason(reason);
              const pending = pendingInstanceId !== null;
              return (
                <div
                  key={entry.instanceId}
                  className="flex items-center justify-between gap-2"
                  data-chat-handoff-target={entry.instanceId}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <ProviderInstanceIcon
                      driverKind={entry.driverKind}
                      displayName={entry.displayName}
                      accentColor={entry.accentColor}
                      showBadge={shouldShowInstanceBadge(entry, instanceEntries)}
                      className="size-4"
                      iconClassName="size-4"
                    />
                    <span className="truncate text-xs">{entry.displayName}</span>
                  </span>
                  {displayReason !== null ? (
                    <Badge variant="outline" size="sm" title={displayReason}>
                      {displayReason}
                    </Badge>
                  ) : (
                    <span className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => void dispatch(entry, false)}
                      >
                        {t("Switch CLI")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="default"
                        disabled={pending || !continuationReady}
                        onClick={() => void dispatch(entry, true)}
                      >
                        {t("Switch & Continue")}
                      </Button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
