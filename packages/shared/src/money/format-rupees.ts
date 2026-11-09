// Money is always rupees with two decimals, held as text ("1499.00") or as a number that has at most
// two decimals. Arithmetic is never done on floats here: the text is split and grouped as digits.

const MINUS = "\u2212"; // a true minus sign, not a hyphen
const RUPEE = "\u20B9";
const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

/** Indian digit grouping for a string of digits: 1234567 -> "12,34,567". */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${lastThree}`;
}

function toDecimalText(value: string | number): string {
  if (typeof value === "string") return value.trim();
  if (!Number.isFinite(value)) throw new RangeError(`Money must be a finite number, got ${value}`);
  const text = value.toFixed(2);
  // A number with more than two decimals (or float noise) is a bug upstream. Fail loudly.
  if (Math.abs(Number(text) - value) > 1e-7) {
    throw new RangeError(`Money must have at most two decimals, got ${String(value)}`);
  }
  return text;
}

export interface FormatRupeesOptions {
  /** Show the rupee sign. Default true. */
  symbol?: boolean;
}

/** "123456" -> "₹1,23,456.00"; "-37" -> "−₹37.00"; 1499 -> "₹1,499.00". */
export function formatRupees(value: string | number, options: FormatRupeesOptions = {}): string {
  const { symbol = true } = options;
  const match = DECIMAL_PATTERN.exec(toDecimalText(value));
  if (!match) throw new RangeError(`Money must be a decimal amount, got ${String(value)}`);
  const [, sign = "", whole = "0", fraction = ""] = match;
  const wholeDigits = whole.replace(/^0+(?=\d)/, "");
  const fractionDigits = fraction.padEnd(2, "0");
  const isZero = /^0*$/.test(wholeDigits) && fractionDigits === "00";
  const negative = sign === "-" && !isZero;
  return `${negative ? MINUS : ""}${symbol ? RUPEE : ""}${groupIndian(wholeDigits)}.${fractionDigits}`;
}

/** True when the amount is below zero. Works on the text form, so nothing is rounded. */
export function isNegativeAmount(value: string | number): boolean {
  const match = DECIMAL_PATTERN.exec(toDecimalText(value));
  if (!match) throw new RangeError(`Money must be a decimal amount, got ${String(value)}`);
  const [, sign = "", whole = "0", fraction = ""] = match;
  return sign === "-" && !(/^0*$/.test(whole) && /^0*$/.test(fraction));
}
