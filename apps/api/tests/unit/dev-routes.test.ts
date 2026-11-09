// TEMPORARY: tests for the temporary dev routes (decision D11).
// Delete this file together with apps/api/src/modules/dev/ and its mount in app.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ErrorBody } from "../../src/lib/errors.js";
import { startServer, type TestServer } from "../helpers/server.js";

let outsideProduction: TestServer;
let production: TestServer;

// Each server needs its own copy of the app, because the dev routes are mounted (or not)
// when the app is created, based on NODE_ENV at that moment.
async function serverFor(nodeEnv: "test" | "production") {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv("LOG_LEVEL", "silent");
  const { createApp } = await import("../../src/app.js");
  return startServer(createApp());
}

beforeAll(async () => {
  outsideProduction = await serverFor("test");
  production = await serverFor("production");
});

afterAll(async () => {
  await outsideProduction.close();
  await production.close();
  vi.unstubAllEnvs();
});

describe("dev routes outside production", () => {
  it("POST /api/dev/validate returns 422 for a bad body", async () => {
    const res = await fetch(`${outsideProduction.baseUrl}/api/dev/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", amount: -5 }),
    });
    const body = (await res.json()) as ErrorBody;
    expect(res.status).toBe(422);
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("POST /api/dev/validate returns 200 for a good body", async () => {
    const res = await fetch(`${outsideProduction.baseUrl}/api/dev/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Alice", amount: 5 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, body: { name: "Alice", amount: 5 } });
  });

  it("GET /api/dev/app-error returns 409 with details", async () => {
    const res = await fetch(`${outsideProduction.baseUrl}/api/dev/app-error`);
    const body = (await res.json()) as ErrorBody;
    expect(res.status).toBe(409);
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.details).toEqual({ field: "example" });
  });

  it("GET /api/dev/boom returns a generic 500 without the internal message", async () => {
    const res = await fetch(`${outsideProduction.baseUrl}/api/dev/boom`);
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).toContain("INTERNAL_ERROR");
    expect(text).not.toContain("secret internal detail");
  });
});

describe("dev routes in production", () => {
  it.each(["/api/dev/db-check", "/api/dev/app-error", "/api/dev/boom"])(
    "%s is not mounted (404)",
    async (route) => {
      const res = await fetch(`${production.baseUrl}${route}`);
      const body = (await res.json()) as ErrorBody;
      expect(res.status).toBe(404);
      expect(body.error.code).toBe("NOT_FOUND");
    },
  );

  it("the real routes still work in production mode", async () => {
    const res = await fetch(`${production.baseUrl}/api/health`);
    expect(res.status).toBe(200);
  });
});
