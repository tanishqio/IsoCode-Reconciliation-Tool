import { Router, type RequestHandler } from "express";
import { getRequestUser, requireRole } from "../../lib/request-user.js";
import {
  calculateSchema,
  createCardSchema,
  idParamSchema,
  listQuerySchema,
  updateCardSchema,
} from "./rate-cards.schemas.js";
import type { RateCardsService } from "./rate-cards.service.js";

export interface RateCardsRouterOptions {
  service: RateCardsService;
  /** Sign-in and CSRF checks, added by app.ts. */
  guards?: RequestHandler[];
}

/**
 * Both roles can read rate cards and use the check panel (the co-founder has a view-only screen).
 * Only the finance executive can create a card or make a new version.
 */
export function createRateCardsRouter({ service, guards = [] }: RateCardsRouterOptions): Router {
  const router = Router();
  const executiveOnly = requireRole("FINANCE_EXECUTIVE");

  router.use(...guards, requireRole("FINANCE_EXECUTIVE", "CO_FOUNDER"));

  router.get("/", async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    res.json({ items: await service.list(query) });
  });

  // Not a change to data, so the co-founder may use it too.
  router.post("/calculate", async (req, res) => {
    res.json(await service.calculate(calculateSchema.parse(req.body)));
  });

  router.get("/:id", async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    res.json(await service.getOne(id));
  });

  router.post("/", executiveOnly, async (req, res) => {
    const input = createCardSchema.parse(req.body);
    res.status(201).json(await service.create(input, getRequestUser(req).id));
  });

  // "Update" makes a new version; the old one is kept.
  router.put("/:id", executiveOnly, async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    const input = updateCardSchema.parse(req.body);
    res.json(await service.createNewVersion(id, input, getRequestUser(req).id));
  });

  return router;
}
