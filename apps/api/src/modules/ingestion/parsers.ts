// Turns one raw cell into a clean value, or throws a CellError that becomes a rejected row.
// Money is kept as exact text ("1499.00"), never as a float.

/** A cell as read from CSV (always text) or Excel (text, number, boolean or empty). */
export type Cell = string | number | boolean | null | undefined;

export class CellError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CellError";
    this.code = code;
  }
}

const MAX_TEXT_LENGTH = 200;
const MAX_ID_LENGTH = 100;
const MAX_WHOLE_NUMBER = 1_000_000_000;

function isBlank(cell: Cell): cell is null | undefined | "" {
  return cell === null || cell === undefined || (typeof cell === "string" && cell.trim() === "");
}

function asText(cell: Cell): string {
  return String(cell)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

export function parseText(cell: Cell): string | null {
  if (isBlank(cell)) return null;
  const text = asText(cell).replace(/\s+/g, " ");
  if (text === "") return null;
  if (text.length > MAX_TEXT_LENGTH) {
    throw new CellError("TEXT_TOO_LONG", `Text is longer than ${MAX_TEXT_LENGTH} characters.`);
  }
  return text;
}

/** Order IDs, AWBs and references: trimmed, upper-case, with spreadsheet damage caught. */
export function parseId(cell: Cell): string | null {
  if (isBlank(cell)) return null;
  if (typeof cell === "number") {
    if (!Number.isFinite(cell)) throw new CellError("BAD_ID", "The ID is not a valid number.");
    if (Number.isInteger(cell) && Math.abs(cell) > Number.MAX_SAFE_INTEGER) {
      throw new CellError(
        "ID_PRECISION_LOST",
        "The ID is a number too long for Excel to keep exactly. Save the column as text.",
      );
    }
    return String(cell);
  }
  let text = asText(cell).replace(/^'+/, "").replace(/\s+/g, " ").toUpperCase();
  if (text === "") return null;
  if (/^\d+(\.\d+)?E[+-]?\d+$/.test(text)) {
    // Excel shows long numbers like 1.23457E+11 and drops the digits it cannot show, so the
    // real ID cannot be rebuilt. Guessing would match the wrong order.
    throw new CellError(
      "ID_SCIENTIFIC_NOTATION",
      `"${text}" looks like a number Excel shortened. Save the ID column as text and upload again.`,
    );
  }
  // 12345.0 (an ID that went through a spreadsheet as a decimal number) -> 12345
  if (/^\d+\.0+$/.test(text)) text = text.replace(/\.0+$/, "");
  if (text.length > MAX_ID_LENGTH) {
    throw new CellError("BAD_ID", `The ID is longer than ${MAX_ID_LENGTH} characters.`);
  }
  return text;
}

/**
 * An amount in rupees as text with exactly two decimals. Accepts "1,499", "₹1,499.00",
 * "Rs. 862.4", "(37.00)" (negative) and Excel numbers. More than two real decimals is rejected
 * instead of rounded, because rounding hides money.
 */
export function parseMoney(cell: Cell): string | null {
  if (isBlank(cell)) return null;
  if (typeof cell === "boolean") throw new CellError("BAD_AMOUNT", "The amount is not a number.");

  let text: string;
  if (typeof cell === "number") {
    if (!Number.isFinite(cell)) throw new CellError("BAD_AMOUNT", "The amount is not a number.");
    text = cell.toFixed(2);
    if (Math.abs(Number(text) - cell) > 1e-7) {
      throw new CellError("BAD_AMOUNT", `The amount ${String(cell)} has more than two decimals.`);
    }
  } else {
    text = asText(cell)
      .replace(/\u00A0/g, " ")
      .replace(/(^|\s)(rs\.?|inr)(?=\s|\d|-|\(|$)/gi, " ")
      .replace(/₹/g, "")
      .replace(/\s+/g, "");
    let negative = false;
    if (/^\(.*\)$/.test(text)) {
      negative = true;
      text = text.slice(1, -1);
    }
    if (text.endsWith("-")) {
      negative = true;
      text = text.slice(0, -1);
    }
    text = text.replace(/,/g, "");
    if (text.startsWith("-")) {
      negative = !negative;
      text = text.slice(1);
    } else if (text.startsWith("+")) {
      text = text.slice(1);
    }
    if (!/^\d+(\.\d*)?$|^\.\d+$/.test(text)) {
      throw new CellError("BAD_AMOUNT", `"${asText(cell).slice(0, 40)}" is not a valid amount.`);
    }
    const [wholePart = "", fractionPart = ""] = text.split(".");
    if (/[1-9]/.test(fractionPart.slice(2))) {
      throw new CellError(
        "BAD_AMOUNT",
        `"${asText(cell).slice(0, 40)}" has more than two decimals.`,
      );
    }
    text = `${negative ? "-" : ""}${wholePart === "" ? "0" : wholePart}.${fractionPart.slice(0, 2).padEnd(2, "0")}`;
  }

  const negative = text.startsWith("-");
  const [whole = "0", fraction = "00"] = text.replace("-", "").split(".");
  const wholeDigits = whole.replace(/^0+(?=\d)/, "");
  if (wholeDigits.length > 12) {
    throw new CellError(
      "BAD_AMOUNT",
      "The amount is too large (more than 12 digits before the decimal point).",
    );
  }
  const isZero = /^0+$/.test(wholeDigits) && fraction === "00";
  return `${negative && !isZero ? "-" : ""}${wholeDigits}.${fraction}`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function buildDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    year < 1990 ||
    year > 2100 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new CellError("BAD_DATE", "The date is not a real calendar date.");
  }
  return date;
}

function to24Hour(hour: number, meridiem: string | undefined): number {
  if (!meridiem) return hour;
  const pm = meridiem.toUpperCase() === "PM";
  if (hour < 1 || hour > 12) throw new CellError("BAD_DATE", "The time is not valid.");
  return (hour % 12) + (pm ? 12 : 0);
}

/**
 * Dates are read as written and kept as UTC wall-clock time (no time-zone shift), unless the
 * text carries an explicit Z or offset. Day-first order is assumed for 03/11/2026 [ASSUME: India].
 * Excel serial numbers are converted without using the computer's time zone.
 */
export function parseDate(cell: Cell): Date | null {
  if (isBlank(cell)) return null;
  if (typeof cell === "boolean") throw new CellError("BAD_DATE", "The date is not valid.");

  if (typeof cell === "number") {
    if (!Number.isFinite(cell) || cell < 20000 || cell > 80000) {
      throw new CellError("BAD_DATE", `The number ${String(cell)} is not a date.`);
    }
    return new Date(Math.round((cell - 25569) * 86400) * 1000);
  }

  const text = asText(cell);

  const iso =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(
      text,
    );
  if (iso) {
    const date = buildDate(
      Number(iso[1]),
      Number(iso[2]),
      Number(iso[3]),
      Number(iso[4] ?? 0),
      Number(iso[5] ?? 0),
      Number(iso[6] ?? 0),
    );
    const zone = iso[7];
    if (zone && zone.toUpperCase() !== "Z") {
      const sign = zone.startsWith("-") ? -1 : 1;
      const digits = zone.slice(1).replace(":", "");
      const offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
      return new Date(date.getTime() - offsetMinutes * 60_000);
    }
    return date;
  }

  const dayFirst =
    /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(
      text,
    );
  if (dayFirst) {
    const yearText = dayFirst[3] ?? "";
    const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
    return buildDate(
      year,
      Number(dayFirst[2]),
      Number(dayFirst[1]),
      to24Hour(Number(dayFirst[4] ?? 0), dayFirst[7]),
      Number(dayFirst[5] ?? 0),
      Number(dayFirst[6] ?? 0),
    );
  }

  const named =
    /^(\d{1,2})[ \-/]([A-Za-z]{3,9})[ \-/,]+(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(
      text,
    );
  if (named) {
    const month = MONTHS.indexOf((named[2] ?? "").slice(0, 3).toLowerCase()) + 1;
    if (month > 0) {
      return buildDate(
        Number(named[3]),
        month,
        Number(named[1]),
        to24Hour(Number(named[4] ?? 0), named[7]),
        Number(named[5] ?? 0),
        Number(named[6] ?? 0),
      );
    }
  }

  throw new CellError("BAD_DATE", `"${text.slice(0, 40)}" is not a recognised date.`);
}

/** Weights and similar: a whole number of units. "500", "500.0" and "1,200" are accepted. */
export function parseWholeNumber(cell: Cell): number | null {
  if (isBlank(cell)) return null;
  let value: number;
  if (typeof cell === "number") value = cell;
  else if (typeof cell === "boolean") value = Number.NaN;
  else {
    const text = asText(cell).replace(/,/g, "");
    value = /^\d+(\.0+)?$/.test(text) ? Number(text) : Number.NaN;
  }
  if (!Number.isInteger(value) || value < 0 || value > MAX_WHOLE_NUMBER) {
    throw new CellError("BAD_NUMBER", `"${asText(cell).slice(0, 40)}" is not a whole number.`);
  }
  return value;
}

export type PaymentTypeValue = "COD" | "PREPAID";

export function parsePaymentType(cell: Cell): PaymentTypeValue | null {
  if (isBlank(cell)) return null;
  const key = asText(cell)
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (["cod", "cashondelivery", "cash"].includes(key)) return "COD";
  if (["prepaid", "online", "paid"].includes(key)) return "PREPAID";
  throw new CellError("BAD_PAYMENT_TYPE", `"${asText(cell).slice(0, 40)}" is not COD or prepaid.`);
}

export type ChargeTypeValue = "FORWARD" | "REVERSE" | "COD_FEE" | "OTHER";

/** Charge types are grouped by name. Anything not recognised is OTHER, not rejected. */
export function parseChargeType(cell: Cell): ChargeTypeValue {
  if (isBlank(cell)) return "OTHER";
  const key = asText(cell)
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (["forward", "fwd", "forwardfreight", "forwardcharge"].includes(key)) return "FORWARD";
  if (
    ["reverse", "rvp", "reversefreight", "reversecharge", "return", "returnfreight"].includes(key)
  )
    return "REVERSE";
  if (["codfee", "codcharge", "codcharges", "cod"].includes(key)) return "COD_FEE";
  return "OTHER";
}
