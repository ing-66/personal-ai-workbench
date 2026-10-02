import { createFileRoute } from "@tanstack/react-router";

import { ModelGatewaySettingsPanel } from "../components/settings/ModelGatewaySettings";

export const Route = createFileRoute("/settings/model-gateway")({
  component: ModelGatewaySettingsPanel,
});
