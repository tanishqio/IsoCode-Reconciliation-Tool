import { formatRupees, isNegativeAmount } from "@leaklens/shared";
import { cn } from "./cn";

export interface MoneyProps {
  /**
   * An amount in rupees as text ("1499.00") or a number with at most two decimals.
   * null or undefined shows a dash (for example, nothing received yet).
   */
  amount: string | number | null | undefined;
  /**
   * neutral: a negative amount shows a minus sign in the normal text colour.
   * difference: a negative amount is also red and semibold. Use it only for a Difference column
   * and for money-at-risk totals, so red keeps its meaning.
   */
  tone?: "neutral" | "difference";
  /** Show the rupee sign. Default true. */
  symbol?: boolean;
  className?: string;
}

export function Money({ amount, tone = "neutral", symbol = true, className }: MoneyProps) {
  if (amount === null || amount === undefined) {
    return (
      <span className={cn("text-muted", className)}>
        <span aria-hidden="true">{"\u2014"}</span>
        <span className="sr-only">No amount</span>
      </span>
    );
  }
  const atRisk = tone === "difference" && isNegativeAmount(amount);
  return (
    <span
      className={cn(
        "whitespace-nowrap tabular-nums",
        // The minus sign is always shown, so colour is never the only signal.
        atRisk && "font-semibold text-risk",
        className,
      )}
    >
      {formatRupees(amount, { symbol })}
    </span>
  );
}
