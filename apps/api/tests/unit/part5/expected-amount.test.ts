import { describe, expect, it } from "vitest";
import { RATE_CARD_SEED, type RateCardSeed } from "../../../src/db/seed-rate-cards.js";
import {
  computeExpected,
  describeWeightBand,
  linesToAmounts,
  pickRateCard,
  type CalcCard,
  type CalcInput,
  type CalcRule,
} from "../../../src/modules/rate-cards/expected-amount.js";
import {
  decimalToPaise,
  paiseToAmount,
  parseAmountToPaise,
  shareOfPaise,
} from "../../../src/modules/rate-cards/money.js";

/** Turns the seed's rule inputs into calculator rules, exactly as the service does. */
function rulesOf(seed: RateCardSeed): CalcRule[] {
  return seed.rules.map((rule) => ({
    ruleType: rule.ruleType,
    minWeightGrams: rule.minWeightGrams ?? null,
    maxWeightGrams: rule.maxWeightGrams ?? null,
    basisPoints: rule.basisPoints ?? null,
    amountPaise: rule.amount == null ? null : parseAmountToPaise(rule.amount),
  }));
}

const seedFor = (channel: string, courier: string | null) => {
  const found = RATE_CARD_SEED.find((s) => s.channel === channel && s.courier === courier);
  if (!found) throw new Error(`No seed card for ${channel} / ${courier}`);
  return rulesOf(found);
};

const order = (overrides: Partial<CalcInput> = {}): CalcInput => ({
  orderValuePaise: 149_900n,
  paymentType: "COD",
  weightGrams: 450,
  isReturn: false,
  ...overrides,
});

const expectOk = (result: ReturnType<typeof computeExpected>) => {
  if (!result.ok) throw new Error(`expected a result, got ${result.code}`);
  return result;
};

describe("the three sample rows of the assignment, with the demo rate cards", () => {
  it("row 1: Website COD order of 1499 expects 1409", () => {
    const result = expectOk(computeExpected(seedFor("Website", "Aggregator 1"), order()));
    expect(paiseToAmount(result.expectedPaise)).toBe("1409.00");
    expect(linesToAmounts(result.lines)).toEqual([
      { label: "Order value", amount: "1499.00" },
      { label: "Delivery charge (0 to 500 g)", amount: "-60.00" },
      { label: "COD fee", amount: "-30.00" },
    ]);
  });

  it("row 2: Marketplace 1 prepaid order of 1199 expects 899, with no weight needed", () => {
    const result = expectOk(
      computeExpected(
        seedFor("Marketplace 1", null),
        order({ orderValuePaise: 119_900n, paymentType: "PREPAID", weightGrams: null }),
      ),
    );
    expect(paiseToAmount(result.expectedPaise)).toBe("899.00");
    expect(linesToAmounts(result.lines).map((line) => line.amount)).toEqual([
      "1199.00",
      "-239.80",
      "-25.00",
      "-35.20",
    ]);
  });

  it("row 3: a returned Website order expects minus 96", () => {
    const result = expectOk(
      computeExpected(
        seedFor("Website", "Aggregator 1"),
        order({ orderValuePaise: 239_800n, paymentType: "PREPAID", isReturn: true }),
      ),
    );
    expect(paiseToAmount(result.expectedPaise)).toBe("-96.00");
  });
});

describe("delivery charge by weight", () => {
  const rules = seedFor("Website", "Aggregator 1");
  const chargeFor = (weightGrams: number) => {
    const result = expectOk(computeExpected(rules, order({ paymentType: "PREPAID", weightGrams })));
    return paiseToAmount(149_900n - result.expectedPaise);
  };

  it("uses the band that includes the weight, edges included", () => {
    expect(chargeFor(0)).toBe("60.00");
    expect(chargeFor(500)).toBe("60.00");
    expect(chargeFor(501)).toBe("90.00");
    expect(chargeFor(1000)).toBe("90.00");
    expect(chargeFor(1001)).toBe("130.00");
    expect(chargeFor(2000)).toBe("130.00");
    expect(chargeFor(2001)).toBe("180.00");
    expect(chargeFor(50_000)).toBe("180.00");
  });

  it("does not guess when the order has no weight and the card depends on weight", () => {
    const result = computeExpected(rules, order({ weightGrams: null }));
    expect(result).toMatchObject({ ok: false, code: "MISSING_WEIGHT" });
  });

  it("says so when no band covers the weight", () => {
    const onlySmall: CalcRule[] = [
      {
        ruleType: "FREIGHT_SLAB",
        minWeightGrams: 0,
        maxWeightGrams: 500,
        basisPoints: null,
        amountPaise: 6000n,
      },
    ];
    const result = computeExpected(onlySmall, order({ weightGrams: 600 }));
    expect(result).toMatchObject({ ok: false, code: "NO_SLAB_FOR_WEIGHT" });
  });
});

describe("other rules", () => {
  it("charges the COD fee only on cash-on-delivery orders", () => {
    const rules = seedFor("Website", "Aggregator 1");
    const cod = expectOk(computeExpected(rules, order({ paymentType: "COD" })));
    const prepaid = expectOk(computeExpected(rules, order({ paymentType: "PREPAID" })));
    expect(cod.expectedPaise).toBe(140_900n);
    expect(prepaid.expectedPaise).toBe(143_900n);
  });

  it("refuses a returned order when the card has no return delivery charge", () => {
    const result = computeExpected([], order({ isReturn: true }));
    expect(result).toMatchObject({ ok: false, code: "NO_REVERSE_FREIGHT_RULE" });
  });

  it("with no rules, expects the full order value", () => {
    expect(expectOk(computeExpected([], order())).expectedPaise).toBe(149_900n);
  });

  it("rejects a negative order value", () => {
    expect(() => computeExpected([], order({ orderValuePaise: -1n }))).toThrow(RangeError);
  });

  it("can go below zero when the fees are larger than the order", () => {
    const rules: CalcRule[] = [
      {
        ruleType: "FIXED_FEE",
        minWeightGrams: null,
        maxWeightGrams: null,
        basisPoints: null,
        amountPaise: 50_000n,
      },
    ];
    expect(
      expectOk(computeExpected(rules, order({ orderValuePaise: 10_000n }))).expectedPaise,
    ).toBe(-40_000n);
  });
});

