// Pure helpers for the dashboard screens: tabs, money arithmetic on text amounts, and wording.
// Money is added as whole paise (BigInt), never as floating point.

export type TabId = "risk" | "tax" | "activity";

export const TAB_LABELS: Record<TabId, string> = {
  risk: "Money at risk",
  tax: "TCS and TDS",
  activity: "Activity",
};

/** The tab named in the address (?tab=tax). Unknown names, and Activity for anyone but the co-founder, fall back to the first tab. */
export function parseTab(value: string | null, canSeeActivity: boolean): TabId {
  if (value === "tax") return "tax";
  if (value === "activity" && canSeeActivity) return "activity";
  return "risk";
}

const AMOUNT = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

/** "1234.5" -> 123450n; "-12.30" -> -1230n. Throws on anything that is not a plain amount. */
export function toPaise(amount: string): bigint {
  const match = AMOUNT.exec(amount.trim());
  if (!match) throw new RangeError(`Not an amount: ${amount}`);
  const [, sign = "", whole = "0", fraction = ""] = match;
  const paise = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return sign === "-" ? -paise : paise;
}

export function fromPaise(paise: bigint): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  return `${negative ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

export function sumAmounts(amounts: readonly string[]): string {
  return fromPaise(amounts.reduce((total, amount) => total + toPaise(amount), 0n));
}

export function isPositive(amount: string): boolean {
  return toPaise(amount) > 0n;
}

/** part as a whole-number percentage of whole (rounded), or null when whole is zero. */
export function percentOf(part: string, whole: string): number | null {
  const denominator = toPaise(whole);
  if (denominator <= 0n) return null;
  return Number((toPaise(part) * 100n + denominator / 2n) / denominator);
}

const countFormat = new Intl.NumberFormat("en-IN");
export const formatCount = (value: number): string => countFormat.format(value);

export const pluralise = (count: number, one: string, many = `${one}s`): string =>
  `${formatCount(count)} ${count === 1 ? one : many}`;

const dateFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** A date from the uploaded data (kept as UTC wall-clock time): "30 Nov 2026". */
export function formatDataDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}

const dateTimeFormat = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
});

/** A moment something happened, in the viewer's own time zone. */
export function formatWhen(iso: string): string {
  return dateTimeFormat.format(new Date(iso));
}

const monthFormat = new Intl.DateTimeFormat("en-IN", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** "2026-10" -> "October 2026". */
export function monthLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  return monthFormat.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}

export const KIND_LABELS: Record<string, string> = {
  WEBSITE: "Website",
  MARKETPLACE: "Marketplace",
  QUICK_COMMERCE: "Quick commerce",
  COURIER_AGGREGATOR: "Courier",
  WAREHOUSE: "Warehouse",
};

export const ENTITY_LABELS: Record<string, string> = {
  USER: "Account",
  RATE_CARD: "Rate card",
  UPLOADED_FILE: "File",
  MAPPING_VERSION: "Column mapping",
  PROCESSING_JOB: "Calculation",
};

export const entityLabel = (entityType: string): string => ENTITY_LABELS[entityType] ?? entityType;

const FILE_TYPE_LABELS: Record<string, string> = {
  ORDERS: "Orders",
  SETTLEMENT: "Settlement",
  COD_REMITTANCE: "COD remittance",
  FREIGHT_INVOICE: "Freight invoice",
  RETURN_SCAN: "Return scan",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A short sentence fragment from an audit entry's details. Only fields with a friendly meaning are
 * shown; ids and anything else stay hidden, so the screen never fills with raw identifiers.
 */
export function describeAuditMeta(meta: Record<string, string | number | boolean | null>): string {
  const parts: string[] = [];
  const fileType = meta["fileType"];
  if (typeof fileType === "string") parts.push(FILE_TYPE_LABELS[fileType] ?? fileType);
  const size = meta["sizeBytes"];
  if (typeof size === "number") parts.push(formatSize(size));
  const version = meta["versionNo"];
  if (typeof version === "number") parts.push(`version ${version}`);
  const queued = meta["queuedFiles"];
  if (typeof queued === "number" && queued > 0) parts.push(pluralise(queued, "file") + " queued");
  if (meta["alreadyQueued"] === true) parts.push("a calculation was already waiting");
  return parts.join(" \u00B7 ");
}
