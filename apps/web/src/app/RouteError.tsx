import type { ReactNode } from "react";
import { Link, isRouteErrorResponse, useRouteError } from "react-router-dom";
import { EmptyState, ErrorState } from "../components/feedback";
import { Button, PageHeader } from "../components/ui";
import { getErrorMessage, isApiError } from "../lib/api-error";

// Shown when a route throws while loading or rendering. A 403 is not a fault: the signed-in
// person's role simply cannot open that page.
export function RouteError({ inShell = false }: { inShell?: boolean }) {
  const error = useRouteError();
  // Inside the app shell the page area already has padding; outside it the page needs its own.
  const frame = (content: ReactNode) =>
    inShell ? <>{content}</> : <div className="mx-auto max-w-2xl p-6">{content}</div>;

  if (isRouteErrorResponse(error) && error.status === 403) {
    return frame(
      <>
        <PageHeader title="No access" />
        <EmptyState
          title="Your role cannot open this page"
          description="Use the menu to go to a page you can use."
          action={
            <Button variant="primary" asChild>
              <Link to="/">Go to the start page</Link>
            </Button>
          }
        />
      </>,
    );
  }

  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : getErrorMessage(error);
  const requestId = isApiError(error) ? error.requestId : undefined;

  return frame(
    <>
      <PageHeader title="Something went wrong" />
      <ErrorState
        message={message}
        requestId={requestId}
        onRetry={() => window.location.reload()}
      />
    </>,
  );
}
