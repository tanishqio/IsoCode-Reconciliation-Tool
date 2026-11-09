import { api, setCsrfToken } from "../../lib/api-client";
import type { Role } from "../../lib/roles";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

interface SessionResponse {
  user: AuthUser;
  csrfToken: string;
}

/** The query key under which the signed-in user is cached. */
export const ME_KEY = ["auth", "me"] as const;

/** How long the cached "who am I" answer is trusted before it is asked again. */
export const ME_STALE_MS = 5 * 60_000;

// A 401 here means "not signed in", which callers handle themselves (a redirect to the sign-in
// page), so the global "session ended" redirect is switched off for these calls.

/** Who is signed in. Also learns the CSRF token for this session. Rejects with a 401 ApiError if nobody is. */
export async function fetchMe(signal?: AbortSignal): Promise<AuthUser> {
  const response = await api.get<SessionResponse>("/auth/me", { signal, redirectOn401: false });
  setCsrfToken(response.csrfToken);
  return response.user;
}

export async function signIn(email: string, password: string): Promise<AuthUser> {
  const response = await api.post<SessionResponse>(
    "/auth/login",
    { email, password },
    { redirectOn401: false },
  );
  setCsrfToken(response.csrfToken);
  return response.user;
}

export async function signOut(): Promise<void> {
  await api.post("/auth/logout", undefined, { redirectOn401: false });
}
