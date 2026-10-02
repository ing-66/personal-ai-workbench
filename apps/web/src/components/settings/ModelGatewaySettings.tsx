"use client";

import { useMemo, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon, TriangleAlertIcon, XIcon } from "lucide-react";
import {
  type EnvironmentId,
  MODEL_GATEWAY_CREDENTIAL_REDACTED,
  type ModelGatewayProvider,
  type ModelGatewayRoute,
  type ModelGatewaySettings,
  type ModelGatewayStatus,
  type ModelGatewayUsageDimension,
  type UsageModelPriceOverride,
} from "@t3tools/contracts";

import { modelGatewayStatus, modelGatewayUsage } from "../../state/modelGateway";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  MODEL_GATEWAY_USAGE_HOURS,
  appendModelGatewayBackup,
  blankModelGatewayProvider,
  blankModelGatewayRoute,
  estimateModelGatewayUsageCostUsd,
  formatModelGatewayCostUsd,
  formatModelGatewayCount,
  formatModelGatewayPercent,
  modelGatewayProviderChoices,
  modelGatewayProviderHasCredential,
  modelGatewayProviderHealthText,
  modelGatewayProtocolChoices,
  modelGatewayProtocolLabel,
  modelGatewayRouteDisplay,
  modelGatewayRouteStatusText,
  modelGatewaySettingsPatch,
  modelGatewaySuccessRate,
  modelGatewayUsageDimensionLabel,
  modelGatewayUsageGroupLabel,
  modelGatewayUsageSummaryRows,
  moveModelGatewayEntry,
  readModelGatewaySettings,
  resolveModelGatewayDisplay,
  uniqueModelGatewayId,
} from "./modelGatewaySettings.logic";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { useI18n } from "../../i18n";

const USAGE_DIMENSIONS: ReadonlyArray<ModelGatewayUsageDimension> = [
  "route",
  "provider",
  "model",
  "protocol",
];

const NAME_WIDTH = "w-full sm:w-56";
const URL_WIDTH = "w-full sm:w-72";

/**
 * The model gateway: what answers, and which upstream a harness is sent to.
 *
 * Environment-level, never per project: a harness instance is *who works*, and the
 * gateway decides *which upstream API answers*. Choosing a route for a harness lives
 * on that harness's own card in Providers, not here - this section only defines what
 * routes exist to choose from.
 */
