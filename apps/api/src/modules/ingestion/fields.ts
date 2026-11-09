import type { FileType } from "../../../generated/prisma/enums.js";
import { normaliseHeader } from "../../lib/header-signature.js";

/**
 * The standard field names for each file type. This is the contract between ingestion (Part 3)
 * and column mapping (Part 4): a mapping is `{ standardField: "column name in the file" }`.
 *
 * Only the columns named in a mapping are ever read. Customer name, phone and address have no
 * standard field, so they are never read, stored, logged or sent anywhere.
 */
export type FieldKind =
  "id" | "text" | "money" | "date" | "wholeNumber" | "paymentType" | "chargeType";

export interface FieldSpec {
  name: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  /** Header names (case and spacing are ignored) that a file may use for this field. */
  aliases: string[];
}

export const FIELD_SPECS: Record<FileType, FieldSpec[]> = {
  ORDERS: [
    {
      name: "orderId",
      label: "Order ID",
      kind: "id",
      required: true,
      aliases: ["order id", "order no", "order number", "order ref", "order_id"],
    },
    {
      name: "orderDate",
      label: "Order date",
      kind: "date",
      required: true,
      aliases: [
        "order date",
        "ordered at",
        "order placed at",
        "order created at",
        "order_purchase_timestamp",
      ],
    },
    {
      name: "value",
      label: "Order value (₹)",
      kind: "money",
      required: true,
      aliases: [
        "value",
        "order value",
        "order amount",
        "order total",
        "invoice value",
        "selling price",
        "gmv",
      ],
    },
    {
      name: "paymentType",
      label: "Payment type (COD or prepaid)",
      kind: "paymentType",
      required: true,
      aliases: ["payment", "payment type", "payment mode", "payment method"],
    },
    {
      name: "deliveryStatus",
      label: "Delivery status",
      kind: "text",
      required: true,
      aliases: ["delivery status", "status", "order status", "shipment status"],
    },
    {
      name: "awb",
      label: "AWB",
      kind: "id",
      required: false,
      aliases: ["awb", "awb no", "awb number", "tracking number", "tracking no", "waybill"],
    },
    {
      name: "courier",
      label: "Courier",
      kind: "text",
      required: false,
      aliases: ["courier", "courier name", "aggregator", "shipping partner", "carrier"],
    },
    {
      name: "weightGrams",
      label: "Weight (grams)",
      kind: "wholeNumber",
      required: false,
      aliases: ["weight", "weight g", "weight grams", "weight (g)", "weight in grams"],
    },
    {
      name: "deliveredAt",
      label: "Delivered on",
      kind: "date",
      required: false,
      aliases: ["delivered at", "delivered on", "delivery date", "delivered date"],
    },
    {
      name: "returnedAt",
      label: "Returned on",
      kind: "date",
      required: false,
      aliases: ["returned at", "returned on", "return date", "rto date"],
    },
  ],
  SETTLEMENT: [
    {
      name: "orderId",
      label: "Order ID",
      kind: "id",
      required: false,
      aliases: ["order id", "order no", "order number", "order ref", "order_id"],
    },
    {
      name: "lineRef",
      label: "Settlement line reference",
      kind: "id",
      required: false,
      aliases: [
        "settlement id",
        "settlement ref",
        "line ref",
        "reference",
        "reference no",
        "transaction id",
        "txn id",
        "utr",
      ],
    },
    {
      name: "settledOn",
      label: "Settled on",
      kind: "date",
      required: true,
      aliases: ["settled on", "settlement date", "payout date", "paid on", "date"],
    },
    {
      name: "lineType",
      label: "Line type",
      kind: "text",
      required: false,
      aliases: ["line type", "transaction type", "entry type", "type"],
    },
    {
      name: "netReceived",
      label: "Net received (₹)",
      kind: "money",
      required: true,
      aliases: [
        "net received",
        "net amount",
        "net payout",
        "net settlement",
        "amount received",
        "settled amount",
        "payout",
        "received",
      ],
    },
    {
      name: "tcs",
      label: "GST TCS (₹)",
      kind: "money",
      required: false,
      aliases: ["tcs", "gst tcs", "tcs amount"],
    },
    {
      name: "tds",
      label: "Income tax TDS (₹)",
      kind: "money",
      required: false,
      aliases: ["tds", "income tax tds", "tds amount"],
    },
    {
      name: "otherDeductions",
      label: "Other deductions (₹)",
      kind: "money",
      required: false,
      aliases: ["other deductions", "deductions", "fees", "commission and fees"],
    },
  ],
  COD_REMITTANCE: [
    {
      name: "awb",
      label: "AWB",
      kind: "id",
      required: false,
      aliases: ["awb", "awb no", "awb number", "tracking number", "tracking no", "waybill"],
    },
    {
      name: "orderId",
      label: "Order ID",
      kind: "id",
      required: false,
      aliases: ["order id", "order no", "order number", "order ref", "order_id"],
    },
    {
      name: "remittanceRef",
      label: "Remittance reference (UTR)",
      kind: "id",
      required: false,
      aliases: [
        "utr",
        "remittance ref",
        "remittance id",
        "payment ref",
        "reference no",
        "reference",
      ],
    },
    {
      name: "remittedOn",
      label: "Remitted on",
      kind: "date",
      required: true,
      aliases: ["remitted on", "remittance date", "payment date", "paid on", "date"],
    },
    {
      name: "remittedAmount",
      label: "Remitted amount (₹)",
      kind: "money",
      required: true,
      aliases: [
        "remitted amount",
        "remittance amount",
        "amount remitted",
        "cod amount",
        "cod remitted",
        "amount",
      ],
    },
  ],
  FREIGHT_INVOICE: [
    {
      name: "invoiceNo",
      label: "Invoice number",
      kind: "id",
      required: true,
      aliases: ["invoice no", "invoice number", "invoice id", "invoice"],
    },
    {
      name: "awb",
      label: "AWB",
      kind: "id",
      required: false,
      aliases: ["awb", "awb no", "awb number", "tracking number", "tracking no", "waybill"],
    },
    {
      name: "orderId",
      label: "Order ID",
      kind: "id",
      required: false,
      aliases: ["order id", "order no", "order number", "order ref", "order_id"],
    },
    {
      name: "chargeType",
      label: "Charge type",
      kind: "chargeType",
      required: false,
      aliases: ["charge type", "charge", "type"],
    },
    {
      name: "billedWeightGrams",
      label: "Billed weight (grams)",
      kind: "wholeNumber",
      required: false,
      aliases: [
        "billed weight",
        "billed weight g",
        "billed weight grams",
        "charged weight",
        "weight",
      ],
    },
    {
      name: "billedAmount",
      label: "Billed amount (₹)",
      kind: "money",
      required: true,
      aliases: [
        "billed amount",
        "freight amount",
        "freight charge",
        "charge amount",
        "total charge",
        "amount",
      ],
    },
    {
      name: "chargedOn",
      label: "Charged on",
      kind: "date",
      required: false,
      aliases: ["charged on", "charge date", "invoice date", "date"],
    },
  ],
  RETURN_SCAN: [
    {
      name: "awb",
      label: "AWB",
      kind: "id",
      required: false,
      aliases: ["awb", "awb no", "awb number", "tracking number", "tracking no", "waybill"],
    },
    {
      name: "orderId",
      label: "Order ID",
      kind: "id",
      required: false,
      aliases: ["order id", "order no", "order number", "order ref", "order_id"],
    },
    {
      name: "scannedAt",
      label: "Scanned at",
      kind: "date",
      required: true,
      aliases: [
        "scanned at",
        "scan date",
        "scan time",
        "received at",
        "received on",
        "warehouse receipt date",
      ],
    },
  ],
};

