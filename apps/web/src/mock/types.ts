// `ConnectorCategory` / `ConnectStep` / `Connector` moved to
// `@/components/connections/connectors` (D204) — one card definition for both
// modes. Only the demo-source shape below is mock data.
export interface ConnectedSource {
  connectorSlug: string;
  name: string;
  status: "healthy" | "degraded" | "silent";
  lastEvent: string;
  ratePerMin: number;
  errorCount: number;
}
