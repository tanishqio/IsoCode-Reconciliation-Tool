import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import express, { type RequestHandler } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, type ErrorBody } from "../../../src/lib/errors.js";
import type {
  UploadOutcome,
  UploadsService,
} from "../../../src/modules/uploads/uploads.service.js";
import { buildForm, makeTempDir, uniqueCsv, waitForNoFiles } from "../../helpers/part2-fixtures.js";
import { startServer, type TestServer } from "../../helpers/server.js";

const MAX_FILE_BYTES = 64 * 1024;

let tempDir: string;
let server: TestServer;
let receiverCalls = 0;

const service = {
  processUpload: vi.fn(),
  listUploads: vi.fn(),
  getUpload: vi.fn(),
};

const sourceId = randomUUID();
const oneItem = [{ sourceId, fileType: "ORDERS" }];

const fakeAuth: RequestHandler = (req, _res, next) => {
  const role = req.header("x-role");
  if (!role) {
    next(new AppError("UNAUTHENTICATED", 401, "Please sign in."));
    return;
  }
  (req as unknown as { user: unknown }).user = { id: req.header("x-user-id") ?? "user-1", role };
  next();
};

beforeAll(async () => {
  tempDir = makeTempDir("uploads-routes");
  process.env["UPLOAD_TEMP_DIR"] = tempDir;
  process.env["MAX_UPLOAD_FILE_BYTES"] = String(MAX_FILE_BYTES);
  const { createUploadsRouter } = await import("../../../src/modules/uploads/uploads.routes.js");
  const { receiveFiles } = await import("../../../src/middleware/upload.js");
  const { errorHandler, notFoundHandler } =
    await import("../../../src/middleware/error-handler.js");
  const { requestLogger } = await import("../../../src/middleware/request-logger.js");

  const countingReceiver: RequestHandler = (req, res, next) => {
    receiverCalls += 1;
    receiveFiles(req, res, next);
  };

  const app = express();
  app.use(requestLogger);
  app.use(
    "/api/uploads",
    createUploadsRouter({
      service: service as unknown as UploadsService,
      guards: [fakeAuth],
      receiver: countingReceiver,
    }),
  );
  app.use(notFoundHandler);
  app.use(errorHandler);
  server = await startServer(app);
});

afterAll(async () => {
  await server.close();
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  receiverCalls = 0;
  vi.resetAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

const executive = { "x-role": "FINANCE_EXECUTIVE", "x-user-id": "exec-1" };
const cofounder = { "x-role": "CO_FOUNDER" };

async function call(
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: BodyInit } = {},
) {
  const response = await fetch(`${server.baseUrl}${path}`, { method, ...init });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as unknown };
}

function outcome(summary: Partial<UploadOutcome["summary"]>): UploadOutcome {
  return {
    batchId: randomUUID(),
    summary: { fileCount: 1, accepted: 0, duplicate: 0, rejected: 0, ...summary },
    results: [],
  };
}

describe("POST /api/uploads: access", () => {
  it("answers 401 without a session, before any file is read", async () => {
    const { status, body } = await call("POST", "/api/uploads", {
      body: buildForm(oneItem, [{ name: "a.csv", data: uniqueCsv() }]),
    });
    expect(status).toBe(401);
    expect((body as ErrorBody).error.code).toBe("UNAUTHENTICATED");
    expect(receiverCalls).toBe(0);
    expect(await waitForNoFiles(tempDir)).toBe(0);
    expect(service.processUpload).not.toHaveBeenCalled();
  });

  it("answers 403 for the co-founder, before any file is read", async () => {
    const { status, body } = await call("POST", "/api/uploads", {
      headers: cofounder,
      body: buildForm(oneItem, [{ name: "a.csv", data: uniqueCsv() }]),
    });
    expect(status).toBe(403);
    expect((body as ErrorBody).error.code).toBe("FORBIDDEN");
    expect(receiverCalls).toBe(0);
    expect(service.processUpload).not.toHaveBeenCalled();
  });

  it.each(["/api/uploads", `/api/uploads/${randomUUID()}`])(
    "blocks GET %s for the co-founder and for guests",
    async (path) => {
      expect((await call("GET", path, { headers: cofounder })).status).toBe(403);
      expect((await call("GET", path)).status).toBe(401);
      expect(service.listUploads).not.toHaveBeenCalled();
      expect(service.getUpload).not.toHaveBeenCalled();
    },
  );
});

