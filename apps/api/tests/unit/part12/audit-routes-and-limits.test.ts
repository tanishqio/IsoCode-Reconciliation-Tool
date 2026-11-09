import express, { type RequestHandler } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, type ErrorBody } from "../../../src/lib/errors.js";
import { errorHandler, notFoundHandler } from "../../../src/middleware/error-handler.js";
import { createApiRateLimiter } from "../../../src/middleware/api-rate-limit.js";
import { requestLogger } from "../../../src/middleware/request-logger.js";
import { createAuditRouter } from "../../../src/modules/audit/audit.routes.js";
import type { AuditService } from "../../../src/modules/audit/audit.service.js";
import { createDashboardRouter } from "../../../src/modules/dashboard/dashboard.routes.js";
import type { DashboardService } from "../../../src/modules/dashboard/dashboard.service.js";
import { startServer, type TestServer } from "../../helpers/server.js";

const auditService = { list: vi.fn(), record: vi.fn() };
const dashboardService = { moneyAtRisk: vi.fn(), taxSummary: vi.fn() };

const fakeAuth: RequestHandler = (req, _res, next) => {
  const role = req.header("x-role");
  if (!role) {
    next(new AppError("UNAUTHENTICATED", 401, "Please sign in."));
    return;
  }
  (req as unknown as { user: unknown }).user = { id: "u1", role };
  next();
};

let server: TestServer;

beforeAll(async () => {
  const app = express();
  app.use(requestLogger);
  app.use(
    "/api/audit",
    createAuditRouter({ service: auditService as unknown as AuditService, guards: [fakeAuth] }),
  );
  app.use(
    "/api/dashboard",
    createDashboardRouter({
      service: dashboardService as unknown as DashboardService,
      guards: [fakeAuth],
    }),
  );
  app.use(notFoundHandler);
  app.use(errorHandler);
  server = await startServer(app);
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  vi.resetAllMocks();
});

const founder = { "x-role": "CO_FOUNDER" };
const executive = { "x-role": "FINANCE_EXECUTIVE" };

async function get(path: string, headers: Record<string, string> = {}, method = "GET") {
  const response = await fetch(`${server.baseUrl}${path}`, { method, headers });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    headers: response.headers,
  };
}

describe("GET /api/audit", () => {
  it("is open to the co-founder only", async () => {
    auditService.list.mockResolvedValue({ items: [], nextCursor: null });
    expect((await get("/api/audit")).status).toBe(401);
    expect((await get("/api/audit", executive)).status).toBe(403);
    expect((await get("/api/audit", founder)).status).toBe(200);
    expect(auditService.list).toHaveBeenCalledTimes(1);
  });

  it("is never cached", async () => {
    auditService.list.mockResolvedValue({ items: [], nextCursor: null });
    expect((await get("/api/audit", founder)).headers.get("cache-control")).toBe("no-store");
  });

  it("passes the checked query to the service", async () => {
    auditService.list.mockResolvedValue({ items: [], nextCursor: null });
    await get("/api/audit?action=UPLOAD&limit=5", founder);
    expect(auditService.list).toHaveBeenCalledWith({ action: "UPLOAD", limit: 5 });
  });

  it.each(["action=NOPE", "limit=0", "limit=500", "cursor="])(
    "answers 422 for ?%s",
    async (query) => {
      const { status, body } = await get(`/api/audit?${query}`, founder);
      expect(status).toBe(422);
      expect((body as ErrorBody).error.code).toBe("VALIDATION_FAILED");
    },
  );

  it("offers no way to change or delete an entry", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((await get("/api/audit", founder, method)).status, method).toBe(404);
      expect((await get("/api/audit/some-id", founder, method)).status, method).toBe(404);
    }
  });
});

describe("GET /api/dashboard", () => {
  it("lets both roles read and nobody else", async () => {
    dashboardService.moneyAtRisk.mockResolvedValue({ ok: true });
    dashboardService.taxSummary.mockResolvedValue({ ok: true });
    for (const path of ["/api/dashboard/money-at-risk", "/api/dashboard/tax-summary"]) {
      expect((await get(path)).status, path).toBe(401);
      expect((await get(path, executive)).status, path).toBe(200);
      expect((await get(path, founder)).status, path).toBe(200);
    }
  });

  it("passes the month to the tax summary and rejects a bad one", async () => {
    dashboardService.taxSummary.mockResolvedValue({ ok: true });
    await get("/api/dashboard/tax-summary?month=2026-08", executive);
    expect(dashboardService.taxSummary).toHaveBeenCalledWith("2026-08");
    await get("/api/dashboard/tax-summary", executive);
    expect(dashboardService.taxSummary).toHaveBeenLastCalledWith(undefined);

    for (const month of ["2026-13", "2026-8", "last-month"]) {
      expect(
        (await get(`/api/dashboard/tax-summary?month=${month}`, executive)).status,
        month,
      ).toBe(422);
    }
  });

  it("is read only", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await get("/api/dashboard/money-at-risk", executive, method)).status, method).toBe(
        404,
      );
    }
  });
});

describe("the general request limit", () => {
  it("lets requests through up to the limit, then answers 429 in the standard error shape", async () => {
    const app = express();
    app.use(requestLogger);
    app.use("/api", createApiRateLimiter(10));
    app.get("/api/thing", (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);
    const limited = await startServer(app);
    try {
      const statuses: number[] = [];
      let last: ErrorBody | null = null;
      for (let index = 0; index < 13; index += 1) {
        const response = await fetch(`${limited.baseUrl}/api/thing`);
        statuses.push(response.status);
        if (response.status === 429) last = (await response.json()) as ErrorBody;
        else await response.text();
      }
      expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429, 429]);
      expect(last?.error.code).toBe("RATE_LIMITED");
    } finally {
      await limited.close();
    }
  });
});
