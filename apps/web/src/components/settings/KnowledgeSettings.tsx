import {
  KNOWLEDGE_SAG_TOKEN_REDACTED,
  KNOWLEDGE_SCOPE_NONE,
  knowledgeScopeLabel,
  knowledgeScopeOrNone,
  type EnvironmentId,
  type KnowledgeScope,
  type ProjectId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import { knowledgeStatus } from "../../state/knowledge";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  knowledgeScopeFromSelectValue,
  knowledgeScopeSelectValue,
  knowledgeSourceChoices,
  projectKnowledgeStatusText,
  resolveKnowledgeDisplay,
} from "./knowledgeSettings.logic";
import { ScopedSwitch } from "./ScopedSwitch";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { useI18n } from "../../i18n";

const ENDPOINT_PLACEHOLDER = "http://127.0.0.1:8000/mcp/";

/**
 * The environment's connection to the knowledge engine: one endpoint, one
 * credential, and the live answer to whether either works.
 *
 * Environment-level, never per project: a project selects a *scope* of this one
 * connection. The rows go inert wherever the settings scope is a project, where
 * this value can only be inherited.
 */
export function KnowledgeSettings() {
  const { t } = useI18n();
  const { scope, target } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const knowledge = settings.knowledge;
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const environmentId = target?.environmentId ?? null;
  // Sources ride along with the probe: the list is what a project's scope
  // picker is populated from, and SAG only pays for it once it is reachable.
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : knowledgeStatus({ environmentId, input: { includeSources: true } }),
  );
  const display = resolveKnowledgeDisplay({
    status: query.data,
    isPending: query.isPending,
    isError: query.error !== null,
  });
  const storedToken = knowledge.token === KNOWLEDGE_SAG_TOKEN_REDACTED;
  const disabled = projectScope || environmentId === null;

  return (
    <SettingsSection id="knowledge" title="Knowledge">
      <SettingsRow
        {...searchableSetting("knowledge-enabled")}
        serverScoped
        settingKeys={["knowledge"]}
        description="Let your agents search an external knowledge engine. Off by default."
        control={
          <ScopedSwitch
            settingKeys={["knowledge"]}
            checked={knowledge.enabled}
            disabled={disabled}
            aria-label={t("Knowledge")}
            onCheckedChange={(checked) =>
              updateSettings({ knowledge: { enabled: Boolean(checked) } })
            }
          />
        }
      />
      <SettingsRow
        {...searchableSetting("knowledge-endpoint")}
        serverScoped
        settingKeys={["knowledge"]}
        description="The knowledge server's MCP endpoint. A source in a pasted address is ignored."
        control={
          <DraftInput
            size="sm"
            className="w-full sm:w-64"
            aria-label={t("Knowledge endpoint")}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            placeholder={ENDPOINT_PLACEHOLDER}
            value={knowledge.endpoint}
            onCommit={(next) => updateSettings({ knowledge: { endpoint: next.trim() } })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("knowledge-token")}
        serverScoped
        settingKeys={["knowledge"]}
        description="Sent as a bearer token. Type a new one to replace the stored one."
        status={storedToken ? "A token is stored on this environment." : undefined}
        control={
          <div className="flex items-center gap-2">
            <DraftInput
              size="sm"
              className="w-full sm:w-64"
              aria-label={t("Knowledge token")}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              placeholder={storedToken ? KNOWLEDGE_SAG_TOKEN_REDACTED : t("Paste a token")}
              // Always empty: the stored token is never sent to a client, so the
              // field starts blank and carries only a newly typed value. Blurring
              // an untouched field writes nothing rather than clearing it, which
              // is what the Clear button is for.
              value=""
              onCommit={(next) => {
                const token = next.trim();
                if (token.length === 0) return;
                updateSettings({ knowledge: { token } });
              }}
            />
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={disabled || !storedToken}
              onClick={() => updateSettings({ knowledge: { token: "" } })}
            >
              {t("Clear")}
            </Button>
          </div>
        }
      />
      <SettingsRow
        {...searchableSetting("knowledge-status")}
        serverScoped
        settingKeys={["knowledge"]}
        description={t(display.message)}
        status={
          display.sources.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {display.sources.map((source) => (
                <span
                  key={source.sourceId}
                  className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  {source.displayName}
                </span>
              ))}
            </div>
          ) : undefined
        }
        control={
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={environmentId === null || query.isPending}
            onClick={() => query.refresh()}
          >
            {query.isPending ? t("Testing…") : t("Test connection")}
          </Button>
        }
      />
    </SettingsSection>
  );
}

