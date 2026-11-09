import { createHash } from "node:crypto";
import type { FileType } from "../../../generated/prisma/enums.js";
import { FIELD_SPECS, ONE_OF_REQUIRED, type FieldSpec } from "./fields.js";
import {
  CellError,
  parseChargeType,
  parseDate,
  parseId,
  parseMoney,
  parsePaymentType,
  parseText,
  parseWholeNumber,
  type Cell,
} from "./parsers.js";
import type { RawTable } from "./read-table.js";

type Value = string | number | Date | null;

/** A row that is ready to be written. Keys are the database column names of its table. */
export type StagedRecord = Record<string, string | number | null>;

export interface RejectedItem {
  rowNumber: number;
  reasonCode: string;
  message: string;
  rawSnippet: string | null;
}

export interface TransformInput {
  fileType: FileType;
  /** The source the file was uploaded for: the channel, aggregator or warehouse. */
  sourceId: string;
  sourceFileId: string;
  table: RawTable;
  /** Standard field -> column index in the file. */
  indexes: ReadonlyMap<string, number>;
  /** Lower-case courier name -> source id, to link orders to their courier. */
  couriers: ReadonlyMap<string, string>;
}

export interface TransformResult {
  records: StagedRecord[];
  rejected: RejectedItem[];
  /** Rows identical to an earlier row of the same file. */
  duplicateRows: number;
}

const SNIPPET_LENGTH = 300;

export function parseField(spec: FieldSpec, cell: Cell): Value {
  switch (spec.kind) {
    case "id":
      return parseId(cell);
    case "text":
      return parseText(cell);
    case "money":
      return parseMoney(cell);
    case "date":
      return parseDate(cell);
    case "wholeNumber":
      return parseWholeNumber(cell);
    case "paymentType":
      return parsePaymentType(cell);
    case "chargeType":
      return parseChargeType(cell);
  }
}

function iso(value: Value): string | number | null {
  return value instanceof Date ? value.toISOString() : (value as string | number | null);
}

function hashOf(parts: readonly (string | number | null)[]): string {
  return createHash("sha256")
    .update(parts.map((part) => (part === null ? "\u0000" : String(part))).join("\u001f"))
    .digest("hex");
}

/** Only the values of the mapped columns. Other columns (possibly personal data) are never kept. */
function snippetOf(row: { cells: Cell[] }, indexes: ReadonlyMap<string, number>): string {
  const parts: string[] = [];
  for (const [field, index] of indexes) {
    const cell = row.cells[index];
    if (cell !== null && cell !== undefined && String(cell) !== "") {
      parts.push(`${field}=${String(cell).slice(0, 60)}`);
    }
  }
  return parts.join("; ").slice(0, SNIPPET_LENGTH);
}

interface Built {
  record: StagedRecord;
  /** Same natural key = same business row (for example the same order ID). null = none. */
  naturalKey: string | null;
}

