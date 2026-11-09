import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { ErrorState, LoadingState } from "../../components/feedback";
import { Badge, Button, Money } from "../../components/ui";
import { getErrorMessage, isApiError } from "../../lib/api-error";
import { getOrder, ordersKeys, type Amount, type OrderDetail } from "./orders-api";
import {
  CALC_PROBLEM_LABELS,
  FLAG_LABELS,
  STATUS_EXPLANATIONS,
  STATUS_LABELS,
  formatDate,
  formatDateTime,
  showsLoss,
  statusVariant,
} from "./orders-model";

/** The evidence for one order: how the expected amount was worked out and every line that counted. */
export function OrderDrawer({ orderId, onClose }: { orderId: string | null; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ordersKeys.detail(orderId ?? ""),
    queryFn: ({ signal }) => getOrder(orderId as string, signal),
    enabled: orderId !== null,
  });

  return (
    <Dialog.Root open={orderId !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col overflow-y-auto border-l border-border bg-page p-5 shadow-overlay">
          <Dialog.Title className="text-section font-semibold text-ink">
            {detail.data?.order.orderId ?? "Order"}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-body text-ink-2">
            How this order was checked, and the lines that count.
          </Dialog.Description>

          <div className="mt-4 flex flex-1 flex-col gap-6">
            {detail.isPending ? (
              <LoadingState label={"Loading the order\u2026"} rows={5} />
            ) : detail.isError ? (
              <ErrorState
                message={getErrorMessage(detail.error)}
                requestId={isApiError(detail.error) ? detail.error.requestId : undefined}
                onRetry={() => void detail.refetch()}
              />
            ) : (
              <Body detail={detail.data} />
            )}
          </div>

          <div className="mt-6 flex justify-end">
            <Dialog.Close asChild>
              <Button variant="primary">Close</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-body font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

function AmountList({
  items,
  total,
}: {
  items: Amount[];
  total?: { label: string; amount: string | null };
}) {
  return (
    <dl className="flex flex-col text-cell">
      {items.map((item) => (
        <div key={item.label} className="flex justify-between gap-4 border-b border-border py-1.5">
          <dt className="text-ink-2">{item.label}</dt>
          <dd>
            <Money amount={item.amount} />
          </dd>
        </div>
      ))}
      {total ? (
        <div className="flex justify-between gap-4 py-1.5 font-medium">
          <dt className="text-ink">{total.label}</dt>
          <dd>
            <Money amount={total.amount} />
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

function Body({ detail }: { detail: OrderDetail }) {
  const { order, result, working, received, lines } = detail;
  const noLines =
    lines.settlement.length +
      lines.codRemittance.length +
      lines.freight.length +
      lines.returnScans.length ===
    0;

  return (
    <>
      <Section title="Result">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={statusVariant(result.status)}>{STATUS_LABELS[result.status]}</Badge>
          <span className="text-cell text-ink-2">{STATUS_EXPLANATIONS[result.status]}</span>
        </div>
        {result.calcProblem ? (
          <p className="text-cell text-ink-2">
            {CALC_PROBLEM_LABELS[result.calcProblem] ?? result.calcProblem}
          </p>
        ) : null}
        <dl className="grid grid-cols-3 gap-3 text-cell">
          <div>
            <dt className="text-muted">Expected</dt>
            <dd className="font-medium">
              <Money amount={result.expected} />
            </dd>
          </div>
          <div>
            <dt className="text-muted">Received</dt>
            <dd className="font-medium">
              <Money amount={result.received} />
            </dd>
          </div>
          <div>
            <dt className="text-muted">Difference</dt>
            <dd className="font-medium">
              <Money
                amount={result.difference}
                tone={showsLoss(result.status) ? "difference" : "neutral"}
              />
            </dd>
          </div>
        </dl>
        {result.flags.length > 0 ? (
          <ul className="flex flex-col gap-1 text-cell text-ink-2">
            {result.flags.map((flag) => (
              <li key={flag}>{FLAG_LABELS[flag] ?? flag}</li>
            ))}
          </ul>
        ) : null}
        {result.dueDate ? (
          <p className="text-label text-muted">
            Due {formatDate(result.dueDate)}; checked against data up to {formatDate(result.asOf)}.
          </p>
        ) : null}
      </Section>

      <Section title="The order">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-cell">
          <dt className="text-muted">Channel</dt>
          <dd>
            {order.channel}
            {order.courier ? ` with ${order.courier}` : ""}
          </dd>
          <dt className="text-muted">Value</dt>
          <dd>
            <Money amount={order.value} />
          </dd>
          <dt className="text-muted">Payment</dt>
          <dd>{order.paymentType === "COD" ? "Cash on delivery" : "Prepaid"}</dd>
          <dt className="text-muted">Delivery status</dt>
          <dd>{order.deliveryStatus}</dd>
          <dt className="text-muted">Order date</dt>
          <dd>{formatDate(order.orderDate)}</dd>
          {order.awb ? (
            <>
              <dt className="text-muted">AWB</dt>
              <dd>{order.awb}</dd>
            </>
          ) : null}
          {order.weightGrams !== null ? (
            <>
              <dt className="text-muted">Weight</dt>
              <dd>{order.weightGrams} g</dd>
            </>
          ) : null}
        </dl>
      </Section>

      <Section title="How the expected amount was worked out">
        {working.length > 0 ? (
          <>
            <AmountList items={working} total={{ label: "Expected", amount: result.expected }} />
            {result.rateCard ? (
              <p className="text-label text-muted">
                Rate card version {result.rateCard.versionNo}
                {result.rateCard.isSampleData ? " (sample values)" : ""}.
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-cell text-muted">No expected amount could be worked out.</p>
        )}
      </Section>

      <Section title="What counted as received">
        {received.length > 0 ? (
          <AmountList items={received} total={{ label: "Received", amount: result.received }} />
        ) : (
          <p className="text-cell text-muted">
            {noLines ? "No payment line matched this order." : "Nothing counted as received."}
          </p>
        )}
      </Section>

      <Section title="Lines from the uploaded files">
        {noLines ? (
          <p className="text-cell text-muted">
            No line from any uploaded file was matched to this order by its ID or AWB.
          </p>
        ) : (
          <ul className="flex flex-col gap-2 text-cell">
            {lines.settlement.map((line) => (
              <LineItem
                key={line.id}
                title={`Settlement from ${line.partner}`}
                detail={`${formatDate(line.date)} \u00b7 ${line.type}${line.tcs !== "0.00" || line.tds !== "0.00" ? ` \u00b7 TCS ${line.tcs}, TDS ${line.tds}` : ""}`}
                amount={line.amount}
                file={line.file}
                row={line.row}
              />
            ))}
            {lines.codRemittance.map((line) => (
              <LineItem
                key={line.id}
                title={`COD remittance from ${line.partner}`}
                detail={`${formatDate(line.date)}${line.reference ? ` \u00b7 ${line.reference}` : ""}`}
                amount={line.amount}
                file={line.file}
                row={line.row}
              />
            ))}
            {lines.freight.map((line) => (
              <LineItem
                key={line.id}
                title={`Freight invoice ${line.invoiceNo} from ${line.partner}`}
                detail={`${line.date ? `${formatDate(line.date)} \u00b7 ` : ""}${line.chargeType.toLowerCase().replace("_", " ")}`}
                amount={line.amount}
                file={line.file}
                row={line.row}
              />
            ))}
            {lines.returnScans.map((line) => (
              <LineItem
                key={line.id}
                title="Warehouse return scan"
                detail={formatDate(line.date)}
                amount={null}
                file={line.file}
                row={line.row}
              />
            ))}
          </ul>
        )}
        <p className="text-label text-muted">Calculated {formatDateTime(result.computedAt)}.</p>
      </Section>
    </>
  );
}

function LineItem({
  title,
  detail,
  amount,
  file,
  row,
}: {
  title: string;
  detail: string;
  amount: string | null;
  file: string;
  row: number;
}) {
  return (
    <li className="flex items-start justify-between gap-3 rounded-ui border border-border p-2">
      <div className="min-w-0">
        <p className="font-medium text-ink">{title}</p>
        <p className="text-muted">{detail}</p>
        <p className="break-all text-label text-muted">
          {file}, row {row}
        </p>
      </div>
      {amount !== null ? <Money amount={amount} /> : null}
    </li>
  );
}
