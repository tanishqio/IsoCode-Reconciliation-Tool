import type { FileType } from "../../../generated/prisma/enums.js";
import { FIELD_SPECS, resolveColumnMap, type ColumnMap } from "../ingestion/fields.js";
import {
  AiUnavailableError,
  requestAiMapping,
  type AiConfig,
  type AiMappingInput,
} from "./ai-client.js";
import { compactHeader, isPersonalHeader, looksPersonalValue } from "./personal.js";

export type Confidence = "high" | "medium" | "low";

export interface FieldInfo {
  source: "ai" | "rule";
  confidence: Confidence;
}

export interface Suggestion {
  columnMap: ColumnMap;
  fieldInfo: Record<string, FieldInfo>;
  origin: "AI" | "FALLBACK";
  aiModel: string | null;
  /** Plain-language remarks for the person reviewing: what the AI could not do, and why. */
  notes: string[];
  /** Columns that look like personal data. They are never mapped, read or sent to the AI. */
  ignoredColumns: string[];
}

export interface SuggestInput {
  fileType: FileType;
  headers: readonly string[];
  /** The first rows of the file, cells as text. Used only for a few sample values. */
  sampleRows: readonly (readonly (string | number | boolean | null | undefined)[])[];
}

const SAMPLE_COUNT = 3;
const SAMPLE_LENGTH = 40;

function tokens(text: string): Set<string> {
  return new Set(
    text
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word !== ""),
  );
}

function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Rule-based suggestion: exact known header names first, then the closest word overlap. */
export function suggestByRules(
  fileType: FileType,
  headers: readonly string[],
  excluded: ReadonlySet<string> = new Set(),
): { columnMap: ColumnMap; fieldInfo: Record<string, FieldInfo> } {
  const usable = headers.filter((header) => header.trim() !== "" && !excluded.has(header));
  const exact = resolveColumnMap(fileType, usable);
  const columnMap: ColumnMap = { ...exact.columnMap };
  const fieldInfo: Record<string, FieldInfo> = {};
  for (const field of Object.keys(columnMap))
    fieldInfo[field] = { source: "rule", confidence: "high" };

  const used = new Set(Object.values(columnMap));
  for (const spec of FIELD_SPECS[fileType]) {
    if (columnMap[spec.name]) continue;
    const wanted = [spec.name, spec.label, ...spec.aliases].map(tokens);
    let best: { header: string; score: number } | null = null;
    for (const header of usable) {
      if (used.has(header)) continue;
      const score = Math.max(...wanted.map((words) => similarity(tokens(header), words)));
      if (score >= 0.5 && (!best || score > best.score)) best = { header, score };
    }
    if (best) {
      columnMap[spec.name] = best.header;
      fieldInfo[spec.name] = { source: "rule", confidence: "low" };
      used.add(best.header);
    }
  }
  return { columnMap, fieldInfo };
}

function buildAiInput(input: SuggestInput, safeHeaders: readonly string[]): AiMappingInput {
  const index = new Map(input.headers.map((header, i) => [header, i]));
  return {
    fileType: input.fileType,
    fields: FIELD_SPECS[input.fileType].map((spec) => ({
      name: spec.name,
      label: spec.label,
      required: spec.required,
      kind: spec.kind,
    })),
    columns: safeHeaders.map((header) => {
      const position = index.get(header) ?? -1;
      const samples: string[] = [];
      for (const row of input.sampleRows) {
        const cell = row[position];
        if (cell === null || cell === undefined || String(cell).trim() === "") continue;
        const text = String(cell).trim().slice(0, SAMPLE_LENGTH);
        if (!looksPersonalValue(text)) samples.push(text);
        if (samples.length >= SAMPLE_COUNT) break;
      }
      return { header, samples };
    }),
  };
}

export interface Suggester {
  suggest(input: SuggestInput): Promise<Suggestion>;
}

export function createSuggester(config: AiConfig, fetchImpl: typeof fetch = fetch): Suggester {
  return {
    async suggest(input) {
      const ignoredColumns = input.headers.filter(
        (header) => header.trim() !== "" && isPersonalHeader(header, input.fileType),
      );
      const ignored = new Set(ignoredColumns);
      const safeHeaders = input.headers.filter(
        (header) => header.trim() !== "" && !ignored.has(header),
      );
      const rules = suggestByRules(input.fileType, input.headers, ignored);
      const notes: string[] = [];
      if (ignoredColumns.length > 0) {
        notes.push(
          `Left out as personal data and not sent to any AI: ${ignoredColumns.join(", ")}.`,
        );
      }

      if (config.provider === "none") {
        notes.push("No AI service is set up, so these suggestions come from fixed rules.");
        return { ...rules, origin: "FALLBACK", aiModel: null, notes, ignoredColumns };
      }

      try {
        const answer = await requestAiMapping(config, buildAiInput(input, safeHeaders), fetchImpl);
        const known = new Set(FIELD_SPECS[input.fileType].map((spec) => spec.name));
        const allowed = new Map(safeHeaders.map((header) => [header, header]));
        const compactAllowed = new Map(
          safeHeaders.map((header) => [compactHeader(header), header]),
        );
        const columnMap: ColumnMap = {};
        const fieldInfo: Record<string, FieldInfo> = {};
        const usedColumns = new Set<string>();
        const refused: string[] = [];

        for (const entry of answer.entries) {
          if (!entry.column) continue; // the AI said it was not sure
          const column =
            allowed.get(entry.column) ?? compactAllowed.get(compactHeader(entry.column));
          if (!known.has(entry.field) || columnMap[entry.field] !== undefined) {
            refused.push(`${entry.field} (not a standard field)`);
          } else if (!column) {
            refused.push(`${entry.field} -> "${entry.column}" (no such column in the file)`);
          } else if (usedColumns.has(column)) {
            refused.push(`${entry.field} -> "${column}" (column already used)`);
          } else {
            columnMap[entry.field] = column;
            fieldInfo[entry.field] = { source: "ai", confidence: entry.confidence };
            usedColumns.add(column);
          }
        }
        if (refused.length > 0) {
          notes.push(`Ignored AI answers that cannot be right: ${refused.join("; ")}.`);
        }
        if (answer.notes) notes.push(`AI remark: ${answer.notes.slice(0, 300)}`);

        // Fill what the AI left empty from the rules, and say so on each field.
        for (const [field, column] of Object.entries(rules.columnMap)) {
          if (columnMap[field] === undefined && !usedColumns.has(column)) {
            columnMap[field] = column;
            fieldInfo[field] = rules.fieldInfo[field] ?? { source: "rule", confidence: "low" };
            usedColumns.add(column);
          }
        }

        if (!Object.values(fieldInfo).some((info) => info.source === "ai")) {
          notes.push("The AI did not give any usable answer, so these come from fixed rules.");
          return { ...rules, origin: "FALLBACK", aiModel: null, notes, ignoredColumns };
        }
        return { columnMap, fieldInfo, origin: "AI", aiModel: answer.model, notes, ignoredColumns };
      } catch (err) {
        if (!(err instanceof AiUnavailableError)) throw err;
        notes.push(`${err.message} These suggestions come from fixed rules.`);
        return { ...rules, origin: "FALLBACK", aiModel: null, notes, ignoredColumns };
      }
    },
  };
}
