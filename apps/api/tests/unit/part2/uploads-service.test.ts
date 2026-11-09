import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/lib/errors.js";
import { buildHeaderSignature } from "../../../src/lib/header-signature.js";
import type { AuditEntry, AuditWriter } from "../../../src/modules/uploads/uploads.service.js";
import { countFiles, makeTempDir, uniqueWorkbook } from "../../helpers/part2-fixtures.js";

type ServiceModule = typeof import("../../../src/modules/uploads/uploads.service.js");
type ClientModule = typeof import("../../../generated/prisma/client.js");

let tempDir: string;
let uploadDir: string;
let service: ServiceModule;
let Prisma: ClientModule["Prisma"];

const userId = randomUUID();
const batchId = randomUUID();
const sourceId = randomUUID();
const websiteSource = {
  id: sourceId,
  name: "Website",
  isActive: true,
  fileTypes: [{ fileType: "ORDERS" as const }],
};

beforeAll(async () => {
  tempDir = makeTempDir("service-temp");
  uploadDir = makeTempDir("service-uploads");
  process.env["UPLOAD_TEMP_DIR"] = tempDir;
  process.env["UPLOAD_DIR"] = uploadDir;
  service = await import("../../../src/modules/uploads/uploads.service.js");
  ({ Prisma } = await import("../../../generated/prisma/client.js"));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(uploadDir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(uploadDir, { recursive: true, force: true });
});

let fileCounter = 0;

function makeFile(name: string, content: Buffer | string): Express.Multer.File {
  fileCounter += 1;
  const data = typeof content === "string" ? Buffer.from(content) : content;
  const tempPath = path.join(tempDir, `incoming-${fileCounter}.part`);
  return {
    originalname: name,
    tempPath,
    sha256: createHash("sha256").update(data).digest("hex"),
    sizeBytes: data.length,
    headBytes: data.subarray(0, 8),
    _data: data,
  } as unknown as Express.Multer.File;
}

async function persist(file: Express.Multer.File): Promise<Express.Multer.File> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(file.tempPath), { recursive: true });
  writeFileSync(file.tempPath, (file as unknown as { _data: Buffer })._data);
  return file;
}

async function csvFile(name = "orders.csv", content = `order_id,amount\nA-${randomUUID()},100\n`) {
  return persist(makeFile(name, content));
}

interface FakeOptions {
  sources?: (typeof websiteSource)[];
  existing?: { id: string } | null;
  create?: (args: { data: Record<string, unknown> }) => Promise<unknown>;
}

function makePrisma(options: FakeOptions = {}) {
  const existingRow = {
    id: randomUUID(),
    originalName: "first.csv",
    uploadedAt: new Date("2026-11-01T00:00:00Z"),
  };
  const rowFrom = (data: Record<string, unknown>) => ({
    mappingVersionId: null,
    rowsAccepted: null,
    rowsRejected: null,
    rowsDuplicate: null,
    processedAt: null,
    uploadedAt: new Date("2026-11-08T10:00:00Z"),
    ...data,
    source: { name: "Website" },
  });
  return {
    existingRow,
    client: {
      source: {
        findMany: vi.fn<(args: unknown) => Promise<unknown[]>>(
          async () => options.sources ?? [websiteSource],
        ),
      },
      processingJob: { findMany: vi.fn(async () => []) },
      uploadBatch: {
        create: vi.fn(async () => ({ id: batchId })),
        update: vi.fn(async () => ({})),
      },
      uploadedFile: {
        findUnique: vi.fn<(args: unknown) => Promise<unknown>>(
          async () => options.existing ?? null,
        ),
        findUniqueOrThrow: vi.fn(async () => existingRow),
        create: vi.fn(async (args: { data: Record<string, unknown> }) =>
          options.create ? options.create(args) : rowFrom(args.data),
        ),
        findMany: vi.fn<(args: unknown) => Promise<unknown[]>>(async () => []),
      },
    },
  };
}