export function ModelGatewaySettingsPanel() {
  const { t } = useI18n();
  const { target } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gateway = readModelGatewaySettings(settings);
  const environmentId = target?.environmentId ?? null;
  const disabled = environmentId === null;

  const statusQuery = useEnvironmentQuery(
    environmentId === null ? null : modelGatewayStatus({ environmentId, input: {} }),
  );
  const status: ModelGatewayStatus | null = statusQuery.data ?? null;
  const display = resolveModelGatewayDisplay({
    status,
    isPending: statusQuery.isPending,
    isError: statusQuery.error !== null,
  });

  const providers = gateway.providers;
  const routes = gateway.routes;
  const providerList = Object.values(providers);
  const routeList = Object.values(routes);
  const providerNames = useMemo(
    () => Object.fromEntries(providerList.map((provider) => [provider.id, provider.name])),
    [providerList],
  );
  const routeNames = useMemo(
    () => Object.fromEntries(routeList.map((route) => [route.id, route.name])),
    [routeList],
  );

  const writeGateway = (patch: Partial<ModelGatewaySettings>) =>
    updateSettings(modelGatewaySettingsPatch(patch));
  const writeProviders = (next: ModelGatewaySettings["providers"]) =>
    writeGateway({ providers: next });
  const writeRoutes = (next: ModelGatewaySettings["routes"]) => writeGateway({ routes: next });

  const updateProvider = (
    id: ModelGatewayProvider["id"],
    recipe: (provider: ModelGatewayProvider) => ModelGatewayProvider,
  ) => {
    const current = providers[id];
    if (current === undefined) return;
    writeProviders({ ...providers, [id]: recipe(current) });
  };
  const removeProvider = (id: ModelGatewayProvider["id"]) => {
    const next = { ...providers };
    delete next[id];
    writeProviders(next);
  };
  const updateRoute = (
    id: ModelGatewayRoute["id"],
    recipe: (route: ModelGatewayRoute) => ModelGatewayRoute,
  ) => {
    const current = routes[id];
    if (current === undefined) return;
    writeRoutes({ ...routes, [id]: recipe(current) });
  };
  const removeRoute = (id: ModelGatewayRoute["id"]) => {
    const next = { ...routes };
    delete next[id];
    writeRoutes(next);
  };

  const addProvider = () => {
    const id = uniqueModelGatewayId("provider", Object.keys(providers));
    writeProviders({ ...providers, [id]: blankModelGatewayProvider(id) });
  };
  const addRoute = () => {
    const primary = providerList[0];
    if (primary === undefined) return;
    const id = uniqueModelGatewayId("route", Object.keys(routes));
    writeRoutes({ ...routes, [id]: blankModelGatewayRoute(id, primary.id) });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection id="model-gateway" title="Gateway">
        <SettingsRow
          {...searchableSetting("model-gateway-enabled")}
          serverScoped
          description="Send this environment's harness requests through a local gateway, so upstreams can be changed without touching a harness. Off by default."
          control={
            <Switch
              checked={gateway.enabled}
              disabled={disabled}
              aria-label={t("Model gateway")}
              onCheckedChange={(checked) => writeGateway({ enabled: Boolean(checked) })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("model-gateway-status")}
          serverScoped
          title="Status"
          description={t(display.message)}
          status={
            <span className="text-xs text-muted-foreground">
              {t(display.lifecycleLabel)}
              {display.endpoint === null ? null : (
                <>
                  {" at "}
                  <code className="text-foreground">{display.endpoint}</code>
                </>
              )}
            </span>
          }
          control={
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={environmentId === null || statusQuery.isPending}
              onClick={() => statusQuery.refresh()}
            >
              {statusQuery.isPending ? t("Refreshing…") : t("Refresh")}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection
        {...searchableSetting("model-gateway-providers")}
        title="Providers"
        variant="plain"
        headerAction={
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={disabled}
            onClick={addProvider}
          >
            {t("Add provider")}
          </Button>
        }
      >
        {providerList.length === 0 ? (
          <SettingsRow
            title="No providers yet"
            description="A provider is one upstream API: a base URL, a protocol, and a key."
          />
        ) : null}
        {providerList.map((provider) => (
          <GatewayProviderSection
            key={provider.id}
            provider={provider}
            status={status}
            disabled={disabled}
            onChange={(recipe) => updateProvider(provider.id, recipe)}
            onRemove={() => removeProvider(provider.id)}
          />
        ))}
      </SettingsSection>

      <SettingsSection
        {...searchableSetting("model-gateway-routes")}
        title="Routes"
        variant="plain"
        headerAction={
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={disabled || providerList.length === 0}
            onClick={addRoute}
          >
            {t("Add route")}
          </Button>
        }
      >
        {providerList.length === 0 ? (
          <SettingsRow
            title="Routes need a provider"
            description="Add a provider first; a route sends requests to the providers on it."
          />
        ) : null}
        {routeList.map((route) => (
          <GatewayRouteSection
            key={route.id}
            route={route}
            providers={providers}
            status={status}
            disabled={disabled}
            onChange={(recipe) => updateRoute(route.id, recipe)}
            onRemove={() => removeRoute(route.id)}
          />
        ))}
      </SettingsSection>

      <GatewayUsageSection
        environmentId={environmentId}
        providers={providerNames}
        routes={routeNames}
        retentionDays={gateway.usageRetentionDays}
        priceOverrides={settings.usagePriceOverrides}
      />
    </SettingsPageContainer>
  );
}

function GatewayProviderSection({
  provider,
  status,
  disabled,
  onChange,
  onRemove,
}: {
  readonly provider: ModelGatewayProvider;
  readonly status: ModelGatewayStatus | null;
  readonly disabled: boolean;
  readonly onChange: (recipe: (provider: ModelGatewayProvider) => ModelGatewayProvider) => void;
  readonly onRemove: () => void;
}) {
  const health = status?.health.find((entry) => entry.providerId === provider.id) ?? null;
  const healthText = modelGatewayProviderHealthText(health, Date.now());
  const hasCredential = modelGatewayProviderHasCredential(provider, status);

  return (
    <SettingsSection
      id={`model-gateway-provider-${provider.id}`}
      title={provider.name}
      headerAction={
        <Button
          size="icon-xs"
          variant="ghost"
          type="button"
          disabled={disabled}
          aria-label={`Delete provider ${provider.name}`}
          onClick={onRemove}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      }
    >
      <SettingsRow
        title="Name"
        description={
          healthText === null
            ? "Shown on routes and usage rows."
            : `Shown on routes and usage rows. Live state: ${healthText}`
        }
        control={
          <DraftInput
            size="sm"
            className={NAME_WIDTH}
            aria-label="Provider name"
            disabled={disabled}
            value={provider.name}
            onCommit={(next) => {
              const name = next.trim();
              if (name.length === 0) return;
              onChange((current) => ({ ...current, name: name as ModelGatewayProvider["name"] }));
            }}
          />
        }
      />
      <SettingsRow
        title="Protocol"
        description="What this upstream speaks. A route may only carry providers that agree."
        control={
          <Select
            value={provider.protocol}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === null) return;
              const next = modelGatewayProtocolChoices().find((choice) => choice.value === value);
              if (next === undefined) return;
              onChange((current) => ({ ...current, protocol: next.value }));
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Provider protocol">
              <SelectValue>{modelGatewayProtocolLabel(provider.protocol)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false} className="min-w-56">
              {modelGatewayProtocolChoices().map((choice) => (
                <SelectItem key={choice.value} value={choice.value} hideIndicator>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Base URL"
        description="The origin (with any path prefix). The request path carries the API segment."
        control={
          <DraftInput
            size="sm"
            className={URL_WIDTH}
            aria-label="Provider base URL"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            placeholder="https://api.example.com"
            value={provider.baseUrl}
            onCommit={(next) => onChange((current) => ({ ...current, baseUrl: next.trim() }))}
          />
        }
      />
      <SettingsRow
        title="API key"
        description="Sent to this upstream only, and never shown again once stored."
        status={hasCredential ? "A key is stored on this environment." : undefined}
        control={
          <div className="flex items-center gap-2">
            <DraftInput
              size="sm"
              className={URL_WIDTH}
              aria-label="Provider API key"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              placeholder={hasCredential ? MODEL_GATEWAY_CREDENTIAL_REDACTED : "Paste a key"}
              // Always empty: the stored key is never sent to a client, so the field
              // starts blank and carries only a newly typed value. Blurring untouched
              // writes nothing; Clear is what removes the stored key.
              value=""
              onCommit={(next) => {
                const apiKey = next.trim();
                if (apiKey.length === 0) return;
                onChange((current) => ({ ...current, apiKey }));
              }}
            />
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={disabled || !hasCredential}
              onClick={() => onChange((current) => ({ ...current, apiKey: "" }))}
            >
              Clear
            </Button>
          </div>
        }
      />
      <SettingsRow
        title="Default model"
        description="Optional. Used only when a request names no model and the route maps none."
        control={
          <DraftInput
            size="sm"
            className={NAME_WIDTH}
            aria-label="Provider default model"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            value={provider.defaultModel}
            onCommit={(next) => onChange((current) => ({ ...current, defaultModel: next.trim() }))}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("model-gateway-provider-enabled")}
        title="Enabled"
        description="A disabled provider is left off every route that names it."
        control={
          <Switch
            checked={provider.enabled}
            disabled={disabled}
            aria-label="Provider enabled"
            onCheckedChange={(checked) =>
              onChange((current) => ({ ...current, enabled: Boolean(checked) }))
            }
          />
        }
      />
    </SettingsSection>
  );
}

function GatewayRouteSection({
  route,
  providers,
  status,
  disabled,
  onChange,
  onRemove,
}: {
  readonly route: ModelGatewayRoute;
  readonly providers: ModelGatewaySettings["providers"];
  readonly status: ModelGatewayStatus | null;
  readonly disabled: boolean;
  readonly onChange: (recipe: (route: ModelGatewayRoute) => ModelGatewayRoute) => void;
  readonly onRemove: () => void;
}) {
  const [draftRequested, setDraftRequested] = useState("");
  const [draftUpstream, setDraftUpstream] = useState("");
  const reported = status?.routes.find((entry) => entry.id === route.id)?.problems ?? [];
  const display = modelGatewayRouteDisplay(route, providers, reported);
  const offText = modelGatewayRouteStatusText(route);
  const choices = modelGatewayProviderChoices(providers);
  const primary = providers[route.primaryProviderId];
  const usedBackups = new Set<string>(route.backupProviderIds);
  const backupsAvailable = choices.some(
    (choice) => choice.id !== route.primaryProviderId && !usedBackups.has(choice.id),
  );
  const canAddMapping = draftRequested.trim().length > 0 && draftUpstream.trim().length > 0;

  return (
    <SettingsSection
      id={`model-gateway-route-${route.id}`}
      title={display.name}
      className={route.enabled ? undefined : "opacity-60"}
      headerAction={
        <div className="flex items-center gap-1.5">
          {display.flagged ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning">
              <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />
              Needs attention
            </span>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            type="button"
            disabled={disabled}
            aria-label={`Delete route ${display.name}`}
            onClick={onRemove}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      }
    >
      {display.flagged ? (
        <div
          role="status"
          className="flex items-start gap-2 px-3 py-2 text-[12px] leading-relaxed sm:px-4"
        >
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <ul className="min-w-0 list-disc space-y-0.5 ps-4 text-muted-foreground">
            {display.problemMessages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <SettingsRow
        title="Name"
        description={offText ?? `A request tries ${display.attemptChain}`}
        control={
          <DraftInput
            size="sm"
            className={NAME_WIDTH}
            aria-label="Route name"
            disabled={disabled}
            value={route.name}
            onCommit={(next) => {
              const name = next.trim();
              if (name.length === 0) return;
              onChange((current) => ({ ...current, name: name as ModelGatewayRoute["name"] }));
            }}
          />
        }
      />
      <SettingsRow
        title="Primary provider"
        description={
          primary === undefined
            ? "This route's primary provider no longer exists."
            : modelGatewayProtocolLabel(primary.protocol)
        }
        control={
          <Select
            value={route.primaryProviderId}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === null) return;
              onChange((current) => ({
                ...current,
                primaryProviderId: value as ModelGatewayRoute["primaryProviderId"],
              }));
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Route primary provider">
              <SelectValue>{primary?.name ?? route.primaryProviderId}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false} className="min-w-56">
              {choices.map((choice) => (
                <SelectItem key={choice.id} value={choice.id} hideIndicator>
                  {choice.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Enabled"
        description="A route that is switched off is not carried at all: a harness naming it keeps its own provider settings."
        control={
          <Switch
            checked={route.enabled}
            disabled={disabled}
            aria-label="Route enabled"
            onCheckedChange={(checked) =>
              onChange((current) => ({ ...current, enabled: Boolean(checked) }))
            }
          />
        }
      />
      <SettingsRow
        {...searchableSetting("model-gateway-route-failover")}
        title="Failover"
        description="When on, a request that fails before its response starts moves to the next backup. Auth and malformed-request failures never fail over."
        control={
          <Switch
            checked={route.failoverEnabled}
            disabled={disabled}
            aria-label="Route failover"
            onCheckedChange={(checked) =>
              onChange((current) => ({ ...current, failoverEnabled: Boolean(checked) }))
            }
          />
        }
      />
      {route.backupProviderIds.map((backupId, index) => (
        <SettingsRow
          key={`${backupId}-${index}`}
          title={`Backup ${index + 1}`}
          description={
            providers[backupId] === undefined
              ? "This provider no longer exists."
              : (providers[backupId]?.name ?? backupId)
          }
          control={
            <div className="flex items-center gap-2">
              <Select
                value={backupId}
                disabled={disabled}
                onValueChange={(value) => {
                  if (value === null) return;
                  onChange((current) => ({
                    ...current,
                    backupProviderIds: current.backupProviderIds.map((id, position) =>
                      position === index
                        ? (value as ModelGatewayRoute["backupProviderIds"][number])
                        : id,
                    ),
                  }));
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-48"
                  aria-label={`Backup ${index + 1}`}
                >
                  <SelectValue>{providers[backupId]?.name ?? backupId}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false} className="min-w-48">
                  {choices.map((choice) => (
                    <SelectItem key={choice.id} value={choice.id} hideIndicator>
                      {choice.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                size="icon-xs"
                variant="ghost"
                type="button"
                disabled={disabled || index === 0}
                aria-label={`Move backup ${index + 1} earlier`}
                onClick={() =>
                  onChange((current) => ({
                    ...current,
                    backupProviderIds: moveModelGatewayEntry(current.backupProviderIds, index, -1),
                  }))
                }
              >
                <ArrowUpIcon className="size-3.5" />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                type="button"
                disabled={disabled || index === route.backupProviderIds.length - 1}
                aria-label={`Move backup ${index + 1} later`}
                onClick={() =>
                  onChange((current) => ({
                    ...current,
                    backupProviderIds: moveModelGatewayEntry(current.backupProviderIds, index, 1),
                  }))
                }
              >
                <ArrowDownIcon className="size-3.5" />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                type="button"
                disabled={disabled}
                aria-label={`Remove backup ${index + 1}`}
                onClick={() =>
                  onChange((current) => ({
                    ...current,
                    backupProviderIds: current.backupProviderIds.filter(
                      (_id, position) => position !== index,
                    ),
                  }))
                }
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          }
        />
      ))}
      <SettingsRow
        title="Add backup"
        description="Backups are tried in order after the primary. Each provider appears once."
        control={
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={disabled || !backupsAvailable}
            onClick={() =>
              onChange((current) => ({
                ...current,
                backupProviderIds: appendModelGatewayBackup(
                  current.backupProviderIds,
                  providers,
                  current.primaryProviderId,
                ),
              }))
            }
          >
            Add backup
          </Button>
        }
      />
      {Object.entries(route.modelMapping).map(([requested, upstream]) => (
        <SettingsRow
          key={requested}
          title="Model map"
          description={`Asks the upstream for ${upstream.length === 0 ? "nothing yet" : upstream}.`}
          control={
            <div className="flex items-center gap-2">
              <DraftInput
                size="sm"
                className="w-full sm:w-40"
                aria-label="Requested model"
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                value={requested}
                onCommit={(next) => {
                  const key = next.trim();
                  if (key.length === 0 || key === requested) return;
                  onChange((current) => {
                    const entries = Object.entries(current.modelMapping).map(([from, to]) =>
                      from === requested ? [key, to] : [from, to],
                    );
                    return { ...current, modelMapping: Object.fromEntries(entries) };
                  });
                }}
              />
              <DraftInput
                size="sm"
                className="w-full sm:w-40"
                aria-label="Upstream model"
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                value={upstream}
                onCommit={(next) =>
                  onChange((current) => ({
                    ...current,
                    modelMapping: { ...current.modelMapping, [requested]: next.trim() },
                  }))
                }
              />
              <Button
                size="icon-xs"
                variant="ghost"
                type="button"
                disabled={disabled}
                aria-label={`Remove model mapping ${requested}`}
                onClick={() =>
                  onChange((current) => {
                    const next = { ...current.modelMapping };
                    delete next[requested];
                    return { ...current, modelMapping: next };
                  })
                }
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          }
        />
      ))}
      <SettingsRow
        title="Add model mapping"
        description="Optional. A requested model name the upstream bills under a different name; anything unmapped passes through."
        control={
          <div className="flex items-center gap-2">
            <DraftInput
              size="sm"
              className="w-full sm:w-40"
              aria-label="Requested model to add"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              placeholder="requested"
              value={draftRequested}
              onCommit={setDraftRequested}
            />
            <DraftInput
              size="sm"
              className="w-full sm:w-40"
              aria-label="Upstream model to add"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              placeholder="upstream"
              value={draftUpstream}
              onCommit={setDraftUpstream}
            />
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={disabled || !canAddMapping}
              onClick={() => {
                const requested = draftRequested.trim();
                const upstream = draftUpstream.trim();
                setDraftRequested("");
                setDraftUpstream("");
                onChange((current) => ({
                  ...current,
                  modelMapping: { ...current.modelMapping, [requested]: upstream },
                }));
              }}
            >
              Add
            </Button>
          </div>
        }
      />
    </SettingsSection>
  );
}

function GatewayUsageSection({
  environmentId,
  providers,
  routes,
  retentionDays,
  priceOverrides,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly providers: Readonly<Record<string, string>>;
  readonly routes: Readonly<Record<string, string>>;
  readonly retentionDays: number;
  readonly priceOverrides: Readonly<Record<string, UsageModelPriceOverride>>;
}) {
  const { t } = useI18n();
  const [dimension, setDimension] = useState<ModelGatewayUsageDimension>("route");
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : modelGatewayUsage({
          environmentId,
          input: { sinceHours: MODEL_GATEWAY_USAGE_HOURS, groupBy: dimension },
        }),
  );
  const view = query.data ?? null;
  const estimate =
    view === null
      ? null
      : estimateModelGatewayUsageCostUsd({
          groups: view.groups,
          dimension,
          priceOverrides,
        });
  const summaryRows = view === null ? [] : modelGatewayUsageSummaryRows(view.totals);

  return (
    <SettingsSection
      {...searchableSetting("model-gateway-usage")}
      title="Usage"
      headerAction={
        <Select
          value={dimension}
          onValueChange={(value) => {
            if (value === null) return;
            const next = USAGE_DIMENSIONS.find((candidate) => candidate === value);
            if (next !== undefined) setDimension(next);
          }}
        >
          <SelectTrigger size="sm" className="w-36" aria-label={t("Group usage by")}>
            <SelectValue>{t(modelGatewayUsageDimensionLabel(dimension))}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false} className="min-w-36">
            {USAGE_DIMENSIONS.map((candidate) => (
              <SelectItem key={candidate} value={candidate} hideIndicator>
                {t(modelGatewayUsageDimensionLabel(candidate))}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    >
      {view === null ? (
        <SettingsRow
          title="Usage"
          description={
            query.isPending
              ? "Reading this environment's gateway usage."
              : query.error !== null
                ? "This environment did not answer, so usage is unknown."
                : "The gateway has not reported usage yet."
          }
        />
      ) : (
        <>
          {summaryRows.map((row) => (
            <SettingsRow
              key={row.id}
              title={row.label}
              description={
                row.id === "requests"
                  ? t("The last {hours} hours, grouped by {dimension}. Kept for {days} days.", {
                      hours: MODEL_GATEWAY_USAGE_HOURS,
                      dimension: t(modelGatewayUsageDimensionLabel(dimension)),
                      days: formatModelGatewayCount(retentionDays),
                    })
                  : undefined
              }
              control={
                <span className="text-sm text-foreground">
                  {row.id === "tokens"
                    ? t("{input} in / {output} out", {
                        input: formatModelGatewayCount(view.totals.inputTokens),
                        output: formatModelGatewayCount(view.totals.outputTokens),
                      })
                    : row.id === "success-rate"
                      ? t("{rate} of {requests}", {
                          rate: formatModelGatewayPercent(modelGatewaySuccessRate(view.totals)),
                          requests: formatModelGatewayCount(view.totals.requests),
                        })
                      : row.value}
                </span>
              }
            />
          ))}
          <SettingsRow
            title="Estimated cost"
            description={
              estimate === null
                ? "Not computable here: only the Model grouping can be priced, from this environment's usage price overrides."
                : `${formatModelGatewayCostUsd(estimate.usd)} from ${formatModelGatewayCount(estimate.pricedGroups)} of ${formatModelGatewayCount(estimate.totalGroups)} priced models.`
            }
            control={
              <span className="text-sm text-foreground">
                {estimate === null ? "-" : formatModelGatewayCostUsd(estimate.usd)}
              </span>
            }
          />
          {view.groups.length === 0 ? (
            <SettingsRow
              title="No requests"
              description={t("Nothing was routed through the gateway in the last {hours} hours.", {
                hours: MODEL_GATEWAY_USAGE_HOURS,
              })}
            />
          ) : (
            view.groups.map((group) => (
              <SettingsRow
                key={group.key}
                title={modelGatewayUsageGroupLabel({
                  dimension,
                  key: group.key,
                  providerNames: providers,
                  routeNames: routes,
                })}
                description={`${formatModelGatewayCount(group.summary.requests)} requests \u00b7 ${formatModelGatewayCount(group.summary.inputTokens)} in / ${formatModelGatewayCount(group.summary.outputTokens)} out`}
                control={
                  <span className="text-sm text-muted-foreground">
                    {formatModelGatewayPercent(modelGatewaySuccessRate(group.summary))}
                  </span>
                }
              />
            ))
          )}
        </>
      )}
    </SettingsSection>
  );
}
