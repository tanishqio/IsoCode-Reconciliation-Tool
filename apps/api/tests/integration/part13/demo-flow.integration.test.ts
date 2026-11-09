// The whole flow, end to end, on a real database: generated sample files are uploaded through the API,
// their column mappings are approved, the worker reads them, the results are calculated, and the
// Part 11 dashboard and Part 12 audit trail are checked against what the generator knows to be true.
//
// The generator works out what every order SHOULD end up as with its own copy of the rules, so a
// difference below is either a bug in the matching engine or a rule the two disagree about.
import { rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import type { Worker } from "../../../src/jobs/worker-loop.js";
import { generateDataset, type GeneratedDataset } from "../../../src/tools/sample-data/generate.js";
import { loadDemoData, type LoadResult } from "../../../src/tools/sample-data/load-demo.js";
import { writeDataset } from "../../../src/tools/sample-data/write.js";
import { call, signIn } from "../../helpers/auth-client.js";
import { makeTempDir } from "../../helpers/part2-fixtures.js";
import { startServer, type TestServer } from "../../helpers/server.js";
import { assertTestDatabase } from "../../helpers/test-db.js";

const EXEC = { email: "exec-flow@example.test", password: "executive-password-1" };
const FOUNDER = { email: "founder-flow@example.test", password: "cofounder-password-1" };
const ORDERS = 400;

let prisma: PrismaClient;
let server: TestServer;
let worker: Worker;
let dataset: GeneratedDataset;
let dataDir: string;
let tempDir: string;
let uploadDir: string;
let first: LoadResult;
const logs: string[] = [];

beforeAll(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]);
  tempDir = makeTempDir("flow-temp");
  uploadDir = makeTempDir("flow-uploads");
  dataDir = makeTempDir("flow-data");
  process.env["UPLOAD_TEMP_DIR"] = tempDir;
  process.env["UPLOAD_DIR"] = uploadDir;

  prisma = (await import("../../../src/db/prisma.js")).prisma;
  const { createApp } = await import("../../../src/app.js");
  const { startWorker } = await import("../../../src/jobs/worker-loop.js");
  const { jobHandlers } = await import("../../../src/jobs/handlers.js");
  const { logger } = await import("../../../src/lib/logger.js");
  const { seedSources } = await import("../../../src/db/seed-sources.js");
  const { seedUsers } = await import("../../../src/db/seed-users.js");
  const { seedRateCards } = await import("../../../src/db/seed-rate-cards.js");

  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "users", "uploaded_files", "upload_batches", "sources", "source_file_types", "processing_jobs", "order_results", "rate_cards", "audit_logs", "reconciliation_settings" CASCADE',
  );
  await seedSources(prisma);
  await (seedUsers as (c: PrismaClient, u: unknown[], cost: number) => Promise<void>)(
    prisma,
    [
      { ...EXEC, name: "Flow Executive", role: "FINANCE_EXECUTIVE" },
      { ...FOUNDER, name: "Flow Founder", role: "CO_FOUNDER" },
    ],
    4,
  );
  await seedRateCards(prisma);

  server = await startServer(createApp({ loginRateLimitMax: 10_000, apiRateLimitMax: 100_000 }));
  worker = startWorker({
    handlers: jobHandlers,
    logger,
    pollIntervalMs: 50,
    heartbeatIntervalMs: 1000,
    staleAfterMs: 60_000,
  });

  dataset = generateDataset({ orders: ORDERS, seed: 2026 });
  writeDataset(dataset, dataDir);
  first = await loadDemoData({
    baseUrl: server.baseUrl,
    email: EXEC.email,
    password: EXEC.password,
    dir: dataDir,
    log: (message) => logs.push(message),
    timeoutMs: 120_000,
  });
}, 180_000);

afterAll(async () => {
  await worker?.stop();
  await server?.close();
  await prisma?.$disconnect();
  for (const dir of [tempDir, uploadDir, dataDir]) rmSync(dir, { recursive: true, force: true });
});