function build(options: FakeOptions = {}) {
  const fake = makePrisma(options);
  const audit = vi.fn<AuditWriter>(async () => undefined);
  const instance = service.createUploadsService({ prisma: fake.client as never, audit });
  return { ...fake, audit, instance };
}

const orders = (sourceIdValue = sourceId) => ({
  sourceId: sourceIdValue,
  fileType: "ORDERS" as const,
});

describe("processUpload: accepted file", () => {
  it("moves the file into storage, saves the row and records the upload", async () => {
    const { instance, client, audit } = build();
    const file = await csvFile("orders.csv", "Order ID,Amount\nA1,100\nA2,200\n");

    const outcome = await instance.processUpload({ userId, files: [file], items: [orders()] });

    expect(outcome.summary).toEqual({ fileCount: 1, accepted: 1, duplicate: 0, rejected: 0 });
    const result = outcome.results[0];
    expect(result?.status).toBe("ACCEPTED");

    const data = client.uploadedFile.create.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(data).toMatchObject({
      batchId,
      sourceId,
      fileType: "ORDERS",
      originalName: "orders.csv",
      sizeBytes: BigInt(file.sizeBytes),
      format: "CSV",
      sha256: file.sha256,
      headerSignature: buildHeaderSignature(["Order ID", "Amount"]),
      detectedRowCount: 2,
      warning: null,
      status: "NEEDS_MAPPING",
      uploadedById: userId,
    });
    expect(data["storagePath"]).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.csv$/);

    const stored = path.join(uploadDir, String(data["storagePath"]));
    expect(readFileSync(stored, "utf8")).toBe("Order ID,Amount\nA1,100\nA2,200\n");
    expect(existsSync(file.tempPath)).toBe(false);

    expect(audit).toHaveBeenCalledTimes(1);
    const entry = audit.mock.calls[0]?.[0] as AuditEntry;
    expect(entry).toMatchObject({ userId, action: "UPLOAD", entityType: "UPLOADED_FILE" });
    expect(JSON.stringify(entry)).not.toContain("orders.csv");

    expect(client.uploadBatch.update).toHaveBeenCalledWith({
      where: { id: batchId },
      data: { acceptedCount: 1, duplicateCount: 0, rejectedCount: 0 },
    });
  });

  it("stores the extension from the detected format, not from the uploaded name", async () => {
    const { instance, client } = build();
    const file = await csvFile("Orders.CSV");
    await instance.processUpload({ userId, files: [file], items: [orders()] });
    const data = client.uploadedFile.create.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(String(data["storagePath"])).toMatch(/\.csv$/);
  });

  it("accepts real xlsx and xls files", async () => {
    const { instance, client } = build();
    const xlsx = await persist(makeFile("a.xlsx", uniqueWorkbook("xlsx")));
    const xls = await persist(makeFile("b.xls", uniqueWorkbook("biff8")));
    const outcome = await instance.processUpload({
      userId,
      files: [xlsx, xls],
      items: [orders(), orders()],
    });
    expect(outcome.summary.accepted).toBe(2);
    const formats = client.uploadedFile.create.mock.calls.map(
      (call) => (call[0].data as { format: string }).format,
    );
    expect(formats).toEqual(["XLSX", "XLS"]);
  });

  it("returns the file as a plain JSON-safe object", async () => {
    const { instance } = build();
    const outcome = await instance.processUpload({
      userId,
      files: [await csvFile()],
      items: [orders()],
    });
    expect(() => JSON.stringify(outcome)).not.toThrow();
    const result = outcome.results[0];
    if (result?.status !== "ACCEPTED") throw new Error("expected ACCEPTED");
    expect(typeof result.file.sizeBytes).toBe("number");
    expect(result.file.sourceName).toBe("Website");
    expect(result.file.status).toBe("NEEDS_MAPPING");
  });

  it("does not fail the upload when writing the audit entry fails", async () => {
    const { instance, audit } = build();
    audit.mockRejectedValueOnce(new Error("audit store down"));
    const outcome = await instance.processUpload({
      userId,
      files: [await csvFile()],
      items: [orders()],
    });
    expect(outcome.summary.accepted).toBe(1);
  });
});