describe("describeWeightBand", () => {
  it("reads naturally", () => {
    expect(describeWeightBand(0, 500)).toBe("0 to 500 g");
    expect(describeWeightBand(2001, null)).toBe("2,001 g and above");
    expect(describeWeightBand(null, null)).toBe("any weight");
    expect(describeWeightBand(0, null)).toBe("any weight");
  });
});

describe("money helpers (whole paise, no floating point)", () => {
  it("reads rupee text into paise", () => {
    expect(parseAmountToPaise("60")).toBe(6000n);
    expect(parseAmountToPaise("60.5")).toBe(6050n);
    expect(parseAmountToPaise("60.05")).toBe(6005n);
    expect(parseAmountToPaise(" 1499.00 ")).toBe(149_900n);
    expect(parseAmountToPaise("0.01")).toBe(1n);
  });

  it("refuses anything else", () => {
    for (const bad of [
      "",
      "-5",
      "60.123",
      "1e3",
      "60,00",
      "₹60",
      "abc",
      "60.",
      ".5",
      "1234567890123",
    ]) {
      expect(parseAmountToPaise(bad), bad).toBeNull();
    }
  });

  it("writes paise as rupee text, with the sign", () => {
    expect(paiseToAmount(6000n)).toBe("60.00");
    expect(paiseToAmount(5n)).toBe("0.05");
    expect(paiseToAmount(-9600n)).toBe("-96.00");
    expect(paiseToAmount(0n)).toBe("0.00");
  });

  it("reads a database decimal", () => {
    expect(decimalToPaise({ toFixed: () => "1409.00" })).toBe(140_900n);
    expect(decimalToPaise({ toFixed: () => "-96.00" })).toBe(-9600n);
  });

  it("rounds a percentage share half up to the nearest paisa", () => {
    expect(shareOfPaise(119_900n, 2000)).toBe(23_980n); // exactly 239.80
    expect(shareOfPaise(100_101n, 1850)).toBe(18_519n); // 185.19 from 185.1868...
    expect(shareOfPaise(1n, 5000)).toBe(1n); // 0.5 rounds up
    expect(shareOfPaise(1n, 4999)).toBe(0n);
    expect(shareOfPaise(0n, 2500)).toBe(0n);
  });
});

describe("pickRateCard", () => {
  const WEBSITE = "11111111-1111-4111-8111-111111111111";
  const AGG1 = "22222222-2222-4222-8222-222222222222";
  const AGG2 = "33333333-3333-4333-8333-333333333333";
  const card = (
    id: string,
    courier: string | null,
    versionNo: number,
    from: string | null,
    to: string | null,
  ): CalcCard => ({
    id,
    channelSourceId: WEBSITE,
    courierSourceId: courier,
    versionNo,
    effectiveFrom: from ? new Date(from) : null,
    effectiveTo: to ? new Date(to) : null,
  });
  const v1 = card("v1", AGG1, 1, null, "2026-06-01T00:00:00Z");
  const v2 = card("v2", AGG1, 2, "2026-06-01T00:00:00Z", null);
  const channelOnly = card("channel-only", null, 1, null, null);
  const day = (iso: string) => new Date(iso);

  it("uses the version that applied on the order date", () => {
    const cards = [v1, v2];
    const query = { channelSourceId: WEBSITE, courierSourceId: AGG1 };
    expect(pickRateCard(cards, { ...query, orderDate: day("2026-05-31T23:59:59Z") })?.id).toBe(
      "v1",
    );
    expect(pickRateCard(cards, { ...query, orderDate: day("2026-06-01T00:00:00Z") })?.id).toBe(
      "v2",
    );
    expect(pickRateCard(cards, { ...query, orderDate: day("2030-01-01T00:00:00Z") })?.id).toBe(
      "v2",
    );
  });

  it("prefers the card made for the order's courier", () => {
    const picked = pickRateCard([channelOnly, v2], {
      channelSourceId: WEBSITE,
      courierSourceId: AGG1,
      orderDate: day("2026-07-01T00:00:00Z"),
    });
    expect(picked?.id).toBe("v2");
  });

  it("falls back to the channel-only card when there is none for that courier", () => {
    const picked = pickRateCard([channelOnly, v2], {
      channelSourceId: WEBSITE,
      courierSourceId: AGG2,
      orderDate: day("2026-07-01T00:00:00Z"),
    });
    expect(picked?.id).toBe("channel-only");
  });

  it("finds nothing instead of guessing a courier", () => {
    expect(
      pickRateCard([v2], {
        channelSourceId: WEBSITE,
        courierSourceId: null,
        orderDate: day("2026-07-01T00:00:00Z"),
      }),
    ).toBeNull();
    expect(
      pickRateCard([v2], {
        channelSourceId: "99999999-9999-4999-8999-999999999999",
        courierSourceId: AGG1,
        orderDate: day("2026-07-01T00:00:00Z"),
      }),
    ).toBeNull();
  });
});
