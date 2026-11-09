import type { PrismaClient } from "../../../generated/prisma/client.js";
import type { FileType, SourceKind } from "../../../generated/prisma/enums.js";

export interface SourceDto {
  id: string;
  name: string;
  kind: SourceKind;
  fileTypes: FileType[];
}

export type SourcesService = ReturnType<typeof createSourcesService>;

export function createSourcesService({ prisma }: { prisma: PrismaClient }) {
  async function listActiveSources(): Promise<SourceDto[]> {
    const rows = await prisma.source.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        kind: true,
        fileTypes: { select: { fileType: true }, orderBy: { fileType: "asc" } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      fileTypes: row.fileTypes.map((entry) => entry.fileType),
    }));
  }

  return { listActiveSources };
}
