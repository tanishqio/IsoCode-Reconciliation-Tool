// Part 6 and 7 end to end: rows already in the staging tables are linked to orders, the worker
// recalculates, and the orders API shows the result. The three sample rows of the assignment are
// in here, plus a tax add-back, a match by AWB, and a line that cannot be matched.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import type { Worker } from "../../../src/jobs/worker-loop.js";
import { call, signIn } from "../../helpers/auth-client.js";
import { startServer, type TestServer } from "../../helpers/server.js";
import { assertTestDatabase } from "../../helpers/test-db.js";

process.env["UPLOAD_DIR"] = process.env["UPLOAD_DIR"] ?? "storage/uploads";

const EXEC = { email: "exec@example.test", password: "executive-password-1" };
const FOUNDER = { email: "founder@example.test", password: "cofounder-password-1" };

let prisma: PrismaClient;
let server: TestServer;
let worker: Worker;
let base: string;
let exec: { cookie: string; csrf: string };
let ids: Record<string, string> = {};

beforeAll(async () => {
  prisma = (await import("../../../src/db/prisma.js")).prisma;
  const { createApp } = await import("../../../src/app.js");
  const { startWorker } = await import("../../../src/jobs/worker-loop.js");
  const { jobHandlers } = await import("../../../src/jobs/handlers.js");
  const { logger } = await import("../../../src/lib/logger.js");
  server = await startServer(createApp({ loginRateLimitMax: 10_000 }));
  base = server.baseUrl;
  worker = startWorker({
    handlers: jobHandlers,
    logger,
    pollIntervalMs: 50,
    heartbeatIntervalMs: 1000,
    staleAfterMs: 60_000,
  });
});

afterAll(async () => {
  await worker.stop();
  await server.close();
  await prisma.$disconnect();
});

const at = (text: string) => new Date(`${text}T00:00:00Z`);
let hashCounter = 0;
const hash = () => `h-${Date.now()}-${hashCounter++}`;