/** Return scans must carry an AWB or an order ID, or they could never be matched to anything. */
export const ONE_OF_REQUIRED: Partial<Record<FileType, string[]>> = {
  RETURN_SCAN: ["awb", "orderId"],
};

/** A mapping from standard field name to the column name used in the file. */
export type ColumnMap = Record<string, string>;

function compact(header: string): string {
  return normaliseHeader(header).replace(/[^a-z0-9]/g, "");
}

export interface MappingResolution {
  /** Standard field -> index of the column in the file. */
  indexes: Map<string, number>;
  /** Standard field -> column name, as it will be saved on the job. */
  columnMap: ColumnMap;
  /** Required fields that no column could be found for. */
  missing: string[];
  /** Entries of a given mapping that name an unknown field or a column the file does not have. */
  invalid: string[];
}

/**
 * Works out which column of the file feeds each standard field.
 * With `given` (an explicit mapping, which Part 4 will supply) only that mapping is used.
 * Without it, the header names are matched against the known aliases. This is a fixed,
 * rule-based stand-in until Part 4 adds saved, approved mappings.
 */
export function resolveColumnMap(
  fileType: FileType,
  headers: readonly string[],
  given?: ColumnMap,
): MappingResolution {
  const specs = FIELD_SPECS[fileType];
  const indexes = new Map<string, number>();
  const columnMap: ColumnMap = {};
  const invalid: string[] = [];

  if (given) {
    const known = new Set(specs.map((spec) => spec.name));
    const headerIndex = new Map<string, number>();
    headers.forEach((header, index) => {
      const key = compact(header);
      if (key !== "" && !headerIndex.has(key)) headerIndex.set(key, index);
    });
    for (const [field, column] of Object.entries(given)) {
      const index = headerIndex.get(compact(column));
      if (!known.has(field)) invalid.push(`"${field}" is not a standard field`);
      else if (index === undefined) invalid.push(`column "${column}" is not in the file`);
      else {
        indexes.set(field, index);
        columnMap[field] = headers[index] ?? column;
      }
    }
  } else {
    const used = new Set<number>();
    for (const spec of specs) {
      const wanted = new Set([compact(spec.name), ...spec.aliases.map(compact)]);
      const index = headers.findIndex((header, i) => !used.has(i) && wanted.has(compact(header)));
      if (index >= 0) {
        used.add(index);
        indexes.set(spec.name, index);
        columnMap[spec.name] = headers[index] ?? "";
      }
    }
  }

  const missing = specs
    .filter((spec) => spec.required && !indexes.has(spec.name))
    .map((spec) => spec.name);
  const oneOf = ONE_OF_REQUIRED[fileType];
  if (oneOf && !oneOf.some((field) => indexes.has(field))) missing.push(oneOf.join(" or "));
  return { indexes, columnMap, missing, invalid };
}
