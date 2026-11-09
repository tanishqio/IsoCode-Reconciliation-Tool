import { Link } from "react-router-dom";
import { EmptyState } from "../../components/feedback";
import { Badge, Button, Money, cn } from "../../components/ui";
import type { MoneyAtRisk, PartnerRisk, RiskFigures } from "./dashboard-api";
import {
  KIND_LABELS,
  formatCount,
  formatDataDate,
  formatWhen,
  isPositive,
  percentOf,
  pluralise,
  sumAmounts,
} from "./dashboard-model";
import { stickyFirst, td, tdTotal, th } from "./table-styles";

export interface MoneyAtRiskViewProps {
  data: MoneyAtRisk;
  /** The finance executive can go to Uploads from the empty state. */
  canUpload: boolean;
}

/** A money amount that is at risk: red, and a dash when there is nothing. */
function AtRisk({ amount, strong = false }: { amount: string; strong?: boolean }) {
  return isPositive(amount) ? (
    <Money amount={amount} className={cn("text-risk", strong && "font-semibold")} />
  ) : (
    <Money amount={null} />
  );
}

function StatCard({
  label,
  children,
  note,
}: {
  label: string;
  children: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <div className="rounded-ui border border-border bg-page p-4">
      <dt className="text-label font-medium uppercase tracking-wider text-muted">{label}</dt>
      <dd className="mt-1 text-title font-semibold text-ink">{children}</dd>
      {note ? <dd className="mt-0.5 text-cell text-muted">{note}</dd> : null}
    </div>
  );
}

function olderThan60(figures: RiskFigures, bands: MoneyAtRisk["ageBuckets"]): string {
  return sumAmounts(
    figures.byAge
      .filter((_, index) => (bands[index]?.fromDays ?? 0) >= 61)
      .map((age) => age.amount),
  );
}

function NotIncluded({ data }: { data: MoneyAtRisk }) {
  const { pending, cannotCalculate, notTracked, overpaid } = data.notIncluded;
  const items: string[] = [];
  if (pending > 0) items.push(`${pluralise(pending, "order")} not yet due`);
  if (cannotCalculate > 0)
    items.push(
      `${pluralise(cannotCalculate, "order")} that could not be calculated (no rate card or weight)`,
    );
  if (notTracked > 0)
    items.push(`${pluralise(notTracked, "order")} paid outside the files uploaded`);
  if (overpaid > 0) items.push(`${pluralise(overpaid, "order")} paid more than expected`);
  if (items.length === 0) return null;
  return (
    <p className="text-cell text-muted">
      <span className="font-medium text-ink-2">Not counted here:</span> {items.join("; ")}.
    </p>
  );
}