describe("POST /api/uploads: request checks", () => {
  it("answers 400 when no file is attached", async () => {
    const form = new FormData();
    form.append("items", JSON.stringify(oneItem));
    const { status, body } = await call("POST", "/api/uploads", { headers: executive, body: form });
    expect(status).toBe(400);
    expect((body as ErrorBody).error.message).toContain("Attach at least one file");
  });

  it("answers 400 when the request is not multipart", async () => {
    const { status } = await call("POST", "/api/uploads", {
      headers: { ...executive, "content-type": "application/json" },
      body: JSON.stringify({ items: oneItem }),
    });
    expect(status).toBe(400);
  });

  it.each([
    ["is missing", undefined],
    ["is not JSON", "{oops"],
    ["has an unknown file type", [{ sourceId, fileType: "NOPE" }]],
    ["has a bad source id", [{ sourceId: "1", fileType: "ORDERS" }]],
    ["has the wrong number of entries", [...oneItem, ...oneItem]],
  ])("answers 422 and removes the temp file when items %s", async (_name, items) => {
    const { status, body } = await call("POST", "/api/uploads", {
      headers: executive,
      body: buildForm(items, [{ name: "a.csv", data: uniqueCsv() }]),
    });
    expect(status).toBe(422);
    expect((body as ErrorBody).error.code).toBe("VALIDATION_FAILED");
    expect(service.processUpload).not.toHaveBeenCalled();
    expect(await waitForNoFiles(tempDir)).toBe(0);
  });

  it("answers 413 for a file over the configured limit and removes the temp file", async () => {
    const big = Buffer.alloc(MAX_FILE_BYTES + 1024, 0x61);
    const { status } = await call("POST", "/api/uploads", {
      headers: executive,
      body: buildForm(oneItem, [{ name: "big.csv", data: big }]),
    });
    expect(status).toBe(413);
    expect(await waitForNoFiles(tempDir)).toBe(0);
  });
});

