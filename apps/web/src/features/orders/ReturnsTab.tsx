import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "../../components/feedback";
import { Badge, Button, Money, TextField, cn } from "../../components/ui";
import { getErrorMessage, isApiError } from "../../lib/api-error";
import { FilterChip } from "./FilterChip";
import {
  getReturnsSummary,
  listReturns,
  returnsKeys,
  type ReturnState,
  type ReturnsQuery,
} from "./returns-api";
import { formatCount, formatDate, pageCount } from "./orders-model";

const STATE_LABELS: Record<ReturnState, string> = {
  NOT_RECEIVED: "Not received",
  WAITING: "On its way",
  RECEIVED: "Received",
};

const th =
  "h-9 whitespace-nowrap border-b border-border-strong bg-page px-3 text-label font-medium uppercase tracking-wider text-muted";
const td = "h-10 whitespace-nowrap border-b border-border px-3 text-cell";

/** Returned orders against the warehouse receipt scans. Read only. */
export function ReturnsTab() {
  const [state, setState] = useState<ReturnState | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query: ReturnsQuery = { state, q: q || undefined, page };
  const summary = useQuery({
    queryKey: returnsKeys.summary,
    queryFn: ({ signal }) => getReturnsSummary(signal),
  });
  const list = useQuery({
    queryKey: returnsKeys.list(query),
    queryFn: ({ signal }) => listReturns(query, signal),
    placeholderData: (previous) => previous,
  });

  const data = summary.data;
  const total = data ? data.notReceived.orders + data.waiting.orders + data.received.orders : 0;
  const cards: { state: ReturnState; tone: "risk" | "neutral" }[] = [
    { state: "NOT_RECEIVED", tone: "risk" },
    { state: "WAITING", tone: "neutral" },
    { state: "RECEIVED", tone: "neutral" },
  ];

  return (
    <div className="flex flex-col gap-5">
      <p className="text-cell text-muted">
        A returned order should reach the warehouse within {data?.windowDays ?? 7} days of its
        return date (a sample value). The check uses the newest date in the uploaded data
        {data?.asOf ? `, ${formatDate(data.asOf)}` : ""}.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {cards.map(({ state: key, tone }) => {
          const entry =
            key === "NOT_RECEIVED"
              ? data?.notReceived
              : key === "WAITING"
                ? data?.waiting
                : data?.received;
          return (
            <div key={key} className="rounded-ui border border-border p-4">
              <p className="text-cell text-muted">{STATE_LABELS[key]}</p>
              <p
                className={cn(
                  "mt-1 text-title font-semibold tabular-nums",
                  tone === "risk" && entry?.orders ? "text-risk" : "text-ink",
                )}
              >
                {entry ? formatCount(entry.orders) : "\u2014"}
              </p>
              <p className="text-cell text-muted">
                {entry ? (
                  <>
                    Order value <Money amount={entry.value} />
                  </>
                ) : null}
              </p>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by state">
        <FilterChip
          active={state === undefined}
          onClick={() => {
            setState(undefined);
            setPage(1);
          }}
        >
          All {data ? formatCount(total) : ""}
        </FilterChip>
        {cards.map(({ state: key }) => (
          <FilterChip
            key={key}
            active={state === key}
            onClick={() => {
              setState(key);
              setPage(1);
            }}
          >
            {STATE_LABELS[key]}
          </FilterChip>
        ))}
      </div>

      <TextField
        label="Find a returned order"
        placeholder="Part of the order ID"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="max-w-sm"
      />

      {list.isPending ? (
        <LoadingState label={"Loading returns\u2026"} rows={5} />
      ) : list.isError ? (
        <ErrorState
          message={getErrorMessage(list.error)}
          requestId={isApiError(list.error) ? list.error.requestId : undefined}
          onRetry={() => void list.refetch()}
        />
      ) : list.data.total === 0 ? (
        <EmptyState
          title={total === 0 ? "No returned orders" : "No returns match"}
          description={
            total === 0
              ? "Returned orders appear here once an orders file with return statuses is processed."
              : "Change the filters to see more."
          }
        />
      ) : (
        <>
          <div className="max-h-[32rem] overflow-auto border-t border-border-strong">
            <table className="w-full min-w-[960px] border-collapse">
              <thead>
                <tr className="text-left">
                  {["Order", "State", "Channel", "Courier", "AWB"].map((label) => (
                    <th key={label} scope="col" className={cn(th, "sticky top-0")}>
                      {label}
                    </th>
                  ))}
                  <th scope="col" className={cn(th, "sticky top-0 text-right")}>
                    Value
                  </th>
                  <th scope="col" className={cn(th, "sticky top-0")}>
                    Returned
                  </th>
                  <th scope="col" className={cn(th, "sticky top-0 text-right")}>
                    Days since
                  </th>
                  <th scope="col" className={cn(th, "sticky top-0")}>
                    Warehouse scan
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((row) => (
                  <tr key={row.id}>
                    <td className={cn(td, "font-medium")}>{row.orderId}</td>
                    <td className={td}>
                      <Badge variant={row.state === "NOT_RECEIVED" ? "risk" : "neutral"}>
                        {STATE_LABELS[row.state]}
                      </Badge>
                    </td>
                    <td className={td}>{row.channel}</td>
                    <td className={td}>{row.courier ?? "\u2014"}</td>
                    <td className={td}>{row.awb ?? "\u2014"}</td>
                    <td className={cn(td, "text-right")}>
                      <Money amount={row.value} />
                    </td>
                    <td className={td}>{formatDate(row.returnedAt ?? row.returnStart)}</td>
                    <td className={cn(td, "text-right tabular-nums")}>{row.daysSince}</td>
                    <td className={td}>{row.scannedAt ? formatDate(row.scannedAt) : "\u2014"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-cell text-muted">
              {formatCount(list.data.total)} return{list.data.total === 1 ? "" : "s"}, page {page}{" "}
              of {formatCount(pageCount(list.data.total, list.data.pageSize))}
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
                disabled={page >= pageCount(list.data.total, list.data.pageSize)}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
