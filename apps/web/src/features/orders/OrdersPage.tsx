import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState } from "../../components/feedback";
import { Badge, Button, Money, PageHeader, SelectField, TextField, cn } from "../../components/ui";
import { getErrorMessage, isApiError } from "../../lib/api-error";
import { useCurrentUser } from "../auth/use-current-user";
import { FilterChip } from "./FilterChip";
import { OrderDrawer } from "./OrderDrawer";
import { ReturnsTab } from "./ReturnsTab";
import {
  getStatus,
  getSummary,
  listOrders,
  ordersKeys,
  recalculate,
  type OrderStatus,
  type OrdersQuery,
  type SortKey,
} from "./orders-api";
import {
  SORT_LABELS,
  STATUS_LABELS,
  STATUS_ORDER,
  formatCount,
  formatDate,
  formatDateTime,
  pageCount,
  showsLoss,
  statusVariant,
} from "./orders-model";

const th =
  "h-9 whitespace-nowrap border-b border-border-strong bg-page px-3 text-label font-medium uppercase tracking-wider text-muted";
const td = "h-10 whitespace-nowrap border-b border-border px-3 text-cell group-hover:bg-surface";
const stickyFirst =
  "max-sm:sticky max-sm:left-0 max-sm:border-r max-sm:border-r-border max-sm:bg-page";

/** How often the page refreshes while a recalculation is running. */
const REFRESH_WHILE_RUNNING_MS = 1500;

