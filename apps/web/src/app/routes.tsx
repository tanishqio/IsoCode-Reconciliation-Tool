import type { QueryClient } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { RouteObject } from "react-router-dom";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { ClaimsPage } from "../features/claims/ClaimsPage";
import { ReviewPage } from "../features/review/ReviewPage";
import { OrdersPage } from "../features/orders/OrdersPage";
import { MappingPage } from "../features/mapping/MappingPage";
import { createAuthLoaders } from "../features/auth/auth-loaders";
import { LoginPage } from "../features/auth/LoginPage";
import { RateCardsPage } from "../features/rate-cards/RateCardsPage";
import { UploadsPage } from "../features/uploads/UploadsPage";
import { AppLayout } from "./AppLayout";
import { NotFoundPage } from "./NotFoundPage";
import { PlaceholderPage } from "./PlaceholderPage";
import { RouteError } from "./RouteError";
import { ROUTE_DEFS, type RouteDef } from "./route-config";

// Pages that are built. Every other route in ROUTE_DEFS shows a placeholder for now.
const BUILT_PAGES: Record<string, () => ReactElement> = {
  uploads: () => <UploadsPage />,
  orders: () => <OrdersPage />,
  review: () => <ReviewPage />,
  claims: () => <ClaimsPage />,
  "sources/:sourceId/mapping": () => <MappingPage />,
  "rate-cards": () => <RateCardsPage />,
  dashboard: () => <DashboardPage />,
};

const pageFor = (route: RouteDef): ReactElement =>
  BUILT_PAGES[route.path]?.() ?? <PlaceholderPage title={route.title} />;

/**
 * The route tree. It takes the query client so the loaders can ask "who is signed in?" and the
 * answer is shared with the components. Kept separate from router.tsx so tests can render it
 * without a browser.
 */
export function createRoutes(queryClient: QueryClient): RouteObject[] {
  const auth = createAuthLoaders(queryClient);

  return [
    {
      path: "/login",
      loader: auth.redirectIfSignedIn,
      element: <LoginPage />,
      errorElement: <RouteError />,
    },
    {
      // Every signed-in page sits inside the app shell. Signed out means: go to sign-in.
      loader: auth.requireUser,
      element: <AppLayout />,
      errorElement: <RouteError />,
      children: [
        {
          // Errors in a page (including "your role cannot open this") show inside the shell.
          errorElement: <RouteError inShell />,
          children: [
            { index: true, loader: auth.landing },
            ...ROUTE_DEFS.map((route): RouteObject => ({
              path: route.path,
              loader: auth.requireRole(route.roles),
              element: pageFor(route),
            })),
            { path: "*", element: <NotFoundPage /> },
          ],
        },
      ],
    },
  ];
}
