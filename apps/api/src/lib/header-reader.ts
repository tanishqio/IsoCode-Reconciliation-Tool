import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import type { UploadFormat } from "./file-signature.js";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx") as typeof import("xlsx");

const CSV_READ_BYTES = 64 * 1024;
const CSV_DELIMITERS = [",", ";", "\t", "|"] as const;
const XLS_MAX_ROWS = 65_536;

export type HeaderReadErrorCode = "EMPTY_FILE" | "NO_HEADER" | "UNREADABLE";

export class HeaderReadError extends Error {
  readonly code: HeaderReadErrorCode;

  constructor(code: HeaderReadErrorCode, message: string) {
    super(message);
    this.name = "HeaderReadError";
    this.code = code;
  }
}

export interface HeaderReadResult {
  headers: string[];
  dataRowCount: number | null;
  warning: string | null;
}

function decodeCsv(buffer: Buffer, atEndOfFile: boolean): { text: string; isUtf16: boolean } {
  const stream = !atEndOfFile;
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return {
      text: new TextDecoder("utf-8").decode(buffer.subarray(3), { stream }),
      isUtf16: false,
    };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return {
      text: new TextDecoder("utf-16le").decode(buffer.subarray(2), { stream }),
      isUtf16: true,
    };
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return {
      text: new TextDecoder("utf-16be").decode(buffer.subarray(2), { stream }),
      isUtf16: true,
    };
  }
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(buffer, { stream }),
      isUtf16: false,
    };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(buffer), isUtf16: false };
  }
}

function extractFirstRecord(text: string, atEndOfFile: boolean): string | null {
  let index = 0;
  while (index < text.length && (text.charAt(index) === "\r" || text.charAt(index) === "\n")) {
    index += 1;
  }
  const start = index;
  let inQuotes = false;
  for (; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (char === "\n" || char === "\r")) return text.slice(start, index);
  }
  return atEndOfFile ? text.slice(start) : null;
}

function detectDelimiter(record: string): string {
  const counts = new Map<string, number>(CSV_DELIMITERS.map((delimiter) => [delimiter, 0]));
  let inQuotes = false;
  for (const char of record) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && counts.has(char)) counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let best: string = ",";
  let bestCount = 0;
  for (const delimiter of CSV_DELIMITERS) {
    const count = counts.get(delimiter) ?? 0;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

function splitRecord(record: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < record.length; index += 1) {
    const char = record.charAt(index);
    if (inQuotes) {
      if (char === '"') {
        if (record.charAt(index + 1) === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((field) => field.trim());
}

async function countCsvDataRows(filePath: string): Promise<number> {
  let nonEmptyLines = 0;
  let lineHasContent = false;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = chunk as Buffer;
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index];
      if (byte === 0x0a) {
        if (lineHasContent) nonEmptyLines += 1;
        lineHasContent = false;
      } else if (byte !== 0x0d) {
        lineHasContent = true;
      }
    }
  }
  if (lineHasContent) nonEmptyLines += 1;
  return Math.max(0, nonEmptyLines - 1);
}

async function readCsvHeaders(filePath: string): Promise<HeaderReadResult> {
  const handle = await open(filePath, "r");
  let buffer: Buffer;
  let atEndOfFile: boolean;
  try {
    const chunk = Buffer.alloc(CSV_READ_BYTES);
    const { bytesRead } = await handle.read(chunk, 0, CSV_READ_BYTES, 0);
    buffer = chunk.subarray(0, bytesRead);
    atEndOfFile = bytesRead < CSV_READ_BYTES;
  } finally {
    await handle.close();
  }

  if (buffer.length === 0) throw new HeaderReadError("EMPTY_FILE", "The file is empty.");

  const { text, isUtf16 } = decodeCsv(buffer, atEndOfFile);
  const record = extractFirstRecord(text, atEndOfFile);
  if (record === null || record.trim() === "") {
    throw new HeaderReadError("NO_HEADER", "No header row was found at the start of the file.");
  }

  const headers = splitRecord(record, detectDelimiter(record));
  if (headers.every((header) => header === "")) {
    throw new HeaderReadError("NO_HEADER", "The header row has no column names.");
  }

  return {
    headers,
    dataRowCount: isUtf16 ? null : await countCsvDataRows(filePath),
    warning: null,
  };
}

async function readExcelHeaders(
  filePath: string,
  format: "XLS" | "XLSX",
): Promise<HeaderReadResult> {
  const size = (await stat(filePath)).size;
  if (size === 0) throw new HeaderReadError("EMPTY_FILE", "The file is empty.");

  let workbook: import("xlsx").WorkBook;
  try {
    workbook = XLSX.read(await readFile(filePath), {
      type: "buffer",
      sheetRows: 1,
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      cellNF: false,
      bookVBA: false,
    });
  } catch {
    throw new HeaderReadError("UNREADABLE", "The spreadsheet could not be read.");
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) throw new HeaderReadError("NO_HEADER", "The workbook has no sheets.");

  const firstRow = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  })[0];
  const headers = (firstRow ?? []).map((cell) => String(cell).trim());
  if (headers.length === 0 || headers.every((header) => header === "")) {
    throw new HeaderReadError("NO_HEADER", "The first row of the first sheet has no column names.");
  }

  const fullRange = (sheet as { "!fullref"?: string })["!fullref"] ?? sheet["!ref"];
  let totalRows: number | null = null;
  if (fullRange) {
    const range = XLSX.utils.decode_range(fullRange);
    totalRows = range.e.r - range.s.r + 1;
  }

  const warnings: string[] = [];
  if (format === "XLS" && totalRows !== null && totalRows >= XLS_MAX_ROWS) {
    warnings.push(
      "The sheet is at the 65,536-row limit of the old .xls format, so rows may be missing. Save it as .xlsx and upload again.",
    );
  }
  if (workbook.SheetNames.length > 1) {
    warnings.push(
      `The workbook has ${workbook.SheetNames.length} sheets. Only the first sheet is used.`,
    );
  }

  return {
    headers,
    dataRowCount: totalRows === null ? null : Math.max(0, totalRows - 1),
    warning: warnings.length > 0 ? warnings.join(" ") : null,
  };
}

export async function readHeaders(
  filePath: string,
  format: UploadFormat,
): Promise<HeaderReadResult> {
  if (format === "CSV") return readCsvHeaders(filePath);
  return readExcelHeaders(filePath, format);
}
