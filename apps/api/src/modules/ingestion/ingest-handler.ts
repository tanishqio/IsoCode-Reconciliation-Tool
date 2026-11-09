import { z } from "zod";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { env } from "../../config/env.js";
import { JobFailure, type JobHandler } from "../../jobs/job-types.js";
import { logger } from "../../lib/logger.js";
import { enqueueRecompute } from "../reconciliation/reconciliation.service.js";
import { resolveInside } from "../uploads/uploads.storage.js";
import { resolveColumnMap } from "./fields.js";
import { readTable, TableReadError, type RawTable } from "./read-table.js";
import { transformTable } from "./transform.js";
import { BATCH_SIZE, clearFileRows, insertRecords, insertRejected } from "./writer.js";

/** What the job needs to know besides the file: which column feeds which standard field. */
export const ingestParamsSchema = z.object({
  columnMap: z.record(z.string().min(1).max(100), z.string().min(1).max(300)).optional(),
});

export type IngestParams = z.infer<typeof ingestParamsSchema>;

const TRANSACTION_TIMEOUT_MS = 30 * 60 * 1000;

export function createIngestHandler(prisma: PrismaClient): JobHandler {
  return async ({ job, setStage, signal }) => {
    const fileId = job.entityId;
    if (job.entityType !== "UPLOADED_FILE" || !fileId) {
      throw new JobFailure("This job does not point at an uploaded file.");
    }
    const params = ingestParamsSchema.safeParse(job.params ?? {});
    if (!params.success) throw new JobFailure("The job settings are not valid.");

    const file = await prisma.uploadedFile.findUnique({ where: { id: fileId } });
    if (!file) throw new JobFailure("The uploaded file no longer exists.");

    await prisma.uploadedFile.update({ where: { id: file.id }, data: { status: "PROCESSING" } });

    try {
      await setStage("reading", 5);
      let table: RawTable;
      try {
        table = await readTable(resolveInside(env.UPLOAD_DIR, file.storagePath), file.format);
      } catch (err) {
        if (err instanceof TableReadError) throw new JobFailure(err.message);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new JobFailure("The stored file is missing from the server.");
        }
        throw err;
      }
      if (table.rows.length === 0) throw new JobFailure("The file has a header but no data rows.");

      const mapping = resolveColumnMap(file.fileType, table.headers, params.data.columnMap);
      if (mapping.invalid.length > 0) {
        throw new JobFailure(`The column mapping is not valid: ${mapping.invalid.join("; ")}.`);
      }
      if (mapping.missing.length > 0) {
        throw new JobFailure(`Required columns were not found: ${mapping.missing.join(", ")}.`);
      }
      if (signal.aborted) throw new JobFailure("The worker was stopped before this file was read.");

      await setStage("validating", 30);
      const couriers = new Map<string, string>();
      if (file.fileType === "ORDERS") {
        const sources = await prisma.source.findMany({
          where: { kind: "COURIER_AGGREGATOR" },
          select: { id: true, name: true },
        });
        for (const source of sources) couriers.set(source.name.toLowerCase(), source.id);
      }
      const result = transformTable({
        fileType: file.fileType,
        sourceId: file.sourceId,
        sourceFileId: file.id,
        table,
        indexes: mapping.indexes,
        couriers,
      });

      await setStage("saving", 55);
      let inserted = 0;
      const totalBatches = Math.ceil(result.records.length / BATCH_SIZE) || 1;
      await prisma.$transaction(
        async (tx) => {
          await clearFileRows(tx, file.fileType, file.id);
          let done = 0;
          for (let from = 0; from < result.records.length; from += BATCH_SIZE) {
            inserted += await insertRecords(
              tx,
              file.fileType,
              result.records.slice(from, from + BATCH_SIZE),
            );
            done += 1;
            await setStage("saving", 55 + Math.round((done / totalBatches) * 40));
          }
          for (let from = 0; from < result.rejected.length; from += BATCH_SIZE) {
            await insertRejected(tx, file.id, result.rejected.slice(from, from + BATCH_SIZE));
          }

          // Rows skipped by the database were already saved from an earlier file.
          const alreadySaved = result.records.length - inserted;
          await tx.uploadedFile.update({
            where: { id: file.id },
            data: {
              status: result.rejected.length > 0 ? "COMPLETED_WITH_REJECTS" : "COMPLETED",
              rowsAccepted: inserted,
              rowsRejected: result.rejected.length,
              rowsDuplicate: result.duplicateRows + alreadySaved,
              processedAt: new Date(),
            },
          });
        },
        { timeout: TRANSACTION_TIMEOUT_MS, maxWait: 60_000 },
      );
      await setStage("finishing", 100);
      // New rows can change every order result, so ask for a recalculation (one at a time).
      await enqueueRecompute(prisma, job.createdById).catch((err: unknown) =>
        logger.error({ err, fileId: file.id }, "could not queue the recalculation"),
      );
    } catch (err) {
      // Nothing from this file was saved (the save is one transaction), so mark it failed.
      await prisma.uploadedFile
        .update({
          where: { id: file.id },
          data: {
            status: "FAILED",
            processedAt: new Date(),
            rowsAccepted: null,
            rowsRejected: null,
            rowsDuplicate: null,
          },
        })
        .catch((updateError: unknown) =>
          logger.error({ err: updateError, fileId: file.id }, "could not mark the file as failed"),
        );
      throw err;
    }
  };
}
