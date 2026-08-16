/** End-user impact: who actually felt the failures. */

export interface ImpactedUser {
  org: string;
  user: string;
  plan: "Free" | "Pro" | "Scale";
  reqs7d: number;
  failures7d: number;
  slow7d: number;
  lastFailure?: { label: string; traceId?: string; href?: string; when: string };
  risk: "at-risk" | "degraded" | "healthy";
}

export const impactedUsers: ImpactedUser[] = [
  {
    org: "Meridian Labs",
    user: "ops@meridianlabs.io",
    plan: "Scale",
    reqs7d: 9800,
    failures7d: 41,
    slow7d: 12,
    lastFailure: { label: "504 · bulk import (INC-42)", traceId: "c9d4e71f3a2b8c56", when: "34m ago" },
    risk: "at-risk",
  },
  {
    org: "Meridian Labs",
    user: "sara@meridianlabs.io",
    plan: "Scale",
    reqs7d: 610,
    failures7d: 1,
    slow7d: 0,
    lastFailure: { label: "502 · reply truncated (OOM)", traceId: "a3f8c1d92b6e407f", when: "17m ago" },
    risk: "degraded",
  },
  {
    org: "Atlas Support",
    user: "help@atlassupport.co",
    plan: "Pro",
    reqs7d: 2100,
    failures7d: 0,
    slow7d: 9,
    lastFailure: { label: "16.4s reply · kb fallback", traceId: "b7e2d94a1c8f5e30", when: "42m ago" },
    risk: "degraded",
  },
  {
    org: "Nimbus Retail",
    user: "team@nimbusretail.com",
    plan: "Pro",
    reqs7d: 1700,
    failures7d: 0,
    slow7d: 1,
    lastFailure: undefined,
    risk: "healthy",
  },
  {
    org: "Kite Commerce",
    user: "support@kitecommerce.dev",
    plan: "Scale",
    reqs7d: 6400,
    failures7d: 2,
    slow7d: 3,
    lastFailure: { label: "500 · pg pool exhausted", href: "/app/traces?q=pool&status=error", when: "3h ago" },
    risk: "degraded",
  },
  {
    org: "Brightline AI",
    user: "founders@brightline.ai",
    plan: "Free",
    reqs7d: 900,
    failures7d: 0,
    slow7d: 0,
    risk: "healthy",
  },
];