describe("processUpload: rejected files", () => {
  async function expectRejected(
    file: Express.Multer.File,
    reason: string,
    setup: FakeOptions = {},
    item = orders(),
  ) {
    const { instance, client } = build(setup);
    const outcome = await instance.processUpload({ userId, files: [file], items: [item] });
    const result = outcome.results[0];
    expect(result).toMatchObject({ status: "REJECTED", reason });
    expect(outcome.summary).toMatchObject({ accepted: 0, rejected: 1 });
    expect(client.uploadedFile.create).not.toHaveBeenCalled();
    expect(existsSync(file.tempPath)).toBe(false);
    expect(countFiles(uploadDir)).toBe(0);
  }

  it("rejects an unsupported extension", async () => {
    await expectRejected(
      await persist(makeFile("notes.txt", "a,b\n1,2\n")),
      "UNSUPPORTED_EXTENSION",
    );
  });

  it("rejects an empty file", async () => {
    await expectRejected(await persist(makeFile("empty.csv", "")), "EMPTY_FILE");
  });

  it("rejects text renamed to .xlsx", async () => {
    await expectRejected(await persist(makeFile("fake.xlsx", "a,b\n1,2\n")), "SIGNATURE_MISMATCH");
  });

  it("rejects a source id that does not exist", async () => {
    await expectRejected(await csvFile(), "UNKNOWN_SOURCE", {}, orders(randomUUID()));
  });

  it("rejects an inactive source", async () => {
    await expectRejected(await csvFile(), "UNKNOWN_SOURCE", {
      sources: [{ ...websiteSource, isActive: false }],
    });
  });

  it("rejects a file type the source does not send", async () => {
    const { instance, client } = build();
    const file = await csvFile();
    const outcome = await instance.processUpload({
      userId,
      files: [file],
      items: [{ sourceId, fileType: "FREIGHT_INVOICE" }],
    });
    expect(outcome.results[0]).toMatchObject({
      status: "REJECTED",
      reason: "FILE_TYPE_NOT_ALLOWED",
    });
    expect(client.uploadedFile.create).not.toHaveBeenCalled();
  });

  it("rejects a CSV with no header and keeps nothing in storage", async () => {
    await expectRejected(await persist(makeFile("blank.csv", "\n\n   \n")), "NO_HEADER");
  });

  it("does not look for duplicates before the cheap checks pass", async () => {
    const { instance, client } = build();
    await instance.processUpload({
      userId,
      files: [await persist(makeFile("a.txt", "x"))],
      items: [orders()],
    });
    expect(client.uploadedFile.findUnique).not.toHaveBeenCalled();
  });
});

describe("processUpload: duplicates", () => {
  it("reports a duplicate found before saving, deletes the temp file and audits it", async () => {
    const existing = { id: randomUUID() };
    const { instance, client, audit, existingRow } = build({ existing });
    const file = await csvFile();

    const outcome = await instance.processUpload({ userId, files: [file], items: [orders()] });

    expect(outcome.summary).toEqual({ fileCount: 1, accepted: 0, duplicate: 1, rejected: 0 });
    expect(outcome.results[0]).toMatchObject({
      status: "DUPLICATE",
      existing: { id: existingRow.id, originalName: "first.csv" },
    });
    expect(client.uploadedFile.create).not.toHaveBeenCalled();
    expect(existsSync(file.tempPath)).toBe(false);
    expect(countFiles(uploadDir)).toBe(0);
    expect(audit.mock.calls[0]?.[0]).toMatchObject({
      action: "DUPLICATE_BLOCKED",
      entityId: existingRow.id,
    });
  });

  it("checks for duplicates using the source, file type and hash together", async () => {
    const { instance, client } = build();
    const file = await csvFile();
    await instance.processUpload({ userId, files: [file], items: [orders()] });
    expect(client.uploadedFile.findUnique).toHaveBeenCalledWith({
      where: { sourceId_fileType_sha256: { sourceId, fileType: "ORDERS", sha256: file.sha256 } },
      select: { id: true },
    });
  });

  it("treats a database unique violation (a race) as a duplicate and removes the stored copy", async () => {
    const { instance, client } = build({
      create: async () => {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
        });
      },
    });
    const file = await csvFile();
    const outcome = await instance.processUpload({ userId, files: [file], items: [orders()] });

    expect(outcome.results[0]?.status).toBe("DUPLICATE");
    expect(outcome.summary.duplicate).toBe(1);
    expect(client.uploadedFile.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    expect(countFiles(uploadDir)).toBe(0);
    expect(existsSync(file.tempPath)).toBe(false);
  });
});

