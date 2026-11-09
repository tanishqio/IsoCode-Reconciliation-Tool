// Measures matching and result calculation (Part 6) on about 100,000 orders and their payments,
// through the real queue, worker and database.
//
//   npx tsx scripts/bench-ingest.ts prepare     (once: builds bench-orders.csv and bench-settlement.csv)
//   npx tsx scripts/bench-reconcile.ts
//
// It only touches the test database (leaklens_test) and empties its tables first.
// Orders are the public Olist orders; the settlement file holds the real total paid per order,
// dated 10 days after the order (made-up dates), so every order has exactly one payout line.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertTestDatabase, getTestDatabaseUrl } from "../tests/helpers/test-db.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dataDir = path.join(repoRoot, ".bench-data");

for (const name of ["bench-orders.csv", "bench-settlement.csv"]) {
  if (!existsSync(path.join(dataDir, name)))
    throw new Error(`${name} is missing. Run "prepare" first.`);
}
const dbUrl = getTestDatabaseUrl();
assertTestDatabase(dbUrl);
process.env["DATABASE_URL"] = dbUrl;
process.env["LOG_LEVEL"] = "silent";
process.env["UPLOAD_DIR"] = path.join(dataDir, "uploads");
process.env["UPLOAD_TEMP_DIR"] = path.join(dataDir, "tmp");
rmSync(process.env["UPLOAD_DIR"], { recursive: true, force: true });

const { prisma } = await import("../src/db/prisma.js");
const { seedSources } = await import("../src/db/seed-sources.js");
const { seedUsers } = await import("../src/db/seed-users.js");
const { seedRateCards } = await import("../src/db/seed-rate-cards.js");
const { startWorker } = await import("../src/jobs/worker-loop.js");
const { jobHandlers } = await import("../src/jobs/handlers.js");
const { logger } = await import("../src/lib/logger.js");
const { readHeaders } = await import("../src/lib/header-reader.js");
const { resolveColumnMap } = await import("../src/modules/ingestion/fields.js");
const { enqueueRecompute } =
  await import("../src/modules/reconciliation/reconciliation.service.js");

await prisma.$executeRawUnsafe(
  'TRUNCATE TABLE "users", "uploaded_files", "upload_batches", "sources", "source_file_types", "processing_jobs", "order_results", "rate_cards" CASCADE',
);
await seedSources(prisma);
await (seedUsers as (c: typeof prisma, u: unknown[], cost: number) => Promise<void>)(
  prisma,
  [
    {
      email: "bench@example.test",
      password: "bench-password-123",
      name: "Bench",
      role: "FINANCE_EXECUTIVE",
    },
  ],
  4,
);
await seedRateCards(prisma);
const user = await prisma.user.findFirstOrThrow();
const marketplace = await prisma.source.findUniqueOrThrow({ where: { name: "Marketplace 1" } });
const batch = await prisma.uploadBatch.create({ data: { uploadedById: user.id, fileCount: 2 } });

async function queueFile(fileName: string, fileType: "ORDERS" | "SETTLEMENT"): Promise<string> {
  const source = path.join(dataDir, fileName);
  const fileId = crypto.randomUUID();
  const storagePath = `bench/${fileId}.csv`;
  mkdirSync(path.dirname(path.join(process.env["UPLOAD_DIR"] as string, storagePath)), {
    recursive: true,
  });
  copyFileSync(source, path.join(process.env["UPLOAD_DIR"] as string, storagePath));
  const headers = (await readHeaders(source, "CSV")).headers;
  const mapping = resolveColumnMap(fileType, headers);
  if (mapping.missing.length > 0)
    throw new Error(`${fileName}: unmapped ${mapping.missing.join(", ")}`);
  const version = await prisma.mappingVersion.create({
    data: {
      sourceId: marketplace.id,
      fileType,
      versionNo: 1,
      headerSignature: fileName,
      columnMap: mapping.columnMap,
      ignoredColumns: [],
      origin: "MANUAL",
      status: "ACTIVE",
      createdById: user.id,
      approvedById: user.id,
      approvedAt: new Date(),
    },
  });
  await prisma.uploadedFile.create({
    data: {
      id: fileId,
      batchId: batch.id,
      sourceId: marketplace.id,
      fileType,
      originalName: fileName,
      storagePath,
      sizeBytes: BigInt(statSync(source).size),
      format: "CSV",
      sha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
      headerSignature: fileName,
      status: "QUEUED",
      mappingVersionId: version.id,
      uploadedById: user.id,
    },
  });
  await prisma.processingJob.create({
    data: {
      type: "INGEST_FILE",
      entityType: "UPLOADED_FILE",
      entityId: fileId,
      params: { columnMap: mapping.columnMap },
      createdById: user.id,
    },
  });
  return fileId;
}

async function waitForIdle(): Promise<void> {
  for (;;) {
    const open = await prisma.processingJob.count({
      where: { status: { in: ["QUEUED", "RUNNING"] } },
    });
    if (open === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const worker = startWorker({
  handlers: jobHandlers,
  logger,
  pollIntervalMs: 50,
  heartbeatIntervalMs: 5000,
  staleAfterMs: 120_000,
});

// Step 1: read both files (each file also asks for a recalculation when it finishes).
const ingestStart = performance.now();
await queueFile("bench-orders.csv", "ORDERS");
await queueFile("bench-settlement.csv", "SETTLEMENT");
await waitForIdle();
const ingestMs = Math.round(performance.now() - ingestStart);

// Step 2: the measured run. Everything is already loaded; clear old links so linking is timed too.
await prisma.$executeRawUnsafe(
  `UPDATE settlement_lines SET "orderPk" = NULL, "matchStatus" = 'UNMATCHED'`,
);
const startedAt = performance.now();
const { jobId } = await enqueueRecompute(prisma, user.id);
let job = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
while (job.status === "QUEUED" || job.status === "RUNNING") {
  await new Promise((resolve) => setTimeout(resolve, 100));
  job = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
}
const wallMs = Math.round(performance.now() - startedAt);
await worker.stop();

const byStatus = await prisma.orderResult.groupBy({ by: ["status"], _count: { _all: true } });
const total = await prisma.orderResult.count();
console.log(
  JSON.stringify(
    {
      orders: await prisma.customerOrder.count(),
      settlementLines: await prisma.settlementLine.count(),
      ingestBothFilesMs: ingestMs,
      recomputeStatus: job.status,
      recomputeError: job.errorMessage,
      recomputeWallMs: wallMs,
      stageTimingsMs: job.stageTimingsMs,
      resultRows: total,
      byStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count._all])),
      peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
