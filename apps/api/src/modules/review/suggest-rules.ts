import type { LineKind, PaymentType } from "../../../generated/prisma/enums.js";

// Rule-based candidates for a line that could not be matched by its order ID or AWB (Part 8).
// Pure functions: no database, no clock. A candidate is only ever a SUGGESTION. A person accepts
// or rejects it, and nothing here closes a match.
//
// ASSUMPTIONS (the assignment names the signals: amount, date window and channel; the weights and
// limits below are mine and are labelled as assumptions in docs/decisions.md):
//   - The partner must fit: a settlement line belongs to the order's sales channel, a COD or
//     freight line to the order's courier, a return scan to a returned order.
//   - The amount is compared with the amount the order was expected to bring in (or the freight
//     the rate card allows). A payout that is a little short still counts as close.
//   - The date must not be before the order was delivered, and not long after.

export interface Rules {
  tolerancePaise: bigint;
  codDueDays: number;
  settlementDueDays: number;
  returnWindowDays: number;
}

export interface LineFacts {
  id: string;
  kind: LineKind;
  /** The source that sent the line: channel, courier aggregator or warehouse. */
  partnerId: string;
  date: Date | null;
  /** Money in for settlements and COD (tax added back), freight billed for freight, null for scans. */
  amountPaise: bigint | null;
  orderIdRaw: string | null;
  awb: string | null;
}

export interface CandidateOrder {
  pk: string;
  orderId: string;
  awb: string | null;
  channelId: string;
  courierId: string | null;
  paymentType: PaymentType;
  orderDate: Date;
  deliveredAt: Date | null;
  returnedAt: Date | null;
  returned: boolean;
  valuePaise: bigint;
  expectedPaise: bigint | null;
  freightExpectedPaise: bigint | null;
  counts: { settlement: number; codRemittance: number; freight: number; returnScan: number };
}

export interface Candidate {
  orderPk: string;
  score: number;
  reasons: string[];
}

export const MIN_SCORE = 50;
export const MAX_CANDIDATES = 5;
/** Two top candidates this close in score are "ambiguous": the AI is asked to rank them. */
export const AMBIGUOUS_GAP = 10;

const DAY_MS = 24 * 60 * 60 * 1000;
const daysBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY_MS);

/** Upper case letters and digits only, so "ord-w 204118" and "ORDW204118" compare equal. */
export function normaliseKey(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Number of single-character edits between two short strings, stopping early above `limit`. */
export function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length] ?? limit + 1;
}

const rupees = (paise: bigint) => `\u20B9${(Number(paise) / 100).toFixed(2)}`;
const absBig = (value: bigint) => (value < 0n ? -value : value);

function amountScore(
  line: bigint,
  target: bigint,
  tolerance: bigint,
): { score: number; reason: string } | null {
  const gap = absBig(line - target);
  if (gap === 0n) return { score: 50, reason: "The amount equals the expected amount exactly" };
  if (gap <= tolerance) {
    return {
      score: 40,
      reason: `The amount is within ${rupees(tolerance)} of the expected amount`,
    };
  }
  const base = absBig(target);
  if (base > 0n && gap * 20n <= base) {
    return { score: 25, reason: "The amount is within 5% of the expected amount" };
  }
  if (base > 0n && gap * 10n <= base) {
    return { score: 15, reason: "The amount is within 10% of the expected amount" };
  }
  return null;
}

/** Whether this kind of partner can have sent a line for this order at all. */
function partnerFits(line: LineFacts, order: CandidateOrder): boolean {
  switch (line.kind) {
    case "SETTLEMENT":
      return order.channelId === line.partnerId;
    case "COD_REMITTANCE":
      return (
        order.paymentType === "COD" &&
        (order.courierId === null || order.courierId === line.partnerId)
      );
    case "FREIGHT":
      return order.courierId === null || order.courierId === line.partnerId;
    case "RETURN_SCAN":
      return order.returned;
  }
}

function alreadyHas(line: LineFacts, order: CandidateOrder): boolean {
  switch (line.kind) {
    case "SETTLEMENT":
      return order.counts.settlement > 0;
    case "COD_REMITTANCE":
      return order.counts.codRemittance > 0;
    case "FREIGHT":
      return order.counts.freight > 0;
    case "RETURN_SCAN":
      return order.counts.returnScan > 0;
  }
}

