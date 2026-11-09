import type { QueryClient } from "@tanstack/react-query";
import { redirect, type LoaderFunctionArgs } from "react-router-dom";
import { isApiError } from "../../lib/api-error";
import type { Role } from "../../lib/roles";
import { fetchMe, ME_KEY, ME_STALE_MS, type AuthUser } from "./auth-api";
import { landingPathFor, loginUrlFor, safeNextPath } from "./auth-paths";

const requestedPath = (request: Request): string => {
  const url = new URL(request.url);
  return url.pathname + url.search;
};

/**
 * Route loaders for sign-in and roles. A loader runs before its page is drawn, so a signed-out
 * person never sees a flash of the page. These only decide what the person sees; the API checks
 * the session and the role on every request, and is what actually protects the data.
 */
export function createAuthLoaders(queryClient: QueryClient) {
  /** The signed-in user, or null if nobody is signed in. Other failures (network, server) are thrown. */
  async function getUser(): Promise<AuthUser | null> {
    try {
      return await queryClient.fetchQuery({
        queryKey: ME_KEY,
        queryFn: ({ signal }) => fetchMe(signal),
        staleTime: ME_STALE_MS,
        // This runs before a page is drawn. Retrying a network failure would leave a blank
        // screen for seconds, so report the problem straight away instead.
        retry: false,
      });
    } catch (error) {
      if (isApiError(error) && error.status === 401) return null;
      throw error;
    }
  }

  /** For the layout every signed-in page sits in: signed out means go to sign-in. */
  async function requireUser({ request }: LoaderFunctionArgs): Promise<AuthUser> {
    const user = await getUser();
    if (!user) throw redirect(loginUrlFor(requestedPath(request)));
    return user;
  }

  /** For one page: signed out means sign-in; the wrong role means a 403 page. */
  function requireRole(roles: readonly Role[]) {
    return async ({ request }: LoaderFunctionArgs): Promise<AuthUser> => {
      const user = await getUser();
      if (!user) throw redirect(loginUrlFor(requestedPath(request)));
      if (!roles.includes(user.role)) {
        throw new Response(null, { status: 403, statusText: "Forbidden" });
      }
      return user;
    };
  }

  /** For "/": send each role to its own first page. */
  async function landing(): Promise<never> {
    const user = await getUser();
    throw redirect(user ? landingPathFor(user.role) : "/login");
  }

  /** For the sign-in page: someone already signed in goes on to their page instead. */
  async function redirectIfSignedIn({ request }: LoaderFunctionArgs): Promise<null> {
    // If the check itself fails (network, server), still show the form. Signing in will
    // report the real problem.
    const user = await getUser().catch(() => null);
    if (user) {
      const next = safeNextPath(new URL(request.url).searchParams.get("next"));
      throw redirect(next ?? landingPathFor(user.role));
    }
    return null;
  }

  return { getUser, requireUser, requireRole, landing, redirectIfSignedIn };
}

export type AuthLoaders = ReturnType<typeof createAuthLoaders>;
