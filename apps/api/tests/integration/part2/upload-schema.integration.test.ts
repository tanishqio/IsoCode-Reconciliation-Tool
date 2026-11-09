import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../../src/db/prisma.js";
import { SOURCE_SEED, seedSources } from "../../../src/db/seed-sources.js";
import { assertTestDatabase } from "../../helpers/test-db.js";

const CLEAN =
  'TRUNCATE TABLE "uploaded_files", "upload_batches", "source_file_types", "sources" CASCADE';

let userId: string;
let otherUserId: string;

beforeAll(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]);
  await prisma.$executeRawUnsafe(CLEAN);
  const user = await prisma.user.create({
    data: {
      email: `schema-${randomUUID()}@example.invalid`,
      name: "U",
      passwordHash: "x",
      role: "FINANCE_EXECUTIVE",
    },
  });
  userId = user.id;
  otherUserId = randomUUID();
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(CLEAN);
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]);
  await prisma.$executeRawUnsafe(CLEAN);
});

async function newSource(name = `Source ${randomUUID()}`) {
  return prisma.source.create({ data: { name, kind: "MARKETPLACE" } });
}

async function newBatch() {
  return prisma.uploadBatch.create({ data: { uploadedById: userId, fileCount: 1 } });
}

async function newFile(
  overrides: Partial<{
    sourceId: string;
    batchId: string;
    sha256: string;
    fileType: "ORDERS" | "SETTLEMENT";
  }> = {},
) {
  const sourceId = overrides.sourceId ?? (await newSource()).id;
  const batchId = overrides.batchId ?? (await newBatch()).id;
  return prisma.uploadedFile.create({
    data: {
      batchId,
      sourceId,
      fileType: overrides.fileType ?? "ORDERS",
      originalName: "a.csv",
      storagePath: "2026/11/a.csv",
      sizeBytes: 123n,
      format: "CSV",
      sha256: overrides.sha256 ?? randomUUID(),
      headerSignature: "sig",
      uploadedById: userId,
    },
  });
}