const cents = (text: string) => Math.round(Number(text) * 100);

describe("loading the sample files through the API", () => {
  it("uploads every file, approves one mapping per layout and leaves nothing for a person", () => {
    expect(first.files).toBe(dataset.files.length);
    expect(first.uploaded).toBe(dataset.files.length);
    expect(first.alreadyThere).toBe(0);
    expect(first.refused).toEqual([]);
    expect(first.needsAttention).toEqual([]);
    expect(first.mappingsApproved).toBe(dataset.files.length);
  });

  it("has the worker read every file without a failure", () => {
    const bad = first.finished.filter((file) => file.status === "FAILED");
    expect(bad).toEqual([]);
    expect(first.finished).toHaveLength(dataset.files.length);
  });

  it("saves every row of the files, dropping only the settlement rows that were written twice", async () => {
    const rejected = await prisma.rejectedRow.findMany({
      select: {
        reasonCode: true,
        message: true,
        rowNumber: true,
        file: { select: { originalName: true } },
      },
      take: 10,
    });
    expect(rejected).toEqual([]);

    const rowsOf = (type: string) =>
      dataset.files
        .filter((file) => file.fileType === type)
        .reduce((total, file) => total + file.rows, 0);
    expect(await prisma.customerOrder.count()).toBe(ORDERS);
    expect(await prisma.settlementLine.count()).toBe(
      rowsOf("SETTLEMENT") - dataset.summary.duplicateRows,
    );
    expect(await prisma.codRemittanceLine.count()).toBe(rowsOf("COD_REMITTANCE"));
    expect(await prisma.freightLine.count()).toBe(rowsOf("FREIGHT_INVOICE"));
    expect(await prisma.returnScan.count()).toBe(rowsOf("RETURN_SCAN"));

    const dropped = await prisma.uploadedFile.aggregate({ _sum: { rowsDuplicate: true } });
    expect(dropped._sum.rowsDuplicate).toBe(dataset.summary.duplicateRows);
  });

  it("leaves exactly the planted payment lines unmatched", async () => {
    const unmatched =
      (await prisma.settlementLine.count({ where: { orderPk: null } })) +
      (await prisma.codRemittanceLine.count({ where: { orderPk: null } }));
    expect(unmatched).toBe(dataset.summary.orphanLines);
  });

  it("calculated a result for every order", async () => {
    expect(first.calculation?.orderCount).toBe(ORDERS);
    expect(await prisma.orderResult.count()).toBe(ORDERS);
  });
});

