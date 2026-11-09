import { Router, type RequestHandler } from "express";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { getRequestUser, requireRole } from "../../lib/request-user.js";
import {
  enqueueRecompute,
  listOrdersQuerySchema,
  orderIdParamSchema,
  type ReconciliationService,
} from "./reconciliation.service.js";

export interface ReconciliationRouterOptions {
  service: ReconciliationService;
  prisma: PrismaClient;
  guards?: RequestHandler[];
}

/**
 * /api/orders (both roles, read only) and /api/reconciliation (status for both roles, the
 * recalculate button for the finance executive only).
 */
export function createOrdersRouter({ service, guards = [] }: ReconciliationRouterOptions): Router {
  const router = Router();
  router.use(...guards);

  router.get("/summary", async (_req, res) => {
    res.json(await service.summary());
  });
  router.get("/", async (req, res) => {
    res.json(await service.list(listOrdersQuerySchema.parse(req.query)));
  });
  router.get("/:id", async (req, res) => {
    const { id } = orderIdParamSchema.parse(req.params);
    res.json(await service.detail(id));
  });
  return router;
}

export function createReconciliationRouter({
  service,
  prisma,
  guards = [],
}: ReconciliationRouterOptions): Router {
  const router = Router();
  router.use(...guards);

  router.get("/status", async (_req, res) => {
    res.json(await service.status());
  });
  router.post("/run", requireRole("FINANCE_EXECUTIVE"), async (req, res) => {
    const result = await enqueueRecompute(prisma, getRequestUser(req).id);
    res.status(202).json(result);
  });
  return router;
}
