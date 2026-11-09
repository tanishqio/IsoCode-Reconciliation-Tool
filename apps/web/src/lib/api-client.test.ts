import { afterEach, describe, expect, it, vi } from "vitest";
import { api, setCsrfToken, setUnauthorizedHandler } from "./api-client";
import { ApiError, getFieldErrors } from "./api-error";
import { createQueryClient } from "./query-client";

type FetchCall = { url: string; init: RequestInit };

/** Replaces fetch. `make` builds a fresh Response for every call, because a body can be read once. */
function stubFetch(make: () => Response) {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return make();
  });
  return calls;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error("expected the request to fail");
}

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken(null);
  setUnauthorizedHandler(null);
});

describe("api client: responses", () => {
  it("returns the parsed JSON on success", async () => {
    const calls = stubFetch(() => json({ status: "ok" }));
    expect(await api.get("/health")).toEqual({ status: "ok" });
    expect(calls[0]?.url).toBe("/api/health");
  });

  it("turns the server's error body into an ApiError with code, details and request ID", async () => {
    stubFetch(() =>
      json(
        {
          error: {
            code: "VALIDATION_FAILED",
            message: "Some fields are invalid.",
            details: [{ path: "name", message: "Too small" }],
            requestId: "req-1",
          },
        },
        422,
      ),
    );
    const error = await failure(api.post("/things", { name: "x" }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(422);
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.requestId).toBe("req-1");
    expect(getFieldErrors(error)).toEqual({ name: "Too small" });
  });

  it("gives a friendly error, not raw HTML, when the server returns a non-JSON error page", async () => {
    stubFetch(
      () =>
        new Response("<html>Bad gateway</html>", {
          status: 502,
          headers: { "x-request-id": "gw-1" },
        }),
    );
    const error = await failure(api.get("/x"));
    expect(error.code).toBe("UNEXPECTED_RESPONSE");
    expect(error.message).not.toContain("html");
    expect(error.requestId).toBe("gw-1");
  });

  it("treats a 200 response that is not JSON as an error (wrong URL or proxy problem)", async () => {
    stubFetch(
      () =>
        new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    expect((await failure(api.get("/x"))).code).toBe("UNEXPECTED_RESPONSE");
  });

  it("reports a failed network call as NETWORK_ERROR with status 0", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const error = await failure(api.get("/x"));
    expect(error.status).toBe(0);
    expect(error.code).toBe("NETWORK_ERROR");
  });
});

describe("api client: requests", () => {
  it("sends the CSRF header on requests that change data, and not on reads", async () => {
    const calls = stubFetch(() => json({}));
    setCsrfToken("token-1");
    await api.get("/x");
    await api.post("/x", {});
    await api.delete("/x");
    const sent = calls.map((call) => (call.init.headers as Headers).get("X-CSRF-Token"));
    expect(sent).toEqual([null, "token-1", "token-1"]);
  });

  it("calls the sign-in redirect once on a 401, but not for the login call itself", async () => {
    stubFetch(() => json({ error: { code: "UNAUTHENTICATED", message: "Sign in" } }, 401));
    const redirect = vi.fn();
    setUnauthorizedHandler(redirect);

    await failure(api.get("/me"));
    expect(redirect).toHaveBeenCalledTimes(1);

    await failure(api.post("/auth/login", {}, { redirectOn401: false }));
    expect(redirect).toHaveBeenCalledTimes(1);
  });
});

describe("api client: statuses that carry a result", () => {
  const report = { summary: { accepted: 0, duplicate: 1, rejected: 0 }, results: [] };

  it("returns the body of a status listed in treatAsSuccess (a 409 upload report)", async () => {
    stubFetch(() => json(report, 409));
    expect(await api.post("/uploads", {}, { treatAsSuccess: [409, 422] })).toEqual(report);
  });

  it("still throws for a status that is not listed", async () => {
    stubFetch(() => json(report, 409));
    expect((await failure(api.post("/uploads", {}))).status).toBe(409);
    stubFetch(() => json(report, 500));
    expect((await failure(api.post("/uploads", {}, { treatAsSuccess: [409, 422] }))).status).toBe(
      500,
    );
  });

  it("still throws when a listed status carries a real error body", async () => {
    stubFetch(() => json({ error: { code: "VALIDATION_FAILED", message: "Bad items." } }, 422));
    const error = await failure(api.post("/uploads", {}, { treatAsSuccess: [409, 422] }));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.status).toBe(422);
  });

  it("still throws when a listed status has a body that is not JSON", async () => {
    stubFetch(() => new Response("<html>oops</html>", { status: 409 }));
    expect((await failure(api.post("/uploads", {}, { treatAsSuccess: [409] }))).code).toBe(
      "UNEXPECTED_RESPONSE",
    );
  });
});

describe("query retry rules", () => {
  const retry = createQueryClient().getDefaultOptions().queries?.retry as (
    failureCount: number,
    error: Error,
  ) => boolean;
  const apiError = (status: number) => new ApiError({ status, code: "X", message: "m" });

  it("does not retry a request the server refused (4xx), but retries network and 5xx errors twice", () => {
    expect(retry(0, apiError(404))).toBe(false);
    expect(retry(0, apiError(422))).toBe(false);
    for (const error of [apiError(0), apiError(503)]) {
      expect(retry(0, error)).toBe(true);
      expect(retry(1, error)).toBe(true);
      expect(retry(2, error)).toBe(false);
    }
  });
});
