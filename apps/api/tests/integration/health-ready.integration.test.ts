import { afterEach, describe, expect, it, vi } from "vitest";
import type { ErrorBody } from "../../src/lib/errors.js";
import { startServer } from "../helpers/server.js";
import { getTestDatabaseUrl } from "../helpers/test-db.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Loads a fresh copy of the app pointed at the given database URL. */
async function appWithDatabase(url: string) {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", url);
  const { createApp } = await import("../../src/app.js");
  const { prisma } = await import("../../src/db/prisma.js");
  const server = await startServer(createApp());
  return {
    baseUrl: server.baseUrl,
    cleanup: async () => {
      await server.close();
      await prisma.$disconnect();
    },
  };
}

describe("GET /api/health/ready", () => {
  it("returns 200 with database: up when the database answers", async () => {
    const app = await appWithDatabase(getTestDatabaseUrl());
    try {
      const res = await fetch(`${app.baseUrl}/api/health/ready`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok", database: "up" });
    } finally {
      await app.cleanup();
    }
  });

  it("returns 503 DATABASE_UNAVAILABLE when the password is wrong, without leaking details", async () => {
    const url = new URL(getTestDatabaseUrl());
    url.password = "definitely-the-wrong-password";
    const app = await appWithDatabase(url.toString());
    try {
      const res = await fetch(`${app.baseUrl}/api/health/ready`);
      const text = await res.text();
      const body = JSON.parse(text) as ErrorBody;
      expect(res.status).toBe(503);
      expect(body.error.code).toBe("DATABASE_UNAVAILABLE");
      expect(body.error.requestId).toBe(res.headers.get("x-request-id"));
      expect(text).not.toContain("definitely-the-wrong-password");
      expect(text.toLowerCase()).not.toContain("authentication");
    } finally {
      await app.cleanup();
    }
  });

  it("returns 503 quickly when nothing is listening on the database port", async () => {
    const url = new URL(getTestDatabaseUrl());
    url.port = "1";
    const app = await appWithDatabase(url.toString());
    try {
      const started = Date.now();
      const res = await fetch(`${app.baseUrl}/api/health/ready`);
      const body = (await res.json()) as ErrorBody;
      expect(res.status).toBe(503);
      expect(body.error.code).toBe("DATABASE_UNAVAILABLE");
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await app.cleanup();
    }
  });

  it("the liveness route still returns 200 while the database is unreachable", async () => {
    const url = new URL(getTestDatabaseUrl());
    url.port = "1";
    const app = await appWithDatabase(url.toString());
    try {
      const res = await fetch(`${app.baseUrl}/api/health`);
      expect(res.status).toBe(200);
    } finally {
      await app.cleanup();
    }
  });
});
