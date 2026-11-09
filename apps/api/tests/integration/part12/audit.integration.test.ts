// Part 12 against a real database and the real app: the actions that matter are written to the
// audit trail, failures are not, the co-founder can read it, and it holds no personal data.
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { call, signIn } from "../../helpers/auth-client.js";
import { buildForm, makeTempDir, uniqueCsv } from "../../helpers/part2-fixtures.js";
import { startServer, type TestServer } from "../../helpers/server.js";
import { assertTestDatabase } from "../../helpers/test-db.js";

const EXEC = { email: "exec-p12@example.test", password: "executive-password-1" };
const FOUNDER = { email: "founder-p12@example.test", password: "cofounder-password-1" };
const SECRET_FILE_NAME = "customer-list-asha-sharma.csv";

let prisma: PrismaClient;
let server: TestServer;
let base: string;
let tempDir: string;
let uploadDir: string;
let sourceIds: Record<string, string> = {};

beforeAll(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]);
  tempDir = makeTempDir("p12-temp");
  uploadDir = makeTempDir("p12-uploads");
  process.env["UPLOAD_TEMP_DIR"] = tempDir;
  process.env["UPLOAD_DIR"] = uploadDir;
  prisma = (await import("../../../src/db/prisma.js")).prisma;
  const { createApp } = await import("../../../src/app.js");
  server = await startServer(createApp({ loginRateLimitMax: 10_000, apiRateLimitMax: 100_000 }));
  base = server.baseUrl;
});

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(uploadDir, { recursive: true, force: true });
});

beforeEach(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]);
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "users", "uploaded_files", "upload_batches", "sources", "source_file_types", "processing_jobs", "order_results", "rate_cards", "audit_logs" CASCADE',
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
});

/** Audit events are written just after the response is sent, so wait for them to appear. */
async function auditRows(expected: number, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let rows = await prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } });
  while (rows.length < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    rows = await prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } });
  }
  // A little longer, to catch an unexpected extra row.
  await new Promise((resolve) => setTimeout(resolve, 60));
  return prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } });
}

const cardBody = (channel: string) => ({
  channelSourceId: sourceIds[channel],
  courierSourceId: null,
  note: "Created by a test",
  isSampleData: true,
  rules: [
    { ruleType: "COMMISSION", basisPoints: 1000 },
    { ruleType: "FIXED_FEE", amount: "10.00" },
  ],
});

describe("sign-in and sign-out", () => {
  it("records a successful sign-in and sign-out for the right user", async () => {
    const exec = await signIn(base, EXEC.email, EXEC.password);
    await call(base, "POST", "/api/auth/logout", { cookie: exec.cookie, csrf: exec.csrf });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EXEC.email } });

    const rows = await auditRows(2);
    expect(rows.map((row) => row.action)).toEqual(["LOGIN", "LOGOUT"]);
    for (const row of rows) {
      expect(row.userId).toBe(user.id);
      expect(row.entityType).toBe("USER");
      expect(row.entityId).toBe(user.id);
    }
  });

  it("records a refused sign-in with no user, no e-mail and no password", async () => {
    await call(base, "POST", "/api/auth/login", {
      json: { email: EXEC.email, password: "wrong-password-xyz" },
    });
    await call(base, "POST", "/api/auth/login", {
      json: { email: "nobody@example.test", password: "another-wrong-1" },
    });
    const rows = await auditRows(2);
    expect(rows.map((row) => row.action)).toEqual(["LOGIN_FAILED", "LOGIN_FAILED"]);
    for (const row of rows) {
      expect(row.userId).toBeNull();
      expect(JSON.stringify(row)).not.toMatch(/example\.test|wrong-password|another-wrong/);
    }
  });

  it("records nothing for 'who am I' or for a request that is not valid", async () => {
    const exec = await signIn(base, EXEC.email, EXEC.password);
    await call(base, "GET", "/api/auth/me", { cookie: exec.cookie });
    await call(base, "POST", "/api/auth/login", { json: { email: "", password: "" } });
    const rows = await auditRows(1);
    expect(rows.map((row) => row.action)).toEqual(["LOGIN"]);
  });

  it("does not record a sign-out that was refused (no CSRF token)", async () => {
    const exec = await signIn(base, EXEC.email, EXEC.password);
    const refused = await call(base, "POST", "/api/auth/logout", { cookie: exec.cookie });
    expect(refused.status).toBe(403);
    expect((await auditRows(1)).map((row) => row.action)).toEqual(["LOGIN"]);
  });
});

