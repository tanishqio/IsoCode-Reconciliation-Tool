// The API sends every error as { error: { code, message, details?, requestId } }.
// This mirrors apps/api/src/lib/errors.ts. If the two ever drift, move the shared type
// to packages/shared.
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

/** Codes the client itself makes up when there is no usable error body from the server. */
export const CLIENT_ERROR_CODES = {
  network: "NETWORK_ERROR",
  unexpectedResponse: "UNEXPECTED_RESPONSE",
} as const;

export class ApiError extends Error {
  /** HTTP status. 0 means the request never got a response (network failure). */
  readonly status: number;
  /** Machine-readable code, for example VALIDATION_FAILED or NETWORK_ERROR. Use it for logic. */
  readonly code: string;
  readonly details?: unknown;
  /** The ID the server logged for this request. Show it to the user so they can report it. */
  readonly requestId?: string;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.requestId = init.requestId;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const error = (value as { error: unknown }).error;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

/** A message that is safe to show to the user. */
export function getErrorMessage(
  error: unknown,
  fallback = "Something went wrong. Please try again.",
): string {
  return isApiError(error) && error.message ? error.message : fallback;
}

/**
 * Turns a 422 VALIDATION_FAILED error into { "field.path": "message" } for forms.
 * Returns an empty object for any other error.
 */
export function getFieldErrors(error: unknown): Record<string, string> {
  if (!isApiError(error) || error.code !== "VALIDATION_FAILED" || !Array.isArray(error.details)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const item of error.details as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const { path, message } = item as { path?: unknown; message?: unknown };
    if (typeof path === "string" && typeof message === "string" && !(path in result)) {
      result[path] = message;
    }
  }
  return result;
}
