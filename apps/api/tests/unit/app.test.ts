import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ErrorBody } from "../../src/lib/errors.js";
import { createApp } from "../../src/app.js";
import { startServer, type TestServer } from "../helpers/server.js";

let server: TestServer;
beforeAll(async () => {
  server = await startServer(createApp());
});
afterAll(async () => {
  await server.close();
});

describe("app wiring (no database needed)", () => {
  it("GET /api/health returns 200 {status: ok}", async () => {
    const res = await fetch(`${server.baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("does not advertise Express and sends security headers", async () => {
    const res = await fetch(`${server.baseUrl}/api/health`);
    expect(res.headers.get("x-powered-by")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("content-security-policy")).toBeTruthy();
  });

  it("returns the standard 404 error shape for an unknown route", async () => {
    const res = await fetch(`${server.baseUrl}/api/nope`);
    const body = (await res.json()) as ErrorBody;
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.requestId).toBe(res.headers.get("x-request-id"));
  });

  it("rejects an invalid JSON body with 400 before it reaches any route", async () => {
    const res = await fetch(`${server.baseUrl}/api/health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad json",
    });
    const body = (await res.json()) as ErrorBody;
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("INVALID_JSON");
  });

  it("rejects a JSON body over 100 kb with 413", async () => {
    const res = await fetch(`${server.baseUrl}/api/health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filler: "x".repeat(200_000) }),
    });
    const body = (await res.json()) as ErrorBody;
    expect(res.status).toBe(413);
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("accepts a small valid JSON body (then 404 because no POST route exists)", async () => {
    const res = await fetch(`${server.baseUrl}/api/health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(res.status).toBe(404);
  });
});