function build(
  input: TransformInput,
  v: Record<string, Value>,
  rowNumber: number,
  rowHash: string,
): Built {
  const base = {
    sourceFileId: input.sourceFileId,
    sourceRowNumber: rowNumber,
    rowHash,
  };
  const orderIdRaw = (v["orderId"] as string | null) ?? null;
  const text = (name: string) => (v[name] as string | null) ?? null;
  const zero = (name: string) => (v[name] as string | null) ?? "0.00";

  switch (input.fileType) {
    case "ORDERS": {
      const courier = text("courier");
      return {
        naturalKey: text("orderId"),
        record: {
          ...base,
          orderId: text("orderId"),
          channelSourceId: input.sourceId,
          orderDate: iso(v["orderDate"] ?? null),
          value: text("value"),
          paymentType: text("paymentType"),
          deliveryStatus: text("deliveryStatus"),
          awb: text("awb"),
          courierSourceId: courier ? (input.couriers.get(courier.toLowerCase()) ?? null) : null,
          weightGrams: (v["weightGrams"] as number | null) ?? null,
          deliveredAt: iso(v["deliveredAt"] ?? null),
          returnedAt: iso(v["returnedAt"] ?? null),
        },
      };
    }
    case "SETTLEMENT":
      return {
        naturalKey: text("lineRef"),
        record: {
          ...base,
          orderIdRaw,
          sourceId: input.sourceId,
          lineRef: text("lineRef"),
          settledOn: iso(v["settledOn"] ?? null),
          lineType: (text("lineType") ?? "UNSPECIFIED").toUpperCase(),
          netReceived: text("netReceived"),
          tcs: zero("tcs"),
          tds: zero("tds"),
          otherDeductions: zero("otherDeductions"),
        },
      };
    case "COD_REMITTANCE": {
      const ref = text("remittanceRef");
      return {
        naturalKey: ref ? `${ref}|${text("awb") ?? ""}` : null,
        record: {
          ...base,
          orderIdRaw,
          aggregatorSourceId: input.sourceId,
          awb: text("awb"),
          remittanceRef: ref,
          remittedOn: iso(v["remittedOn"] ?? null),
          remittedAmount: text("remittedAmount"),
        },
      };
    }
    case "FREIGHT_INVOICE":
      return {
        naturalKey: null,
        record: {
          ...base,
          orderIdRaw,
          aggregatorSourceId: input.sourceId,
          invoiceNo: text("invoiceNo"),
          awb: text("awb"),
          chargeType: text("chargeType"),
          billedWeightGrams: (v["billedWeightGrams"] as number | null) ?? null,
          billedAmount: text("billedAmount"),
          chargedOn: iso(v["chargedOn"] ?? null),
        },
      };
    case "RETURN_SCAN":
      return {
        naturalKey: null,
        record: {
          ...base,
          orderIdRaw,
          warehouseSourceId: input.sourceId,
          awb: text("awb"),
          scannedAt: iso(v["scannedAt"] ?? null),
        },
      };
  }
}

/**
 * Validates and cleans every row. A bad row goes to `rejected` with a reason and never stops the
 * file. Rows identical to an earlier row are counted and dropped. A later row with the same
 * natural key (for example the same order ID) but different values is rejected, and the first
 * row is kept.
 */
export function transformTable(input: TransformInput): TransformResult {
  const specs = FIELD_SPECS[input.fileType];
  const oneOf = ONE_OF_REQUIRED[input.fileType];
  const records: StagedRecord[] = [];
  const rejected: RejectedItem[] = [];
  const seenHashes = new Set<string>();
  const seenKeys = new Set<string>();
  let duplicateRows = 0;

  for (const row of input.table.rows) {
    const reject = (reasonCode: string, message: string) =>
      rejected.push({
        rowNumber: row.rowNumber,
        reasonCode,
        message,
        rawSnippet: snippetOf(row, input.indexes) || null,
      });

    const values: Record<string, Value> = {};
    let failed = false;
    for (const spec of specs) {
      const index = input.indexes.get(spec.name);
      if (index === undefined) {
        values[spec.name] = spec.kind === "chargeType" ? "OTHER" : null;
        continue;
      }
      try {
        const parsed = parseField(spec, row.cells[index]);
        if (parsed === null && spec.required) {
          reject("MISSING_VALUE", `${spec.label} is empty.`);
          failed = true;
          break;
        }
        values[spec.name] = parsed;
      } catch (err) {
        if (!(err instanceof CellError)) throw err;
        reject(err.code, `${spec.label}: ${err.message}`);
        failed = true;
        break;
      }
    }
    if (failed) continue;

    if (oneOf && oneOf.every((field) => values[field] === null || values[field] === undefined)) {
      reject("MISSING_KEY", `Needs ${oneOf.join(" or ")} so the scan can be matched.`);
      continue;
    }
    if (input.fileType === "ORDERS" && String(values["value"]).startsWith("-")) {
      reject("BAD_AMOUNT", "Order value (₹): an order value cannot be negative.");
      continue;
    }

    // The hash covers the cleaned values, the source and the file type, never the row number.
    const hash = hashOf([
      input.fileType,
      input.sourceId,
      ...specs.map((spec) => iso(values[spec.name] ?? null)),
    ]);
    if (seenHashes.has(hash)) {
      duplicateRows += 1;
      continue;
    }

    const built = build(input, values, row.rowNumber, hash);
    if (built.naturalKey !== null) {
      if (seenKeys.has(built.naturalKey)) {
        reject(
          "CONFLICTING_DUPLICATE",
          `Another row in this file already uses the same key "${built.naturalKey}" with different values.`,
        );
        continue;
      }
      seenKeys.add(built.naturalKey);
    }
    seenHashes.add(hash);
    records.push(built.record);
  }

  return { records, rejected, duplicateRows };
}
