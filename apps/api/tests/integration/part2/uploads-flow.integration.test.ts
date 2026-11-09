import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import express, { type RequestHandler } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, type ErrorBody } from "../../../src/lib/errors.js";
import { buildHeaderSignature } from "../../../src/lib/header-signature.js";
import type {
  AuditEntry,
  AuditWriter,
  UploadOutcome,
  UploadPage,
} from "../../../src/modules/uploads/uploads.service.js";
import {
  buildForm,
  countFiles,
  makeTempDir,
  uniqueCsv,
  uniqueWorkbook,
  waitForNoFiles,
  workbookBuffer,
} from "../../helpers/part2-fixtures.js";
import { startServer, type TestServer } from "../../helpers/server.js";
import { assertTestDatabase } from "../../helpers/test-db.js";

const MAX_FILE_BYTES = 256 * 1024;
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

let tempDir: string;
let uploadDir: string;
let server: TestServer;
let prisma: typeof import("../../../src/db/prisma.js").prisma;
let execId: string;
let founderId: string;
const audit = vi.fn<AuditWriter>(async () => undefined);

interface SourceInfo {
  id: string;
  name: string;
  fileTypes: string[];
}
const sourceByName = new Map<string, SourceInfo>();

const fakeAuth: RequestHandler = (req, _res, next) => {
  const role = req.header("x-role");
  const id = req.header("x-user-id");
  if (!role || !id) {
    next(new AppError("UNAUTHENTICATED", 401, "Please sign in."));
    return;
  }
  (req as unknown as { user: unknown }).user = { id, role };
  next();
};

beforeAll(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]);
  tempDir = makeTempDir("flow-temp");
  uploadDir = makeTempDir("flow-uploads");
  process.env["UPLOAD_TEMP_DIR"] = tempDir;
  process.env["UPLOAD_DIR"] = uploadDir;
  process.env["MAX_UPLOAD_FILE_BYTES"] = String(MAX_FILE_BYTES);
  process.env["MAX_UPLOAD_FILES"] = "5";

  ({ prisma } = await import("../../../src/db/prisma.js"));
  const { seedSources } = await import("../../../src/db/seed-sources.js");
  const { createUploadsService } = await import("../../../src/modules/uploads/uploads.service.js");
  const { createUploadsRouter } = await import("../../../src/modules/uploads/uploads.routes.js");
  const { createSourcesService } = await import("../../../src/modules/sources/sources.service.js");
  const { createSourcesRouter } = await import("../../../src/modules/sources/sources.routes.js");
  const { errorHandler, notFoundHandler } =
    await import("../../../src/middleware/error-handler.js");
  const { requestLogger } = await import("../../../src/middleware/request-logger.js");

  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "uploaded_files", "upload_batches", "source_file_types", "sources" CASCADE',
  );
  await seedSources(prisma);
  const sources = await prisma.source.findMany({ include: { fileTypes: true } });
  for (const source of sources) {
    sourceByName.set(source.name, {
      id: source.id,
      name: source.name,
      fileTypes: source.fileTypes.map((entry) => entry.fileType),
    });
  }

  const exec = await prisma.user.create({
    data: {
      email: `exec-${randomUUID()}@example.invalid`,
      name: "Exec",
      passwordHash: "x",
      role: "FINANCE_EXECUTIVE",
    },
  });
  const founder = await prisma.user.create({
    data: {
      email: `founder-${randomUUID()}@example.invalid`,
      name: "Founder",
      passwordHash: "x",
      role: "CO_FOUNDER",
    },
  });
  execId = exec.id;
  founderId = founder.id;

  const uploadsService = createUploadsService({ prisma, audit });
  const sourcesService = createSourcesService({ prisma });
  const app = express();
  app.use(requestLogger);
  app.use("/api/uploads", createUploadsRouter({ service: uploadsService, guards: [fakeAuth] }));
  app.use("/api/sources", createSourcesRouter({ service: sourcesService, guards: [fakeAuth] }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  server = await startServer(app);
});

