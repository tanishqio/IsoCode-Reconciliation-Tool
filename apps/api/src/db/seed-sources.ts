import { pathToFileURL } from "node:url";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { FileType, SourceKind } from "../../generated/prisma/enums.js";

export interface SourceSeed {
  name: string;
  kind: SourceKind;
  fileTypes: FileType[];
}

export const SOURCE_SEED: SourceSeed[] = [
  { name: "Website", kind: "WEBSITE", fileTypes: ["ORDERS"] },
  { name: "Marketplace 1", kind: "MARKETPLACE", fileTypes: ["ORDERS", "SETTLEMENT"] },
  { name: "Marketplace 2", kind: "MARKETPLACE", fileTypes: ["ORDERS", "SETTLEMENT"] },
  { name: "Marketplace 3", kind: "MARKETPLACE", fileTypes: ["ORDERS", "SETTLEMENT"] },
  { name: "Quick Commerce 1", kind: "QUICK_COMMERCE", fileTypes: ["ORDERS", "SETTLEMENT"] },
  { name: "Quick Commerce 2", kind: "QUICK_COMMERCE", fileTypes: ["ORDERS", "SETTLEMENT"] },
  {
    name: "Aggregator 1",
    kind: "COURIER_AGGREGATOR",
    fileTypes: ["COD_REMITTANCE", "FREIGHT_INVOICE"],
  },
  {
    name: "Aggregator 2",
    kind: "COURIER_AGGREGATOR",
    fileTypes: ["COD_REMITTANCE", "FREIGHT_INVOICE"],
  },
  { name: "Warehouse", kind: "WAREHOUSE", fileTypes: ["RETURN_SCAN"] },
];

export async function seedSources(
  prisma: PrismaClient,
  seed: SourceSeed[] = SOURCE_SEED,
): Promise<void> {
  for (const entry of seed) {
    const source = await prisma.source.upsert({
      where: { name: entry.name },
      update: { kind: entry.kind },
      create: { name: entry.name, kind: entry.kind },
      select: { id: true },
    });
    await prisma.sourceFileType.createMany({
      data: entry.fileTypes.map((fileType) => ({ sourceId: source.id, fileType })),
      skipDuplicates: true,
    });
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const { prisma } = await import("./prisma.js");
  try {
    await seedSources(prisma);
    console.log(`Seeded ${SOURCE_SEED.length} sources.`);
  } finally {
    await prisma.$disconnect();
  }
}