beforeEach(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]);
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "users", "uploaded_files", "upload_batches", "sources", "source_file_types", "processing_jobs", "order_results", "rate_cards" CASCADE',
  );
  const { seedSources } = await import("../../../src/db/seed-sources.js");
  const { seedUsers } = await import("../../../src/db/seed-users.js");
  const { seedRateCards } = await import("../../../src/db/seed-rate-cards.js");
  await seedSources(prisma);
  await (seedUsers as (c: PrismaClient, u: unknown[], cost: number) => Promise<void>)(
    prisma,
    [
      { ...EXEC, name: "Test Executive", role: "FINANCE_EXECUTIVE" },
      { ...FOUNDER, name: "Test Founder", role: "CO_FOUNDER" },
    ],
    4,
  );
  await seedRateCards(prisma);

  const source = async (name: string) =>
    (await prisma.source.findUniqueOrThrow({ where: { name } })).id;
  const user = await prisma.user.findUniqueOrThrow({ where: { email: EXEC.email } });
  const batch = await prisma.uploadBatch.create({ data: { uploadedById: user.id, fileCount: 1 } });
  const file = await prisma.uploadedFile.create({
    data: {
      batchId: batch.id,
      sourceId: await source("Website"),
      fileType: "ORDERS",
      originalName: "orders.csv",
      storagePath: "x/orders.csv",
      sizeBytes: 1n,
      format: "CSV",
      sha256: hash(),
      headerSignature: "x",
      status: "COMPLETED",
      uploadedById: user.id,
    },
  });
  ids = {
    website: await source("Website"),
    marketplace: await source("Marketplace 1"),
    aggregator: await source("Aggregator 1"),
    warehouse: await source("Warehouse"),
    file: file.id,
  };

  const line = (n: number) => ({
    sourceFileId: ids["file"] as string,
    sourceRowNumber: n,
    rowHash: hash(),
  });
  const order = (data: Record<string, unknown>) =>
    prisma.customerOrder.create({
      data: {
        ...line(2),
        orderDate: at("2026-11-01"),
        deliveredAt: at("2026-11-03"),
        weightGrams: 450,
        courierSourceId: ids["aggregator"],
        deliveryStatus: "Delivered",
        ...data,
      } as never,
    });

  // The three sample rows of the assignment.
  await order({
    orderId: "ORD-W-204118",
    channelSourceId: ids["website"],
    value: "1499",
    paymentType: "COD",
    awb: "AWB1",
  });
  await order({
    orderId: "ORD-M-88120",
    channelSourceId: ids["marketplace"],
    value: "1199",
    paymentType: "PREPAID",
    courierSourceId: null,
  });
  await order({
    orderId: "ORD-W-204377",
    channelSourceId: ids["website"],
    value: "2398",
    paymentType: "PREPAID",
    deliveryStatus: "Returned to warehouse",
    returnedAt: at("2026-11-05"),
    awb: "AWB3",
  });
  // A marketplace order paid net of TCS and TDS, and a COD order whose cash carries only the AWB.
  await order({
    orderId: "ORD-M-90001",
    channelSourceId: ids["marketplace"],
    value: "1199",
    paymentType: "PREPAID",
    courierSourceId: null,
  });
  await order({
    orderId: "ORD-W-300005",
    channelSourceId: ids["website"],
    value: "1499",
    paymentType: "COD",
    awb: "AWB5",
  });

  const settlement = (
    n: number,
    orderIdRaw: string,
    net: string,
    tcs = "0",
    tds = "0",
    date = "2026-11-30",
  ) =>
    prisma.settlementLine.create({
      data: {
        ...line(n),
        sourceId: ids["marketplace"] as string,
        orderIdRaw,
        settledOn: at(date),
        lineType: "SALE",
        netReceived: net,
        tcs,
        tds,
      },
    });
  await settlement(2, "ORD-M-88120", "862");
  await settlement(3, "ORD-M-90001", "850", "40", "9");
  await prisma.freightLine.create({
    data: {
      ...line(2),
      aggregatorSourceId: ids["aggregator"] as string,
      orderIdRaw: "ORD-W-204377",
      invoiceNo: "INV-1",
      chargeType: "REVERSE",
      billedAmount: "142",
      chargedOn: at("2026-11-06"),
    },
  });
  await prisma.returnScan.create({
    data: {
      ...line(2),
      warehouseSourceId: ids["warehouse"] as string,
      awb: "AWB3",
      scannedAt: at("2026-11-07"),
    },
  });
  const cod = (n: number, extra: Record<string, unknown>, amount: string) =>
    prisma.codRemittanceLine.create({
      data: {
        ...line(n),
        aggregatorSourceId: ids["aggregator"] as string,
        remittedOn: at("2026-11-10"),
        remittedAmount: amount,
        ...extra,
      },
    });
  await cod(2, { awb: "AWB5" }, "1409");
  await cod(3, { orderIdRaw: "ORD-UNKNOWN-1", awb: "AWB-NOBODY" }, "500");

  const login = await signIn(base, EXEC.email, EXEC.password);
  exec = { cookie: login.cookie, csrf: login.csrf };
});