describe("changes", () => {
  it("records a new rate card and a new version with their ids", async () => {
    const exec = await signIn(base, EXEC.email, EXEC.password);
    const created = await call(base, "POST", "/api/rate-cards", {
      cookie: exec.cookie,
      csrf: exec.csrf,
      json: cardBody("Marketplace 1"),
    });
    expect(created.status).toBe(201);
    const changed = await call(base, "PUT", `/api/rate-cards/${created.data.id}`, {
      cookie: exec.cookie,
      csrf: exec.csrf,
      json: { rules: [{ ruleType: "COMMISSION", basisPoints: 1200 }] },
    });
    expect(changed.status).toBe(200);

    const rows = (await auditRows(3)).filter((row) => row.action.startsWith("RATE_CARD"));
    expect(rows.map((row) => row.action)).toEqual(["RATE_CARD_CREATED", "RATE_CARD_CHANGED"]);
    expect(rows[0]?.entityId).toBe(created.data.id);
    expect(rows[1]?.entityId).toBe(changed.data.id);
    expect(rows[1]?.meta).toMatchObject({ previousId: created.data.id, versionNo: 2 });
    expect(rows[0]?.entityType).toBe("RATE_CARD");
  });

  it("records nothing when a change is refused or invalid", async () => {
    const exec = await signIn(base, EXEC.email, EXEC.password);
    const founder = await signIn(base, FOUNDER.email, FOUNDER.password);
    const invalid = await call(base, "POST", "/api/rate-cards", {
      cookie: exec.cookie,
      csrf: exec.csrf,
      json: { channelSourceId: "not-a-uuid", rules: [] },
    });
    const forbidden = await call(base, "POST", "/api/rate-cards", {
      cookie: founder.cookie,
      csrf: founder.csrf,
      json: cardBody("Marketplace 1"),
    });
    expect(invalid.status).toBe(422);
    expect(forbidden.status).toBe(403);
    const rows = await auditRows(2);
    expect(rows.map((row) => row.action)).toEqual(["LOGIN", "LOGIN"]);
  });

  it("records an upload and a blocked duplicate, without the file name", async () => {
    const exec = await signIn(base, EXEC.email, EXEC.password);
    const data = uniqueCsv();
    const items = [{ sourceId: sourceIds["Website"], fileType: "ORDERS" }];
    const first = await call(base, "POST", "/api/uploads", {
      cookie: exec.cookie,
      csrf: exec.csrf,
      form: buildForm(items, [{ name: SECRET_FILE_NAME, data }]),
    });
    const second = await call(base, "POST", "/api/uploads", {
      cookie: exec.cookie,
      csrf: exec.csrf,
      form: buildForm(items, [{ name: SECRET_FILE_NAME, data }]),
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);

    const rows = (await auditRows(3)).filter((row) => row.entityType === "UPLOADED_FILE");
    expect(rows.map((row) => row.action)).toEqual(["UPLOAD", "DUPLICATE_BLOCKED"]);
    const fileId = first.data.results[0].file.id;
    expect(rows[0]?.entityId).toBe(fileId);
    expect(rows[1]?.entityId).toBe(fileId);
    expect(JSON.stringify(rows)).not.toContain("asha");
    expect(JSON.stringify(rows)).not.toContain(".csv");
  });

  it("records a recalculation request with the job id", async () => {
    const exec = await signIn(base, EXEC.email, EXEC.password);
    const run = await call(base, "POST", "/api/reconciliation/run", {
      cookie: exec.cookie,
      csrf: exec.csrf,
    });
    expect(run.status).toBe(202);
    const rows = (await auditRows(2)).filter((row) => row.action === "RECONCILIATION_RUN");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "PROCESSING_JOB", entityId: run.data.jobId });
  });
});