afterAll(async () => {
  await server?.close();
  if (prisma) {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "uploaded_files", "upload_batches", "source_file_types", "sources" CASCADE',
    );
    await prisma.user.deleteMany({ where: { id: { in: [execId, founderId] } } });
    await prisma.$disconnect();
  }
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(uploadDir, { recursive: true, force: true });
});

beforeEach(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]);
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "uploaded_files", "upload_batches" CASCADE');
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(uploadDir, { recursive: true, force: true });
  audit.mockClear();
});

const executive = () => ({ "x-role": "FINANCE_EXECUTIVE", "x-user-id": execId });
const founder = () => ({ "x-role": "CO_FOUNDER", "x-user-id": founderId });

function src(name: string): SourceInfo {
  const found = sourceByName.get(name);
  if (!found) throw new Error(`Missing seeded source ${name}`);
  return found;
}

const item = (name: string, fileType = "ORDERS") => ({ sourceId: src(name).id, fileType });

async function api<T = unknown>(
  method: string,
  url: string,
  init: { headers?: Record<string, string>; body?: BodyInit } = {},
) {
  const response = await fetch(`${server.baseUrl}${url}`, { method, ...init });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

function upload(
  items: unknown,
  files: { name: string; data: Buffer }[],
  headers: Record<string, string> = executive(),
  options?: Parameters<typeof buildForm>[2],
) {
  return api<UploadOutcome & ErrorBody>("POST", "/api/uploads", {
    headers,
    body: buildForm(items, files, options),
  });
}

async function expectNothingStored() {
  expect(await prisma.uploadedFile.count()).toBe(0);
  expect(countFiles(uploadDir)).toBe(0);
  expect(await waitForNoFiles(tempDir)).toBe(0);
}

describe("GET /api/sources", () => {
  it("lists the nine seeded sources with the file types each may send", async () => {
    const { status, body } = await api<{
      items: { name: string; kind: string; fileTypes: string[] }[];
    }>("GET", "/api/sources", { headers: executive() });
    expect(status).toBe(200);
    expect(body.items).toHaveLength(9);
    const byName = new Map(body.items.map((entry) => [entry.name, entry]));
    expect(byName.get("Website")?.fileTypes).toEqual(["ORDERS"]);
    expect(byName.get("Marketplace 2")?.fileTypes).toEqual(["ORDERS", "SETTLEMENT"]);
    expect(byName.get("Aggregator 1")?.fileTypes).toEqual(["COD_REMITTANCE", "FREIGHT_INVOICE"]);
    expect(byName.get("Warehouse")?.fileTypes).toEqual(["RETURN_SCAN"]);
    expect(body.items.map((entry) => entry.name)).toEqual(
      [...body.items.map((entry) => entry.name)].sort(),
    );
  });

  it("hides inactive sources", async () => {
    await prisma.source.update({
      where: { id: src("Marketplace 3").id },
      data: { isActive: false },
    });
    try {
      const { body } = await api<{ items: { name: string }[] }>("GET", "/api/sources", {
        headers: executive(),
      });
      expect(body.items.map((entry) => entry.name)).not.toContain("Marketplace 3");
      expect(body.items).toHaveLength(8);
    } finally {
      await prisma.source.update({
        where: { id: src("Marketplace 3").id },
        data: { isActive: true },
      });
    }
  });

  it("is closed to guests and to the co-founder", async () => {
    expect((await api("GET", "/api/sources")).status).toBe(401);
    expect((await api("GET", "/api/sources", { headers: founder() })).status).toBe(403);
  });
});

describe("POST /api/uploads: one valid file", () => {
  it("stores the file on disk, records it in the database and leaves no temp file", async () => {
    const data = uniqueCsv(["Order ID", "Amount", "Date"], 3);
    const { status, body } = await upload([item("Website")], [{ name: "orders.csv", data }]);

    expect(status).toBe(201);
    expect(body.summary).toEqual({ fileCount: 1, accepted: 1, duplicate: 0, rejected: 0 });
    const result = body.results[0];
    if (result?.status !== "ACCEPTED") throw new Error("expected ACCEPTED");
    expect(result.file).toMatchObject({
      sourceName: "Website",
      fileType: "ORDERS",
      originalName: "orders.csv",
      format: "CSV",
      sizeBytes: data.length,
      status: "NEEDS_MAPPING",
      warning: null,
      detectedRowCount: 3,
    });

    const row = await prisma.uploadedFile.findUniqueOrThrow({ where: { id: result.file.id } });
    expect(row.sha256).toBe(sha256(data));
    expect(row.headerSignature).toBe(buildHeaderSignature(["Order ID", "Amount", "Date"]));
    expect(row.sourceId).toBe(src("Website").id);
    expect(row.uploadedById).toBe(execId);
    expect(row.batchId).toBe(body.batchId);
    expect(row.sizeBytes).toBe(BigInt(data.length));
    expect(row.mappingVersionId).toBeNull();
    expect(row.storagePath).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.csv$/);
    expect(path.isAbsolute(row.storagePath)).toBe(false);

    const stored = path.join(uploadDir, row.storagePath);
    expect(readFileSync(stored).equals(data)).toBe(true);
    expect(countFiles(uploadDir)).toBe(1);
    expect(await waitForNoFiles(tempDir)).toBe(0);

    const batch = await prisma.uploadBatch.findUniqueOrThrow({ where: { id: body.batchId } });
    expect(batch).toMatchObject({
      uploadedById: execId,
      fileCount: 1,
      acceptedCount: 1,
      duplicateCount: 0,
      rejectedCount: 0,
    });
  });

  it("records an UPLOAD audit event without the file name", async () => {
    const { body } = await upload(
      [item("Website")],
      [{ name: "customer-list.csv", data: uniqueCsv() }],
    );
    expect(audit).toHaveBeenCalledTimes(1);
    const entry = audit.mock.calls[0]?.[0] as AuditEntry;
    expect(entry).toMatchObject({ userId: execId, action: "UPLOAD", entityType: "UPLOADED_FILE" });
    expect(entry.meta["batchId"]).toBe(body.batchId);
    expect(JSON.stringify(entry)).not.toContain("customer-list");
  });

  it("accepts the items field after the files", async () => {
    const { status } = await upload(
      [item("Website")],
      [{ name: "a.csv", data: uniqueCsv() }],
      executive(),
      {
        itemsAfterFiles: true,
      },
    );
    expect(status).toBe(201);
  });

  it("counts the rows of a larger file", async () => {
    const lines = ["order_id,amount"];
    for (let row = 0; row < 8_000; row += 1) lines.push(`ORD-${randomUUID().slice(0, 8)},${row}`);
    const data = Buffer.from(`${lines.join("\n")}\n`);
    expect(data.length).toBeLessThan(MAX_FILE_BYTES);
    const { body } = await upload([item("Website")], [{ name: "big.csv", data }]);
    const result = body.results[0];
    if (result?.status !== "ACCEPTED") throw new Error("expected ACCEPTED");
    expect(result.file.detectedRowCount).toBe(8_000);
  });

  it("never lets the uploaded file name decide where the file is stored", async () => {
    const { status, body } = await upload(
      [item("Website")],
      [{ name: "..\\..\\..\\evil name.csv", data: uniqueCsv() }],
    );
    expect(status).toBe(201);
    const result = body.results[0];
    if (result?.status !== "ACCEPTED") throw new Error("expected ACCEPTED");
    const row = await prisma.uploadedFile.findUniqueOrThrow({ where: { id: result.file.id } });
    expect(row.storagePath).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.csv$/);
    expect(existsSync(path.join(uploadDir, row.storagePath))).toBe(true);
    expect(countFiles(uploadDir)).toBe(1);
  });
});

