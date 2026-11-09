// Part 12 privacy and abuse checks against the real database and app:
//  - no table has a column for customer name, phone, address or similar (DPDP Act 2023: personal
//    data is not collected where it is not needed);
//  - the general request limit answers 429 in the standard error shape, and the health check is exempt.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { call } from "../../helpers/auth-client.js";
import { startServer, type TestServer } from "../../helpers/server.js";
import { assertTestDatabase } from "../../helpers/test-db.js";

let prisma: PrismaClient;
let limited: TestServer;

beforeAll(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]);
  prisma = (await import("../../../src/db/prisma.js")).prisma;
  const { createApp } = await import("../../../src/app.js");
  limited = await startServer(createApp({ apiRateLimitMax: 10, loginRateLimitMax: 10_000 }));
});

afterAll(async () => {
  await limited.close();
  await prisma.$disconnect();
});

describe("personal data has no column anywhere", () => {
  interface Column {
    table_name: string;
    column_name: string;
  }
  let columns: Column[] = [];

  beforeAll(async () => {
    columns = await prisma.$queryRawUnsafe<Column[]>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'`,
    );
  });

  it("looks at every table", () => {
    const tables = new Set(columns.map((column) => column.table_name));
    for (const table of [
      "users",
      "customer_orders",
      "settlement_lines",
      "cod_remittance_lines",
      "freight_lines",
      "return_scans",
      "rejected_rows",
      "uploaded_files",
      "order_results",
      "audit_logs",
    ]) {
      expect(tables.has(table), table).toBe(true);
    }
  });

  it("has no phone, mobile, address, date-of-birth, gender or ID-number column", () => {
    const forbidden =
      /phone|mobile|address|birth|dob|gender|aadhaar|aadhar|passport|pincode|postal|zip/i;
    const found = columns.filter((column) => forbidden.test(column.column_name));
    expect(found).toEqual([]);
  });

  it("has an e-mail only for staff sign-in (users), and a person's name only there", () => {
    const emails = columns.filter((column) => /e-?mail/i.test(column.column_name));
    expect(emails).toEqual([{ table_name: "users", column_name: "email" }]);

    // `name` also appears on sources and rate cards' partners (company names, not people).
    const names = columns
      .filter((column) =>
        /^(first|last|full|customer|buyer|consignee)?_?name$/i.test(column.column_name),
      )
      .map((column) => column.table_name)
      .sort();
    expect(names).toEqual(["sources", "users"]);
  });

  it("has no column named for the customer or the buyer", () => {
    const found = columns.filter((column) =>
      /customer|buyer|consignee|recipient/i.test(column.column_name),
    );
    expect(found).toEqual([]);
  });

  it("keeps only the mapped columns of a rejected row (a snippet, not the whole row)", () => {
    const rejected = columns
      .filter((column) => column.table_name === "rejected_rows")
      .map((c) => c.column_name);
    expect(rejected.sort()).toEqual(
      ["createdAt", "fileId", "id", "message", "rawSnippet", "reasonCode", "rowNumber"].sort(),
    );
  });
});

describe("the general request limit", () => {
  it("answers 429 in the standard error shape after the limit, but never limits the health check", async () => {
    const statuses: number[] = [];
    let last: { error: { code: string; requestId: string } } | null = null;
    for (let index = 0; index < 13; index += 1) {
      const result = await call(limited.baseUrl, "GET", "/api/auth/me");
      statuses.push(result.status);
      if (result.status === 429) last = result.data;
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429, 429]);
    expect(last?.error.code).toBe("RATE_LIMITED");
    expect(last?.error.requestId).toBeTruthy();

    for (let index = 0; index < 5; index += 1) {
      expect((await call(limited.baseUrl, "GET", "/api/health")).status).toBe(200);
    }
  });

  it("does not record 429 answers in the audit trail", async () => {
    const before = await prisma.auditLog.count();
    for (let index = 0; index < 15; index += 1) {
      await call(limited.baseUrl, "POST", "/api/auth/login", {
        json: { email: "a@b.co", password: "x" },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await prisma.auditLog.count()).toBe(before);
  });
});
