import { QueryClient } from "@tanstack/react-query";
import { isApiError } from "./api-error";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // Do not retry a request the server understood and refused (400 to 499).
        // Retry network failures and server errors twice.
        retry: (failureCount, error) => {
          if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
          return failureCount < 2;
        },
      },
      // Never repeat a write automatically.
      mutations: { retry: false },
    },
  });
}

// The one client the whole app shares. The route loaders (which run before a page renders and
// outside React) and the components must read the same cache, so both use this instance.
export const queryClient = createQueryClient();
