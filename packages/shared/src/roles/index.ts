// The two roles in the assignment ("finance executive and co-founder"). They match the Role enum
// in the database (apps/api/prisma/schema.prisma). Add a role in both places.
export const ROLES = ["FINANCE_EXECUTIVE", "CO_FOUNDER"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  FINANCE_EXECUTIVE: "Finance executive",
  CO_FOUNDER: "Co-founder",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