describe("POST /api/uploads: Excel files", () => {
  it("accepts .xlsx and .xls and gives all three formats the same signature for the same columns", async () => {
    const headers = ["Order ID", "Amount"];
    const csv = Buffer.from(`${headers.join(",")}\nA-${randomUUID()},1\n`);
    const xlsx = workbookBuffer([headers, [`A-${randomUUID()}`, 1]], "xlsx");
    const xls = workbookBuffer([headers, [`A-${randomUUID()}`, 1]], "biff8");

    const { status, body } = await upload(
      [item("Website"), item("Website"), item("Website")],
      [
        { name: "a.csv", data: csv },
        { name: "b.xlsx", data: xlsx },
        { name: "c.xls", data: xls },
      ],
    );

    expect(status).toBe(201);
    expect(body.summary.accepted).toBe(3);
    const rows = await prisma.uploadedFile.findMany({ orderBy: { originalName: "asc" } });
    expect(rows.map((row) => row.format)).toEqual(["CSV", "XLSX", "XLS"]);
    expect(new Set(rows.map((row) => row.headerSignature)).size).toBe(1);
    expect(rows.map((row) => row.detectedRowCount)).toEqual([1, 1, 1]);
    expect(rows.map((row) => path.extname(row.storagePath))).toEqual([".csv", ".xlsx", ".xls"]);
  });

  it("gives a different signature when a partner changes its columns", async () => {
    await upload([item("Website")], [{ name: "a.csv", data: uniqueCsv(["order_id", "amount"]) }]);
    await upload(
      [item("Website")],
      [{ name: "b.csv", data: uniqueCsv(["order_id", "net_amount"]) }],
    );
    const rows = await prisma.uploadedFile.findMany();
    expect(new Set(rows.map((row) => row.headerSignature)).size).toBe(2);
  });

  it("warns when a workbook has several sheets", async () => {
    const data = workbookBuffer([["Order ID"], [`A-${randomUUID()}`]], "xlsx", 1);
    const { body } = await upload([item("Website")], [{ name: "multi.xlsx", data }]);
    const result = body.results[0];
    if (result?.status !== "ACCEPTED") throw new Error("expected ACCEPTED");
    expect(result.file.warning).toContain("2 sheets");
  });
});