describe("the matching engine against the generator's truth", () => {
  it("gives every order the status the generator expects", async () => {
    const results = await prisma.orderResult.findMany({
      select: {
        status: true,
        expected: true,
        received: true,
        difference: true,
        order: { select: { orderId: true, channel: { select: { name: true } } } },
      },
    });
    const byKey = new Map(
      results.map((row) => [`${row.order.channel.name}|${row.order.orderId}`, row]),
    );
    const mismatches: string[] = [];
    for (const truth of dataset.truth) {
      const actual = byKey.get(`${truth.channel}|${truth.orderId}`);
      if (!actual) {
        mismatches.push(`${truth.orderId}: no result`);
        continue;
      }
      const expected = actual.expected?.toFixed(2) ?? null;
      const difference = actual.difference?.toFixed(2) ?? null;
      if (
        actual.status !== truth.status ||
        expected !== truth.expected ||
        (truth.difference !== null && difference !== truth.difference)
      ) {
        mismatches.push(
          `${truth.orderId} [${truth.scenario}]: engine ${actual.status} exp=${expected} diff=${difference}; truth ${truth.status} exp=${truth.expected} diff=${truth.difference}`,
        );
      }
    }
    expect(
      mismatches.slice(0, 15),
      `${mismatches.length} of ${dataset.truth.length} differ`,
    ).toEqual([]);
    // A check that every order is "settled" on both sides would prove nothing, so make sure the
    // data really contains every kind of finding.
    const statuses = new Set(dataset.truth.map((order) => order.status));
    for (const status of [
      "SETTLED",
      "SHORT_PAID",
      "UNPAID_PAST_DUE",
      "FREIGHT_OVERCHARGED",
      "RETURN_NOT_RECEIVED",
      "NOT_TRACKED",
      "PENDING",
    ]) {
      expect(statuses.has(status), status).toBe(true);
    }
  });

  it("reproduces the three sample rows of the assignment", async () => {
    const result = (id: string) =>
      prisma.orderResult.findFirstOrThrow({ where: { order: { orderId: id } } });
    const unpaid = await result("ORD-W-204118");
    expect([unpaid.status, unpaid.expected?.toFixed(2), unpaid.received?.toFixed(2)]).toEqual([
      "UNPAID_PAST_DUE",
      "1409.00",
      "0.00",
    ]);
    const short = await result("ORD-M-88120");
    expect([
      short.status,
      short.expected?.toFixed(2),
      short.received?.toFixed(2),
      short.difference?.toFixed(2),
    ]).toEqual(["SHORT_PAID", "899.00", "862.00", "-37.00"]);
    const freight = await result("ORD-W-204377");
    expect([
      freight.status,
      freight.expected?.toFixed(2),
      freight.received?.toFixed(2),
      freight.difference?.toFixed(2),
    ]).toEqual(["FREIGHT_OVERCHARGED", "-96.00", "-142.00", "-46.00"]);
  });
});

describe("Part 11 dashboard against the generator's truth", () => {
  it("shows the money at risk the generator knows about, in total, by partner and by age", async () => {
    const founder = await signIn(server.baseUrl, FOUNDER.email, FOUNDER.password);
    const { status, data } = await call(server.baseUrl, "GET", "/api/dashboard/money-at-risk", {
      cookie: founder.cookie,
    });
    expect(status).toBe(200);
    expect(data.hasResults).toBe(true);
    expect(data.orderCount).toBe(ORDERS);

    const withProblem = dataset.truth.filter((order) => order.problem !== null);
    const cash = withProblem.filter((order) => order.problem !== "RETURN_NOT_RECEIVED");
    const expectedTotal = cash.reduce((sum, order) => sum + cents(order.cashAtRisk), 0);
    expect(cents(data.totals.cashAtRisk)).toBe(expectedTotal);
    expect(data.totals.orders).toBe(cash.length);

    const returns = withProblem.filter((order) => order.problem === "RETURN_NOT_RECEIVED");
    expect(data.totals.returnsNotReceived.orders).toBe(returns.length);
    expect(cents(data.totals.returnsNotReceived.orderValue)).toBe(
      returns.reduce((sum, order) => sum + cents(order.returnValue), 0),
    );

    for (const [type, key] of [
      ["SHORT_PAID", "shortPaid"],
      ["UNPAID_PAST_DUE", "unpaidPastDue"],
      ["FREIGHT_OVERCHARGED", "freightOvercharged"],
    ] as const) {
      const group = cash.filter((order) => order.problem === type);
      expect(data.totals.byType[key].orders, type).toBe(group.length);
      expect(cents(data.totals.byType[key].amount), type).toBe(
        group.reduce((sum, order) => sum + cents(order.cashAtRisk), 0),
      );
    }

    for (let band = 0; band < 4; band += 1) {
      const group = cash.filter((order) => order.ageBand === band);
      expect(cents(data.totals.byAge[band].amount), `age band ${band}`).toBe(
        group.reduce((sum, order) => sum + cents(order.cashAtRisk), 0),
      );
    }

    const expectedByPartner = new Map<string, number>();
    for (const order of cash) {
      const partner = order.riskPartner as string;
      expectedByPartner.set(
        partner,
        (expectedByPartner.get(partner) ?? 0) + cents(order.cashAtRisk),
      );
    }
    const actualByPartner = new Map<string, number>(
      data.partners
        .filter((partner: { cashAtRisk: string }) => cents(partner.cashAtRisk) > 0)
        .map((partner: { name: string; cashAtRisk: string }) => [
          partner.name,
          cents(partner.cashAtRisk),
        ]),
    );
    expect(Object.fromEntries(actualByPartner)).toEqual(Object.fromEntries(expectedByPartner));
  });

  it("shows TCS and TDS for each partner exactly as generated", async () => {
    const exec = await signIn(server.baseUrl, EXEC.email, EXEC.password);
    const { data } = await call(server.baseUrl, "GET", "/api/dashboard/tax-summary", {
      cookie: exec.cookie,
    });
    const expectedByPartner = new Map<string, { lines: number; tcs: number; tds: number }>();
    for (const entry of dataset.summary.tax) {
      const total = expectedByPartner.get(entry.partner) ?? { lines: 0, tcs: 0, tds: 0 };
      total.lines += entry.lines;
      total.tcs += cents(entry.tcs);
      total.tds += cents(entry.tds);
      expectedByPartner.set(entry.partner, total);
    }
    const actual = Object.fromEntries(
      data.partners.map((partner: { name: string; lines: number; tcs: string; tds: string }) => [
        partner.name,
        { lines: partner.lines, tcs: cents(partner.tcs), tds: cents(partner.tds) },
      ]),
    );
    expect(actual).toEqual(Object.fromEntries(expectedByPartner));
    expect(data.totals.lines).toBe(
      dataset.summary.tax.reduce((sum, entry) => sum + entry.lines, 0),
    );

    const month = data.months[0];
    const oneMonth = await call(
      server.baseUrl,
      "GET",
      `/api/dashboard/tax-summary?month=${month}`,
      {
        cookie: exec.cookie,
      },
    );
    const expectedMonthLines = dataset.summary.tax
      .filter((entry) => entry.month === month)
      .reduce((sum, entry) => sum + entry.lines, 0);
    expect(oneMonth.data.totals.lines).toBe(expectedMonthLines);
  });
});