/** Scores one order as the owner of one line. Null means it cannot be the owner. */
export function scoreCandidate(
  line: LineFacts,
  order: CandidateOrder,
  rules: Rules,
): Candidate | null {
  if (!partnerFits(line, order)) return null;

  let score = 0;
  const reasons: string[] = [];

  // Likeness of the ID or AWB the line carries.
  let idLike = false;
  if (line.orderIdRaw) {
    const wanted = normaliseKey(order.orderId);
    const given = normaliseKey(line.orderIdRaw);
    if (given === wanted) {
      score += 45;
      idLike = true;
      reasons.push("The ID is the same apart from dashes, spaces or letter case");
    } else if (given.length >= 6 && wanted.length >= 6) {
      const distance = editDistance(given, wanted, 2);
      if (distance <= 2) {
        score += 30;
        idLike = true;
        reasons.push(`The ID differs by ${distance} character${distance === 1 ? "" : "s"}`);
      }
    }
  }
  if (line.awb && order.awb) {
    const distance = editDistance(normaliseKey(line.awb), normaliseKey(order.awb), 1);
    if (distance <= 1) {
      score += 30;
      idLike = true;
      reasons.push(distance === 0 ? "The AWB is the same" : "The AWB differs by one character");
    }
  }

  // The order must still be waiting for this kind of line, unless the ID points at it.
  if (alreadyHas(line, order) && !idLike) return null;
  if (!alreadyHas(line, order)) {
    score += 10;
    reasons.push("This order has no such line yet");
  }

  // The amount.
  if (line.kind !== "RETURN_SCAN") {
    const target = line.kind === "FREIGHT" ? order.freightExpectedPaise : order.expectedPaise;
    if (line.amountPaise !== null && target !== null) {
      const amount = amountScore(line.amountPaise, target, rules.tolerancePaise);
      if (amount) {
        score += amount.score;
        reasons.push(amount.reason);
      } else if (!idLike) {
        return null;
      }
    } else if (!idLike) {
      return null;
    }
  }

  // The date.
  if (line.date) {
    const start =
      line.kind === "RETURN_SCAN"
        ? (order.returnedAt ?? order.deliveredAt ?? order.orderDate)
        : (order.deliveredAt ?? order.orderDate);
    const days = daysBetween(start, line.date);
    const window =
      line.kind === "RETURN_SCAN"
        ? rules.returnWindowDays * 2
        : line.kind === "COD_REMITTANCE"
          ? rules.codDueDays * 2
          : line.kind === "FREIGHT"
            ? 30
            : rules.settlementDueDays * 2;
    if (days < -1) {
      if (!idLike) return null;
    } else if (days <= window) {
      // Money usually arrives soon after delivery, so the closer the date, the higher the score.
      score += 20 - Math.round((10 * Math.max(days, 0)) / window);
      reasons.push(
        `The date is ${Math.max(days, 0)} day${days === 1 ? "" : "s"} after delivery, inside the usual window`,
      );
    } else if (days <= 90) {
      score += 10;
      reasons.push(`The date is ${days} days after delivery, later than usual`);
    } else if (!idLike) {
      return null;
    }
  }

  return score >= MIN_SCORE ? { orderPk: order.pk, score: Math.min(score, 100), reasons } : null;
}

/** The best few candidates for a line, best first. */
export function rankCandidates(
  line: LineFacts,
  orders: Iterable<CandidateOrder>,
  rules: Rules,
  limit = MAX_CANDIDATES,
): Candidate[] {
  const scored: Candidate[] = [];
  for (const order of orders) {
    const candidate = scoreCandidate(line, order, rules);
    if (candidate) scored.push(candidate);
  }
  scored.sort((a, b) => b.score - a.score || a.orderPk.localeCompare(b.orderPk));
  return scored.slice(0, limit);
}

/** True when the top two candidates are too close to tell apart by the rules alone. */
export function isAmbiguous(candidates: readonly Candidate[]): boolean {
  const [first, second] = candidates;
  return first !== undefined && second !== undefined && first.score - second.score <= AMBIGUOUS_GAP;
}
