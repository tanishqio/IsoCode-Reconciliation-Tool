import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "../../components/feedback";
import { Badge, Button, Money, PageHeader, SelectField, cn } from "../../components/ui";
import { getErrorMessage, isApiError } from "../../lib/api-error";
import { useCurrentUser } from "../auth/use-current-user";
import { formatCount, formatDate, pageCount } from "../orders/orders-model";
import { ClaimDialog } from "./ClaimDialog";
import {
  claimsKeys,
  getClaimsSummary,
  listClaims,
  rebuildClaims,
  type Claim,
  type ClaimStatus,
  type ClaimsQuery,
} from "./claims-api";
import { STATUS_LABELS, ageText, statusVariant } from "./claims-model";

const th =
  "h-9 whitespace-nowrap border-b border-border-strong bg-page px-3 text-label font-medium uppercase tracking-wider text-muted";
const td = "h-10 whitespace-nowrap border-b border-border px-3 text-cell";

/** Claims by partner, with the evidence for each order. */
export function ClaimsPage() {
  const user = useCurrentUser();
  const canChange = user?.role === "FINANCE_EXECUTIVE";
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ClaimStatus | "">("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Claim | null>(null);

  const query: ClaimsQuery = { status: status || undefined, page };
  const summary = useQuery({
    queryKey: claimsKeys.summary,
    queryFn: ({ signal }) => getClaimsSummary(signal),
    refetchInterval: (state) =>
      state.state.data?.job?.status === "QUEUED" || state.state.data?.job?.status === "RUNNING"
        ? 1500
        : false,
  });
  const list = useQuery({
    queryKey: claimsKeys.list(query),
    queryFn: ({ signal }) => listClaims(query, signal),
    placeholderData: (previous) => previous,
  });
  const rebuild = useMutation({
    mutationFn: rebuildClaims,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: claimsKeys.all }),
  });

  const data = summary.data;
  const running = data?.job?.status === "QUEUED" || data?.job?.status === "RUNNING";
  const pages = pageCount(list.data?.total ?? 0, list.data?.pageSize ?? 25);
  const cards = data
    ? [
        { label: "Open", bucket: data.open, help: "still collecting" },
        { label: "Evidence exported", bucket: data.exported, help: "waiting for the partner" },
        {
          label: "Recovered",
          bucket: data.recovered,
          help: "money came back",
          showRecovered: true,
        },
        { label: "Closed", bucket: data.closed, help: "dropped" },
      ]
    : [];

  return (
    <>
      <PageHeader
        title="Claims"
        description="What each partner owes us, found by the matching, with the evidence to claim it. Nothing is filed for you."
      />
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-cell text-muted" aria-live="polite">
            {running
              ? `Updating the claims\u2026 ${data?.job?.progressPct ?? 0}%`
              : data?.asOf
                ? `Based on results using data up to ${formatDate(data.asOf)}.`
                : "No results yet."}
          </p>
          {canChange ? (
            <Button
              variant="secondary"
              disabled={rebuild.isPending || running}
              onClick={() => rebuild.mutate()}
            >
              Refresh claims
            </Button>
          ) : null}
        </div>
        {data?.job?.status === "FAILED" ? (
          <p role="alert" className="text-cell text-risk">
            The last update failed: {data.job.errorMessage ?? "unknown reason"}
          </p>
        ) : null}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {cards.map(({ label, bucket, help, showRecovered }) => (
            <div key={label} className="rounded-ui border border-border p-4">
              <p className="text-cell text-muted">{label}</p>
              <p className="mt-1 text-title font-semibold tabular-nums text-ink">
                <Money amount={showRecovered ? bucket.recovered : bucket.total} />
              </p>
              <p className="text-label text-muted">
                {formatCount(bucket.claims)} claim{bucket.claims === 1 ? "" : "s"},{" "}
                {formatCount(bucket.orders)} order
                {bucket.orders === 1 ? "" : "s"} &middot; {help}
              </p>
            </div>
          ))}
        </div>

        <SelectField
          label="Status"
          placeholder="All statuses"
          value={status}
          options={(Object.keys(STATUS_LABELS) as ClaimStatus[]).map((key) => ({
            value: key,
            label: STATUS_LABELS[key],
          }))}
          onChange={(event) => {
            setStatus(event.target.value as ClaimStatus | "");
            setPage(1);
          }}
          className="w-56"
        />

        {list.isPending ? (
          <LoadingState label={"Loading claims\u2026"} rows={4} />
        ) : list.isError ? (
          <ErrorState
            message={getErrorMessage(list.error)}
            requestId={isApiError(list.error) ? list.error.requestId : undefined}
            onRetry={() => void list.refetch()}
          />
        ) : list.data.items.length === 0 ? (
          <EmptyState
            title="No claims"
            description="Claims appear when the matching finds orders that were short-paid, unpaid, over-charged for freight or never returned."
          />
        ) : (
          <>
            <div className="overflow-x-auto border-t border-border-strong">
              <table className="w-full min-w-[820px] border-collapse">
                <thead>
                  <tr className="text-left">
                    <th scope="col" className={th}>
                      Claim
                    </th>
                    <th scope="col" className={th}>
                      Partner
                    </th>
                    <th scope="col" className={th}>
                      Status
                    </th>
                    <th scope="col" className={cn(th, "text-right")}>
                      Orders
                    </th>
                    <th scope="col" className={cn(th, "text-right")}>
                      Claimed
                    </th>
                    <th scope="col" className={cn(th, "text-right")}>
                      Recovered
                    </th>
                    <th scope="col" className={cn(th, "text-right")}>
                      Oldest
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((claim) => (
                    <tr key={claim.id}>
                      <td className={cn(td, "font-medium")}>
                        <button
                          type="button"
                          className="text-accent underline-offset-2 hover:underline"
                          onClick={() => setOpen(claim)}
                          aria-label={`Open claim ${claim.label} for ${claim.partner.name}`}
                        >
                          {claim.label}
                        </button>
                      </td>
                      <td className={td}>{claim.partner.name}</td>
                      <td className={td}>
                        <Badge variant={statusVariant(claim.status)}>
                          {STATUS_LABELS[claim.status]}
                        </Badge>
                      </td>
                      <td className={cn(td, "text-right tabular-nums")}>
                        {formatCount(claim.itemCount)}
                      </td>
                      <td className={cn(td, "text-right")}>
                        <Money amount={claim.total} />
                      </td>
                      <td className={cn(td, "text-right")}>
                        <Money amount={claim.recovered} />
                      </td>
                      <td className={cn(td, "text-right")}>{ageText(claim.oldestAgeDays)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-cell text-muted">
                {formatCount(list.data.total)} claim{list.data.total === 1 ? "" : "s"}, page {page}{" "}
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
      <ClaimDialog claim={open} canChange={canChange} onClose={() => setOpen(null)} />
    </>
  );
}
