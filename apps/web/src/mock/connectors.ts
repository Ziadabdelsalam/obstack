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
  // R2 must-fix 2. This row was `connectorSlug: "vercel"`, and the connections
  // wall rendered it under CONNECTED while the catalog listed Vercel as
  // coming-soon 350px lower on the same screen — a contradiction the landing
  // page then shipped as a screenshot. D208's line is that demo DATA is
  // allowed and a false CAPABILITY claim is not, and a source connected
  // through a connector that does not exist yet is the second thing. Docker is
  // one of the three the product actually ships, so the row keeps its job —
  // demonstrating the degraded state with its error counter — through a
  // connector a reader could go and use.
  {
    connectorSlug: "docker",
    name: "loopwork-web (docker, staging)",
    status: "degraded",
    lastEvent: "4m ago",
    ratePerMin: 86,
    errorCount: 12,
  },
];
