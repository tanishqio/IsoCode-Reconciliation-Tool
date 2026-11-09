import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { AppError, type ErrorBody, type ErrorCode } from "../lib/errors.js";

interface Mapped {
  status: number;
  code: ErrorCode;
  message: string;
  details?: unknown;
}

function bodyParserErrorType(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "type" in err) {
    const { type } = err as { type: unknown };
    return typeof type === "string" ? type : undefined;
  }
  return undefined;
}

function mapError(err: unknown): Mapped {
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, message: err.message, details: err.details };
  }
  if (err instanceof ZodError) {
    return {
      status: 422,
      code: "VALIDATION_FAILED",
      message: "Some fields are invalid.",
      details: err.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    };
  }
  const bodyType = bodyParserErrorType(err);
  if (bodyType === "entity.parse.failed") {
    return { status: 400, code: "INVALID_JSON", message: "The request body is not valid JSON." };
  }
  if (bodyType === "entity.too.large") {
    return { status: 413, code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "Something went wrong. Please try again.",
  };
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError("NOT_FOUND", 404, "Route not found."));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const mapped = mapError(err);
  // AppError is an expected, already-handled error. Only unexpected errors need a stack in the log.
  if (mapped.status >= 500 && !(err instanceof AppError)) {
    req.log.error({ err }, "request failed");
  }

  const body: ErrorBody = {
    error: {
      code: mapped.code,
      message: mapped.message,
      ...(mapped.details !== undefined ? { details: mapped.details } : {}),
      requestId: String(req.id),
    },
  };
  res.status(mapped.status).json(body);
};
