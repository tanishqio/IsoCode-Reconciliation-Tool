import { z } from "zod";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import type { ColumnMap } from "./fields.js";

/** The retry request has no settings: the file is read again with the mapping it already has. */
export const processBodySchema = z.strictObject({}).default({});

export const rejectedRowsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  after: z.coerce.number().int().min(0).default(0),
});

export interface IngestionServiceDeps {
  prisma: PrismaClient;
}

export type IngestionService = ReturnType<typeof createIngestionService>;

export function createIngestionService({ prisma }: IngestionServiceDeps) {
  /**
   * Queues a file whose last run failed so the worker reads it again, with the approved mapping
   * it was first read with. A file that has no approved mapping yet is released by approving a
   * mapping (Part 4), not by this call.
   */
  async function retryProcessing(args: {
    fileId: string;
    userId: string;
  }): Promise<{ jobId: string }> {
    const file = await prisma.uploadedFile.findUnique({
      where: { id: args.fileId },
      include: { mappingVersion: { select: { columnMap: true, status: true } } },
    });
    if (!file) throw new AppError("NOT_FOUND", 404, "Upload not found.");
    if (file.status === "NEEDS_MAPPING") {
      throw new AppError("CONFLICT", 409, "Approve a column mapping for this file first.");
    }
    if (file.status !== "FAILED") {
      throw new AppError("CONFLICT", 409, "Only a file that failed can be processed again.");
    }
    if (!file.mappingVersion) {
      throw new AppError("CONFLICT", 409, "This file has no approved mapping. Approve one first.");
    }
    const columnMap = file.mappingVersion.columnMap as ColumnMap;

    const jobId = await prisma.$transaction(async (tx) => {
      const claimed = await tx.uploadedFile.updateMany({
        where: { id: file.id, status: "FAILED" },
        data: {
          status: "QUEUED",
          rowsAccepted: null,
          rowsRejected: null,
          rowsDuplicate: null,
          processedAt: null,
        },
      });
      if (claimed.count !== 1) {
        throw new AppError("CONFLICT", 409, "This file has already been queued.");
      }
      const job = await tx.processingJob.create({
        data: {
          type: "INGEST_FILE",
          entityType: "UPLOADED_FILE",
          entityId: file.id,
          params: { columnMap },
          createdById: args.userId,
        },
        select: { id: true },
      });
      return job.id;
    });
    return { jobId };
  }

  async function listRejectedRows(args: { fileId: string; limit: number; after: number }) {
    const file = await prisma.uploadedFile.findUnique({
      where: { id: args.fileId },
      select: { id: true, rowsRejected: true },
    });
    if (!file) throw new AppError("NOT_FOUND", 404, "Upload not found.");

    const [rows, groups] = await Promise.all([
      prisma.rejectedRow.findMany({
        where: { fileId: file.id, rowNumber: { gt: args.after } },
        orderBy: [{ rowNumber: "asc" }, { id: "asc" }],
        take: args.limit + 1,
        select: { id: true, rowNumber: true, reasonCode: true, message: true, rawSnippet: true },
      }),
      prisma.rejectedRow.groupBy({
        by: ["reasonCode"],
        where: { fileId: file.id },
        _count: { _all: true },
        orderBy: { _count: { reasonCode: "desc" } },
      }),
    ]);
    const items = rows.slice(0, args.limit);
    const last = items[items.length - 1];
    return {
      items,
      nextAfter: rows.length > args.limit && last ? last.rowNumber : null,
      total: file.rowsRejected ?? 0,
      reasons: groups.map((group) => ({ reasonCode: group.reasonCode, count: group._count._all })),
    };
  }

  return { retryProcessing, listRejectedRows };
}
