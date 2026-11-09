import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HeaderReadError, readHeaders } from "../../../src/lib/header-reader.js";
import { makeTempDir, workbookBuffer } from "../../helpers/part2-fixtures.js";

let dir: string;
let counter = 0;

beforeAll(() => {
  dir = makeTempDir("header-reader");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(content: Buffer | string): string {
  counter += 1;
  const filePath = path.join(dir, `file-${counter}`);
  writeFileSync(filePath, content);
  return filePath;
}

async function expectReadError(filePath: string, format: "CSV" | "XLS" | "XLSX", code: string) {
  const err = await readHeaders(filePath, format).catch((error: unknown) => error);
  expect(err).toBeInstanceOf(HeaderReadError);
  expect((err as HeaderReadError).code).toBe(code);
}

describe("readHeaders: CSV", () => {
  it("reads a simple comma file and counts the data rows", async () => {
    const result = await readHeaders(write("order_id,amount\nA1,100\nA2,200\n"), "CSV");
    expect(result).toEqual({ headers: ["order_id", "amount"], dataRowCount: 2, warning: null });
  });

  it("counts a last row that has no line break", async () => {
    const result = await readHeaders(write("order_id,amount\nA1,100\nA2,200"), "CSV");
    expect(result.dataRowCount).toBe(2);
  });

  it("returns zero data rows for a header-only file", async () => {
    expect((await readHeaders(write("order_id,amount\n"), "CSV")).dataRowCount).toBe(0);
    expect((await readHeaders(write("order_id,amount"), "CSV")).dataRowCount).toBe(0);
  });

  it("ignores blank lines when counting rows", async () => {
    const result = await readHeaders(write("a,b\n1,2\n\n\n3,4\n\n"), "CSV");
    expect(result.dataRowCount).toBe(2);
  });

  it("handles Windows line endings", async () => {
    const result = await readHeaders(write("a,b\r\n1,2\r\n3,4\r\n"), "CSV");
    expect(result.headers).toEqual(["a", "b"]);
    expect(result.dataRowCount).toBe(2);
  });

  it("removes a UTF-8 byte order mark", async () => {
    const content = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("Order ID,Amount\n1,2\n"),
    ]);
    expect((await readHeaders(write(content), "CSV")).headers).toEqual(["Order ID", "Amount"]);
  });

  it("skips blank lines before the header", async () => {
    const result = await readHeaders(write("\n\r\n\norder_id,amount\n1,2\n"), "CSV");
    expect(result.headers).toEqual(["order_id", "amount"]);
  });

  it.each([
    ["semicolon", "a;b;c\n1;2;3\n"],
    ["tab", "a\tb\tc\n1\t2\t3\n"],
    ["pipe", "a|b|c\n1|2|3\n"],
    ["comma", "a,b,c\n1,2,3\n"],
  ])("detects the %s delimiter", async (_name, content) => {
    expect((await readHeaders(write(content), "CSV")).headers).toEqual(["a", "b", "c"]);
  });

  it("does not split on a delimiter inside quotes and unescapes doubled quotes", async () => {
    const result = await readHeaders(write('"Order, ID","He said ""hi""",Amount\n1,2,3\n'), "CSV");
    expect(result.headers).toEqual(["Order, ID", 'He said "hi"', "Amount"]);
  });

  it("trims spaces around header names", async () => {
    expect((await readHeaders(write(" a , b \n"), "CSV")).headers).toEqual(["a", "b"]);
  });

  it("reads a one-column file", async () => {
    expect((await readHeaders(write("order_id\nA1\n"), "CSV")).headers).toEqual(["order_id"]);
  });

  it("falls back to Windows-1252 when the bytes are not valid UTF-8", async () => {
    const result = await readHeaders(
      write(Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x2c, 0x61, 0x0a])),
      "CSV",
    );
    expect(result.headers).toEqual(["Café", "a"]);
  });

  it("reads UTF-16 with a byte order mark and does not guess a row count", async () => {
    const content = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("Order ID,Amount\n1,2\n", "utf16le"),
    ]);
    const result = await readHeaders(write(content), "CSV");
    expect(result.headers).toEqual(["Order ID", "Amount"]);
    expect(result.dataRowCount).toBeNull();
  });

  it.each([0, 1, 2])(
    "keeps multi-byte characters correct when the 64 KiB cut falls inside one (offset %i)",
    async (padding) => {
      const header = `Order ID,Amount ₹${"x".repeat(padding)}\n`;
      const body = "₹".repeat(40_000);
      const result = await readHeaders(write(header + body), "CSV");
      expect(result.headers).toEqual(["Order ID", `Amount ₹${"x".repeat(padding)}`]);
    },
  );

  it("counts the rows of a large file", async () => {
    const lines = ["order_id,amount"];
    for (let row = 0; row < 30_000; row += 1) lines.push(`ORD-${row},${row}`);
    const result = await readHeaders(write(`${lines.join("\n")}\n`), "CSV");
    expect(result.dataRowCount).toBe(30_000);
  });

  it("reports an empty file", async () => {
    await expectReadError(write(""), "CSV", "EMPTY_FILE");
  });

  it("reports a file with only blank lines or spaces", async () => {
    await expectReadError(write("\n\n\r\n"), "CSV", "NO_HEADER");
    await expectReadError(write("   \n"), "CSV", "NO_HEADER");
  });

  it("reports a header row with no names", async () => {
    await expectReadError(write(",,,\n1,2,3,4\n"), "CSV", "NO_HEADER");
  });

  it("reports a first line longer than the read window", async () => {
    await expectReadError(write("a".repeat(70_000)), "CSV", "NO_HEADER");
  });

  it("does not put file contents in error messages", async () => {
    const err = (await readHeaders(write("   \n"), "CSV").catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("   ");
  });
});