describe("Part 12 audit trail for the same session of work", () => {
  it("recorded the sign-in, every upload, every mapping approval and the calculation", async () => {
    const wanted = 1 + first.uploaded + first.mappingsApproved + 1;
    const deadline = Date.now() + 5000;
    let rows = await prisma.auditLog.findMany();
    while (rows.length < wanted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      rows = await prisma.auditLog.findMany();
    }
    const count = (action: string) => rows.filter((row) => row.action === action).length;
    expect(count("UPLOAD")).toBe(first.uploaded);
    expect(count("MAPPING_APPROVED")).toBe(first.mappingsApproved);
    expect(count("RECONCILIATION_RUN")).toBeGreaterThanOrEqual(1);
    expect(count("LOGIN")).toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(".csv");
    expect(text).not.toContain("example.test");
  });
});

describe("loading the same folder again", () => {
  it("is safe: every file is reported as already there and nothing is added", async () => {
    const before = {
      orders: await prisma.customerOrder.count(),
      lines: await prisma.settlementLine.count(),
      files: await prisma.uploadedFile.count(),
    };
    const second = await loadDemoData({
      baseUrl: server.baseUrl,
      email: EXEC.email,
      password: EXEC.password,
      dir: dataDir,
      timeoutMs: 60_000,
    });
    expect(second.uploaded).toBe(0);
    expect(second.alreadyThere).toBe(dataset.files.length);
    expect(second.mappingsApproved).toBe(0);
    expect(await prisma.customerOrder.count()).toBe(before.orders);
    expect(await prisma.settlementLine.count()).toBe(before.lines);
    expect(await prisma.uploadedFile.count()).toBe(before.files);
    expect(path.basename(dataDir).length).toBeGreaterThan(0);
  }, 120_000);
});