describe("GET /api/audit", () => {
  async function makeActivity(): Promise<void> {
    const exec = await signIn(base, EXEC.email, EXEC.password);
    await call(base, "POST", "/api/rate-cards", {
      cookie: exec.cookie,
      csrf: exec.csrf,
      json: cardBody("Marketplace 2"),
    });
    await call(base, "POST", "/api/reconciliation/run", { cookie: exec.cookie, csrf: exec.csrf });
    await call(base, "POST", "/api/auth/logout", { cookie: exec.cookie, csrf: exec.csrf });
    await auditRows(4);
  }

  it("is for the co-founder only", async () => {
    const exec = await signIn(base, EXEC.email, EXEC.password);
    const founder = await signIn(base, FOUNDER.email, FOUNDER.password);
    expect((await call(base, "GET", "/api/audit")).status).toBe(401);
    expect((await call(base, "GET", "/api/audit", { cookie: exec.cookie })).status).toBe(403);
    expect((await call(base, "GET", "/api/audit", { cookie: founder.cookie })).status).toBe(200);
  });

  it("lists newest first with the person's name and a readable label", async () => {
    await makeActivity();
    const founder = await signIn(base, FOUNDER.email, FOUNDER.password);
    const { data } = await call(base, "GET", "/api/audit?limit=100", { cookie: founder.cookie });
    const actions = data.items.map((entry: { action: string }) => entry.action);
    expect(actions[0]).toBe("LOGIN");
    expect(actions).toEqual(
      expect.arrayContaining(["RATE_CARD_CREATED", "RECONCILIATION_RUN", "LOGOUT"]),
    );
    const created = data.items.find(
      (entry: { action: string }) => entry.action === "RATE_CARD_CREATED",
    );
    expect(created.label).toBe("Created a rate card");
    expect(created.user).toMatchObject({ name: "Test Executive", role: "FINANCE_EXECUTIVE" });
    const times = data.items.map((entry: { createdAt: string }) => Date.parse(entry.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("pages through every entry exactly once", async () => {
    await makeActivity();
    const founder = await signIn(base, FOUNDER.email, FOUNDER.password);
    await auditRows(5); // the co-founder's own sign-in is recorded too
    const total = await prisma.auditLog.count();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const url: string = `/api/audit?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const { data } = await call(base, "GET", url, { cookie: founder.cookie });
      seen.push(...data.items.map((entry: { id: string }) => entry.id));
      cursor = data.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it("filters by action and rejects an unknown action or cursor", async () => {
    await makeActivity();
    const founder = await signIn(base, FOUNDER.email, FOUNDER.password);
    const filtered = await call(base, "GET", "/api/audit?action=RECONCILIATION_RUN", {
      cookie: founder.cookie,
    });
    expect(filtered.data.items).toHaveLength(1);
    expect(
      (await call(base, "GET", "/api/audit?action=NOPE", { cookie: founder.cookie })).status,
    ).toBe(422);
    expect(
      (await call(base, "GET", "/api/audit?cursor=junk", { cookie: founder.cookie })).status,
    ).toBe(422);
  });

  it("cannot be changed or deleted through the API", async () => {
    await makeActivity();
    const founder = await signIn(base, FOUNDER.email, FOUNDER.password);
    await auditRows(5); // the co-founder's own sign-in is recorded too
    const before = await prisma.auditLog.count();
    const entry = await prisma.auditLog.findFirstOrThrow();
    for (const method of ["PUT", "PATCH", "DELETE", "POST"]) {
      const result = await call(base, method, `/api/audit/${entry.id}`, {
        cookie: founder.cookie,
        csrf: founder.csrf,
        json: {},
      });
      expect(result.status, method).toBe(404);
    }
    expect(await prisma.auditLog.count()).toBe(before);
  });
});

describe("privacy and integrity", () => {
  it("holds no e-mail, password, token or file name anywhere in the trail", async () => {
    const exec = await signIn(base, EXEC.email, EXEC.password);
    await signIn(base, FOUNDER.email, FOUNDER.password);
    await call(base, "POST", "/api/auth/login", {
      json: { email: EXEC.email, password: "nope-nope-1" },
    });
    await call(base, "POST", "/api/uploads", {
      cookie: exec.cookie,
      csrf: exec.csrf,
      form: buildForm(
        [{ sourceId: sourceIds["Website"], fileType: "ORDERS" }],
        [{ name: SECRET_FILE_NAME, data: uniqueCsv() }],
      ),
    });
    await call(base, "POST", "/api/auth/logout", { cookie: exec.cookie, csrf: exec.csrf });
    const rows = await auditRows(5);
    const text = JSON.stringify(rows);
    for (const forbidden of [
      "example.test",
      EXEC.password,
      FOUNDER.password,
      "nope-nope-1",
      "asha",
      "sharma",
      exec.csrf,
      exec.cookie.replace("sid=", ""),
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("keeps the entries when the person's account is later removed", async () => {
    const exec = await signIn(base, EXEC.email, EXEC.password);
    await call(base, "POST", "/api/auth/logout", { cookie: exec.cookie, csrf: exec.csrf });
    await auditRows(2);
    await prisma.user.delete({ where: { email: EXEC.email } });
    const rows = await prisma.auditLog.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.userId === null)).toBe(true);
  });

  it("does not stop the action when the audit table is unavailable", async () => {
    const exec = await signIn(base, EXEC.email, EXEC.password);
    await auditRows(1);
    await prisma.$executeRawUnsafe('ALTER TABLE "audit_logs" RENAME TO "audit_logs_away"');
    try {
      const run = await call(base, "POST", "/api/reconciliation/run", {
        cookie: exec.cookie,
        csrf: exec.csrf,
      });
      expect(run.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "audit_logs_away" RENAME TO "audit_logs"');
    }
  });

  it("stores the planned columns, with a delete rule that keeps entries", async () => {
    const columns = await prisma.$queryRawUnsafe<{ column_name: string; is_nullable: string }[]>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'audit_logs' ORDER BY ordinal_position`,
    );
    expect(columns.map((column) => column.column_name)).toEqual([
      "id",
      "userId",
      "action",
      "entityType",
      "entityId",
      "meta",
      "createdAt",
    ]);
    const rule = await prisma.$queryRawUnsafe<{ delete_rule: string }[]>(
      `SELECT delete_rule FROM information_schema.referential_constraints
       WHERE constraint_name = 'audit_logs_userId_fkey'`,
    );
    expect(rule[0]?.delete_rule).toBe("SET NULL");
    expect(randomUUID()).toBeTruthy();
  });
});
