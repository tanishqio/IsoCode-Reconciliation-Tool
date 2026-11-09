import { describe, expect, it } from "vitest";
import { claimFor, claimLabel } from "../../../src/modules/claims/claim-rules.js";
import { buildClaimCsv, csvText } from "../../../src/modules/claims/claims-csv.js";
import {
  editDistance,
  isAmbiguous,
  rankCandidates,
  type CandidateOrder,
  type LineFacts,
  type Rules,
} from "../../../src/modules/review/suggest-rules.js";

const rules: Rules = {
  tolerancePaise: 1000n,
  codDueDays: 7,
  settlementDueDays: 14,
  returnWindowDays: 7,
};
const day = (text: string) => new Date(`${text}T00:00:00Z`);

const order = (over: Partial<CandidateOrder>): CandidateOrder => ({
  pk: "o1",
  orderId: "ORD-W-300004",
  awb: "AWB4",
  channelId: "web",
  courierId: "agg1",
  paymentType: "COD",
  orderDate: day("2026-11-01"),
  deliveredAt: day("2026-11-03"),
  returnedAt: null,
  returned: false,
  valuePaise: 159900n,
  expectedPaise: 150900n,
  freightExpectedPaise: 6000n,
  counts: { settlement: 0, codRemittance: 0, freight: 0, returnScan: 0 },
  ...over,
});

const codLine = (over: Partial<LineFacts> = {}): LineFacts => ({
  id: "l1",
  kind: "COD_REMITTANCE",
  partnerId: "agg1",
  date: day("2026-11-10"),
  amountPaise: 150900n,
  orderIdRaw: null,
  awb: null,
  ...over,
});

describe("Part 8: rule-based candidates", () => {
  it("scores an exact amount inside the usual date window as a strong candidate, and explains why", () => {
    const [top] = rankCandidates(codLine(), [order({})], rules);
    expect(top?.score).toBeGreaterThanOrEqual(75);
    expect(top?.reasons.join(" ")).toContain("amount equals the expected amount exactly");
  });

  it("uses an ID that differs only by dashes or by a typo", () => {
    const same = rankCandidates(
      codLine({ orderIdRaw: "ordw300004", amountPaise: 90000n }),
      [order({})],
      rules,
    );
    expect(same[0]?.reasons.join(" ")).toContain("same apart from dashes");
    const typo = rankCandidates(codLine({ orderIdRaw: "ORD-W-3OO004" }), [order({})], rules);
    expect(typo[0]?.reasons.join(" ")).toContain("differs by 2 characters");
    expect(editDistance("ABCDEF", "ABCXYZ", 2)).toBe(3);
  });

  it("never offers an order the partner could not have been paid for", () => {
    expect(rankCandidates(codLine({ partnerId: "other-courier" }), [order({})], rules)).toEqual([]);
    expect(rankCandidates(codLine(), [order({ paymentType: "PREPAID" })], rules)).toEqual([]);
    // A settlement belongs to the sales channel only.
    const settlement = codLine({ kind: "SETTLEMENT", partnerId: "market" });
    expect(rankCandidates(settlement, [order({})], rules)).toEqual([]);
  });

  it("ignores amounts that are far off, dates before delivery, and orders that already have this line", () => {
    expect(rankCandidates(codLine({ amountPaise: 300000n }), [order({})], rules)).toEqual([]);
    expect(rankCandidates(codLine({ date: day("2026-10-01") }), [order({})], rules)).toEqual([]);
    const paid = order({ counts: { settlement: 0, codRemittance: 1, freight: 0, returnScan: 0 } });
    expect(rankCandidates(codLine(), [paid], rules)).toEqual([]);
  });

  it("prefers the order whose delivery is closest before the payment", () => {
    const near = order({ pk: "near", deliveredAt: day("2026-11-08") });
    const far = order({ pk: "far", deliveredAt: day("2026-11-01") });
    expect(rankCandidates(codLine(), [far, near], rules).map((c) => c.orderPk)).toEqual([
      "near",
      "far",
    ]);
  });

  it("finds a payout that is a little short, and flags two equal candidates as ambiguous", () => {
    const [short] = rankCandidates(codLine({ amountPaise: 147000n }), [order({})], rules);
    expect(short?.reasons.join(" ")).toContain("within 5%");
    const twins = rankCandidates(
      codLine(),
      [order({ pk: "a" }), order({ pk: "b", orderId: "ORD-W-300005" })],
      rules,
    );
    expect(twins).toHaveLength(2);
    expect(isAmbiguous(twins)).toBe(true);
    expect(isAmbiguous(twins.slice(0, 1))).toBe(false);
  });
});

