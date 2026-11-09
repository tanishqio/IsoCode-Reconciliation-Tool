import { describe, expect, it } from "vitest";
import { checkFileSignature, formatFromFileName } from "../../../src/lib/file-signature.js";
import { uniqueWorkbook } from "../../helpers/part2-fixtures.js";

const ZIP = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00];
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

describe("formatFromFileName", () => {
  it.each([
    ["orders.csv", "CSV"],
    ["orders.CSV", "CSV"],
    ["report.xls", "XLS"],
    ["report.XLS", "XLS"],
    ["report.xlsx", "XLSX"],
    ["My Report (1).XlSx", "XLSX"],
  ])("%s is %s", (name, format) => {
    expect(formatFromFileName(name)).toBe(format);
  });

  it.each([
    "notes.txt",
    "noextension",
    "archive.csv.exe",
    "data.xlsm",
    "data.json",
    ".csv.bak",
    "",
  ])("%j is not accepted", (name) => {
    expect(formatFromFileName(name)).toBeNull();
  });
});

describe("checkFileSignature", () => {
  it("accepts a text CSV", () => {
    expect(checkFileSignature("a.csv", Buffer.from("order_id,amount"))).toEqual({
      ok: true,
      format: "CSV",
    });
  });

  it("accepts a CSV that starts with a UTF-8 byte order mark", () => {
    const head = Buffer.from([0xef, 0xbb, 0xbf, 0x6f, 0x72, 0x64]);
    expect(checkFileSignature("a.csv", head)).toEqual({ ok: true, format: "CSV" });
  });

  it("accepts a CSV saved as UTF-16 (it contains zero bytes but starts with a BOM)", () => {
    const head = Buffer.from([0xff, 0xfe, 0x6f, 0x00, 0x72, 0x00]);
    expect(checkFileSignature("a.csv", head)).toEqual({ ok: true, format: "CSV" });
  });

  it("rejects a CSV that contains zero bytes without a UTF-16 BOM", () => {
    expect(checkFileSignature("a.csv", Buffer.from([0x61, 0x00, 0x62, 0x00]))).toEqual({
      ok: false,
      reason: "SIGNATURE_MISMATCH",
    });
  });

  it("rejects an xlsx file renamed to .csv", () => {
    expect(checkFileSignature("a.csv", Buffer.from(ZIP))).toEqual({
      ok: false,
      reason: "SIGNATURE_MISMATCH",
    });
  });

  it("rejects an xls file renamed to .csv", () => {
    expect(checkFileSignature("a.csv", Buffer.from(OLE2))).toEqual({
      ok: false,
      reason: "SIGNATURE_MISMATCH",
    });
  });

  it("accepts a real xlsx and a real xls written by SheetJS", () => {
    const xlsx = uniqueWorkbook("xlsx").subarray(0, 8);
    const xls = uniqueWorkbook("biff8").subarray(0, 8);
    expect(checkFileSignature("a.xlsx", xlsx)).toEqual({ ok: true, format: "XLSX" });
    expect(checkFileSignature("a.xls", xls)).toEqual({ ok: true, format: "XLS" });
  });

  it("rejects text renamed to .xlsx or .xls", () => {
    const text = Buffer.from("order_id,amount\n1,2\n");
    expect(checkFileSignature("a.xlsx", text)).toMatchObject({
      ok: false,
      reason: "SIGNATURE_MISMATCH",
    });
    expect(checkFileSignature("a.xls", text)).toMatchObject({
      ok: false,
      reason: "SIGNATURE_MISMATCH",
    });
  });

  it("rejects an xlsx renamed to .xls and an xls renamed to .xlsx", () => {
    expect(checkFileSignature("a.xls", Buffer.from(ZIP))).toMatchObject({ ok: false });
    expect(checkFileSignature("a.xlsx", Buffer.from(OLE2))).toMatchObject({ ok: false });
  });

  it("rejects a file that only starts with the two letters PK", () => {
    expect(checkFileSignature("a.xlsx", Buffer.from("PK"))).toMatchObject({
      ok: false,
      reason: "SIGNATURE_MISMATCH",
    });
  });

  it("reports an empty file", () => {
    expect(checkFileSignature("a.csv", Buffer.alloc(0))).toEqual({
      ok: false,
      reason: "EMPTY_FILE",
    });
    expect(checkFileSignature("a.xlsx", Buffer.alloc(0))).toEqual({
      ok: false,
      reason: "EMPTY_FILE",
    });
  });

  it("checks the extension before the content", () => {
    expect(checkFileSignature("a.txt", Buffer.alloc(0))).toEqual({
      ok: false,
      reason: "UNSUPPORTED_EXTENSION",
    });
    expect(checkFileSignature("a.exe", Buffer.from("MZ"))).toEqual({
      ok: false,
      reason: "UNSUPPORTED_EXTENSION",
    });
  });
});
