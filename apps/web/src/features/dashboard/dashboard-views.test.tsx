import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AuditEntry, MoneyAtRisk, PartnerRisk, TaxSummary } from "./dashboard-api";
import { ActivityView } from "./ActivityView";
import { MoneyAtRiskView } from "./MoneyAtRiskView";
import { TaxSummaryView } from "./TaxSummaryView";

const html = (node: React.ReactNode) => renderToString(<MemoryRouter>{node}</MemoryRouter>);
const noop = () => undefined;

const BANDS = [
  { key: "0-30", label: "0 to 30 days", fromDays: 0, toDays: 30 },
  { key: "31-60", label: "31 to 60 days", fromDays: 31, toDays: 60 },
  { key: "61-90", label: "61 to 90 days", fromDays: 61, toDays: 90 },
  { key: "90+", label: "Over 90 days", fromDays: 91, toDays: null },
];

const age = (...amounts: string[]) =>
  amounts.map((amount, index) => ({
    key: BANDS[index]?.key ?? "",
    amount,
    orders: amount === "0.00" ? 0 : 1,
  }));

function partner(overrides: Partial<PartnerRisk> & { name: string }): PartnerRisk {
  return {
    id: overrides.name,
    kind: "COURIER_AGGREGATOR",
    cashAtRisk: "0.00",
    orders: 0,
    byType: {
      shortPaid: { orders: 0, amount: "0.00" },
      unpaidPastDue: { orders: 0, amount: "0.00" },
      freightOvercharged: { orders: 0, amount: "0.00" },
    },
    byAge: age("0.00", "0.00", "0.00", "0.00"),
    returnsNotReceived: { orders: 0, orderValue: "0.00" },
    ...overrides,
  };
}

const RISK: MoneyAtRisk = {
  hasResults: true,
  orderCount: 18,
  asOf: "2026-11-30T00:00:00.000Z",
  computedAt: "2026-12-01T10:30:00.000Z",
  settingsAreSample: true,
  ageBuckets: BANDS,
  totals: {
    cashAtRisk: "2143.50",
    orders: 12,
    byType: {
      shortPaid: { orders: 8, amount: "158.50" },
      unpaidPastDue: { orders: 2, amount: "1909.00" },
      freightOvercharged: { orders: 2, amount: "76.00" },
    },
    byAge: age("568.00", "1414.00", "109.50", "52.00"),
    returnsNotReceived: { orders: 1, orderValue: "2398.00" },
  },
  partners: [
    partner({
      name: "Aggregator 1",
      cashAtRisk: "1455.00",
      orders: 2,
      byAge: age("0.00", "1409.00", "0.00", "46.00"),
      returnsNotReceived: { orders: 1, orderValue: "2398.00" },
    }),
    partner({
      name: "Marketplace 2",
      kind: "MARKETPLACE",
      cashAtRisk: "100.50",
      orders: 1,
      byAge: age("0.00", "0.00", "100.50", "0.00"),
    }),
  ],
  notIncluded: { pending: 1, cannotCalculate: 2, notTracked: 0, overpaid: 1, settled: 5 },
};

