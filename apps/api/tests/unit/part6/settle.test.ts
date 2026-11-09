import { describe, expect, it } from "vitest";
import type { CalcRule } from "../../../src/modules/rate-cards/expected-amount.js";
import {
  settleOrder,
  type Aggregates,
  type OrderFacts,
  type Settings,
} from "../../../src/modules/reconciliation/settle.js";

const rule = (ruleType: CalcRule["ruleType"], rest: Partial<CalcRule>): CalcRule => ({
  ruleType,
  minWeightGrams: null,
  maxWeightGrams: null,
  basisPoints: null,
  amountPaise: null,
  ...rest,
});

// Rates that make the three sample rows of the assignment work out (the demo cards).
const websiteCard = [
  rule("FREIGHT_SLAB", { minWeightGrams: 0, maxWeightGrams: 500, amountPaise: 6000n }),
  rule("COD_FEE", { amountPaise: 3000n }),
  rule("REVERSE_FREIGHT", { amountPaise: 9600n }),
];
const marketplaceCard = [
  rule("COMMISSION", { basisPoints: 2000 }),
  rule("FIXED_FEE", { amountPaise: 2500n }),
  rule("FREIGHT_SLAB", { amountPaise: 3520n }),
];

const settings: Settings = {
  tolerancePaise: 1000n,
  codDueDays: 7,
  settlementDueDays: 14,
  returnWindowDays: 7,
};
const asOf = new Date("2026-11-30T00:00:00Z");
const day = (text: string) => new Date(`${text}T00:00:00Z`);

const nothing = (): Aggregates => ({
  settlementNet: 0n,
  tcs: 0n,
  tds: 0n,
  codRemitted: 0n,
  forwardFreight: 0n,
  reverseFreight: 0n,
  counts: { settlement: 0, codRemittance: 0, freight: 0, returnScan: 0 },
});

const facts = (over: Partial<OrderFacts>): OrderFacts => ({
  paymentType: "COD",
  channelKind: "WEBSITE",
  deliveryStatus: "Delivered",
  orderDate: day("2026-11-01"),
  deliveredAt: day("2026-11-03"),
  returnedAt: null,
  weightGrams: 450,
  valuePaise: 149900n,
  ...over,
});

describe("the three sample rows of the assignment", () => {
  it("row 1: a delivered COD order with nothing received is unpaid, and the loss is negative", () => {
    const verdict = settleOrder(facts({}), nothing(), websiteCard, asOf, settings);
    expect(verdict).toMatchObject({
      status: "UNPAID_PAST_DUE",
      expectedPaise: 140900n,
      receivedPaise: 0n,
      differencePaise: -140900n,
    });
  });

  it("row 2: a marketplace payout 37 rupees short is SHORT_PAID with a difference of -37", () => {
    const agg = { ...nothing(), settlementNet: 86200n };
    agg.counts.settlement = 1;
    const verdict = settleOrder(
      facts({ channelKind: "MARKETPLACE", paymentType: "PREPAID", valuePaise: 119900n }),
      agg,
      marketplaceCard,
      asOf,
      settings,
    );
    expect(verdict).toMatchObject({
      status: "SHORT_PAID",
      expectedPaise: 89900n,
      receivedPaise: 86200n,
      differencePaise: -3700n,
    });
  });

  it("row 3: a returned order whose return freight was billed above the card is FREIGHT_OVERCHARGED, -46", () => {
    const agg = { ...nothing(), reverseFreight: 14200n };
    agg.counts.freight = 1;
    agg.counts.returnScan = 1;
    const verdict = settleOrder(
      facts({
        paymentType: "PREPAID",
        deliveryStatus: "Returned to warehouse",
        returnedAt: day("2026-11-05"),
        valuePaise: 239800n,
      }),
      agg,
      websiteCard,
      asOf,
      settings,
    );
    expect(verdict).toMatchObject({
      status: "FREIGHT_OVERCHARGED",
      expectedPaise: -9600n,
      receivedPaise: -14200n,
      differencePaise: -4600n,
    });
    expect(verdict.flags).toContain("RETURN_FREIGHT_DEDUCTED");
  });
});

