import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/prisma.js";

afterAll(async () => {
  await prisma.$disconnect();
});

async function columns(table: string) {
  return prisma.$queryRaw<
    Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>
  >`SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table}
      ORDER BY ordinal_position`;
}

async function enumLabels(typeName: string) {
  const rows = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
    SELECT e.enumlabel
      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = ${typeName}
      ORDER BY e.enumsortorder`;
  return rows.map((r) => r.enumlabel);
}

describe("migrated schema: tables", () => {
  it("has the users and processing_jobs tables and the Prisma migration history", async () => {
    const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    const names = rows.map((r) => r.tablename);
    expect(names).toContain("users");
    expect(names).toContain("processing_jobs");
    expect(names).toContain("_prisma_migrations");
  });

  it("has applied the init migration successfully", async () => {
    const rows = await prisma.$queryRaw<
      Array<{ migration_name: string; finished_at: Date | null }>
    >`
      SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name LIKE '%\_init'`;
    expect(rows.length).toBe(1);
    expect(rows[0]?.finished_at).not.toBeNull();
  });
});

describe("migrated schema: processing_jobs", () => {
  it("has exactly the designed columns", async () => {
    const names = (await columns("processing_jobs")).map((c) => c.column_name).sort();
    expect(names).toEqual(
      [
        "id",
        "type",
        "entityType",
        "entityId",
        "params",
        "status",
        "stage",
        "progressPct",
        "attempt",
        "heartbeatAt",
        "stageTimingsMs",
        "errorMessage",
        "createdById",
        "queuedAt",
        "startedAt",
        "finishedAt",
      ].sort(),
    );
  });

  it("marks the right columns required and optional", async () => {
    const cols = Object.fromEntries(
      (await columns("processing_jobs")).map((c) => [c.column_name, c]),
    );
    for (const required of [
      "id",
      "type",
      "entityType",
      "status",
      "progressPct",
      "attempt",
      "createdById",
      "queuedAt",
    ]) {
      expect(cols[required]?.is_nullable, required).toBe("NO");
    }
    for (const optional of [
      "entityId",
      "params",
      "stage",
      "heartbeatAt",
      "stageTimingsMs",
      "errorMessage",
      "startedAt",
      "finishedAt",
    ]) {
      expect(cols[optional]?.is_nullable, optional).toBe("YES");
    }
  });

  it("stores params and stageTimingsMs as JSONB and ids as UUID", async () => {
    const cols = Object.fromEntries(
      (await columns("processing_jobs")).map((c) => [c.column_name, c]),
    );
    expect(cols["params"]?.data_type).toBe("jsonb");
    expect(cols["stageTimingsMs"]?.data_type).toBe("jsonb");
    expect(cols["id"]?.data_type).toBe("uuid");
    expect(cols["createdById"]?.data_type).toBe("uuid");
  });

  it("defaults status to QUEUED and the counters to 0", async () => {
    const cols = Object.fromEntries(
      (await columns("processing_jobs")).map((c) => [c.column_name, c]),
    );
    expect(cols["status"]?.column_default).toContain("QUEUED");
    expect(cols["progressPct"]?.column_default).toBe("0");
    expect(cols["attempt"]?.column_default).toBe("0");
  });

  it("has the two worker-lookup indexes", async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'processing_jobs'`;
    const names = rows.map((r) => r.indexname);
    expect(names).toContain("processing_jobs_status_queuedAt_idx");
    expect(names).toContain("processing_jobs_entityType_entityId_idx");
  });

  it("blocks deleting a user who still has jobs (foreign key ON DELETE RESTRICT)", async () => {
    const rows = await prisma.$queryRaw<Array<{ confdeltype: string }>>`
      SELECT confdeltype::text AS confdeltype FROM pg_constraint
      WHERE conname = 'processing_jobs_createdById_fkey'`;
    expect(rows[0]?.confdeltype).toBe("r");
  });
});

describe("migrated schema: users", () => {
  it("has the designed columns", async () => {
    const names = (await columns("users")).map((c) => c.column_name).sort();
    expect(names).toEqual(
      [
        "id",
        "email",
        "name",
        "passwordHash",
        "role",
        "isActive",
        "failedLoginCount",
        "lockedUntil",
        "lastLoginAt",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
  });

  it("has a unique index on email", async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'users'`;
    expect(rows.some((r) => r.indexdef.includes("UNIQUE") && r.indexdef.includes("(email)"))).toBe(
      true,
    );
  });

  it("defaults isActive to true and failedLoginCount to 0", async () => {
    const cols = Object.fromEntries((await columns("users")).map((c) => [c.column_name, c]));
    expect(cols["isActive"]?.column_default).toBe("true");
    expect(cols["failedLoginCount"]?.column_default).toBe("0");
  });
});

describe("migrated schema: enums", () => {
  it("Role has exactly the two roles in the brief", async () => {
    expect(await enumLabels("Role")).toEqual(["FINANCE_EXECUTIVE", "CO_FOUNDER"]);
  });

  it("JobStatus has the four job states", async () => {
    expect(await enumLabels("JobStatus")).toEqual(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"]);
  });

  it("JobType has the three job types", async () => {
    expect(await enumLabels("JobType")).toEqual([
      "INGEST_FILE",
      "RECOMPUTE_RESULTS",
      "BUILD_CLAIMS",
    ]);
  });
});