describe("processUpload: failures", () => {
  it("rethrows an unexpected database error, removes the stored copy and still updates the batch", async () => {
    const { instance, client } = build({
      create: async () => {
        throw new Error("connection reset");
      },
    });
    const file = await csvFile();

    await expect(
      instance.processUpload({ userId, files: [file], items: [orders()] }),
    ).rejects.toThrow("connection reset");
    expect(countFiles(uploadDir)).toBe(0);
    expect(existsSync(file.tempPath)).toBe(false);
    expect(client.uploadBatch.update).toHaveBeenCalledTimes(1);
  });

  it("removes the temp files of files that were never reached when one file fails", async () => {
    const { instance } = build({
      create: async () => {
        throw new Error("boom");
      },
    });
    const first = await csvFile();
    const second = await csvFile();
    await expect(
      instance.processUpload({ userId, files: [first, second], items: [orders(), orders()] }),
    ).rejects.toThrow("boom");
    expect(existsSync(second.tempPath)).toBe(false);
    expect(countFiles(tempDir)).toBe(0);
  });

  it("throws a validation error when files and items do not line up, before touching the database", async () => {
    const { instance, client } = build();
    await expect(
      instance.processUpload({ userId, files: [await csvFile()], items: [] }),
    ).rejects.toBeInstanceOf(AppError);
    expect(client.uploadBatch.create).not.toHaveBeenCalled();
  });
});

describe("processUpload: several files in one batch", () => {
  it("handles accepted, duplicate and rejected files together and counts them", async () => {
    const { instance, client } = build();
    client.uploadedFile.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: randomUUID() })
      .mockResolvedValue(null);

    const files = [
      await csvFile("good.csv"),
      await csvFile("again.csv"),
      await persist(makeFile("bad.txt", "x")),
    ];
    const outcome = await instance.processUpload({
      userId,
      files,
      items: [orders(), orders(), orders()],
    });

    expect(outcome.results.map((result) => [result.index, result.status])).toEqual([
      [0, "ACCEPTED"],
      [1, "DUPLICATE"],
      [2, "REJECTED"],
    ]);
    expect(outcome.summary).toEqual({ fileCount: 3, accepted: 1, duplicate: 1, rejected: 1 });
    expect(client.uploadBatch.update).toHaveBeenCalledWith({
      where: { id: batchId },
      data: { acceptedCount: 1, duplicateCount: 1, rejectedCount: 1 },
    });
    expect(countFiles(tempDir)).toBe(0);
    expect(countFiles(uploadDir)).toBe(1);
  });

  it("processes files one after another so the first is saved before the second is checked", async () => {
    const { instance, client } = build();
    const order: string[] = [];
    client.uploadedFile.findUnique.mockImplementation(async () => {
      order.push("check");
      return null;
    });
    client.uploadedFile.create.mockImplementation(
      async (args: { data: Record<string, unknown> }) => {
        order.push("create");
        return {
          ...args.data,
          mappingVersionId: null,
          rowsAccepted: null,
          rowsRejected: null,
          rowsDuplicate: null,
          processedAt: null,
          uploadedAt: new Date(),
          source: { name: "Website" },
        };
      },
    );
    await instance.processUpload({
      userId,
      files: [await csvFile(), await csvFile()],
      items: [orders(), orders()],
    });
    expect(order).toEqual(["check", "create", "check", "create"]);
  });

  it("loads each distinct source once", async () => {
    const { instance, client } = build();
    await instance.processUpload({
      userId,
      files: [await csvFile(), await csvFile()],
      items: [orders(), orders()],
    });
    expect(client.source.findMany).toHaveBeenCalledTimes(1);
    expect(client.source.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: { in: [sourceId] } },
    });
  });
});

