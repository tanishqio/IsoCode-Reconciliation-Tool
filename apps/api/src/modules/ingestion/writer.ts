import type { Prisma } from "../../../generated/prisma/client.js";
import type { FileType } from "../../../generated/prisma/enums.js";
import type { RejectedItem, StagedRecord } from "./transform.js";

type Tx = Prisma.TransactionClient;

interface ColumnDef {
  name: string;
  /** PostgreSQL type used to read the value from the JSON batch. */
  pg: string;
}

interface TableDef {
  table: string;
  columns: ColumnDef[];
}

const shared: ColumnDef[] = [
  { name: "sourceFileId", pg: "uuid" },
  { name: "sourceRowNumber", pg: "int" },
  { name: "rowHash", pg: "text" },
];

// Table and column names below are fixed constants, never user input. Values always travel
// as one bound JSON parameter.
export const TABLE_DEFS: Record<FileType, TableDef> = {
  ORDERS: {
    table: "customer_orders",
    columns: [
      ...shared,
      { name: "orderId", pg: "text" },
      { name: "channelSourceId", pg: "uuid" },
      { name: "orderDate", pg: "timestamp(3)" },
      { name: "value", pg: "numeric(14,2)" },
      { name: "paymentType", pg: '"PaymentType"' },
      { name: "deliveryStatus", pg: "text" },
      { name: "awb", pg: "text" },
      { name: "courierSourceId", pg: "uuid" },
      { name: "weightGrams", pg: "int" },
      { name: "deliveredAt", pg: "timestamp(3)" },
      { name: "returnedAt", pg: "timestamp(3)" },
    ],
  },
  SETTLEMENT: {
    table: "settlement_lines",
    columns: [
      ...shared,
      { name: "orderIdRaw", pg: "text" },
      { name: "sourceId", pg: "uuid" },
      { name: "lineRef", pg: "text" },
      { name: "settledOn", pg: "timestamp(3)" },
      { name: "lineType", pg: "text" },
      { name: "netReceived", pg: "numeric(14,2)" },
      { name: "tcs", pg: "numeric(14,2)" },
      { name: "tds", pg: "numeric(14,2)" },
      { name: "otherDeductions", pg: "numeric(14,2)" },
    ],
  },
  COD_REMITTANCE: {
    table: "cod_remittance_lines",
    columns: [
      ...shared,
      { name: "orderIdRaw", pg: "text" },
      { name: "aggregatorSourceId", pg: "uuid" },
      { name: "awb", pg: "text" },
      { name: "remittanceRef", pg: "text" },
      { name: "remittedOn", pg: "timestamp(3)" },
      { name: "remittedAmount", pg: "numeric(14,2)" },
    ],
  },
  FREIGHT_INVOICE: {
    table: "freight_lines",
    columns: [
      ...shared,
      { name: "orderIdRaw", pg: "text" },
      { name: "aggregatorSourceId", pg: "uuid" },
      { name: "invoiceNo", pg: "text" },
      { name: "awb", pg: "text" },
      { name: "chargeType", pg: '"ChargeType"' },
      { name: "billedWeightGrams", pg: "int" },
      { name: "billedAmount", pg: "numeric(14,2)" },
      { name: "chargedOn", pg: "timestamp(3)" },
    ],
  },
  RETURN_SCAN: {
    table: "return_scans",
    columns: [
      ...shared,
      { name: "orderIdRaw", pg: "text" },
      { name: "warehouseSourceId", pg: "uuid" },
      { name: "awb", pg: "text" },
      { name: "scannedAt", pg: "timestamp(3)" },
    ],
  },
};

export const BATCH_SIZE = 5000;

function insertSql(def: TableDef): string {
  const names = def.columns.map((column) => `"${column.name}"`).join(", ");
  const selected = def.columns.map((column) => `t."${column.name}"`).join(", ");
  const typed = def.columns.map((column) => `"${column.name}" ${column.pg}`).join(", ");
  return (
    `INSERT INTO "${def.table}" ("id", ${names}) ` +
    `SELECT gen_random_uuid(), ${selected} FROM jsonb_to_recordset($1::jsonb) AS t(${typed}) ` +
    `ON CONFLICT DO NOTHING`
  );
}

/** Removes everything an earlier run of this file saved, so a re-run starts clean. */
export async function clearFileRows(tx: Tx, fileType: FileType, fileId: string): Promise<void> {
  const def = TABLE_DEFS[fileType];
  await tx.$executeRawUnsafe(`DELETE FROM "${def.table}" WHERE "sourceFileId" = $1::uuid`, fileId);
  await tx.$executeRawUnsafe(`DELETE FROM "rejected_rows" WHERE "fileId" = $1::uuid`, fileId);
}

/**
 * Inserts one batch. Rows that collide with a row already saved (same hash, same natural key)
 * are skipped by the database. Returns how many rows were really inserted.
 */
export async function insertRecords(
  tx: Tx,
  fileType: FileType,
  batch: readonly StagedRecord[],
): Promise<number> {
  if (batch.length === 0) return 0;
  return tx.$executeRawUnsafe(insertSql(TABLE_DEFS[fileType]), JSON.stringify(batch));
}

export async function insertRejected(
  tx: Tx,
  fileId: string,
  batch: readonly RejectedItem[],
): Promise<void> {
  if (batch.length === 0) return;
  await tx.$executeRawUnsafe(
    `INSERT INTO "rejected_rows" ("id", "fileId", "rowNumber", "reasonCode", "message", "rawSnippet") ` +
      `SELECT gen_random_uuid(), $2::uuid, t."rowNumber", t."reasonCode", t."message", t."rawSnippet" ` +
      `FROM jsonb_to_recordset($1::jsonb) AS t("rowNumber" int, "reasonCode" text, "message" text, "rawSnippet" text)`,
    JSON.stringify(batch),
    fileId,
  );
}
