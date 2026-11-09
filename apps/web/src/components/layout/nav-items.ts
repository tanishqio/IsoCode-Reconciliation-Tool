import {
  FileText,
  IndianRupee,
  ListChecks,
  Package,
  TrendingDown,
  Upload,
  type LucideIcon,
} from "lucide-react";
import type { ShellRole } from "./types";

// The one list the sidebar and the mobile menu are built from.
// Hiding a link is only a convenience; the API enforces access.
// Routes and roles follow docs/diagrams/02-website-map.mmd.

export type NavGroupId = "reconcile" | "money";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  roles: readonly ShellRole[];
  group: NavGroupId;
}

const BOTH: readonly ShellRole[] = ["FINANCE_EXECUTIVE", "CO_FOUNDER"];
const EXECUTIVE: readonly ShellRole[] = ["FINANCE_EXECUTIVE"];

export const NAV_GROUPS: readonly { id: NavGroupId; label: string }[] = [
  { id: "reconcile", label: "Reconcile" },
  { id: "money", label: "Money" },
];

export const NAV_ITEMS: readonly NavItem[] = [
  { to: "/uploads", label: "Uploads", icon: Upload, roles: EXECUTIVE, group: "reconcile" },
  { to: "/orders", label: "Orders", icon: Package, roles: BOTH, group: "reconcile" },
  { to: "/review", label: "Review queue", icon: ListChecks, roles: EXECUTIVE, group: "reconcile" },
  { to: "/rate-cards", label: "Rate cards", icon: IndianRupee, roles: BOTH, group: "money" },
  { to: "/claims", label: "Claims", icon: FileText, roles: BOTH, group: "money" },
  { to: "/dashboard", label: "Money at risk", icon: TrendingDown, roles: BOTH, group: "money" },
];

export function navItemsForRole(role: ShellRole): NavItem[] {
  return NAV_ITEMS.filter((item) => item.roles.includes(role));
}

// Pages that are not in the sidebar but still need a name in the top bar on small screens.
const EXTRA_TITLES: readonly { prefix: string; title: string }[] = [
  { prefix: "/sources", title: "Mapping review" },
];

/** Name of the current page, for the top bar on small screens. */
export function getPageTitle(pathname: string): string {
  const inNav = NAV_ITEMS.find(
    (item) => pathname === item.to || pathname.startsWith(`${item.to}/`),
  );
  if (inNav) return inNav.label;
  const extra = EXTRA_TITLES.find(
    (entry) => pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`),
  );
  return extra?.title ?? "LeakLens";
}
