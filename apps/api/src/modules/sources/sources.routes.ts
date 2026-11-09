import { Router, type RequestHandler } from "express";
import { requireRole } from "../../lib/request-user.js";
import type { SourcesService } from "./sources.service.js";

export interface SourcesRouterOptions {
  service: SourcesService;
  guards?: RequestHandler[];
}

export function createSourcesRouter({ service, guards = [] }: SourcesRouterOptions): Router {
  const router = Router();

  router.use(...guards, requireRole("FINANCE_EXECUTIVE"));

  router.get("/", async (_req, res) => {
    res.json({ items: await service.listActiveSources() });
  });

  return router;
}