describe("POST /api/uploads: duplicates", () => {
  it("rejects the same file for the same source and type with 409 and keeps only the first copy", async () => {
    const data = uniqueCsv();
    const first = await upload([item("Website")], [{ name: "first.csv", data }]);
    const second = await upload([item("Website")], [{ name: "second.csv", data }]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.summary).toEqual({ fileCount: 1, accepted: 0, duplicate: 1, rejected: 0 });
    const firstResult = first.body.results[0];
    if (firstResult?.status !== "ACCEPTED") throw new Error("expected ACCEPTED");
    expect(second.body.results[0]).toMatchObject({
      status: "DUPLICATE",
      fileName: "second.csv",
      existing: { id: firstResult.file.id, originalName: "first.csv" },
    });

    expect(await prisma.uploadedFile.count()).toBe(1);
    expect(countFiles(uploadDir)).toBe(1);
    expect(await waitForNoFiles(tempDir)).toBe(0);
    const batch = await prisma.uploadBatch.findUniqueOrThrow({
      where: { id: second.body.batchId },
    });
    expect(batch).toMatchObject({ acceptedCount: 0, duplicateCount: 1, rejectedCount: 0 });
  });

  it("writes a DUPLICATE_BLOCKED audit event pointing at the first file", async () => {
    const data = uniqueCsv();
    const first = await upload([item("Website")], [{ name: "a.csv", data }]);
    audit.mockClear();
    await upload([item("Website")], [{ name: "b.csv", data }]);
    const firstResult = first.body.results[0];
    if (firstResult?.status !== "ACCEPTED") throw new Error("expected ACCEPTED");
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]?.[0]).toMatchObject({
      userId: execId,
      action: "DUPLICATE_BLOCKED",
      entityId: firstResult.file.id,
    });
  });

  it("treats a renamed copy as a duplicate (the content decides, not the name)", async () => {
    const data = uniqueCsv();
    await upload([item("Website")], [{ name: "orders-june.csv", data }]);
    const { status } = await upload(
      [item("Website")],
      [{ name: "totally-different-name.csv", data }],
    );
    expect(status).toBe(409);
  });

  it("accepts the same bytes for another source or another file type", async () => {
    const data = uniqueCsv();
    expect((await upload([item("Marketplace 1")], [{ name: "a.csv", data }])).status).toBe(201);
    expect((await upload([item("Marketplace 2")], [{ name: "a.csv", data }])).status).toBe(201);
    expect(
      (await upload([item("Marketplace 1", "SETTLEMENT")], [{ name: "a.csv", data }])).status,
    ).toBe(201);
    expect(await prisma.uploadedFile.count()).toBe(3);
  });

  it("does not catch the same data saved with a different byte layout (known limit)", async () => {
    const data = uniqueCsv();
    await upload([item("Website")], [{ name: "a.csv", data }]);
    const resaved = Buffer.concat([data, Buffer.from("\n")]);
    expect((await upload([item("Website")], [{ name: "a.csv", data: resaved }])).status).toBe(201);
  });

  it("catches an exact duplicate sent twice inside one request", async () => {
    const data = uniqueCsv();
    const { status, body } = await upload(
      [item("Website"), item("Website")],
      [
        { name: "a.csv", data },
        { name: "b.csv", data },
      ],
    );
    expect(status).toBe(201);
    expect(body.results.map((result) => result.status)).toEqual(["ACCEPTED", "DUPLICATE"]);
    expect(await prisma.uploadedFile.count()).toBe(1);
    expect(countFiles(uploadDir)).toBe(1);
  });

  it.each([1, 2, 3, 4, 5])(
    "lets exactly one of two simultaneous identical uploads win (run %i)",
    async () => {
      const data = uniqueCsv();
      const [a, b] = await Promise.all([
        upload([item("Website")], [{ name: "a.csv", data }]),
        upload([item("Website")], [{ name: "b.csv", data }]),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(await prisma.uploadedFile.count()).toBe(1);
      expect(countFiles(uploadDir)).toBe(1);
      expect(await waitForNoFiles(tempDir)).toBe(0);
      const winner = [a, b].find((response) => response.status === 201);
      const loser = [a, b].find((response) => response.status === 409);
      const winnerResult = winner?.body.results[0];
      if (winnerResult?.status !== "ACCEPTED") throw new Error("expected ACCEPTED");
      expect(loser?.body.results[0]).toMatchObject({
        status: "DUPLICATE",
        existing: { id: winnerResult.file.id },
      });
    },
  );
});

