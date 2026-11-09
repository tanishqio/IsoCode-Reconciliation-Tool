import { cn } from "./cn";
import { formatPaise } from "./format-paise";

export interface MoneyProps {
  /** Integer paise. null or undefined shows a dash (for example, nothing received yet). */
  paise: number | bigint | null | undefined;
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

export function Money({ paise, tone = "neutral", symbol = true, className }: MoneyProps) {
  if (paise === null || paise === undefined) {
    return (
      <span className={cn("text-muted", className)}>
        <span aria-hidden="true">{"\u2014"}</span>
        <span className="sr-only">No amount</span>
      </span>
    );
  }
  const atRisk = tone === "difference" && paise < 0;
  return (
    <span
      className={cn(
        "whitespace-nowrap tabular-nums",
        // The minus sign is always shown, so colour is never the only signal.
        atRisk && "font-semibold text-risk",
        className,
      )}
    >
      {formatPaise(paise, { symbol })}
    </span>
  );
}
