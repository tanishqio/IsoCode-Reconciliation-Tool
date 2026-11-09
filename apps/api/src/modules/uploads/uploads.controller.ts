import type { RequestHandler } from "express";
import { AppError } from "../../lib/errors.js";
import { getRequestUser } from "../../lib/request-user.js";
import { ITEMS_FIELD } from "../../middleware/upload.js";
import {
  listUploadsQuerySchema,
  parseUploadItems,
  uploadIdParamSchema,
} from "./uploads.schemas.js";
import type { UploadsService } from "./uploads.service.js";
import { removeFileQuietly } from "./uploads.storage.js";

export function createUploadsController(service: UploadsService) {
  const create: RequestHandler = async (req, res) => {
    const user = getRequestUser(req);
    const files = Array.isArray(req.files) ? req.files : [];
    try {
      if (files.length === 0) {
        throw new AppError("BAD_REQUEST", 400, 'Attach at least one file in the "files" field.');
      }
      const items = parseUploadItems(req.body?.[ITEMS_FIELD], files.length);
      const outcome = await service.processUpload({ userId: user.id, files, items });
      const { accepted, rejected } = outcome.summary;
      const status = accepted > 0 ? 201 : rejected === 0 ? 409 : 422;
      res.status(status).json(outcome);
    } finally {
      await Promise.all(files.map((file) => removeFileQuietly(file.tempPath)));
    }
  };

  const list: RequestHandler = async (req, res) => {
    const query = listUploadsQuerySchema.parse(req.query);
    res.json(await service.listUploads(query));
  };

  const getOne: RequestHandler = async (req, res) => {
    const { id } = uploadIdParamSchema.parse(req.params);
    res.json(await service.getUpload(id));
  };

  return { create, list, getOne };
}
