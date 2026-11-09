import type { Express, Request, Response } from "express";
import type { AuditEvent, AuditRecorder } from "./audit.service.js";

// Records the actions that change something, without touching the services that do the work.
// Each rule watches one route; when the response is a success it writes one audit event. The user
// comes from req.user (set by the sign-in check, which runs later in the same request) and the ids
// come from the URL or the response body. Failed requests are not recorded, except failed sign-ins.

interface Context {
  req: Request;
  status: number;
  body: unknown;
  userId: string | null;
}

type Build = (ctx: Context) => AuditEvent | null;

function field(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function numberField(body: unknown, key: string): number | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

const param = (req: Request, name: string): string | null => {
  const value = req.params[name];
  return typeof value === "string" ? value : null;
};

function userFrom(req: Request): string | null {
  const user = (req as Request & { user?: { id: string } }).user;
  return user?.id ?? null;
}

function watch(
  app: Express,
  method: "post" | "put",
  path: string,
  record: AuditRecorder,
  build: Build,
): void {
  app[method](path, (req: Request, res: Response, next) => {
    let body: unknown;
    const originalJson = res.json.bind(res);
    res.json = ((payload: unknown) => {
      body = payload;
      return originalJson(payload);
    }) as Response["json"];

    res.on("finish", () => {
      const event = build({ req, status: res.statusCode, body, userId: userFrom(req) });
      if (event) void record(event);
    });
    next();
  });
}

const ok = (status: number) => status >= 200 && status < 300;

/**
 * Registers the audit rules. Call it BEFORE the routers it watches are mounted, because a router
 * that answers the request ends the chain.
 */
export function registerAuditing(app: Express, record: AuditRecorder): void {
  watch(app, "post", "/api/auth/login", record, ({ status, body }) => {
    if (status === 200) {
      const id = field((body as { user?: unknown } | null)?.user, "id");
      return id ? { userId: id, action: "LOGIN", entityType: "USER", entityId: id } : null;
    }
    // Only a refused sign-in is recorded. The sign-in limiter caps these per IP address; the
    // "too many attempts" answer (429) is not recorded, so a flood cannot fill the table.
    if (status === 401) {
      return { userId: null, action: "LOGIN_FAILED", entityType: "USER" };
    }
    return null;
  });

  watch(app, "post", "/api/auth/logout", record, ({ status, userId }) =>
    ok(status) && userId
      ? { userId, action: "LOGOUT", entityType: "USER", entityId: userId }
      : null,
  );

  watch(app, "post", "/api/rate-cards", record, ({ status, body, userId }) =>
    ok(status) && userId
      ? {
          userId,
          action: "RATE_CARD_CREATED",
          entityType: "RATE_CARD",
          entityId: field(body, "id"),
          meta: { versionNo: numberField(body, "versionNo") },
        }
      : null,
  );

  watch(app, "put", "/api/rate-cards/:id", record, ({ req, status, body, userId }) =>
    ok(status) && userId
      ? {
          userId,
          action: "RATE_CARD_CHANGED",
          entityType: "RATE_CARD",
          entityId: field(body, "id"),
          meta: { previousId: param(req, "id"), versionNo: numberField(body, "versionNo") },
        }
      : null,
  );

  watch(app, "post", "/api/uploads/:id/mapping/approve", record, ({ req, status, body, userId }) =>
    ok(status) && userId
      ? {
          userId,
          action: "MAPPING_APPROVED",
          entityType: "MAPPING_VERSION",
          entityId: field(body, "id"),
          meta: {
            fileId: param(req, "id"),
            versionNo: numberField(body, "versionNo"),
            queuedFiles: numberField(body, "queuedFiles"),
          },
        }
      : null,
  );

  watch(app, "post", "/api/mappings/:id/reject", record, ({ req, status, userId }) =>
    ok(status) && userId
      ? {
          userId,
          action: "MAPPING_REJECTED",
          entityType: "MAPPING_VERSION",
          entityId: param(req, "id"),
        }
      : null,
  );

  watch(app, "post", "/api/mappings/:id/rollback", record, ({ req, status, body, userId }) =>
    ok(status) && userId
      ? {
          userId,
          action: "MAPPING_ROLLED_BACK",
          entityType: "MAPPING_VERSION",
          entityId: field(body, "id"),
          meta: {
            fromId: param(req, "id"),
            versionNo: numberField(body, "versionNo"),
            queuedFiles: numberField(body, "queuedFiles"),
          },
        }
      : null,
  );

  watch(app, "post", "/api/reconciliation/run", record, ({ status, body, userId }) =>
    ok(status) && userId
      ? {
          userId,
          action: "RECONCILIATION_RUN",
          entityType: "PROCESSING_JOB",
          entityId: field(body, "jobId"),
          meta: {
            alreadyQueued:
              typeof body === "object" && body !== null
                ? (body as { alreadyQueued?: unknown }).alreadyQueued === true
                : false,
          },
        }
      : null,
  );
  // Part 8: a person decides a suggested match. Only ids and codes are recorded.
  watch(
    app,
    "post",
    "/api/review/suggestions/:id/accept",
    record,
    ({ req, status, body, userId }) =>
      ok(status) && userId
        ? {
            userId,
            action: "MATCH_ACCEPTED",
            entityType: "MATCH_SUGGESTION",
            entityId: param(req, "id"),
            meta: { lineKind: field(body, "lineKind") },
          }
        : null,
  );

  watch(app, "post", "/api/review/suggestions/:id/reject", record, ({ req, status, userId }) =>
    ok(status) && userId
      ? {
          userId,
          action: "MATCH_REJECTED",
          entityType: "MATCH_SUGGESTION",
          entityId: param(req, "id"),
        }
      : null,
  );

  // Part 10: the evidence export and the claim status.
  watch(app, "post", "/api/claims/:id/export", record, ({ req, status, body, userId }) =>
    ok(status) && userId
      ? {
          userId,
          action: "CLAIM_EXPORTED",
          entityType: "CLAIM",
          entityId: param(req, "id"),
          meta: { itemCount: numberField(body, "itemCount"), total: field(body, "total") },
        }
      : null,
  );

  watch(app, "post", "/api/claims/:id/status", record, ({ req, status, body, userId }) =>
    ok(status) && userId
      ? {
          userId,
          action: "CLAIM_STATUS_CHANGED",
          entityType: "CLAIM",
          entityId: param(req, "id"),
          meta: { status: field(body, "status"), recovered: field(body, "recovered") },
        }
      : null,
  );
}
