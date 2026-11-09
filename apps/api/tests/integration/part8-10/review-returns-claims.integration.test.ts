// Parts 8, 9 and 10 end to end, on top of the results of Part 6: lines that could not be matched
// get suggestions that only a person can accept, the returns tracker shows what reached the
// warehouse, and the problem orders become claims by partner with an evidence export.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import type { Worker } from "../../../src/jobs/worker-loop.js";
import { call, signIn } from "../../helpers/auth-client.js";
import { startServer, type TestServer } from "../../helpers/server.js";
import { assertTestDatabase } from "../../helpers/test-db.js";

const EXEC = { email: "exec@example.test", password: "executive-password-1" };
const FOUNDER = { email: "founder@example.test", password: "cofounder-password-1" };

let prisma: PrismaClient;
let server: TestServer;
let worker: Worker;
let base: string;
let exec: { cookie: string; csrf: string };
let founder: { cookie: string; csrf: string };
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

async function waitForIdle() {
  const deadline = Date.now() + 30_000;
  let quiet = 0;
  while (Date.now() < deadline) {
    const open = await prisma.processingJob.count({
      where: { status: { in: ["QUEUED", "RUNNING"] } },
    });
    quiet = open === 0 ? quiet + 1 : 0;
    if (quiet >= 3) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error("The worker did not become idle in time.");
}

// Every action queues more jobs; let the worker finish before the next test empties the tables.
afterEach(waitForIdle);

afterAll(async () => {
  await worker.stop();
  await server.close();
  await prisma.$disconnect();
});

const at = (text: string) => new Date(`${text}T00:00:00Z`);
let hashCounter = 0;
const hash = () => `h8-${Date.now()}-${hashCounter++}`;

beforeEach(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]);
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "users", "uploaded_files", "upload_batches", "sources", "source_file_types", "processing_jobs", "order_results", "rate_cards", "claims", "match_suggestions", "audit_logs" CASCADE',
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
  const web = (orderId: string, extra: Record<string, unknown>) =>
    order({ orderId, channelSourceId: ids["website"], ...extra });
  const market = (orderId: string, extra: Record<string, unknown> = {}) =>
    order({
      orderId,
      channelSourceId: ids["marketplace"],
      paymentType: "PREPAID",
      value: "1199",
      courierSourceId: null,
      ...extra,
    });

  // The three sample rows, plus orders for the review queue, the returns tracker and the claims.
  await web("ORD-W-204118", { value: "1499", paymentType: "COD", awb: "AWB1" });
  await market("ORD-M-88120");
  await web("ORD-W-204377", {
    value: "2398",
    paymentType: "PREPAID",
    deliveryStatus: "Returned to warehouse",
    returnedAt: at("2026-11-05"),
    awb: "AWB3",
  });
  await web("ORD-W-300004", { value: "1599", paymentType: "COD", awb: "AWB4" });
  await web("ORD-W-300006", {
    value: "999",
    paymentType: "PREPAID",
    deliveryStatus: "Returned",
    returnedAt: at("2026-10-01"),
    awb: "AWB6",
  });
  await web("ORD-W-300007", {
    value: "999",
    paymentType: "PREPAID",
    deliveryStatus: "Returned",
    returnedAt: at("2026-11-28"),
    awb: "AWB7",
  });
  await market("ORD-M-90010");

  await prisma.settlementLine.create({
    data: {
      ...line(2),
      sourceId: ids["marketplace"] as string,
      orderIdRaw: "ORD-M-88120",
      settledOn: at("2026-11-30"),
      lineType: "SALE",
      netReceived: "862",
    },
  });
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
  // Two lines nobody can place by ID: a COD payment with no ID at all, and a payout with a typo.
  await prisma.codRemittanceLine.create({
    data: {
      ...line(2),
      aggregatorSourceId: ids["aggregator"] as string,
      remittanceRef: "UTR-ORPHAN-1",
      remittedOn: at("2026-11-10"),
      remittedAmount: "1509",
    },
  });
  await prisma.settlementLine.create({
    data: {
      ...line(3),
      sourceId: ids["marketplace"] as string,
      orderIdRaw: "ORD-M-9OO10",
      settledOn: at("2026-11-20"),
      lineType: "SALE",
      netReceived: "899",
    },
  });

  const login = await signIn(base, EXEC.email, EXEC.password);
  exec = { cookie: login.cookie, csrf: login.csrf };
  const other = await signIn(base, FOUNDER.email, FOUNDER.password);
  founder = { cookie: other.cookie, csrf: other.csrf };
});

async function runPipeline() {
  const queued = await call(base, "POST", "/api/reconciliation/run", exec);
  expect(queued.status).toBe(202);
  await waitForIdle();
}

type Suggestion = {
  id: string;
  score: number;
  origin: string;
  reasons: string[];
  order: { orderId: string };
};
type QueueItem = {
  lineKind: string;
  lineId: string;
  amount: string | null;
  suggestions: Suggestion[];
};
const queue = async (view = "suggested") =>
  (await call(base, "GET", `/api/review/queue?view=${view}`, exec)).data as {
    total: number;
    items: QueueItem[];
  };

