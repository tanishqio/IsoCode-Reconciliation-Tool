import type { Role } from "../../lib/roles";

/** Where a person starts after signing in: the executive works from Uploads, the co-founder from the dashboard. */
export function landingPathFor(role: Role): string {
  return role === "CO_FOUNDER" ? "/dashboard" : "/uploads";
}

/**
 * The "next" page to return to after signing in, or null if it is not safe to use.
 * Only a path inside this app is allowed. Anything else (another website, "//host", a backslash
 * trick, the sign-in page itself) is dropped, so a crafted link cannot send a person elsewhere.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  // Control characters, including line breaks, are never part of a real path.
  if ([...raw].some((character) => character.charCodeAt(0) < 32)) return null;
  const pathOnly = raw.split(/[?#]/)[0] ?? "";
  if (pathOnly === "/login" || pathOnly === "/") return null;
  return raw;
}

/** The sign-in URL to send a signed-out person to, remembering the page they asked for. */
export function loginUrlFor(requested: string): string {
  const next = safeNextPath(requested);
  return next ? `/login?next=${encodeURIComponent(next)}` : "/login";
}
