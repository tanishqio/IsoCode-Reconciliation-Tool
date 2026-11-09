import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ErrorState, LoadingState } from "../../components/feedback";
import { Badge, Button, Money, TextField, cn } from "../../components/ui";
import { getErrorMessage, isApiError } from "../../lib/api-error";
import { formatDate } from "../orders/orders-model";
import {
  CLAIM_ITEMS_PAGE_SIZE,
  claimsKeys,
  exportClaim,
  getClaim,
  getClaimItem,
  setClaimStatus,
  type Claim,
} from "./claims-api";
import {
  STATUS_HELP,
  STATUS_LABELS,
  ageText,
  downloadText,
  recoveredProblem,
  statusVariant,
} from "./claims-model";

const th =
  "h-9 whitespace-nowrap border-b border-border-strong bg-page px-3 text-label font-medium uppercase tracking-wider text-muted";
const td = "border-b border-border px-3 py-2 text-cell";

/** One claim: its orders, the evidence for each, and (for the executive) export and status. */
export function ClaimDialog({
  claim,
  canChange,
  onClose,
}: {
  claim: Claim | null;
  canChange: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open={claim !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-3xl flex-col overflow-y-auto border-l border-border bg-page p-5 shadow-overlay">
          {claim ? <Body claim={claim} canChange={canChange} onClose={onClose} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Body({
  claim,
  canChange,
  onClose,
}: {
  claim: Claim;
  canChange: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [recovered, setRecovered] = useState("");
  const [recoveredError, setRecoveredError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: claimsKeys.detail(claim.id, page),
    queryFn: ({ signal }) => getClaim(claim.id, page, signal),
    placeholderData: (previous) => previous,
  });
  const live = detail.data?.claim ?? claim;

  const refresh = () => void queryClient.invalidateQueries({ queryKey: claimsKeys.all });
  const exporting = useMutation({
    mutationFn: () => exportClaim(claim.id),
    onSuccess: (result) => {
      downloadText(result.fileName, result.csv);
      setNotice(
        `Saved ${result.fileName} with ${result.itemCount} order${result.itemCount === 1 ? "" : "s"}.`,
      );
      refresh();
    },
  });
  const changing = useMutation({
    mutationFn: (body: { status: "RECOVERED" | "CLOSED"; recovered?: string }) =>
      setClaimStatus(claim.id, body),
    onSuccess: (result) => {
      setNotice(result.status === "RECOVERED" ? "Recorded as recovered." : "Claim closed.");
      refresh();
    },
  });

  const pages = Math.max(1, Math.ceil((live.itemCount || 0) / CLAIM_ITEMS_PAGE_SIZE));
  const problem = exporting.error ?? changing.error;

  function saveRecovered() {
    const message = recoveredProblem(recovered, live.total);
    setRecoveredError(message);
    if (!message) changing.mutate({ status: "RECOVERED", recovered: recovered.trim() });
  }

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Dialog.Title className="text-section font-semibold text-ink">
            {live.label} &middot; {live.partner.name}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-body text-ink-2">
            {live.itemCount} order{live.itemCount === 1 ? "" : "s"} &middot;{" "}
            <Money amount={live.total} /> &middot; oldest {ageText(live.oldestAgeDays)}
          </Dialog.Description>
        </div>
        <Badge variant={statusVariant(live.status)}>{STATUS_LABELS[live.status]}</Badge>
      </div>
      <p className="mt-1 text-label text-muted">{STATUS_HELP[live.status]}</p>

      {canChange ? (
        <div className="mt-4 flex flex-col gap-3 rounded-ui border border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={exporting.isPending || live.itemCount === 0}
              onClick={() => exporting.mutate()}
            >
              {exporting.isPending
                ? "Preparing\u2026"
                : live.status === "OPEN"
                  ? "Export evidence (CSV)"
                  : "Download evidence again"}
            </Button>
            {live.status === "OPEN" ? (
              <span className="text-label text-muted">
                Exporting freezes this claim; new findings go to a new one.
              </span>
            ) : null}
            {live.status !== "CLOSED" ? (
              <Button
                variant="secondary"
                disabled={changing.isPending}
                onClick={() => changing.mutate({ status: "CLOSED" })}
              >
                Close claim
              </Button>
            ) : null}
          </div>
          {live.status === "EXPORTED" ? (
            <div className="flex flex-wrap items-end gap-2">
              <TextField
                label="Amount recovered (₹)"
                inputMode="decimal"
                placeholder="1409.00"
                value={recovered}
                error={recoveredError ?? undefined}
                onChange={(event) => setRecovered(event.target.value)}
                className="w-48"
              />
              <Button variant="secondary" disabled={changing.isPending} onClick={saveRecovered}>
                Record recovery
              </Button>
            </div>
          ) : null}
          {live.status === "RECOVERED" ? (
            <p className="text-cell text-ink-2">
              Recovered <Money amount={live.recovered} /> of <Money amount={live.total} />.
            </p>
          ) : null}
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="mt-3 text-cell text-ink-2">
          {notice}
        </p>
      ) : null}
      {problem ? (
        <p role="alert" className="mt-3 text-cell text-risk">
          {getErrorMessage(problem)}
        </p>
      ) : null}

      {detail.data && detail.data.byType.length > 0 ? (
        <ul className="mt-4 flex flex-wrap gap-2">
          {detail.data.byType.map((entry) => (
            <li key={entry.type}>
              <Badge>
                {entry.label}: {entry.orders} &middot; <Money amount={entry.amount} />
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-4 min-h-0 flex-1">
        {detail.isPending ? (
          <LoadingState label={"Loading the orders\u2026"} rows={4} />
        ) : detail.isError ? (
          <ErrorState
            message={getErrorMessage(detail.error)}
            requestId={isApiError(detail.error) ? detail.error.requestId : undefined}
            onRetry={() => void detail.refetch()}
          />
        ) : (
          <>
            <div className="overflow-x-auto border-t border-border-strong">
              <table className="w-full min-w-[560px] border-collapse">
                <thead>
                  <tr className="text-left">
                    <th scope="col" className={th}>
                      Order
                    </th>
                    <th scope="col" className={th}>
                      Problem
                    </th>
                    <th scope="col" className={cn(th, "text-right")}>
                      Claimed
                    </th>
                    <th scope="col" className={cn(th, "text-right")}>
                      Age
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.items.map((item) => (
                    <tr key={item.id} className={cn(openItem === item.id && "bg-surface")}>
                      <td className={td}>
                        <button
                          type="button"
                          className="font-medium text-accent underline-offset-2 hover:underline"
                          aria-expanded={openItem === item.id}
                          onClick={() => setOpenItem(openItem === item.id ? null : item.id)}
                        >
                          {item.orderId}
                        </button>
                      </td>
                      <td className={td}>{item.typeLabel}</td>
                      <td className={cn(td, "text-right")}>
                        <Money amount={item.amount} />
                      </td>
                      <td className={cn(td, "text-right")}>{ageText(item.ageDays)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {openItem ? (
              <Evidence itemId={openItem} />
            ) : (
              <p className="mt-3 text-label text-muted">
                Select an order to see the evidence for it.
              </p>
            )}
            {pages > 1 ? (
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-cell text-muted">
                  Page {page} of {pages}
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
            ) : null}
          </>
        )}
      </div>

      <div className="mt-5 flex justify-end">
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </div>
    </>
  );
}

function Evidence({ itemId }: { itemId: string }) {
  const item = useQuery({
    queryKey: claimsKeys.item(itemId),
    queryFn: ({ signal }) => getClaimItem(itemId, signal),
  });
  if (item.isPending) return <LoadingState label={"Loading the evidence\u2026"} rows={3} />;
  if (item.isError)
    return <ErrorState message={getErrorMessage(item.error)} onRetry={() => void item.refetch()} />;
  const { evidence } = item.data;
  const list = (rows: { label: string; amount: string }[]) => (
    <dl className="text-cell">
      {rows.map((row) => (
        <div key={row.label} className="flex justify-between gap-4 border-b border-border py-1">
          <dt className="text-ink-2">{row.label}</dt>
          <dd>
            <Money amount={row.amount} />
          </dd>
        </div>
      ))}
    </dl>
  );
  return (
    <section
      aria-label={`Evidence for ${item.data.orderId}`}
      className="mt-3 flex flex-col gap-3 rounded-ui border border-border p-3"
    >
      <h3 className="text-body font-semibold text-ink">Evidence for {item.data.orderId}</h3>
      <p className="text-cell text-ink-2">
        {evidence.order.channel}
        {evidence.order.courier ? ` with ${evidence.order.courier}` : ""} &middot;{" "}
        {evidence.order.paymentType === "COD" ? "COD" : "Prepaid"} &middot;{" "}
        {evidence.order.deliveryStatus} &middot; ordered {formatDate(evidence.order.orderDate)}{" "}
        &middot; value <Money amount={evidence.order.value} />
      </p>
      <div className="grid gap-3 sm:grid-cols-3 text-cell">
        <div>
          <p className="text-muted">Expected</p>
          <Money amount={evidence.result.expected} />
        </div>
        <div>
          <p className="text-muted">Received</p>
          <Money amount={evidence.result.received} />
        </div>
        <div>
          <p className="text-muted">Difference</p>
          <Money amount={evidence.result.difference} tone="difference" />
        </div>
      </div>
      {evidence.working.length > 0 ? (
        <div>
          <p className="text-cell font-medium text-ink">
            How the expected amount was worked out
            {evidence.result.rateCardVersion !== null
              ? ` (rate card version ${evidence.result.rateCardVersion}${evidence.result.rateCardIsSample ? ", sample values" : ""})`
              : ""}
          </p>
          {list(evidence.working)}
        </div>
      ) : null}
      {evidence.received.length > 0 ? (
        <div>
          <p className="text-cell font-medium text-ink">What counted as received</p>
          {list(evidence.received)}
        </div>
      ) : null}
      <div>
        <p className="text-cell font-medium text-ink">Lines from the uploaded files</p>
        {evidence.lines.length === 0 ? (
          <p className="text-cell text-muted">
            No line from any uploaded file was matched to this order.
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1 text-cell">
            {evidence.lines.map((line, index) => (
              <li
                key={`${line.file}-${line.row}-${index}`}
                className="flex justify-between gap-3 rounded-ui border border-border p-2"
              >
                <span className="min-w-0">
                  {line.kind}
                  {line.partner ? ` from ${line.partner}` : ""}
                  {line.date ? ` \u00b7 ${formatDate(line.date)}` : ""}
                  {line.reference ? ` \u00b7 ${line.reference}` : ""}
                  <span className="block break-all text-label text-muted">
                    {line.file}, row {line.row}
                  </span>
                </span>
                {line.amount !== null ? <Money amount={line.amount} /> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
