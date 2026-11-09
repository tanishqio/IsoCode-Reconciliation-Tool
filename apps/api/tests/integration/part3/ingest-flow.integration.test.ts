// Part 3 end to end: upload a file, queue it, let the real worker process it, and check the
// saved rows, the rejected rows and the counts. The app is imported inside beforeAll, after the
// upload folders are set, because the settings are read once when the code is first loaded.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import type { Worker } from "../../../src/jobs/worker-loop.js";
import { call, signIn } from "../../helpers/auth-client.js";
import { startServer, type TestServer } from "../../helpers/server.js";
import { assertTestDatabase } from "../../helpers/test-db.js";

const EXEC = { email: "exec@example.test", password: "executive-password-1" };
const FOUNDER = { email: "founder@example.test", password: "cofounder-password-1" };

const root = mkdtempSync(path.join(tmpdir(), "lk-ingest-"));
process.env["UPLOAD_DIR"] = path.join(root, "uploads");
process.env["UPLOAD_TEMP_DIR"] = path.join(root, "tmp");

let prisma: PrismaClient;
let server: TestServer;
let worker: Worker;
let base: string;
let websiteId: string;
let session: { cookie: string; csrf: string };

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

// Reading a file also queues a recalculation. Let the worker finish it before the next test empties
// the tables, or the two would wait on each other.
afterEach(async () => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const open = await prisma.processingJob.count({
      where: { status: { in: ["QUEUED", "RUNNING"] } },
    });
    if (open === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

afterAll(async () => {
  await worker.stop();
  await server.close();
  await prisma.$disconnect();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]);
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "users", "uploaded_files", "upload_batches", "sources", "source_file_types", "processing_jobs" CASCADE',
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
  websiteId = (await prisma.source.findUniqueOrThrow({ where: { name: "Website" } })).id;
  const login = await signIn(base, EXEC.email, EXEC.password);
  session = { cookie: login.cookie, csrf: login.csrf };
});

let counter = 0;

async function upload(csv: string): Promise<string> {
  const form = new FormData();
  form.append("items", JSON.stringify([{ sourceId: websiteId, fileType: "ORDERS" }]));
  form.append("files", new Blob([csv], { type: "text/csv" }), `orders-${counter++}.csv`);
  const result = await call(base, "POST", "/api/uploads", { ...session, form });
  expect(result.status).toBe(201);
  return result.data.results[0].file.id as string;
}

/** Gets the file read: reviews the suggested mapping and approves it (unless one already applied). */
async function queue(fileId: string) {
  const file = (await call(base, "GET", `/api/uploads/${fileId}`, session)).data;
  if (file.status !== "NEEDS_MAPPING") return { status: 200, data: file };
  const suggestion = await call(base, "POST", `/api/uploads/${fileId}/mapping/suggest`, session);
  expect(suggestion.status).toBe(200);
  return call(base, "POST", `/api/uploads/${fileId}/mapping/approve`, {
    ...session,
    json: { proposalId: suggestion.data.proposalId, columnMap: suggestion.data.columnMap },
  });
}

