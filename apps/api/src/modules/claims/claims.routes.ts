import { Router, type RequestHandler } from "express";
import { getRequestUser, requireRole } from "../../lib/request-user.js";
import {
  claimIdSchema,
  claimItemsQuerySchema,
  itemIdSchema,
  listClaimsQuerySchema,
  statusBodySchema,
  type ClaimsService,
} from "./claims.service.js";

export interface ClaimsRouterOptions {
  service: ClaimsService;
  guards?: RequestHandler[];
}

/**
 * Claims by partner. Both roles can read; only the finance executive can export, record a recovery,
 * close a claim or ask for a rebuild.
 */
export function createClaimsRouter({ service, guards = [] }: ClaimsRouterOptions): Router {
  const router = Router();
  const executiveOnly = requireRole("FINANCE_EXECUTIVE");
  router.use(...guards, requireRole("FINANCE_EXECUTIVE", "CO_FOUNDER"));

  router.get("/summary", async (_req, res) => {
    res.json(await service.summary());
  });
  router.get("/", async (req, res) => {
    res.json(await service.list(listClaimsQuerySchema.parse(req.query)));
  });
  router.get("/items/:itemId", async (req, res) => {
    const { itemId } = itemIdSchema.parse(req.params);
    res.json(await service.getItem(itemId));
  });
  router.get("/:id", async (req, res) => {
    const { id } = claimIdSchema.parse(req.params);
    res.json(await service.getOne(id, claimItemsQuerySchema.parse(req.query)));
  });
  router.post("/rebuild", executiveOnly, async (req, res) => {
    res.status(202).json(await service.rebuild(getRequestUser(req).id));
  });
  router.post("/:id/export", executiveOnly, async (req, res) => {
    const { id } = claimIdSchema.parse(req.params);
    res.json(await service.exportClaim(id, getRequestUser(req).id));
  });
  router.post("/:id/status", executiveOnly, async (req, res) => {
    const { id } = claimIdSchema.parse(req.params);
    res.json(await service.setStatus(id, statusBodySchema.parse(req.body)));
  });
  return router;
}