describe("readHeaders: Excel", () => {
  const rows = [
    ["Order ID", " Amount ", 2026],
    ["A1", 100, 1],
    ["A2", 200, 2],
  ];

  it.each([
    ["xlsx", "XLSX"],
    ["biff8", "XLS"],
  ] as const)("reads headers and row count from %s", async (bookType, format) => {
    const result = await readHeaders(write(workbookBuffer(rows, bookType)), format);
    expect(result.headers).toEqual(["Order ID", "Amount", "2026"]);
    expect(result.dataRowCount).toBe(2);
    expect(result.warning).toBeNull();
  });

  it("uses only the first sheet and warns when there are more", async () => {
    const result = await readHeaders(write(workbookBuffer(rows, "xlsx", 2)), "XLSX");
    expect(result.headers).toEqual(["Order ID", "Amount", "2026"]);
    expect(result.warning).toContain("3 sheets");
  });

  it("warns when an xls sheet is at the 65,536-row limit", async () => {
    const many: unknown[][] = [["Order ID", "Amount"]];
    for (let row = 1; row < 65_536; row += 1) many.push([`A${row}`, row]);
    const result = await readHeaders(write(workbookBuffer(many, "biff8")), "XLS");
    expect(result.warning).toContain("65,536");
    expect(result.dataRowCount).toBe(65_535);
  }, 120_000);

  it("does not warn when an xls sheet is below the limit", async () => {
    const many: unknown[][] = [["Order ID", "Amount"]];
    for (let row = 1; row < 1_000; row += 1) many.push([`A${row}`, row]);
    const result = await readHeaders(write(workbookBuffer(many, "biff8")), "XLS");
    expect(result.warning).toBeNull();
  });

  it("does not warn about the limit for xlsx files with more than 65,536 rows", async () => {
    const many: unknown[][] = [["Order ID", "Amount"]];
    for (let row = 1; row < 66_000; row += 1) many.push([`A${row}`, row]);
    const result = await readHeaders(write(workbookBuffer(many, "xlsx")), "XLSX");
    expect(result.warning).toBeNull();
    expect(result.dataRowCount).toBe(65_999);
  }, 120_000);

  it("reports a sheet whose first row is empty", async () => {
    await expectReadError(write(workbookBuffer([[], ["A1", 100]], "xlsx")), "XLSX", "NO_HEADER");
  });

  it("reports a header row with only empty cells", async () => {
    await expectReadError(
      write(
        workbookBuffer(
          [
            ["", " "],
            ["A1", 100],
          ],
          "xlsx",
        ),
      ),
      "XLSX",
      "NO_HEADER",
    );
  });

  it("reports a zero-byte file", async () => {
    await expectReadError(write(""), "XLSX", "EMPTY_FILE");
    await expectReadError(write(""), "XLS", "EMPTY_FILE");
  });

  it("reports a file that looks like a spreadsheet but cannot be read", async () => {
    const broken = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("this is not a real archive"),
    ]);
    const err = (await readHeaders(write(broken), "XLSX").catch(
      (e: unknown) => e,
    )) as HeaderReadError;
    expect(err).toBeInstanceOf(HeaderReadError);
    expect(["UNREADABLE", "NO_HEADER"]).toContain(err.code);
  });
});