async function waitForFile(fileId: string, done: (status: string) => boolean) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const file = (await call(base, "GET", `/api/uploads/${fileId}`, session)).data;
    if (done(file.status)) return file;
    if (Date.now() > deadline) throw new Error(`Timed out, file status is ${file.status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const HEADER = "Order ID,Order Date,Order Value,Payment Mode,Status,Customer Name,Customer Phone";
const CSV = [
  HEADER,
  'ord-1,2026-11-03,"₹1,499.00",COD,Delivered,Asha Rao,9876543210',
  "ORD-2,03/11/2026,899,Prepaid,Delivered,Ravi Kumar,9123456780",
  "ORD-2,03/11/2026,899,Prepaid,Delivered,Ravi Kumar,9123456780", // identical row
  "ORD-3,not a date,100,COD,Delivered,Meena,9000000001",
  "1.23457E+11,2026-11-03,100,COD,Delivered,Meena,9000000001",
  "ORD-1,2026-11-03,1500,COD,Delivered,Asha Rao,9876543210", // same ID, different value
  "ORD-5,2026-11-04,250.50,Prepaid,Returned,Sunil,9000000002",
  "",
].join("\n");

describe("processing an orders file", () => {
  it("saves good rows, rejects bad rows with reasons, and never touches personal data", async () => {
    const fileId = await upload(CSV);

    const queued = await queue(fileId);
    expect(queued.status).toBe(200);

    const file = await waitForFile(
      fileId,
      (s) => s !== "NEEDS_MAPPING" && s !== "QUEUED" && s !== "PROCESSING",
    );
    expect(file.status).toBe("COMPLETED_WITH_REJECTS");
    expect(file).toMatchObject({ rowsAccepted: 3, rowsRejected: 3, rowsDuplicate: 1 });
    expect(file.job).toMatchObject({ status: "SUCCEEDED", progressPct: 100 });

    const orders = await prisma.customerOrder.findMany({ orderBy: { sourceRowNumber: "asc" } });
    expect(orders.map((o) => [o.orderId, o.value.toFixed(2), o.sourceRowNumber])).toEqual([
      ["ORD-1", "1499.00", 2],
      ["ORD-2", "899.00", 3],
      ["ORD-5", "250.50", 8],
    ]);
    expect(orders[0]?.channelSourceId).toBe(websiteId);

    const rejected = await call(base, "GET", `/api/uploads/${fileId}/rejected-rows`, session);
    expect(rejected.status).toBe(200);
    expect(
      rejected.data.items.map((r: { rowNumber: number; reasonCode: string }) => [
        r.rowNumber,
        r.reasonCode,
      ]),
    ).toEqual([
      [5, "BAD_DATE"],
      [6, "ID_SCIENTIFIC_NOTATION"],
      [7, "CONFLICTING_DUPLICATE"],
    ]);

    // Nothing from the personal-data columns was stored anywhere.
    const stored = JSON.stringify([orders, rejected.data]);
    for (const secret of ["Asha", "Ravi", "9876543210", "9123456780"]) {
      expect(stored).not.toContain(secret);
    }
  });

  it("does not load an order again when a second file repeats it", async () => {
    const first = await upload(`${HEADER}\nORD-9,2026-11-03,100,COD,Delivered,A,1\n`);
    await queue(first);
    await waitForFile(first, (s) => s === "COMPLETED");

    const second = await upload(
      `${HEADER}\nORD-9,2026-11-03,100,COD,Delivered,A,1\nORD-10,2026-11-03,50,COD,Delivered,B,2\n`,
    );
    await queue(second);
    const file = await waitForFile(second, (s) => s === "COMPLETED");

    expect(file).toMatchObject({ rowsAccepted: 1, rowsDuplicate: 1, rowsRejected: 0 });
    expect(await prisma.customerOrder.count()).toBe(2);
  });

  it("refuses a file whose required columns cannot be found, and a file already processed", async () => {
    const bad = await upload("Reference,Amount\nX1,100\n");
    const refused = await queue(bad);
    expect(refused.status).toBe(422);
    expect(refused.data.error.message).toContain("orderId");
    expect((await call(base, "GET", `/api/uploads/${bad}`, session)).data.status).toBe(
      "NEEDS_MAPPING",
    );

    const ok = await upload(`${HEADER}\nORD-20,2026-11-03,100,COD,Delivered,A,1\n`);
    await queue(ok);
    await waitForFile(ok, (s) => s === "COMPLETED");
    // Nothing can be queued twice: a processed file is not waiting for a mapping any more.
    expect((await call(base, "POST", `/api/uploads/${ok}/process`, session)).status).toBe(409);
  });

  it("is for the finance executive only", async () => {
    const fileId = await upload(`${HEADER}\nORD-30,2026-11-03,100,COD,Delivered,A,1\n`);
    const founder = await signIn(base, FOUNDER.email, FOUNDER.password);
    const suggest = `/api/uploads/${fileId}/mapping/suggest`;
    const denied = await call(base, "POST", suggest, {
      cookie: founder.cookie,
      csrf: founder.csrf,
    });
    expect(denied.status).toBe(403);
    expect((await call(base, "POST", suggest, {})).status).toBe(401);
  });
});