describe("Part 8: the review queue", () => {
  it("suggests the right order for a line with no usable ID, and only a person can accept it", async () => {
    await runPipeline();

    const { items } = await queue();
    const cod = items.find((item) => item.lineKind === "COD_REMITTANCE") as QueueItem;
    const payout = items.find((item) => item.lineKind === "SETTLEMENT") as QueueItem;
    expect(cod.suggestions[0]).toMatchObject({
      order: { orderId: "ORD-W-300004" },
      origin: "RULES",
    });
    expect(cod.suggestions[0]?.score).toBeGreaterThanOrEqual(75);
    expect(cod.suggestions[0]?.reasons.join(" ")).toContain(
      "amount equals the expected amount exactly",
    );
    expect(payout.suggestions[0]).toMatchObject({ order: { orderId: "ORD-M-90010" } });
    expect(payout.suggestions[0]?.reasons.join(" ")).toContain("The ID differs by 2 characters");

    // Nothing closed by itself: both lines are still unmatched and the order still unpaid.
    const line = await prisma.codRemittanceLine.findFirstOrThrow({
      where: { remittanceRef: "UTR-ORPHAN-1" },
    });
    expect(line).toMatchObject({ orderPk: null, matchStatus: "UNMATCHED" });
    const before = (await call(base, "GET", "/api/orders?q=300004", exec)).data.items[0];
    expect(before).toMatchObject({ status: "UNPAID_PAST_DUE", difference: "-1509.00" });

    // The person accepts the COD one and rejects the payout one.
    const accepted = await call(
      base,
      "POST",
      `/api/review/suggestions/${cod.suggestions[0]?.id}/accept`,
      exec,
    );
    expect(accepted.status).toBe(200);
    const rejected = await call(
      base,
      "POST",
      `/api/review/suggestions/${payout.suggestions[0]?.id}/reject`,
      exec,
    );
    expect(rejected.status).toBe(200);
    await waitForIdle();

    expect(
      await prisma.codRemittanceLine.findUniqueOrThrow({ where: { id: line.id } }),
    ).toMatchObject({ matchStatus: "ACCEPTED" });
    const after = (await call(base, "GET", "/api/orders?q=300004", exec)).data.items[0];
    expect(after).toMatchObject({ status: "SETTLED", received: "1509.00", difference: "0.00" });
    const result = await prisma.orderResult.findFirstOrThrow({
      where: { order: { orderId: "ORD-W-300004" } },
    });
    expect(result.matchMethod).toBe("REVIEW_ACCEPTED");

    // A rejected suggestion does not come back, and a decided one cannot be decided twice.
    await call(base, "POST", "/api/review/run", exec);
    await waitForIdle();
    const again = await queue();
    expect(again.items.find((item) => item.lineKind === "SETTLEMENT")).toBeUndefined();
    expect(
      (await call(base, "POST", `/api/review/suggestions/${cod.suggestions[0]?.id}/accept`, exec))
        .status,
    ).toBe(409);

    // The rejected payout line is still visible, as a line no one has placed.
    const none = await queue("none");
    expect(
      none.items.some((item) => item.lineKind === "SETTLEMENT" && item.amount === "899.00"),
    ).toBe(true);

    // The audit trail has both decisions, and the co-founder cannot reach the queue.
    const actions = (await prisma.auditLog.findMany({ select: { action: true } })).map(
      (row) => row.action,
    );
    expect(actions).toEqual(expect.arrayContaining(["MATCH_ACCEPTED", "MATCH_REJECTED"]));
    expect((await call(base, "GET", "/api/review/queue", founder)).status).toBe(403);
  });
});

describe("Part 9: the returns tracker", () => {
  it("separates returns that arrived, returns that are missing and returns still on their way", async () => {
    await runPipeline();
    const summary = (await call(base, "GET", "/api/returns/summary", founder)).data;
    expect(summary.received.orders).toBe(1);
    expect(summary.notReceived).toEqual({ orders: 1, value: "999.00" });
    expect(summary.waiting.orders).toBe(1);

    const missing = (await call(base, "GET", "/api/returns?state=NOT_RECEIVED", exec)).data;
    expect(missing.items.map((row: { orderId: string }) => row.orderId)).toEqual(["ORD-W-300006"]);
    expect(missing.items[0]).toMatchObject({ state: "NOT_RECEIVED", daysSince: 60 });

    const all = (await call(base, "GET", "/api/returns", exec)).data;
    expect(all.items.map((row: { state: string }) => row.state)).toEqual([
      "NOT_RECEIVED",
      "WAITING",
      "RECEIVED",
    ]);
    expect(all.items[2]).toMatchObject({
      orderId: "ORD-W-204377",
      scannedAt: "2026-11-07T00:00:00.000Z",
    });
  });
});

