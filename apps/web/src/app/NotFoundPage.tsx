import { Link } from "react-router-dom";
import { EmptyState } from "../components/feedback";
import { Button, PageHeader } from "../components/ui";
import { DEFAULT_LANDING_PATH } from "./route-config";

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" />
      <EmptyState
        title="There is nothing at this address"
        description="Check the address, or go back to the start page."
        action={
          <Button variant="primary" asChild>
            <Link to={DEFAULT_LANDING_PATH}>Go to the start page</Link>
          </Button>
        }
      />
    </>
  );
}
