import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "../../components/feedback";
import { Badge, Button, PageHeader, cn } from "../../components/ui";
import { getErrorMessage, isApiError } from "../../lib/api-error";
import { useCurrentUser } from "../auth/use-current-user";
import { RateCardDetailDialog } from "./RateCardDetailDialog";
import { RateCardFormDialog, type FormState } from "./RateCardFormDialog";
import { listRateCards, RATE_CARDS_KEY, type RateCard } from "./rate-cards-api";
import { describeEffective } from "./rate-cards-model";

const th =
  "h-9 whitespace-nowrap border-b border-border-strong bg-page px-3 text-label font-medium uppercase tracking-wider text-muted";
const td = "h-10 whitespace-nowrap border-b border-border px-3 text-cell group-hover:bg-surface";
const stickyFirst =
  "max-sm:sticky max-sm:left-0 max-sm:border-r max-sm:border-r-border max-sm:bg-page";

export function RateCardsPage() {
  const user = useCurrentUser();
  const canEdit = user?.role === "FINANCE_EXECUTIVE";

  const [includeOlder, setIncludeOlder] = useState(false);
  const [viewing, setViewing] = useState<RateCard | null>(null);
  const [form, setForm] = useState<FormState | null>(null);

  const query = useQuery({
    queryKey: [...RATE_CARDS_KEY, { includeOlder }],
    queryFn: ({ signal }) => listRateCards(includeOlder, signal),
  });
  const cards = query.data ?? [];
  const showsSample = cards.some((card) => card.isSampleData);

  return (
    <>
      <PageHeader
        title="Rate cards"
        description="The price list for each channel and courier. It is used to work out the amount we should receive for every order."
        actions={
          canEdit ? (
            <Button variant="primary" onClick={() => setForm({ mode: "create" })}>
              New rate card
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-col gap-4">
        {showsSample ? (
          <p className="rounded-ui border border-border bg-surface px-4 py-3 text-body text-ink-2">
            Cards marked <strong className="font-medium text-ink">Sample values</strong> use demo
            numbers, not real partner rates.
            {canEdit ? " Edit a card and untick the sample box once you have the real rates." : ""}
          </p>
        ) : null}

        {query.isPending ? (
          <LoadingState label={"Loading rate cards\u2026"} rows={5} />
        ) : query.isError ? (
          <ErrorState
            message={getErrorMessage(query.error)}
            requestId={isApiError(query.error) ? query.error.requestId : undefined}
            onRetry={() => void query.refetch()}
          />
        ) : cards.length === 0 ? (
          <EmptyState
            title="No rate cards yet"
            description={
              canEdit
                ? "Add a rate card for each channel and courier so expected amounts can be worked out."
                : "The finance team has not added any rate cards yet."
            }
            action={
              canEdit ? (
                <Button variant="primary" onClick={() => setForm({ mode: "create" })}>
                  New rate card
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <label className="inline-flex w-fit items-center gap-2 text-body text-ink">
              <input
                type="checkbox"
                checked={includeOlder}
                onChange={(event) => setIncludeOlder(event.target.checked)}
                className="size-4 accent-accent"
              />
              Show older versions
            </label>

            <div className="max-h-[36rem] overflow-auto border-t border-border-strong">
              <table className="w-full min-w-[760px] border-collapse">
                <thead>
                  <tr className="text-left">
                    <th scope="col" className={cn(th, "sticky top-0 z-10", stickyFirst)}>
                      Channel
                    </th>
                    <th scope="col" className={cn(th, "sticky top-0")}>
                      Courier
                    </th>
                    <th scope="col" className={cn(th, "sticky top-0")}>
                      Version
                    </th>
                    <th scope="col" className={cn(th, "sticky top-0 text-right")}>
                      Fees
                    </th>
                    <th scope="col" className={cn(th, "sticky top-0")}>
                      In effect
                    </th>
                    <th scope="col" className={cn(th, "sticky top-0")}>
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {cards.map((card) => (
                    <tr key={card.id} className="group">
                      <td className={cn(td, stickyFirst)}>
                        <button
                          type="button"
                          onClick={() => setViewing(card)}
                          className="rounded-ui font-medium text-accent hover:underline"
                          aria-label={`Open ${card.channel.name}${card.courier ? ` with ${card.courier.name}` : ""}, version ${card.versionNo}`}
                        >
                          {card.channel.name}
                        </button>
                      </td>
                      <td className={td}>{card.courier?.name ?? "\u2014"}</td>
                      <td className={td}>
                        <span className="inline-flex items-center gap-2">
                          Version {card.versionNo}
                          {card.isSampleData ? <Badge>Sample values</Badge> : null}
                        </span>
                      </td>
                      <td className={cn(td, "text-right tabular-nums")}>{card.rules.length}</td>
                      <td className={td}>{describeEffective(card)}</td>
                      <td className={td}>
                        <Badge variant={card.status === "ACTIVE" ? "accent" : "neutral"}>
                          {card.status === "ACTIVE" ? "Current" : "Older version"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <RateCardDetailDialog
        card={viewing}
        canEdit={canEdit}
        onClose={() => setViewing(null)}
        onEdit={(card) => {
          setViewing(null);
          setForm({ mode: "edit", card });
        }}
      />
      <RateCardFormDialog
        state={form}
        onClose={() => setForm(null)}
        onSaved={(card) => {
          setForm(null);
          setViewing(card);
        }}
      />
    </>
  );
}
