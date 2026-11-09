// Part 11 against a real database: the money-at-risk numbers and the TCS/TDS summary are checked
// against figures worked out by hand from rows written straight into the tables. The matching
// engine (Part 6) is not involved, so a change there cannot hide a mistake here.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { call, signIn } from "../../helpers/auth-client.js";
import { startServer, type TestServer } from "../../helpers/server.js";
import { assertTestDatabase } from "../../helpers/test-db.js";

const EXEC = { email: "exec-p11@example.test", password: "executive-password-1" };
const FOUNDER = { email: "founder-p11@example.test", password: "cofounder-password-1" };
const DAY_MS = 24 * 60 * 60 * 1000;
const AS_OF = new Date("2026-11-30T00:00:00Z");
const daysBefore = (days: number) => new Date(AS_OF.getTime() - days * DAY_MS);

let prisma: PrismaClient;
let server: TestServer;
let exec: { cookie: string; csrf: string };
let founder: { cookie: string; csrf: string };
let sourceIds: Record<string, string> = {};
let fileId = "";
let counter = 0;
const next = () => `h-${Date.now()}-${counter++}`;

beforeAll(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]);
  prisma = (await import("../../../src/db/prisma.js")).prisma;
  const { createApp } = await import("../../../src/app.js");
  server = await startServer(createApp({ loginRateLimitMax: 10_000, apiRateLimitMax: 100_000 }));
});

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]);
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "users", "uploaded_files", "upload_batches", "sources", "source_file_types", "processing_jobs", "order_results", "rate_cards", "audit_logs", "reconciliation_settings" CASCADE',
  );
  const { seedSources } = await import("../../../src/db/seed-sources.js");
  const { seedUsers } = await import("../../../src/db/seed-users.js");
  await seedSources(prisma);
  await (seedUsers as (c: PrismaClient, u: unknown[], cost: number) => Promise<void>)(
    prisma,
    [
      { ...EXEC, name: "Test Executive", role: "FINANCE_EXECUTIVE" },
      { ...FOUNDER, name: "Test Founder", role: "CO_FOUNDER" },
    ],
    4,
  );
  sourceIds = Object.fromEntries(
    (await prisma.source.findMany()).map((source) => [source.name, source.id]),
  );
  const user = await prisma.user.findUniqueOrThrow({ where: { email: EXEC.email } });
  const batch = await prisma.uploadBatch.create({ data: { uploadedById: user.id, fileCount: 1 } });
  fileId = (
    await prisma.uploadedFile.create({
      data: {
        batchId: batch.id,
        sourceId: sourceIds["Website"] as string,
        fileType: "ORDERS",
        originalName: "orders.csv",
        storagePath: "x/orders.csv",
        sizeBytes: 1n,
        format: "CSV",
        sha256: next(),
        headerSignature: "x",
        status: "COMPLETED",
        uploadedById: user.id,
      },
    })
  ).id;
  exec = await signIn(server.baseUrl, EXEC.email, EXEC.password);
  founder = await signIn(server.baseUrl, FOUNDER.email, FOUNDER.password);
});

interface Fixture {
  channel: string;
  courier?: string | null;
  paymentType?: "COD" | "PREPAID";
  value?: string;
  status: string;
  difference?: string | null;
  freightBilled?: string;
  freightExpected?: string | null;
  dueDaysAgo?: number | null;
  deliveredDaysAgo?: number;
  deliveryStatus?: string;
}

