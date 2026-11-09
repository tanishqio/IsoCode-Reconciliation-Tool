import { Router, type RequestHandler } from "express";
import { getRequestUser, requireRole } from "../../lib/request-user.js";
import { queueQuerySchema, suggestionIdSchema, type ReviewService } from "./review.service.js";

export interface ReviewRouterOptions {
  service: ReviewService;
  guards?: RequestHandler[];
}

/** The review queue. Finance executive only (the co-founder has no access to it). */
export function createReviewRouter({ service, guards = [] }: ReviewRouterOptions): Router {
  const router = Router();
  router.use(...guards, requireRole("FINANCE_EXECUTIVE"));

  router.get("/summary", async (_req, res) => {
    res.json(await service.summary());
  });
  router.get("/queue", async (req, res) => {
    res.json(await service.queue(queueQuerySchema.parse(req.query)));
  });
  router.post("/suggestions/:id/accept", async (req, res) => {
    const { id } = suggestionIdSchema.parse(req.params);
    res.json(await service.accept({ id, userId: getRequestUser(req).id }));
  });
  router.post("/suggestions/:id/reject", async (req, res) => {
    const { id } = suggestionIdSchema.parse(req.params);
    res.json(await service.reject({ id, userId: getRequestUser(req).id }));
  });
  router.post("/run", async (req, res) => {
    res.status(202).json(await service.rerun(getRequestUser(req).id));
  });
  return router;
}
