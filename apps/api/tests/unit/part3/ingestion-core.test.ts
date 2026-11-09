import { describe, expect, it } from "vitest";
import { resolveColumnMap } from "../../../src/modules/ingestion/fields.js";
import {
  CellError,
  parseDate,
  parseId,
  parseMoney,
  parsePaymentType,
} from "../../../src/modules/ingestion/parsers.js";
import { parseCsv } from "../../../src/modules/ingestion/read-table.js";
import { transformTable } from "../../../src/modules/ingestion/transform.js";

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof CellError) return err.code;
    throw err;
  }
  return "NO_ERROR";
};

describe("money parsing (exact rupees, never floats)", () => {
  it("cleans common spreadsheet formats to two decimals", () => {
    expect(parseMoney("₹1,499.00")).toBe("1499.00");
    expect(parseMoney("Rs. 862.4")).toBe("862.40");
    expect(parseMoney("1,23,456")).toBe("123456.00");
    expect(parseMoney("(37.00)")).toBe("-37.00");
    expect(parseMoney("-1409")).toBe("-1409.00");
    expect(parseMoney(862.4)).toBe("862.40");
    expect(parseMoney("862.400")).toBe("862.40");
    expect(parseMoney("")).toBeNull();
  });

  it("rejects instead of rounding", () => {
    expect(codeOf(() => parseMoney("862.404"))).toBe("BAD_AMOUNT");
    expect(codeOf(() => parseMoney("abc"))).toBe("BAD_AMOUNT");
    expect(codeOf(() => parseMoney("1.5E3"))).toBe("BAD_AMOUNT");
    expect(codeOf(() => parseMoney(1.005))).toBe("BAD_AMOUNT");
  });
});

describe("date and ID parsing", () => {
  it("reads ISO, day-first and named dates as UTC wall-clock time", () => {
    expect(parseDate("2026-11-03")?.toISOString()).toBe("2026-11-03T00:00:00.000Z");
    expect(parseDate("03/11/2026")?.toISOString()).toBe("2026-11-03T00:00:00.000Z");
    expect(parseDate("3-Nov-2026 02:30 PM")?.toISOString()).toBe("2026-11-03T14:30:00.000Z");
    expect(parseDate(46329)?.toISOString()).toBe("2026-11-03T00:00:00.000Z"); // Excel serial
    expect(codeOf(() => parseDate("31/02/2026"))).toBe("BAD_DATE");
    expect(codeOf(() => parseDate("soon"))).toBe("BAD_DATE");
  });

  it("normalises IDs and refuses IDs that Excel damaged", () => {
    expect(parseId("  ord-w-204118 ")).toBe("ORD-W-204118");
    expect(parseId(204118)).toBe("204118");
    expect(parseId("204118.0")).toBe("204118");
    expect(codeOf(() => parseId("1.23457E+11"))).toBe("ID_SCIENTIFIC_NOTATION");
    expect(parsePaymentType("Cash on Delivery")).toBe("COD");
    expect(codeOf(() => parsePaymentType("barter"))).toBe("BAD_PAYMENT_TYPE");
  });
});

describe("CSV reading", () => {
  it("handles quotes, line breaks inside quotes and keeps true row numbers", () => {
    const records = parseCsv('id,note\n\n1,"a, ""b""\nc"\n2,plain\r\n', ",");
    // A line break inside quotes is part of one record, so the row after it is record 4.
    expect(records.map((r) => r.recordNumber)).toEqual([1, 3, 4]);
    expect(records[1]?.fields).toEqual(["1", 'a, "b"\nc']);
    expect(records[2]?.fields).toEqual(["2", "plain"]);
  });
});

describe("orders transform", () => {
  const headers = [
    "Order ID",
    "Order Date",
    "Order Value",
    "Payment Mode",
    "Status",
    "Customer Phone",
  ];
  const row = (rowNumber: number, ...cells: string[]) => ({ rowNumber, cells });
  const run = (rows: ReturnType<typeof row>[]) => {
    const mapping = resolveColumnMap("ORDERS", headers);
    expect(mapping.missing).toEqual([]);
    return transformTable({
      fileType: "ORDERS",
      sourceId: "source-1",
      sourceFileId: "file-1",
      table: { headers, rows },
      indexes: mapping.indexes,
      couriers: new Map(),
    });
  };

  it("never maps a personal-data column", () => {
    const mapping = resolveColumnMap("ORDERS", headers);
    expect([...mapping.indexes.values()]).not.toContain(headers.indexOf("Customer Phone"));
  });

  it("accepts good rows, rejects bad ones with a reason, and drops duplicates", () => {
    const good = ["ORD-1", "2026-11-03", "₹1,499.00", "COD", "Delivered", "9876543210"];
    const result = run([
      row(2, ...good),
      row(3, ...good), // identical: counted as a duplicate
      row(4, "ORD-2", "not a date", "100", "COD", "Delivered", "9876543210"),
      row(5, "ORD-3", "2026-11-03", "100", "barter", "Delivered", "9876543210"),
      row(6, "ORD-1", "2026-11-03", "1500", "COD", "Delivered", "9876543210"), // same ID, new value
    ]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      orderId: "ORD-1",
      value: "1499.00",
      sourceRowNumber: 2,
    });
    expect(result.duplicateRows).toBe(1);
    expect(result.rejected.map((r) => [r.rowNumber, r.reasonCode])).toEqual([
      [4, "BAD_DATE"],
      [5, "BAD_PAYMENT_TYPE"],
      [6, "CONFLICTING_DUPLICATE"],
    ]);
    // The phone number is never read, so it cannot appear in a saved snippet.
    expect(JSON.stringify(result)).not.toContain("9876543210");
  });
});