describe("other outcomes", () => {
  const marketplace = (over: Partial<OrderFacts> = {}) =>
    facts({ channelKind: "MARKETPLACE", paymentType: "PREPAID", valuePaise: 119900n, ...over });
  const paid = (net: bigint, tcs = 0n, tds = 0n): Aggregates => {
    const agg = { ...nothing(), settlementNet: net, tcs, tds };
    agg.counts.settlement = 1;
    return agg;
  };

  it("adds TCS and TDS back, so withheld tax is not leakage", () => {
    const verdict = settleOrder(
      marketplace(),
      paid(85000n, 4000n, 900n),
      marketplaceCard,
      asOf,
      settings,
    );
    expect(verdict).toMatchObject({
      status: "SETTLED",
      receivedPaise: 89900n,
      differencePaise: 0n,
    });
    expect(verdict.flags).toContain("TAX_ADDED_BACK");
  });

  it("allows a gap of up to 10 rupees either way, and flags a bigger overpayment", () => {
    expect(settleOrder(marketplace(), paid(88900n), marketplaceCard, asOf, settings).status).toBe(
      "SETTLED",
    );
    expect(settleOrder(marketplace(), paid(88899n), marketplaceCard, asOf, settings).status).toBe(
      "SHORT_PAID",
    );
    expect(settleOrder(marketplace(), paid(90900n), marketplaceCard, asOf, settings).status).toBe(
      "SETTLED",
    );
    expect(settleOrder(marketplace(), paid(90901n), marketplaceCard, asOf, settings).status).toBe(
      "OVERPAID",
    );
  });

  it("waits for the due date before calling an order unpaid", () => {
    const recent = facts({ deliveredAt: day("2026-11-28") });
    expect(settleOrder(recent, nothing(), websiteCard, asOf, settings).status).toBe("PENDING");
  });

  it("flags a return that never reached the warehouse only after the return window", () => {
    const returned = (returnedAt: string) =>
      facts({ deliveryStatus: "Returned", returnedAt: day(returnedAt), paymentType: "PREPAID" });
    expect(settleOrder(returned("2026-11-01"), nothing(), websiteCard, asOf, settings).status).toBe(
      "RETURN_NOT_RECEIVED",
    );
    expect(settleOrder(returned("2026-11-27"), nothing(), websiteCard, asOf, settings).status).toBe(
      "PENDING",
    );
  });

  it("does not call a Website prepaid order unpaid, because its gateway has no file here", () => {
    const verdict = settleOrder(
      facts({ paymentType: "PREPAID" }),
      nothing(),
      websiteCard,
      asOf,
      settings,
    );
    expect(verdict.status).toBe("NOT_TRACKED");
    expect(verdict.flags).toContain("PAYMENT_NOT_TRACKED");
    expect(verdict.differencePaise).toBeNull();
  });

  it("never guesses: no weight or no rate card means CANNOT_CALCULATE", () => {
    const noWeight = settleOrder(
      facts({ weightGrams: null }),
      nothing(),
      websiteCard,
      asOf,
      settings,
    );
    expect(noWeight).toMatchObject({
      status: "CANNOT_CALCULATE",
      calcProblem: "MISSING_WEIGHT",
      expectedPaise: null,
    });
    const noCard = settleOrder(facts({}), nothing(), null, asOf, settings);
    expect(noCard).toMatchObject({ status: "CANNOT_CALCULATE", calcProblem: "NO_RATE_CARD" });
  });

  it("flags freight billed above the card on an otherwise settled delivered order", () => {
    const agg = paid(86380n, 0n, 0n);
    agg.counts.freight = 1;
    agg.forwardFreight = 6000n; // card allows 35.20 for this marketplace order
    const verdict = settleOrder(marketplace(), agg, marketplaceCard, asOf, settings);
    expect(verdict.flags).toContain("FREIGHT_OVERCHARGED");
  });
});
