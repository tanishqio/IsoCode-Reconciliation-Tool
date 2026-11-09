import { Router, type RequestHandler } from "express";
import { requireRole } from "../../lib/request-user.js";
import { listAuditQuerySchema, type AuditService } from "./audit.service.js";

export interface AuditRouterOptions {
  service: AuditService;
  /** Sign-in and CSRF checks, added by app.ts. */
  guards?: RequestHandler[];
}

/**
 * GET /api/audit: the activity log, for the co-founder only (oversight). The finance executive
 * cannot read it, and nobody can change or delete an entry through the API.
 */
export function createAuditRouter({ service, guards = [] }: AuditRouterOptions): Router {
  const router = Router();
  router.use(...guards, requireRole("CO_FOUNDER"));

  router.get("/", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await service.list(listAuditQuerySchema.parse(req.query)));
  });

  return router;
}
