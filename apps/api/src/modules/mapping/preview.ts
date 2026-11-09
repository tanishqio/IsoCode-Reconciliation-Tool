import type { FileType } from "../../../generated/prisma/enums.js";
import { FIELD_SPECS, ONE_OF_REQUIRED } from "../ingestion/fields.js";
import { CellError } from "../ingestion/parsers.js";
import type { RawTable } from "../ingestion/read-table.js";
import { parseField } from "../ingestion/transform.js";

export const PREVIEW_ROWS = 20;

export interface PreviewRow {
  rowNumber: number;
  /** Cleaned value for each mapped field, as text. null = empty. */
  values: Record<string, string | null>;
  /** Why this row would be rejected if the file were processed with this mapping. */
  error: { code: string; message: string } | null;
}

export interface Preview {
  /** The mapped fields, in the order of the standard field list. */
  fields: string[];
  rows: PreviewRow[];
  rowsWithProblems: number;
}

function display(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().replace("T", " ").slice(0, 16);
  return String(value);
}

/**
 * Applies a mapping to the first rows of a file and shows what the result would look like,
 * with the problem (if any) for each row. Nothing is saved.
 */
export function buildPreview(
  fileType: FileType,
  table: RawTable,
  indexes: ReadonlyMap<string, number>,
  limit: number = PREVIEW_ROWS,
): Preview {
  const specs = FIELD_SPECS[fileType].filter((spec) => indexes.has(spec.name));
  const oneOf = ONE_OF_REQUIRED[fileType];
  const rows: PreviewRow[] = [];

  for (const row of table.rows.slice(0, limit)) {
    const values: Record<string, string | null> = {};
    let error: PreviewRow["error"] = null;
    for (const spec of specs) {
      const index = indexes.get(spec.name) as number;
      try {
        const parsed = parseField(spec, row.cells[index]);
        values[spec.name] = display(parsed);
        if (parsed === null && spec.required && !error) {
          error = { code: "MISSING_VALUE", message: `${spec.label} is empty.` };
        }
      } catch (err) {
        if (!(err instanceof CellError)) throw err;
        values[spec.name] = null;
        error ??= { code: err.code, message: `${spec.label}: ${err.message}` };
      }
    }
    if (!error && oneOf && oneOf.every((field) => !values[field])) {
      error = { code: "MISSING_KEY", message: `Needs ${oneOf.join(" or ")}.` };
    }
    rows.push({ rowNumber: row.rowNumber, values, error });
  }

  return {
    fields: specs.map((spec) => spec.name),
    rows,
    rowsWithProblems: rows.filter((row) => row.error).length,
  };
}