describe("POST /api/uploads: a mixed batch of five types", () => {
  it("accepts one file of each type from the right sources", async () => {
    const { status, body } = await upload(
      [
        item("Website", "ORDERS"),
        item("Marketplace 1", "SETTLEMENT"),
        item("Aggregator 1", "COD_REMITTANCE"),
        item("Aggregator 2", "FREIGHT_INVOICE"),
        item("Warehouse", "RETURN_SCAN"),
      ],
      ["orders", "settlement", "cod", "freight", "scans"].map((name) => ({
        name: `${name}.csv`,
        data: uniqueCsv(),
      })),
    );
    expect(status).toBe(201);
    expect(body.summary).toEqual({ fileCount: 5, accepted: 5, duplicate: 0, rejected: 0 });
    const types = (await prisma.uploadedFile.findMany()).map((row) => row.fileType).sort();
    expect(types).toEqual([
      "COD_REMITTANCE",
      "FREIGHT_INVOICE",
      "ORDERS",
      "RETURN_SCAN",
      "SETTLEMENT",
    ]);
    expect(await prisma.uploadBatch.count()).toBe(1);
  });

  it("returns one result per file in order, with a valid, a duplicate and two invalid files", async () => {
    const dup = uniqueCsv();
    await upload([item("Website")], [{ name: "seed.csv", data: dup }]);

    const { status, body } = await upload(
      [item("Website"), item("Website"), item("Website"), item("Website")],
      [
        { name: "good.csv", data: uniqueCsv() },
        { name: "again.csv", data: dup },
        { name: "notes.txt", data: Buffer.from("hello") },
        { name: "fake.xlsx", data: Buffer.from("order_id,amount\n1,2\n") },
      ],
    );

    expect(status).toBe(201);
    expect(body.results.map((result) => [result.index, result.status])).toEqual([
      [0, "ACCEPTED"],
      [1, "DUPLICATE"],
      [2, "REJECTED"],
      [3, "REJECTED"],
    ]);
    expect(body.results[2]).toMatchObject({ reason: "UNSUPPORTED_EXTENSION" });
    expect(body.results[3]).toMatchObject({ reason: "SIGNATURE_MISMATCH" });
    expect(body.summary).toEqual({ fileCount: 4, accepted: 1, duplicate: 1, rejected: 2 });
    const batch = await prisma.uploadBatch.findUniqueOrThrow({ where: { id: body.batchId } });
    expect(batch).toMatchObject({
      fileCount: 4,
      acceptedCount: 1,
      duplicateCount: 1,
      rejectedCount: 2,
    });
    expect(await prisma.uploadedFile.count()).toBe(2);
    expect(await waitForNoFiles(tempDir)).toBe(0);
  });
});

