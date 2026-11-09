// TEMPORARY: tests the temporary dev route that needs the database (decision D11).
// Delete this file together with apps/api/src/modules/dev/ and its mount in app.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db/prisma.js";
import { startServer, type TestServer } from "../helpers/server.js";

let server: TestServer;
beforeAll(async () => {
  server = await startServer(createApp());
});
afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});

interface DbCheck {
  database: string;
  select1: boolean;
  inTransaction: {
    jobStatus: string;
    progressPct: number;
    attempt: number;
    queuedAtIsSet: boolean;
    userRole: string;
  };
  rolledBack: boolean;
  counts: { usersBefore: number; usersAfter: number; jobsBefore: number; jobsAfter: number };
}

describe("GET /api/dev/db-check (database success path)", () => {
  it("writes and reads a user and a job, with the table defaults, then rolls back", async () => {
    const res = await fetch(`${server.baseUrl}/api/dev/db-check`);
    const body = (await res.json()) as DbCheck;
    expect(res.status).toBe(200);
    expect(body.database).toBe("up");
    expect(body.select1).toBe(true);
    expect(body.inTransaction).toEqual({
      jobStatus: "QUEUED",
      progressPct: 0,
      attempt: 0,
      queuedAtIsSet: true,
      userRole: "FINANCE_EXECUTIVE",
    });
    expect(body.rolledBack).toBe(true);
  });

  it("leaves no rows behind, even when called repeatedly", async () => {
    const before = await prisma.user.count();
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${server.baseUrl}/api/dev/db-check`);
      expect(res.status).toBe(200);
    }
    expect(await prisma.user.count()).toBe(before);
    expect(await prisma.processingJob.count()).toBe(0);
  });
});
