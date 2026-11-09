import { CLAIM_TYPE_LABELS, claimLabel } from "./claim-rules.js";
import type { Evidence } from "./evidence.js";
import type { ClaimType } from "../../../generated/prisma/enums.js";

// The evidence export: one CSV file per claim, one row per claimed order, with the working and the
// source file and row of every line that counts. Amounts are in rupees (INR) as plain numbers, a
// loss is a positive "claimed" amount and a negative difference.

const FORMULA_START = /^[=+\-@\t\r]/;

/** Quotes a cell. Text that a spreadsheet could run as a formula gets a leading apostrophe. */
export function csvText(value: string | null | undefined): string {
  let text = value ?? "";
  if (FORMULA_START.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** A number or amount cell: not touched, because "-46.00" is a real negative number. */
export function csvNumber(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

const HEADERS = [
  "Claim",
  "Partner",
  "Order ID",
  "Problem",
  "Amount claimed (INR)",
  "Expected (INR)",
  "Received (INR)",
  "Difference (INR)",
  "Order date",
  "Due or age date",
  "Age (days)",
  "Channel",
  "Courier",
  "AWB",
  "Delivery status",
  "Rate card version",
  "How the expected amount was worked out",
  "What counted as received",
  "Source lines (file and row)",
];

export interface CsvItem {
  orderId: string;
  claimType: ClaimType;
  amount: string;
  ageBasisDate: Date;
  ageDays: number;
  evidence: Evidence;
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
const parts = (list: { label: string; amount: string }[]) =>
  list.map((entry) => `${entry.label}: ${entry.amount}`).join("; ");

/** The whole file, with a byte-order mark so Excel reads the text as UTF-8. */
export function buildClaimCsv(args: {
  claimNo: number;
  partner: string;
  items: readonly CsvItem[];
}): string {
  const label = claimLabel(args.claimNo);
  const rows = args.items.map((item) => {
    const e = item.evidence;
    const lines = e.lines
      .map((line) =>
        [
          line.kind,
          line.partner ? `from ${line.partner}` : "",
          day(line.date),
          line.reference ?? "",
          line.amount ?? "",
          `${line.file}, row ${line.row}`,
        ]
          .filter((piece) => piece !== "")
          .join(" "),
      )
      .join(" | ");
    return [
      csvText(label),
      csvText(args.partner),
      csvText(item.orderId),
      csvText(CLAIM_TYPE_LABELS[item.claimType]),
      csvNumber(item.amount),
      csvNumber(e.result?.expected),
      csvNumber(e.result?.received),
      csvNumber(e.result?.difference),
      csvText(day(e.order?.orderDate ?? null)),
      csvText(day(item.ageBasisDate.toISOString())),
      csvNumber(item.ageDays),
      csvText(e.order?.channel),
      csvText(e.order?.courier),
      csvText(e.order?.awb),
      csvText(e.order?.deliveryStatus),
      csvNumber(e.result?.rateCardVersion),
      csvText(parts(e.working ?? [])),
      csvText(parts(e.received ?? [])),
      csvText(lines),
    ].join(",");
  });
  return `\uFEFF${HEADERS.map((header) => csvText(header)).join(",")}\r\n${rows.join("\r\n")}${rows.length ? "\r\n" : ""}`;
}

export function claimFileName(claimNo: number, partner: string): string {
  const safe = partner
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${claimLabel(claimNo).toLowerCase()}-${safe || "partner"}-evidence.csv`;
}
