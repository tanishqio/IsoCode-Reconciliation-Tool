import { api } from "../../lib/api-client";

// These mirror the API's responses (apps/api/src/modules/uploads and sources).

export type FileType =
  "ORDERS" | "SETTLEMENT" | "COD_REMITTANCE" | "FREIGHT_INVOICE" | "RETURN_SCAN";

export type FileStatus =
  "NEEDS_MAPPING" | "QUEUED" | "PROCESSING" | "COMPLETED" | "COMPLETED_WITH_REJECTS" | "FAILED";

export interface Source {
  id: string;
  name: string;
  kind: string;
  fileTypes: FileType[];
}

export interface UploadedFile {
  id: string;
  batchId: string;
  sourceId: string;
  sourceName: string;
  fileType: FileType;
  originalName: string;
  format: "CSV" | "XLS" | "XLSX";
  sizeBytes: number;
  status: FileStatus;
  warning: string | null;
  detectedRowCount: number | null;
  uploadedAt: string;
  processedAt: string | null;
  rowsAccepted: number | null;
  rowsRejected: number | null;
  rowsDuplicate: number | null;
  job: UploadJob | null;
}

export interface UploadJob {
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  stage: string | null;
  progressPct: number;
  errorMessage: string | null;
}

export interface RejectedRow {
  id: string;
  rowNumber: number;
  reasonCode: string;
  message: string;
  rawSnippet: string | null;
}

export interface RejectedRowsPage {
  items: RejectedRow[];
  nextAfter: number | null;
  total: number;
  reasons: { reasonCode: string; count: number }[];
}

export type FileResult =
  | { index: number; fileName: string; status: "ACCEPTED"; file: UploadedFile }
  | {
      index: number;
      fileName: string;
      status: "DUPLICATE";
      existing: { id: string; originalName: string; uploadedAt: string };
    }
  | { index: number; fileName: string; status: "REJECTED"; reason: string; message: string };

export interface UploadOutcome {
  batchId: string;
  summary: { fileCount: number; accepted: number; duplicate: number; rejected: number };
  results: FileResult[];
}

export interface UploadPage {
  items: UploadedFile[];
  nextCursor: string | null;
}

export const SOURCES_KEY = ["sources"] as const;
export const UPLOADS_KEY = ["uploads"] as const;
export const UPLOADS_PAGE_SIZE = 25;

export async function listSources(signal?: AbortSignal): Promise<Source[]> {
  const response = await api.get<{ items: Source[] }>("/sources", { signal });
  return response.items;
}

export function listUploads(cursor: string | undefined, signal?: AbortSignal): Promise<UploadPage> {
  return api.get<UploadPage>("/uploads", { query: { limit: UPLOADS_PAGE_SIZE, cursor }, signal });
}

export interface UploadEntry {
  file: File;
  sourceId: string;
  fileType: FileType;
}

/**
 * Sends the files in one request. The API answers 201 (something was saved), 409 (everything was
 * a duplicate) or 422 (everything was rejected) with a per-file report, so all three are results,
 * not errors. A real error (for example the session ended) still throws.
 */
export function uploadFiles(entries: readonly UploadEntry[]): Promise<UploadOutcome> {
  const form = new FormData();
  form.append(
    "items",
    JSON.stringify(entries.map(({ sourceId, fileType }) => ({ sourceId, fileType }))),
  );
  for (const entry of entries) form.append("files", entry.file, entry.file.name);
  return api.post<UploadOutcome>("/uploads", form, { treatAsSuccess: [409, 422] });
}

/** Queues a file so the background worker reads its rows. Answers 202 straight away. */
export function processFile(fileId: string): Promise<{ jobId: string }> {
  return api.post<{ jobId: string }>(`/uploads/${fileId}/process`);
}

export function listRejectedRows(
  fileId: string,
  after: number | undefined,
  signal?: AbortSignal,
): Promise<RejectedRowsPage> {
  return api.get<RejectedRowsPage>(`/uploads/${fileId}/rejected-rows`, {
    query: { after, limit: 50 },
    signal,
  });
}
