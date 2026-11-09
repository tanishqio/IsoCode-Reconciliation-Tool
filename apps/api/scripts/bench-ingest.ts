// Measures file ingestion (Part 3) on a large file, through the real queue, worker and database.
//
//   npx tsx scripts/bench-ingest.ts prepare            builds the test files from the downloaded data
//   npx tsx scripts/bench-ingest.ts run <name>         runs one of: orders-csv, orders-xlsx, freight-csv
//
// It only ever touches the test database (leaklens_test) and empties its upload tables first.
// Data: the public Olist Brazilian e-commerce files, saved in <repo>/.bench-data (git-ignored).
// Amounts there are in Brazilian reais; they are used only to test parsing and volume.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertTestDatabase, getTestDatabaseUrl } from "../tests/helpers/test-db.js";

const XLSX = createRequire(import.meta.url)("xlsx") as typeof import("xlsx");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dataDir = path.join(repoRoot, ".bench-data");

function readCsvRows(file: string): string[][] {
  const text = readFileSync(path.join(dataDir, file), "utf8");
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue;
    rows.push(line.split(",").map((cell) => cell.replace(/^"|"$/g, "")));
  }
  return rows;
}

/**
 * Orders: real Olist orders plus the total of their real payments. Olist has no payment mode
 * like COD, so a boleto (bank slip) payment is labelled COD and the rest Prepaid. That label is
 * made up for this test and has no business meaning.
 */