describe("listUploads and getUpload", () => {
  function row(id: string, uploadedAt: string) {
    return {
      id,
      batchId,
      sourceId,
      fileType: "ORDERS",
      originalName: "a.csv",
      storagePath: "2026/11/x.csv",
      sizeBytes: 123n,
      format: "CSV",
      sha256: "x",
      headerSignature: "y",
      detectedRowCount: 5,
      warning: null,
      status: "NEEDS_MAPPING",
      mappingVersionId: null,
      rowsAccepted: null,
      rowsRejected: null,
      rowsDuplicate: null,
      uploadedById: userId,
      uploadedAt: new Date(uploadedAt),
      processedAt: null,
      source: { name: "Website" },
    };
  }

  it("returns a page and a cursor when more rows exist", async () => {
    const { instance, client } = build();
    client.uploadedFile.findMany.mockResolvedValue([
      row(randomUUID(), "2026-11-08T10:00:03Z"),
      row(randomUUID(), "2026-11-08T10:00:02Z"),
      row(randomUUID(), "2026-11-08T10:00:01Z"),
    ] as never);

    const page = await instance.listUploads({ limit: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    expect(client.uploadedFile.findMany.mock.calls[0]?.[0]).toMatchObject({
      take: 3,
      orderBy: [{ uploadedAt: "desc" }, { id: "desc" }],
    });
  });

  it("returns no cursor on the last page and converts the BigInt size", async () => {
    const { instance, client } = build();
    client.uploadedFile.findMany.mockResolvedValue([
      row(randomUUID(), "2026-11-08T10:00:00Z"),
    ] as never);
    const page = await instance.listUploads({ limit: 2 });
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toMatchObject({ sizeBytes: 123, uploadedAt: "2026-11-08T10:00:00.000Z" });
    expect(() => JSON.stringify(page)).not.toThrow();
  });

  it("turns the cursor into a keyset condition and passes the filters", async () => {
    const { instance, client } = build();
    const cursor = { uploadedAt: new Date("2026-11-08T10:00:00.000Z"), id: randomUUID() };
    const { encodeCursor } = await import("../../../src/modules/uploads/uploads.schemas.js");
    await instance.listUploads({
      limit: 10,
      sourceId,
      fileType: "SETTLEMENT",
      status: "FAILED",
      cursor: encodeCursor(cursor),
    });
    expect(client.uploadedFile.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        sourceId,
        fileType: "SETTLEMENT",
        status: "FAILED",
        OR: [
          { uploadedAt: { lt: cursor.uploadedAt } },
          { uploadedAt: cursor.uploadedAt, id: { lt: cursor.id } },
        ],
      },
    });
  });

  it("rejects a malformed cursor", async () => {
    const { instance } = build();
    await expect(instance.listUploads({ limit: 10, cursor: "garbage" })).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("getUpload returns 404 for an unknown id", async () => {
    const { instance, client } = build();
    (
      client.uploadedFile as unknown as { findUnique: ReturnType<typeof vi.fn> }
    ).findUnique.mockResolvedValue(null);
    await expect(instance.getUpload(randomUUID())).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });
});
