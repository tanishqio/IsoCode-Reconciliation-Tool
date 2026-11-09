// Rate card money. Amounts are stored as rupees with two decimals and travel as text ("60.00").
// All arithmetic is done on whole paise (BigInt). No floating point is used anywhere.

const AMOUNT_PATTERN = /^(\d{1,12})(?:\.(\d{1,2}))?$/;

/** "60", "60.5" or "60.50" -> 6000n, 6050n, 6050n. Returns null if the text is not a valid amount. */
export function parseAmountToPaise(text: string): bigint | null {
  const match = AMOUNT_PATTERN.exec(text.trim());
  if (!match) return null;
  const [, whole = "0", fraction = ""] = match;
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

/** 6050n -> "60.50"; -6000n -> "-60.00". */
export function paiseToAmount(paise: bigint): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const whole = (abs / 100n).toString();
  const fraction = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** A Prisma Decimal(14,2) (or any value with toFixed) -> whole paise. */
export function decimalToPaise(value: { toFixed(digits: number): string }): bigint {
  const text = value.toFixed(2);
  const negative = text.startsWith("-");
  const paise = parseAmountToPaise(negative ? text.slice(1) : text);
  if (paise === null) throw new RangeError(`Not a valid money amount: ${text}`);
  return negative ? -paise : paise;
}

/** share = value * basisPoints / 10,000, rounded half up to the nearest paisa. Value must not be negative. */
export function shareOfPaise(valuePaise: bigint, basisPoints: number): bigint {
  return (valuePaise * BigInt(basisPoints) + 5000n) / 10000n;
}
