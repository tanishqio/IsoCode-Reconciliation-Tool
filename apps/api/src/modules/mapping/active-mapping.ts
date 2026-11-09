import type { PrismaClient } from "../../../generated/prisma/client.js";
import type { FileType } from "../../../generated/prisma/enums.js";
import { logger } from "../../lib/logger.js";
import type { ColumnMap } from "../ingestion/fields.js";

/**
 * The approved mapping that fits a new file: same source, same file type and the same set of
 * column names. null means a person has to review a mapping first. A lookup problem also gives
 * null, which is the safe answer: the file simply waits for a mapping.
 */
export async function findActiveMapping(
  prisma: PrismaClient,
  sourceId: string,
  fileType: FileType,
  headerSignature: string,
): Promise<{ id: string; columnMap: ColumnMap } | null> {
  try {
    const row = await prisma.mappingVersion.findFirst({
      where: { sourceId, fileType, headerSignature, status: "ACTIVE" },
      select: { id: true, columnMap: true },
    });
    return row ? { id: row.id, columnMap: row.columnMap as ColumnMap } : null;
  } catch (err) {
    logger.warn({ err }, "could not look up the saved mapping; the file will wait for a mapping");
    return null;
  }
}
