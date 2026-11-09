import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../../../generated/prisma/client.js";
import type { FileStatus, FileType } from "../../../generated/prisma/enums.js";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { checkFileSignature, type SignatureResult } from "../../lib/file-signature.js";
import { HeaderReadError, readHeaders } from "../../lib/header-reader.js";
import { buildHeaderSignature } from "../../lib/header-signature.js";
import { logger } from "../../lib/logger.js";
import {
  decodeCursor,
  encodeCursor,
  type ListUploadsQuery,
  type UploadItem,
} from "./uploads.schemas.js";
import {
  buildStoragePath,
  moveIntoStorage,
  removeFileQuietly,
  resolveInside,
} from "./uploads.storage.js";

export type RejectReason =
  | "UNSUPPORTED_EXTENSION"
  | "EMPTY_FILE"
  | "SIGNATURE_MISMATCH"
  | "UNKNOWN_SOURCE"
  | "FILE_TYPE_NOT_ALLOWED"
  | "NO_HEADER"
  | "UNREADABLE";

export interface UploadedFileDto {
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
}

export type FileResult =
  | { index: number; fileName: string; status: "ACCEPTED"; file: UploadedFileDto }
  | {
      index: number;
      fileName: string;
      status: "DUPLICATE";
      existing: { id: string; originalName: string; uploadedAt: string };
    }
  | { index: number; fileName: string; status: "REJECTED"; reason: RejectReason; message: string };

export interface UploadOutcome {
  batchId: string;
  summary: { fileCount: number; accepted: number; duplicate: number; rejected: number };
  results: FileResult[];
}

export interface UploadPage {
  items: UploadedFileDto[];
  nextCursor: string | null;
}

export interface AuditEntry {
  userId: string;
  action: "UPLOAD" | "DUPLICATE_BLOCKED";
  entityType: "UPLOADED_FILE";
  entityId: string;
  meta: Record<string, string | number>;
}

export type AuditWriter = (entry: AuditEntry) => Promise<void>;

export interface UploadsServiceDeps {
  prisma: PrismaClient;
  audit?: AuditWriter;
}

export interface ProcessUploadInput {
  userId: string;
  files: Express.Multer.File[];
  items: UploadItem[];
}

export type UploadsService = ReturnType<typeof createUploadsService>;

const fileInclude = { source: { select: { name: true } } } satisfies Prisma.UploadedFileInclude;
type UploadedFileRow = Prisma.UploadedFileGetPayload<{ include: typeof fileInclude }>;

const SIGNATURE_MESSAGES: Record<Exclude<SignatureResult, { ok: true }>["reason"], string> = {
  UNSUPPORTED_EXTENSION: "Only .csv, .xls and .xlsx files are accepted.",
  EMPTY_FILE: "The file is empty.",
  SIGNATURE_MISMATCH: "The file content does not match its extension.",
};

