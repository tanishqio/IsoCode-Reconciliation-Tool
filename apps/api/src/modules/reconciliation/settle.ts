import type { OrderStatus, PaymentType, SourceKind } from "../../../generated/prisma/enums.js";
import { computeExpected, type CalcResult, type CalcRule } from "../rate-cards/expected-amount.js";

// The rules that turn one order and its matched lines into a result. Pure functions: no database,
// no clock. All money is whole paise (BigInt) until it is written. The rule numbers (due days,
// return window, tolerance) come from the settings; the assignment gives none of them.
//
// Sign: difference = received - expected, so a LOSS IS NEGATIVE (the assignment's sample rows).
//
// ASSUMPTIONS (labelled in docs/decisions.md):
//   - received = settlement net + TCS + TDS (tax withheld is added back, it is not leakage)
//                + COD remittance. For a returned order the return freight billed is deducted.
//   - A delivered Website prepaid order is paid through a payment gateway that has no file here,
//     so it is NOT_TRACKED rather than "unpaid".
//   - An order is "returned" if its delivery status mentions a return, or it has a return date.

export interface Settings {
  tolerancePaise: bigint;
  codDueDays: number;
  settlementDueDays: number;
  returnWindowDays: number;
}

export interface OrderFacts {
  paymentType: PaymentType;
  channelKind: SourceKind;
  deliveryStatus: string;
  orderDate: Date;
  deliveredAt: Date | null;
  returnedAt: Date | null;
  weightGrams: number | null;
  valuePaise: bigint;
}

/** Sums of the lines matched to one order, with how many lines each came from. */
export interface Aggregates {
  settlementNet: bigint;
  tcs: bigint;
  tds: bigint;
  codRemitted: bigint;
  forwardFreight: bigint;
  reverseFreight: bigint;
  counts: { settlement: number; codRemittance: number; freight: number; returnScan: number };
}

export type Flag =
  | "TAX_ADDED_BACK"
  | "MULTIPLE_PAYMENTS"
  | "RETURN_FREIGHT_DEDUCTED"
  | "RETURN_DATE_ASSUMED"
  | "PAYMENT_NOT_TRACKED"
  | "FREIGHT_OVERCHARGED";

export interface Verdict {
  expectedPaise: bigint | null;
  receivedPaise: bigint | null;
  differencePaise: bigint | null;
  freightExpectedPaise: bigint | null;
  status: OrderStatus;
  flags: Flag[];
  calcProblem: string | null;
  dueDate: Date | null;
  matched: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

export function isReturned(facts: Pick<OrderFacts, "deliveryStatus" | "returnedAt">): boolean {
  return facts.returnedAt !== null || /return|rto/i.test(facts.deliveryStatus);
}

function freightExpectedOf(calc: CalcResult): bigint | null {
  if (!calc.ok) return null;
  const line = calc.lines.find((entry) => /delivery charge/i.test(entry.label));
  return line ? -line.amountPaise : null;
}

/**
 * Decides the status of one order. `rules` are the fees of the rate card that applies, or null
 * when no card applies. `asOf` is the date the check is made against (the newest date in the data).
 */
export function settleOrder(
  facts: OrderFacts,
  agg: Aggregates,
  rules: readonly CalcRule[] | null,
  asOf: Date,
  settings: Settings,
): Verdict {
  const returned = isReturned(facts);
  const flags: Flag[] = [];
  const matched =
    agg.counts.settlement + agg.counts.codRemittance + agg.counts.freight + agg.counts.returnScan >
    0;

  const calc: CalcResult = rules
    ? computeExpected(rules, {
        orderValuePaise: facts.valuePaise,
        paymentType: facts.paymentType,
        weightGrams: facts.weightGrams,
        isReturn: returned,
      })
    : { ok: false, code: "NO_RATE_CARD", message: "No rate card applies to this order." };

  const taxBack = agg.tcs + agg.tds;
  const paymentsIn = agg.settlementNet + taxBack + agg.codRemitted;
  const received = returned ? paymentsIn - agg.reverseFreight : paymentsIn;
  if (taxBack !== 0n) flags.push("TAX_ADDED_BACK");
  if (agg.counts.settlement + agg.counts.codRemittance > 1) flags.push("MULTIPLE_PAYMENTS");
  if (returned && agg.reverseFreight !== 0n) flags.push("RETURN_FREIGHT_DEDUCTED");

  const base = {
    expectedPaise: calc.ok ? calc.expectedPaise : null,
    freightExpectedPaise: freightExpectedOf(calc),
    matched,
  };
  const done = (
    status: OrderStatus,
    parts: Partial<Pick<Verdict, "receivedPaise" | "differencePaise" | "dueDate">> = {},
  ): Verdict => ({
    ...base,
    receivedPaise: null,
    differencePaise: null,
    dueDate: null,
    calcProblem: null,
    ...parts,
    status,
    flags,
  });

  if (!calc.ok) return { ...done("CANNOT_CALCULATE"), calcProblem: calc.code };
  const expected = calc.expectedPaise;
  const tolerance = settings.tolerancePaise;
  const differenceOf = (value: bigint) => value - expected;

  // Freight: what the courier billed against what the card allows.
  const freightBilled = returned ? agg.reverseFreight : agg.forwardFreight;
  const freightOver =
    base.freightExpectedPaise !== null &&
    agg.counts.freight > 0 &&
    freightBilled - base.freightExpectedPaise > tolerance;
  if (freightOver) flags.push("FREIGHT_OVERCHARGED");

  if (returned) {
    if (agg.counts.returnScan === 0) {
      const start = facts.returnedAt ?? facts.deliveredAt ?? facts.orderDate;
      if (facts.returnedAt === null) flags.push("RETURN_DATE_ASSUMED");
      const due = addDays(start, settings.returnWindowDays);
      return asOf > due
        ? done("RETURN_NOT_RECEIVED", {
            receivedPaise: received,
            differencePaise: differenceOf(received),
            dueDate: due,
          })
        : done("PENDING", { dueDate: due });
    }
    // The parcel reached the warehouse. The only cash movement is usually the return freight.
    const difference = differenceOf(received);
    if (freightOver) {
      return done("FREIGHT_OVERCHARGED", { receivedPaise: received, differencePaise: difference });
    }
    const status: OrderStatus =
      difference < -tolerance ? "SHORT_PAID" : difference > tolerance ? "OVERPAID" : "SETTLED";
    return done(status, { receivedPaise: received, differencePaise: difference });
  }

  // Delivered. A Website prepaid order is paid through a gateway that has no file here.
  if (facts.channelKind === "WEBSITE" && facts.paymentType === "PREPAID") {
    flags.push("PAYMENT_NOT_TRACKED");
    return done("NOT_TRACKED");
  }

  const gotPayment = agg.counts.settlement + agg.counts.codRemittance > 0;
  if (!gotPayment) {
    const days = facts.paymentType === "COD" ? settings.codDueDays : settings.settlementDueDays;
    const due = addDays(facts.deliveredAt ?? facts.orderDate, days);
    return asOf > due
      ? done("UNPAID_PAST_DUE", {
          receivedPaise: received,
          differencePaise: differenceOf(received),
          dueDate: due,
        })
      : done("PENDING", { dueDate: due });
  }

  const difference = differenceOf(received);
  const status: OrderStatus =
    difference < -tolerance
      ? "SHORT_PAID"
      : difference > tolerance
        ? "OVERPAID"
        : freightOver
          ? "FREIGHT_OVERCHARGED"
          : "SETTLED";
  return done(status, { receivedPaise: received, differencePaise: difference });
}
