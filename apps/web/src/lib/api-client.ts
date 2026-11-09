import { ApiError, CLIENT_ERROR_CODES, isApiErrorBody } from "./api-error";

// The one place the frontend talks to the backend. Feature code calls api.get / api.post and
// never uses fetch directly. In development Vite proxies /api to the Express server, so the
// browser sees one origin and the session cookie works without CORS.
const API_BASE = "/api";
const CSRF_HEADER = "X-CSRF-Token";
const CSRF_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

let csrfToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

/** Set after login (Part 1). It is sent on every request that changes data. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Called when the server answers 401. The router registers a redirect to /login. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: string;
  /** A plain object/array is sent as JSON. A FormData is sent as multipart (file uploads). */
  body?: unknown;
  /** Added to the URL. null and undefined values are left out. */
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Set to false for the login call, where a 401 means "wrong password", not "session expired". */
  redirectOn401?: boolean;
  /**
   * Statuses, besides 2xx, whose body is a normal result and not an error. The upload endpoint
   * answers 409 (all duplicates) or 422 (all rejected) with a report of what happened to each file.
   */
  treatAsSuccess?: readonly number[];
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const base = `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${base}?${text}` : base;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

async function readJson(response: Response): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const text = await response.text();
  if (text === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const requestIdHeader = response.headers.get("X-Request-Id") ?? undefined;
  const parsed = await readJson(response);

  if (parsed.ok && isApiErrorBody(parsed.value)) {
    const { code, message, details, requestId } = parsed.value.error;
    return new ApiError({
      status: response.status,
      code,
      message,
      details,
      requestId: requestId ?? requestIdHeader,
    });
  }

  // No usable error body, for example a gateway error page while the API is down.
  const byStatus: Record<number, { code: string; message: string }> = {
    401: { code: "UNAUTHENTICATED", message: "Please sign in to continue." },
    403: { code: "FORBIDDEN", message: "You do not have access to this." },
    404: { code: "NOT_FOUND", message: "That was not found." },
  };
  const known = byStatus[response.status];
  return new ApiError({
    status: response.status,
    code: known?.code ?? CLIENT_ERROR_CODES.unexpectedResponse,
    message:
      known?.message ??
      (response.status >= 500
        ? "The server had a problem. Please try again in a moment."
        : "The server sent a response the app could not understand."),
    requestId: requestIdHeader,
  });
}

async function parseSuccess(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const parsed = await readJson(response);
  if (!parsed.ok) {
    // A 2xx with a body that is not JSON usually means a wrong URL or a proxy problem.
    throw new ApiError({
      status: response.status,
      code: CLIENT_ERROR_CODES.unexpectedResponse,
      message: "The server sent a response the app could not understand.",
      requestId: response.headers.get("X-Request-Id") ?? undefined,
    });
  }
  return parsed.value;
}

export async function apiRequest<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");

  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    body = options.body; // the browser adds the multipart boundary itself
  } else if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.body);
  }
  if (CSRF_METHODS.has(method) && csrfToken) headers.set(CSRF_HEADER, csrfToken);

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      body,
      signal: options.signal,
      credentials: "same-origin",
    });
  } catch (error) {
    if (isAbortError(error)) throw error; // a cancelled request is not a failure
    throw new ApiError({
      status: 0,
      code: CLIENT_ERROR_CODES.network,
      message: "Could not reach the server. Check your connection and try again.",
    });
  }

  if (response.ok) return (await parseSuccess(response)) as T;

  if (options.treatAsSuccess?.includes(response.status)) {
    // Only a real result counts. A body shaped like { error: ... } is still an error.
    const parsed = await readJson(response.clone());
    if (parsed.ok && !isApiErrorBody(parsed.value)) return parsed.value as T;
  }

  const error = await toApiError(response);
  if (response.status === 401 && options.redirectOn401 !== false) unauthorizedHandler?.();
  throw error;
}

type BodylessOptions = Omit<RequestOptions, "method" | "body">;

export const api = {
  get: <T = unknown>(path: string, options?: BodylessOptions) =>
    apiRequest<T>(path, { ...options, method: "GET" }),
  post: <T = unknown>(path: string, body?: unknown, options?: BodylessOptions) =>
    apiRequest<T>(path, { ...options, method: "POST", body }),
  put: <T = unknown>(path: string, body?: unknown, options?: BodylessOptions) =>
    apiRequest<T>(path, { ...options, method: "PUT", body }),
  patch: <T = unknown>(path: string, body?: unknown, options?: BodylessOptions) =>
    apiRequest<T>(path, { ...options, method: "PATCH", body }),
  delete: <T = unknown>(path: string, options?: BodylessOptions) =>
    apiRequest<T>(path, { ...options, method: "DELETE" }),
};
