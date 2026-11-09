import type { FileResult, FileStatus, FileType, Source, UploadedFile } from "./uploads-api";

export const MAX_FILES = 5;
export const ACCEPTED_EXTENSIONS = [".csv", ".xls", ".xlsx"] as const;

export const FILE_TYPE_LABELS: Record<FileType, string> = {
  ORDERS: "Orders",
  SETTLEMENT: "Settlement",
  COD_REMITTANCE: "COD remittance",
  FREIGHT_INVOICE: "Freight invoice",
  RETURN_SCAN: "Warehouse return scan",
};

export const STATUS_LABELS: Record<FileStatus, string> = {
  NEEDS_MAPPING: "Needs mapping",
  QUEUED: "Queued",
  PROCESSING: "Processing",
  COMPLETED: "Completed",
  COMPLETED_WITH_REJECTS: "Completed with rejected rows",
  FAILED: "Failed",
};

/** A file the person has chosen but not yet uploaded, with the source and type they picked for it. */
export interface DraftRow {
  key: string;
  file: File;
  sourceId: string;
  fileType: FileType | "";
}

let nextKey = 0;

export function hasAcceptedExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export interface AddFilesResult {
  rows: DraftRow[];
  /** Names of files left out because of their extension. */
  wrongType: string[];
  /** How many files were left out because five are already chosen. */
  overflow: number;
}

/** Adds chosen files to the list, up to five in total, leaving out files the API would refuse. */
export function addFiles(rows: readonly DraftRow[], chosen: readonly File[]): AddFilesResult {
  const next = [...rows];
  const wrongType: string[] = [];
  let overflow = 0;
  for (const file of chosen) {
    if (!hasAcceptedExtension(file.name)) {
      wrongType.push(file.name);
    } else if (next.length >= MAX_FILES) {
      overflow += 1;
    } else {
      next.push({ key: String(++nextKey), file, sourceId: "", fileType: "" });
    }
  }
  return { rows: next, wrongType, overflow };
}

export function allowedFileTypes(sources: readonly Source[], sourceId: string): FileType[] {
  return sources.find((source) => source.id === sourceId)?.fileTypes ?? [];
}

/**
 * Sets a row's source. The file type is cleared if the new source cannot send it, and chosen
 * for the person if the source can only send one kind of file.
 */
export function setRowSource(
  row: DraftRow,
  sources: readonly Source[],
  sourceId: string,
): DraftRow {
  const allowed = allowedFileTypes(sources, sourceId);
  let fileType: DraftRow["fileType"] = row.fileType;
  if (fileType !== "" && !allowed.includes(fileType)) fileType = "";
  if (fileType === "" && allowed.length === 1) fileType = allowed[0] ?? "";
  return { ...row, sourceId, fileType };
}

export function isRowReady(row: DraftRow, sources: readonly Source[]): boolean {
  return row.fileType !== "" && allowedFileTypes(sources, row.sourceId).includes(row.fileType);
}

export function canUpload(rows: readonly DraftRow[], sources: readonly Source[]): boolean {
  return (
    rows.length >= 1 && rows.length <= MAX_FILES && rows.every((row) => isRowReady(row, sources))
  );
}

/** Keeps the rows whose file was rejected, so the person can fix the choice and try again. */
export function rowsAfterUpload(
  rows: readonly DraftRow[],
  results: readonly FileResult[],
): DraftRow[] {
  const rejected = new Set(results.filter((r) => r.status === "REJECTED").map((r) => r.index));
  return rows.filter((_, index) => rejected.has(index));
}

/** Files the worker is reading or about to read: the list keeps refreshing while any exist. */
export function isInProgress(file: Pick<UploadedFile, "status">): boolean {
  return file.status === "QUEUED" || file.status === "PROCESSING";
}

/** Only a file whose last run failed can be run again; the rest are released by approving a mapping. */
export function canProcess(file: Pick<UploadedFile, "status">): boolean {
  return file.status === "FAILED";
}

/** A file whose column names are new waits for a person to review a mapping. */
export function needsMapping(file: Pick<UploadedFile, "status">): boolean {
  return file.status === "NEEDS_MAPPING";
}

const STAGE_LABELS: Record<string, string> = {
  reading: "Reading the file",
  validating: "Checking rows",
  saving: "Saving rows",
  finishing: "Finishing",
};

/** One short line about a file that is queued or running, for example "Saving rows, 70%". */
export function progressLabel(file: Pick<UploadedFile, "status" | "job">): string {
  if (file.status === "QUEUED" || !file.job?.stage) return "Waiting for the worker";
  return `${STAGE_LABELS[file.job.stage] ?? file.job.stage}, ${file.job.progressPct}%`;
}

/** Plain-language names for the reason codes the API gives to rejected rows. */
export const REJECT_REASON_LABELS: Record<string, string> = {
  MISSING_VALUE: "Required value is empty",
  MISSING_KEY: "No AWB or order ID",
  BAD_DATE: "Date not recognised",
  BAD_AMOUNT: "Amount not valid",
  BAD_NUMBER: "Number not valid",
  BAD_PAYMENT_TYPE: "Payment type not COD or prepaid",
  BAD_ID: "ID not valid",
  ID_SCIENTIFIC_NOTATION: "ID shortened by Excel",
  ID_PRECISION_LOST: "ID too long for Excel",
  TEXT_TOO_LONG: "Text too long",
  CONFLICTING_DUPLICATE: "Same key, different values",
};

export function reasonLabel(code: string): string {
  return REJECT_REASON_LABELS[code] ?? code;
}

const countFormat = new Intl.NumberFormat("en-IN");

export function formatCount(value: number | null): string {
  return value === null ? "\u2014" : countFormat.format(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const dateFormat = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" });

export function formatDateTime(iso: string): string {
  return dateFormat.format(new Date(iso));
}