let rowNumber = 1;
async function addResult(fixture: Fixture): Promise<void> {
  rowNumber += 1;
  const courier = fixture.courier === undefined ? "Aggregator 1" : fixture.courier;
  const order = await prisma.customerOrder.create({
    data: {
      sourceFileId: fileId,
      sourceRowNumber: rowNumber,
      rowHash: next(),
      orderId: `ORD-${rowNumber}`,
      channelSourceId: sourceIds[fixture.channel] as string,
      courierSourceId: courier ? (sourceIds[courier] as string) : null,
      orderDate: daysBefore((fixture.deliveredDaysAgo ?? 5) + 3),
      deliveredAt: daysBefore(fixture.deliveredDaysAgo ?? 5),
      value: fixture.value ?? "1000",
      paymentType: fixture.paymentType ?? "PREPAID",
      deliveryStatus: fixture.deliveryStatus ?? "Delivered",
    },
  });
  await prisma.orderResult.create({
    data: {
      orderPk: order.id,
      status: fixture.status as never,
      difference: fixture.difference ?? null,
      freightBilled: fixture.freightBilled ?? "0",
      freightExpected: fixture.freightExpected ?? null,
      dueDate: fixture.dueDaysAgo == null ? null : daysBefore(fixture.dueDaysAgo),
      asOf: AS_OF,
      flags: [],
      lineCounts: {},
      matchMethod: "EXACT",
    },
  });
}

async function addSettlement(
  source: string,
  settledOn: string,
  tcs: string,
  tds: string,
  options: { orderPk?: string | null; net?: string } = {},
): Promise<void> {
  rowNumber += 1;
  await prisma.settlementLine.create({
    data: {
      sourceFileId: fileId,
      sourceRowNumber: rowNumber,
      rowHash: next(),
      sourceId: sourceIds[source] as string,
      lineRef: `L-${rowNumber}`,
      orderIdRaw: `RAW-${rowNumber}`,
      orderPk: options.orderPk ?? null,
      settledOn: new Date(settledOn),
      lineType: "SALE",
      netReceived: options.net ?? "900",
      tcs,
      tds,
    },
  });
}

async function riskFixtures(): Promise<void> {
  // 1. Website cash-on-delivery order, never remitted: Aggregator 1 owes 1409, 45 days old.
  await addResult({
    channel: "Website",
    paymentType: "COD",
    value: "1499",
    status: "UNPAID_PAST_DUE",
    difference: "-1409.00",
    dueDaysAgo: 45,
  });
  // 2. Marketplace 1 paid 37 too little, 10 days old.
  await addResult({
    channel: "Marketplace 1",
    courier: null,
    status: "SHORT_PAID",
    difference: "-37.00",
    dueDaysAgo: 10,
  });
  // 3. Returned order, courier billed 142 against 96: 46 over, no due date, delivered 100 days ago.
  await addResult({
    channel: "Website",
    status: "FREIGHT_OVERCHARGED",
    difference: "-46.00",
    freightBilled: "142",
    freightExpected: "96",
    deliveredDaysAgo: 100,
    deliveryStatus: "Returned to warehouse",
  });
  // 4. Returned order that never reached the warehouse (valued at its selling price, 2398).
  await addResult({
    channel: "Website",
    value: "2398",
    status: "RETURN_NOT_RECEIVED",
    difference: "96.00",
    dueDaysAgo: 5,
    deliveryStatus: "Returned to warehouse",
  });
  // 5. Marketplace 2 short by 100.50, 75 days old.
  await addResult({
    channel: "Marketplace 2",
    courier: null,
    status: "SHORT_PAID",
    difference: "-100.50",
    dueDaysAgo: 75,
  });
  // 6. Marketplace 3: amounts 1 to 6 rupees, aged exactly on the band edges 30, 31, 60, 61, 90, 91.
  for (const [index, age] of [30, 31, 60, 61, 90, 91].entries()) {
    await addResult({
      channel: "Marketplace 3",
      courier: null,
      status: "SHORT_PAID",
      difference: `-${index + 1}.00`,
      dueDaysAgo: age,
    });
  }
  // 7. Freight overcharge with no expected freight on file: falls back to the difference (30).
  // No due date, so the age counts from delivery (29 days), not from the order date (32 days).
  await addResult({
    channel: "Website",
    courier: "Aggregator 2",
    status: "FREIGHT_OVERCHARGED",
    difference: "-30.00",
    freightBilled: "90",
    freightExpected: null,
    deliveredDaysAgo: 29,
  });
  // 8. A cash-on-delivery order with no courier: the Website is the partner.
  await addResult({
    channel: "Website",
    courier: null,
    paymentType: "COD",
    status: "UNPAID_PAST_DUE",
    difference: "-500.00",
    dueDaysAgo: 1,
  });
  // Not money at risk: counted only under "not included".
  await addResult({
    channel: "Marketplace 1",
    courier: null,
    status: "OVERPAID",
    difference: "50.00",
  });
  await addResult({ channel: "Marketplace 1", courier: null, status: "PENDING" });
  await addResult({ channel: "Marketplace 1", courier: null, status: "CANNOT_CALCULATE" });
  await addResult({
    channel: "Marketplace 1",
    courier: null,
    status: "SETTLED",
    difference: "0.00",
  });
  await addResult({ channel: "Website", courier: null, status: "NOT_TRACKED" });
}

