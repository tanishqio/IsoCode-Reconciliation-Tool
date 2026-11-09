import { z } from "zod";
import { FileStatus, FileType } from "../../../generated/prisma/enums.js";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";

export const uploadItemSchema = z.strictObject({
  sourceId: z.uuid(),
  fileType: z.enum(FileType),
});

export type UploadItem = z.infer<typeof uploadItemSchema>;

export function parseUploadItems(
  raw: unknown,
  fileCount: number,
  maxFiles: number = env.MAX_UPLOAD_FILES,
): UploadItem[] {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new AppError("VALIDATION_FAILED", 422, 'The "items" field is required.');
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AppError("VALIDATION_FAILED", 422, 'The "items" field must be valid JSON.');
  }

  const items = z.array(uploadItemSchema).min(1).max(maxFiles).parse(json);
  if (items.length !== fileCount) {
    throw new AppError(
      "VALIDATION_FAILED",
      422,
      `Expected one item for each file: received ${fileCount} file(s) and ${items.length} item(s).`,
    );
  }
  return items;
}

export const listUploadsQuerySchema = z.object({
  sourceId: z.uuid().optional(),
  fileType: z.enum(FileType).optional(),
  status: z.enum(FileStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(200).optional(),
});

export type ListUploadsQuery = z.infer<typeof listUploadsQuerySchema>;

export const uploadIdParamSchema = z.strictObject({ id: z.uuid() });

export interface UploadCursor {
  uploadedAt: Date;
  id: string;
}

export function encodeCursor(cursor: UploadCursor): string {
  return Buffer.from(`${cursor.uploadedAt.toISOString()}|${cursor.id}`, "utf8").toString(
    "base64url",
  );
}

export function decodeCursor(value: string): UploadCursor {
  const invalid = new AppError("VALIDATION_FAILED", 422, "The cursor is not valid.");
  const [isoText, id, ...rest] = Buffer.from(value, "base64url").toString("utf8").split("|");
  if (!isoText || !id || rest.length > 0) throw invalid;
  const uploadedAt = new Date(isoText);
  if (Number.isNaN(uploadedAt.getTime()) || !z.uuid().safeParse(id).success) throw invalid;
  return { uploadedAt, id };
}
