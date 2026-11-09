// Money is always integer paise. No floating point is used anywhere in this file.

const MINUS = "\u2212"; // a true minus sign, not a hyphen
const RUPEE = "\u20B9";

function toBigInt(value: number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isSafeInteger(value)) {
    // A fractional or unsafe number here is a bug upstream. Fail loudly instead of showing a wrong amount.
    throw new RangeError(`Money must be a whole number of paise, got ${String(value)}`);
  }
  return BigInt(value);
}

/** Indian digit grouping for a string of digits: 1234567 -> "12,34,567". */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${lastThree}`;
}

export interface FormatPaiseOptions {
  /** Show the rupee sign. Default true. */
  symbol?: boolean;
}

/** 12345600 -> "₹1,23,456.00"; -3700 -> "−₹37.00". */
export function formatPaise(value: number | bigint, options: FormatPaiseOptions = {}): string {
  const { symbol = true } = options;
  const paise = toBigInt(value);
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const rupees = groupIndian((abs / 100n).toString());
  const fraction = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? MINUS : ""}${symbol ? RUPEE : ""}${rupees}.${fraction}`;
}
