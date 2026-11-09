import type { ClaimType, OrderStatus } from "../../../generated/prisma/enums.js";

// Which findings become claims, and for how much. The amounts follow the money-at-risk dashboard
// (Part 11) so a claim list and the dashboard always agree.
//
// ASSUMPTIONS (the assignment does not say; labelled in docs/decisions.md):
//   - Short-paid and unpaid: the claim is the loss, that is minus the (negative) difference.
//   - Freight overcharged: the claim is what the courier billed above what the rate card allows.
//   - Return not received: the claim is the order value, the goods that never came back.
//   - Pending, overpaid, settled, not tracked and cannot-calculate orders are not claimed.

export const CLAIM_TYPE_OF: Partial<Record<OrderStatus, ClaimType>> = {
  SHORT_PAID: "SHORT_PAID",
  UNPAID_PAST_DUE: "UNPAID",
  FREIGHT_OVERCHARGED: "FREIGHT_OVERCHARGE",
  RETURN_NOT_RECEIVED: "RETURN_NOT_RECEIVED",
};

export const CLAIMABLE_STATUSES = Object.keys(CLAIM_TYPE_OF) as OrderStatus[];

export interface ClaimInput {
  status: OrderStatus;
  differencePaise: bigint | null;
  freightBilledPaise: bigint;
  freightExpectedPaise: bigint | null;
  orderValuePaise: bigint;
}

const positive = (value: bigint) => (value > 0n ? value : 0n);

/** The claim type and amount in paise for a result, or null if it is not claimable. */
export function claimFor(input: ClaimInput): { type: ClaimType; amountPaise: bigint } | null {
  const type = CLAIM_TYPE_OF[input.status];
  if (!type) return null;
  let amount: bigint;
  switch (type) {
    case "SHORT_PAID":
    case "UNPAID":
      amount = positive(-(input.differencePaise ?? 0n));
      break;
    case "FREIGHT_OVERCHARGE":
      amount = positive(
        input.freightExpectedPaise === null
          ? -(input.differencePaise ?? 0n)
          : input.freightBilledPaise - input.freightExpectedPaise,
      );
      break;
    case "RETURN_NOT_RECEIVED":
      amount = positive(input.orderValuePaise);
      break;
  }
  return amount > 0n ? { type, amountPaise: amount } : null;
}

export const CLAIM_TYPE_LABELS: Record<ClaimType, string> = {
  SHORT_PAID: "Short-paid",
  UNPAID: "Unpaid past due",
  FREIGHT_OVERCHARGE: "Freight overcharged",
  RETURN_NOT_RECEIVED: "Return not received",
};

export const claimLabel = (claimNo: number) => `CLM-${String(claimNo).padStart(4, "0")}`;