describe("POST /api/uploads: rejected files", () => {
  const csv = () => uniqueCsv();

  const cases: [string, () => { name: string; data: Buffer }, () => unknown, string][] = [
    [
      "an unsupported extension",
      () => ({ name: "notes.txt", data: Buffer.from("a,b\n1,2\n") }),
      () => item("Website"),
      "UNSUPPORTED_EXTENSION",
    ],
    [
      "an empty file",
      () => ({ name: "empty.csv", data: Buffer.alloc(0) }),
      () => item("Website"),
      "EMPTY_FILE",
    ],
    [
      "text renamed to .xlsx",
      () => ({ name: "fake.xlsx", data: csv() }),
      () => item("Website"),
      "SIGNATURE_MISMATCH",
    ],
    [
      "text renamed to .xls",
      () => ({ name: "fake.xls", data: csv() }),
      () => item("Website"),
      "SIGNATURE_MISMATCH",
    ],
    [
      "an xlsx renamed to .csv",
      () => ({ name: "fake.csv", data: uniqueWorkbook("xlsx") }),
      () => item("Website"),
      "SIGNATURE_MISMATCH",
    ],
    [
      "a CSV with no header",
      () => ({ name: "blank.csv", data: Buffer.from("\n\n  \n") }),
      () => item("Website"),
      "NO_HEADER",
    ],
    [
      "a spreadsheet with an empty first row",
      () => ({ name: "gap.xlsx", data: workbookBuffer([[], ["A1", 2]], "xlsx") }),
      () => item("Website"),
      "NO_HEADER",
    ],
    [
      "an unknown source",
      csvCase,
      () => ({ sourceId: randomUUID(), fileType: "ORDERS" }),
      "UNKNOWN_SOURCE",
    ],
    [
      "a file type the source does not send",
      csvCase,
      () => item("Warehouse", "ORDERS"),
      "FILE_TYPE_NOT_ALLOWED",
    ],
    [
      "settlement data from the website",
      csvCase,
      () => item("Website", "SETTLEMENT"),
      "FILE_TYPE_NOT_ALLOWED",
    ],
  ];

  function csvCase() {
    return { name: "orders.csv", data: uniqueCsv() };
  }

  it.each(cases)(
    "answers 422 for %s and stores nothing",
    async (_name, file, itemFactory, reason) => {
      const { status, body } = await upload([itemFactory()], [file()]);
      expect(status).toBe(422);
      expect(body.summary).toEqual({ fileCount: 1, accepted: 0, duplicate: 0, rejected: 1 });
      expect(body.results[0]).toMatchObject({ status: "REJECTED", reason });
      await expectNothingStored();
      const batch = await prisma.uploadBatch.findUniqueOrThrow({ where: { id: body.batchId } });
      expect(batch).toMatchObject({ acceptedCount: 0, rejectedCount: 1 });
    },
  );

  it("rejects an inactive source", async () => {
    await prisma.source.update({
      where: { id: src("Marketplace 3").id },
      data: { isActive: false },
    });
    try {
      const { status, body } = await upload(
        [item("Marketplace 3")],
        [{ name: "a.csv", data: csv() }],
      );
      expect(status).toBe(422);
      expect(body.results[0]).toMatchObject({ reason: "UNKNOWN_SOURCE" });
      await expectNothingStored();
    } finally {
      await prisma.source.update({
        where: { id: src("Marketplace 3").id },
        data: { isActive: true },
      });
    }
  });

  it("does not echo file content in the rejection message", async () => {
    const secret = "SECRET-CUSTOMER-NAME";
    const { body } = await upload(
      [item("Website")],
      [{ name: "x.xlsx", data: Buffer.from(secret) }],
    );
    expect(JSON.stringify(body.results)).not.toContain(secret);
  });
});

