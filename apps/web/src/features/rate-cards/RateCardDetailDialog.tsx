import * as Dialog from "@radix-ui/react-dialog";
import { Badge, Button, Money } from "../../components/ui";
import { ExpectedAmountCheck } from "./ExpectedAmountCheck";
import type { RateCard } from "./rate-cards-api";
import {
  RULE_TYPE_LABELS,
  basisPointsToPercent,
  cardTitle,
  describeAppliesTo,
  describeEffective,
  formatDate,
} from "./rate-cards-model";

const th =
  "sticky top-0 border-b border-border-strong bg-page px-3 py-2 text-left text-label font-medium uppercase tracking-wider text-muted";
const td = "border-b border-border px-3 py-2 text-cell align-top";

/** One rate card: its fees, what it was made for, and a panel to try an order against it. */
export function RateCardDetailDialog({
  card,
  canEdit,
  onEdit,
  onClose,
}: {
  card: RateCard | null;
  canEdit: boolean;
  onEdit: (card: RateCard) => void;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open={card !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-ui border border-border bg-page p-5 shadow-overlay"
        >
          {card ? (
            <>
              <Dialog.Title className="text-section font-semibold text-ink">
                {cardTitle(card)}
              </Dialog.Title>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge variant={card.status === "ACTIVE" ? "accent" : "neutral"}>
                  {card.status === "ACTIVE" ? "Current" : "Older version"}
                </Badge>
                <Badge>Version {card.versionNo}</Badge>
                {card.isSampleData ? <Badge>Sample values</Badge> : null}
                <span className="text-cell text-muted">{describeEffective(card)}</span>
              </div>
              <p className="mt-1 text-cell text-muted">
                Saved {formatDate(card.createdAt)} by {card.createdByName}
              </p>
              {card.note ? <p className="mt-2 text-body text-ink-2">{card.note}</p> : null}

              <div className="mt-4 flex min-h-0 flex-1 flex-col gap-5 overflow-auto pr-2">
                {/* shrink-0: the dialog body scrolls as a whole; the fees never get a scroll box of their own. */}
                <div className="shrink-0 overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <th scope="col" className={th}>
                          Fee
                        </th>
                        <th scope="col" className={th}>
                          Applies to
                        </th>
                        <th scope="col" className={`${th} text-right`}>
                          Charge
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {card.rules.map((rule) => (
                        <tr key={rule.id}>
                          <td className={`${td} font-medium text-ink`}>
                            {RULE_TYPE_LABELS[rule.ruleType]}
                          </td>
                          <td className={`${td} text-ink-2`}>{describeAppliesTo(rule)}</td>
                          <td className={`${td} text-right`}>
                            {rule.basisPoints !== null ? (
                              <span className="tabular-nums">
                                {basisPointsToPercent(rule.basisPoints)}%
                              </span>
                            ) : (
                              <Money amount={rule.amount} />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <ExpectedAmountCheck key={card.id} card={card} />
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                {canEdit && card.status === "ACTIVE" ? (
                  <div className="flex flex-col items-start gap-1">
                    <Button variant="secondary" onClick={() => onEdit(card)}>
                      Edit this card
                    </Button>
                    <span className="text-label text-muted">
                      Saving an edit makes version {card.versionNo + 1}. This version is kept.
                    </span>
                  </div>
                ) : (
                  <span />
                )}
                <Dialog.Close asChild>
                  <Button variant="primary">Close</Button>
                </Dialog.Close>
              </div>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
