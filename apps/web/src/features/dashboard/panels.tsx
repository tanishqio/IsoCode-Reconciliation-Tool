import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ErrorState, LoadingState } from "../../components/feedback";
import { getErrorMessage, isApiError } from "../../lib/api-error";
import { ActivityView } from "./ActivityView";
import {
  AUDIT_KEY,
  MONEY_AT_RISK_KEY,
  TAX_SUMMARY_KEY,
  fetchAudit,
  fetchMoneyAtRisk,
  fetchTaxSummary,
} from "./dashboard-api";
import { MoneyAtRiskView } from "./MoneyAtRiskView";
import { TaxSummaryView } from "./TaxSummaryView";

function failure(error: unknown, retry: () => void) {
  return (
    <ErrorState
      message={getErrorMessage(error)}
      requestId={isApiError(error) ? error.requestId : undefined}
      onRetry={retry}
    />
  );
}

export function MoneyAtRiskPanel({ canUpload }: { canUpload: boolean }) {
  const query = useQuery({
    queryKey: MONEY_AT_RISK_KEY,
    queryFn: ({ signal }) => fetchMoneyAtRisk(signal),
  });
  if (query.isPending) return <LoadingState label={"Loading money at risk\u2026"} rows={6} />;
  if (query.isError) return failure(query.error, () => void query.refetch());
  return <MoneyAtRiskView data={query.data} canUpload={canUpload} />;
}

export function TaxSummaryPanel({
  month,
  onMonthChange,
}: {
  month: string | null;
  onMonthChange: (month: string | null) => void;
}) {
  const query = useQuery({
    queryKey: [...TAX_SUMMARY_KEY, { month }],
    queryFn: ({ signal }) => fetchTaxSummary(month, signal),
    // Keep the previous table on screen while another month loads.
    placeholderData: (previous) => previous,
  });
  if (query.isPending) return <LoadingState label={"Loading TCS and TDS\u2026"} rows={4} />;
  if (query.isError) return failure(query.error, () => void query.refetch());
  return <TaxSummaryView data={query.data} onMonthChange={onMonthChange} />;
}

export function ActivityPanel() {
  const query = useInfiniteQuery({
    queryKey: AUDIT_KEY,
    queryFn: ({ pageParam, signal }) => fetchAudit(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  if (query.isPending) return <LoadingState label={"Loading activity\u2026"} rows={5} />;
  if (query.isError) return failure(query.error, () => void query.refetch());
  return (
    <ActivityView
      items={query.data.pages.flatMap((page) => page.items)}
      hasMore={query.hasNextPage}
      loadingMore={query.isFetchingNextPage}
      onLoadMore={() => void query.fetchNextPage()}
    />
  );
}