const getRisk = (who = exec) =>
  call(server.baseUrl, "GET", "/api/dashboard/money-at-risk", { cookie: who.cookie });

describe("GET /api/dashboard/money-at-risk", () => {
  it("is closed to guests and open to both roles", async () => {
    expect((await call(server.baseUrl, "GET", "/api/dashboard/money-at-risk")).status).toBe(401);
    expect((await getRisk(exec)).status).toBe(200);
    expect((await getRisk(founder)).status).toBe(200);
  });

  it("says there are no results yet when the results table is empty", async () => {
    const { data } = await getRisk();
    expect(data.hasResults).toBe(false);
    expect(data.orderCount).toBe(0);
    expect(data.asOf).toBeNull();
    expect(data.partners).toEqual([]);
    expect(data.totals.cashAtRisk).toBe("0.00");
    expect(data.totals.orders).toBe(0);
    expect(data.totals.returnsNotReceived).toEqual({ orders: 0, orderValue: "0.00" });
    expect(data.ageBuckets).toHaveLength(4);
  });

  it("adds up the cash at risk exactly, by problem and by age", async () => {
    await riskFixtures();
    const { data } = await getRisk();

    expect(data.hasResults).toBe(true);
    expect(data.orderCount).toBe(18);
    expect(data.asOf).toBe(AS_OF.toISOString());
    expect(data.totals.cashAtRisk).toBe("2143.50");
    expect(data.totals.orders).toBe(12);
    expect(data.totals.byType).toEqual({
      shortPaid: { orders: 8, amount: "158.50" },
      unpaidPastDue: { orders: 2, amount: "1909.00" },
      freightOvercharged: { orders: 2, amount: "76.00" },
    });
    expect(data.totals.byAge).toEqual([
      { key: "0-30", amount: "568.00", orders: 4 },
      { key: "31-60", amount: "1414.00", orders: 3 },
      { key: "61-90", amount: "109.50", orders: 3 },
      { key: "90+", amount: "52.00", orders: 2 },
    ]);
    expect(data.totals.returnsNotReceived).toEqual({ orders: 1, orderValue: "2398.00" });
  });

  it("puts the edge ages in the right bands (30 | 31, 60 | 61, 90 | 91)", async () => {
    await riskFixtures();
    const { data } = await getRisk();
    const marketplace3 = data.partners.find(
      (partner: { name: string }) => partner.name === "Marketplace 3",
    );
    expect(marketplace3.cashAtRisk).toBe("21.00");
    expect(marketplace3.byAge.map((band: { amount: string }) => band.amount)).toEqual([
      "1.00",
      "5.00",
      "9.00",
      "6.00",
    ]);
  });

  it("gives each money amount to the partner that owes it, biggest first", async () => {
    await riskFixtures();
    const { data } = await getRisk();
    const summary = data.partners.map(
      (partner: { name: string; cashAtRisk: string; orders: number }) => [
        partner.name,
        partner.cashAtRisk,
        partner.orders,
      ],
    );
    expect(summary).toEqual([
      ["Aggregator 1", "1455.00", 2],
      ["Website", "500.00", 1],
      ["Marketplace 2", "100.50", 1],
      ["Marketplace 1", "37.00", 1],
      ["Aggregator 2", "30.00", 1],
      ["Marketplace 3", "21.00", 6],
    ]);
    const aggregator1 = data.partners[0];
    expect(aggregator1.byType.unpaidPastDue).toEqual({ orders: 1, amount: "1409.00" });
    expect(aggregator1.byType.freightOvercharged).toEqual({ orders: 1, amount: "46.00" });
    expect(aggregator1.returnsNotReceived).toEqual({ orders: 1, orderValue: "2398.00" });
    expect(aggregator1.kind).toBe("COURIER_AGGREGATOR");
  });

  it("makes the partner rows add up to the totals", async () => {
    await riskFixtures();
    const { data } = await getRisk();
    const cents = (text: string) => Math.round(Number(text) * 100);
    const sum = (values: string[]) => values.reduce((total, value) => total + cents(value), 0);
    expect(sum(data.partners.map((p: { cashAtRisk: string }) => p.cashAtRisk))).toBe(
      cents(data.totals.cashAtRisk),
    );
    for (let band = 0; band < 4; band += 1) {
      expect(
        sum(
          data.partners.map((p: { byAge: { amount: string }[] }) => p.byAge[band]?.amount ?? "0"),
        ),
      ).toBe(cents(data.totals.byAge[band].amount));
    }
    expect(data.partners.reduce((n: number, p: { orders: number }) => n + p.orders, 0)).toBe(
      data.totals.orders,
    );
  });

  it("counts the orders that are not money at risk, separately", async () => {
    await riskFixtures();
    const { data } = await getRisk();
    expect(data.notIncluded).toEqual({
      pending: 1,
      cannotCalculate: 1,
      notTracked: 1,
      overpaid: 1,
      settled: 1,
    });
  });

  it("shows only the problems when the data has none of the risk statuses", async () => {
    await addResult({
      channel: "Marketplace 1",
      courier: null,
      status: "SETTLED",
      difference: "0.00",
    });
    const { data } = await getRisk();
    expect(data.hasResults).toBe(true);
    expect(data.partners).toEqual([]);
    expect(data.totals.cashAtRisk).toBe("0.00");
  });

  it("reports whether the due-date rules are sample values", async () => {
    await riskFixtures();
    expect((await getRisk()).data.settingsAreSample).toBe(true);
    await prisma.reconciliationSettings.upsert({
      where: { id: 1 },
      update: { isSampleData: false },
      create: { id: 1, isSampleData: false },
    });
    expect((await getRisk()).data.settingsAreSample).toBe(false);
  });

  it("counts a loss only from the result table, not twice when orders have several lines", async () => {
    await addResult({
      channel: "Marketplace 1",
      courier: null,
      status: "SHORT_PAID",
      difference: "-12.34",
      dueDaysAgo: 3,
    });
    const order = await prisma.customerOrder.findFirstOrThrow();
    await addSettlement("Marketplace 1", "2026-11-10T00:00:00Z", "0", "0", { orderPk: order.id });
    await addSettlement("Marketplace 1", "2026-11-11T00:00:00Z", "0", "0", { orderPk: order.id });
    const { data } = await getRisk();
    expect(data.totals.cashAtRisk).toBe("12.34");
    expect(data.totals.orders).toBe(1);
  });

  it("never shows a negative amount at risk, even for odd data", async () => {
    await addResult({
      channel: "Marketplace 1",
      courier: null,
      status: "SHORT_PAID",
      difference: "25.00",
      dueDaysAgo: 3,
    });
    const { data } = await getRisk();
    expect(data.totals.cashAtRisk).toBe("0.00");
  });
});

