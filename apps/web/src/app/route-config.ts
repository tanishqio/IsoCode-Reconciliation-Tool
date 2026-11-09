import type { Role } from "../lib/roles";

// Routes from docs/diagrams/02-website-map.mmd. `roles` says who may open the page.
// Hiding a page is only a convenience; the API enforces access (Part 1).
// The sidebar list is in components/layout/nav-items.ts; a test checks the two agree.
export interface RouteDef {
  path: string;
  title: string;
  roles: readonly Role[];
}

const BOTH: readonly Role[] = ["FINANCE_EXECUTIVE", "CO_FOUNDER"];
const EXECUTIVE: readonly Role[] = ["FINANCE_EXECUTIVE"];

export const ROUTE_DEFS: readonly RouteDef[] = [
  { path: "uploads", title: "Uploads", roles: EXECUTIVE },
  { path: "sources/:sourceId/mapping", title: "Mapping review", roles: EXECUTIVE },
  { path: "orders", title: "Orders", roles: BOTH },
  { path: "review", title: "Review queue", roles: EXECUTIVE },
  { path: "rate-cards", title: "Rate cards", roles: BOTH },
  { path: "claims", title: "Claims", roles: BOTH },
  { path: "dashboard", title: "Money at risk", roles: BOTH },
];

/** Where "/" sends the user. The role-based landing page (executive: uploads, co-founder: dashboard) comes with login. */
export const DEFAULT_LANDING_PATH = "/uploads";