function prepare(): void {
  const orders = readCsvRows("olist_orders_dataset.csv");
  const payments = readCsvRows("olist_order_payments_dataset.csv");
  const totals = new Map<string, { cents: number; boleto: boolean }>();
  for (const [orderId, , type, , value] of payments.slice(1)) {
    if (!orderId || !value) continue;
    const entry = totals.get(orderId) ?? { cents: 0, boleto: false };
    entry.cents += Math.round(Number(value) * 100);
    entry.boleto ||= type === "boleto";
    totals.set(orderId, entry);
  }

  const header = ["Order ID", "Order Date", "Order Value", "Payment Mode", "Status", "Customer ID"];
  const body: (string | number)[][] = [];
  for (const row of orders.slice(1)) {
    const [orderId, customerId, status, purchasedAt] = row;
    if (!orderId) continue;
    const total = totals.get(orderId);
    body.push([
      orderId,
      purchasedAt ?? "",
      total ? total.cents / 100 : "",
      total?.boleto ? "COD" : "Prepaid",
      status ?? "",
      customerId ?? "",
    ]);
  }

  // A settlement file for the same orders: the real total paid per order, dated 10 days after the order
  // (the date is made up; Olist has no payout date).
  const settlementRows = ["Settlement Date,Order ID,Net Received,TCS,TDS"];
  for (const row of body) {
    const value = row[2];
    if (value === "") continue;
    const day = new Date(`${String(row[1]).slice(0, 10)}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + 10);
    settlementRows.push(
      `${day.toISOString().slice(0, 10)},${row[0]},${Number(value).toFixed(2)},0.00,0.00`,
    );
  }
  writeFileSync(path.join(dataDir, "bench-settlement.csv"), `${settlementRows.join("\n")}\n`);

  const csv = [header, ...body.map((r) => r.map((c) => (typeof c === "number" ? c.toFixed(2) : c)))]
    .map((r) => r.join(","))
    .join("\n");
  writeFileSync(path.join(dataDir, "bench-orders.csv"), `${csv}\n`);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([header, ...body]), "Orders");
  writeFileSync(
    path.join(dataDir, "bench-orders.xlsx"),
    XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer,
  );
  console.log(`Prepared ${body.length} order rows (CSV and XLSX) in ${dataDir}`);
}

interface Scenario {
  file: string;
  format: "CSV" | "XLSX";
  fileType: "ORDERS" | "FREIGHT_INVOICE";
  sourceName: string;
  columnMap?: Record<string, string>;
}

const SCENARIOS: Record<string, Scenario> = {
  "orders-csv": {
    file: "bench-orders.csv",
    format: "CSV",
    fileType: "ORDERS",
    sourceName: "Website",
  },
  "orders-xlsx": {
    file: "bench-orders.xlsx",
    format: "XLSX",
    fileType: "ORDERS",
    sourceName: "Website",
  },
  "freight-csv": {
    file: "olist_order_items_dataset.csv",
    format: "CSV",
    fileType: "FREIGHT_INVOICE",
    sourceName: "Aggregator 1",
    // Olist has no freight invoice, so the closest real columns are mapped explicitly.
    columnMap: {
      invoiceNo: "order_id",
      orderId: "order_id",
      billedAmount: "freight_value",
      chargedOn: "shipping_limit_date",
    },
  },
};

async function run(name: string): Promise<void> {
  const scenario = SCENARIOS[name];
  if (!scenario)
    throw new Error(`Unknown scenario "${name}". Use: ${Object.keys(SCENARIOS).join(", ")}`);
  const source = path.join(dataDir, scenario.file);
  if (!existsSync(source)) throw new Error(`${source} is missing. Run "prepare" first.`);

  const dbUrl = getTestDatabaseUrl();
  assertTestDatabase(dbUrl);
  process.env["DATABASE_URL"] = dbUrl;
  process.env["LOG_LEVEL"] = "silent";
  process.env["UPLOAD_DIR"] = path.join(dataDir, "uploads");
  process.env["UPLOAD_TEMP_DIR"] = path.join(dataDir, "tmp");
  rmSync(process.env["UPLOAD_DIR"], { recursive: true, force: true });

  const { prisma } = await import("../src/db/prisma.js");
  const { seedSources } = await import("../src/db/seed-sources.js");
  const { startWorker } = await import("../src/jobs/worker-loop.js");
  const { jobHandlers } = await import("../src/jobs/handlers.js");
  const { logger } = await import("../src/lib/logger.js");
  const { readHeaders } = await import("../src/lib/header-reader.js");
  const { resolveColumnMap } = await import("../src/modules/ingestion/fields.js");

  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "users", "uploaded_files", "upload_batches", "sources", "source_file_types", "processing_jobs" CASCADE',
  );
  await seedSources(prisma);
  const user = await prisma.user.create({
    data: {
      email: "bench@example.test",
      name: "Bench",
      passwordHash: "x",
      role: "FINANCE_EXECUTIVE",
    },
  });
  const sourceRow = await prisma.source.findUniqueOrThrow({ where: { name: scenario.sourceName } });

  // Store the file the way the upload step does.
  const fileId = crypto.randomUUID();
  const storagePath = `bench/${fileId}.${scenario.format.toLowerCase()}`;
  mkdirSync(path.dirname(path.join(process.env["UPLOAD_DIR"], storagePath)), { recursive: true });
  copyFileSync(source, path.join(process.env["UPLOAD_DIR"], storagePath));
  const batch = await prisma.uploadBatch.create({ data: { uploadedById: user.id, fileCount: 1 } });
  await prisma.uploadedFile.create({
    data: {
      id: fileId,
      batchId: batch.id,
      sourceId: sourceRow.id,
      fileType: scenario.fileType,
      originalName: scenario.file,
      storagePath,
      sizeBytes: BigInt(statSync(source).size),
      format: scenario.format,
      sha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
      headerSignature: "bench",
      status: "NEEDS_MAPPING",
      uploadedById: user.id,
    },
  });

  const worker = startWorker({
    handlers: jobHandlers,
    logger,
    pollIntervalMs: 50,
    heartbeatIntervalMs: 5000,
    staleAfterMs: 120_000,
  });
  const startedAt = performance.now();
  // Stand in for an approved mapping: save one as ACTIVE and queue the file with it.
  const headers = (await readHeaders(source, scenario.format)).headers;
  const mapping = resolveColumnMap(scenario.fileType, headers, scenario.columnMap);
  if (mapping.missing.length > 0) throw new Error(`Unmapped fields: ${mapping.missing.join(", ")}`);
  const version = await prisma.mappingVersion.create({
    data: {
      sourceId: sourceRow.id,
      fileType: scenario.fileType,
      versionNo: 1,
      headerSignature: "bench",
      columnMap: mapping.columnMap,
      ignoredColumns: [],
      origin: "MANUAL",
      status: "ACTIVE",
      createdById: user.id,
      approvedById: user.id,
      approvedAt: new Date(),
    },
  });
  await prisma.uploadedFile.update({
    where: { id: fileId },
    data: { status: "QUEUED", mappingVersionId: version.id },
  });
  const { id: jobId } = await prisma.processingJob.create({
    data: {
      type: "INGEST_FILE",
      entityType: "UPLOADED_FILE",
      entityId: fileId,
      params: { columnMap: mapping.columnMap },
      createdById: user.id,
    },
  });

  let job = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
  while (job.status === "QUEUED" || job.status === "RUNNING") {
    await new Promise((resolve) => setTimeout(resolve, 100));
    job = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
  }
  const wallMs = Math.round(performance.now() - startedAt);
  await worker.stop();

  const file = await prisma.uploadedFile.findUniqueOrThrow({ where: { id: fileId } });
  const reasons = await prisma.rejectedRow.groupBy({
    by: ["reasonCode"],
    where: { fileId },
    _count: { _all: true },
  });
  console.log(
    JSON.stringify(
      {
        scenario: name,
        fileMB: Number((statSync(source).size / 1_048_576).toFixed(1)),
        jobStatus: job.status,
        jobError: job.errorMessage,
        fileStatus: file.status,
        dataRowsInFile: file.detectedRowCount,
        accepted: file.rowsAccepted,
        rejected: file.rowsRejected,
        duplicate: file.rowsDuplicate,
        rejectedByReason: Object.fromEntries(reasons.map((r) => [r.reasonCode, r._count._all])),
        wallMs,
        stageTimingsMs: job.stageTimingsMs,
        peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
      },
      null,
      2,
    ),
  );
  await prisma.$disconnect();
}

const [command, argument] = process.argv.slice(2);
if (command === "prepare") prepare();
else if (command === "run" && argument) await run(argument);
else
  console.log(
    "Usage: tsx scripts/bench-ingest.ts prepare | run <orders-csv|orders-xlsx|freight-csv>",
  );
