import type { PaymentType, RateRuleType } from "../../../generated/prisma/enums.js";
import { paiseToAmount, shareOfPaise } from "./money.js";

// Works out the amount a partner should have paid us for one order, from a rate card.
// Plain rules, no AI. Pure functions: no database, no clock, so they are easy to test and Part 6
// (matching) can call them for every order.
//
// ASSUMPTIONS (the assignment gives no fee rules; these follow the three sample rows and are
// labelled as assumptions in the documents):
//   - A delivered order: expected = order value, minus commission, minus the fixed fee, minus the
//     delivery charge for the order's weight, minus the COD fee if the order is cash on delivery.
//   - A returned order: expected = minus the return delivery charge (sample row 3: -96).
//   - Commission is a share of the order value, rounded half up to the nearest paisa.
//   - TCS and TDS are not part of this calculation. They are shown separately (Part 6/11).

export interface CalcRule {
  ruleType: RateRuleType;
  minWeightGrams: number | null;
  maxWeightGrams: number | null;
  basisPoints: number | null;
  amountPaise: bigint | null;
}

export interface CalcCard {
  id: string;
  channelSourceId: string;
  courierSourceId: string | null;
  versionNo: number;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
}

export interface CalcInput {
  /** The order value in paise. Must not be negative. */
  orderValuePaise: bigint;
  paymentType: PaymentType;
  /** Null when the order file has no weight. */
  weightGrams: number | null;
  isReturn: boolean;
}

export interface CalcLine {
  label: string;
  /** Signed paise: the order value is positive, every charge is negative. */
  amountPaise: bigint;
}

export type CalcFailureCode =
  "NO_RATE_CARD" | "NO_REVERSE_FREIGHT_RULE" | "MISSING_WEIGHT" | "NO_SLAB_FOR_WEIGHT";

export type CalcResult =
  | { ok: true; expectedPaise: bigint; lines: CalcLine[] }
  | { ok: false; code: CalcFailureCode; message: string };

const fail = (code: CalcFailureCode, message: string): CalcResult => ({ ok: false, code, message });

const grams = (value: number) => `${value.toLocaleString("en-IN")} g`;

/** "0 to 500 g", "2,001 g and above", "any weight". */
export function describeWeightBand(min: number | null, max: number | null): string {
  const low = min ?? 0;
  if (max === null) return low === 0 ? "any weight" : `${grams(low)} and above`;
  return `${low.toLocaleString("en-IN")} to ${grams(max)}`;
}

function slabCovers(rule: CalcRule, weightGrams: number): boolean {
  const low = rule.minWeightGrams ?? 0;
  return weightGrams >= low && (rule.maxWeightGrams === null || weightGrams <= rule.maxWeightGrams);
}

/** A slab with no limits at all covers every order, even one with no weight. */
function slabCoversAnyWeight(rule: CalcRule): boolean {
  return (rule.minWeightGrams ?? 0) === 0 && rule.maxWeightGrams === null;
}

export function computeExpected(rules: readonly CalcRule[], input: CalcInput): CalcResult {
  if (input.orderValuePaise < 0n) throw new RangeError("The order value must not be negative.");

  const ofType = (type: RateRuleType) => rules.filter((rule) => rule.ruleType === type);
  const flat = (type: RateRuleType): bigint | null => ofType(type)[0]?.amountPaise ?? null;

  if (input.isReturn) {
    const reverse = flat("REVERSE_FREIGHT");
    if (reverse === null) {
      return fail(
        "NO_REVERSE_FREIGHT_RULE",
        "This rate card has no return delivery charge, so a returned order cannot be calculated.",
      );
    }
    return {
      ok: true,
      expectedPaise: -reverse,
      lines: [{ label: "Return delivery charge", amountPaise: -reverse }],
    };
  }

  const lines: CalcLine[] = [{ label: "Order value", amountPaise: input.orderValuePaise }];
  let expected = input.orderValuePaise;
  const charge = (label: string, paise: bigint) => {
    lines.push({ label, amountPaise: -paise });
    expected -= paise;
  };

  const commission = ofType("COMMISSION")[0];
  if (commission?.basisPoints != null) {
    const percent = commission.basisPoints / 100;
    charge(
      `Commission (${percent.toLocaleString("en-IN", { maximumFractionDigits: 2 })}%)`,
      shareOfPaise(input.orderValuePaise, commission.basisPoints),
    );
  }

  const fixed = flat("FIXED_FEE");
  if (fixed !== null) charge("Fixed fee", fixed);

  const slabs = ofType("FREIGHT_SLAB");
  if (slabs.length > 0) {
    const weight = input.weightGrams;
    const slab =
      weight === null
        ? slabs.find(slabCoversAnyWeight)
        : slabs.find((candidate) => slabCovers(candidate, weight));
    if (!slab || slab.amountPaise === null) {
      return weight === null
        ? fail(
            "MISSING_WEIGHT",
            "The delivery charge depends on weight, and this order has no weight.",
          )
        : fail("NO_SLAB_FOR_WEIGHT", `No delivery charge is set for a weight of ${grams(weight)}.`);
    }
    charge(
      `Delivery charge (${describeWeightBand(slab.minWeightGrams, slab.maxWeightGrams)})`,
      slab.amountPaise,
    );
  }

  const codFee = flat("COD_FEE");
  if (input.paymentType === "COD" && codFee !== null) charge("COD fee", codFee);

  return { ok: true, expectedPaise: expected, lines };
}

/** Lines in the form the API sends: signed amounts as text. */
export function linesToAmounts(lines: readonly CalcLine[]): { label: string; amount: string }[] {
  return lines.map((line) => ({ label: line.label, amount: paiseToAmount(line.amountPaise) }));
}

export interface CardQuery {
  channelSourceId: string;
  /** The courier that carried the order, or null if unknown or not applicable. */
  courierSourceId: string | null;
  orderDate: Date;
}

/**
 * Chooses the card that applied on the order date.
 * A card made for the order's courier wins over a channel-only card. Within a pair, the newest
 * version whose dates include the order date wins. Returns null when no card applies.
 */
export function pickRateCard<T extends CalcCard>(cards: readonly T[], query: CardQuery): T | null {
  const inDate = (card: T) =>
    (card.effectiveFrom === null || card.effectiveFrom <= query.orderDate) &&
    (card.effectiveTo === null || card.effectiveTo > query.orderDate);
  const newest = (list: T[]) =>
    list.reduce<T | null>((a, b) => (!a || b.versionNo > a.versionNo ? b : a), null);

  const forChannel = cards.filter(
    (card) => card.channelSourceId === query.channelSourceId && inDate(card),
  );
  if (query.courierSourceId !== null) {
    const forCourier = newest(
      forChannel.filter((card) => card.courierSourceId === query.courierSourceId),
    );
    if (forCourier) return forCourier;
  }
  return newest(forChannel.filter((card) => card.courierSourceId === null));
}