describe("uploaded_files table", () => {
  it("applies the defaults", async () => {
    const file = await newFile();
    expect(file.status).toBe("NEEDS_MAPPING");
    expect(file.mappingVersionId).toBeNull();
    expect(file.detectedRowCount).toBeNull();
    expect(file.warning).toBeNull();
    expect(file.rowsAccepted).toBeNull();
    expect(file.processedAt).toBeNull();
    expect(file.uploadedAt).toBeInstanceOf(Date);
    expect(file.sizeBytes).toBe(123n);
  });

  it("blocks the same hash for the same source and file type with a unique violation", async () => {
    const source = await newSource();
    await newFile({ sourceId: source.id, sha256: "same-hash" });
    await expect(newFile({ sourceId: source.id, sha256: "same-hash" })).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("allows the same hash for another source or another file type", async () => {
    const one = await newSource();
    const two = await newSource();
    await newFile({ sourceId: one.id, sha256: "h" });
    await expect(newFile({ sourceId: two.id, sha256: "h" })).resolves.toBeDefined();
    await expect(
      newFile({ sourceId: one.id, sha256: "h", fileType: "SETTLEMENT" }),
    ).resolves.toBeDefined();
  });

  it("rejects a file for a source, batch or user that does not exist", async () => {
    const source = await newSource();
    const batch = await newBatch();
    const base = {
      batchId: batch.id,
      sourceId: source.id,
      fileType: "ORDERS" as const,
      originalName: "a.csv",
      storagePath: "p",
      sizeBytes: 1n,
      format: "CSV" as const,
      sha256: randomUUID(),
      headerSignature: "s",
      uploadedById: userId,
    };
    await expect(
      prisma.uploadedFile.create({ data: { ...base, sourceId: randomUUID() } }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      prisma.uploadedFile.create({ data: { ...base, batchId: randomUUID() } }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      prisma.uploadedFile.create({ data: { ...base, uploadedById: otherUserId } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("does not let a source or batch with files be deleted", async () => {
    const file = await newFile();
    await expect(prisma.source.delete({ where: { id: file.sourceId } })).rejects.toMatchObject({
      code: "P2003",
    });
    await expect(prisma.uploadBatch.delete({ where: { id: file.batchId } })).rejects.toMatchObject({
      code: "P2003",
    });
  });

  it("rejects a file type, format or status that is not in the list", async () => {
    const source = await newSource();
    const batch = await newBatch();
    const attempt = (patch: Record<string, unknown>) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "uploaded_files" ("id","batchId","sourceId","fileType","originalName","storagePath","sizeBytes","format","sha256","headerSignature","status","uploadedById")
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::"FileType",'a','p',1,$5::"FileFormat",$6,'s',$7::"FileStatus",$8::uuid)`,
        randomUUID(),
        batch.id,
        source.id,
        patch["fileType"] ?? "ORDERS",
        patch["format"] ?? "CSV",
        randomUUID(),
        patch["status"] ?? "NEEDS_MAPPING",
        userId,
      );
    await expect(attempt({})).resolves.toBe(1);
    await expect(attempt({ fileType: "REFUNDS" })).rejects.toThrow();
    await expect(attempt({ format: "PDF" })).rejects.toThrow();
    await expect(attempt({ status: "DONE" })).rejects.toThrow();
  });

  it("stores file sizes above 2 GB without overflow", async () => {
    const file = await prisma.uploadedFile.update({
      where: { id: (await newFile()).id },
      data: { sizeBytes: 5_000_000_000n },
    });
    expect(file.sizeBytes).toBe(5_000_000_000n);
  });
});

describe("sources and source_file_types", () => {
  it("keeps source names unique", async () => {
    await newSource("Dup Name");
    await expect(newSource("Dup Name")).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows each file type once per source", async () => {
    const source = await newSource();
    await prisma.sourceFileType.create({ data: { sourceId: source.id, fileType: "ORDERS" } });
    await expect(
      prisma.sourceFileType.create({ data: { sourceId: source.id, fileType: "ORDERS" } }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      prisma.sourceFileType.create({ data: { sourceId: source.id, fileType: "SETTLEMENT" } }),
    ).resolves.toBeDefined();
  });

  it("removes a source's allowed file types when the source is deleted", async () => {
    const source = await newSource();
    await prisma.sourceFileType.create({ data: { sourceId: source.id, fileType: "ORDERS" } });
    await prisma.source.delete({ where: { id: source.id } });
    expect(await prisma.sourceFileType.count()).toBe(0);
  });
});

describe("upload_batches table", () => {
  it("starts every counter at zero", async () => {
    const batch = await newBatch();
    expect(batch).toMatchObject({
      acceptedCount: 0,
      duplicateCount: 0,
      rejectedCount: 0,
      fileCount: 1,
    });
  });

  it("belongs to an existing user", async () => {
    await expect(
      prisma.uploadBatch.create({ data: { uploadedById: otherUserId, fileCount: 1 } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });
});

describe("seedSources", () => {
  it("creates every source with its file types", async () => {
    await seedSources(prisma);
    expect(await prisma.source.count()).toBe(SOURCE_SEED.length);
    const expectedLinks = SOURCE_SEED.reduce((sum, source) => sum + source.fileTypes.length, 0);
    expect(await prisma.sourceFileType.count()).toBe(expectedLinks);
  });

  it("can run twice without creating duplicates", async () => {
    await seedSources(prisma);
    const ids = (await prisma.source.findMany({ orderBy: { name: "asc" } })).map(
      (source) => source.id,
    );
    await seedSources(prisma);
    expect(await prisma.source.count()).toBe(SOURCE_SEED.length);
    expect(
      (await prisma.source.findMany({ orderBy: { name: "asc" } })).map((source) => source.id),
    ).toEqual(ids);
    const expectedLinks = SOURCE_SEED.reduce((sum, source) => sum + source.fileTypes.length, 0);
    expect(await prisma.sourceFileType.count()).toBe(expectedLinks);
  });

  it("adds a missing file type without removing existing data", async () => {
    await seedSources(prisma);
    const website = await prisma.source.findUniqueOrThrow({ where: { name: "Website" } });
    await prisma.sourceFileType.deleteMany({ where: { sourceId: website.id } });
    await seedSources(prisma);
    expect(await prisma.sourceFileType.count({ where: { sourceId: website.id } })).toBe(1);
  });
});