/**
 * Which knowledge one project's threads may search.
 *
 * `knowledgeScope` is unlike the other project-scoped keys: it never exists on
 * the environment's own settings, only inside a project's override entry. So it
 * is read from that entry and written by replacing the entry whole - the same
 * per-entry rule the Actions section follows - rather than through the scoped
 * settings key helpers, which only carry keys that exist at both scopes.
 */
export function ProjectKnowledgeSettings() {
  const { t } = useI18n();
  const { scope, targets, target, environments } = useSettingsScope();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "knowledge scope update");
  const projectId = target?.projectId ?? null;
  const environmentId = target?.environmentId ?? null;
  const memberEnvironments = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig !== null &&
      environment.serverConfig.environment?.capabilities.projectSettingsOverrides === true,
  );

  const scopeOf = (member: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId | null;
  }): KnowledgeScope => {
    if (member.projectId === null) return KNOWLEDGE_SCOPE_NONE;
    const settings = memberEnvironments.find(
      (environment) => environment.environmentId === member.environmentId,
    )?.serverConfig?.settings;
    return settings === undefined
      ? KNOWLEDGE_SCOPE_NONE
      : knowledgeScopeOrNone(
          resolveProjectSettings(settings, member.projectId).overrides.knowledgeScope,
        );
  };

  const currentScope = target === null ? KNOWLEDGE_SCOPE_NONE : scopeOf(target);
  // A group spanning several checkouts can hold a different scope per member;
  // the row shows one of them and says so rather than lying about the other.
  const mixed = targets.some(
    (member) => JSON.stringify(scopeOf(member)) !== JSON.stringify(currentScope),
  );

  // Populated from the environment-level probe: a call scoped to this project's
  // own source reports only that one source, which would leave the picker unable
  // to offer any other choice.
  const sourceQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : knowledgeStatus({ environmentId, input: { includeSources: true } }),
  );
  const choices = knowledgeSourceChoices(sourceQuery.data?.sources ?? [], currentScope);
  // The diagnostic comes from the project's own scope: that is the only call
  // that can answer `source-not-found` for the source this project selects.
  const projectQuery = useEnvironmentQuery(
    environmentId === null || projectId === null
      ? null
      : knowledgeStatus({ environmentId, input: { projectId, includeSources: false } }),
  );
  const statusText = projectKnowledgeStatusText({
    status: projectQuery.data,
    isPending: projectQuery.isPending,
  });
  // One row speaks for every checkout in the group, so a disagreement between
  // them is named rather than hidden behind one member's answer.
  const statusLines = [
    ...(mixed
      ? ["This project's checkouts disagree; saving applies the choice to all of them."]
      : []),
    ...(statusText === null ? [] : [statusText]),
  ];

  const writeScope = (next: KnowledgeScope) => {
    for (const member of targets) {
      if (member.projectId === null) continue;
      const settings = memberEnvironments.find(
        (candidate) => candidate.environmentId === member.environmentId,
      )?.serverConfig?.settings;
      if (settings === undefined) continue;
      void updateSettings({
        environmentId: member.environmentId,
        input: {
          patch: {
            projectSettingsOverrides: {
              [member.projectId]: {
                ...settings.projectSettingsOverrides[member.projectId],
                knowledgeScope: next,
              },
            },
          },
        },
      });
    }
    // The answer belongs to the scope that was just written, not the one before.
    projectQuery.refresh();
  };

  return (
    <SettingsSection title="Knowledge">
      <SettingsRow
        {...searchableSetting("knowledge-scope")}
        description="Which knowledge this project's threads may search. Nothing is searched until you choose."
        status={statusLines.length > 0 ? statusLines.join(" ") : undefined}
        control={
          <Select
            value={knowledgeScopeSelectValue(currentScope)}
            disabled={
              (scope.kind !== "project" && scope.kind !== "checkout") ||
              projectId === null ||
              memberEnvironments.length === 0
            }
            onValueChange={(value) => {
              if (value === null) return;
              const next = knowledgeScopeFromSelectValue(value, choices);
              // A value naming a source that is no longer an option changes
              // nothing at all - least of all into `all`, which would silently
              // widen what this project searches.
              if (next !== null) writeScope(next);
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full min-w-0 sm:w-52"
              aria-label={t("Knowledge scope")}
            >
              <SelectValue>{t(knowledgeScopeLabel(currentScope) ?? "None")}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false} className="min-w-52">
              <SelectItem value="none" hideIndicator>
                {t("None")}
              </SelectItem>
              <SelectItem value="all" hideIndicator>
                {t("All Sources")}
              </SelectItem>
              {choices.map((source) => (
                <SelectItem
                  key={source.sourceId}
                  value={knowledgeScopeSelectValue({ mode: "source", sourceId: source.sourceId })}
                  hideIndicator
                >
                  {source.displayName}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
