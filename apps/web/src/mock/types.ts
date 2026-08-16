export type ConnectorCategory =
  | "Cloud"
  | "PaaS"
  | "Containers & K8s"
  | "Databases"
  | "LLM & AI"
  | "Queues & Events"
  | "CI/CD";

export interface ConnectStep {
  title: string;
  body?: string;
  snippet?: string;
}

export interface Connector {
  slug: string;
  name: string;
  category: ConnectorCategory;
  status: "available" | "coming-soon";
  blurb: string;
  /** two-letter mark rendered in mono */
  mark: string;
  markColor: string; // css color token value
  connectSteps?: ConnectStep[];
}

export interface ConnectedSource {
  connectorSlug: string;
  name: string;
  status: "healthy" | "degraded" | "silent";
  lastEvent: string;
  ratePerMin: number;
  errorCount: number;
}
