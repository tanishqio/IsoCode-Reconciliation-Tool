import type { BadgeVariant } from "../../components/ui";
import type { OrderStatus } from "./orders-api";

export const STATUS_LABELS: Record<OrderStatus, string> = {
  SETTLED: "Settled",
  SHORT_PAID: "Short-paid",
  OVERPAID: "Overpaid",
  UNPAID_PAST_DUE: "Unpaid past due",
  FREIGHT_OVERCHARGED: "Freight overcharged",
  RETURN_NOT_RECEIVED: "Return not received",
  PENDING: "Pending",
  NOT_TRACKED: "Payment not tracked",
  CANNOT_CALCULATE: "Cannot calculate",
};

/** What each status means, in one plain sentence, for the detail panel. */
export const STATUS_EXPLANATIONS: Record<OrderStatus, string> = {
  SETTLED: "The amount received is within the allowed gap of the amount expected.",
  SHORT_PAID: "Less was received than expected, by more than the allowed gap.",
  OVERPAID: "More was received than expected, by more than the allowed gap.",
  UNPAID_PAST_DUE: "Nothing was received and the payment is overdue.",
  FREIGHT_OVERCHARGED: "The courier billed more freight than the rate card allows.",
  RETURN_NOT_RECEIVED:
    "The order was returned but no warehouse scan arrived within the return window.",
  PENDING: "It is not yet due, so nothing is wrong so far.",
  NOT_TRACKED:
    "A Website prepaid order is paid through a payment gateway, and no file for it is uploaded here.",
  CANNOT_CALCULATE: "No expected amount could be worked out, so nothing is compared.",
};

/** Red is for money at risk only, so only the statuses that mean lost money use it. */
export function statusVariant(status: OrderStatus): BadgeVariant {
  switch (status) {
    case "SHORT_PAID":
    case "UNPAID_PAST_DUE":
    case "FREIGHT_OVERCHARGED":
    case "RETURN_NOT_RECEIVED":
      return "risk";
    default:
      return "neutral";
  }
}

export const FLAG_LABELS: Record<string, string> = {
  TAX_ADDED_BACK: "GST TCS and income tax TDS were added back to the payout",
  MULTIPLE_PAYMENTS: "More than one payment was added together",
  RETURN_FREIGHT_DEDUCTED: "The return freight billed was deducted from what was received",
  RETURN_DATE_ASSUMED:
    "The file has no return date, so another date was used for the return window",
  PAYMENT_NOT_TRACKED: "No payment file exists for this kind of order",
  FREIGHT_OVERCHARGED: "Freight billed is above the rate card",
};

export const CALC_PROBLEM_LABELS: Record<string, string> = {
  NO_RATE_CARD: "No rate card applies to this order's channel, courier and date.",
  MISSING_WEIGHT: "The delivery charge depends on weight, and the order file has no weight.",
  NO_SLAB_FOR_WEIGHT: "The rate card has no delivery charge for this weight.",
  NO_REVERSE_FREIGHT_RULE: "The rate card has no return delivery charge.",
};

export const SORT_LABELS = {
  difference: "Biggest loss first",
  orderDate: "Newest first",
} as const;

/** The filter chips, in the order a finance person works through them: problems first. */
export const STATUS_ORDER: OrderStatus[] = [
  "UNPAID_PAST_DUE",
  "SHORT_PAID",
  "FREIGHT_OVERCHARGED",
  "RETURN_NOT_RECEIVED",
  "OVERPAID",
  "PENDING",
  "NOT_TRACKED",
  "CANNOT_CALCULATE",
  "SETTLED",
];

const countFormat = new Intl.NumberFormat("en-IN");
export const formatCount = (value: number) => countFormat.format(value);

const dateFormat = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "UTC" });
const dateTimeFormat = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
});

export const formatDate = (iso: string) => dateFormat.format(new Date(iso));
export const formatDateTime = (iso: string) => dateTimeFormat.format(new Date(iso));

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Pending and untracked orders have no loss yet, so their difference is shown without red. */
export function showsLoss(status: OrderStatus): boolean {
  return status !== "PENDING" && status !== "NOT_TRACKED" && status !== "CANNOT_CALCULATE";
}
