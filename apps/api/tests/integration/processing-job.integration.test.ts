import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/prisma.js";
import { assertTestDatabase } from "../helpers/test-db.js";

beforeEach(async () => {
  // Safety: never empty tables unless this is clearly the test database.
  assertTestDatabase(process.env["DATABASE_URL"]);
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "processing_jobs", "users" CASCADE');
});

afterAll(async () => {
  await prisma.$disconnect();
});

function newUser(overrides: { email?: string } = {}) {
  return prisma.user.create({
    data: {
      email: overrides.email ?? `user-${randomUUID()}@example.invalid`,
      name: "Test User",
      passwordHash: "not-a-real-hash",
      role: "FINANCE_EXECUTIVE",
    },
  });
}

describe("users table", () => {
  it("applies the defaults", async () => {
    const user = await newUser();
    expect(user.isActive).toBe(true);
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeNull();
    expect(user.lastLoginAt).toBeNull();
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects a second user with the same email", async () => {
    await newUser({ email: "same@example.invalid" });
    await expect(newUser({ email: "same@example.invalid" })).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("stores both roles from the brief and rejects any other role", async () => {
    const executive = await newUser();
    const founder = await prisma.user.create({
      data: { email: "founder@example.invalid", name: "F", passwordHash: "x", role: "CO_FOUNDER" },
    });
    expect([executive.role, founder.role]).toEqual(["FINANCE_EXECUTIVE", "CO_FOUNDER"]);
    await expect(
      prisma.$executeRaw`INSERT INTO users (id, email, name, "passwordHash", role, "updatedAt")
        VALUES (${randomUUID()}::uuid, 'bad@example.invalid', 'B', 'x', 'ADMIN'::"Role", now())`,
    ).rejects.toThrow();
  });

  it("updates updatedAt when a row changes", async () => {
    const user = await newUser();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const changed = await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 1 },
    });
    expect(changed.updatedAt.getTime()).toBeGreaterThan(user.updatedAt.getTime());
  });
});

describe("processing_jobs table", () => {
  it("creates a job with the defaults the worker relies on", async () => {
    const user = await newUser();
    const job = await prisma.processingJob.create({
      data: {
        type: "INGEST_FILE",
        entityType: "UPLOADED_FILE",
        entityId: randomUUID(),
        createdById: user.id,
      },
    });
    expect(job.status).toBe("QUEUED");
    expect(job.progressPct).toBe(0);
    expect(job.attempt).toBe(0);
    expect(job.stage).toBeNull();
    expect(job.heartbeatAt).toBeNull();
    expect(job.startedAt).toBeNull();
    expect(job.finishedAt).toBeNull();
    expect(job.errorMessage).toBeNull();
    expect(job.queuedAt).toBeInstanceOf(Date);
  });

  it("walks through a full run: QUEUED, RUNNING, SUCCEEDED, keeping stage timings", async () => {
    const user = await newUser();
    const created = await prisma.processingJob.create({
      data: { type: "INGEST_FILE", entityType: "UPLOADED_FILE", createdById: user.id },
    });

    await prisma.processingJob.update({
      where: { id: created.id },
      data: {
        status: "RUNNING",
        stage: "READ",
        progressPct: 5,
        startedAt: new Date(),
        heartbeatAt: new Date(),
      },
    });
    const timings = { read: 9000, normalise: 4000, match: 11000 };
    await prisma.processingJob.update({
      where: { id: created.id },
      data: {
        status: "SUCCEEDED",
        progressPct: 100,
        finishedAt: new Date(),
        stageTimingsMs: timings,
      },
    });

    const final = await prisma.processingJob.findUniqueOrThrow({ where: { id: created.id } });
    expect(final.status).toBe("SUCCEEDED");
    expect(final.progressPct).toBe(100);
    expect(final.stageTimingsMs).toEqual(timings);
    expect(final.startedAt).toBeInstanceOf(Date);
    expect(final.finishedAt).toBeInstanceOf(Date);
  });

  it("records a failure with an error message", async () => {
    const user = await newUser();
    const job = await prisma.processingJob.create({
      data: { type: "RECOMPUTE_RESULTS", entityType: "RATE_CARD", createdById: user.id },
    });
    const failed = await prisma.processingJob.update({
      where: { id: job.id },
      data: { status: "FAILED", attempt: { increment: 1 }, errorMessage: "File is corrupted" },
    });
    expect(failed.status).toBe("FAILED");
    expect(failed.attempt).toBe(1);
    expect(failed.errorMessage).toBe("File is corrupted");
  });

  it("round-trips a JSON params object, including nested values", async () => {
    const user = await newUser();
    const params = {
      rateCardVersion: 3,
      options: { dryRun: false, channels: ["Website", "Marketplace 1"] },
    };
    const job = await prisma.processingJob.create({
      data: { type: "RECOMPUTE_RESULTS", entityType: "RATE_CARD", params, createdById: user.id },
    });
    const read = await prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(read.params).toEqual(params);
  });

  it("can find jobs by status in queue order (the query a worker would run)", async () => {
    const user = await newUser();
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      await prisma.processingJob.create({
        data: {
          type: "INGEST_FILE",
          entityType: "UPLOADED_FILE",
          createdById: user.id,
          queuedAt: new Date(base + i * 1000),
          status: i === 1 ? "RUNNING" : "QUEUED",
        },
      });
    }
    const queued = await prisma.processingJob.findMany({
      where: { status: "QUEUED" },
      orderBy: { queuedAt: "asc" },
    });
    expect(queued).toHaveLength(2);
    expect(queued[0]!.queuedAt.getTime()).toBeLessThan(queued[1]!.queuedAt.getTime());
  });

  it("finds jobs by the entity they work on", async () => {
    const user = await newUser();
    const fileId = randomUUID();
    await prisma.processingJob.create({
      data: {
        type: "INGEST_FILE",
        entityType: "UPLOADED_FILE",
        entityId: fileId,
        createdById: user.id,
      },
    });
    await prisma.processingJob.create({
      data: {
        type: "INGEST_FILE",
        entityType: "UPLOADED_FILE",
        entityId: randomUUID(),
        createdById: user.id,
      },
    });
    const found = await prisma.processingJob.findMany({
      where: { entityType: "UPLOADED_FILE", entityId: fileId },
    });
    expect(found).toHaveLength(1);
  });

  it("rejects a job whose creator does not exist (foreign key)", async () => {
    await expect(
      prisma.processingJob.create({
        data: { type: "INGEST_FILE", entityType: "UPLOADED_FILE", createdById: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("refuses to delete a user who still has jobs", async () => {
    const user = await newUser();
    await prisma.processingJob.create({
      data: { type: "BUILD_CLAIMS", entityType: "CLAIM_RUN", createdById: user.id },
    });
    await expect(prisma.user.delete({ where: { id: user.id } })).rejects.toMatchObject({
      code: "P2003",
    });
  });

  it("rejects an unknown job type or status at the database level", async () => {
    const user = await newUser();
    await expect(
      prisma.$executeRaw`INSERT INTO processing_jobs (id, type, "entityType", "createdById")
        VALUES (${randomUUID()}::uuid, 'MINE_BITCOIN'::"JobType", 'X', ${user.id}::uuid)`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`INSERT INTO processing_jobs (id, type, "entityType", status, "createdById")
        VALUES (${randomUUID()}::uuid, 'INGEST_FILE', 'X', 'PAUSED'::"JobStatus", ${user.id}::uuid)`,
    ).rejects.toThrow();
  });
});