describe("POST /api/uploads: bad requests", () => {
  const good = () => [{ name: "a.csv", data: uniqueCsv() }];

  async function expectNoBatch() {
    expect(await prisma.uploadBatch.count()).toBe(0);
    await expectNothingStored();
  }

  it("answers 400 when no file is attached", async () => {
    const form = new FormData();
    form.append("items", JSON.stringify([item("Website")]));
    const { status } = await api("POST", "/api/uploads", { headers: executive(), body: form });
    expect(status).toBe(400);
    await expectNoBatch();
  });

  it.each([
    ["missing", undefined],
    ["not JSON", "[oops"],
    ["not an array", { sourceId: randomUUID(), fileType: "ORDERS" }],
    ["too short", []],
    [
      "too long",
      [
        { sourceId: randomUUID(), fileType: "ORDERS" },
        { sourceId: randomUUID(), fileType: "ORDERS" },
      ],
    ],
    ["an unknown file type", [{ sourceId: randomUUID(), fileType: "REFUNDS" }]],
    ["a bad source id", [{ sourceId: "1", fileType: "ORDERS" }]],
  ])("answers 422 when items is %s", async (_name, items) => {
    const { status, body } = await upload(items, good());
    expect(status).toBe(422);
    expect(body.error.code).toBe("VALIDATION_FAILED");
    await expectNoBatch();
  });

  it("answers 400 for six files and stores none of them", async () => {
    const files = Array.from({ length: 6 }, (_, index) => ({
      name: `f${index}.csv`,
      data: uniqueCsv(),
    }));
    const { status, body } = await upload(
      files.map(() => item("Website")),
      files,
    );
    expect(status).toBe(400);
    expect(body.error.message).toContain("at most 5");
    await expectNoBatch();
  });

  it("answers 413 when a file is over the limit and stores none of the files", async () => {
    const { status, body } = await upload(
      [item("Website"), item("Website")],
      [
        { name: "ok.csv", data: uniqueCsv() },
        { name: "huge.csv", data: randomBytes(MAX_FILE_BYTES + 4096) },
      ],
    );
    expect(status).toBe(413);
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
    await expectNoBatch();
  });

  it("accepts a file exactly at the size limit", async () => {
    const header = "order_id,amount\n";
    const data = Buffer.concat([
      Buffer.from(header),
      Buffer.alloc(MAX_FILE_BYTES - header.length, 0x61),
    ]);
    expect(data.length).toBe(MAX_FILE_BYTES);
    const { status } = await upload([item("Website")], [{ name: "edge.csv", data }]);
    expect(status).toBe(201);
  });
});

describe("POST /api/uploads: access control", () => {
  it("answers 401 without a session and stores nothing", async () => {
    const { status } = await upload([item("Website")], [{ name: "a.csv", data: uniqueCsv() }], {});
    expect(status).toBe(401);
    expect(await prisma.uploadBatch.count()).toBe(0);
    await expectNothingStored();
  });

  it("answers 403 for the co-founder and stores nothing", async () => {
    const { status } = await upload(
      [item("Website")],
      [{ name: "a.csv", data: uniqueCsv() }],
      founder(),
    );
    expect(status).toBe(403);
    expect(await prisma.uploadBatch.count()).toBe(0);
    await expectNothingStored();
  });
});

