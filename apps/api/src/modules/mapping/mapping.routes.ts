import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { getRequestUser, requireRole } from "../../lib/request-user.js";
import { uploadIdParamSchema } from "../uploads/uploads.schemas.js";
import {
  approveBodySchema,
  listMappingsQuerySchema,
  previewBodySchema,
  type MappingService,
} from "./mapping.service.js";
import { createSuggester, type Suggester } from "./suggest.js";

export interface MappingRouterOptions {
  service: MappingService;
  guards?: RequestHandler[];
}

const idParam = z.strictObject({ id: z.uuid() });

/** Settings for the real suggester, read from the environment. */
export function createConfiguredSuggester(): Suggester {
  return createSuggester({
    provider: env.AI_PROVIDER,
    apiKey: env.AI_API_KEY,
    baseUrl: env.AI_BASE_URL,
    model: env.AI_MODEL,
    timeoutMs: env.AI_TIMEOUT_MS,
  });
}

/**
 * Mounted on /api/uploads next to the upload and ingestion routers: the mapping steps of one
 * waiting file. Finance executive only.
 */
export function createFileMappingRouter({ service, guards = [] }: MappingRouterOptions): Router {
  const router = Router();
  router.use(...guards, requireRole("FINANCE_EXECUTIVE"));

  router.post("/:id/mapping/suggest", async (req, res) => {
    const { id } = uploadIdParamSchema.parse(req.params);
    res.json(await service.suggest({ fileId: id, userId: getRequestUser(req).id }));
  });

  router.post("/:id/mapping/preview", async (req, res) => {
    const { id } = uploadIdParamSchema.parse(req.params);
    const body = previewBodySchema.parse(req.body);
    res.json(await service.preview({ fileId: id, columnMap: body.columnMap }));
  });

  router.post("/:id/mapping/approve", async (req, res) => {
    const { id } = uploadIdParamSchema.parse(req.params);
    const body = approveBodySchema.parse(req.body);
    res.json(
      await service.approve({
        fileId: id,
        userId: getRequestUser(req).id,
        proposalId: body.proposalId,
        columnMap: body.columnMap,
      }),
    );
  });

  return router;
}

/** Mounted on /api/mappings: the saved versions of a source and file type. */
export function createMappingsRouter({ service, guards = [] }: MappingRouterOptions): Router {
  const router = Router();
  router.use(...guards, requireRole("FINANCE_EXECUTIVE"));

  router.get("/", async (req, res) => {
    res.json(await service.listVersions(listMappingsQuerySchema.parse(req.query)));
  });

  router.post("/:id/reject", async (req, res) => {
    const { id } = idParam.parse(req.params);
    await service.rejectProposal({ id });
    res.status(204).end();
  });

  router.post("/:id/rollback", async (req, res) => {
    const { id } = idParam.parse(req.params);
    res.json(await service.rollback({ id, userId: getRequestUser(req).id }));
  });

  return router;
}