describe("MoneyAtRiskView with results", () => {
  const page = html(<MoneyAtRiskView data={RISK} canUpload />);

  it("shows the headline numbers", () => {
    expect(page).toContain("Cash at risk");
    expect(page).toContain("\u20B92,143.50");
    expect(page).toContain("12 orders with money missing");
    expect(page).toContain("Older than 60 days");
    expect(page).toContain("\u20B9161.50");
    expect(page).toContain("8% of cash at risk");
    expect(page).toContain("Most at risk");
    expect(page).toContain("Aggregator 1");
    expect(page).toContain("Returns not received");
  });

  it("states what date the numbers are as of", () => {
    expect(page).toContain("30 Nov 2026");
    expect(page).toContain("Based on data up to");
  });

  it("lists partners with one column per age band and a total row", () => {
    for (const band of BANDS) expect(page).toContain(band.label);
    expect(page.indexOf("Aggregator 1")).toBeLessThan(page.indexOf("Marketplace 2"));
    expect(page).toContain("\u20B91,455.00");
    expect(page).toContain("\u20B91,409.00");
    expect(page).toContain("All partners");
    expect(page).toContain("Courier");
    expect(page).toContain("Marketplace");
  });

  it("shows a dash instead of a zero amount, so the table stays quiet", () => {
    expect(page).not.toContain("\u20B90.00");
    expect(page).toContain("No amount");
  });

  it("marks money older than 60 days with the risk tint, and nothing else", () => {
    const tinted = page.match(/bg-risk-tint/g)?.length ?? 0;
    // Aggregator 1: the over-90 cell; Marketplace 2: the 61 to 90 cell.
    expect(tinted).toBe(2);
  });

  it("shows returns separately, with their order value", () => {
    const plain = page.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");
    expect(plain).toContain("1 (\u20B92,398.00)");
    expect(page).toContain("\u20B92,398.00");
    expect(page).toContain("Shown apart");
  });

  it("breaks the cash down by problem", () => {
    expect(page).toContain("Short-paid");
    expect(page).toContain("Unpaid past due");
    expect(page).toContain("Freight overcharged");
    expect(page).toContain("\u20B91,909.00");
    expect(page).toContain("\u20B9158.50");
  });

  it("is honest about what is not counted and what is assumed", () => {
    expect(page).toContain("Not counted here:");
    expect(page).toContain("1 order not yet due");
    expect(page).toContain("2 orders that could not be calculated");
    expect(page).toContain("1 order paid more than expected");
    expect(page).not.toContain("paid outside the files");
    expect(page).toContain("How this is worked out");
    expect((page.match(/Assumption/g) ?? []).length).toBe(3);
    expect(page).toContain("Sample settings.");
  });

  it("uses red only on the money at risk", () => {
    expect(page).toContain("text-risk");
    expect(page).not.toContain("bg-red");
  });

  it("hides the sample-settings note once the settings are confirmed", () => {
    expect(
      html(<MoneyAtRiskView data={{ ...RISK, settingsAreSample: false }} canUpload />),
    ).not.toContain("Sample settings.");
  });
});

describe("MoneyAtRiskView without money at risk", () => {
  it("tells the executive to upload and links to Uploads when there are no results", () => {
    const text = html(
      <MoneyAtRiskView
        data={{
          ...RISK,
          hasResults: false,
          orderCount: 0,
          partners: [],
          asOf: null,
          computedAt: null,
        }}
        canUpload
      />,
    );
    expect(text).toContain("No results yet");
    expect(text).toContain('href="/uploads"');
  });

  it("does not send the co-founder to Uploads", () => {
    const text = html(
      <MoneyAtRiskView
        data={{
          ...RISK,
          hasResults: false,
          orderCount: 0,
          partners: [],
          asOf: null,
          computedAt: null,
        }}
        canUpload={false}
      />,
    );
    expect(text).toContain("No results yet");
    expect(text).not.toContain("/uploads");
  });

  it("says so plainly when every order is fine", () => {
    const text = html(
      <MoneyAtRiskView
        data={{
          ...RISK,
          partners: [],
          totals: {
            ...RISK.totals,
            cashAtRisk: "0.00",
            orders: 0,
            returnsNotReceived: { orders: 0, orderValue: "0.00" },
          },
        }}
        canUpload
      />,
    );
    expect(text).toContain("No money at risk");
    expect(text).toContain("18 calculated orders");
    expect(text).not.toContain("By partner and age");
  });

  it("still shows a lost return when no cash is missing", () => {
    const text = html(
      <MoneyAtRiskView
        data={{
          ...RISK,
          partners: [RISK.partners[0] as PartnerRisk],
          totals: { ...RISK.totals, cashAtRisk: "0.00", orders: 0 },
        }}
        canUpload
      />,
    );
    expect(text).not.toContain("No money at risk");
    expect(text).toContain("By partner and age");
  });
});

const TAX: TaxSummary = {
  month: null,
  months: ["2026-11", "2026-10"],
  partners: [
    {
      id: "m1",
      name: "Marketplace 1",
      kind: "MARKETPLACE",
      lines: 3,
      tcs: "190.25",
      tds: "19.00",
      total: "209.25",
    },
    {
      id: "q1",
      name: "Quick Commerce 1",
      kind: "QUICK_COMMERCE",
      lines: 1,
      tcs: "7.50",
      tds: "0.75",
      total: "8.25",
    },
  ],
  totals: { lines: 4, tcs: "197.75", tds: "19.75", total: "217.50" },
};

