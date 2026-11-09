import * as Tabs from "@radix-ui/react-tabs";
import { useSearchParams } from "react-router-dom";
import { PageHeader, cn } from "../../components/ui";
import { useCurrentUser } from "../auth/use-current-user";
import { TAB_LABELS, parseTab, type TabId } from "./dashboard-model";
import { ActivityPanel, MoneyAtRiskPanel, TaxSummaryPanel } from "./panels";

const trigger =
  "-mb-px border-b-2 border-transparent px-3 py-2 text-body font-medium text-muted hover:text-ink " +
  "data-[state=active]:border-accent data-[state=active]:text-ink";

/**
 * Money at risk (the co-founder's landing page). Three tabs, kept in the address (?tab=tax) so a
 * refresh or a shared link opens the same one: Money at risk, TCS and TDS, and, for the co-founder
 * only, the Activity log.
 */
export function DashboardPage() {
  const user = useCurrentUser();
  const isCoFounder = user?.role === "CO_FOUNDER";
  const [params, setParams] = useSearchParams();

  const tab = parseTab(params.get("tab"), isCoFounder);
  const month = params.get("month") ?? null;

  const update = (changes: { tab?: TabId; month?: string | null }) => {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (changes.tab !== undefined) {
          if (changes.tab === "risk") next.delete("tab");
          else next.set("tab", changes.tab);
          if (changes.tab !== "tax") next.delete("month");
        }
        if (changes.month !== undefined) {
          if (changes.month === null) next.delete("month");
          else next.set("month", changes.month);
        }
        return next;
      },
      { replace: true },
    );
  };

  const tabs: TabId[] = isCoFounder ? ["risk", "tax", "activity"] : ["risk", "tax"];

  return (
    <>
      <PageHeader
        title="Money at risk"
        description="Money we should have received and have not, by partner and by how long it has been outstanding."
      />
      <Tabs.Root value={tab} onValueChange={(value) => update({ tab: value as TabId })}>
        <Tabs.List
          aria-label="Dashboard sections"
          className="mb-5 flex gap-1 overflow-x-auto border-b border-border"
        >
          {tabs.map((id) => (
            <Tabs.Trigger key={id} value={id} className={cn(trigger)}>
              {TAB_LABELS[id]}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="risk" className="outline-none">
          <MoneyAtRiskPanel canUpload={user?.role === "FINANCE_EXECUTIVE"} />
        </Tabs.Content>
        <Tabs.Content value="tax" className="outline-none">
          <TaxSummaryPanel month={month} onMonthChange={(value) => update({ month: value })} />
        </Tabs.Content>
        {isCoFounder ? (
          <Tabs.Content value="activity" className="outline-none">
            <ActivityPanel />
          </Tabs.Content>
        ) : null}
      </Tabs.Root>
    </>
  );
}
