import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError, type ErrorBody } from "../../src/lib/errors.js";
import { errorHandler, notFoundHandler } from "../../src/middleware/error-handler.js";
import { requestLogger } from "../../src/middleware/request-logger.js";
import { startServer, type TestServer } from "../helpers/server.js";

const bodySchema = z.object({
  name: z.string().min(2),
  nested: z.object({ qty: z.number().int() }),
});

function buildApp() {
  const app = express();
  app.use(requestLogger);
  app.use(express.json());

  app.get("/app-error", () => {
    throw new AppError("CONFLICT", 409, "Already exists.", { field: "email" });
  });
  app.get("/app-error-no-details", () => {
    throw new AppError("FORBIDDEN", 403, "Not allowed.");
  });
  app.post("/zod", (req, res) => {
    bodySchema.parse(req.body);
    res.json({ ok: true });
  });
  app.get("/boom", () => {
    throw new Error("SECRET internal detail");
  });
  app.get("/boom-string", () => {
    throw "a plain string was thrown";
  });
  app.get("/async-boom", async () => {
    await Promise.resolve();
    throw new Error("async SECRET internal detail");
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

let server: TestServer;
beforeAll(async () => {
  server = await startServer(buildApp());
});
afterAll(async () => {
  await server.close();
});

async function call(pathName: string, init?: RequestInit) {
  const res = await fetch(`${server.baseUrl}${pathName}`, init);
  const body = (await res.json()) as ErrorBody;
  return { res, body };
}

describe("central error handler", () => {
  it("returns an AppError with its status, code, message and details", async () => {
    const { res, body } = await call("/app-error");
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toBe("Already exists.");
    expect(body.error.details).toEqual({ field: "email" });
  });

  it("leaves out `details` when an AppError has none", async () => {
    const { res, body } = await call("/app-error-no-details");
    expect(res.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
    expect("details" in body.error).toBe(false);
  });

  it("maps a Zod validation failure to 422 with a path and message per field", async () => {
    const { res, body } = await call("/zod", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", nested: { qty: 1.5 } }),
    });
    expect(res.status).toBe(422);
    expect(body.error.code).toBe("VALIDATION_FAILED");
    const details = body.error.details as Array<{ path: string; message: string }>;
    const paths = details.map((d) => d.path).sort();
    expect(paths).toEqual(["name", "nested.qty"]);
    for (const d of details) expect(d.message.length).toBeGreaterThan(0);
  });

  it("maps invalid JSON to 400 INVALID_JSON", async () => {
    const { res, body } = await call("/zod", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad json",
    });
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("INVALID_JSON");
  });

  it("returns a generic 500 and never leaks the real error message", async () => {
    const { res, body } = await call("/boom");
    expect(res.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("SECRET");
    expect("details" in body.error).toBe(false);
  });

  it("handles a thrown non-Error value as a generic 500", async () => {
    const { res, body } = await call("/boom-string");
    expect(res.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("plain string");
  });

  it("handles an error thrown inside an async route (Express 5 forwards it)", async () => {
    const { res, body } = await call("/async-boom");
    expect(res.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });

  it("returns 404 NOT_FOUND for an unknown route", async () => {
    const { res, body } = await call("/does-not-exist");
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("puts the request ID in the body, and it matches the X-Request-Id header", async () => {
    const { res, body } = await call("/does-not-exist");
    const headerId = res.headers.get("x-request-id");
    expect(headerId).toBeTruthy();
    expect(body.error.requestId).toBe(headerId);
  });
});