async function recalculate() {
  const queued = await call(base, "POST", "/api/reconciliation/run", exec);
  expect(queued.status).toBe(202);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const job = await prisma.processingJob.findUniqueOrThrow({ where: { id: queued.data.jobId } });
    if (job.status === "SUCCEEDED") return;
    if (job.status === "FAILED") throw new Error(`Recalculation failed: ${job.errorMessage}`);
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type Row = {
  id: string;
  orderId: string;
  status: string;
  expected: string | null;
  received: string | null;
  difference: string | null;
  flags: string[];
};
const orders = async (query = "") =>
  (await call(base, "GET", `/api/orders?${query}`, exec)).data.items as Row[];

describe("matching and results", () => {
  it("works out the three sample rows, the tax add-back and the AWB match, and a loss is negative", async () => {
    await recalculate();
    const byId = Object.fromEntries((await orders()).map((row) => [row.orderId, row]));

    expect(byId["ORD-W-204118"]).toMatchObject({
      status: "UNPAID_PAST_DUE",
      expected: "1409.00",
      received: "0.00",
      difference: "-1409.00",
    });
    expect(byId["ORD-M-88120"]).toMatchObject({
      status: "SHORT_PAID",
      expected: "899.00",
      received: "862.00",
      difference: "-37.00",
    });
    expect(byId["ORD-W-204377"]).toMatchObject({
      status: "FREIGHT_OVERCHARGED",
      expected: "-96.00",
      received: "-142.00",
      difference: "-46.00",
    });
    expect(byId["ORD-M-90001"]).toMatchObject({
      status: "SETTLED",
      received: "899.00",
      difference: "0.00",
    });
    expect(byId["ORD-M-90001"]?.flags).toContain("TAX_ADDED_BACK");
    // Matched by AWB alone, no order ID on the cash line.
    expect(byId["ORD-W-300005"]).toMatchObject({ status: "SETTLED", received: "1409.00" });

    // The cash line that names nobody is left for the review queue, not guessed.
    const stray = await prisma.codRemittanceLine.findFirstOrThrow({
      where: { orderIdRaw: "ORD-UNKNOWN-1" },
    });
    expect(stray).toMatchObject({ orderPk: null, matchStatus: "UNMATCHED" });
  });

  it("lists, filters, sorts and summarises for both roles, and shows the evidence for one order", async () => {
    await recalculate();
    const summary = (await call(base, "GET", "/api/orders/summary", exec)).data;
    expect(summary.total).toBe(5);
    expect(summary.byStatus["SHORT_PAID"]).toEqual({ count: 1, difference: "-37.00" });
    // Four orders have at least one matched line; the first sample order has none (it is unpaid).
    expect(summary.matched).toBe(4);

    // Worst loss first by default.
    expect((await orders())[0]?.orderId).toBe("ORD-W-204118");
    expect((await orders("status=SETTLED")).map((r) => r.orderId).sort()).toEqual([
      "ORD-M-90001",
      "ORD-W-300005",
    ]);
    expect((await orders("q=88120")).map((r) => r.orderId)).toEqual(["ORD-M-88120"]);

    const returned = (await orders("q=204377"))[0] as Row;
    const detail = (await call(base, "GET", `/api/orders/${returned.id}`, exec)).data;
    expect(detail.working).toEqual([{ label: "Return delivery charge", amount: "-96.00" }]);
    expect(detail.received).toEqual([
      { label: "Return freight billed (deducted)", amount: "-142.00" },
    ]);
    expect(detail.lines.freight[0]).toMatchObject({
      amount: "142.00",
      chargeType: "REVERSE",
      file: "orders.csv",
    });
    expect(detail.lines.returnScans).toHaveLength(1);

    const founder = await signIn(base, FOUNDER.email, FOUNDER.password);
    const asFounder = { cookie: founder.cookie, csrf: founder.csrf };
    expect((await call(base, "GET", "/api/orders", asFounder)).status).toBe(200);
    expect((await call(base, "POST", "/api/reconciliation/run", asFounder)).status).toBe(403);
    expect((await call(base, "GET", "/api/orders", {})).status).toBe(401);
  });

  it("reports when results were calculated, against which date, and the rules used", async () => {
    await recalculate();
    const status = (await call(base, "GET", "/api/reconciliation/status", exec)).data;
    expect(status.orderCount).toBe(5);
    expect(status.job.status).toBe("SUCCEEDED");
    // Late is judged against the newest date in the uploaded data, not today.
    expect(status.asOf).toBe("2026-11-30T00:00:00.000Z");
    expect(status.settings).toMatchObject({
      tolerance: "10.00",
      codDueDays: 7,
      settlementDueDays: 14,
      returnWindowDays: 7,
      isSampleData: true,
    });
  });
});
