import { api } from "../../lib/api-client";
import type { FileType, UploadPage } from "../uploads/uploads-api";

// These mirror the API's responses (apps/api/src/modules/mapping).

export type Confidence = "high" | "medium" | "low";

export interface MappingField {
  name: string;
  label: string;
  kind: string;
  required: boolean;
}

export interface FieldInfo {
  source: "ai" | "rule";
  confidence: Confidence;
}

export type ColumnMap = Record<string, string>;

export interface PreviewRow {
  rowNumber: number;
  values: Record<string, string | null>;
  error: { code: string; message: string } | null;
}

export interface Preview {
  fields: string[];
  rows: PreviewRow[];
  rowsWithProblems: number;
}

export interface MappingSummary {
  id: string;
  versionNo: number | null;
  columnMap: ColumnMap;
  approvedAt: string | null;
}

export interface MappingSuggestion {
  proposalId: string;
  file: {
    id: string;
    originalName: string;
    sourceId: string;
    sourceName: string;
    fileType: FileType;
  };
  headers: string[];
  fields: MappingField[];
  columnMap: ColumnMap;
  fieldInfo: Record<string, FieldInfo>;
  origin: "AI" | "FALLBACK";
  aiModel: string | null;
  notes: string[];
  ignoredColumns: string[];
  missing: string[];
  preview: Preview;
  activeVersion: MappingSummary | null;
}

export interface MappingVersion {
  id: string;
  versionNo: number;
  status: "ACTIVE" | "SUPERSEDED";
  origin: "AI" | "FALLBACK" | "MANUAL";
  aiModel: string | null;
  columnMap: ColumnMap;
  approvedBy: string | null;
  approvedAt: string | null;
  rolledBackFromVersionNo: number | null;
}

export const mappingKeys = {
  suggestion: (fileId: string) => ["mapping", "suggestion", fileId] as const,
  versions: (sourceId: string, fileType: FileType) =>
    ["mapping", "versions", sourceId, fileType] as const,
  waiting: (sourceId: string) => ["mapping", "waiting", sourceId] as const,
};

export function listWaitingFiles(sourceId: string, signal?: AbortSignal): Promise<UploadPage> {
  return api.get<UploadPage>("/uploads", {
    query: { sourceId, status: "NEEDS_MAPPING", limit: 50 },
    signal,
  });
}

export function suggestMapping(fileId: string): Promise<MappingSuggestion> {
  return api.post<MappingSuggestion>(`/uploads/${fileId}/mapping/suggest`);
}

export function previewMapping(
  fileId: string,
  columnMap: ColumnMap,
  signal?: AbortSignal,
): Promise<{ preview: Preview; missing: string[]; problems: string[] }> {
  return api.post(`/uploads/${fileId}/mapping/preview`, { columnMap }, { signal });
}

export function approveMapping(args: {
  fileId: string;
  proposalId: string;
  columnMap: ColumnMap;
}): Promise<{ id: string; versionNo: number; origin: string; queuedFiles: number }> {
  return api.post(`/uploads/${args.fileId}/mapping/approve`, {
    proposalId: args.proposalId,
    columnMap: args.columnMap,
  });
}

export function rejectProposal(proposalId: string): Promise<void> {
  return api.post<void>(`/mappings/${proposalId}/reject`);
}

export async function listMappingVersions(
  sourceId: string,
  fileType: FileType,
  signal?: AbortSignal,
): Promise<MappingVersion[]> {
  const response = await api.get<{ items: MappingVersion[] }>("/mappings", {
    query: { sourceId, fileType },
    signal,
  });
  return response.items;
}

export function rollbackMapping(
  versionId: string,
): Promise<{ id: string; versionNo: number; queuedFiles: number }> {
  return api.post(`/mappings/${versionId}/rollback`);
}
