import { EmptyState } from "../../components/feedback";
import { Money, SelectField, cn } from "../../components/ui";
import type { TaxSummary } from "./dashboard-api";
import { KIND_LABELS, formatCount, monthLabel } from "./dashboard-model";
import { stickyFirst, td, tdTotal, th } from "./table-styles";

export interface TaxSummaryViewProps {
  data: TaxSummary;
  /** Called with a month (2026-10) or null for all dates. */
  onMonthChange: (month: string | null) => void;
}

export function TaxSummaryView({ data, onMonthChange }: TaxSummaryViewProps) {
  const hasAnyMonth = data.months.length > 0;
  const options = [
    { value: "", label: "All dates" },
    ...data.months.map((month) => ({ value: month, label: monthLabel(month) })),
  ];

  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-ui border border-border bg-surface px-4 py-3 text-body text-ink-2">
        <strong className="font-medium text-ink">Tax withheld, not leakage.</strong> GST TCS and
        income tax TDS are taken by the partner from our payouts and can be claimed back as tax
        credits. They are shown here on their own and are never counted as money at risk.
      </p>

      {hasAnyMonth ? (
        <SelectField
          label="Period"
          value={data.month ?? ""}
          onChange={(event) => onMonthChange(event.target.value === "" ? null : event.target.value)}
          options={options}
          className="w-full sm:w-64"
        />
      ) : null}

      {data.partners.length === 0 ? (
        <EmptyState
          title={hasAnyMonth ? "No settlements in this period" : "No settlement lines yet"}
          description={
            hasAnyMonth
              ? "Choose another period, or all dates."
              : "TCS and TDS appear here once a marketplace or quick-commerce settlement file has been uploaded."
          }
        />
      ) : (
        <>
          <div className="overflow-auto border-t border-border-strong">
            <table className="w-full min-w-[640px] border-collapse">
              <caption className="sr-only">
                GST TCS and income tax TDS withheld, by partner
                {data.month ? `, ${monthLabel(data.month)}` : ""}
              </caption>
              <thead>
                <tr className="text-left">
                  <th scope="col" className={cn(th, stickyFirst)}>
                    Partner
                  </th>
                  <th scope="col" className={cn(th, "text-right")}>
                    Settlement lines
                  </th>
                  <th scope="col" className={cn(th, "text-right")}>
                    GST TCS
                  </th>
                  <th scope="col" className={cn(th, "text-right")}>
                    Income tax TDS
                  </th>
                  <th scope="col" className={cn(th, "text-right")}>
                    Total withheld
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.partners.map((partner) => (
                  <tr key={partner.id} className="group">
                    <th scope="row" className={cn(td, "text-left font-normal", stickyFirst)}>
                      <span className="font-medium text-ink">{partner.name}</span>
                      <span className="ml-2 text-label text-muted">
                        {KIND_LABELS[partner.kind] ?? partner.kind}
                      </span>
                    </th>
                    <td className={cn(td, "text-right tabular-nums")}>
                      {formatCount(partner.lines)}
                    </td>
                    <td className={cn(td, "text-right")}>
                      <Money amount={partner.tcs} />
                    </td>
                    <td className={cn(td, "text-right")}>
                      <Money amount={partner.tds} />
                    </td>
                    <td className={cn(td, "text-right font-medium")}>
                      <Money amount={partner.total} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" className={cn(tdTotal, "text-left", stickyFirst)}>
                    All partners
                  </th>
                  <td className={cn(tdTotal, "text-right tabular-nums")}>
                    {formatCount(data.totals.lines)}
                  </td>
                  <td className={cn(tdTotal, "text-right")}>
                    <Money amount={data.totals.tcs} />
                  </td>
                  <td className={cn(tdTotal, "text-right")}>
                    <Money amount={data.totals.tds} />
                  </td>
                  <td className={cn(tdTotal, "text-right")}>
                    <Money amount={data.totals.total} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-cell text-muted">
            Taken from the settlement files, including lines not yet matched to an order.
          </p>
        </>
      )}
    </div>
  );
}
