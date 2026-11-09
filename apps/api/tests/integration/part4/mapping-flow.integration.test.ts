// Part 4 end to end with a fake AI service: upload with an unknown layout, review the AI's
// suggestion, approve it, see the file read, then see the next file with the same layout read
// without review, a changed layout wait, and a rollback release the file that waited.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import type { Worker } from "../../../src/jobs/worker-loop.js";
import { call, signIn } from "../../helpers/auth-client.js";
import { startServer, type TestServer } from "../../helpers/server.js";
import { assertTestDatabase } from "../../helpers/test-db.js";

const EXEC = { email: "exec@example.test", password: "executive-password-1" };
const FOUNDER = { email: "founder@example.test", password: "cofounder-password-1" };

const root = mkdtempSync(path.join(tmpdir(), "lk-mapping-"));
process.env["UPLOAD_DIR"] = path.join(root, "uploads");
process.env["UPLOAD_TEMP_DIR"] = path.join(root, "tmp");

// A fake OpenAI-compatible service. `aiMode` decides how it answers.
let aiMode: "ok" | "down" = "ok";
const aiRequests: string[] = [];
const AI_ANSWER = {
  mapping: [
    { field: "orderId", column: "Ref No", confidence: "high" },
    { field: "orderDate", column: "Placed On", confidence: "high" },
    { field: "value", column: "Amount Payable", confidence: "medium" },
    { field: "paymentType", column: "Pay Mode", confidence: "high" },
    { field: "deliveryStatus", column: "Shipment State", confidence: "low" },
    { field: "awb", column: "Tracking Code", confidence: "high" }, // wrong: not in the file
  ],
  notes: "ok",
};
const aiServer: Server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    aiRequests.push(body);
    if (aiMode === "down") {
      res.writeHead(500).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(AI_ANSWER) } }] }));
  });
});
await new Promise<void>((resolve) => aiServer.listen(0, "127.0.0.1", resolve));
process.env["AI_PROVIDER"] = "openai-compatible";
process.env["AI_API_KEY"] = "test-key";
process.env["AI_BASE_URL"] = `http://127.0.0.1:${(aiServer.address() as AddressInfo).port}/v1`;
process.env["AI_MODEL"] = "fake-model";

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

afterAll(async () => {
  await worker.stop();
  await server.close();
  await new Promise((resolve) => aiServer.close(resolve));
  await prisma.$disconnect();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]);
  aiMode = "ok";
  aiRequests.length = 0;
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

const LAYOUT_A = "Ref No,Placed On,Amount Payable,Pay Mode,Shipment State,Customer Mobile";
const LAYOUT_B = "Order ID,Order Date,Order Value,Payment Mode,Status";
let counter = 0;

async function upload(csv: string) {
  const form = new FormData();
  form.append("items", JSON.stringify([{ sourceId: websiteId, fileType: "ORDERS" }]));
  form.append("files", new Blob([csv], { type: "text/csv" }), `orders-${counter++}.csv`);
  const result = await call(base, "POST", "/api/uploads", { ...session, form });
  expect(result.status).toBe(201);
  return result.data.results[0].file as { id: string; status: string };
}

const get = async (id: string) => (await call(base, "GET", `/api/uploads/${id}`, session)).data;

