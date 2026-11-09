import express, { type RequestHandler } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAuditing } from "../../../src/modules/audit/audit.middleware.js";
import type { AuditEvent } from "../../../src/modules/audit/audit.service.js";
import { startServer, type TestServer } from "../../helpers/server.js";

// A small stand-in app: the routes answer with whatever status the test asks for, the way the real
// routers would, and set req.user the way the sign-in check does (after the audit rules ran).

let server: TestServer;
const recorded: AuditEvent[] = [];
const record = vi.fn(async (event: AuditEvent) => {
  recorded.push(event);
});

const asUser: RequestHandler = (req, _res, next) => {
  (req as unknown as { user: { id: string } }).user = { id: "user-1" };
  next();
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerAuditing(app, record);

  const reply =
    (status: number, body?: unknown): RequestHandler =>
    (_req, res) => {
      if (body === undefined) res.status(status).end();
      else res.status(status).json(body);
    };
  // The status for each route comes from the ?status= query so one route can fail and succeed.
  const dynamic =
    (body?: unknown): RequestHandler =>
    (req, res, next) =>
      reply(Number(req.query["status"] ?? 200), body)(req, res, next);

  app.post("/api/auth/login", dynamic({ user: { id: "user-1", email: "a@b.co" }, csrfToken: "t" }));
  app.post("/api/auth/logout", asUser, dynamic());
  app.post("/api/rate-cards", asUser, dynamic({ id: "card-2", versionNo: 1 }));
  app.put("/api/rate-cards/:id", asUser, dynamic({ id: "card-3", versionNo: 2 }));
  app.post(
    "/api/uploads/:id/mapping/approve",
    asUser,
    dynamic({ id: "map-1", versionNo: 4, queuedFiles: 2 }),
  );
  app.post("/api/mappings/:id/reject", asUser, dynamic());
  app.post(
    "/api/mappings/:id/rollback",
    asUser,
    dynamic({ id: "map-9", versionNo: 5, queuedFiles: 0 }),
  );
  app.post("/api/reconciliation/run", asUser, dynamic({ jobId: "job-1", alreadyQueued: true }));
  app.post("/api/unwatched", asUser, dynamic({ ok: true }));
  server = await startServer(app);
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  recorded.length = 0;
  record.mockClear();
});

async function post(path: string, method = "POST") {
  const response = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  await response.text();
  // The audit event is written when the response finishes, a moment after the client has it.
  await new Promise((resolve) => setTimeout(resolve, 30));
  return response.status;
}

describe("sign-in and sign-out", () => {
  it("records a successful sign-in for the user in the response", async () => {
    await post("/api/auth/login");
    expect(recorded).toEqual([
      { userId: "user-1", action: "LOGIN", entityType: "USER", entityId: "user-1" },
    ]);
  });

  it("records a refused sign-in with no user and no e-mail", async () => {
    await post("/api/auth/login?status=401");
    expect(recorded).toEqual([{ userId: null, action: "LOGIN_FAILED", entityType: "USER" }]);
    expect(JSON.stringify(recorded)).not.toContain("@");
  });

  it("does not record 'too many attempts' answers, so a flood cannot fill the table", async () => {
    await post("/api/auth/login?status=429");
    await post("/api/auth/login?status=422");
    await post("/api/auth/login?status=500");
    expect(recorded).toEqual([]);
  });

  it("records sign-out for the signed-in user", async () => {
    await post("/api/auth/logout?status=204");
    expect(recorded).toEqual([
      { userId: "user-1", action: "LOGOUT", entityType: "USER", entityId: "user-1" },
    ]);
  });
});

describe("changes", () => {
  it("records a new rate card and a new version, with the new ids", async () => {
    await post("/api/rate-cards?status=201");
    await post("/api/rate-cards/card-1", "PUT");
    expect(recorded).toEqual([
      {
        userId: "user-1",
        action: "RATE_CARD_CREATED",
        entityType: "RATE_CARD",
        entityId: "card-2",
        meta: { versionNo: 1 },
      },
      {
        userId: "user-1",
        action: "RATE_CARD_CHANGED",
        entityType: "RATE_CARD",
        entityId: "card-3",
        meta: { previousId: "card-1", versionNo: 2 },
      },
    ]);
  });

  it("records mapping approval, rejection and rollback", async () => {
    await post("/api/uploads/file-1/mapping/approve");
    await post("/api/mappings/map-2/reject?status=204");
    await post("/api/mappings/map-3/rollback");
    expect(recorded.map((event) => [event.action, event.entityId])).toEqual([
      ["MAPPING_APPROVED", "map-1"],
      ["MAPPING_REJECTED", "map-2"],
      ["MAPPING_ROLLED_BACK", "map-9"],
    ]);
    expect(recorded[0]?.meta).toEqual({ fileId: "file-1", versionNo: 4, queuedFiles: 2 });
    expect(recorded[2]?.meta).toEqual({ fromId: "map-3", versionNo: 5, queuedFiles: 0 });
  });

  it("records a recalculation with the job id", async () => {
    await post("/api/reconciliation/run?status=202");
    expect(recorded).toEqual([
      {
        userId: "user-1",
        action: "RECONCILIATION_RUN",
        entityType: "PROCESSING_JOB",
        entityId: "job-1",
        meta: { alreadyQueued: true },
      },
    ]);
  });

  it.each([
    "/api/rate-cards?status=409",
    "/api/rate-cards?status=422",
    "/api/rate-cards?status=500",
    "/api/uploads/file-1/mapping/approve?status=403",
    "/api/mappings/map-2/reject?status=404",
    "/api/mappings/map-3/rollback?status=409",
    "/api/reconciliation/run?status=401",
    "/api/auth/logout?status=401",
  ])("records nothing when %s fails", async (path) => {
    await post(path);
    expect(recorded).toEqual([]);
  });

  it("records nothing for routes it does not watch", async () => {
    await post("/api/unwatched");
    expect(recorded).toEqual([]);
  });
});

describe("robustness", () => {
  it("still sends the response unchanged", async () => {
    const response = await fetch(`${server.baseUrl}/api/rate-cards`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "card-2", versionNo: 1 });
  });
});
