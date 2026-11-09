import { Router, type RequestHandler } from "express";
import { getRequestUser, requireRole } from "../../lib/request-user.js";
import { uploadIdParamSchema } from "../uploads/uploads.schemas.js";
import {
  processBodySchema,
  rejectedRowsQuerySchema,
  type IngestionService,
} from "./ingestion.service.js";

export interface IngestionRouterOptions {
  service: IngestionService;
  guards?: RequestHandler[];
}

/** Mounted on /api/uploads next to the Part 2 router. Finance executive only, like uploads. */
export function createIngestionRouter({ service, guards = [] }: IngestionRouterOptions): Router {
  const router = Router();
  router.use(...guards, requireRole("FINANCE_EXECUTIVE"));

  router.post("/:id/process", async (req, res) => {
    const { id } = uploadIdParamSchema.parse(req.params);
    processBodySchema.parse(req.body);
    const result = await service.retryProcessing({ fileId: id, userId: getRequestUser(req).id });
    res.status(202).json(result);
  });

  router.get("/:id/rejected-rows", async (req, res) => {
    const { id } = uploadIdParamSchema.parse(req.params);
    const query = rejectedRowsQuerySchema.parse(req.query);
    res.json(await service.listRejectedRows({ fileId: id, ...query }));
  });

  return router;
}
