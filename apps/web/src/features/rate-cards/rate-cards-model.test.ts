import { describe, expect, it } from "vitest";
import type { RateCard, RateRule } from "./rate-cards-api";
import {
  basisPointsToPercent,
  cardTitle,
  describeAppliesTo,
  describeEffective,
  describeWeightBand,
  draftFromRule,
  emptyDraft,
  hasErrors,
  percentToBasisPoints,
  placeServerErrors,
  toRuleInputs,
  validateDrafts,
  type DraftRule,
} from "./rate-cards-model";

const slab = (min: string, max: string, amount = "60"): DraftRule => ({
  ...emptyDraft("FREIGHT_SLAB"),
  minWeight: min,
  maxWeight: max,
  amount,
});
const fee = (ruleType: DraftRule["ruleType"], amount: string): DraftRule => ({
  ...emptyDraft(ruleType),
  amount,
});
const rule = (overrides: Partial<RateRule>): RateRule => ({
  id: "r",
  ruleType: "FIXED_FEE",
  appliesToPayment: null,
  minWeightGrams: null,
  maxWeightGrams: null,
  basisPoints: null,
  amount: null,
  ...overrides,
});

describe("percentages", () => {
  it("convert in both directions without floating point", () => {
    expect(percentToBasisPoints("20")).toBe(2000);
    expect(percentToBasisPoints("18.5")).toBe(1850);
    expect(percentToBasisPoints("18.05")).toBe(1805);
    expect(percentToBasisPoints("0")).toBe(0);
    expect(percentToBasisPoints("100")).toBe(10_000);
    expect(basisPointsToPercent(2000)).toBe("20");
    expect(basisPointsToPercent(1850)).toBe("18.5");
    expect(basisPointsToPercent(1805)).toBe("18.05");
    expect(basisPointsToPercent(5)).toBe("0.05");
  });

  it("refuse anything that is not a percentage from 0 to 100", () => {
    for (const bad of ["", "-1", "100.01", "101", "20.123", "twenty", "1e2", "20%", "20,5"]) {
      expect(percentToBasisPoints(bad), bad).toBeNull();
    }
  });
});

describe("describing a card", () => {
  it("says the weight band in words", () => {
    expect(describeWeightBand(0, 500)).toBe("0 to 500 g");
    expect(describeWeightBand(501, 1000)).toBe("501 to 1,000 g");
    expect(describeWeightBand(2001, null)).toBe("2,001 g and above");
    expect(describeWeightBand(0, null)).toBe("Any weight");
    expect(describeWeightBand(null, null)).toBe("Any weight");
  });

  it("says what each fee applies to", () => {
    expect(describeAppliesTo(rule({ ruleType: "COD_FEE" }))).toBe("Cash-on-delivery orders");
    expect(describeAppliesTo(rule({ ruleType: "REVERSE_FREIGHT" }))).toBe("Returned orders");
    expect(
      describeAppliesTo(rule({ ruleType: "FREIGHT_SLAB", minWeightGrams: 0, maxWeightGrams: 500 })),
    ).toBe("0 to 500 g");
  });

  it("names a card by channel and courier, and says when it applied", () => {
    const channel = { id: "1", name: "Website" };
    expect(cardTitle({ channel, courier: { id: "2", name: "Aggregator 1" } })).toBe(
      "Website with Aggregator 1",
    );
    expect(cardTitle({ channel, courier: null })).toBe("Website");
    const base: Pick<RateCard, "effectiveFrom" | "effectiveTo"> = {
      effectiveFrom: null,
      effectiveTo: null,
    };
    expect(describeEffective(base)).toBe("From the start");
    expect(describeEffective({ ...base, effectiveFrom: "2026-11-09T10:00:00.000Z" })).toMatch(
      /^From 9 Nov 2026$/,
    );
    expect(
      describeEffective({
        effectiveFrom: "2026-11-09T10:00:00.000Z",
        effectiveTo: "2026-12-01T10:00:00.000Z",
      }),
    ).toBe("From 9 Nov 2026 until 1 Dec 2026");
  });
});

