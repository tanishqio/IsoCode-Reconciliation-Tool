// Measures the whole pipeline on generated data, with all five report types, and checks the answers.
//
//   npx tsx scripts/bench-full.ts --orders 10000 --runs 3
//   npx tsx scripts/bench-full.ts --orders 100000 --runs 3
//
// What it does: makes the sample files (scripts/generate-sample-data.ts), reads them through the real
// queue, worker and database (the same code the app uses), then runs the matching and calculation job
// several times and times each stage. It compares every order's result with what the generator knows
// to be true. It prints a JSON report and saves it next to the data in .bench-data/full-<orders>/.
//
// It only ever touches a TEST database (the name must contain "test"; set TEST_DATABASE_URL, or it
// uses leaklens_test) and empties its tables first. Uploaded copies go to .bench-data/ (git-ignored).
//
// Nothing here promises a speed: the numbers belong to this machine on the day they were measured.
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertTestDatabase, getTestDatabaseUrl } from "../tests/helpers/test-db.js";
import { generateDataset } from "../src/tools/sample-data/generate.js";
import { writeDataset } from "../src/tools/sample-data/write.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const orders = Number(argument("orders") ?? "10000");
const runs = Math.max(1, Number(argument("runs") ?? "3"));
// --analyze refreshes the database statistics on the loaded tables before the measured runs.
const analyzeFirst = process.argv.includes("--analyze");
if (!Number.isInteger(orders) || orders < 10) {
  console.error("Usage: tsx scripts/bench-full.ts --orders <at least 10> [--runs <number>]");
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dir = path.join(repoRoot, ".bench-data", `full-${orders}`);
const dbUrl = getTestDatabaseUrl();
assertTestDatabase(dbUrl);
process.env["DATABASE_URL"] = dbUrl;
process.env["LOG_LEVEL"] = "silent";
process.env["UPLOAD_DIR"] = path.join(dir, "uploads");
process.env["UPLOAD_TEMP_DIR"] = path.join(dir, "tmp");

const seconds = (ms: number) => Math.round(ms) / 1000;
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;

// 1. The data ------------------------------------------------------------------------------------
rmSync(dir, { recursive: true, force: true });
const generatedAt = performance.now();
const dataset = generateDataset({ orders, seed: 2026 });
const manifest = writeDataset(dataset, path.join(dir, "files"));
const generateMs = performance.now() - generatedAt;
const totalRows = manifest.files.reduce((sum, file) => sum + file.rows, 0);
const totalBytes = manifest.files.reduce(
  (sum, file) => sum + statSync(path.join(dir, "files", file.name)).size,
  0,
);
console.error(
  `Generated ${manifest.files.length} files, ${totalRows} rows, in ${seconds(generateMs)} s.`,
);

// 2. The database ----------------------------------------------------------------------------------
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
  'TRUNCATE TABLE "users", "uploaded_files", "upload_batches", "sources", "source_file_types", "processing_jobs", "order_results", "rate_cards", "audit_logs", "reconciliation_settings" CASCADE',
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
const sourceIdByName = new Map((await prisma.source.findMany()).map((s) => [s.name, s.id]));
const batch = await prisma.uploadBatch.create({
  data: { uploadedById: user.id, fileCount: manifest.files.length },
});

// 3. Queue every file, as an approved mapping would -----------------------------------------------------
for (const file of manifest.files) {
  const source = path.join(dir, "files", file.name);
  const sourceId = sourceIdByName.get(file.source) as string;
  const fileId = randomUUID();
  const storagePath = `bench/${fileId}.csv`;
  mkdirSync(path.dirname(path.join(process.env["UPLOAD_DIR"] as string, storagePath)), {
    recursive: true,
  });
  copyFileSync(source, path.join(process.env["UPLOAD_DIR"] as string, storagePath));
  const headers = (await readHeaders(source, "CSV")).headers;
  const mapping = resolveColumnMap(file.fileType as never, headers);
  if (mapping.missing.length > 0)
    throw new Error(`${file.name}: unmapped ${mapping.missing.join(", ")}`);
  const version = await prisma.mappingVersion.create({
    data: {
      sourceId,
      fileType: file.fileType as never,
      versionNo: 1,
      headerSignature: file.name,
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
      sourceId,
      fileType: file.fileType as never,
      originalName: file.name,
      storagePath,
      sizeBytes: BigInt(statSync(source).size),
      format: "CSV",
      sha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
      headerSignature: file.name,
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
  staleAfterMs: 600_000,
});

// 4. Read all the files ----------------------------------------------------------------------------------
const ingestStart = performance.now();
await waitForIdle();
const ingestMs = performance.now() - ingestStart;
const failedFiles = await prisma.uploadedFile.count({ where: { status: "FAILED" } });
const rejectedRows = await prisma.rejectedRow.count();
const counts = {
  orders: await prisma.customerOrder.count(),
  settlementLines: await prisma.settlementLine.count(),
  codRemittanceLines: await prisma.codRemittanceLine.count(),
  freightLines: await prisma.freightLine.count(),
  returnScans: await prisma.returnScan.count(),
};

// Reading a file also queues a recalculation, so the wall time above includes those. Split it up.
const finishedJobs = await prisma.processingJob.findMany({
  where: { finishedAt: { not: null }, startedAt: { not: null } },
  select: { type: true, startedAt: true, finishedAt: true },
});
const jobSeconds = (type: string) => {
  const mine = finishedJobs.filter((job) => job.type === type);
  const total = mine.reduce(
    (sum, job) => sum + ((job.finishedAt as Date).getTime() - (job.startedAt as Date).getTime()),
    0,
  );
  return { jobs: mine.length, seconds: seconds(total) };
};
const jobBreakdown = {
  readFileJobs: jobSeconds("INGEST_FILE"),
  recalculationsQueuedWhileReading: jobSeconds("RECOMPUTE_RESULTS"),
};

// 5. The measured job, several times
if (analyzeFirst) {
  for (const table of [
    "customer_orders",
    "settlement_lines",
    "cod_remittance_lines",
    "freight_lines",
    "return_scans",
  ]) {
    await prisma.$executeRawUnsafe(`ANALYZE ${table}`);
  }
}
const measured: { wallMs: number; status: string; stages: unknown }[] = [];
for (let run = 0; run < runs; run += 1) {
  // Undo the links so that linking is timed too, as on a first calculation.
  for (const table of [
    "settlement_lines",
    "cod_remittance_lines",
    "freight_lines",
    "return_scans",
  ]) {
    await prisma.$executeRawUnsafe(
      `UPDATE ${table} SET "orderPk" = NULL, "matchStatus" = 'UNMATCHED'`,
    );
  }
  const startedAt = performance.now();
  const { jobId } = await enqueueRecompute(prisma, user.id);
  let job = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
  while (job.status === "QUEUED" || job.status === "RUNNING") {
    await new Promise((resolve) => setTimeout(resolve, 100));
    job = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
  }
  measured.push({
    wallMs: Math.round(performance.now() - startedAt),
    status: job.status,
    stages: job.stageTimingsMs,
  });
  console.error(`Run ${run + 1}: ${job.status} in ${seconds(measured[run]?.wallMs ?? 0)} s.`);
}
await worker.stop();

// 6. Compare every order with the truth ------------------------------------------------------------------------
const truthByKey = new Map(
  dataset.truth.map((order) => [`${order.channel}|${order.orderId}`, order]),
);
const results = await prisma.orderResult.findMany({
  select: {
    status: true,
    expected: true,
    difference: true,
    order: { select: { orderId: true, channel: { select: { name: true } } } },
  },
});
let statusMismatches = 0;
let amountMismatches = 0;
const examples: string[] = [];
for (const row of results) {
  const truth = truthByKey.get(`${row.order.channel.name}|${row.order.orderId}`);
  if (!truth) {
    statusMismatches += 1;
    continue;
  }
  if (row.status !== truth.status) {
    statusMismatches += 1;
    if (examples.length < 5)
      examples.push(`${truth.orderId}: engine ${row.status}, truth ${truth.status}`);
  } else if (
    (row.expected?.toFixed(2) ?? null) !== truth.expected ||
    (truth.difference !== null && row.difference?.toFixed(2) !== truth.difference)
  ) {
    amountMismatches += 1;
  }
}

const walls = measured.map((run) => run.wallMs);
const report = {
  when: new Date().toISOString(),
  machine: {
    cpu: os.cpus()[0]?.model.trim(),
    logicalCores: os.cpus().length,
    memoryGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    os: `${os.type()} ${os.release()}`,
    node: process.version,
  },
  data: {
    orders,
    files: manifest.files.length,
    totalRows,
    totalMB: Math.round((totalBytes / 1024 / 1024) * 10) / 10,
    generateSeconds: seconds(generateMs),
  },
  readingFiles: {
    wallSecondsIncludingRecalculations: seconds(ingestMs),
    ...jobBreakdown,
    failedFiles,
    rejectedRows,
    saved: counts,
  },
  matchingAndCalculation: {
    runs,
    secondsEachRun: walls.map((ms) => seconds(ms)),
    secondsMin: seconds(Math.min(...walls)),
    secondsMedian: seconds(median(walls)),
    secondsMax: seconds(Math.max(...walls)),
    allSucceeded: measured.every((run) => run.status === "SUCCEEDED"),
    analyzedBeforehand: analyzeFirst,
    stageMsEachRun: measured.map((run) => run.stages),
  },
  correctness: {
    ordersChecked: results.length,
    statusMismatches,
    amountMismatches,
    examples,
  },
  peakMemoryMB: Math.round(process.resourceUsage().maxRSS / 1024),
  note: "Measured on this machine only. The database and the worker ran on the same computer as this script.",
};

writeFileSync(path.join(dir, "result.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