export function MoneyAtRiskView({ data, canUpload }: MoneyAtRiskViewProps) {
  if (!data.hasResults) {
    return (
      <EmptyState
        title="No results yet"
        description="Money at risk appears here once files are uploaded and the orders have been matched and calculated."
        action={
          canUpload ? (
            <Button variant="primary" asChild>
              <Link to="/uploads">Go to Uploads</Link>
            </Button>
          ) : undefined
        }
      />
    );
  }

  const { totals, partners, ageBuckets } = data;
  const nothingAtRisk = !isPositive(totals.cashAtRisk) && totals.returnsNotReceived.orders === 0;
  const aged = olderThan60(totals, ageBuckets);
  const agedShare = percentOf(aged, totals.cashAtRisk);
  const biggest = partners[0];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <p className="text-body text-muted">
          {data.asOf ? (
            <>
              Based on data up to{" "}
              <strong className="font-medium text-ink">{formatDataDate(data.asOf)}</strong>
              {data.computedAt ? `, calculated ${formatWhen(data.computedAt)}` : ""}.
            </>
          ) : null}
        </p>
        {data.settingsAreSample ? (
          <p className="rounded-ui border border-border bg-surface px-4 py-3 text-body text-ink-2">
            <strong className="font-medium text-ink">Sample settings.</strong> The due dates, the
            return window and the gap that counts as a difference use demo numbers until the finance
            team confirms them.
          </p>
        ) : null}
      </div>

      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Cash at risk"
          note={`${pluralise(totals.orders, "order")} with money missing`}
        >
          <AtRisk amount={totals.cashAtRisk} strong />
        </StatCard>
        <StatCard
          label="Older than 60 days"
          note={agedShare === null ? "Nothing outstanding" : `${agedShare}% of cash at risk`}
        >
          <AtRisk amount={aged} />
        </StatCard>
        <StatCard
          label="Most at risk"
          note={biggest ? <AtRisk amount={biggest.cashAtRisk} /> : "No partner owes money"}
        >
          {biggest ? biggest.name : "\u2014"}
        </StatCard>
        <StatCard
          label="Returns not received"
          note={
            <>
              Order value <Money amount={totals.returnsNotReceived.orderValue} />
            </>
          }
        >
          {formatCount(totals.returnsNotReceived.orders)}
        </StatCard>
      </dl>

      {nothingAtRisk ? (
        <EmptyState
          title="No money at risk"
          description={`None of the ${pluralise(data.orderCount, "calculated order")} is short-paid, unpaid past due, overcharged for freight or missing a return.`}
        />
      ) : (
        <>
          <section aria-labelledby="by-partner-heading">
            <h2 id="by-partner-heading" className="mb-1 text-section font-semibold text-ink">
              By partner and age
            </h2>
            <p className="mb-3 text-cell text-muted">
              Money we should have received and did not, by how long ago it was due.
            </p>
            <div className="overflow-auto border-t border-border-strong">
              <table className="w-full min-w-[820px] border-collapse">
                <thead>
                  <tr className="text-left">
                    <th scope="col" className={cn(th, stickyFirst)}>
                      Partner
                    </th>
                    {ageBuckets.map((band) => (
                      <th key={band.key} scope="col" className={cn(th, "text-right")}>
                        {band.label}
                      </th>
                    ))}
                    <th scope="col" className={cn(th, "text-right")}>
                      Total at risk
                    </th>
                    <th scope="col" className={cn(th, "text-right")}>
                      Returns not received
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {partners.map((partner) => (
                    <PartnerRow key={partner.id} partner={partner} bands={ageBuckets} />
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" className={cn(tdTotal, "text-left", stickyFirst)}>
                      All partners
                    </th>
                    {totals.byAge.map((age) => (
                      <td key={age.key} className={cn(tdTotal, "text-right")}>
                        <AtRisk amount={age.amount} />
                      </td>
                    ))}
                    <td className={cn(tdTotal, "text-right")}>
                      <AtRisk amount={totals.cashAtRisk} strong />
                    </td>
                    <td className={cn(tdTotal, "text-right")}>
                      <ReturnsCell figures={totals.returnsNotReceived} />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          <section aria-labelledby="by-problem-heading">
            <h2 id="by-problem-heading" className="mb-3 text-section font-semibold text-ink">
              By problem
            </h2>
            <div className="overflow-auto border-t border-border-strong">
              <table className="w-full min-w-[560px] border-collapse">
                <thead>
                  <tr className="text-left">
                    <th scope="col" className={cn(th, stickyFirst)}>
                      Problem
                    </th>
                    <th scope="col" className={cn(th, "text-right")}>
                      Orders
                    </th>
                    <th scope="col" className={cn(th, "text-right")}>
                      Amount
                    </th>
                    <th scope="col" className={th}>
                      What it means
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <ProblemRow
                    name="Short-paid"
                    figures={totals.byType.shortPaid}
                    meaning="Paid less than the rate card says it should have been."
                  />
                  <ProblemRow
                    name="Unpaid past due"
                    figures={totals.byType.unpaidPastDue}
                    meaning="No payment arrived by the due date."
                  />
                  <ProblemRow
                    name="Freight overcharged"
                    figures={totals.byType.freightOvercharged}
                    meaning="The courier billed more than the rate card allows."
                  />
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" className={cn(tdTotal, "text-left", stickyFirst)}>
                      Cash at risk
                    </th>
                    <td className={cn(tdTotal, "text-right tabular-nums")}>
                      {formatCount(totals.orders)}
                    </td>
                    <td className={cn(tdTotal, "text-right")}>
                      <AtRisk amount={totals.cashAtRisk} strong />
                    </td>
                    <td className={tdTotal} />
                  </tr>
                  <tr>
                    <th scope="row" className={cn(td, "text-left font-medium", stickyFirst)}>
                      Returns not received
                    </th>
                    <td className={cn(td, "text-right tabular-nums")}>
                      {formatCount(totals.returnsNotReceived.orders)}
                    </td>
                    <td className={cn(td, "text-right")}>
                      <Money amount={totals.returnsNotReceived.orderValue} />
                    </td>
                    <td className={cn(td, "text-muted")}>
                      Shown apart: valued at the selling price, not the cost.
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        </>
      )}

      <NotIncluded data={data} />

      <details className="rounded-ui border border-border bg-page px-4 py-3 text-body text-ink-2">
        <summary className="cursor-pointer font-medium text-ink">How this is worked out</summary>
        <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5">
          <li>
            Money at risk is money we should have received and did not. GST TCS and income tax TDS
            that a partner withheld are not counted; they are on the TCS and TDS tab.
          </li>
          <li>
            Age is the days since the money was due (the delivery date, or the order date, when
            there is no due date) up to the newest date in the uploaded data.{" "}
            <Badge>Assumption</Badge> The bands are 0 to 30, 31 to 60, 61 to 90 and over 90 days.
          </li>
          <li>
            Each amount is shown against the partner that owes it: cash on delivery, freight and
            lost returns against the courier, other payments against the sales channel.{" "}
            <Badge>Assumption</Badge>
          </li>
          <li>
            A return that never arrived is valued at the order&apos;s selling price, because the
            cost is not in the files. It is kept apart from cash at risk. <Badge>Assumption</Badge>
          </li>
        </ul>
      </details>
    </div>
  );
}

function PartnerRow({
  partner,
  bands,
}: {
  partner: PartnerRisk;
  bands: MoneyAtRisk["ageBuckets"];
}) {
  return (
    <tr className="group">
      <th scope="row" className={cn(td, "text-left font-normal", stickyFirst)}>
        <span className="font-medium text-ink">{partner.name}</span>
        {partner.kind ? (
          <span className="ml-2 text-label text-muted">
            {KIND_LABELS[partner.kind] ?? partner.kind}
          </span>
        ) : null}
      </th>
      {partner.byAge.map((age, index) => {
        const old = (bands[index]?.fromDays ?? 0) >= 61 && isPositive(age.amount);
        return (
          <td key={age.key} className={cn(td, "text-right", old && "bg-risk-tint")}>
            <AtRisk amount={age.amount} />
          </td>
        );
      })}
      <td className={cn(td, "text-right")}>
        <AtRisk amount={partner.cashAtRisk} strong />
      </td>
      <td className={cn(td, "text-right")}>
        <ReturnsCell figures={partner.returnsNotReceived} />
      </td>
    </tr>
  );
}

function ReturnsCell({ figures }: { figures: { orders: number; orderValue: string } }) {
  if (figures.orders === 0) return <Money amount={null} />;
  return (
    <span className="tabular-nums">
      {formatCount(figures.orders)}
      <span className="text-muted">
        {" "}
        (<Money amount={figures.orderValue} />)
      </span>
    </span>
  );
}

function ProblemRow({
  name,
  figures,
  meaning,
}: {
  name: string;
  figures: { orders: number; amount: string };
  meaning: string;
}) {
  return (
    <tr className="group">
      <th scope="row" className={cn(td, "text-left font-medium text-ink", stickyFirst)}>
        {name}
      </th>
      <td className={cn(td, "text-right tabular-nums")}>{formatCount(figures.orders)}</td>
      <td className={cn(td, "text-right")}>
        <AtRisk amount={figures.amount} />
      </td>
      <td className={cn(td, "text-muted")}>{meaning}</td>
    </tr>
  );
}
