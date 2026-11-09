import { z } from "zod";
import { Prisma, type PrismaClient } from "../../../generated/prisma/client.js";
import type { FileType } from "../../../generated/prisma/enums.js";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { FIELD_SPECS, resolveColumnMap, type ColumnMap } from "../ingestion/fields.js";
import { readTable, TableReadError, type RawTable } from "../ingestion/read-table.js";
import { resolveInside } from "../uploads/uploads.storage.js";
import { isPersonalHeader } from "./personal.js";
import { buildPreview, PREVIEW_ROWS, type Preview } from "./preview.js";
import type { Suggester } from "./suggest.js";

type Tx = Prisma.TransactionClient;

export const columnMapSchema = z.record(z.string().min(1).max(100), z.string().min(1).max(300));
export const previewBodySchema = z.strictObject({ columnMap: columnMapSchema });
export const approveBodySchema = z.strictObject({
  proposalId: z.uuid(),
  columnMap: columnMapSchema,
});
export const listMappingsQuerySchema = z.object({
  sourceId: z.uuid(),
  fileType: z.enum(["ORDERS", "SETTLEMENT", "COD_REMITTANCE", "FREIGHT_INVOICE", "RETURN_SCAN"]),
});

export interface MappingServiceDeps {
  prisma: PrismaClient;
  suggester: Suggester;
}

export type MappingService = ReturnType<typeof createMappingService>;

function sameMap(a: ColumnMap, b: ColumnMap): boolean {
  const norm = (map: ColumnMap) =>
    JSON.stringify(Object.entries(map).sort(([x], [y]) => x.localeCompare(y)));
  return norm(a) === norm(b);
}

/** The newest approved version number for a source and file type, plus one. */
async function nextVersionNo(tx: Tx, sourceId: string, fileType: FileType): Promise<number> {
  const last = await tx.mappingVersion.aggregate({
    where: { sourceId, fileType },
    _max: { versionNo: true },
  });
  return (last._max.versionNo ?? 0) + 1;
}

/**
 * Queues every file that is waiting for this mapping: same source, same file type, same set of
 * column names. Each one gets the mapping and an ingestion job.
 */
async function releaseWaitingFiles(
  tx: Tx,
  version: { id: string; sourceId: string; fileType: FileType; headerSignature: string },
  columnMap: ColumnMap,
  userId: string,
): Promise<number> {
  const waiting = await tx.uploadedFile.findMany({
    where: {
      sourceId: version.sourceId,
      fileType: version.fileType,
      headerSignature: version.headerSignature,
      status: "NEEDS_MAPPING",
    },
    select: { id: true },
    orderBy: { uploadedAt: "asc" },
  });
  let released = 0;
  for (const file of waiting) {
    const claimed = await tx.uploadedFile.updateMany({
      where: { id: file.id, status: "NEEDS_MAPPING" },
      data: {
        status: "QUEUED",
        mappingVersionId: version.id,
        rowsAccepted: null,
        rowsRejected: null,
        rowsDuplicate: null,
        processedAt: null,
      },
    });
    if (claimed.count !== 1) continue;
    await tx.processingJob.create({
      data: {
        type: "INGEST_FILE",
        entityType: "UPLOADED_FILE",
        entityId: file.id,
        params: { columnMap },
        createdById: userId,
      },
    });
    released += 1;
  }
  return released;
}