describe("POST /api/uploads: handing over to the service", () => {
  it("passes the user, the saved file facts and the items to the service", async () => {
    service.processUpload.mockResolvedValue(outcome({ accepted: 1 }));
    const data = uniqueCsv();
    const { status } = await call("POST", "/api/uploads", {
      headers: executive,
      body: buildForm(oneItem, [{ name: "orders.csv", data }]),
    });

    expect(status).toBe(201);
    expect(service.processUpload).toHaveBeenCalledTimes(1);
    const input = service.processUpload.mock.calls[0]?.[0] as {
      userId: string;
      items: unknown;
      files: { originalname: string; sha256: string; sizeBytes: number; tempPath: string }[];
    };
    expect(input.userId).toBe("exec-1");
    expect(input.items).toEqual(oneItem);
    expect(input.files).toHaveLength(1);
    expect(input.files[0]).toMatchObject({ originalname: "orders.csv", sizeBytes: data.length });
    expect(input.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("removes temp files that the service leaves behind", async () => {
    service.processUpload.mockResolvedValue(outcome({ accepted: 1 }));
    await call("POST", "/api/uploads", {
      headers: executive,
      body: buildForm(oneItem, [{ name: "a.csv", data: uniqueCsv() }]),
    });
    expect(await waitForNoFiles(tempDir)).toBe(0);
  });

  it.each([
    ["at least one file accepted", { accepted: 1, duplicate: 1, rejected: 1 }, 201],
    ["every file a duplicate", { duplicate: 2 }, 409],
    ["nothing accepted and some rejected", { duplicate: 1, rejected: 1 }, 422],
    ["every file rejected", { rejected: 2 }, 422],
  ])("answers %s with status %i", async (_name, summary, expected) => {
    service.processUpload.mockResolvedValue(outcome(summary));
    const { status, body } = await call("POST", "/api/uploads", {
      headers: executive,
      body: buildForm(oneItem, [{ name: "a.csv", data: uniqueCsv() }]),
    });
    expect(status).toBe(expected);
    expect((body as UploadOutcome).summary).toMatchObject(summary);
  });

  it("passes a service AppError through and still removes temp files", async () => {
    service.processUpload.mockRejectedValue(new AppError("CONFLICT", 409, "Conflict happened."));
    const { status, body } = await call("POST", "/api/uploads", {
      headers: executive,
      body: buildForm(oneItem, [{ name: "a.csv", data: uniqueCsv() }]),
    });
    expect(status).toBe(409);
    expect((body as ErrorBody).error.message).toBe("Conflict happened.");
    expect(await waitForNoFiles(tempDir)).toBe(0);
  });

  it("hides the detail of an unexpected error and still removes temp files", async () => {
    service.processUpload.mockRejectedValue(new Error("SECRET database detail"));
    const { status, body } = await call("POST", "/api/uploads", {
      headers: executive,
      body: buildForm(oneItem, [{ name: "a.csv", data: uniqueCsv() }]),
    });
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("SECRET");
    expect(await waitForNoFiles(tempDir)).toBe(0);
  });
});

describe("GET /api/uploads", () => {
  it("uses the default page size and returns the service result", async () => {
    service.listUploads.mockResolvedValue({ items: [], nextCursor: null });
    const { status, body } = await call("GET", "/api/uploads", { headers: executive });
    expect(status).toBe(200);
    expect(body).toEqual({ items: [], nextCursor: null });
    expect(service.listUploads).toHaveBeenCalledWith({ limit: 25 });
  });

  it("passes parsed filters to the service", async () => {
    service.listUploads.mockResolvedValue({ items: [], nextCursor: null });
    await call(
      "GET",
      `/api/uploads?sourceId=${sourceId}&fileType=SETTLEMENT&status=NEEDS_MAPPING&limit=5`,
      {
        headers: executive,
      },
    );
    expect(service.listUploads).toHaveBeenCalledWith({
      sourceId,
      fileType: "SETTLEMENT",
      status: "NEEDS_MAPPING",
      limit: 5,
    });
  });

  it.each(["limit=0", "limit=1000", "status=DONE", "fileType=X", "sourceId=abc"])(
    "answers 422 for ?%s",
    async (query) => {
      const { status } = await call("GET", `/api/uploads?${query}`, { headers: executive });
      expect(status).toBe(422);
      expect(service.listUploads).not.toHaveBeenCalled();
    },
  );
});

describe("GET /api/uploads/:id", () => {
  it("returns one upload", async () => {
    const id = randomUUID();
    service.getUpload.mockResolvedValue({ id });
    const { status, body } = await call("GET", `/api/uploads/${id}`, { headers: executive });
    expect(status).toBe(200);
    expect(body).toEqual({ id });
    expect(service.getUpload).toHaveBeenCalledWith(id);
  });

  it("answers 422 for an id that is not a uuid", async () => {
    const { status } = await call("GET", "/api/uploads/123", { headers: executive });
    expect(status).toBe(422);
    expect(service.getUpload).not.toHaveBeenCalled();
  });

  it("passes the 404 from the service", async () => {
    service.getUpload.mockRejectedValue(new AppError("NOT_FOUND", 404, "Upload not found."));
    const { status } = await call("GET", `/api/uploads/${randomUUID()}`, { headers: executive });
    expect(status).toBe(404);
  });
});

describe("unsupported methods", () => {
  it("answers 404 for DELETE and PUT", async () => {
    const id = randomUUID();
    expect((await call("DELETE", `/api/uploads/${id}`, { headers: executive })).status).toBe(404);
    expect((await call("PUT", `/api/uploads/${id}`, { headers: executive })).status).toBe(404);
  });
});
