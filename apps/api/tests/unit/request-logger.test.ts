import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requestLogger } from "../../src/middleware/request-logger.js";
import { startServer, type TestServer } from "../helpers/server.js";

const captured = vi.hoisted(() => ({ lines: [] as string[] }));

// Replace the app logger with one that writes into memory, so the tests can read the log lines.
vi.mock("../../src/lib/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/logger.js")>();
  const { Writable } = await import("node:stream");
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      captured.lines.push(String(chunk));
      callback();
    },
  });
  return { ...actual, logger: actual.createLogger(stream, "info") };
});

interface LogRecord {
  level: number;
  msg: string;
  responseTime?: number;
  req: { id: string; method: string; path: string };
  res?: { statusCode: number };
}

const records = () =>
  captured.lines
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogRecord);

function buildApp() {
  const app = express();
  app.use(requestLogger);
  app.use(express.json());
  app.get("/ping", (_req, res) => res.json({ ok: true }));
  app.post("/ping", (_req, res) => res.json({ ok: true }));
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/fail", (_req, res) => res.status(500).json({ failed: true }));
  return app;
}

let server: TestServer;
beforeAll(async () => {
  server = await startServer(buildApp());
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  captured.lines.length = 0;
});

describe("request logger", () => {
  it("writes exactly one line per request with method, path, status and timing", async () => {
    await fetch(`${server.baseUrl}/ping`);
    const lines = records();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe(30);
    expect(lines[0]?.req.method).toBe("GET");
    expect(lines[0]?.req.path).toBe("/ping");
    expect(lines[0]?.res?.statusCode).toBe(200);
    expect(typeof lines[0]?.responseTime).toBe("number");
  });

  it("logs the path only: no query string, cookie, token, header or body value", async () => {
    await fetch(`${server.baseUrl}/ping?email=a%40b.com&token=SECRETQUERY`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "sid=SECRETCOOKIE",
        authorization: "Bearer SECRETBEARER",
        "x-csrf-token": "SECRETCSRF",
      },
      body: JSON.stringify({ password: "SECRETPASSWORD", customerPhone: "9999999999" }),
    });
    const raw = captured.lines.join("");
    for (const secret of [
      "SECRETQUERY",
      "a@b.com",
      "a%40b.com",
      "SECRETCOOKIE",
      "SECRETBEARER",
      "SECRETCSRF",
      "SECRETPASSWORD",
      "9999999999",
    ]) {
      expect(raw).not.toContain(secret);
    }
    expect(records()[0]?.req.path).toBe("/ping");
  });

  it("sets an X-Request-Id header that matches the logged request ID", async () => {
    const res = await fetch(`${server.baseUrl}/ping`);
    const headerId = res.headers.get("x-request-id");
    expect(headerId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(records()[0]?.req.id).toBe(headerId);
  });

  it("gives every request its own ID", async () => {
    const a = await fetch(`${server.baseUrl}/ping`);
    const b = await fetch(`${server.baseUrl}/ping`);
    expect(a.headers.get("x-request-id")).not.toBe(b.headers.get("x-request-id"));
  });

  it("logs 4xx responses as warnings (level 40)", async () => {
    await fetch(`${server.baseUrl}/no-such-route`);
    const [line] = records();
    expect(line?.res?.statusCode).toBe(404);
    expect(line?.level).toBe(40);
  });

  it("logs 5xx responses as errors (level 50)", async () => {
    await fetch(`${server.baseUrl}/fail`);
    const [line] = records();
    expect(line?.res?.statusCode).toBe(500);
    expect(line?.level).toBe(50);
  });

  it("does not log the liveness route /api/health", async () => {
    const res = await fetch(`${server.baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(captured.lines.join("")).toBe("");
  });
});
