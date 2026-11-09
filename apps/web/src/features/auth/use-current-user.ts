import { useQuery } from "@tanstack/react-query";
import { fetchMe, ME_KEY, ME_STALE_MS, type AuthUser } from "./auth-api";

/**
 * The signed-in user. Inside the app layout it is already in the cache, because the route
 * loader fetched it before the page was drawn, so this answers straight away.
 */
export function useCurrentUser(): AuthUser | undefined {
  const { data } = useQuery({
    queryKey: ME_KEY,
    queryFn: ({ signal }) => fetchMe(signal),
    staleTime: ME_STALE_MS,
  });
  return data;
}
