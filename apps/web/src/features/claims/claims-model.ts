import type { BadgeVariant } from "../../components/ui";
import type { ClaimStatus } from "./claims-api";

export const STATUS_LABELS: Record<ClaimStatus, string> = {
  OPEN: "Open",
  EXPORTED: "Evidence exported",
  RECOVERED: "Recovered",
  CLOSED: "Closed",
};

export const STATUS_HELP: Record<ClaimStatus, string> = {
  OPEN: "Still collecting orders. It changes when results change.",
  EXPORTED: "The evidence was handed over. This claim no longer changes.",
  RECOVERED: "Money came back.",
  CLOSED: "Dropped, with nothing more to do.",
};

export function statusVariant(status: ClaimStatus): BadgeVariant {
  return status === "OPEN" ? "accent" : "neutral";
}

/** The amount typed for "recovered": whole rupees or two decimals, nothing else. */
export const RECOVERED_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

export function recoveredProblem(text: string, total: string): string | null {
  const value = text.trim();
  if (!RECOVERED_PATTERN.test(value)) return "Enter the amount in rupees, like 1409 or 1409.50.";
  if (Number(value) <= 0) return "Enter an amount more than zero.";
  if (Number(value) > Number(total)) return `It cannot be more than the claim, ${total}.`;
  return null;
}

/** Saves text as a file in the browser. Nothing is sent anywhere. */
export function downloadText(fileName: string, text: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ageText(days: number | null): string {
  if (days === null) return "\u2014";
  return days === 1 ? "1 day" : `${days} days`;
}
