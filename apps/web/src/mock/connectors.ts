import type { ConnectedSource } from "./types";

// Demo rows only (D204/D208): the connector cards, categories and connect steps
// are ONE definition for both modes and live in
// `@/components/connections/connectors`. These three sources are fabricated
// sample data, rendered in mock mode alone.
export const connectedSources: ConnectedSource[] = [
  {
    connectorSlug: "kubernetes",
    name: "prod-cluster (GKE, 14 nodes)",
    status: "healthy",
    lastEvent: "2s ago",
    ratePerMin: 8420,
    errorCount: 0,
  },
  {
    connectorSlug: "otlp",
    name: "agent-worker · obstack-py",
    status: "healthy",
    lastEvent: "1s ago",
    ratePerMin: 1130,
    errorCount: 0,
  },
  {
    connectorSlug: "vercel",
    name: "loopwork-web (production)",
    status: "degraded",
    lastEvent: "4m ago",
    ratePerMin: 86,
    errorCount: 12,
  },
];