describe("Part 10: claims and the evidence export", () => {
  it("builds one claim per partner from the problem orders, and the export proves each one", async () => {
    await runPipeline();
    const summary = (await call(base, "GET", "/api/claims/summary", founder)).data;
    const claims = (await call(base, "GET", "/api/claims", founder)).data.items as {
      id: string;
      label: string;
      partner: { name: string };
      itemCount: number;
      total: string;
      status: string;
    }[];
    const byPartner = Object.fromEntries(claims.map((claim) => [claim.partner.name, claim]));

    // COD, freight and returns are the courier's; payouts are the channel's.
    expect(byPartner["Aggregator 1"]).toMatchObject({
      itemCount: 4,
      total: "3963.00",
      status: "OPEN",
    });
    expect(byPartner["Marketplace 1"]).toMatchObject({ itemCount: 2, total: "936.00" });
    expect(summary.open).toMatchObject({ claims: 2, orders: 6, total: "4899.00" });

    const marketplace = byPartner["Marketplace 1"] as (typeof claims)[number];
    const detail = (await call(base, "GET", `/api/claims/${marketplace.id}`, founder)).data;
    expect(
      detail.items.map((item: { orderId: string; amount: string }) => [item.orderId, item.amount]),
    ).toEqual([
      ["ORD-M-90010", "899.00"],
      ["ORD-M-88120", "37.00"],
    ]);

    // The evidence of the short-paid order: the working, the payout and the file and row.
    const shortPaid = detail.items.find(
      (item: { orderId: string }) => item.orderId === "ORD-M-88120",
    );
    const item = (await call(base, "GET", `/api/claims/items/${shortPaid.id}`, founder)).data;
    expect(item.evidence.working.at(-1)).toEqual({
      label: "Delivery charge (any weight)",
      amount: "-35.20",
    });
    expect(item.evidence.result).toMatchObject({
      expected: "899.00",
      received: "862.00",
      difference: "-37.00",
    });
    expect(item.evidence.lines[0]).toMatchObject({
      kind: "Settlement",
      amount: "862.00",
      file: "orders.csv",
      row: 2,
    });

    // Only the executive exports. The file is a CSV with one row per order, and the claim is frozen.
    expect((await call(base, "POST", `/api/claims/${marketplace.id}/export`, founder)).status).toBe(
      403,
    );
    const exported = await call(base, "POST", `/api/claims/${marketplace.id}/export`, exec);
    expect(exported.status).toBe(200);
    expect(exported.data).toMatchObject({ itemCount: 2, total: "936.00", status: "EXPORTED" });
    const csv = exported.data.csv as string;
    expect(csv.startsWith("\uFEFF")).toBe(true);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"ORD-M-90010"');
    expect(lines[2]).toContain('"ORD-M-88120",');
    expect(lines[2]).toContain("37.00,899.00,862.00,-37.00");
    expect(lines[2]).toContain("orders.csv, row 2");

    // A rebuild keeps the exported claim as it was and does not claim the same orders twice.
    await call(base, "POST", "/api/claims/rebuild", exec);
    await waitForIdle();
    const after = (await call(base, "GET", "/api/claims?partnerId=" + ids["marketplace"], exec))
      .data.items;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: "EXPORTED", itemCount: 2, total: "936.00" });

    // Recording what came back is limited to the executive, and to the claim's own amount.
    const status = (body: unknown, who = exec) =>
      call(base, "POST", `/api/claims/${marketplace.id}/status`, { ...who, json: body });
    expect((await status({ status: "RECOVERED", recovered: "5000" })).status).toBe(422);
    expect((await status({ status: "RECOVERED", recovered: "100" }, founder)).status).toBe(403);
    expect((await status({ status: "RECOVERED", recovered: "900" })).data).toMatchObject({
      status: "RECOVERED",
      recovered: "900.00",
    });
    const done = (await call(base, "GET", "/api/claims/summary", exec)).data;
    expect(done.recovered).toMatchObject({ claims: 1, recovered: "900.00" });

    const actions = (await prisma.auditLog.findMany({ select: { action: true } })).map(
      (row) => row.action,
    );
    expect(actions).toEqual(expect.arrayContaining(["CLAIM_EXPORTED", "CLAIM_STATUS_CHANGED"]));
  });

  it("drops an order from an open claim once it has been paid", async () => {
    await runPipeline();
    const { items } = await queue();
    const cod = items.find((entry) => entry.lineKind === "COD_REMITTANCE") as QueueItem;
    await call(base, "POST", `/api/review/suggestions/${cod.suggestions[0]?.id}/accept`, exec);
    await waitForIdle();
    const claims = (await call(base, "GET", "/api/claims", exec)).data.items as {
      partner: { name: string };
      itemCount: number;
      total: string;
    }[];
    expect(claims.find((claim) => claim.partner.name === "Aggregator 1")).toMatchObject({
      itemCount: 3,
      total: "2454.00",
    });
  });
});