describe("Part 10: what is claimed, and the export file", () => {
  it("claims the loss for short and unpaid orders, the extra freight, and the goods of a lost return", () => {
    const base = { freightBilledPaise: 0n, freightExpectedPaise: null, orderValuePaise: 239800n };
    expect(claimFor({ ...base, status: "UNPAID_PAST_DUE", differencePaise: -140900n })).toEqual({
      type: "UNPAID",
      amountPaise: 140900n,
    });
    expect(claimFor({ ...base, status: "SHORT_PAID", differencePaise: -3700n })).toEqual({
      type: "SHORT_PAID",
      amountPaise: 3700n,
    });
    expect(
      claimFor({
        ...base,
        status: "FREIGHT_OVERCHARGED",
        differencePaise: -4600n,
        freightBilledPaise: 14200n,
        freightExpectedPaise: 9600n,
      }),
    ).toEqual({ type: "FREIGHT_OVERCHARGE", amountPaise: 4600n });
    expect(claimFor({ ...base, status: "RETURN_NOT_RECEIVED", differencePaise: null })).toEqual({
      type: "RETURN_NOT_RECEIVED",
      amountPaise: 239800n,
    });
  });

  it("does not claim settled, pending, overpaid or untracked orders", () => {
    const base = {
      differencePaise: 0n,
      freightBilledPaise: 0n,
      freightExpectedPaise: null,
      orderValuePaise: 1000n,
    };
    for (const status of [
      "SETTLED",
      "PENDING",
      "OVERPAID",
      "NOT_TRACKED",
      "CANNOT_CALCULATE",
    ] as const) {
      expect(claimFor({ ...base, status })).toBeNull();
    }
  });

  it("writes a CSV that a spreadsheet cannot run as a formula, with negative numbers left alone", () => {
    expect(csvText("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    expect(csvText('say "hi"')).toBe('"say ""hi"""');
    const csv = buildClaimCsv({
      claimNo: 7,
      partner: "Aggregator 1",
      items: [
        {
          orderId: "ORD-1",
          claimType: "SHORT_PAID",
          amount: "37.00",
          ageBasisDate: day("2026-11-17"),
          ageDays: 13,
          evidence: {
            order: {
              orderId: "ORD-1",
              channel: "Marketplace 1",
              courier: null,
              awb: null,
              orderDate: "2026-11-01T00:00:00.000Z",
              deliveredAt: null,
              returnedAt: null,
              value: "1199.00",
              paymentType: "PREPAID",
              deliveryStatus: "Delivered",
              weightGrams: 450,
            },
            result: {
              status: "SHORT_PAID",
              expected: "899.00",
              received: "862.00",
              difference: "-37.00",
              freightExpected: null,
              freightBilled: "0.00",
              dueDate: null,
              asOf: "2026-11-30T00:00:00.000Z",
              computedAt: "2026-11-30T00:00:00.000Z",
              rateCardVersion: 1,
              rateCardIsSample: true,
            },
            working: [{ label: "Order value", amount: "1199.00" }],
            received: [{ label: "Settlement payout (net)", amount: "862.00" }],
            lines: [
              {
                kind: "Settlement",
                partner: "Marketplace 1",
                date: "2026-11-30T00:00:00.000Z",
                reference: "STL-1",
                amount: "862.00",
                file: "s.csv",
                row: 2,
              },
            ],
          },
        },
      ],
    });
    expect(claimLabel(7)).toBe("CLM-0007");
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.split("\r\n")[1]).toContain(
      '"CLM-0007","Aggregator 1","ORD-1","Short-paid",37.00,899.00,862.00,-37.00',
    );
    expect(csv).toContain("s.csv, row 2");
  });
});

describe("Part 8: finding the orders near a line", () => {
  it("still finds the right courier order when orders with no courier are mixed in", async () => {
    const { OrderIndex } = await import("../../../src/modules/review/suggest-handler.js");
    // Orders with no courier (marketplace orders) have small and large amounts, so the two lists
    // the index puts together are not sorted as one.
    const mixed = [
      order({ pk: "c1", courierId: "agg1", expectedPaise: 150900n, orderId: "ORD-C1", awb: null }),
      order({ pk: "n1", courierId: null, expectedPaise: 10000n, orderId: "ORD-N1", awb: null }),
      order({ pk: "n2", courierId: null, expectedPaise: 900000n, orderId: "ORD-N2", awb: null }),
      order({ pk: "c2", courierId: "agg1", expectedPaise: 20000n, orderId: "ORD-C2", awb: null }),
    ];
    const near = new OrderIndex(mixed).near(codLine());
    expect(near.map((entry) => entry.pk)).toContain("c1");
    expect(rankCandidates(codLine(), near, rules)[0]?.orderPk).toBe("c1");
  });
});
