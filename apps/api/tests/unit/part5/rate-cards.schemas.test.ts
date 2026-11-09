import { describe, expect, it } from "vitest";
import { RATE_CARD_SEED } from "../../../src/db/seed-rate-cards.js";
import {
  calculateSchema,
  createCardSchema,
  rulesSchema,
  updateCardSchema,
} from "../../../src/modules/rate-cards/rate-cards.schemas.js";

const UUID = "11111111-1111-4111-8111-111111111111";

/** The first problem's path and message, or null if the rules are valid. */
function firstProblem(rules: unknown): { path: string; message: string } | null {
  const result = rulesSchema.safeParse(rules);
  if (result.success) return null;
  const issue = result.error.issues[0]!;
  return { path: issue.path.join("."), message: issue.message };
}

describe("rules", () => {
  it("accept every demo card", () => {
    for (const seed of RATE_CARD_SEED) {
      expect(firstProblem(seed.rules), `${seed.channel} / ${seed.courier}`).toBeNull();
    }
  });

  it("need at least one fee", () => {
    expect(firstProblem([])?.message).toMatch(/at least one/i);
  });

  it("need a percentage for commission, and no amount", () => {
    expect(firstProblem([{ ruleType: "COMMISSION" }])?.path).toBe("0.basisPoints");
    expect(firstProblem([{ ruleType: "COMMISSION", basisPoints: 2000, amount: "5" }])?.path).toBe(
      "0.amount",
    );
    expect(firstProblem([{ ruleType: "COMMISSION", basisPoints: 10_001 }])).not.toBeNull();
    expect(firstProblem([{ ruleType: "COMMISSION", basisPoints: 2000.5 }])).not.toBeNull();
    expect(firstProblem([{ ruleType: "COMMISSION", basisPoints: 0 }])).toBeNull();
  });

  it("need an amount for every other fee, and no percentage", () => {
    for (const ruleType of ["FIXED_FEE", "COD_FEE", "REVERSE_FREIGHT", "FREIGHT_SLAB"]) {
      expect(firstProblem([{ ruleType }])?.path, ruleType).toBe("0.amount");
      expect(firstProblem([{ ruleType, amount: "10", basisPoints: 100 }])?.path, ruleType).toBe(
        "0.basisPoints",
      );
    }
  });

  it("accept amounts of up to two decimals and nothing else", () => {
    for (const amount of ["0", "60", "60.5", "60.05", "999999999999.99"]) {
      expect(firstProblem([{ ruleType: "FIXED_FEE", amount }]), amount).toBeNull();
    }
    for (const amount of ["", "-1", "60.123", "1e3", "sixty", "60,00", "₹60", "1234567890123"]) {
      expect(firstProblem([{ ruleType: "FIXED_FEE", amount }])?.path, amount).toBe("0.amount");
    }
  });

  it("allow each single fee only once", () => {
    const twice = [
      { ruleType: "COD_FEE", amount: "30" },
      { ruleType: "COD_FEE", amount: "35" },
    ];
    expect(firstProblem(twice)).toEqual({
      path: "1.ruleType",
      message: "Each fee can be added only once.",
    });
  });

  it("allow several delivery charges that do not overlap, touching bands included", () => {
    const slabs = [
      { ruleType: "FREIGHT_SLAB", minWeightGrams: 0, maxWeightGrams: 500, amount: "60" },
      { ruleType: "FREIGHT_SLAB", minWeightGrams: 501, maxWeightGrams: 1000, amount: "90" },
      { ruleType: "FREIGHT_SLAB", minWeightGrams: 1001, amount: "130" },
    ];
    expect(firstProblem(slabs)).toBeNull();
  });

  it("refuse overlapping weight bands, including one with no limit", () => {
    const overlap = [
      { ruleType: "FREIGHT_SLAB", minWeightGrams: 0, maxWeightGrams: 500, amount: "60" },
      { ruleType: "FREIGHT_SLAB", minWeightGrams: 500, maxWeightGrams: 1000, amount: "90" },
    ];
    expect(firstProblem(overlap)).toMatchObject({ path: "1.minWeightGrams" });

    const everything = [
      { ruleType: "FREIGHT_SLAB", amount: "35.20" },
      { ruleType: "FREIGHT_SLAB", minWeightGrams: 2001, amount: "180" },
    ];
    expect(firstProblem(everything)).toMatchObject({ path: "1.minWeightGrams" });
  });

  it("refuse a highest weight below the lowest, and weights on other fees", () => {
    expect(
      firstProblem([
        { ruleType: "FREIGHT_SLAB", minWeightGrams: 600, maxWeightGrams: 500, amount: "60" },
      ])?.path,
    ).toBe("0.maxWeightGrams");
    expect(firstProblem([{ ruleType: "FIXED_FEE", amount: "10", minWeightGrams: 0 }])?.path).toBe(
      "0.minWeightGrams",
    );
  });

  it("refuse unknown fields and unknown fee types", () => {
    expect(firstProblem([{ ruleType: "FIXED_FEE", amount: "10", surprise: true }])).not.toBeNull();
    expect(firstProblem([{ ruleType: "TAX", amount: "10" }])).not.toBeNull();
  });

  it("refuse more than 30 fees", () => {
    const many = Array.from({ length: 31 }, (_, index) => ({
      ruleType: "FREIGHT_SLAB",
      minWeightGrams: index * 10,
      maxWeightGrams: index * 10 + 9,
      amount: "10",
    }));
    expect(firstProblem(many)?.message).toMatch(/at most 30/);
  });
});

describe("create, update and calculate bodies", () => {
  const rules = [{ ruleType: "FIXED_FEE", amount: "25" }];

  it("create needs a channel, and the courier is optional", () => {
    expect(createCardSchema.safeParse({ channelSourceId: UUID, rules }).success).toBe(true);
    expect(
      createCardSchema.safeParse({ channelSourceId: UUID, courierSourceId: null, rules }).success,
    ).toBe(true);
    expect(createCardSchema.safeParse({ channelSourceId: "nope", rules }).success).toBe(false);
    expect(createCardSchema.safeParse({ rules }).success).toBe(false);
  });

  it("update cannot change the channel or courier", () => {
    expect(updateCardSchema.safeParse({ rules }).success).toBe(true);
    expect(updateCardSchema.safeParse({ rules, channelSourceId: UUID }).success).toBe(false);
    expect(updateCardSchema.safeParse({ rules, note: "x".repeat(201) }).success).toBe(false);
  });

  it("calculate takes an amount as text, an optional weight, and defaults to not returned", () => {
    const parsed = calculateSchema.parse({
      rateCardId: UUID,
      paymentType: "COD",
      orderValue: "1499",
    });
    expect(parsed.isReturn).toBe(false);
    expect(
      calculateSchema.safeParse({ rateCardId: UUID, paymentType: "COD", orderValue: 1499 }).success,
    ).toBe(false);
    expect(
      calculateSchema.safeParse({ rateCardId: UUID, paymentType: "CHEQUE", orderValue: "1" })
        .success,
    ).toBe(false);
    expect(
      calculateSchema.safeParse({
        rateCardId: UUID,
        paymentType: "COD",
        orderValue: "1",
        weightGrams: -5,
      }).success,
    ).toBe(false);
  });
});