describe("checking the form before it is sent", () => {
  it("accepts a normal card", () => {
    const drafts = [
      { ...emptyDraft("COMMISSION"), percent: "20" },
      fee("FIXED_FEE", "25"),
      slab("0", "500"),
      slab("501", ""),
      fee("COD_FEE", "30.50"),
    ];
    expect(hasErrors(validateDrafts(drafts))).toBe(false);
  });

  it("asks for the missing or badly written value of each fee", () => {
    const commission = emptyDraft("COMMISSION");
    const fixed = fee("FIXED_FEE", "60.123");
    const errors = validateDrafts([commission, fixed]);
    expect(errors[commission.key]?.percent).toMatch(/percentage/i);
    expect(errors[fixed.key]?.amount).toMatch(/rupees/i);
  });

  it("allows a single fee only once", () => {
    const first = fee("COD_FEE", "30");
    const second = fee("COD_FEE", "35");
    const errors = validateDrafts([first, second]);
    expect(errors[first.key]).toBeUndefined();
    expect(errors[second.key]?.ruleType).toMatch(/only once/i);
  });

  it("allows many delivery charges, but not overlapping or backwards weight ranges", () => {
    const a = slab("0", "500");
    const b = slab("500", "1000");
    const c = slab("900", "800");
    const errors = validateDrafts([a, b, c]);
    expect(errors[a.key]).toBeUndefined();
    expect(errors[b.key]?.minWeight).toMatch(/overlaps/i);
    expect(errors[c.key]?.maxWeight).toMatch(/lower/i);
  });

  it("treats an empty highest weight as no limit, so it overlaps anything above its start", () => {
    const open = slab("", "");
    const above = slab("2001", "");
    expect(validateDrafts([open, above])[above.key]?.minWeight).toMatch(/overlaps/i);
  });

  it("requires whole grams", () => {
    const errors = validateDrafts([slab("1.5", "")]);
    expect(Object.values(errors)[0]?.minWeight).toMatch(/whole grams/i);
  });
});

describe("turning the form into what the API wants, and back", () => {
  it("sends percentages as basis points, amounts as text and empty limits correctly", () => {
    const drafts = [
      { ...emptyDraft("COMMISSION"), percent: "18.5" },
      fee("FIXED_FEE", " 25 "),
      slab("", "500"),
      slab("501", ""),
    ];
    expect(toRuleInputs(drafts)).toEqual([
      { ruleType: "COMMISSION", basisPoints: 1850 },
      { ruleType: "FIXED_FEE", amount: "25" },
      { ruleType: "FREIGHT_SLAB", amount: "60", minWeightGrams: 0, maxWeightGrams: 500 },
      { ruleType: "FREIGHT_SLAB", amount: "60", minWeightGrams: 501, maxWeightGrams: null },
    ]);
  });

  it("fills the form from a saved fee and gives the same fee back", () => {
    const saved = rule({
      ruleType: "FREIGHT_SLAB",
      amount: "35.20",
      minWeightGrams: 0,
      maxWeightGrams: null,
    });
    const draft = draftFromRule(saved);
    expect(draft).toMatchObject({ amount: "35.20", minWeight: "0", maxWeight: "" });
    expect(toRuleInputs([draft])).toEqual([
      { ruleType: "FREIGHT_SLAB", amount: "35.20", minWeightGrams: 0, maxWeightGrams: null },
    ]);
    const commission = draftFromRule(rule({ ruleType: "COMMISSION", basisPoints: 1800 }));
    expect(commission.percent).toBe("18");
  });

  it("puts the server's field errors back on the right row", () => {
    const drafts = [fee("FIXED_FEE", "1"), slab("0", "500")];
    const { rows, other } = placeServerErrors(drafts, {
      "rules.1.minWeightGrams": "This weight range overlaps another delivery charge.",
      "rules.0.amount": "Enter the amount.",
      channelSourceId: "Choose a valid channel.",
      "rules.9.amount": "No such row.",
    });
    expect(rows[drafts[1]!.key]?.minWeight).toMatch(/overlaps/);
    expect(rows[drafts[0]!.key]?.amount).toBe("Enter the amount.");
    expect(other).toEqual(["Choose a valid channel.", "No such row."]);
  });
});
