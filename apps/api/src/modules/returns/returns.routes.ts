import { Router, type RequestHandler } from "express";
import { requireRole } from "../../lib/request-user.js";
import { returnsQuerySchema, type ReturnsService } from "./returns.service.js";

export interface ReturnsRouterOptions {
  service: ReturnsService;
  guards?: RequestHandler[];
}

/** The returns tracker. Read only; both roles may open it. */
export function createReturnsRouter({ service, guards = [] }: ReturnsRouterOptions): Router {
  const router = Router();
  router.use(...guards, requireRole("FINANCE_EXECUTIVE", "CO_FOUNDER"));

  router.get("/summary", async (_req, res) => {
    res.json(await service.summary());
  });
  router.get("/", async (req, res) => {
    res.json(await service.list(returnsQuerySchema.parse(req.query)));
  });
  return router;
}