export function toUploadedFileDto(row: UploadedFileRow): UploadedFileDto {
  return {
    id: row.id,
    batchId: row.batchId,
    sourceId: row.sourceId,
    sourceName: row.source.name,
    fileType: row.fileType,
    originalName: row.originalName,
    format: row.format,
    sizeBytes: Number(row.sizeBytes),
    status: row.status,
    warning: row.warning,
    detectedRowCount: row.detectedRowCount,
    uploadedAt: row.uploadedAt.toISOString(),
    processedAt: row.processedAt ? row.processedAt.toISOString() : null,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export function createUploadsService({ prisma, audit }: UploadsServiceDeps) {
  const writeAudit: AuditWriter =
    audit ??
    (async (entry) => {
      logger.info({ audit: entry }, "audit event");
    });

  async function recordAudit(entry: AuditEntry): Promise<void> {
    try {
      await writeAudit(entry);
    } catch (err) {
      logger.error({ err, action: entry.action }, "audit write failed");
    }
  }

  async function duplicateResult(
    index: number,
    file: Express.Multer.File,
    item: UploadItem,
    userId: string,
    batchId: string,
  ): Promise<FileResult> {
    const existing = await prisma.uploadedFile.findUniqueOrThrow({
      where: {
        sourceId_fileType_sha256: {
          sourceId: item.sourceId,
          fileType: item.fileType,
          sha256: file.sha256,
        },
      },
      select: { id: true, originalName: true, uploadedAt: true },
    });
    await recordAudit({
      userId,
      action: "DUPLICATE_BLOCKED",
      entityType: "UPLOADED_FILE",
      entityId: existing.id,
      meta: { batchId, sourceId: item.sourceId, fileType: item.fileType },
    });
    return {
      index,
      fileName: file.originalname,
      status: "DUPLICATE",
      existing: {
        id: existing.id,
        originalName: existing.originalName,
        uploadedAt: existing.uploadedAt.toISOString(),
      },
    };
  }

  async function processOne(args: {
    index: number;
    file: Express.Multer.File;
    item: UploadItem;
    userId: string;
    batchId: string;
    sources: Map<string, { isActive: boolean; name: string; fileTypes: { fileType: FileType }[] }>;
  }): Promise<FileResult> {
    const { index, file, item, userId, batchId, sources } = args;
    const fileName = file.originalname;
    const rejected = (reason: RejectReason, message: string): FileResult => ({
      index,
      fileName,
      status: "REJECTED",
      reason,
      message,
    });

    const signature = checkFileSignature(fileName, file.headBytes);
    if (!signature.ok) return rejected(signature.reason, SIGNATURE_MESSAGES[signature.reason]);

    const source = sources.get(item.sourceId);
    if (!source || !source.isActive) {
      return rejected("UNKNOWN_SOURCE", "This source does not exist or is not active.");
    }
    if (!source.fileTypes.some((allowed) => allowed.fileType === item.fileType)) {
      return rejected("FILE_TYPE_NOT_ALLOWED", `${source.name} does not send this type of file.`);
    }

    const existing = await prisma.uploadedFile.findUnique({
      where: {
        sourceId_fileType_sha256: {
          sourceId: item.sourceId,
          fileType: item.fileType,
          sha256: file.sha256,
        },
      },
      select: { id: true },
    });
    if (existing) return duplicateResult(index, file, item, userId, batchId);

    let header;
    try {
      header = await readHeaders(file.tempPath, signature.format);
    } catch (err) {
      if (err instanceof HeaderReadError) return rejected(err.code, err.message);
      throw err;
    }

    const fileId = randomUUID();
    const storagePath = buildStoragePath(fileId, `.${signature.format.toLowerCase()}`);
    await moveIntoStorage(file.tempPath, env.UPLOAD_DIR, storagePath);

    let row: UploadedFileRow;
    try {
      row = await prisma.uploadedFile.create({
        data: {
          id: fileId,
          batchId,
          sourceId: item.sourceId,
          fileType: item.fileType,
          originalName: fileName,
          storagePath,
          sizeBytes: BigInt(file.sizeBytes),
          format: signature.format,
          sha256: file.sha256,
          headerSignature: buildHeaderSignature(header.headers),
          detectedRowCount: header.dataRowCount,
          warning: header.warning,
          status: "NEEDS_MAPPING",
          uploadedById: userId,
        },
        include: fileInclude,
      });
    } catch (err) {
      await removeFileQuietly(resolveInside(env.UPLOAD_DIR, storagePath));
      if (isUniqueViolation(err)) return duplicateResult(index, file, item, userId, batchId);
      throw err;
    }

    await recordAudit({
      userId,
      action: "UPLOAD",
      entityType: "UPLOADED_FILE",
      entityId: row.id,
      meta: {
        batchId,
        sourceId: item.sourceId,
        fileType: item.fileType,
        sizeBytes: file.sizeBytes,
      },
    });

    return { index, fileName, status: "ACCEPTED", file: toUploadedFileDto(row) };
  }

  async function processUpload({
    userId,
    files,
    items,
  }: ProcessUploadInput): Promise<UploadOutcome> {
    if (files.length !== items.length) {
      throw new AppError("VALIDATION_FAILED", 422, "Expected one item for each file.");
    }

    const sourceIds = [...new Set(items.map((item) => item.sourceId))];
    const sourceRows = await prisma.source.findMany({
      where: { id: { in: sourceIds } },
      select: { id: true, name: true, isActive: true, fileTypes: { select: { fileType: true } } },
    });
    const sources = new Map(sourceRows.map((source) => [source.id, source]));

    const batch = await prisma.uploadBatch.create({
      data: { uploadedById: userId, fileCount: files.length },
      select: { id: true },
    });

    const results: FileResult[] = [];
    try {
      for (const [index, file] of files.entries()) {
        const item = items[index];
        if (!item) throw new AppError("VALIDATION_FAILED", 422, "Expected one item for each file.");
        results.push(await processOne({ index, file, item, userId, batchId: batch.id, sources }));
      }
    } finally {
      await Promise.all(files.map((file) => removeFileQuietly(file.tempPath)));
      const count = (status: FileResult["status"]) =>
        results.filter((result) => result.status === status).length;
      await prisma.uploadBatch
        .update({
          where: { id: batch.id },
          data: {
            acceptedCount: count("ACCEPTED"),
            duplicateCount: count("DUPLICATE"),
            rejectedCount: count("REJECTED"),
          },
        })
        .catch((err: unknown) => logger.error({ err }, "could not update upload batch counts"));
    }

    return {
      batchId: batch.id,
      summary: {
        fileCount: files.length,
        accepted: results.filter((result) => result.status === "ACCEPTED").length,
        duplicate: results.filter((result) => result.status === "DUPLICATE").length,
        rejected: results.filter((result) => result.status === "REJECTED").length,
      },
      results,
    };
  }

  async function listUploads(query: ListUploadsQuery): Promise<UploadPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await prisma.uploadedFile.findMany({
      where: {
        sourceId: query.sourceId,
        fileType: query.fileType,
        status: query.status,
        ...(cursor
          ? {
              OR: [
                { uploadedAt: { lt: cursor.uploadedAt } },
                { uploadedAt: cursor.uploadedAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ uploadedAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      include: fileInclude,
    });

    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > query.limit && last
        ? encodeCursor({ uploadedAt: last.uploadedAt, id: last.id })
        : null;
    return { items: page.map(toUploadedFileDto), nextCursor };
  }

  async function getUpload(id: string): Promise<UploadedFileDto> {
    const row = await prisma.uploadedFile.findUnique({ where: { id }, include: fileInclude });
    if (!row) throw new AppError("NOT_FOUND", 404, "Upload not found.");
    return toUploadedFileDto(row);
  }

  return { processUpload, listUploads, getUpload };
}