export function createMappingService({ prisma, suggester }: MappingServiceDeps) {
  async function loadWaitingFile(fileId: string) {
    const file = await prisma.uploadedFile.findUnique({
      where: { id: fileId },
      include: { source: { select: { name: true } } },
    });
    if (!file) throw new AppError("NOT_FOUND", 404, "Upload not found.");
    if (file.status !== "NEEDS_MAPPING") {
      throw new AppError("CONFLICT", 409, "This file already has a mapping.");
    }
    return file;
  }

  async function readTop(file: { storagePath: string; format: "CSV" | "XLS" | "XLSX" }) {
    try {
      return await readTable(resolveInside(env.UPLOAD_DIR, file.storagePath), file.format, {
        maxRows: PREVIEW_ROWS,
      });
    } catch (err) {
      if (err instanceof TableReadError) throw new AppError("VALIDATION_FAILED", 422, err.message);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AppError("NOT_FOUND", 404, "The stored file is missing from the server.");
      }
      throw err;
    }
  }

  /** Checks a mapping against the file's real columns and returns the resolved column indexes. */
  function checkMapping(fileType: FileType, table: RawTable, columnMap: ColumnMap) {
    const mapping = resolveColumnMap(fileType, table.headers, columnMap);
    const personal = Object.values(mapping.columnMap).filter((header) =>
      isPersonalHeader(header, fileType),
    );
    const problems = [
      ...mapping.invalid,
      ...personal.map((header) => `column "${header}" looks like personal data and cannot be used`),
    ];
    return { mapping, problems };
  }

  function previewFor(fileType: FileType, table: RawTable, columnMap: ColumnMap) {
    const { mapping, problems } = checkMapping(fileType, table, columnMap);
    const preview: Preview = buildPreview(fileType, table, mapping.indexes);
    return { preview, missing: mapping.missing, problems, columnMap: mapping.columnMap };
  }

  async function activeSummary(sourceId: string, fileType: FileType) {
    const active = await prisma.mappingVersion.findFirst({
      where: { sourceId, fileType, status: "ACTIVE" },
      select: { id: true, versionNo: true, columnMap: true, approvedAt: true },
    });
    return active
      ? {
          id: active.id,
          versionNo: active.versionNo,
          columnMap: active.columnMap as ColumnMap,
          approvedAt: active.approvedAt?.toISOString() ?? null,
        }
      : null;
  }

  /** Proposes a mapping for a waiting file and shows how its first rows would be read. */
  async function suggest(args: { fileId: string; userId: string }) {
    const file = await loadWaitingFile(args.fileId);
    const table = await readTop(file);
    const suggestion = await suggester.suggest({
      fileType: file.fileType,
      headers: table.headers,
      sampleRows: table.rows.map((row) => row.cells),
    });

    const proposal = await prisma.mappingVersion.create({
      data: {
        sourceId: file.sourceId,
        fileType: file.fileType,
        headerSignature: file.headerSignature,
        columnMap: suggestion.columnMap,
        ignoredColumns: suggestion.ignoredColumns,
        fieldInfo: suggestion.fieldInfo as unknown as Prisma.InputJsonValue,
        notes: suggestion.notes,
        origin: suggestion.origin,
        aiModel: suggestion.aiModel,
        status: "PROPOSED",
        createdById: args.userId,
      },
      select: { id: true },
    });

    const checked = previewFor(file.fileType, table, suggestion.columnMap);
    return {
      proposalId: proposal.id,
      file: {
        id: file.id,
        originalName: file.originalName,
        sourceId: file.sourceId,
        sourceName: file.source.name,
        fileType: file.fileType,
      },
      headers: table.headers,
      fields: FIELD_SPECS[file.fileType].map(({ name, label, kind, required }) => ({
        name,
        label,
        kind,
        required,
      })),
      columnMap: checked.columnMap,
      fieldInfo: suggestion.fieldInfo,
      origin: suggestion.origin,
      aiModel: suggestion.aiModel,
      notes: suggestion.notes,
      ignoredColumns: suggestion.ignoredColumns,
      missing: checked.missing,
      preview: checked.preview,
      activeVersion: await activeSummary(file.sourceId, file.fileType),
    };
  }

  /** The 20-row preview for a mapping the person has edited. Nothing is saved. */
  async function preview(args: { fileId: string; columnMap: ColumnMap }) {
    const file = await loadWaitingFile(args.fileId);
    const table = await readTop(file);
    const checked = previewFor(file.fileType, table, args.columnMap);
    return { preview: checked.preview, missing: checked.missing, problems: checked.problems };
  }

  /**
   * A person approves a mapping. It becomes the next version, replaces the active one, and every
   * file waiting for it is queued for processing.
   */
  async function approve(args: {
    fileId: string;
    userId: string;
    proposalId: string;
    columnMap: ColumnMap;
  }) {
    const file = await loadWaitingFile(args.fileId);
    const table = await readTop(file);
    const { mapping, problems } = checkMapping(file.fileType, table, args.columnMap);
    if (problems.length > 0 || mapping.missing.length > 0) {
      const all = [
        ...problems,
        ...(mapping.missing.length > 0
          ? [`required fields not mapped: ${mapping.missing.join(", ")}`]
          : []),
      ];
      throw new AppError(
        "VALIDATION_FAILED",
        422,
        `This mapping cannot be saved: ${all.join("; ")}.`,
        {
          missing: mapping.missing,
          problems,
        },
      );
    }

    try {
      return await prisma.$transaction(async (tx) => {
        const proposal = await tx.mappingVersion.findUnique({ where: { id: args.proposalId } });
        if (
          !proposal ||
          proposal.sourceId !== file.sourceId ||
          proposal.fileType !== file.fileType ||
          proposal.headerSignature !== file.headerSignature
        ) {
          throw new AppError("NOT_FOUND", 404, "That suggestion does not belong to this file.");
        }
        if (proposal.status !== "PROPOSED") {
          throw new AppError("CONFLICT", 409, "That suggestion was already used or rejected.");
        }

        const versionNo = await nextVersionNo(tx, file.sourceId, file.fileType);
        await tx.mappingVersion.updateMany({
          where: { sourceId: file.sourceId, fileType: file.fileType, status: "ACTIVE" },
          data: { status: "SUPERSEDED" },
        });
        const edited = !sameMap(proposal.columnMap as ColumnMap, mapping.columnMap);
        const version = await tx.mappingVersion.update({
          where: { id: proposal.id },
          data: {
            status: "ACTIVE",
            versionNo,
            columnMap: mapping.columnMap,
            // A person changed the suggestion, so it is labelled as a manual mapping.
            origin: edited ? "MANUAL" : proposal.origin,
            approvedById: args.userId,
            approvedAt: new Date(),
          },
        });
        const queuedFiles = await releaseWaitingFiles(tx, version, mapping.columnMap, args.userId);
        return { id: version.id, versionNo, origin: version.origin, queuedFiles };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new AppError(
          "CONFLICT",
          409,
          "Another mapping was approved at the same moment. Try again.",
        );
      }
      throw err;
    }
  }

  async function rejectProposal(args: { id: string }) {
    const result = await prisma.mappingVersion.updateMany({
      where: { id: args.id, status: "PROPOSED" },
      data: { status: "REJECTED" },
    });
    if (result.count !== 1) {
      throw new AppError("NOT_FOUND", 404, "No open suggestion with that ID.");
    }
  }

  async function listVersions(args: { sourceId: string; fileType: FileType }) {
    const rows = await prisma.mappingVersion.findMany({
      where: {
        sourceId: args.sourceId,
        fileType: args.fileType,
        status: { in: ["ACTIVE", "SUPERSEDED"] },
      },
      orderBy: { versionNo: "desc" },
      include: { approvedBy: { select: { name: true } } },
    });
    const numbers = new Map(rows.map((row) => [row.id, row.versionNo]));
    return {
      items: rows.map((row) => ({
        id: row.id,
        versionNo: row.versionNo,
        status: row.status,
        origin: row.origin,
        aiModel: row.aiModel,
        columnMap: row.columnMap as ColumnMap,
        approvedBy: row.approvedBy?.name ?? null,
        approvedAt: row.approvedAt?.toISOString() ?? null,
        rolledBackFromVersionNo: row.rolledBackFromId
          ? (numbers.get(row.rolledBackFromId) ?? null)
          : null,
      })),
    };
  }

  /**
   * Makes an older approved version the active one again. It is saved as a new version so the
   * history stays complete. Files already read are not changed; waiting files are queued.
   */
  async function rollback(args: { id: string; userId: string }) {
    const target = await prisma.mappingVersion.findUnique({ where: { id: args.id } });
    if (!target || target.versionNo === null || !["ACTIVE", "SUPERSEDED"].includes(target.status)) {
      throw new AppError("NOT_FOUND", 404, "No approved mapping version with that ID.");
    }
    if (target.status === "ACTIVE") {
      throw new AppError("CONFLICT", 409, "That version is already the active one.");
    }

    return prisma.$transaction(async (tx) => {
      const versionNo = await nextVersionNo(tx, target.sourceId, target.fileType);
      await tx.mappingVersion.updateMany({
        where: { sourceId: target.sourceId, fileType: target.fileType, status: "ACTIVE" },
        data: { status: "SUPERSEDED" },
      });
      const version = await tx.mappingVersion.create({
        data: {
          sourceId: target.sourceId,
          fileType: target.fileType,
          versionNo,
          headerSignature: target.headerSignature,
          columnMap: target.columnMap as Prisma.InputJsonValue,
          ignoredColumns: target.ignoredColumns as Prisma.InputJsonValue,
          origin: target.origin,
          aiModel: target.aiModel,
          status: "ACTIVE",
          rolledBackFromId: target.id,
          createdById: args.userId,
          approvedById: args.userId,
          approvedAt: new Date(),
        },
      });
      const queuedFiles = await releaseWaitingFiles(
        tx,
        version,
        target.columnMap as ColumnMap,
        args.userId,
      );
      return { id: version.id, versionNo, queuedFiles };
    });
  }

  return { suggest, preview, approve, rejectProposal, listVersions, rollback };
}
