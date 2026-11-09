import { Router, type RequestHandler } from "express";
import { requireRole } from "../../lib/request-user.js";
import { receiveFiles } from "../../middleware/upload.js";
import { createUploadsController } from "./uploads.controller.js";
import type { UploadsService } from "./uploads.service.js";

export interface UploadsRouterOptions {
  service: UploadsService;
  guards?: RequestHandler[];
  receiver?: RequestHandler;
}

export function createUploadsRouter({
  service,
  guards = [],
  receiver = receiveFiles,
}: UploadsRouterOptions): Router {
  const controller = createUploadsController(service);
  const router = Router();

  router.use(...guards, requireRole("FINANCE_EXECUTIVE"));

  router.post("/", receiver, controller.create);
  router.get("/", controller.list);
  router.get("/:id", controller.getOne);

  return router;
}
