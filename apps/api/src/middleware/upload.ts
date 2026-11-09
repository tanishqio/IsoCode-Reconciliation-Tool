import type { RequestHandler } from "express";
import multer from "multer";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import { hashStorage } from "../lib/hash-storage.js";

export const FILES_FIELD = "files";
export const ITEMS_FIELD = "items";

const ITEMS_FIELD_MAX_BYTES = 16 * 1024;
const MULTIPART_PARSE_ERROR = /^(Multipart:|Unexpected end of form|Malformed)/;

export interface FileReceiverOptions {
  maxFileBytes: number;
  maxFiles: number;
}

function toMegabytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return Number.isInteger(megabytes) ? String(megabytes) : megabytes.toFixed(1);
}

export function toUploadError(err: unknown, options: FileReceiverOptions): unknown {
  if (err instanceof multer.MulterError) {
    switch (err.code) {
      case "LIMIT_FILE_SIZE":
        return new AppError(
          "PAYLOAD_TOO_LARGE",
          413,
          `A file is larger than the ${toMegabytes(options.maxFileBytes)} MB limit.`,
          { maxFileBytes: options.maxFileBytes },
        );
      case "LIMIT_FILE_COUNT":
        return new AppError(
          "BAD_REQUEST",
          400,
          `You can upload at most ${options.maxFiles} files at a time.`,
          { maxFiles: options.maxFiles },
        );
      case "LIMIT_UNEXPECTED_FILE":
        return err.field === FILES_FIELD
          ? new AppError(
              "BAD_REQUEST",
              400,
              `You can upload at most ${options.maxFiles} files at a time.`,
              { maxFiles: options.maxFiles },
            )
          : new AppError("BAD_REQUEST", 400, `Send the files in the "${FILES_FIELD}" field.`);
      default:
        return new AppError("BAD_REQUEST", 400, "The upload form is not valid.");
    }
  }
  if (err instanceof Error && MULTIPART_PARSE_ERROR.test(err.message)) {
    return new AppError("BAD_REQUEST", 400, "The upload could not be read.");
  }
  return err;
}

export function createFileReceiver(options: FileReceiverOptions): RequestHandler {
  const upload = multer({
    storage: hashStorage,
    limits: {
      fileSize: options.maxFileBytes,
      files: options.maxFiles,
      fields: 5,
      fieldSize: ITEMS_FIELD_MAX_BYTES,
      parts: options.maxFiles + 5,
    },
  });
  const receive = upload.array(FILES_FIELD, options.maxFiles);

  return (req, res, next) => {
    receive(req, res, (err?: unknown) => {
      if (err) {
        next(toUploadError(err, options));
        return;
      }
      next();
    });
  };
}

export const receiveFiles: RequestHandler = createFileReceiver({
  maxFileBytes: env.MAX_UPLOAD_FILE_BYTES,
  maxFiles: env.MAX_UPLOAD_FILES,
});
