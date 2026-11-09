import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const XLSX = createRequire(import.meta.url)("xlsx") as typeof import("xlsx");

export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function countFiles(dir: string): number {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) =>
      entry.isFile(),
    ).length;
  } catch {
    return 0;
  }
}

export async function waitForNoFiles(dir: string, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = countFiles(dir);
  while (count > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    count = countFiles(dir);
  }
  return count;
}

/** A small CSV whose content is unique on every call, so its SHA-256 never collides with another test's file. */
export function uniqueCsv(headers: string[] = ["order_id", "amount"], dataRows = 2): Buffer {
  const lines = [headers.join(",")];
  for (let row = 0; row < dataRows; row += 1) {
    lines.push([`ORD-${randomUUID()}`, ...headers.slice(1).map(() => "100")].join(","));
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

export function workbookBuffer(
  rows: unknown[][],
  bookType: "xlsx" | "biff8",
  extraSheets = 0,
): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  for (let index = 0; index < extraSheets; index += 1) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["extra"]]), `Extra${index}`);
  }
  return XLSX.write(workbook, { type: "buffer", bookType }) as Buffer;
}

export function uniqueWorkbook(bookType: "xlsx" | "biff8"): Buffer {
  return workbookBuffer(
    [
      ["Order ID", "Amount"],
      [`ORD-${randomUUID()}`, 100],
    ],
    bookType,
  );
}

export interface FormFile {
  name: string;
  data: Buffer;
}

export function buildForm(
  items: unknown,
  files: FormFile[],
  options: { itemsAfterFiles?: boolean; fileField?: string } = {},
): FormData {
  const form = new FormData();
  const appendItems = () => {
    if (items !== undefined) {
      form.append("items", typeof items === "string" ? items : JSON.stringify(items));
    }
  };
  if (!options.itemsAfterFiles) appendItems();
  for (const file of files) {
    form.append(
      options.fileField ?? "files",
      new Blob([new Uint8Array(file.data)]),
      file.name,
    );
  }
  if (options.itemsAfterFiles) appendItems();
  return form;
}