describe("upload history", () => {
  async function seedHistory(count: number, sameTime = false) {
    const stamp = new Date("2026-11-08T10:00:00.000Z");
    const batch = await prisma.uploadBatch.create({
      data: { uploadedById: execId, fileCount: count },
    });
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const row = await prisma.uploadedFile.create({
        data: {
          batchId: batch.id,
          sourceId: src(index % 2 === 0 ? "Website" : "Marketplace 1").id,
          fileType: "ORDERS",
          originalName: `f${index}.csv`,
          storagePath: `2026/11/${randomUUID()}.csv`,
          sizeBytes: 10n,
          format: "CSV",
          sha256: randomUUID(),
          headerSignature: "sig",
          uploadedById: execId,
          uploadedAt: sameTime ? stamp : new Date(stamp.getTime() + index * 1000),
          status: index === 0 ? "FAILED" : "NEEDS_MAPPING",
        },
      });
      ids.push(row.id);
    }
    return ids;
  }

  async function readAll(query: string) {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const url: string = `/api/uploads?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await api<UploadPage>("GET", url, { headers: executive() });
      expect(page.status).toBe(200);
      seen.push(...page.body.items.map((entry) => entry.id));
      cursor = page.body.nextCursor;
      if (!cursor) break;
    }
    return seen;
  }

  it("lists newest first and pages through every row exactly once", async () => {
    const ids = await seedHistory(7);
    const seen = await readAll("limit=3");
    expect(seen).toEqual([...ids].reverse());
  });

  it("does not skip or repeat rows that share the same timestamp", async () => {
    const ids = await seedHistory(9, true);
    const seen = await readAll("limit=2");
    expect(seen).toHaveLength(9);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it("filters by source, file type and status", async () => {
    await seedHistory(6);
    const website = await readAll(`sourceId=${src("Website").id}&limit=10`);
    expect(website).toHaveLength(3);
    expect(await readAll("status=FAILED&limit=10")).toHaveLength(1);
    expect(await readAll("fileType=SETTLEMENT&limit=10")).toHaveLength(0);
    expect(await readAll("fileType=ORDERS&status=NEEDS_MAPPING&limit=10")).toHaveLength(5);
  });

  it("returns a real upload with its details and 404 for an unknown id", async () => {
    const { body } = await upload([item("Website")], [{ name: "a.csv", data: uniqueCsv() }]);
    const result = body.results[0];
    if (result?.status !== "ACCEPTED") throw new Error("expected ACCEPTED");

    const found = await api<{ id: string; sourceName: string }>(
      "GET",
      `/api/uploads/${result.file.id}`,
      {
        headers: executive(),
      },
    );
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ id: result.file.id, sourceName: "Website" });

    expect(
      (await api("GET", `/api/uploads/${randomUUID()}`, { headers: executive() })).status,
    ).toBe(404);
  });

  it("rejects bad ids, filters and cursors", async () => {
    for (const url of [
      "/api/uploads/not-a-uuid",
      "/api/uploads?status=WRONG",
      "/api/uploads?limit=0",
      "/api/uploads?cursor=garbage",
    ]) {
      expect((await api("GET", url, { headers: executive() })).status, url).toBe(422);
    }
  });

  it("is closed to guests and the co-founder", async () => {
    expect((await api("GET", "/api/uploads")).status).toBe(401);
    expect((await api("GET", "/api/uploads", { headers: founder() })).status).toBe(403);
  });

  it("never exposes storage paths or hashes", async () => {
    await seedHistory(1);
    const page = await api<UploadPage>("GET", "/api/uploads", { headers: executive() });
    const keys = Object.keys(page.body.items[0] ?? {});
    expect(keys).not.toContain("storagePath");
    expect(keys).not.toContain("sha256");
    expect(keys).not.toContain("headerSignature");
  });
});
