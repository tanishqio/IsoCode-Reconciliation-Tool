import { open, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { UploadFormat } from "../../lib/file-signature.js";
import { decodeCsv, detectDelimiter, extractFirstRecord } from "../../lib/header-reader.js";
import type { Cell } from "./parsers.js";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx") as typeof import("xlsx");

/** One non-empty data row. `rowNumber` is the spreadsheet row number (the header is usually 1). */
export interface RawRow {
  rowNumber: number;
  cells: Cell[];
}

export interface RawTable {
  headers: string[];
  rows: RawRow[];
}

export class TableReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableReadError";
  }
}

/**
 * Splits CSV text into records. Handles quoted fields, doubled quotes, line breaks inside quotes
 * and \r\n or \n line ends. Every record gets its 1-based position, blank lines included, so row
 * numbers match what a spreadsheet shows.
 */
export function parseCsv(
  text: string,
  delimiter: string,
): { recordNumber: number; fields: string[] }[] {
  const records: { recordNumber: number; fields: string[] }[] = [];
  const delimiterCode = delimiter.charCodeAt(0);
  const length = text.length;
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let recordNumber = 1;
  let touched = false; // the current record has any content or delimiter

  const endRecord = () => {
    if (touched) {
      fields.push(field);
      records.push({ recordNumber, fields });
    }
    fields = [];
    field = "";
    touched = false;
    recordNumber += 1;
  };

  for (let index = 0; index < length; index += 1) {
    const code = text.charCodeAt(index);
    if (inQuotes) {
      if (code === 34) {
        if (text.charCodeAt(index + 1) === 34) {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += text.charAt(index);
      }
    } else if (code === 34 && field === "") {
      inQuotes = true;
      touched = true;
    } else if (code === delimiterCode) {
      fields.push(field);
      field = "";
      touched = true;
    } else if (code === 10) {
      endRecord();
    } else if (code === 13) {
      if (text.charCodeAt(index + 1) === 10) index += 1;
      endRecord();
    } else {
      // Plain text: take the whole run up to the next delimiter or line end in one slice.
      let end = index + 1;
      while (end < length) {
        const next = text.charCodeAt(end);
        if (next === delimiterCode || next === 10 || next === 13) break;
        end += 1;
      }
      field += text.slice(index, end);
      index = end - 1;
      touched = true;
    }
  }
  endRecord();
  return records;
}

function isBlankRow(cells: readonly Cell[]): boolean {
  return cells.every((cell) => cell === null || cell === undefined || String(cell).trim() === "");
}

function fromRows(rows: { rowNumber: number; cells: Cell[] }[]): RawTable {
  const headerIndex = rows.findIndex((row) => !isBlankRow(row.cells));
  const headerRow = rows[headerIndex];
  if (!headerRow) throw new TableReadError("The file has no header row.");
  const headers = headerRow.cells.map((cell) => (cell === null ? "" : String(cell).trim()));
  const dataRows = rows.slice(headerIndex + 1).filter((row) => !isBlankRow(row.cells));
  return { headers, rows: dataRows };
}

const PREVIEW_CSV_BYTES = 1024 * 1024;

/** The first megabyte of a file, cut after the last complete line. Enough for a preview. */
async function readCsvHead(filePath: string): Promise<{ buffer: Buffer; complete: boolean }> {
  const handle = await open(filePath, "r");
  try {
    const chunk = Buffer.alloc(PREVIEW_CSV_BYTES);
    const { bytesRead } = await handle.read(chunk, 0, PREVIEW_CSV_BYTES, 0);
    if (bytesRead < PREVIEW_CSV_BYTES)
      return { buffer: chunk.subarray(0, bytesRead), complete: true };
    const lastBreak = chunk.lastIndexOf(10);
    return { buffer: chunk.subarray(0, lastBreak > 0 ? lastBreak : bytesRead), complete: false };
  } finally {
    await handle.close();
  }
}

async function readCsvTable(filePath: string, preview: boolean): Promise<RawTable> {
  const buffer = preview ? (await readCsvHead(filePath)).buffer : await readFile(filePath);
  if (buffer.length === 0) throw new TableReadError("The file is empty.");
  const { text } = decodeCsv(buffer, true);
  const firstRecord = extractFirstRecord(text, true);
  if (firstRecord === null || firstRecord.trim() === "") {
    throw new TableReadError("The file has no header row.");
  }
  const records = parseCsv(text, detectDelimiter(firstRecord));
  return fromRows(
    records.map((record) => ({
      rowNumber: record.recordNumber,
      cells: record.fields.map((value) => value.trim()),
    })),
  );
}

async function readExcelTable(filePath: string, previewRows: number | null): Promise<RawTable> {
  const buffer = await readFile(filePath);
  if (buffer.length === 0) throw new TableReadError("The file is empty.");

  let workbook: import("xlsx").WorkBook;
  try {
    workbook = XLSX.read(buffer, {
      type: "buffer",
      dense: true,
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      cellNF: false,
      cellDates: false,
      bookVBA: false,
      // A preview only needs the top of the sheet.
      ...(previewRows === null ? {} : { sheetRows: previewRows }),
    });
  } catch {
    throw new TableReadError("The spreadsheet could not be read.");
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet || !sheet["!ref"]) throw new TableReadError("The first sheet is empty.");

  const firstRow = XLSX.utils.decode_range(sheet["!ref"]).s.r;
  const matrix = XLSX.utils.sheet_to_json<Cell[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
  });
  return fromRows(matrix.map((cells, index) => ({ rowNumber: firstRow + index + 1, cells })));
}

/**
 * Reads a whole CSV or Excel file into rows of cells. Only the first sheet of a workbook is read.
 * Nothing is interpreted here: every column is kept, and the mapping decides which ones are used.
 */
export async function readTable(
  filePath: string,
  format: UploadFormat,
  options: { maxRows?: number } = {},
): Promise<RawTable> {
  const { maxRows } = options;
  const table =
    format === "CSV"
      ? await readCsvTable(filePath, maxRows !== undefined)
      : await readExcelTable(filePath, maxRows === undefined ? null : maxRows + 50);
  return maxRows === undefined
    ? table
    : { headers: table.headers, rows: table.rows.slice(0, maxRows) };
}
