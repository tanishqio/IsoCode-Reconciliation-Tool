import type { BadgeVariant } from "../../components/ui";
import type { LineKind } from "./review-api";

export const KIND_LABELS: Record<LineKind, string> = {
  SETTLEMENT: "Settlement payout",
  COD_REMITTANCE: "COD remittance",
  FREIGHT: "Freight invoice line",
  RETURN_SCAN: "Warehouse return scan",
};

/** How sure the rules are, in words. The number itself is not shown to the person. */
export function strength(score: number): { label: string; variant: BadgeVariant } {
  if (score >= 85) return { label: "Strong match", variant: "accent" };
  if (score >= 70) return { label: "Likely match", variant: "neutral" };
  return { label: "Possible match", variant: "neutral" };
}

export function partnerLine(kind: LineKind, partner: string): string {
  return kind === "RETURN_SCAN" ? KIND_LABELS[kind] : `${KIND_LABELS[kind]} from ${partner}`;
}

/** What the line itself says about its order, for the person comparing it with a suggestion. */
export function describeLineIds(orderIdOnLine: string | null, awb: string | null): string {
  const parts = [
    orderIdOnLine ? `Order ID on the line: ${orderIdOnLine}` : "No order ID on the line",
    awb ? `AWB: ${awb}` : "no AWB",
  ];
  return parts.join(", ");
}

export const SUGGESTION_LIMIT_NOTE =
  "A suggestion is only a proposal. The line stays unmatched until you accept it.";
