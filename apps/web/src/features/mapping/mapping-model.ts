import type { ColumnMap, Confidence, FieldInfo, MappingField, MappingVersion } from "./mapping-api";

export const ORIGIN_LABELS: Record<MappingVersion["origin"], string> = {
  AI: "AI suggestion",
  FALLBACK: "Rule-based",
  MANUAL: "Edited by a person",
};

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  high: "Sure",
  medium: "Fairly sure",
  low: "Not sure",
};

/** Sets or clears the column for one field. An empty column removes the field from the map. */
export function setField(map: ColumnMap, field: string, column: string): ColumnMap {
  const next = { ...map };
  if (column === "") delete next[field];
  else next[field] = column;
  return next;
}

/** Required fields that no column feeds yet. */
export function missingRequired(fields: readonly MappingField[], map: ColumnMap): string[] {
  return fields.filter((field) => field.required && !map[field.name]).map((field) => field.label);
}

/** A column can feed only one field, so a column used by another field is flagged. */
export function duplicateColumns(map: ColumnMap): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const column of Object.values(map)) {
    if (seen.has(column)) repeated.add(column);
    seen.add(column);
  }
  return [...repeated];
}

/** How to describe where a field's column came from, for the review screen. */
export function describeSource(info: FieldInfo | undefined, changedByPerson: boolean): string {
  if (changedByPerson) return "Chosen by you";
  if (!info) return "";
  const who = info.source === "ai" ? "AI" : "Rule";
  return `${who}: ${CONFIDENCE_LABELS[info.confidence].toLowerCase()}`;
}

/** A suggestion a person should look at twice: the AI or rule was not sure. */
export function needsCheck(info: FieldInfo | undefined): boolean {
  return info !== undefined && info.confidence !== "high";
}

export function canApprove(
  fields: readonly MappingField[],
  map: ColumnMap,
  problems: readonly string[],
): boolean {
  return (
    missingRequired(fields, map).length === 0 &&
    duplicateColumns(map).length === 0 &&
    problems.length === 0
  );
}
