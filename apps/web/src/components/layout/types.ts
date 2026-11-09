// Same two roles as the database enum. Written out here so the shell does not depend on
// another module; any `Role` from lib/roles.ts is assignable to this type.
export type ShellRole = "FINANCE_EXECUTIVE" | "CO_FOUNDER";

export interface ShellUser {
  name: string;
  role: ShellRole;
}

export const ROLE_LABELS: Record<ShellRole, string> = {
  FINANCE_EXECUTIVE: "Finance executive",
  CO_FOUNDER: "Co-founder",
};

/** Optional count badges by nav path, for example { "/review": 12 }. Zero or missing shows nothing. */
export type NavCounts = Readonly<Partial<Record<string, number>>>;