function AllOrdersTab() {
  const user = useCurrentUser();
  const canRecalculate = user?.role === "FINANCE_EXECUTIVE";
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<OrderStatus | undefined>(undefined);
  const [channelId, setChannelId] = useState("");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("difference");
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  // Search as the person pauses typing, and go back to page 1 whenever a filter changes.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query: OrdersQuery = {
    status,
    channelId: channelId || undefined,
    q: q || undefined,
    sort,
    page,
  };

  const statusQuery = useQuery({
    queryKey: ordersKeys.status,
    queryFn: ({ signal }) => getStatus(signal),
    refetchInterval: (state) =>
      state.state.data?.job?.status === "QUEUED" || state.state.data?.job?.status === "RUNNING"
        ? REFRESH_WHILE_RUNNING_MS
        : false,
  });
  const running =
    statusQuery.data?.job?.status === "QUEUED" || statusQuery.data?.job?.status === "RUNNING";

  const summary = useQuery({
    queryKey: ordersKeys.summary,
    queryFn: ({ signal }) => getSummary(signal),
    refetchInterval: running ? REFRESH_WHILE_RUNNING_MS : false,
  });
  const list = useQuery({
    queryKey: ordersKeys.list(query),
    queryFn: ({ signal }) => listOrders(query, signal),
    placeholderData: (previous) => previous,
    refetchInterval: running ? REFRESH_WHILE_RUNNING_MS : false,
  });

  const run = useMutation({
    mutationFn: recalculate,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["orders"] }),
  });

  const total = summary.data?.total ?? 0;
  const pages = pageCount(list.data?.total ?? 0, list.data?.pageSize ?? 50);
  const settings = statusQuery.data?.settings;

  function pick(next: OrderStatus | undefined) {
    setStatus(next);
    setPage(1);
  }

  return (
    <>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-cell text-muted" aria-live="polite">
            {running
              ? `Recalculating\u2026 ${statusQuery.data?.job?.progressPct ?? 0}%`
              : statusQuery.data?.computedAt
                ? `Calculated ${formatDateTime(statusQuery.data.computedAt)}, using data up to ${formatDate(statusQuery.data.asOf as string)}.`
                : "No results yet."}
          </p>
          {canRecalculate ? (
            <Button
              variant="secondary"
              onClick={() => run.mutate()}
              disabled={run.isPending || running}
            >
              Recalculate
            </Button>
          ) : null}
        </div>
        {statusQuery.data?.job?.status === "FAILED" ? (
          <p role="alert" className="text-cell text-risk">
            The last recalculation failed: {statusQuery.data.job.errorMessage ?? "unknown reason"}
          </p>
        ) : null}
        {run.isError ? (
          <p role="alert" className="text-cell text-risk">
            {getErrorMessage(run.error)}
          </p>
        ) : null}

        {settings ? (
          <p className="text-label text-muted">
            Rules used{settings.isSampleData ? " (sample values, to be confirmed by finance)" : ""}:
            a gap of up to {"\u20B9"}
            {settings.tolerance} is accepted; COD is late after {settings.codDueDays} days, other
            payouts after {settings.settlementDueDays} days; a return is missing after{" "}
            {settings.returnWindowDays} days.
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
          <FilterChip active={status === undefined} onClick={() => pick(undefined)}>
            All {summary.data ? formatCount(total) : ""}
          </FilterChip>
          {STATUS_ORDER.filter((value) => summary.data?.byStatus[value]).map((value) => (
            <FilterChip key={value} active={status === value} onClick={() => pick(value)}>
              {STATUS_LABELS[value]} {formatCount(summary.data?.byStatus[value]?.count ?? 0)}
            </FilterChip>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_14rem_14rem]">
          <TextField
            label="Find an order"
            placeholder="Part of the order ID"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <SelectField
            label="Channel"
            placeholder="All channels"
            value={channelId}
            options={(summary.data?.channels ?? []).map((c) => ({ value: c.id, label: c.name }))}
            onChange={(event) => {
              setChannelId(event.target.value);
              setPage(1);
            }}
          />
          <SelectField
            label="Order"
            value={sort}
            options={(Object.keys(SORT_LABELS) as SortKey[]).map((key) => ({
              value: key,
              label: SORT_LABELS[key],
            }))}
            onChange={(event) => {
              setSort(event.target.value as SortKey);
              setPage(1);
            }}
          />
        </div>

        {list.isPending ? (
          <LoadingState label={"Loading orders\u2026"} rows={6} />
        ) : list.isError ? (
          <ErrorState
            message={getErrorMessage(list.error)}
            requestId={isApiError(list.error) ? list.error.requestId : undefined}
            onRetry={() => void list.refetch()}
          />
        ) : list.data.total === 0 ? (
          <EmptyState
            title={total === 0 ? "No orders yet" : "No orders match"}
            description={
              total === 0
                ? "Upload and process an orders file, and the results appear here."
                : "Change the filters to see more."
            }
          />
        ) : (
          <>
            <div className="max-h-[36rem] overflow-auto border-t border-border-strong">
              <table className="w-full min-w-[940px] border-collapse">
                <thead>
                  <tr className="text-left">
                    <th scope="col" className={cn(th, "sticky top-0 z-10", stickyFirst)}>
                      Order
                    </th>
                    <th scope="col" className={cn(th, "sticky top-0")}>
                      Status
                    </th>
                    <th scope="col" className={cn(th, "sticky top-0")}>
                      Channel
                    </th>
                    <th scope="col" className={cn(th, "sticky top-0 text-right")}>
                      Value
                    </th>
                    <th scope="col" className={cn(th, "sticky top-0")}>
                      Payment
                    </th>
                    <th scope="col" className={cn(th, "sticky top-0")}>
                      Delivery
                    </th>
                    <th scope="col" className={cn(th, "sticky top-0 text-right")}>
                      Expected
                    </th>
                    <th scope="col" className={cn(th, "sticky top-0 text-right")}>
                      Received
                    </th>
                    <th scope="col" className={cn(th, "sticky top-0 text-right")}>
                      Difference
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((row) => (
                    <tr key={row.id} className="group">
                      <td className={cn(td, stickyFirst, "font-medium")}>
                        <button
                          type="button"
                          className="text-left text-accent underline-offset-2 hover:underline"
                          onClick={() => setOpenId(row.id)}
                          aria-label={`Open order ${row.orderId}`}
                        >
                          {row.orderId}
                        </button>
                      </td>
                      <td className={td}>
                        <Badge variant={statusVariant(row.status)}>
                          {STATUS_LABELS[row.status]}
                        </Badge>
                      </td>
                      <td className={td}>{row.channel}</td>
                      <td className={cn(td, "text-right")}>
                        <Money amount={row.value} />
                      </td>
                      <td className={td}>{row.paymentType === "COD" ? "COD" : "Prepaid"}</td>
                      <td className={cn(td, "max-w-48 truncate")} title={row.deliveryStatus}>
                        {row.deliveryStatus}
                      </td>
                      <td className={cn(td, "text-right")}>
                        <Money amount={row.expected} />
                      </td>
                      <td className={cn(td, "text-right")}>
                        <Money amount={row.received} />
                      </td>
                      <td className={cn(td, "text-right")}>
                        <Money
                          amount={row.difference}
                          tone={showsLoss(row.status) ? "difference" : "neutral"}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-cell text-muted">
                {formatCount(list.data.total)} order{list.data.total === 1 ? "" : "s"}, page {page}{" "}
                of {formatCount(pages)}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={page >= pages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      <OrderDrawer orderId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

/** The Orders screen: every order with its result, and the returns tracker as a second tab. */
export function OrdersPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "returns" ? "returns" : "all";
  const choose = (next: "all" | "returns") =>
    setParams(next === "all" ? {} : { tab: next }, { replace: true });
  return (
    <>
      <PageHeader
        title="Orders"
        description="For every order: what we should have received, what we did receive, and the difference. A loss is a negative number."
      />
      <div
        role="tablist"
        aria-label="Orders views"
        className="mb-5 flex gap-1 border-b border-border"
      >
        {(
          [
            ["all", "All orders"],
            ["returns", "Returns"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => choose(key)}
            className={cn(
              "-mb-px h-9 border-b-2 px-3 text-cell",
              tab === key
                ? "border-accent font-medium text-accent"
                : "border-transparent text-ink-2 hover:text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "returns" ? <ReturnsTab /> : <AllOrdersTab />}
    </>
  );
}
