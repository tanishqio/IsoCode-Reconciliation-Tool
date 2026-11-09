import type { OrderStatus, PaymentType } from "../../../generated/prisma/enums.js";

// The four findings that put money at risk. The other statuses (settled, overpaid, pending, not
// tracked, cannot calculate) are not losses.
export const RISK_STATUSES = [
  "SHORT_PAID",
  "UNPAID_PAST_DUE",
  "FREIGHT_OVERCHARGED",
  "RETURN_NOT_RECEIVED",
] as const satisfies readonly OrderStatus[];

export type RiskStatus = (typeof RISK_STATUSES)[number];

export function isRiskStatus(status: string): status is RiskStatus {
  return (RISK_STATUSES as readonly string[]).includes(status);
}

export interface AttributionInput {
  status: RiskStatus;
  paymentType: PaymentType;
  channelId: string;
  courierId: string | null;
}

/**
 * Which partner the money is claimed from.
 *
 * ASSUMPTION (the assignment does not say; docs/decisions.md lists it): cash-on-delivery money,
 * freight charges and lost returns are the courier aggregator's business, so they belong to the
 * order's courier when it has one. Everything else (settlement payouts) belongs to the sales
 * channel. An order with no courier falls back to its channel.
 */
export function partnerIdFor(input: AttributionInput): string {
  const courierHandles =
    input.status === "FREIGHT_OVERCHARGED" ||
    input.status === "RETURN_NOT_RECEIVED" ||
    input.paymentType === "COD";
  return courierHandles && input.courierId ? input.courierId : input.channelId;
}
