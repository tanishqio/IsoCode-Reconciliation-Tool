import { Router, type RequestHandler } from "express";
import { requireRole } from "../../lib/request-user.js";
import { taxSummaryQuerySchema } from "./dashboard.schemas.js";
import type { DashboardService } from "./dashboard.service.js";

export interface DashboardRouterOptions {
  service: DashboardService;
  /** Sign-in and CSRF checks, added by app.ts. */
  guards?: RequestHandler[];
}

/**
 * The money-at-risk dashboard and the TCS/TDS summary. Read only; both roles may open them (the
 * co-founder lands here).
 */
export function createDashboardRouter({ service, guards = [] }: DashboardRouterOptions): Router {
  const router = Router();
  router.use(...guards, requireRole("FINANCE_EXECUTIVE", "CO_FOUNDER"));

  router.get("/money-at-risk", async (_req, res) => {
    res.json(await service.moneyAtRisk());
  });

  router.get("/tax-summary", async (req, res) => {
    const { month } = taxSummaryQuerySchema.parse(req.query);
    res.json(await service.taxSummary(month));
  });

  return router;
}
