import { createBrowserRouter } from "react-router-dom";
import { loginUrlFor } from "../features/auth/auth-paths";
import { setCsrfToken, setUnauthorizedHandler } from "../lib/api-client";
import { queryClient } from "../lib/query-client";
import { createRoutes } from "./routes";

export const router = createBrowserRouter(createRoutes(queryClient));

// When any API call gets a 401 (the session ended or was never there), forget everything held for
// the signed-in user and go to the sign-in page, remembering where the person was.
setUnauthorizedHandler(() => {
  setCsrfToken(null);
  queryClient.removeQueries();
  const { pathname, search } = router.state.location;
  if (pathname !== "/login") {
    void router.navigate(loginUrlFor(pathname + search), { replace: true });
  }
});