describe("GET /api/dashboard/tax-summary", () => {
  async function taxFixtures(): Promise<void> {
    await addSettlement("Marketplace 1", "2026-10-05T00:00:00Z", "100.00", "10.00");
    await addSettlement("Marketplace 1", "2026-10-31T23:59:59Z", "50.25", "5.00");
    await addSettlement("Marketplace 1", "2026-11-01T00:00:00Z", "40.00", "4.00");
    await addSettlement("Quick Commerce 1", "2026-11-12T00:00:00Z", "7.50", "0.75");
  }
  const getTax = (query = "", who = exec) =>
    call(server.baseUrl, "GET", `/api/dashboard/tax-summary${query}`, { cookie: who.cookie });

  it("is closed to guests and open to both roles", async () => {
    expect((await call(server.baseUrl, "GET", "/api/dashboard/tax-summary")).status).toBe(401);
    expect((await getTax("", exec)).status).toBe(200);
    expect((await getTax("", founder)).status).toBe(200);
  });

  it("is empty before any settlement file is loaded", async () => {
    const { data } = await getTax();
    expect(data).toEqual({
      month: null,
      months: [],
      partners: [],
      totals: { lines: 0, tcs: "0.00", tds: "0.00", total: "0.00" },
    });
  });

  it("shows TCS and TDS for each partner, in separate columns", async () => {
    await taxFixtures();
    const { data } = await getTax();
    expect(data.partners).toEqual([
      {
        id: sourceIds["Marketplace 1"],
        name: "Marketplace 1",
        kind: "MARKETPLACE",
        lines: 3,
        tcs: "190.25",
        tds: "19.00",
        total: "209.25",
      },
      {
        id: sourceIds["Quick Commerce 1"],
        name: "Quick Commerce 1",
        kind: "QUICK_COMMERCE",
        lines: 1,
        tcs: "7.50",
        tds: "0.75",
        total: "8.25",
      },
    ]);
    expect(data.totals).toEqual({ lines: 4, tcs: "197.75", tds: "19.75", total: "217.50" });
    expect(data.month).toBeNull();
  });

  it("matches the sum of the raw settlement lines", async () => {
    await taxFixtures();
    const raw = await prisma.settlementLine.aggregate({
      _sum: { tcs: true, tds: true },
      _count: true,
    });
    const { data } = await getTax();
    expect(data.totals.tcs).toBe(raw._sum.tcs?.toFixed(2));
    expect(data.totals.tds).toBe(raw._sum.tds?.toFixed(2));
    expect(data.totals.lines).toBe(raw._count);
  });

  it("lists the months that have settlements, newest first, and filters by month", async () => {
    await taxFixtures();
    expect((await getTax()).data.months).toEqual(["2026-11", "2026-10"]);

    const october = (await getTax("?month=2026-10")).data;
    expect(october.month).toBe("2026-10");
    expect(october.partners).toHaveLength(1);
    expect(october.totals).toEqual({ lines: 2, tcs: "150.25", tds: "15.00", total: "165.25" });

    const november = (await getTax("?month=2026-11")).data;
    expect(november.totals).toEqual({ lines: 2, tcs: "47.50", tds: "4.75", total: "52.25" });
  });

  it("returns an empty summary for a month with no settlements, but keeps the month list", async () => {
    await taxFixtures();
    const { data } = await getTax("?month=2026-01");
    expect(data.partners).toEqual([]);
    expect(data.totals.total).toBe("0.00");
    expect(data.months).toEqual(["2026-11", "2026-10"]);
  });

  it("includes settlement lines that are not matched to any order", async () => {
    await addSettlement("Marketplace 1", "2026-11-01T00:00:00Z", "3.00", "0.30", { orderPk: null });
    expect((await getTax()).data.totals).toMatchObject({ lines: 1, tcs: "3.00", tds: "0.30" });
  });

  it("does not count TCS or TDS as money at risk", async () => {
    await taxFixtures();
    expect((await getRisk()).data.totals.cashAtRisk).toBe("0.00");
  });

  it.each(["2026-13", "2026-1", "november", "2026-11-01"])(
    "answers 422 for ?month=%s",
    async (month) => {
      const { status, data } = await getTax(`?month=${month}`);
      expect(status).toBe(422);
      expect(data.error.code).toBe("VALIDATION_FAILED");
    },
  );
});