async function waitFor(id: string, done: (status: string) => boolean) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const file = await get(id);
    if (done(file.status)) return file;
    if (Date.now() > deadline) throw new Error(`Timed out, status ${file.status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const suggest = (id: string) => call(base, "POST", `/api/uploads/${id}/mapping/suggest`, session);
const approve = (id: string, proposalId: string, columnMap: unknown) =>
  call(base, "POST", `/api/uploads/${id}/mapping/approve`, {
    ...session,
    json: { proposalId, columnMap },
  });
const history = async () =>
  (await call(base, "GET", `/api/mappings?sourceId=${websiteId}&fileType=ORDERS`, session)).data
    .items as {
    id: string;
    versionNo: number;
    status: string;
    origin: string;
    rolledBackFromVersionNo: number | null;
  }[];

describe("column mapping", () => {
  it("reviews an unknown layout, remembers the approval, and handles a changed layout and a rollback", async () => {
    // 1. A layout nobody has mapped yet waits for review.
    const first = await upload(
      `${LAYOUT_A}\nA-1,2026-11-03,"1,499.00",COD,Delivered,9876543210\nA-2,2026-11-04,899,Prepaid,Delivered,9123456780\n`,
    );
    expect(first.status).toBe("NEEDS_MAPPING");

    // 2. The AI proposes. A wrong answer is dropped, personal data is not sent, rows are previewed.
    const proposal = await suggest(first.id);
    expect(proposal.status).toBe(200);
    expect(proposal.data).toMatchObject({ origin: "AI", aiModel: "fake-model" });
    expect(proposal.data.columnMap).toEqual({
      orderId: "Ref No",
      orderDate: "Placed On",
      value: "Amount Payable",
      paymentType: "Pay Mode",
      deliveryStatus: "Shipment State",
    });
    expect(proposal.data.notes.join(" ")).toContain("Ignored AI answers that cannot be right");
    expect(proposal.data.ignoredColumns).toEqual(["Customer Mobile"]);
    expect(proposal.data.preview.rows).toHaveLength(2);
    expect(proposal.data.preview.rows[0].values.value).toBe("1499.00");
    expect(aiRequests.join(" ")).not.toContain("9876543210");
    expect(aiRequests.join(" ")).not.toContain("Customer Mobile");

    // 3. Nothing is read until a person approves; a bad mapping is refused.
    expect((await get(first.id)).status).toBe("NEEDS_MAPPING");
    const noValue = { ...proposal.data.columnMap };
    delete noValue.value;
    expect((await approve(first.id, proposal.data.proposalId, noValue)).status).toBe(422);
    const personal = { ...proposal.data.columnMap, awb: "Customer Mobile" };
    expect((await approve(first.id, proposal.data.proposalId, personal)).status).toBe(422);

    // 4. Approval saves version 1 and the file is read.
    const approved = await approve(first.id, proposal.data.proposalId, proposal.data.columnMap);
    expect(approved.status).toBe(200);
    expect(approved.data).toMatchObject({ versionNo: 1, origin: "AI", queuedFiles: 1 });
    expect(await waitFor(first.id, (s) => s === "COMPLETED")).toMatchObject({ rowsAccepted: 2 });
    expect(await prisma.customerOrder.count()).toBe(2);

    // 5. The same layout again needs no review.
    const second = await upload(`${LAYOUT_A}\nA-3,2026-11-05,500,COD,Delivered,9000000001\n`);
    expect(second.status).toBe("QUEUED");
    expect(await waitFor(second.id, (s) => s === "COMPLETED")).toMatchObject({ rowsAccepted: 1 });

    // 6. A changed layout waits. The AI is down, so the rules answer and the screen is told.
    aiMode = "down";
    const changed = await upload(`${LAYOUT_B}\nB-1,2026-11-06,250,Prepaid,Delivered\n`);
    expect(changed.status).toBe("NEEDS_MAPPING");
    const fallback = await suggest(changed.id);
    expect(fallback.data.origin).toBe("FALLBACK");
    expect(fallback.data.aiModel).toBeNull();
    expect(fallback.data.notes.join(" ")).toContain("fixed rules");
    expect(fallback.data.missing).toEqual([]);

    // 7. The rule-based suggestion is approved as it is: version 2 replaces version 1. The label
    // stays "fallback" so the history shows what produced it.
    const v2 = await approve(changed.id, fallback.data.proposalId, fallback.data.columnMap);
    expect(v2.data).toMatchObject({ versionNo: 2, origin: "FALLBACK" });
    await waitFor(changed.id, (s) => s === "COMPLETED");

    // 8. Layout A files now wait, because version 2 is active. Rolling back to version 1 reads them.
    const waiting = await upload(`${LAYOUT_A}\nA-9,2026-11-07,700,COD,Delivered,9000000002\n`);
    expect(waiting.status).toBe("NEEDS_MAPPING");
    const versions = await history();
    expect(versions.map((v) => [v.versionNo, v.status])).toEqual([
      [2, "ACTIVE"],
      [1, "SUPERSEDED"],
    ]);
    const v1 = versions.find((v) => v.versionNo === 1);
    const rolled = await call(base, "POST", `/api/mappings/${v1?.id}/rollback`, session);
    expect(rolled.data).toMatchObject({ versionNo: 3, queuedFiles: 1 });
    await waitFor(waiting.id, (s) => s === "COMPLETED");
    const after = await history();
    expect(after.map((v) => [v.versionNo, v.status, v.rolledBackFromVersionNo])).toEqual([
      [3, "ACTIVE", 1],
      [2, "SUPERSEDED", null],
      [1, "SUPERSEDED", null],
    ]);
    expect(
      (await call(base, "POST", `/api/mappings/${after[0]?.id}/rollback`, session)).status,
    ).toBe(409);
  });

  it("lets a person reject a suggestion, and is for the finance executive only", async () => {
    const file = await upload(`${LAYOUT_A}\nA-1,2026-11-03,100,COD,Delivered,9000000003\n`);
    const proposal = await suggest(file.id);
    const reject = await call(
      base,
      "POST",
      `/api/mappings/${proposal.data.proposalId}/reject`,
      session,
    );
    expect(reject.status).toBe(204);
    expect((await approve(file.id, proposal.data.proposalId, proposal.data.columnMap)).status).toBe(
      409,
    );
    expect((await get(file.id)).status).toBe("NEEDS_MAPPING");

    const founder = await signIn(base, FOUNDER.email, FOUNDER.password);
    const denied = await call(base, "GET", `/api/mappings?sourceId=${websiteId}&fileType=ORDERS`, {
      cookie: founder.cookie,
      csrf: founder.csrf,
    });
    expect(denied.status).toBe(403);
  });
});
