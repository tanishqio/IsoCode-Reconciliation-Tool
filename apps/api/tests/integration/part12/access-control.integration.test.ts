// A table of every API route and who may call it. For each route this checks, against the real app
// and database: a guest gets 401, a role that is not allowed gets 403, an allowed role is let in
// (anything except 401, 403 or a server error), and a request that changes data needs the CSRF
// token. WHEN A ROUTE IS ADDED TO THE API, ADD IT TO THIS TABLE.
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { call, signIn } from "../../helpers/auth-client.js";
import { buildForm, makeTempDir } from "../../helpers/part2-fixtures.js";
import { startServer, type TestServer } from "../../helpers/server.js";
import { assertTestDatabase } from "../../helpers/test-db.js";

const EXEC = { email: "exec-acl@example.test", password: "executive-password-1" };
const FOUNDER = { email: "founder-acl@example.test", password: "cofounder-password-1" };
const ID = "00000000-0000-4000-8000-000000000000";

type Access = "public" | "signed-in" | "both" | "executive" | "co-founder";

interface Route {
  method: "GET" | "POST" | "PUT";
  path: string;
  access: Access;
  /** A body the route can read without failing before the access check. */
  json?: unknown;
  multipart?: boolean;
}

const ROUTES: Route[] = [
  { method: "GET", path: "/api/health", access: "public" },
  { method: "GET", path: "/api/health/ready", access: "public" },
  { method: "POST", path: "/api/auth/login", access: "public", json: { email: "", password: "" } },
  { method: "GET", path: "/api/auth/me", access: "signed-in" },
  { method: "POST", path: "/api/auth/logout", access: "signed-in" },

  { method: "GET", path: "/api/sources", access: "executive" },

  { method: "POST", path: "/api/uploads", access: "executive", multipart: true },
  { method: "GET", path: "/api/uploads", access: "executive" },
  { method: "GET", path: `/api/uploads/${ID}`, access: "executive" },
  { method: "POST", path: `/api/uploads/${ID}/process`, access: "executive", json: {} },
  { method: "GET", path: `/api/uploads/${ID}/rejected-rows`, access: "executive" },
  { method: "POST", path: `/api/uploads/${ID}/mapping/suggest`, access: "executive", json: {} },
  {
    method: "POST",
    path: `/api/uploads/${ID}/mapping/preview`,
    access: "executive",
    json: { columnMap: {} },
  },
  {
    method: "POST",
    path: `/api/uploads/${ID}/mapping/approve`,
    access: "executive",
    json: { proposalId: ID, columnMap: {} },
  },
  { method: "GET", path: "/api/mappings", access: "executive" },
  { method: "POST", path: `/api/mappings/${ID}/reject`, access: "executive", json: {} },
  { method: "POST", path: `/api/mappings/${ID}/rollback`, access: "executive", json: {} },

  { method: "GET", path: "/api/rate-cards", access: "both" },
  { method: "POST", path: "/api/rate-cards/calculate", access: "both", json: {} },
  { method: "GET", path: `/api/rate-cards/${ID}`, access: "both" },
  { method: "POST", path: "/api/rate-cards", access: "executive", json: {} },
  { method: "PUT", path: `/api/rate-cards/${ID}`, access: "executive", json: {} },

  { method: "GET", path: "/api/orders/summary", access: "both" },
  { method: "GET", path: "/api/orders", access: "both" },
  { method: "GET", path: `/api/orders/${ID}`, access: "both" },
  { method: "GET", path: "/api/reconciliation/status", access: "both" },
  { method: "POST", path: "/api/reconciliation/run", access: "executive", json: {} },

  { method: "GET", path: "/api/dashboard/money-at-risk", access: "both" },
  { method: "GET", path: "/api/dashboard/tax-summary", access: "both" },
  { method: "GET", path: "/api/audit", access: "co-founder" },
];

let prisma: PrismaClient;
let server: TestServer;
let tempDir: string;
let uploadDir: string;

beforeAll(async () => {
  assertTestDatabase(process.env["DATABASE_URL"]);
  tempDir = makeTempDir("acl-temp");
  uploadDir = makeTempDir("acl-uploads");
  process.env["UPLOAD_TEMP_DIR"] = tempDir;
  process.env["UPLOAD_DIR"] = uploadDir;
  prisma = (await import("../../../src/db/prisma.js")).prisma;
  const { createApp } = await import("../../../src/app.js");
  server = await startServer(createApp({ loginRateLimitMax: 10_000, apiRateLimitMax: 100_000 }));

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
});

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(uploadDir, { recursive: true, force: true });
});

type Who = "guest" | "executive" | "co-founder";

async function request(route: Route, who: Who, options: { csrf?: boolean } = {}) {
  // A fresh session each time, so a route like logout cannot affect the next check.
  const credentials = who === "executive" ? EXEC : who === "co-founder" ? FOUNDER : null;
  const session = credentials
    ? await signIn(server.baseUrl, credentials.email, credentials.password)
    : null;
  return call(server.baseUrl, route.method, route.path, {
    cookie: session?.cookie,
    csrf: options.csrf === false ? undefined : session?.csrf,
    json: route.multipart ? undefined : route.json,
    form: route.multipart ? buildForm([], []) : undefined,
  });
}

const isAllowed = (access: Access, who: Who): boolean =>
  access === "public" ||
  (who !== "guest" && (access === "signed-in" || access === "both")) ||
  (who === "executive" && access === "executive") ||
  (who === "co-founder" && access === "co-founder");

describe("who may call each route", () => {
  for (const route of ROUTES) {
    describe(`${route.method} ${route.path.replace(ID, ":id")} (${route.access})`, () => {
      for (const who of ["guest", "executive", "co-founder"] as const) {
        it(`${who}: ${isAllowed(route.access, who) ? "let in" : who === "guest" ? "401" : "403"}`, async () => {
          const { status } = await request(route, who);
          if (isAllowed(route.access, who)) {
            expect([401, 403], `${status}`).not.toContain(status);
            expect(status, "a server error").toBeLessThan(500);
          } else {
            expect(status).toBe(who === "guest" ? 401 : 403);
          }
        });
      }
    });
  }
});

describe("requests that change data need the CSRF token", () => {
  const writes = ROUTES.filter((route) => route.method !== "GET" && route.access !== "public");
  for (const route of writes) {
    it(`${route.method} ${route.path.replace(ID, ":id")} without the token is refused`, async () => {
      const who: Who = route.access === "co-founder" ? "co-founder" : "executive";
      const { status } = await request(route, who, { csrf: false });
      expect(status).toBe(403);
    });
  }
});

describe("the table covers the API", () => {
  it("has at least one route for each part of the API", () => {
    const prefixes = new Set(ROUTES.map((route) => route.path.split("/")[2]));
    for (const prefix of [
      "health",
      "auth",
      "sources",
      "uploads",
      "mappings",
      "rate-cards",
      "orders",
      "reconciliation",
      "dashboard",
      "audit",
    ]) {
      expect(prefixes.has(prefix), prefix).toBe(true);
    }
  });

  it("answers 404 in the standard error shape for a route that does not exist", async () => {
    const { status, data } = await call(server.baseUrl, "GET", "/api/does-not-exist");
    expect(status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });
});