describe("TaxSummaryView", () => {
  const page = html(<TaxSummaryView data={TAX} onMonthChange={noop} />);

  it("shows TCS and TDS in their own columns for each partner, with totals", () => {
    expect(page).toContain("GST TCS");
    expect(page).toContain("Income tax TDS");
    expect(page).toContain("Total withheld");
    expect(page).toContain("Marketplace 1");
    expect(page).toContain("\u20B9190.25");
    expect(page).toContain("\u20B919.00");
    expect(page).toContain("\u20B9209.25");
    expect(page).toContain("\u20B9197.75");
    expect(page).toContain("\u20B9217.50");
  });

  it("explains that the tax is not leakage and where the numbers come from", () => {
    expect(page).toContain("Tax withheld, not leakage.");
    expect(page).toContain("never counted as money at risk");
    expect(page).toContain("including lines not yet matched to an order");
  });

  it("offers every month with data, and all dates", () => {
    expect(page).toContain("All dates");
    expect(page).toContain("November 2026");
    expect(page).toContain("October 2026");
    expect(page).toContain("Period");
  });

  it("does not use the risk colour, because tax withheld is not a loss", () => {
    expect(page).not.toContain("text-risk");
  });

  it("selects the chosen month", () => {
    const chosen = html(
      <TaxSummaryView data={{ ...TAX, month: "2026-10" }} onMonthChange={noop} />,
    );
    expect(chosen).toMatch(/<option value="2026-10" selected/);
  });

  it("says there are no settlement lines when nothing was uploaded", () => {
    const empty = html(
      <TaxSummaryView
        data={{
          month: null,
          months: [],
          partners: [],
          totals: { lines: 0, tcs: "0.00", tds: "0.00", total: "0.00" },
        }}
        onMonthChange={noop}
      />,
    );
    expect(empty).toContain("No settlement lines yet");
    expect(empty).not.toContain("Period");
  });

  it("says so when a chosen month has nothing but others do", () => {
    const empty = html(
      <TaxSummaryView
        data={{
          ...TAX,
          month: "2026-01",
          partners: [],
          totals: { lines: 0, tcs: "0.00", tds: "0.00", total: "0.00" },
        }}
        onMonthChange={noop}
      />,
    );
    expect(empty).toContain("No settlements in this period");
    expect(empty).toContain("Period");
  });
});

const entry = (overrides: Partial<AuditEntry>): AuditEntry => ({
  id: crypto.randomUUID(),
  createdAt: "2026-11-09T10:00:00.000Z",
  action: "LOGIN",
  label: "Signed in",
  entityType: "USER",
  entityId: null,
  user: { id: "u1", name: "Asha Executive", role: "FINANCE_EXECUTIVE" },
  meta: {},
  ...overrides,
});

describe("ActivityView", () => {
  it("lists who did what, with friendly details and no raw ids", () => {
    const text = html(
      <ActivityView
        items={[
          entry({
            action: "MAPPING_APPROVED",
            label: "Approved a column mapping",
            entityType: "MAPPING_VERSION",
            entityId: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
            meta: { versionNo: 2, queuedFiles: 3, fileId: "88888888-aaaa-4bbb-8ccc-dddddddddddd" },
          }),
          entry({ action: "LOGIN_FAILED", label: "Failed sign-in", user: null }),
        ]}
        hasMore={false}
        loadingMore={false}
        onLoadMore={noop}
      />,
    );
    expect(text).toContain("Asha Executive");
    expect(text).toContain("Approved a column mapping");
    expect(text).toContain("version 2");
    expect(text).toContain("3 files queued");
    expect(text).toContain("Not signed in");
    expect(text).toContain("Refused");
    expect(text).not.toContain("99999999");
    expect(text).not.toContain("88888888");
  });

  it("falls back to what the entry was about when there are no details", () => {
    const text = html(
      <ActivityView items={[entry({})]} hasMore={false} loadingMore={false} onLoadMore={noop} />,
    );
    expect(text).toContain("Account");
  });

  it("offers older activity only when there is more", () => {
    const base = { items: [entry({})], loadingMore: false, onLoadMore: noop };
    expect(html(<ActivityView {...base} hasMore />)).toContain("Show older activity");
    expect(html(<ActivityView {...base} hasMore={false} />)).not.toContain("Show older activity");
    expect(html(<ActivityView {...base} hasMore loadingMore />)).toContain("Loading");
  });

  it("explains an empty list", () => {
    const text = html(
      <ActivityView items={[]} hasMore={false} loadingMore={false} onLoadMore={noop} />,
    );
    expect(text).toContain("No activity yet");
  });

  it("says the log holds no customer data and cannot be edited", () => {
    const text = html(
      <ActivityView items={[entry({})]} hasMore={false} loadingMore={false} onLoadMore={noop} />,
    );
    expect(text).toContain("holds no customer data");
    expect(text).toContain("Only the co-founder");
  });
});
